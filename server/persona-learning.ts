/**
 * PERSONA-AWARE LEARNING — Segment-specific strategy recommendations
 *
 * Aggregates outcome data per persona (segment) to generate specific
 * recommendations like "for Church leads: use SOCIAL_PROOF, avoid HORMOZI_ACA".
 *
 * Also includes the Daily Snapshot engine for time-series outcome tracking.
 *
 * Persona taxonomy (from shared/sales-training.ts):
 *   church, small_business, event_planner, school_sports, corporate,
 *   nonprofit, individual, reseller
 */

import { eq, and, sql, gte, desc } from "drizzle-orm";
import { getDb } from "./db";
import {
  messageOutcomes,
  dailySnapshots,
  brainCouncilAudit,
  leads,
  conversationOutcomes,
  pipelineEvents,
  type InsertDailySnapshot,
} from "../drizzle/schema";
import { cached, patternCache } from "./cache";

// ============================================================
// 1. PERSONA MAPPING — Normalize segment strings to canonical personas
// ============================================================

const PERSONA_MAP: Record<string, string[]> = {
  church: ["church", "religious", "faith", "ministry", "pastor", "congregation"],
  school_sports: ["school", "sport", "team", "coach", "athletic", "varsity"],
  event_planner: ["event", "conference", "festival", "fundraiser", "gala", "reunion"],
  corporate: ["corporate", "enterprise", "company", "business", "llc", "inc"],
  nonprofit: ["nonprofit", "charity", "foundation", "ngo", "501c"],
  reseller: ["reseller", "wholesale", "bulk", "distributor"],
  individual: ["personal", "individual", "gift", "birthday", "wedding", "family"],
  small_business: ["small business", "startup", "shop", "store", "restaurant", "salon"],
};

/**
 * Normalize a segment string to a canonical persona key.
 * Falls back to "small_business" (the default persona).
 */
export function normalizePersona(segment: string | null | undefined): string {
  if (!segment) return "small_business";
  const s = segment.toLowerCase();

  for (const [persona, keywords] of Object.entries(PERSONA_MAP)) {
    if (keywords.some(kw => s.includes(kw))) return persona;
  }

  return "small_business";
}

// ============================================================
// 2. PERSONA OUTCOME AGGREGATION
// ============================================================

export interface PersonaStats {
  persona: string;
  totalMessages: number;
  replies: number;
  replyRate: number;
  positiveReplies: number;
  positiveRate: number;
  conversions: number;
  conversionRate: number;
  dncCount: number;
  dncRate: number;
  avgReplyMinutes: number;
  // Best and worst frameworks for this persona
  bestFramework: string | null;
  bestFrameworkRate: number;
  worstFramework: string | null;
  worstFrameworkRate: number;
  // Framework breakdown
  frameworkBreakdown: Array<{
    framework: string;
    sent: number;
    replies: number;
    replyRate: number;
    conversions: number;
  }>;
}

/**
 * Get aggregated outcome stats per persona.
 * Cached for 10 minutes.
 */
export async function getPersonaMatrix(): Promise<PersonaStats[]> {
  return cached(patternCache, "persona:matrix", () => _getPersonaMatrixUncached());
}

