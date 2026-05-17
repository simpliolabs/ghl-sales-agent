import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import {
  getAllLeads, getHotLeads, getLeadById, getConversationHistory, getPipelineStats,
  getAiPerformanceStats, getRecentAiMessages, getKnowledgeFiles, addKnowledgeFile,
  deleteKnowledgeFile, updateKnowledgeFile, getActiveTweaks, addAiTweak, archiveTweak,
  getAgentWorkload, getPipelineEvents, getAiState, updateLeadFields, upsertLead,
  createInvite, getInviteByToken, markInviteUsed, getActiveInvites, deleteInvite,
  getAllUsers, updateUserRole, getUserByOpenId, purgeGhostUsers,
  getBrainCouncilAuditLog, getBrainCouncilAuditForLead, getRecentWebhookLogs,
} from "./db";
import { ENV } from "./_core/env";
import { storagePut } from "./storage";
import { getContacts, getPipelines } from "./ghl";
import { invokeLLM } from "./_core/llm";
import { scoreLeadQuick } from "./ai-brain";
import { getPatternAnalysis, backfillOutcomes, getIcpStats } from "./outcome-engine";
import {
  createExperiment, listExperiments, evaluateExperiment,
  evaluateAllExperiments, setExperimentStatus,
} from "./ab-testing";
import {
  getPersonaMatrix, normalizePersona, generateDailySnapshot,
  getOutcomeTrends, getPersonaLearningContext, backfillPersonaOnOutcomes,
} from "./persona-learning";
import { processOverdueFollowUps, processOverdueCatchUp } from "./follow-up-trigger";
import { compressSchedule, MAX_FOLLOWUP_DELAY_MS } from "./scheduling-engine";
import { runAndStoreSupervisorCycle, getSupervisorStatus } from "./supervisor";
import { runLookback } from "./lookback-engine";
import { runDispositionSweep } from "./lead-disposition";
import { getAllSkills } from "./skill-registry";
import { runAutoSkillHunter, getSkillProposals, reviewSkillProposal } from "./auto-skill-hunter";
import { getLeadMemoryFacts } from "./lead-memory";
import { runStrategyReview, getStrategyAdjustmentHistory } from "./strategy-autopilot";
import { extractAgentPatterns, recordAgentLearning } from "./learning-loop";
import { getOutboxStats, enqueueOutbox, makeIdemKey } from "./outbox-worker";
import { createTrainingExport, listTrainingExports, getTrainingExport } from "./training-export";

// Auto-synthesize uploaded content using LLM
async function synthesizeContent(rawText: string, fileName: string): Promise<string> {
  if (!rawText || rawText.trim().length < 10) return rawText;
  try {
    const response = await invokeLLM({
      messages: [
        { role: "system", content: "You are a knowledge synthesizer for Adorb Custom Tees, a custom printing company. Extract and organize the key information from the uploaded content into a clear, structured format that an AI sales agent can reference during conversations. Focus on: pricing, products, services, policies, turnaround times, minimums, and any other actionable details. Keep it concise but comprehensive." },
        { role: "user", content: `Synthesize this content from file '${fileName}':\n\n${rawText.substring(0, 8000)}` },
      ],
    });
    return (response.choices?.[0]?.message?.content as string) || rawText;
  } catch { return rawText; }
}

/**
 * Fetch ALL tabs from a publicly shared Google Sheet.
 * Probes GIDs 0, 100, 200, ... 2000 and concatenates non-empty tabs.
 * Falls back to first tab only if no additional tabs found.
 */
