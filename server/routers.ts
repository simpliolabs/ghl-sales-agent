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
} from "./db";
import { ENV } from "./_core/env";
import { storagePut } from "./storage";
import { getContacts, getPipelines } from "./ghl";

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
    list: protectedProcedure.query(async () => getAllLeads(200)),
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
  }),

  pipeline: router({
    stats: protectedProcedure.query(async () => getPipelineStats()),
    ghlPipelines: protectedProcedure.query(async () => { try { return await getPipelines(); } catch { return []; } }),
  }),

  ai: router({
    performance: protectedProcedure.query(async () => getAiPerformanceStats()),
    recentMessages: protectedProcedure.query(async () => getRecentAiMessages(30)),
    tweaks: adminProcedure.query(async () => getActiveTweaks()),
    addTweak: adminProcedure.input(z.object({ instruction: z.string() })).mutation(async ({ input, ctx }) => addAiTweak(input.instruction, ctx.user?.id)),
    archiveTweak: adminProcedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => { await archiveTweak(input.id); return { success: true }; }),
  }),

  knowledge: router({
    list: protectedProcedure.query(async () => getKnowledgeFiles()),
    upload: protectedProcedure.input(z.object({
      fileName: z.string(), fileType: z.string(), fileData: z.string(), contentText: z.string().optional(),
    })).mutation(async ({ input }) => {
      const buffer = Buffer.from(input.fileData, "base64");
      const fileKey = `knowledge/${Date.now()}-${input.fileName}`;
      const { url } = await storagePut(fileKey, buffer, input.fileType);
      return addKnowledgeFile({ fileName: input.fileName, fileType: input.fileType, fileUrl: url, contentText: input.contentText || "" });
    }),
    addGoogleSheet: protectedProcedure.input(z.object({ name: z.string(), url: z.string() })).mutation(async ({ input }) => {
      return addKnowledgeFile({ fileName: input.name, fileType: "google_sheet", googleSheetUrl: input.url, contentText: "" });
    }),
    updateContent: protectedProcedure.input(z.object({ id: z.number(), contentText: z.string() })).mutation(async ({ input }) => {
      await updateKnowledgeFile(input.id, { contentText: input.contentText, lastSyncedAt: new Date() });
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
