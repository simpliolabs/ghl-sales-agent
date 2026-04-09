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
  getAllUsers, updateUserRole, getUserByOpenId,
  getBrainCouncilAuditLog, getBrainCouncilAuditForLead, getRecentWebhookLogs,
} from "./db";
import { ENV } from "./_core/env";
import { storagePut } from "./storage";
import { getContacts, getPipelines } from "./ghl";
import { invokeLLM } from "./_core/llm";
import { scoreLeadQuick } from "./ai-brain";
import { getPatternAnalysis, backfillOutcomes } from "./outcome-engine";
import { processOverdueFollowUps } from "./follow-up-trigger";
import { runLookback } from "./lookback-engine";
import { runDispositionSweep } from "./lead-disposition";

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
      // Auto-fetch and synthesize content from Google Sheet on add
      let contentText = "";
      try {
        const sheetId = input.url.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1];
        if (sheetId) {
          const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
          const resp = await fetch(csvUrl);
          if (resp.ok) {
            const csv = await resp.text();
            const lines = csv.split("\n").filter(l => l.trim()).map(l => l.replace(/,+$/g, ""));
            const rawText = lines.join("\n");
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
      const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
      const resp = await fetch(csvUrl);
      if (!resp.ok) throw new Error("Failed to fetch sheet — make sure it's shared publicly");
      const csv = await resp.text();
      const lines = csv.split("\n").filter(l => l.trim()).map(l => l.replace(/,+$/g, ""));
      const contentText = lines.join("\n");
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