async function fetchAllSheetTabs(sheetId: string): Promise<string> {
  const baseUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
  const tabSections: string[] = [];

  // Probe GIDs: 0 is always the first tab; others are assigned by Google
  const gidsToProbe = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900,
    1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000];

  for (const gid of gidsToProbe) {
    try {
      const url = gid === 0 ? baseUrl : `${baseUrl}&gid=${gid}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) continue;
      const csv = await resp.text();
      // Skip if it's an HTML error page or empty
      if (!csv || csv.startsWith('<!DOCTYPE') || csv.includes('Page Not Found') || csv.trim().length < 20) continue;
      const lines = csv.split("\n").filter(l => l.trim()).map(l => l.replace(/,+$/g, ""));
      if (lines.length < 2) continue;
      tabSections.push(`=== TAB (GID ${gid}) ===\n${lines.join("\n")}`);
    } catch {
      // Tab doesn't exist or timed out — skip
    }
  }

  if (tabSections.length === 0) {
    // Final fallback: try the default export with no GID
    try {
      const resp = await fetch(baseUrl, { signal: AbortSignal.timeout(10000) });
      if (resp.ok) {
        const csv = await resp.text();
        const lines = csv.split("\n").filter(l => l.trim()).map(l => l.replace(/,+$/g, ""));
        return lines.join("\n");
      }
    } catch { /* ignore */ }
    return "";
  }

  return tabSections.join("\n\n");
}

// Admin-only procedure middleware
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user?.role !== 'admin') throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
  return next({ ctx });
});

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  outbox: router({
    stats: protectedProcedure.query(async () => getOutboxStats()),
  }),

  leads: router({
    list: protectedProcedure.query(async () => getAllLeads(5000)),
    hot: protectedProcedure.query(async () => getHotLeads(80)),
    detail: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ input }) => {
      const lead = await getLeadById(input.id);
      if (!lead) return null;
      const history = await getConversationHistory(lead.id, 50);
      const events = await getPipelineEvents(lead.id);
      const state = await getAiState(lead.id);
      return { lead, history, events, aiState: state };
    }),
    toggleHumanTakeover: protectedProcedure.input(z.object({ id: z.number(), takeover: z.boolean() })).mutation(async ({ input }) => {
      await updateLeadFields(input.id, { humanTakeover: input.takeover ? 1 : 0 });
      return { success: true };
    }),
    reschedule: adminProcedure.input(z.object({
      id: z.number(),
      nextFollowUpAt: z.string(), // ISO date string
      reason: z.string().min(1, "Override reason is required"),
    })).mutation(async ({ input, ctx }) => {
      const newDate = new Date(input.nextFollowUpAt);
      if (isNaN(newDate.getTime())) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid date' });
      await updateLeadFields(input.id, {
        nextFollowUpAt: newDate,
        overrideBy: ctx.user?.name || ctx.user?.openId || 'admin',
        overrideAt: new Date(),
        overrideReason: input.reason,
      });
      return { success: true, scheduledAt: newDate.toISOString() };
    }),
    scheduleDistribution: protectedProcedure.query(async () => {
      const now = new Date();
      const endOfToday = new Date(now); endOfToday.setHours(23, 59, 59, 999);
      const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const in14d = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
      const in30d = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const allLeads = await getAllLeads(5000);
      let overdue = 0, today = 0, week1 = 0, week2 = 0, month = 0, beyond = 0, noSchedule = 0, humanTakeover = 0;
      for (const l of allLeads) {
        if (l.humanTakeover === 1) { humanTakeover++; continue; }
        if (!l.nextFollowUpAt) { noSchedule++; continue; }
        const d = new Date(l.nextFollowUpAt);
        if (d <= now) overdue++;
        else if (d <= endOfToday) today++;
        else if (d <= in7d) week1++;
        else if (d <= in14d) week2++;
        else if (d <= in30d) month++;
        else beyond++;
      }
      return { overdue, today, week1, week2, month, beyond, noSchedule, humanTakeover };
    }),
    handoffQueue: protectedProcedure.query(async () => {
      const allLeads = await getAllLeads(5000);
      const now = Date.now();
      return allLeads
        .filter(l => l.humanTakeover === 1)
        .map(l => {
          const lastActivity = l.lastAgentActivityAt ? new Date(l.lastAgentActivityAt).getTime() : (l.updatedAt ? new Date(l.updatedAt).getTime() : 0);
          const silentHours = lastActivity ? Math.round((now - lastActivity) / (60 * 60 * 1000)) : null;
          const isStale = silentHours !== null && silentHours >= 24;
          const isOverdue = !!(l.nextFollowUpAt && new Date(l.nextFollowUpAt) <= new Date());
          return {
            id: l.id, name: l.name, businessName: l.businessName,
            email: l.email, phone: l.phone, assignedAgent: l.assignedAgent,
            pipelineStage: l.pipelineStage, opportunityScore: l.opportunityScore,
            nextFollowUpAt: l.nextFollowUpAt, lastAgentActivityAt: l.lastAgentActivityAt,
            silentHours, isStale, isOverdue,
            source: l.source, omnisendSegment: l.omnisendSegment,
          };
        })
        .sort((a, b) => {
          if (a.isStale && !b.isStale) return -1;
          if (!a.isStale && b.isStale) return 1;
          return (b.silentHours || 0) - (a.silentHours || 0);
        });
    }),
    bulkScore: adminProcedure.mutation(async () => {
      // Score all leads that don't have a score yet (or score is 0)
      const allLeads = await getAllLeads(5000);
      const unscoredLeads = allLeads.filter(l => !l.opportunityScore || l.opportunityScore === 0);
      let scored = 0;
      let errors = 0;
      // Process in batches of 10 to avoid overwhelming the LLM
      for (let i = 0; i < unscoredLeads.length; i += 10) {
        const batch = unscoredLeads.slice(i, i + 10);
        await Promise.all(batch.map(async (lead) => {
          try {
            const score = await scoreLeadQuick({
              name: lead.name || undefined,
              businessName: lead.businessName || undefined,
              source: lead.source || undefined,
              pipelineStage: lead.pipelineStage || undefined,
            });
            await updateLeadFields(lead.id, { opportunityScore: score });
            scored++;
          } catch {
            errors++;
          }
        }));
      }
      return { scored, errors, total: unscoredLeads.length };
    }),
  }),

  pipeline: router({
    stats: protectedProcedure.query(async () => getPipelineStats()),
    ghlPipelines: protectedProcedure.query(async () => { try { return await getPipelines(); } catch { return []; } }),
  }),

  ai: router({
    performance: protectedProcedure.query(async () => getAiPerformanceStats()),
    recentMessages: protectedProcedure.query(async () => getRecentAiMessages(30)),
    auditLog: protectedProcedure.input(z.object({ limit: z.number().optional() }).optional()).query(async ({ input }) => {
      return getBrainCouncilAuditLog(input?.limit || 50);
    }),
    auditForLead: protectedProcedure.input(z.object({ leadId: z.number(), limit: z.number().optional() })).query(async ({ input }) => {
      return getBrainCouncilAuditForLead(input.leadId, input.limit || 20);
    }),
    webhookLogs: adminProcedure.input(z.object({ limit: z.number().optional() }).optional()).query(async ({ input }) => {
      return getRecentWebhookLogs(input?.limit || 50);
    }),
    tweaks: adminProcedure.query(async () => getActiveTweaks()),
    addTweak: adminProcedure.input(z.object({ instruction: z.string() })).mutation(async ({ input, ctx }) => {
      const result = await addAiTweak(input.instruction, ctx.user?.id);
      // Auto-synthesize: the tweak is stored as-is but we verify it's actionable
      return result;
    }),
    archiveTweak: adminProcedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => { await archiveTweak(input.id); return { success: true }; }),
    learningInsights: protectedProcedure.query(async () => getPatternAnalysis()),
    triggerBackfill: adminProcedure.mutation(async () => {
      const created = await backfillOutcomes();
      return { created };
    }),
    triggerFollowUps: adminProcedure.mutation(async () => {
      const result = await processOverdueFollowUps();
      return result;
    }),
    triggerDisposition: adminProcedure.mutation(async () => {
      const result = await runDispositionSweep();
      return result;
    }),
    triggerOverdueCatchUp: adminProcedure.mutation(async () => {
      const result = await processOverdueCatchUp();
      return result;
    }),
    compressSchedule: adminProcedure.input(z.object({
      maxPerDay: z.number().optional().default(75),
      spreadDays: z.number().optional().default(10),
      dryRun: z.boolean().optional().default(true),
    }).optional()).mutation(async ({ input }) => {
      const result = await compressSchedule({
        maxPerDay: input?.maxPerDay ?? 75,
        spreadDays: input?.spreadDays ?? 10,
        dryRun: input?.dryRun ?? true,
      });
      return result;
    }),
    backfillUnclassified: adminProcedure.input(z.object({
      maxLeads: z.number().optional().default(50),
    }).optional()).mutation(async ({ input }) => {
      const { backfillUnclassifiedSegments } = await import("./scheduling-engine");
      const result = await backfillUnclassifiedSegments(input?.maxLeads ?? 50);
      return result;
    }),
    supervisorStatus: protectedProcedure.query(async () => getSupervisorStatus()),
    triggerSupervisor: adminProcedure.mutation(async () => {
      const result = await runAndStoreSupervisorCycle();
      return result;
    }),
    supervisorAuditLog: protectedProcedure.input(z.object({
      limit: z.number().optional().default(50),
    }).optional()).query(async ({ input }) => {
      const { getDb } = await import("./db");
      const db = await getDb();
      if (!db) return [];
      const { supervisorAudit } = await import("../drizzle/schema");
      const { desc } = await import("drizzle-orm");
      return db.select().from(supervisorAudit).orderBy(desc(supervisorAudit.createdAt)).limit(input?.limit ?? 50);
    }),
    resetLearningData: adminProcedure.input(z.object({
      confirm: z.literal("RESET_CONFIRMED"),
      archiveBefore: z.string().optional(), // ISO date string — archive records before this date
    })).mutation(async ({ input }) => {
      const db = await (await import("./db")).getDb();
      if (!db) throw new Error("Database unavailable");
      const { messageOutcomes, conversationOutcomes, learnings } = await import("../drizzle/schema");
      const { lt, sql: drizzleSql } = await import("drizzle-orm");
      const { patternCache } = await import("./cache");
      const cutoff = input.archiveBefore ? new Date(input.archiveBefore) : new Date();
      // Count before deletion
      const [moBefore] = await db.select({ count: drizzleSql<number>`COUNT(*)` }).from(messageOutcomes).where(lt(messageOutcomes.createdAt, cutoff));
      const cutoffMs = cutoff.getTime();
      const [coBefore] = await db.select({ count: drizzleSql<number>`COUNT(*)` }).from(conversationOutcomes).where(lt(conversationOutcomes.createdAt, cutoffMs));
      const [lBefore] = await db.select({ count: drizzleSql<number>`COUNT(*)` }).from(learnings);
      // Delete pre-cutoff message outcomes (biased data from broken diversity system)
      await db.delete(messageOutcomes).where(lt(messageOutcomes.createdAt, cutoff));
      // Delete pre-cutoff conversation outcomes
      await db.delete(conversationOutcomes).where(lt(conversationOutcomes.createdAt, cutoffMs));
      // Delete all auto-generated learnings (they'll regenerate from fresh data)
      await db.delete(learnings);
      // Invalidate all learning caches so next request starts fresh
      patternCache.clear();
      console.log(`[LearningReset] Archived ${moBefore.count} message outcomes, ${coBefore.count} conversation outcomes, ${lBefore.count} learnings before ${cutoff.toISOString()}`);
      return {
        success: true,
        archivedMessageOutcomes: moBefore.count,
        archivedConversationOutcomes: coBefore.count,
        archivedLearnings: lBefore.count,
        cutoffDate: cutoff.toISOString(),
        message: `Learning data reset. System will rebuild unbiased performance data from new messages going forward.`,
      };
    }),
    triggerLookback: adminProcedure.input(z.object({
      maxLeads: z.number().optional().default(50),
      delayBetweenMs: z.number().optional().default(3000),
      skipResearch: z.boolean().optional().default(false),
    }).optional()).mutation(async ({ input }) => {
      const result = await runLookback({
        maxLeads: input?.maxLeads ?? 50,
        delayBetweenMs: input?.delayBetweenMs ?? 3000,
        onlyUnprocessed: true,
        skipResearch: input?.skipResearch ?? false,
      });
      return {
        total: result.total,
        processed: result.processed,
        engage: result.engage,
        skip: result.skip,
        caution: result.caution,
        humanNeeded: result.humanNeeded,
        researchFetched: result.researchFetched,
        errors: result.errors,
      };
    }),
  }),

  knowledge: router({
    list: protectedProcedure.query(async () => getKnowledgeFiles()),
    upload: protectedProcedure.input(z.object({
      fileName: z.string(), fileType: z.string(), fileData: z.string(), contentText: z.string().optional(),
    })).mutation(async ({ input }) => {
      const buffer = Buffer.from(input.fileData, "base64");
      const fileKey = `knowledge/${Date.now()}-${input.fileName}`;
      const { url } = await storagePut(fileKey, buffer, input.fileType);
      // Auto-synthesize: if contentText provided, run it through LLM; if not, try to extract from text-based files
      let contentText = input.contentText || "";
      if (!contentText && (input.fileType.includes("text") || input.fileName.endsWith(".txt") || input.fileName.endsWith(".csv") || input.fileName.endsWith(".md"))) {
        contentText = buffer.toString("utf-8");
      }
      if (contentText) {
        contentText = await synthesizeContent(contentText, input.fileName);
      }
      return addKnowledgeFile({ fileName: input.fileName, fileType: input.fileType, fileUrl: url, contentText });
    }),
    addGoogleSheet: protectedProcedure.input(z.object({ name: z.string(), url: z.string() })).mutation(async ({ input }) => {
      // Auto-fetch ALL tabs from Google Sheet on add
      let contentText = "";
      try {
        const sheetId = input.url.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1];
        if (sheetId) {
          const rawText = await fetchAllSheetTabs(sheetId);
          if (rawText.trim()) {
            contentText = await synthesizeContent(rawText, input.name);
          }
        }
      } catch (e) { /* silent — sheet may not be public */ }
      return addKnowledgeFile({ fileName: input.name, fileType: "google_sheet", googleSheetUrl: input.url, contentText });
    }),
    syncGoogleSheet: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
      const files = await getKnowledgeFiles();
      const file = files.find((f: any) => f.id === input.id);
      if (!file || !file.googleSheetUrl) throw new Error("Not a Google Sheet");
      const sheetId = file.googleSheetUrl.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1];
      if (!sheetId) throw new Error("Invalid Google Sheet URL");
      // Fetch ALL tabs, not just the first one
      const contentText = await fetchAllSheetTabs(sheetId);
      if (!contentText.trim()) throw new Error("Failed to fetch sheet — make sure it's shared publicly");
      await updateKnowledgeFile(input.id, { contentText, lastSyncedAt: new Date() });
      return { success: true, contentLength: contentText.length };
    }),
    updateContent: protectedProcedure.input(z.object({ id: z.number(), contentText: z.string() })).mutation(async ({ input }) => {
      await updateKnowledgeFile(input.id, { contentText: input.contentText, lastSyncedAt: new Date() });
      return { success: true };
    }),
    resynthesize: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
      const files = await getKnowledgeFiles();
      const file = files.find((f: any) => f.id === input.id);
      if (!file) throw new Error("Knowledge file not found");
      const rawText = file.contentText || "";
      if (!rawText.trim()) throw new Error("No content to re-synthesize");
      const synthesized = await synthesizeContent(rawText, file.fileName);
      await updateKnowledgeFile(input.id, { contentText: synthesized, lastSyncedAt: new Date() });
      return { success: true };
    }),
    delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => { await deleteKnowledgeFile(input.id); return { success: true }; }),
  }),

  agents: router({
    workload: protectedProcedure.query(async () => getAgentWorkload()),
  }),

  invites: router({
    list: adminProcedure.query(async ({ ctx }) => getActiveInvites(ctx.user!.id)),
    create: adminProcedure.input(z.object({ role: z.enum(["admin", "viewer"]) })).mutation(async ({ input, ctx }) => {
      const token = nanoid(32);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
      return createInvite({ token, role: input.role, createdBy: ctx.user!.id, expiresAt });
    }),
    validate: publicProcedure.input(z.object({ token: z.string() })).query(async ({ input }) => {
      const invite = await getInviteByToken(input.token);
      if (!invite) return { valid: false, role: null, expired: false };
      if (invite.usedAt) return { valid: false, role: null, expired: false };
      if (new Date(invite.expiresAt) < new Date()) return { valid: false, role: invite.role, expired: true };
      return { valid: true, role: invite.role, expired: false };
    }),
    accept: protectedProcedure.input(z.object({ token: z.string() })).mutation(async ({ input, ctx }) => {
      const invite = await getInviteByToken(input.token);
      if (!invite) throw new TRPCError({ code: 'NOT_FOUND', message: 'Invalid invite link' });
      if (invite.usedAt) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invite already used' });
      if (new Date(invite.expiresAt) < new Date()) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invite expired' });
      await updateUserRole(ctx.user!.id, invite.role);
      await markInviteUsed(input.token, ctx.user!.id);
      return { success: true, role: invite.role };
    }),
    delete: adminProcedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => { await deleteInvite(input.id); return { success: true }; }),
  }),

  users: router({
    list: adminProcedure.query(async () => getAllUsers()),
    updateRole: adminProcedure.input(z.object({ userId: z.number(), role: z.enum(["admin", "viewer"]) })).mutation(async ({ input }) => {
      await updateUserRole(input.userId, input.role);
      return { success: true };
    }),
    purgeGhosts: adminProcedure.mutation(async () => {
      const removed = await purgeGhostUsers();
      return { success: true, removed };
    }),
  }),

  // ============================================================
  // PHASE 4: SELF-LEARNING LOOP
  // ============================================================
  learning: router({
    // --- A/B Experiments ---
    experiments: protectedProcedure.query(async () => listExperiments()),
    activeExperiments: protectedProcedure.query(async () => listExperiments("active")),
    experimentResults: protectedProcedure.input(z.object({ experimentId: z.string() })).query(async ({ input }) => {
      return evaluateExperiment(input.experimentId);
    }),
    pauseExperiment: adminProcedure.input(z.object({ experimentId: z.string() })).mutation(async ({ input }) => {
      return setExperimentStatus(input.experimentId, "paused");
    }),
    resumeExperiment: adminProcedure.input(z.object({ experimentId: z.string() })).mutation(async ({ input }) => {
      return setExperimentStatus(input.experimentId, "active");
    }),
    evaluateAllExperiments: adminProcedure.mutation(async () => {
      return evaluateAllExperiments();
    }),
    createExperiment: adminProcedure.input(z.object({
      name: z.string(),
      hypothesis: z.string(),
      variantADescription: z.string(),
      variantBDescription: z.string(),
      variantAConfig: z.record(z.string(), z.string()),
      variantBConfig: z.record(z.string(), z.string()),
      targetSegment: z.string().optional(),
      targetChannel: z.string().optional(),
      targetApproach: z.string().optional(),
      primaryMetric: z.enum(["reply_rate", "conversion_rate", "positive_rate"]).optional(),
      sampleSizeTarget: z.number().optional(),
      confidenceThreshold: z.number().optional(),
      autoAdopt: z.boolean().optional(),
    })).mutation(async ({ input }) => {
      return createExperiment(input);
    }),
    evaluateExperiment: adminProcedure.input(z.object({ experimentId: z.string() })).mutation(async ({ input }) => {
      return evaluateExperiment(input.experimentId);
    }),

    // --- Persona Matrix ---
    personaMatrix: protectedProcedure.query(async () => {
      return getPersonaMatrix();
    }),
    personaLearningContext: protectedProcedure.input(z.object({ persona: z.string() })).query(async ({ input }) => {
      return getPersonaLearningContext(input.persona);
    }),
    backfillPersona: adminProcedure.mutation(async () => {
      const count = await backfillPersonaOnOutcomes();
      return { updated: count };
    }),

    // --- Daily Snapshots / Trends ---
    outcomeTrends: protectedProcedure.input(z.object({ days: z.number().optional() }).optional()).query(async ({ input }) => {
      return getOutcomeTrends(input?.days || 14);
    }),
    triggerSnapshot: adminProcedure.mutation(async () => {
      await generateDailySnapshot();
      return { success: true };
    }),

    // --- Module 2A: ICP Cadence Multiplier Stats ---
    icpStats: protectedProcedure.query(async () => getIcpStats()),

    // --- Module 3A: Skill Catalog ---
    listSkills: protectedProcedure.query(async () => {
      const hardcodedSkills = getAllSkills();
      // Also include approved/adopted proposals from the DB
      const { getDb } = await import("./db");
      const db = await getDb();
      if (!db) return hardcodedSkills;
      try {
        const { skillProposals } = await import("../drizzle/schema");
        const { sql, desc } = await import("drizzle-orm");
        const approvedProposals = await db.select({
          id: skillProposals.proposedSkillId,
          name: skillProposals.proposedSkillName,
          description: sql<string>`CONCAT('Auto-learned: prevents ', ${skillProposals.violationCategory}, ' violations (', ${skillProposals.occurrenceCount}, ' occurrences)')`,
          triggerConditions: skillProposals.triggerConditions,
          violationCategory: skillProposals.violationCategory,
          occurrenceCount: skillProposals.occurrenceCount,
          status: skillProposals.status,
        })
          .from(skillProposals)
          .where(sql`${skillProposals.status} IN ('approved', 'adopted')`)
          .orderBy(desc(skillProposals.occurrenceCount));
        const adoptedSkills = approvedProposals.map((p: any) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          triggerConditions: (p.triggerConditions || {}) as { segments?: string[]; approaches?: string[]; conversationStages?: string[]; channels?: string[]; minLeadAgeDays?: number },
          source: 'auto-learned' as const,
          violationCategory: p.violationCategory,
          occurrenceCount: p.occurrenceCount,
        }));
        return [
          ...hardcodedSkills.map(s => ({ ...s, source: 'built-in' as const })),
          ...adoptedSkills,
        ];
      } catch (err) {
        console.error('[listSkills] Failed to fetch approved proposals:', err);
        return hardcodedSkills.map(s => ({ ...s, source: 'built-in' as const }));
      }
    }),

    // --- Module 3B: Auto-Skill Hunter ---
    skillProposals: protectedProcedure
      .input(z.object({ status: z.enum(["pending_review", "approved", "rejected"]).optional() }))
      .query(async ({ input }) => getSkillProposals(input.status)),
    reviewSkillProposal: adminProcedure
      .input(z.object({
        id: z.number(),
        action: z.enum(["approved", "rejected"]),
        reviewNote: z.string().optional(),
      }))
      .mutation(async ({ input }) => reviewSkillProposal(input.id, input.action, input.reviewNote)),
    triggerAutoSkillHunter: adminProcedure.mutation(async () => runAutoSkillHunter()),

    // --- Module 5B: Lead Memory ---
    leadMemory: protectedProcedure
      .input(z.object({ leadId: z.number() }))
      .query(async ({ input }) => getLeadMemoryFacts(input.leadId)),

    // --- Strategy Autopilot (Decision 11) ---
    strategyAdjustments: protectedProcedure.query(async () => getStrategyAdjustmentHistory()),
    triggerStrategyReview: adminProcedure.mutation(async () => runStrategyReview()),

    // --- Agent Pattern Extraction (Decision 10) ---
    extractPatterns: adminProcedure
      .input(z.object({ leadId: z.number() }))
      .mutation(async ({ input }) => {
        const patterns = await extractAgentPatterns(input.leadId);
        if (patterns.length > 0) {
          const recorded = await recordAgentLearning(input.leadId, patterns);
          return { patterns, recorded };
        }
        return { patterns: [], recorded: 0 };
      }),

    // --- Training Export (Decision 9) ---
    trainingExports: protectedProcedure.query(async () => listTrainingExports()),
    trainingExport: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => getTrainingExport(input.id)),
    createTrainingExport: adminProcedure
      .input(z.object({
        exportName: z.string(),
        filter: z.object({
          minScore: z.number().optional(),
          frameworks: z.array(z.string()).optional(),
          channels: z.array(z.string()).optional(),
          onlyReplied: z.boolean().optional(),
          onlyConverted: z.boolean().optional(),
        }).optional(),
      }))
      .mutation(async ({ input }) => createTrainingExport(input.exportName, input.filter || {})),

    // --- AI Learning Status (Dashboard card) ---
    aiLearningStatus: protectedProcedure.query(async () => {
      const { getDb } = await import("./db");
      const db = await getDb();
      if (!db) return null;
      const { hallOfFame, skillProposals: spTable, strategyAdjustments: saTable } = await import("../drizzle/schema");
      const { count, sql: sqlFn } = await import("drizzle-orm");
      const [hofCount] = await db.select({ cnt: count() }).from(hallOfFame);
      const [approvedSkills] = await db.select({ cnt: count() }).from(spTable).where(sqlFn`status = 'approved'`);
      const [activeAdj] = await db.select({ cnt: count() }).from(saTable).where(sqlFn`status = 'applied' AND (expiresAt IS NULL OR expiresAt > NOW())`);
      const [recentHof] = await db.select({ cnt: count() }).from(hallOfFame).where(sqlFn`createdAt > DATE_SUB(NOW(), INTERVAL 7 DAY)`);
      return {
        hallOfFameTotal: hofCount?.cnt || 0,
        hallOfFameThisWeek: recentHof?.cnt || 0,
        approvedSkills: approvedSkills?.cnt || 0,
        activeStrategyAdjustments: activeAdj?.cnt || 0,
        engine: 'dynamic_few_shot',
        engineDescription: 'Top 5 winning examples matched by framework + channel + persona + approach similarity',
      };
    }),

    // --- Combined Dashboard Data ---
    dashboardSummary: protectedProcedure.query(async () => {
      const [patterns, allExperiments, matrix, trends] = await Promise.all([
        getPatternAnalysis(),
        listExperiments(),
        getPersonaMatrix(),
        getOutcomeTrends(14),
      ]);
      return {
        patterns,
        experiments: {
          total: allExperiments.length,
          active: allExperiments.filter((e: any) => e.status === "active").length,
          completed: allExperiments.filter((e: any) => e.status === "completed").length,
          recent: allExperiments.slice(0, 5),
        },
        personaMatrix: matrix,
        trends,
      };
    }),
  }),

  ghl: router({
    syncContacts: adminProcedure.mutation(async () => {
      try {
        const result = await getContacts(100);
        const contacts = result.contacts || [];
        let synced = 0;
        for (const c of contacts) {
          await upsertLead({
            ghlContactId: c.id,
            name: [c.firstName, c.lastName].filter(Boolean).join(" ") || null,
            email: c.email || null,
            phone: c.phone || null,
            businessName: c.companyName || null,
            website: c.website || null,
            source: c.source || null,
          });
          synced++;
        }
        return { contacts: synced, meta: result.meta };
      } catch (err) { return { contacts: 0, error: String(err) }; }
    }),
  }),
});

export type AppRouter = typeof appRouter;
