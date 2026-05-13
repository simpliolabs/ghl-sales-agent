/**
 * STRATEGY AUTOPILOT — Autonomous Weekly Strategy Review (Decision 11)
 *
 * Runs as part of the Monday Weekly Review. Analyzes performance trends
 * and generates strategy adjustments when metrics decline.
 *
 * Flow:
 *   1. Pull 7-day trends from getOutcomeTrends()
 *   2. Identify declining metrics (>10% drop or alert-level)
 *   3. Query LLM for strategy adjustment recommendations
 *   4. Store adjustments in strategy_adjustments table
 *   5. Apply adjustments to strategist context (via tweakInstructions)
 *   6. Auto-expire adjustments after 7 days
 *
 * Connected to:
 *   - /self-learning → "Strategy Log" tab (shows adjustment history)
 *   - strategist.ts → reads active adjustments as context
 *   - _core/index.ts → triggered in Monday weekly review
 */

import { invokeLLM } from "./_core/llm";
import { getDb } from "./db";
import { strategyAdjustments } from "../drizzle/schema";
import { getOutcomeTrends } from "./persona-learning";
import { eq, and, sql, desc } from "drizzle-orm";

function getISOWeek(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * Run the autonomous strategy review.
 * Returns the number of adjustments proposed.
 */
export async function runStrategyReview(): Promise<{ proposed: number; expired: number }> {
  const db = await getDb();
  if (!db) return { proposed: 0, expired: 0 };

  const weekId = getISOWeek();
  let proposed = 0;
  let expired = 0;

  try {
    // Step 0: Expire old adjustments (older than 7 days)
    const expirationDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const expireResult = await db.update(strategyAdjustments)
      .set({ status: "expired" })
      .where(and(
        eq(strategyAdjustments.status, "applied"),
        sql`${strategyAdjustments.createdAt} < ${expirationDate}`,
      ));
    expired = (expireResult as any)[0]?.affectedRows || 0;
    if (expired > 0) {
      console.log(`[StrategyAutopilot] Expired ${expired} old adjustments`);
    }

    // Step 1: Check if we already ran this week
    const existingThisWeek = await db.select({ id: strategyAdjustments.id })
      .from(strategyAdjustments)
      .where(eq(strategyAdjustments.weekId, weekId))
      .limit(1);
    if (existingThisWeek.length > 0) {
      console.log(`[StrategyAutopilot] Already ran for ${weekId}, skipping`);
      return { proposed: 0, expired };
    }

    // Step 2: Get trends
    const trends = await getOutcomeTrends(7);
    if (!trends.trends || trends.trends.length === 0) {
      console.log(`[StrategyAutopilot] No trend data available, skipping`);
      return { proposed: 0, expired };
    }

    // Step 3: Identify declining or alert metrics
    const problems = trends.trends.filter(t => t.direction === "declining" || t.alert);
    if (problems.length === 0) {
      console.log(`[StrategyAutopilot] All metrics stable, no adjustments needed`);
      return { proposed: 0, expired };
    }

    // Step 4: Query LLM for strategy adjustments
    const problemSummary = problems.map(p =>
      `${p.metric}: ${p.current} (was ${p.previous}, ${p.changePercent > 0 ? "+" : ""}${p.changePercent}% — ${p.direction})`
    ).join("\n");

    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are a sales strategy optimizer for Adorb Custom Tees (custom t-shirts, apparel, DTF transfers).
You analyze performance metrics and propose specific, actionable strategy adjustments.

Available levers you can adjust:
1. Framework preference (which messaging frameworks to favor)
2. Channel preference (SMS vs Email vs FB)
3. Tone adjustments (more casual, more urgent, softer)
4. Timing changes (send earlier/later, different days)
5. Approach changes (more value-first, more direct, more curiosity)

Rules:
- Each adjustment must be a single, clear instruction
- Adjustments should be reversible (they auto-expire in 7 days)
- Focus on the declining metrics specifically
- Do NOT suggest banning frameworks (that's a permanent decision)
- Maximum 3 adjustments per review cycle`,
        },
        {
          role: "user",
          content: `Performance trends (last 7 days vs prior 7 days):
${problemSummary}

Current active frameworks: HORMOZI_ACA, PAS, BAB, AIDA, CASE_STUDY, SOAP_OPERA, CURIOSITY_HOOK, EMB_WINBACK, EMB_COLD, VALUE_FIRST
Current channel distribution: SMS (primary), Email (secondary), FB (when window open)

Propose 1-3 strategy adjustments to address the declining metrics.`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "strategy_adjustments",
          strict: true,
          schema: {
            type: "object",
            properties: {
              adjustments: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    triggerMetric: { type: "string", description: "The metric that triggered this adjustment" },
                    adjustment: { type: "string", description: "The specific strategy instruction to apply" },
                    appliedTo: { type: "string", description: "Where this applies: strategist_prompt, channel_weights, or timing" },
                    reasoning: { type: "string", description: "Why this adjustment should help" },
                  },
                  required: ["triggerMetric", "adjustment", "appliedTo", "reasoning"],
                  additionalProperties: false,
                },
              },
            },
            required: ["adjustments"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) return { proposed: 0, expired };

    const parsed = JSON.parse(String(content));
    const adjustments = (parsed.adjustments || []).slice(0, 3);

    // Step 5: Store adjustments
    for (const adj of adjustments) {
      const triggerMetric = problems.find(p => p.metric === adj.triggerMetric) || problems[0];
      await db.insert(strategyAdjustments).values({
        weekId,
        triggerMetric: adj.triggerMetric,
        currentValue: String(triggerMetric?.current || ""),
        previousValue: String(triggerMetric?.previous || ""),
        adjustment: adj.adjustment,
        appliedTo: adj.appliedTo || "strategist_prompt",
        status: "applied",
        appliedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
      proposed++;
      console.log(`[StrategyAutopilot] Applied: ${adj.adjustment} (trigger: ${adj.triggerMetric})`);
    }

    return { proposed, expired };
  } catch (err) {
    console.error("[StrategyAutopilot] Error:", err);
    return { proposed: 0, expired };
  }
}

/**
 * Get active strategy adjustments for injection into strategist context.
 * These are applied as tweakInstructions-style overrides.
 */
export async function getActiveStrategyAdjustments(): Promise<string> {
  const db = await getDb();
  if (!db) return "";

  try {
    const active = await db.select({
      adjustment: strategyAdjustments.adjustment,
      triggerMetric: strategyAdjustments.triggerMetric,
      appliedTo: strategyAdjustments.appliedTo,
    })
      .from(strategyAdjustments)
      .where(and(
        eq(strategyAdjustments.status, "applied"),
        sql`${strategyAdjustments.expiresAt} > NOW()`,
      ))
      .orderBy(desc(strategyAdjustments.createdAt))
      .limit(5);

    if (active.length === 0) return "";

    const lines = ["=== ACTIVE STRATEGY ADJUSTMENTS (auto-generated, expires in 7 days) ==="];
    for (const adj of active) {
      lines.push(`- [${adj.triggerMetric}] ${adj.adjustment}`);
    }
    lines.push("Follow these adjustments when making strategy decisions. They override default preferences but NOT hard constraints.");
    return lines.join("\n");
  } catch (err) {
    console.error("[StrategyAutopilot] getActiveStrategyAdjustments error:", err);
    return "";
  }
}

/**
 * Get strategy adjustment history for the UI.
 */
export async function getStrategyAdjustmentHistory(limit: number = 20): Promise<any[]> {
  const db = await getDb();
  if (!db) return [];

  try {
    return db.select()
      .from(strategyAdjustments)
      .orderBy(desc(strategyAdjustments.createdAt))
      .limit(limit);
  } catch (err) {
    console.error("[StrategyAutopilot] getStrategyAdjustmentHistory error:", err);
    return [];
  }
}
