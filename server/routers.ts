import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import {
  getAllLeads, getHotLeads, getLeadById, getConversationHistory, getPipelineStats,
  getAiPerformanceStats, getRecentAiMessages, getKnowledgeFiles, addKnowledgeFile,
  deleteKnowledgeFile, updateKnowledgeFile, getActiveTweaks, addAiTweak, archiveTweak,
  getAgentWorkload, getPipelineEvents, getAiState, updateLeadFields,
} from "./db";
import { storagePut } from "./storage";
import { getContacts, getPipelines } from "./ghl";

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
    tweaks: protectedProcedure.query(async () => getActiveTweaks()),
    addTweak: protectedProcedure.input(z.object({ instruction: z.string() })).mutation(async ({ input, ctx }) => addAiTweak(input.instruction, ctx.user?.id)),
    archiveTweak: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => { await archiveTweak(input.id); return { success: true }; }),
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

  ghl: router({
    syncContacts: protectedProcedure.mutation(async () => {
      try { const result = await getContacts(100); return { contacts: result.contacts?.length || 0, meta: result.meta }; }
      catch (err) { return { contacts: 0, error: String(err) }; }
    }),
  }),
});

export type AppRouter = typeof appRouter;