async function _getPersonaMatrixUncached(): Promise<PersonaStats[]> {
  const db = await getDb();
  if (!db) return [];

  try {
    // Get all outcomes with persona data
    const raw = await db.select({
      persona: messageOutcomes.persona,
      framework: messageOutcomes.framework,
      totalSent: sql<number>`COUNT(*)`,
      replies: sql<number>`SUM(CASE WHEN ${messageOutcomes.gotReply} = 1 THEN 1 ELSE 0 END)`,
      positiveReplies: sql<number>`SUM(CASE WHEN ${messageOutcomes.replySentiment} = 'positive' THEN 1 ELSE 0 END)`,
      conversions: sql<number>`SUM(CASE WHEN ${messageOutcomes.converted} = 1 THEN 1 ELSE 0 END)`,
      dncCount: sql<number>`SUM(CASE WHEN ${messageOutcomes.dncTriggered} = 1 THEN 1 ELSE 0 END)`,
      avgReplyMin: sql<number>`AVG(CASE WHEN ${messageOutcomes.gotReply} = 1 THEN ${messageOutcomes.replyMinutes} ELSE NULL END)`,
    })
      .from(messageOutcomes)
      .where(sql`${messageOutcomes.persona} IS NOT NULL`)
      .groupBy(messageOutcomes.persona, messageOutcomes.framework);

    // Also get outcomes where persona is null but segment exists (backfill)
    const segmentRaw = await db.select({
      segment: messageOutcomes.segment,
      framework: messageOutcomes.framework,
      totalSent: sql<number>`COUNT(*)`,
      replies: sql<number>`SUM(CASE WHEN ${messageOutcomes.gotReply} = 1 THEN 1 ELSE 0 END)`,
      positiveReplies: sql<number>`SUM(CASE WHEN ${messageOutcomes.replySentiment} = 'positive' THEN 1 ELSE 0 END)`,
      conversions: sql<number>`SUM(CASE WHEN ${messageOutcomes.converted} = 1 THEN 1 ELSE 0 END)`,
      dncCount: sql<number>`SUM(CASE WHEN ${messageOutcomes.dncTriggered} = 1 THEN 1 ELSE 0 END)`,
      avgReplyMin: sql<number>`AVG(CASE WHEN ${messageOutcomes.gotReply} = 1 THEN ${messageOutcomes.replyMinutes} ELSE NULL END)`,
    })
      .from(messageOutcomes)
      .where(and(
        sql`${messageOutcomes.persona} IS NULL`,
        sql`${messageOutcomes.segment} IS NOT NULL`,
      ))
      .groupBy(messageOutcomes.segment, messageOutcomes.framework);

    // Merge: normalize segments to personas
    const personaMap = new Map<string, Map<string, { sent: number; replies: number; positive: number; conversions: number; dnc: number; replyMin: number; replyMinCount: number }>>();

    const addRow = (persona: string, framework: string | null, row: any) => {
      if (!personaMap.has(persona)) personaMap.set(persona, new Map());
      const fwMap = personaMap.get(persona)!;
      const fw = framework || "unknown";
      if (!fwMap.has(fw)) fwMap.set(fw, { sent: 0, replies: 0, positive: 0, conversions: 0, dnc: 0, replyMin: 0, replyMinCount: 0 });
      const entry = fwMap.get(fw)!;
      entry.sent += Number(row.totalSent) || 0;
      entry.replies += Number(row.replies) || 0;
      entry.positive += Number(row.positiveReplies) || 0;
      entry.conversions += Number(row.conversions) || 0;
      entry.dnc += Number(row.dncCount) || 0;
      const avgMin = Number(row.avgReplyMin) || 0;
      const rowReplies = Number(row.replies) || 0;
      if (avgMin > 0 && rowReplies > 0) {
        entry.replyMin += avgMin * rowReplies;
        entry.replyMinCount += rowReplies;
      }
    };

    for (const row of raw) {
      addRow(row.persona || "small_business", row.framework, row);
    }
    for (const row of segmentRaw) {
      const persona = normalizePersona(row.segment);
      addRow(persona, row.framework, row);
    }

    // Build PersonaStats
    const result: PersonaStats[] = [];
    for (const [persona, fwMap] of Array.from(personaMap.entries())) {
      let totalMessages = 0, totalReplies = 0, totalPositive = 0, totalConversions = 0, totalDnc = 0;
      let totalReplyMin = 0, totalReplyMinCount = 0;
      const frameworkBreakdown: PersonaStats["frameworkBreakdown"] = [];
      let bestFw: string | null = null, bestRate = -1;
      let worstFw: string | null = null, worstRate = 101;

      for (const [fw, stats] of Array.from(fwMap.entries())) {
        totalMessages += stats.sent;
        totalReplies += stats.replies;
        totalPositive += stats.positive;
        totalConversions += stats.conversions;
        totalDnc += stats.dnc;
        totalReplyMin += stats.replyMin;
        totalReplyMinCount += stats.replyMinCount;

        const rate = stats.sent >= 3 ? Math.round((stats.replies / stats.sent) * 100) : -1;
        frameworkBreakdown.push({
          framework: fw,
          sent: stats.sent,
          replies: stats.replies,
          replyRate: rate >= 0 ? rate : 0,
          conversions: stats.conversions,
        });

        if (rate >= 0 && stats.sent >= 3) {
          if (rate > bestRate) { bestFw = fw; bestRate = rate; }
          if (rate < worstRate) { worstFw = fw; worstRate = rate; }
        }
      }

      result.push({
        persona,
        totalMessages,
        replies: totalReplies,
        replyRate: totalMessages > 0 ? Math.round((totalReplies / totalMessages) * 100) : 0,
        positiveReplies: totalPositive,
        positiveRate: totalReplies > 0 ? Math.round((totalPositive / totalReplies) * 100) : 0,
        conversions: totalConversions,
        conversionRate: totalMessages > 0 ? Math.round((totalConversions / totalMessages) * 100) : 0,
        dncCount: totalDnc,
        dncRate: totalMessages > 0 ? Math.round((totalDnc / totalMessages) * 100) : 0,
        avgReplyMinutes: totalReplyMinCount > 0 ? Math.round(totalReplyMin / totalReplyMinCount) : 0,
        bestFramework: bestFw,
        bestFrameworkRate: bestRate >= 0 ? bestRate : 0,
        worstFramework: worstFw,
        worstFrameworkRate: worstRate <= 100 ? worstRate : 0,
        frameworkBreakdown: frameworkBreakdown.sort((a, b) => b.replyRate - a.replyRate),
      });
    }

    return result.sort((a, b) => b.totalMessages - a.totalMessages);
  } catch (err) {
    console.error("[PersonaLearning] Error getting persona matrix:", err);
    return [];
  }
}

