import { z } from "zod";
import { notifyOwner } from "./notification";
import { adminProcedure, publicProcedure, router } from "./trpc";
import { getSystemSetting, setSystemSetting } from "../db";

export const systemRouter = router({
  health: publicProcedure
    .input(
      z.object({
        timestamp: z.number().min(0, "timestamp cannot be negative"),
      })
    )
    .query(() => ({
      ok: true,
    })),

  notifyOwner: adminProcedure
    .input(
      z.object({
        title: z.string().min(1, "title is required"),
        content: z.string().min(1, "content is required"),
      })
    )
    .mutation(async ({ input }) => {
      const delivered = await notifyOwner(input);
      return {
        success: delivered,
      } as const;
    }),

  // ============================================================
  // GO OFFLINE / GO ONLINE — master AI messaging toggle
  // When AI is offline, ALL autonomous senders (webhook handler,
  // fast scanner, follow-up trigger, self-review) will skip
  // Brain Council and not send any messages to leads.
  // ============================================================
  getAiStatus: adminProcedure
    .query(async () => {
      const val = await getSystemSetting("ai_online");
      // Default: online (null = never set = online)
      const isOnline = val !== "0";
      return { isOnline };
    }),

  setAiOnline: adminProcedure
    .input(z.object({ online: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      await setSystemSetting("ai_online", input.online ? "1" : "0", ctx.user?.name || "admin");
      const status = input.online ? "ONLINE" : "OFFLINE";
      console.log(`[System] AI set to ${status} by ${ctx.user?.name || "admin"}`);
      // Notify owner when going offline
      if (!input.online) {
        try {
          await notifyOwner({
            title: "🔴 AI Messaging Paused",
            content: `AI messaging has been set to OFFLINE by ${ctx.user?.name || "admin"}. No messages will be sent to leads until AI is set back online.`,
          });
        } catch { /* best effort */ }
      } else {
        try {
          await notifyOwner({
            title: "🟢 AI Messaging Resumed",
            content: `AI messaging has been set back ONLINE by ${ctx.user?.name || "admin"}. All autonomous senders are now active.`,
          });
        } catch { /* best effort */ }
      }
      return { success: true, isOnline: input.online };
    }),
});
