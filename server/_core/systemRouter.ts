import { z } from "zod";
import { notifyOwner } from "./notification";
import { adminProcedure, publicProcedure, router } from "./trpc";
import { getSystemSetting, setSystemSetting, getDb } from "../db";
import { brainCouncilAudit, leads, conversations } from "../../drizzle/schema";
import { eq, desc, sql, gte, and } from "drizzle-orm";

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

  /**
   * SYSTEM HEALTH MONITOR — Layer 6.3
   * Returns operational health indicators for the dashboard.
   * Red/yellow/green status for each subsystem.
   */
  healthMonitor: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) {
      return {
        overall: "red" as const,
        indicators: [],
        lastUpdated: new Date().toISOString(),
      };
    }

    const indicators: Array<{
      name: string;
      status: "green" | "yellow" | "red";
      value: string;
      detail: string;
    }> = [];

    const now = Date.now();

    // 1. Last successful Brain Council run
    try {
      const [lastAudit] = await db.select({
        createdAt: brainCouncilAudit.createdAt,
      })
        .from(brainCouncilAudit)
        .where(eq(brainCouncilAudit.messageSent, 1))
        .orderBy(desc(brainCouncilAudit.createdAt))
        .limit(1);

      if (lastAudit) {
        const ageMinutes = Math.round((now - new Date(lastAudit.createdAt).getTime()) / (1000 * 60));
        const status = ageMinutes < 60 ? "green" : ageMinutes < 360 ? "yellow" : "red";
        indicators.push({
          name: "Last Brain Council Send",
          status,
          value: `${ageMinutes}m ago`,
          detail: ageMinutes < 60 ? "Active" : ageMinutes < 360 ? "Quiet period" : "No sends in 6+ hours",
        });
      } else {
        indicators.push({
          name: "Last Brain Council Send",
          status: "yellow",
          value: "Never",
          detail: "No messages sent yet",
        });
      }
    } catch {
      indicators.push({ name: "Last Brain Council Send", status: "red", value: "Error", detail: "Failed to query audit log" });
    }

    // 2. Framework diversity index (distinct frameworks in last 50 messages)
    try {
      const fwResult = await db.select({
        framework: brainCouncilAudit.strategyFramework,
      })
        .from(brainCouncilAudit)
        .where(and(
          eq(brainCouncilAudit.messageSent, 1),
          sql`${brainCouncilAudit.strategyFramework} IS NOT NULL`,
        ))
        .orderBy(desc(brainCouncilAudit.createdAt))
        .limit(50);

      const uniqueFrameworks = new Set(fwResult.map(r => r.framework)).size;
      const total = fwResult.length;
      const status = total < 5 ? "yellow" : uniqueFrameworks >= 4 ? "green" : uniqueFrameworks >= 2 ? "yellow" : "red";
      indicators.push({
        name: "Framework Diversity",
        status,
        value: `${uniqueFrameworks} unique / ${total} msgs`,
        detail: uniqueFrameworks >= 4 ? "Good diversity" : uniqueFrameworks >= 2 ? "Limited diversity" : "Single framework dominance",
      });
    } catch {
      indicators.push({ name: "Framework Diversity", status: "red", value: "Error", detail: "Failed to query frameworks" });
    }

    // 3. DNC leads still active (humanTakeover=0 but should be flagged)
    try {
      const [dncResult] = await db.select({
        count: sql<number>`COUNT(*)`,
      })
        .from(leads)
        .where(eq(leads.humanTakeover, 1));

      const dncCount = dncResult?.count || 0;
      const status = dncCount === 0 ? "green" : dncCount <= 5 ? "yellow" : "red";
      indicators.push({
        name: "DNC Leads Active",
        status,
        value: String(dncCount),
        detail: dncCount === 0 ? "No conflicts" : `${dncCount} leads have humanTakeover=1 but aiEnabled=1`,
      });
    } catch {
      indicators.push({ name: "DNC Leads Active", status: "yellow", value: "Error", detail: "Failed to query DNC status" });
    }

    // 4. Email formatting validation (check last 5 emails for <br> presence)
    try {
      const recentEmails = await db.select({
        finalMessage: brainCouncilAudit.finalMessage,
        channel: brainCouncilAudit.channel,
      })
        .from(brainCouncilAudit)
        .where(and(
          eq(brainCouncilAudit.messageSent, 1),
          eq(brainCouncilAudit.channel, "Email"),
        ))
        .orderBy(desc(brainCouncilAudit.createdAt))
        .limit(5);

      if (recentEmails.length === 0) {
        indicators.push({ name: "Email Formatting", status: "green", value: "N/A", detail: "No recent emails to check" });
      } else {
        // Check if emails have proper line breaks (not one long paragraph)
        const wellFormatted = recentEmails.filter(e => {
          const msg = e.finalMessage || "";
          return msg.includes("\n\n") || msg.includes("<br") || msg.includes("---");
        }).length;
        const status = wellFormatted === recentEmails.length ? "green" : wellFormatted >= recentEmails.length / 2 ? "yellow" : "red";
        indicators.push({
          name: "Email Formatting",
          status,
          value: `${wellFormatted}/${recentEmails.length} formatted`,
          detail: wellFormatted === recentEmails.length ? "All emails properly formatted" : "Some emails may be single-paragraph",
        });
      }
    } catch {
      indicators.push({ name: "Email Formatting", status: "yellow", value: "Error", detail: "Failed to check email formatting" });
    }

    // 5. LLM error rate (check recent audit entries for blocked messages)
    try {
      const oneHourAgo = new Date(now - 60 * 60 * 1000);
      const [totalResult] = await db.select({
        total: sql<number>`COUNT(*)`,
        blocked: sql<number>`SUM(CASE WHEN ${brainCouncilAudit.blocked} = 1 THEN 1 ELSE 0 END)`,
      })
        .from(brainCouncilAudit)
        .where(gte(brainCouncilAudit.createdAt, oneHourAgo));

      const total = totalResult?.total || 0;
      const blocked = totalResult?.blocked || 0;
      const errorRate = total > 0 ? Math.round((blocked / total) * 100) : 0;
      const status = total === 0 ? "green" : errorRate <= 20 ? "green" : errorRate <= 50 ? "yellow" : "red";
      indicators.push({
        name: "Block Rate (1h)",
        status,
        value: total > 0 ? `${errorRate}% (${blocked}/${total})` : "No activity",
        detail: total === 0 ? "No Brain Council runs in last hour" : errorRate <= 20 ? "Normal operation" : "High block rate — check logs",
      });
    } catch {
      indicators.push({ name: "Block Rate (1h)", status: "yellow", value: "Error", detail: "Failed to check error rate" });
    }

    // 6. AI Online status
    try {
      const val = await getSystemSetting("ai_online");
      const isOnline = val !== "0";
      indicators.push({
        name: "AI Status",
        status: isOnline ? "green" : "red",
        value: isOnline ? "Online" : "Offline",
        detail: isOnline ? "AI messaging is active" : "AI messaging is paused — no messages being sent",
      });
    } catch {
      indicators.push({ name: "AI Status", status: "red", value: "Error", detail: "Failed to check AI status" });
    }

    // Overall status: red if any red, yellow if any yellow, green otherwise
    const hasRed = indicators.some(i => i.status === "red");
    const hasYellow = indicators.some(i => i.status === "yellow");
    const overall = hasRed ? "red" : hasYellow ? "yellow" : "green";

    return {
      overall,
      indicators,
      lastUpdated: new Date().toISOString(),
    };
  }),

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