// ============================================================
// 3. PERSONA-SPECIFIC STRATEGY RECOMMENDATIONS
// ============================================================

/**
 * Generate persona-specific strategy recommendations for the Strategist prompt.
 * Returns a text block like:
 *   "For Church leads: Use SOCIAL_PROOF (42% reply rate). Avoid HORMOZI_ACA (8% reply rate, 12% DNC)."
 */
export async function getPersonaLearningContext(persona: string): Promise<string> {
  const cacheKey = `persona:learning:${persona}`;
  return cached(patternCache, cacheKey, () => _getPersonaLearningContextUncached(persona));
}

async function _getPersonaLearningContextUncached(persona: string): Promise<string> {
  const matrix = await getPersonaMatrix();
  const stats = matrix.find(p => p.persona === persona);

  if (!stats || stats.totalMessages < 5) {
    return `PERSONA LEARNING (${persona}): Insufficient data (${stats?.totalMessages || 0} messages). Use default strategy.`;
  }

  const lines: string[] = [
    `PERSONA LEARNING (${persona} — ${stats.totalMessages} messages tracked):`,
    `  Overall: ${stats.replyRate}% reply rate, ${stats.positiveRate}% positive, ${stats.conversionRate}% conversion, ${stats.dncRate}% DNC`,
  ];

  // Best framework
  if (stats.bestFramework && stats.bestFrameworkRate > 0) {
    lines.push(`  ✓ BEST: ${stats.bestFramework} (${stats.bestFrameworkRate}% reply rate)`);
  }

  // Worst framework (only if DNC rate is concerning)
  if (stats.worstFramework && stats.worstFrameworkRate < stats.replyRate) {
    const worstFwStats = stats.frameworkBreakdown.find(f => f.framework === stats.worstFramework);
    const dncWarning = stats.dncRate > 3 ? ` — HIGH DNC RISK` : "";
    lines.push(`  ✗ AVOID: ${stats.worstFramework} (${stats.worstFrameworkRate}% reply rate${dncWarning})`);
  }

  // Top 3 frameworks with enough data
  const ranked = stats.frameworkBreakdown.filter(f => f.sent >= 3).sort((a, b) => b.replyRate - a.replyRate);
  if (ranked.length >= 2) {
    lines.push(`  Framework ranking: ${ranked.slice(0, 3).map(f => `${f.framework}(${f.replyRate}%)`).join(" > ")}`);
  }

  return lines.join("\n");
}

// ============================================================
// 4. DAILY SNAPSHOT ENGINE — Time-series outcome tracking
// ============================================================

/**
 * Generate a daily performance snapshot.
 * Should be called once per day (e.g., at midnight via cron).
 * Aggregates all outcomes from the previous day.
 */
export async function generateDailySnapshot(dateStr?: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  // Default to yesterday
  const targetDate = dateStr || getYesterdayDateStr();

  try {
    // Check if snapshot already exists
    const [existing] = await db.select()
      .from(dailySnapshots)
      .where(eq(dailySnapshots.snapshotDate, targetDate))
      .limit(1);

    if (existing) {
      console.log(`[DailySnapshot] Snapshot for ${targetDate} already exists, skipping`);
      return true;
    }

    // Date range for the target day
    const dayStart = new Date(`${targetDate}T00:00:00Z`);
    const dayEnd = new Date(`${targetDate}T23:59:59Z`);

    // Count messages sent (from brain_council_audit)
    const [sentStats] = await db.select({
      messagesSent: sql<number>`COUNT(*)`,
    })
      .from(brainCouncilAudit)
      .where(and(
        eq(brainCouncilAudit.messageSent, 1),
        gte(brainCouncilAudit.createdAt, dayStart),
        sql`${brainCouncilAudit.createdAt} <= ${dayEnd}`,
      ));

    // Count outcomes from message_outcomes attributed on this day
    const [outcomeStats] = await db.select({
      total: sql<number>`COUNT(*)`,
      replies: sql<number>`SUM(CASE WHEN ${messageOutcomes.gotReply} = 1 THEN 1 ELSE 0 END)`,
      positive: sql<number>`SUM(CASE WHEN ${messageOutcomes.replySentiment} = 'positive' THEN 1 ELSE 0 END)`,
      conversions: sql<number>`SUM(CASE WHEN ${messageOutcomes.converted} = 1 THEN 1 ELSE 0 END)`,
      dnc: sql<number>`SUM(CASE WHEN ${messageOutcomes.dncTriggered} = 1 THEN 1 ELSE 0 END)`,
      avgReplyMin: sql<number>`AVG(CASE WHEN ${messageOutcomes.gotReply} = 1 THEN ${messageOutcomes.replyMinutes} ELSE NULL END)`,
      stageAdvances: sql<number>`SUM(CASE WHEN ${messageOutcomes.stageAdvanced} = 1 THEN 1 ELSE 0 END)`,
    })
      .from(messageOutcomes)
      .where(and(
        gte(messageOutcomes.createdAt, dayStart),
        sql`${messageOutcomes.createdAt} <= ${dayEnd}`,
      ));

    const messagesSent = sentStats?.messagesSent || 0;
    const repliesReceived = outcomeStats?.replies || 0;
    const total = outcomeStats?.total || 0;

    // Framework breakdown
    const fwBreakdown = await db.select({
      framework: messageOutcomes.framework,
      sent: sql<number>`COUNT(*)`,
      replies: sql<number>`SUM(CASE WHEN ${messageOutcomes.gotReply} = 1 THEN 1 ELSE 0 END)`,
      conversions: sql<number>`SUM(CASE WHEN ${messageOutcomes.converted} = 1 THEN 1 ELSE 0 END)`,
    })
      .from(messageOutcomes)
      .where(and(
        gte(messageOutcomes.createdAt, dayStart),
        sql`${messageOutcomes.createdAt} <= ${dayEnd}`,
        sql`${messageOutcomes.framework} IS NOT NULL`,
      ))
      .groupBy(messageOutcomes.framework);

    // Channel breakdown
    const chBreakdown = await db.select({
      channel: messageOutcomes.channel,
      sent: sql<number>`COUNT(*)`,
      replies: sql<number>`SUM(CASE WHEN ${messageOutcomes.gotReply} = 1 THEN 1 ELSE 0 END)`,
      conversions: sql<number>`SUM(CASE WHEN ${messageOutcomes.converted} = 1 THEN 1 ELSE 0 END)`,
    })
      .from(messageOutcomes)
      .where(and(
        gte(messageOutcomes.createdAt, dayStart),
        sql`${messageOutcomes.createdAt} <= ${dayEnd}`,
        sql`${messageOutcomes.channel} IS NOT NULL`,
      ))
      .groupBy(messageOutcomes.channel);

    // Persona breakdown
    const personaBreakdown = await db.select({
      persona: messageOutcomes.persona,
      sent: sql<number>`COUNT(*)`,
      replies: sql<number>`SUM(CASE WHEN ${messageOutcomes.gotReply} = 1 THEN 1 ELSE 0 END)`,
      conversions: sql<number>`SUM(CASE WHEN ${messageOutcomes.converted} = 1 THEN 1 ELSE 0 END)`,
    })
      .from(messageOutcomes)
      .where(and(
        gte(messageOutcomes.createdAt, dayStart),
        sql`${messageOutcomes.createdAt} <= ${dayEnd}`,
        sql`${messageOutcomes.persona} IS NOT NULL`,
      ))
      .groupBy(messageOutcomes.persona);

    // Experiment breakdown
    const expBreakdown = await db.select({
      experimentId: messageOutcomes.experimentId,
      variant: messageOutcomes.variant,
      sent: sql<number>`COUNT(*)`,
      successes: sql<number>`SUM(CASE WHEN ${messageOutcomes.gotReply} = 1 THEN 1 ELSE 0 END)`,
    })
      .from(messageOutcomes)
      .where(and(
        gte(messageOutcomes.createdAt, dayStart),
        sql`${messageOutcomes.createdAt} <= ${dayEnd}`,
        sql`${messageOutcomes.experimentId} IS NOT NULL`,
      ))
      .groupBy(messageOutcomes.experimentId, messageOutcomes.variant);

    // Pipeline outcomes
    const [pipelineStats] = await db.select({
      won: sql<number>`SUM(CASE WHEN ${conversationOutcomes.outcome} = 'won' THEN 1 ELSE 0 END)`,
      lost: sql<number>`SUM(CASE WHEN ${conversationOutcomes.outcome} = 'lost' THEN 1 ELSE 0 END)`,
      value: sql<number>`SUM(CASE WHEN ${conversationOutcomes.outcome} = 'won' THEN ${conversationOutcomes.pipelineValue} ELSE 0 END)`,
    })
      .from(conversationOutcomes)
      .where(and(
        gte(conversationOutcomes.createdAt, dayStart.getTime()),
        sql`${conversationOutcomes.createdAt} <= ${dayEnd.getTime()}`,
      ));

    // Build JSON breakdowns
    const fwJson: Record<string, any> = {};
    for (const r of fwBreakdown) {
      fwJson[r.framework || "unknown"] = { sent: r.sent, replies: r.replies, conversions: r.conversions };
    }

    const chJson: Record<string, any> = {};
    for (const r of chBreakdown) {
      chJson[r.channel || "unknown"] = { sent: r.sent, replies: r.replies, conversions: r.conversions };
    }

    const pJson: Record<string, any> = {};
    for (const r of personaBreakdown) {
      pJson[r.persona || "unknown"] = { sent: r.sent, replies: r.replies, conversions: r.conversions };
    }

    const eJson: Record<string, any> = {};
    for (const r of expBreakdown) {
      const eid = r.experimentId || "unknown";
      if (!eJson[eid]) eJson[eid] = {};
      eJson[eid][`variant${r.variant}`] = { sent: r.sent, successes: r.successes };
    }

    const snapshot: InsertDailySnapshot = {
      snapshotDate: targetDate,
      messagesSent,
      repliesReceived,
      replyRate: total > 0 ? Math.round((repliesReceived / total) * 100) : 0,
      positiveRate: repliesReceived > 0 ? Math.round(((outcomeStats?.positive || 0) / repliesReceived) * 100) : 0,
      conversionRate: total > 0 ? Math.round(((outcomeStats?.conversions || 0) / total) * 100) : 0,
      dncRate: total > 0 ? Math.round(((outcomeStats?.dnc || 0) / total) * 100) : 0,
      avgReplyMinutes: Math.round(outcomeStats?.avgReplyMin || 0),
      frameworkBreakdown: fwJson,
      channelBreakdown: chJson,
      personaBreakdown: pJson,
      experimentBreakdown: Object.keys(eJson).length > 0 ? eJson : null,
      stageAdvances: outcomeStats?.stageAdvances || 0,
      leadsWon: pipelineStats?.won || 0,
      leadsLost: pipelineStats?.lost || 0,
      pipelineValueAdded: pipelineStats?.value || 0,
    };

    await db.insert(dailySnapshots).values(snapshot);
    console.log(`[DailySnapshot] Generated snapshot for ${targetDate}: ${messagesSent} sent, ${repliesReceived} replies, ${outcomeStats?.conversions || 0} conversions`);
    return true;
  } catch (err) {
    console.error("[DailySnapshot] Error generating snapshot:", err);
    return false;
  }
}

// ============================================================
// 5. TREND ANALYSIS — Detect improving/declining metrics
// ============================================================

export interface OutcomeTrend {
  metric: string;
  current: number;
  previous: number;
  change: number;
  changePercent: number;
  direction: "improving" | "declining" | "stable";
  alert: boolean; // true if change is significant (>20%)
}

export interface TrendReport {
  period: string; // e.g., "last_7d vs prior_7d"
  trends: OutcomeTrend[];
  snapshots: Array<{
    date: string;
    messagesSent: number;
    replyRate: number;
    conversionRate: number;
    dncRate: number;
  }>;
}

/**
 * Get outcome trends comparing recent period to prior period.
 */
export async function getOutcomeTrends(days: number = 7): Promise<TrendReport> {
  const db = await getDb();
  const empty: TrendReport = { period: `last_${days}d vs prior_${days}d`, trends: [], snapshots: [] };
  if (!db) return empty;

  try {
    const snapshots = await db.select()
      .from(dailySnapshots)
      .orderBy(desc(dailySnapshots.snapshotDate))
      .limit(days * 2 + 1);

    if (snapshots.length < 3) return empty;

    const recent = snapshots.slice(0, Math.min(days, snapshots.length));
    const prior = snapshots.slice(days, Math.min(days * 2, snapshots.length));

    const avg = (arr: any[], field: string) => {
      const vals = arr.map(s => (s as any)[field] || 0);
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    };

    const sum = (arr: any[], field: string) => {
      return arr.map(s => (s as any)[field] || 0).reduce((a, b) => a + b, 0);
    };

    const buildTrend = (metric: string, currentVal: number, previousVal: number): OutcomeTrend => {
      const change = currentVal - previousVal;
      const changePercent = previousVal > 0 ? Math.round((change / previousVal) * 100) : 0;
      const isPositiveMetric = metric !== "dncRate"; // DNC going up is bad
      const direction: OutcomeTrend["direction"] =
        Math.abs(changePercent) < 5 ? "stable" :
        (isPositiveMetric ? (change > 0 ? "improving" : "declining") : (change < 0 ? "improving" : "declining"));
      return {
        metric,
        current: Math.round(currentVal * 10) / 10,
        previous: Math.round(previousVal * 10) / 10,
        change: Math.round(change * 10) / 10,
        changePercent,
        direction,
        alert: Math.abs(changePercent) > 20,
      };
    };

    const trends: OutcomeTrend[] = [
      buildTrend("messagesSent", sum(recent, "messagesSent"), sum(prior, "messagesSent")),
      buildTrend("replyRate", avg(recent, "replyRate"), avg(prior, "replyRate")),
      buildTrend("positiveRate", avg(recent, "positiveRate"), avg(prior, "positiveRate")),
      buildTrend("conversionRate", avg(recent, "conversionRate"), avg(prior, "conversionRate")),
      buildTrend("dncRate", avg(recent, "dncRate"), avg(prior, "dncRate")),
      buildTrend("avgReplyMinutes", avg(recent, "avgReplyMinutes"), avg(prior, "avgReplyMinutes")),
    ];

    return {
      period: `last_${days}d vs prior_${days}d`,
      trends,
      snapshots: recent.map(s => ({
        date: s.snapshotDate,
        messagesSent: s.messagesSent || 0,
        replyRate: s.replyRate || 0,
        conversionRate: s.conversionRate || 0,
        dncRate: s.dncRate || 0,
      })),
    };
  } catch (err) {
    console.error("[PersonaLearning] Error getting trends:", err);
    return empty;
  }
}

// ============================================================
// 6. BACKFILL PERSONA ON EXISTING OUTCOMES
// ============================================================

/**
 * Backfill persona field on existing message_outcomes that have segment but no persona.
 */
export async function backfillPersonaOnOutcomes(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  try {
    // Get outcomes with segment but no persona
    const untagged = await db.select({
      id: messageOutcomes.id,
      segment: messageOutcomes.segment,
      leadId: messageOutcomes.leadId,
    })
      .from(messageOutcomes)
      .where(and(
        sql`${messageOutcomes.persona} IS NULL`,
        sql`${messageOutcomes.segment} IS NOT NULL`,
      ))
      .limit(200);

    let updated = 0;
    for (const row of untagged) {
      const persona = normalizePersona(row.segment);
      await db.update(messageOutcomes)
        .set({ persona })
        .where(eq(messageOutcomes.id, row.id));
      updated++;
    }

    // Also tag outcomes that have no segment — look up from lead
    const noSegment = await db.select({
      id: messageOutcomes.id,
      leadId: messageOutcomes.leadId,
    })
      .from(messageOutcomes)
      .where(and(
        sql`${messageOutcomes.persona} IS NULL`,
        sql`${messageOutcomes.segment} IS NULL`,
      ))
      .limit(200);

    for (const row of noSegment) {
      const [lead] = await db.select({ segment: leads.omnisendSegment })
        .from(leads)
        .where(eq(leads.id, row.leadId))
        .limit(1);

      if (lead?.segment) {
        const persona = normalizePersona(lead.segment);
        await db.update(messageOutcomes)
          .set({ segment: lead.segment, persona })
          .where(eq(messageOutcomes.id, row.id));
        updated++;
      }
    }

    if (updated > 0) {
      console.log(`[PersonaLearning] Backfilled persona on ${updated} outcome records`);
    }
    return updated;
  } catch (err) {
    console.error("[PersonaLearning] Error backfilling persona:", err);
    return 0;
  }
}

// ============================================================
// HELPERS
// ============================================================

function getYesterdayDateStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

// ============================================================
// EXPORTS for testing
// ============================================================
export { PERSONA_MAP, getYesterdayDateStr };
