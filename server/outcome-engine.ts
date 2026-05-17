/**
 * OUTCOME ENGINE — Self-learning infrastructure for Adorb Outreach
 * 
 * Three responsibilities:
 * 1. ATTRIBUTION: When a lead replies, attribute the outcome to the AI message that caused it
 * 2. PATTERN ANALYSIS: Aggregate win rates by framework/angle/segment/channel
 * 3. LEARNING CONTEXT: Generate a summary the Strategist brain can use to pick better strategies
 * 
 * Attribution window: 72 hours (if lead replies within 72h of an AI message, that message gets credit)
 * Conversion stages: Paid - Proof Needed, Approved + Deposit, Delivered
 */

import { eq, desc, and, sql, gte, isNull } from "drizzle-orm";
import { getDb, recordSegmentOutcome } from "./db";
import { brainCouncilAudit, messageOutcomes, leads, conversations, pipelineEvents, abExperiments, decisionLog } from "../drizzle/schema";
import { invokeLLM } from "./_core/llm";
import { cached, patternCache } from "./cache";
import { DNC_KEYWORDS } from "./scheduling-engine";
import { STAGES } from "./webhook-helpers";
import { recordAbOutcome } from "./fine-tuning-pipeline";

// --- CONSTANTS ---
const ATTRIBUTION_WINDOW_HOURS = 72;
// Use STAGES from webhook-helpers to stay in sync with GHL pipeline
const CONVERSION_STAGES: string[] = [STAGES.PAID_PROOF_NEEDED, STAGES.APPROVED, STAGES.DELIVERED];
const POSITIVE_STAGES: string[] = [STAGES.QUALIFIED, STAGES.QUOTE_SENT, STAGES.PAID_PROOF_NEEDED, STAGES.PROOF_SENT, STAGES.APPROVED, STAGES.IN_PRODUCTION, STAGES.READY, STAGES.DELIVERED];

// =================================================================
// 1. ATTRIBUTION — Link inbound replies to the AI message that caused them
// =================================================================

/**
 * Called when an inbound message arrives. Finds the most recent AI audit entry
 * for this lead within the attribution window and records the outcome.
 * 
 * Checks BOTH sources:
 *   1. decision_log (single brain, promptVersion='v3.0'+) — preferred
 *   2. brain_council_audit (legacy 4-brain pipeline) — fallback
 * Uses whichever has the most recent sent message.
 */
export async function attributeReply(opts: {
  leadId: number;
  replyMessage: string;
  replyTimestamp: Date;
  channel: string;
}): Promise<{ auditId: number; replyMinutes: number; sentiment: string } | null> {
  const db = await getDb();
  if (!db) return null;

  const windowStart = new Date(opts.replyTimestamp.getTime() - ATTRIBUTION_WINDOW_HOURS * 60 * 60 * 1000);

  // --- Check decision_log (single brain) for recent sent messages ---
  const recentDecisions = await db.select()
    .from(decisionLog)
    .where(and(
      eq(decisionLog.leadId, opts.leadId),
      sql`(${decisionLog.outputGuardResult} = 'pass' OR ${decisionLog.outputGuardResult} LIKE 'corrected:%')`,
      sql`${decisionLog.brainReasoning} IS NOT NULL`,
      gte(decisionLog.createdAt, windowStart),
    ))
    .orderBy(desc(decisionLog.createdAt))
    .limit(1);

  // --- Check brain_council_audit (legacy) for recent sent messages ---
  const recentAudits = await db.select()
    .from(brainCouncilAudit)
    .where(and(
      eq(brainCouncilAudit.leadId, opts.leadId),
      eq(brainCouncilAudit.messageSent, 1),
      gte(brainCouncilAudit.createdAt, windowStart),
    ))
    .orderBy(desc(brainCouncilAudit.createdAt))
    .limit(1);

  // Pick the most recent source
  const dlEntry = recentDecisions[0];
  const bcaEntry = recentAudits[0];
  const dlTime = dlEntry ? new Date(dlEntry.createdAt).getTime() : 0;
  const bcaTime = bcaEntry ? new Date(bcaEntry.createdAt).getTime() : 0;

  if (!dlEntry && !bcaEntry) return null;

  const useSingleBrain = dlTime >= bcaTime && !!dlEntry;

  // Compute common fields
  const sentAt = useSingleBrain ? dlTime : bcaTime;
  const replyMinutes = Math.round((opts.replyTimestamp.getTime() - sentAt) / (1000 * 60));
  const sentiment = classifySentimentFast(opts.replyMessage);
  const isDnc = isDncReply(opts.replyMessage);

  if (useSingleBrain && dlEntry) {
    // --- SINGLE BRAIN ATTRIBUTION PATH ---
    return _attributeReplyFromDecisionLog(db, opts, dlEntry, replyMinutes, sentiment, isDnc);
  } else if (bcaEntry) {
    // --- LEGACY ATTRIBUTION PATH ---
    return _attributeReplyFromBrainCouncilAudit(db, opts, bcaEntry, replyMinutes, sentiment, isDnc);
  }
  return null;
}

/** Attribute a reply to a decision_log entry (single brain). */
async function _attributeReplyFromDecisionLog(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  opts: { leadId: number; replyMessage: string; replyTimestamp: Date; channel: string },
  dl: typeof decisionLog.$inferSelect,
  replyMinutes: number,
  sentiment: string,
  isDnc: boolean,
): Promise<{ auditId: number; replyMinutes: number; sentiment: string }> {
  // Check for existing outcome linked to this decision_log entry
  const existing = await db.select()
    .from(messageOutcomes)
    .where(eq(messageOutcomes.decisionLogId, dl.id))
    .limit(1);

  if (existing.length > 0) {
    if (!existing[0].gotReply) {
      await db.update(messageOutcomes)
        .set({ gotReply: 1, replyMinutes, replySentiment: sentiment, dncTriggered: isDnc ? 1 : 0, attributedAt: opts.replyTimestamp })
        .where(eq(messageOutcomes.id, existing[0].id));
    }
    return { auditId: Number(dl.id), replyMinutes, sentiment };
  }

  // Create new outcome record linked to decision_log
  await db.insert(messageOutcomes).values({
    auditId: 0, // No brain_council_audit entry for single brain
    decisionLogId: Number(dl.id),
    leadId: opts.leadId,
    channel: dl.channel || opts.channel,
    gotReply: 1,
    replyMinutes,
    replySentiment: sentiment,
    dncTriggered: isDnc ? 1 : 0,
    attributedAt: opts.replyTimestamp,
  });

  // --- HALL OF FAME AUTO-PROMOTION ---
  try {
    const shouldPromote = (replyMinutes < 30 && sentiment !== "negative") || sentiment === "positive";
    if (shouldPromote && dl.brainReasoning) {
      const { promoteToHallOfFame } = await import("./db");
      const reason = sentiment === "positive" ? "positive_reply" : "fast_reply";
      await promoteToHallOfFame({
        auditId: Number(dl.id),
        leadId: opts.leadId,
        message: dl.brainReasoning,
        framework: "single_brain",
        approach: dl.trigger || undefined,
        channel: dl.channel || undefined,
        replyMinutes,
        replySentiment: sentiment,
        promotionReason: reason,
      });
      console.log(`[Outcome] \u{1F3C6} Hall of Fame (single brain): dl ${dl.id} promoted (${reason}, ${replyMinutes}min, ${sentiment})`);
    }
  } catch (hofErr) {
    console.error("[Outcome] Hall of Fame promotion error (non-fatal):", hofErr);
  }

  // --- CHANNEL PERFORMANCE TRACKING ---
  try {
    const { upsertChannelPerformance } = await import("./db");
    await upsertChannelPerformance(opts.leadId, opts.channel, {
      replied: true,
      replyMinutes,
      positiveSentiment: sentiment === "positive",
    });
  } catch (cpErr) {
    console.error("[Outcome] Channel performance update error (non-fatal):", cpErr);
  }

  // --- SEGMENT WEIGHT RECORDING (WIN) ---
  try {
    const approach = dl.trigger || "single_brain";
    if (opts.channel) {
      const [leadRow] = await db.select({ segment: leads.omnisendSegment, stage: leads.pipelineStage })
        .from(leads).where(eq(leads.id, opts.leadId)).limit(1);
      const segment = leadRow?.segment || "unknown";
      const stage = leadRow?.stage || "new_lead";
      await recordSegmentOutcome(segment, opts.channel, stage, approach, "win");
      console.log(`[Outcome] \u{1F4CA} Segment weight WIN (single brain): ${segment}/${opts.channel}/${stage}/${approach}`);
    }
  } catch (swErr) {
    console.error("[Outcome] Segment weight recording error (non-fatal):", swErr);
  }

  return { auditId: Number(dl.id), replyMinutes, sentiment };
}

/** Attribute a reply to a brain_council_audit entry (legacy). */
async function _attributeReplyFromBrainCouncilAudit(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  opts: { leadId: number; replyMessage: string; replyTimestamp: Date; channel: string },
  audit: typeof brainCouncilAudit.$inferSelect,
  replyMinutes: number,
  sentiment: string,
  isDnc: boolean,
): Promise<{ auditId: number; replyMinutes: number; sentiment: string }> {
  // Check if we already have an outcome for this audit entry
  const existing = await db.select()
    .from(messageOutcomes)
    .where(eq(messageOutcomes.auditId, audit.id))
    .limit(1);

  if (existing.length > 0) {
    if (!existing[0].gotReply) {
      await db.update(messageOutcomes)
        .set({ gotReply: 1, replyMinutes, replySentiment: sentiment, dncTriggered: isDnc ? 1 : 0, attributedAt: opts.replyTimestamp })
        .where(eq(messageOutcomes.id, existing[0].id));
    }
    return { auditId: audit.id, replyMinutes, sentiment };
  }

  // Create new outcome record
  await db.insert(messageOutcomes).values({
    auditId: audit.id,
    leadId: opts.leadId,
    framework: audit.strategyFramework,
    angle: audit.strategyApproach,
    approach: audit.strategyApproach,
    channel: audit.channel,
    segment: undefined,
    agentName: audit.composerFromName,
    personalizationTier: audit.strategyTier ? parseInt(audit.strategyTier) : undefined,
    experimentId: (audit as any).experimentId || undefined,
    variant: (audit as any).variant || undefined,
    persona: (audit as any).persona || undefined,
    emailSubject: (audit as any).emailSubject || undefined,
    gotReply: 1,
    replyMinutes,
    replySentiment: sentiment,
    dncTriggered: isDnc ? 1 : 0,
    attributedAt: opts.replyTimestamp,
  });

  // --- HALL OF FAME AUTO-PROMOTION ---
  try {
    const shouldPromote = (replyMinutes < 30 && sentiment !== "negative") || sentiment === "positive";
    if (shouldPromote && audit.finalMessage) {
      const { promoteToHallOfFame } = await import("./db");
      const reason = sentiment === "positive" ? "positive_reply" : "fast_reply";
      await promoteToHallOfFame({
        auditId: audit.id,
        leadId: opts.leadId,
        message: audit.finalMessage,
        framework: audit.strategyFramework || "unknown",
        approach: audit.strategyApproach || undefined,
        channel: audit.channel || undefined,
        persona: (audit as any).persona || undefined,
        replyMinutes,
        replySentiment: sentiment,
        promotionReason: reason,
      });
      console.log(`[Outcome] \u{1F3C6} Hall of Fame: audit ${audit.id} promoted (${reason}, ${replyMinutes}min, ${sentiment})`);
    }
  } catch (hofErr) {
    console.error("[Outcome] Hall of Fame promotion error (non-fatal):", hofErr);
  }

  // --- CHANNEL PERFORMANCE TRACKING ---
  try {
    const { upsertChannelPerformance } = await import("./db");
    await upsertChannelPerformance(opts.leadId, opts.channel, {
      replied: true,
      replyMinutes,
      positiveSentiment: sentiment === "positive",
    });
  } catch (cpErr) {
    console.error("[Outcome] Channel performance update error (non-fatal):", cpErr);
  }

  // --- FINE-TUNING A/B OUTCOME RECORDING ---
  try {
    if ((audit as any).fineTuningJobId) {
      const isPositive = sentiment === "positive" || replyMinutes < 30;
      const isFineTuned = !!(audit as any).modelUsed && (audit as any).modelUsed !== "gemini-2.5-flash";
      await recordAbOutcome((audit as any).fineTuningJobId, isFineTuned, isPositive);
      console.log(`[Outcome] Fine-tuning A/B recorded: job=${(audit as any).fineTuningJobId}, fineTuned=${isFineTuned}, positive=${isPositive}`);
    }
  } catch (ftErr) {
    console.error("[Outcome] Fine-tuning A/B recording error (non-fatal):", ftErr);
  }

  // --- SEGMENT WEIGHT RECORDING (WIN) ---
  try {
    const approach = audit.strategyApproach || audit.strategyFramework;
    if (approach && opts.channel) {
      const [leadRow] = await db.select({ segment: leads.omnisendSegment, stage: leads.pipelineStage })
        .from(leads).where(eq(leads.id, opts.leadId)).limit(1);
      const segment = (audit as any).persona || leadRow?.segment || "unknown";
      const stage = leadRow?.stage || "new_lead";
      await recordSegmentOutcome(segment, opts.channel, stage, approach, "win");
      console.log(`[Outcome] \u{1F4CA} Segment weight WIN: ${segment}/${opts.channel}/${stage}/${approach}`);
    }
  } catch (swErr) {
    console.error("[Outcome] Segment weight recording error (non-fatal):", swErr);
  }

  return { auditId: audit.id, replyMinutes, sentiment };
}

/**
 * Called when a pipeline stage changes. Attributes the conversion to the most recent
 * AI message for this lead.
 */
export async function attributeStageAdvance(opts: {
  leadId: number;
  toStage: string;
  previousScore?: number;
  newScore?: number;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const windowStart = new Date(Date.now() - ATTRIBUTION_WINDOW_HOURS * 60 * 60 * 1000);
  const isConversion = CONVERSION_STAGES.includes(opts.toStage);
  const scoreChange = (opts.newScore !== undefined && opts.previousScore !== undefined)
    ? opts.newScore - opts.previousScore : undefined;

  // --- Check decision_log (single brain) ---
  const recentDecisions = await db.select()
    .from(decisionLog)
    .where(and(
      eq(decisionLog.leadId, opts.leadId),
      sql`(${decisionLog.outputGuardResult} = 'pass' OR ${decisionLog.outputGuardResult} LIKE 'corrected:%')`,
      sql`${decisionLog.brainReasoning} IS NOT NULL`,
      gte(decisionLog.createdAt, windowStart),
    ))
    .orderBy(desc(decisionLog.createdAt))
    .limit(1);

  // --- Check brain_council_audit (legacy) ---
  const recentAudits = await db.select()
    .from(brainCouncilAudit)
    .where(and(
      eq(brainCouncilAudit.leadId, opts.leadId),
      eq(brainCouncilAudit.messageSent, 1),
      gte(brainCouncilAudit.createdAt, windowStart),
    ))
    .orderBy(desc(brainCouncilAudit.createdAt))
    .limit(1);

  const dlEntry = recentDecisions[0];
  const bcaEntry = recentAudits[0];
  const dlTime = dlEntry ? new Date(dlEntry.createdAt).getTime() : 0;
  const bcaTime = bcaEntry ? new Date(bcaEntry.createdAt).getTime() : 0;

  if (!dlEntry && !bcaEntry) return;

  const useSingleBrain = dlTime >= bcaTime && !!dlEntry;

  if (useSingleBrain && dlEntry) {
    // Single brain path — use decisionLogId
    const existing = await db.select()
      .from(messageOutcomes)
      .where(eq(messageOutcomes.decisionLogId, Number(dlEntry.id)))
      .limit(1);

    if (existing.length > 0) {
      await db.update(messageOutcomes)
        .set({ stageAdvanced: 1, toStage: opts.toStage, converted: isConversion ? 1 : 0, scoreChange, attributedAt: new Date() })
        .where(eq(messageOutcomes.id, existing[0].id));
    } else {
      await db.insert(messageOutcomes).values({
        auditId: 0,
        decisionLogId: Number(dlEntry.id),
        leadId: opts.leadId,
        channel: dlEntry.channel || undefined,
        stageAdvanced: 1,
        toStage: opts.toStage,
        converted: isConversion ? 1 : 0,
        scoreChange,
        attributedAt: new Date(),
      });
    }
  } else if (bcaEntry) {
    // Legacy path — use auditId
    const existing = await db.select()
      .from(messageOutcomes)
      .where(eq(messageOutcomes.auditId, bcaEntry.id))
      .limit(1);

    if (existing.length > 0) {
      await db.update(messageOutcomes)
        .set({ stageAdvanced: 1, toStage: opts.toStage, converted: isConversion ? 1 : 0, scoreChange, attributedAt: new Date() })
        .where(eq(messageOutcomes.id, existing[0].id));
    } else {
      await db.insert(messageOutcomes).values({
        auditId: bcaEntry.id,
        leadId: opts.leadId,
        framework: bcaEntry.strategyFramework,
        angle: bcaEntry.strategyApproach,
        approach: bcaEntry.strategyApproach,
        channel: bcaEntry.channel,
        agentName: bcaEntry.composerFromName,
        personalizationTier: bcaEntry.strategyTier ? parseInt(bcaEntry.strategyTier) : undefined,
        experimentId: (bcaEntry as any).experimentId || undefined,
        variant: (bcaEntry as any).variant || undefined,
        persona: (bcaEntry as any).persona || undefined,
        stageAdvanced: 1,
        toStage: opts.toStage,
        converted: isConversion ? 1 : 0,
        scoreChange,
        attributedAt: new Date(),
      });
    }
  }
}

// =================================================================
// 2. PATTERN ANALYSIS — Aggregate win rates across dimensions
// =================================================================

export interface FrameworkStats {
  framework: string;
  totalSent: number;
  replies: number;
  replyRate: number;
  avgReplyMinutes: number;
  positiveReplies: number;
  positiveRate: number;
  conversions: number;
  conversionRate: number;
  stageAdvances: number;
  dncCount: number;
  dncRate: number;
}

export interface SegmentStats {
  segment: string;
  bestFramework: string;
  bestReplyRate: number;
  totalMessages: number;
  totalReplies: number;
  overallReplyRate: number;
}

export interface ChannelStats {
  channel: string;
  totalSent: number;
  replies: number;
  replyRate: number;
  avgReplyMinutes: number;
  conversions: number;
}

export interface LearningInsights {
  frameworkStats: FrameworkStats[];
  segmentStats: SegmentStats[];
  channelStats: ChannelStats[];
  topPerformers: { framework: string; segment: string; replyRate: number; sampleSize: number }[];
  overallReplyRate: number;
  overallConversionRate: number;
  totalTracked: number;
  lastUpdated: Date;
}

/**
 * Aggregate all outcome data into actionable insights.
 * Called by the Strategist brain and the dashboard.
 */
export async function getPatternAnalysis(): Promise<LearningInsights> {
  return cached(patternCache, `patterns:all`, () => _getPatternAnalysisUncached());
}

async function _getPatternAnalysisUncached(): Promise<LearningInsights> {
  const db = await getDb();
  const empty: LearningInsights = {
    frameworkStats: [], segmentStats: [], channelStats: [], topPerformers: [],
    overallReplyRate: 0, overallConversionRate: 0, totalTracked: 0, lastUpdated: new Date(),
  };
  if (!db) return empty;

  // --- Framework stats ---
  const fwRaw = await db.select({
    framework: messageOutcomes.framework,
    totalSent: sql<number>`COUNT(*)`,
    replies: sql<number>`SUM(CASE WHEN ${messageOutcomes.gotReply} = 1 THEN 1 ELSE 0 END)`,
    avgReplyMin: sql<number>`AVG(CASE WHEN ${messageOutcomes.gotReply} = 1 THEN ${messageOutcomes.replyMinutes} ELSE NULL END)`,
    positiveReplies: sql<number>`SUM(CASE WHEN ${messageOutcomes.replySentiment} = 'positive' THEN 1 ELSE 0 END)`,
    conversions: sql<number>`SUM(CASE WHEN ${messageOutcomes.converted} = 1 THEN 1 ELSE 0 END)`,
    stageAdvances: sql<number>`SUM(CASE WHEN ${messageOutcomes.stageAdvanced} = 1 THEN 1 ELSE 0 END)`,
    dncCount: sql<number>`SUM(CASE WHEN ${messageOutcomes.dncTriggered} = 1 THEN 1 ELSE 0 END)`,
  }).from(messageOutcomes)
    .where(sql`${messageOutcomes.framework} IS NOT NULL`)
    .groupBy(messageOutcomes.framework);

  const frameworkStats: FrameworkStats[] = fwRaw.map(r => ({
    framework: r.framework || "unknown",
    totalSent: r.totalSent,
    replies: r.replies,
    replyRate: r.totalSent > 0 ? Math.round((r.replies / r.totalSent) * 100) : 0,
    avgReplyMinutes: Math.round(r.avgReplyMin || 0),
    positiveReplies: r.positiveReplies,
    positiveRate: r.replies > 0 ? Math.round((r.positiveReplies / r.replies) * 100) : 0,
    conversions: r.conversions,
    conversionRate: r.totalSent > 0 ? Math.round((r.conversions / r.totalSent) * 100) : 0,
    stageAdvances: r.stageAdvances,
    dncCount: r.dncCount,
    dncRate: r.totalSent > 0 ? Math.round((r.dncCount / r.totalSent) * 100) : 0,
  }));

  // --- Channel stats ---
  const chRaw = await db.select({
    channel: messageOutcomes.channel,
    totalSent: sql<number>`COUNT(*)`,
    replies: sql<number>`SUM(CASE WHEN ${messageOutcomes.gotReply} = 1 THEN 1 ELSE 0 END)`,
    avgReplyMin: sql<number>`AVG(CASE WHEN ${messageOutcomes.gotReply} = 1 THEN ${messageOutcomes.replyMinutes} ELSE NULL END)`,
    conversions: sql<number>`SUM(CASE WHEN ${messageOutcomes.converted} = 1 THEN 1 ELSE 0 END)`,
  }).from(messageOutcomes)
    .where(sql`${messageOutcomes.channel} IS NOT NULL`)
    .groupBy(messageOutcomes.channel);

  const channelStats: ChannelStats[] = chRaw.map(r => ({
    channel: r.channel || "unknown",
    totalSent: r.totalSent,
    replies: r.replies,
    replyRate: r.totalSent > 0 ? Math.round((r.replies / r.totalSent) * 100) : 0,
    avgReplyMinutes: Math.round(r.avgReplyMin || 0),
    conversions: r.conversions,
  }));

  // --- Segment × Framework cross-tab (top performers) ---
  const segFwRaw = await db.select({
    segment: messageOutcomes.segment,
    framework: messageOutcomes.framework,
    totalSent: sql<number>`COUNT(*)`,
    replies: sql<number>`SUM(CASE WHEN ${messageOutcomes.gotReply} = 1 THEN 1 ELSE 0 END)`,
  }).from(messageOutcomes)
    .where(and(
      sql`${messageOutcomes.segment} IS NOT NULL`,
      sql`${messageOutcomes.framework} IS NOT NULL`,
    ))
    .groupBy(messageOutcomes.segment, messageOutcomes.framework);

  // Build segment stats (best framework per segment)
  const segMap = new Map<string, { total: number; replies: number; best: string; bestRate: number; bestSize: number }>();
  for (const r of segFwRaw) {
    const seg = r.segment || "other";
    if (!segMap.has(seg)) segMap.set(seg, { total: 0, replies: 0, best: "", bestRate: 0, bestSize: 0 });
    const s = segMap.get(seg)!;
    s.total += r.totalSent;
    s.replies += r.replies;
    const rate = r.totalSent >= 3 ? (r.replies / r.totalSent) * 100 : 0; // min 3 samples
    if (rate > s.bestRate) { s.best = r.framework || ""; s.bestRate = rate; s.bestSize = r.totalSent; }
  }

  const segmentStats: SegmentStats[] = Array.from(segMap.entries()).map(([seg, s]) => ({
    segment: seg,
    bestFramework: s.best,
    bestReplyRate: Math.round(s.bestRate),
    totalMessages: s.total,
    totalReplies: s.replies,
    overallReplyRate: s.total > 0 ? Math.round((s.replies / s.total) * 100) : 0,
  }));

  // Top performers (segment × framework combos with highest reply rates, min 3 samples)
  const topPerformers = segFwRaw
    .filter(r => r.totalSent >= 3)
    .map(r => ({
      framework: r.framework || "unknown",
      segment: r.segment || "other",
      replyRate: Math.round((r.replies / r.totalSent) * 100),
      sampleSize: r.totalSent,
    }))
    .sort((a, b) => b.replyRate - a.replyRate)
    .slice(0, 10);

  // --- Overall stats ---
  const [overall] = await db.select({
    total: sql<number>`COUNT(*)`,
    replies: sql<number>`SUM(CASE WHEN ${messageOutcomes.gotReply} = 1 THEN 1 ELSE 0 END)`,
    conversions: sql<number>`SUM(CASE WHEN ${messageOutcomes.converted} = 1 THEN 1 ELSE 0 END)`,
  }).from(messageOutcomes);

  return {
    frameworkStats: frameworkStats.sort((a, b) => b.replyRate - a.replyRate),
    segmentStats: segmentStats.sort((a, b) => b.overallReplyRate - a.overallReplyRate),
    channelStats: channelStats.sort((a, b) => b.replyRate - a.replyRate),
    topPerformers,
    overallReplyRate: overall.total > 0 ? Math.round((overall.replies / overall.total) * 100) : 0,
    overallConversionRate: overall.total > 0 ? Math.round((overall.conversions / overall.total) * 100) : 0,
    totalTracked: overall.total,
    lastUpdated: new Date(),
  };
}

// =================================================================
// 3. LEARNING CONTEXT — Generate a summary for the Strategist brain
// =================================================================

/**
 * Builds a concise text block the Strategist brain can use to make data-driven decisions.
 * Only includes patterns with enough sample size (>=3) to be statistically meaningful.
 */
export async function buildLearningContext(segment?: string): Promise<string> {
  const cacheKey = `learning:${segment || 'all'}`;
  return cached(patternCache, cacheKey, () => _buildLearningContextUncached(segment));
}

async function _buildLearningContextUncached(segment?: string): Promise<string> {
  const insights = await getPatternAnalysis();

  if (insights.totalTracked < 5) {
    return "LEARNING DATA: Insufficient data — fewer than 5 tracked outcomes. Use default frameworks.";
  }

  const lines: string[] = [
    `LEARNING DATA (${insights.totalTracked} tracked messages, ${insights.overallReplyRate}% overall reply rate, ${insights.overallConversionRate}% conversion rate):`,
  ];

  // Framework rankings
  const ranked = insights.frameworkStats.filter(f => f.totalSent >= 3);
  if (ranked.length > 0) {
    lines.push("");
    lines.push("FRAMEWORK PERFORMANCE (min 3 messages):");
    for (const f of ranked) {
      const dncWarning = f.dncRate > 5 ? ` ⚠️ ${f.dncRate}% DNC rate` : '';
      lines.push(`  ${f.framework}: ${f.replyRate}% reply rate (${f.replies}/${f.totalSent}), ${f.positiveRate}% positive, ${f.conversionRate}% conversion, avg reply ${f.avgReplyMinutes}min${dncWarning}`);
    }
  }

  // Channel performance
  const chRanked = insights.channelStats.filter(c => c.totalSent >= 3);
  if (chRanked.length > 0) {
    lines.push("");
    lines.push("CHANNEL PERFORMANCE:");
    for (const c of chRanked) {
      lines.push(`  ${c.channel}: ${c.replyRate}% reply rate (${c.replies}/${c.totalSent}), avg reply ${c.avgReplyMinutes}min`);
    }
  }

  // Segment-specific recommendations
  if (segment) {
    const segData = insights.segmentStats.find(s => s.segment === segment);
    if (segData && segData.bestFramework) {
      lines.push("");
      lines.push(`SEGMENT-SPECIFIC (${segment}): Best framework = ${segData.bestFramework} (${segData.bestReplyRate}% reply rate). Overall: ${segData.overallReplyRate}% reply rate from ${segData.totalMessages} messages.`);
    }
  }

  // DNC warnings — frameworks with high opt-out rates
  const dncRisky = insights.frameworkStats.filter(f => f.dncCount > 0 && f.totalSent >= 3).sort((a, b) => b.dncRate - a.dncRate);
  if (dncRisky.length > 0) {
    lines.push("");
    lines.push("DNC/OPT-OUT RISK (frameworks that triggered unsubscribe replies):");
    for (const f of dncRisky.slice(0, 5)) {
      lines.push(`  ${f.framework}: ${f.dncCount} DNC replies out of ${f.totalSent} messages (${f.dncRate}%) — REDUCE USAGE if >5%`);
    }
  }

  // Top combos
  if (insights.topPerformers.length > 0) {
    lines.push("");
    lines.push("TOP PERFORMING COMBOS:");
    for (const tp of insights.topPerformers.slice(0, 5)) {
      lines.push(`  ${tp.framework} × ${tp.segment}: ${tp.replyRate}% reply rate (n=${tp.sampleSize})`);
    }
  }

  // Phase 4: A/B experiment winners — auto-adopted strategies
  try {
    const db = await getDb();
    if (db) {
      const completedExperiments = await db.select()
        .from(abExperiments)
        .where(and(
          eq(abExperiments.status, "completed"),
          sql`${abExperiments.winnerVariant} IS NOT NULL`,
        ))
        .orderBy(desc(abExperiments.endedAt))
        .limit(5);

      if (completedExperiments.length > 0) {
        lines.push("");
        lines.push("A/B TEST WINNERS (proven strategies — ADOPT these):");
        for (const exp of completedExperiments) {
          const winnerConfig = exp.winnerVariant === "A"
            ? (exp.variantAConfig as Record<string, string>)
            : (exp.variantBConfig as Record<string, string>);
          const winnerDesc = exp.winnerVariant === "A" ? exp.variantADescription : exp.variantBDescription;
          const aRate = (exp.variantASamples as number) > 0 ? Math.round(((exp.variantASuccesses as number) / (exp.variantASamples as number)) * 100) : 0;
          const bRate = (exp.variantBSamples as number) > 0 ? Math.round(((exp.variantBSuccesses as number) / (exp.variantBSamples as number)) * 100) : 0;
          lines.push(`  ✅ ${exp.name}: Winner = Variant ${exp.winnerVariant} (${winnerDesc}). A: ${aRate}% vs B: ${bRate}%. Config: ${JSON.stringify(winnerConfig)}`);
          if (exp.targetSegment) lines.push(`     Applies to segment: ${exp.targetSegment}`);
        }
      }
    }
  } catch (err) {
    // Non-fatal — experiment data is supplementary
  }

  return lines.join("\n");
}

// =================================================================
// 4. BACKFILL — Create outcome records for existing audit entries
// =================================================================

/**
 * Scan recent audit entries that don't have outcome records yet,
 * and check if a reply came in within the attribution window.
 * Run periodically (e.g., every 30 minutes) to catch missed attributions.
 */
export async function backfillOutcomes(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  // Find audit entries from last 72h that have no outcome record
  const windowStart = new Date(Date.now() - ATTRIBUTION_WINDOW_HOURS * 60 * 60 * 1000);

  const untracked = await db.select({
    auditId: brainCouncilAudit.id,
    leadId: brainCouncilAudit.leadId,
    framework: brainCouncilAudit.strategyFramework,
    approach: brainCouncilAudit.strategyApproach,
    channel: brainCouncilAudit.channel,
    agentName: brainCouncilAudit.composerFromName,
    tier: brainCouncilAudit.strategyTier,
    sentAt: brainCouncilAudit.createdAt,
    experimentId: brainCouncilAudit.experimentId,
    variant: brainCouncilAudit.variant,
    persona: brainCouncilAudit.persona,
    emailSubject: brainCouncilAudit.emailSubject,
  })
    .from(brainCouncilAudit)
    .leftJoin(messageOutcomes, eq(brainCouncilAudit.id, messageOutcomes.auditId))
    .where(and(
      eq(brainCouncilAudit.messageSent, 1),
      gte(brainCouncilAudit.createdAt, windowStart),
      isNull(messageOutcomes.id),
    ))
    .limit(50);

  let created = 0;
  for (const entry of untracked) {
    // Check if lead replied after this message
    const sentAt = new Date(entry.sentAt);
    const replyWindow = new Date(sentAt.getTime() + ATTRIBUTION_WINDOW_HOURS * 60 * 60 * 1000);

    const replies = await db.select({
      id: conversations.id,
      timestamp: conversations.timestamp,
      messageBody: conversations.messageBody,
    })
      .from(conversations)
      .where(and(
        eq(conversations.leadId, entry.leadId),
        eq(conversations.direction, "inbound"),
        gte(conversations.timestamp, sentAt),
        sql`${conversations.timestamp} <= ${replyWindow}`,
      ))
      .orderBy(conversations.timestamp)
      .limit(1);

    const gotReply = replies.length > 0;
    const replyMinutes = gotReply
      ? Math.round((new Date(replies[0].timestamp).getTime() - sentAt.getTime()) / (1000 * 60))
      : undefined;
    const sentiment = gotReply ? classifySentimentFast(replies[0].messageBody || "") : undefined;
    const dncTriggered = gotReply ? isDncReply(replies[0].messageBody || "") : false;

    // Check if pipeline advanced after this message
    const stageEvents = await db.select()
      .from(pipelineEvents)
      .where(and(
        eq(pipelineEvents.leadId, entry.leadId),
        gte(pipelineEvents.timestamp, sentAt),
      ))
      .orderBy(pipelineEvents.timestamp)
      .limit(1);

    const stageAdvanced = stageEvents.length > 0;
    const toStage = stageAdvanced ? stageEvents[0].toStage : undefined;
    const converted = toStage ? CONVERSION_STAGES.includes(toStage) : false;

    // Get lead segment
    const [lead] = await db.select({ segment: leads.omnisendSegment })
      .from(leads).where(eq(leads.id, entry.leadId)).limit(1);

    await db.insert(messageOutcomes).values({
      auditId: entry.auditId,
      leadId: entry.leadId,
      framework: entry.framework,
      angle: entry.approach,
      approach: entry.approach,
      channel: entry.channel,
      segment: lead?.segment || undefined,
      agentName: entry.agentName,
      personalizationTier: entry.tier ? parseInt(entry.tier) : undefined,
      // Phase 4: Self-Learning metadata from audit
      experimentId: entry.experimentId || undefined,
      variant: entry.variant || undefined,
      persona: entry.persona || undefined,
      // Email subject tracking
      emailSubject: entry.emailSubject || undefined,
      gotReply: gotReply ? 1 : 0,
      replyMinutes,
      replySentiment: sentiment,
      stageAdvanced: stageAdvanced ? 1 : 0,
      toStage,
      converted: converted ? 1 : 0,
      dncTriggered: dncTriggered ? 1 : 0,
      attributedAt: gotReply ? new Date(replies[0].timestamp) : (stageAdvanced ? new Date(stageEvents[0].timestamp) : undefined),
    });

    // --- SEGMENT WEIGHT RECORDING (WIN or LOSS based on reply) ---
    try {
      const approachLabel = entry.approach || entry.framework;
      if (approachLabel && entry.channel) {
        const segment = entry.persona || lead?.segment || "unknown";
        // Get lead's current stage
        const [leadStage] = await db.select({ stage: leads.pipelineStage })
          .from(leads).where(eq(leads.id, entry.leadId)).limit(1);
        const stage = leadStage?.stage || "new_lead";
        const outcome = gotReply ? "win" : "loss";
        await recordSegmentOutcome(segment, entry.channel, stage, approachLabel, outcome);
      }
    } catch (swErr) {
      // Non-fatal — don't break the backfill loop
    }

    created++;
  }

  // --- BACKFILL SINGLE BRAIN: decision_log entries without outcome records ---
  try {
    const untrackedDl = await db.execute(sql.raw(`
      SELECT dl.id as dlId, dl.leadId, dl.channel, dl.trigger as triggerType, dl.createdAt as sentAt
      FROM decision_log dl
      LEFT JOIN message_outcomes mo ON mo.decisionLogId = dl.id
      WHERE (dl.outputGuardResult = 'pass' OR dl.outputGuardResult LIKE 'corrected:%')
        AND dl.brainReasoning IS NOT NULL
        AND dl.createdAt >= '${windowStart.toISOString().slice(0, 19)}'
        AND mo.id IS NULL
      ORDER BY dl.createdAt DESC
      LIMIT 50
    `));

    const dlRows = Array.isArray((untrackedDl as any)[0]) ? (untrackedDl as any)[0] : untrackedDl;
    if (Array.isArray(dlRows)) {
      for (const entry of dlRows) {
        const sentAt = new Date(entry.sentAt);
        const replyWindow = new Date(sentAt.getTime() + ATTRIBUTION_WINDOW_HOURS * 60 * 60 * 1000);

        const replies = await db.select({
          id: conversations.id,
          timestamp: conversations.timestamp,
          messageBody: conversations.messageBody,
        })
          .from(conversations)
          .where(and(
            eq(conversations.leadId, entry.leadId),
            eq(conversations.direction, "inbound"),
            gte(conversations.timestamp, sentAt),
            sql`${conversations.timestamp} <= ${replyWindow}`,
          ))
          .orderBy(conversations.timestamp)
          .limit(1);

        const gotReply = replies.length > 0;
        const replyMin = gotReply
          ? Math.round((new Date(replies[0].timestamp).getTime() - sentAt.getTime()) / (1000 * 60))
          : undefined;
        const sent = gotReply ? classifySentimentFast(replies[0].messageBody || "") : undefined;
        const dnc = gotReply ? isDncReply(replies[0].messageBody || "") : false;

        const stageEvents2 = await db.select()
          .from(pipelineEvents)
          .where(and(
            eq(pipelineEvents.leadId, entry.leadId),
            gte(pipelineEvents.timestamp, sentAt),
          ))
          .orderBy(pipelineEvents.timestamp)
          .limit(1);

        const stageAdv = stageEvents2.length > 0;
        const toSt = stageAdv ? stageEvents2[0].toStage : undefined;
        const conv = toSt ? CONVERSION_STAGES.includes(toSt) : false;

        const [leadInfo] = await db.select({ segment: leads.omnisendSegment })
          .from(leads).where(eq(leads.id, entry.leadId)).limit(1);

        await db.insert(messageOutcomes).values({
          auditId: 0,
          decisionLogId: Number(entry.dlId),
          leadId: entry.leadId,
          channel: entry.channel || undefined,
          segment: leadInfo?.segment || undefined,
          gotReply: gotReply ? 1 : 0,
          replyMinutes: replyMin,
          replySentiment: sent,
          stageAdvanced: stageAdv ? 1 : 0,
          toStage: toSt,
          converted: conv ? 1 : 0,
          dncTriggered: dnc ? 1 : 0,
          attributedAt: gotReply ? new Date(replies[0].timestamp) : (stageAdv ? new Date(stageEvents2[0].timestamp) : undefined),
        });

        // Segment weight recording
        try {
          const approach = entry.triggerType || "single_brain";
          if (entry.channel) {
            const [leadStage2] = await db.select({ stage: leads.pipelineStage })
              .from(leads).where(eq(leads.id, entry.leadId)).limit(1);
            const seg = leadInfo?.segment || "unknown";
            const st = leadStage2?.stage || "new_lead";
            await recordSegmentOutcome(seg, entry.channel, st, approach, gotReply ? "win" : "loss");
          }
        } catch { /* non-fatal */ }

        created++;
      }
    }
  } catch (dlErr) {
    console.error("[Outcome] Decision log backfill error (non-fatal):", dlErr);
  }

  return created;
}

// =================================================================
// HELPERS
// =================================================================

/**
 * Fast sentiment classification without LLM — keyword-based for speed.
 * Used for real-time attribution. Can be upgraded to LLM later.
 */
function classifySentimentFast(message: string): "positive" | "neutral" | "negative" {
  const lower = message.toLowerCase();

  const negativeSignals = [
    "stop", "unsubscribe", "not interested", "remove me", "don't contact",
    "leave me alone", "no thanks", "spam", "wrong number", "do not", "fuck",
    "annoying", "harassing", "reported", "blocked", "terrible", "worst",
  ];

  const positiveSignals = [
    "interested", "yes", "sounds good", "tell me more", "how much",
    "pricing", "quote", "love", "great", "awesome", "perfect", "let's do",
    "sign me up", "ready", "when can", "absolutely", "definitely",
    "need", "want", "looking for", "excited", "amazing", "thank",
  ];

  const negScore = negativeSignals.filter(s => lower.includes(s)).length;
  const posScore = positiveSignals.filter(s => lower.includes(s)).length;

  if (negScore > posScore) return "negative";
  if (posScore > negScore) return "positive";
  return "neutral";
}

/**
 * Check if a reply message contains DNC (Do Not Contact) keywords.
 * Used to track which AI messages triggered opt-out responses.
 */
function isDncReply(message: string): boolean {
  const lower = message.toLowerCase().trim();
  return DNC_KEYWORDS.some(kw => lower === kw || lower.startsWith(kw + " ") || lower.endsWith(" " + kw) || lower.includes(" " + kw + " "));
}

// =================================================================
// 5. ICP WIN/LOSS LEARNING — Conversion rates by lead source and segment
// =================================================================

/**
 * Analyzes which lead sources and segments convert to paid orders at the highest rate.
 * Returns a text block the Strategist can use to prioritize high-value lead profiles.
 *
 * This is the ICP (Ideal Customer Profile) self-learning layer.
 * The system learns from actual paid orders — not just replies — to identify
 * which lead types are worth more effort and faster follow-up.
 */
export async function buildIcpLearningContext(): Promise<string> {
  const cacheKey = 'icp:win_loss';
  return cached(patternCache, cacheKey, _buildIcpLearningContextUncached);
}

async function _buildIcpLearningContextUncached(): Promise<string> {
  const db = await getDb();
  if (!db) return "";

  try {
    // Conversion by lead source (e.g., Facebook, Instagram, Website, Referral)
    const sourceStats = await db.select({
      source: leads.source,
      total: sql<number>`COUNT(*)`,
      conversions: sql<number>`SUM(CASE WHEN ${leads.pipelineStage} IN ('Paid - Proof Needed', 'Approved + Deposit', 'Delivered', 'paid_proof_needed', 'approved', 'delivered') THEN 1 ELSE 0 END)`,
    })
      .from(leads)
      .where(sql`${leads.source} IS NOT NULL`)
      .groupBy(leads.source)
      .having(sql`COUNT(*) >= 3`)
      .orderBy(sql`SUM(CASE WHEN ${leads.pipelineStage} IN ('Paid - Proof Needed', 'Approved + Deposit', 'Delivered', 'paid_proof_needed', 'approved', 'delivered') THEN 1 ELSE 0 END) DESC`);

    // Conversion by seasonal segment (church, corporate, school, etc.)
    const segmentStats = await db.select({
      segment: leads.seasonalSegment,
      total: sql<number>`COUNT(*)`,
      conversions: sql<number>`SUM(CASE WHEN ${leads.pipelineStage} IN ('Paid - Proof Needed', 'Approved + Deposit', 'Delivered', 'paid_proof_needed', 'approved', 'delivered') THEN 1 ELSE 0 END)`,
    })
      .from(leads)
      .where(sql`${leads.seasonalSegment} IS NOT NULL`)
      .groupBy(leads.seasonalSegment)
      .having(sql`COUNT(*) >= 3`)
      .orderBy(sql`SUM(CASE WHEN ${leads.pipelineStage} IN ('Paid - Proof Needed', 'Approved + Deposit', 'Delivered', 'paid_proof_needed', 'approved', 'delivered') THEN 1 ELSE 0 END) DESC`);

    const lines: string[] = [];

    const sourceRows = sourceStats.filter(r => r.total >= 3);
    if (sourceRows.length > 0) {
      lines.push("ICP WIN/LOSS BY LEAD SOURCE:");
      for (const r of sourceRows.slice(0, 8)) {
        const rate = r.total > 0 ? Math.round((r.conversions / r.total) * 100) : 0;
        const tier = rate >= 20 ? "🟢 HIGH" : rate >= 10 ? "🟡 MED" : "🔴 LOW";
        lines.push(`  ${r.source}: ${rate}% conversion (${r.conversions}/${r.total}) ${tier}`);
      }
    }

    const segRows = segmentStats.filter(r => r.total >= 3);
    if (segRows.length > 0) {
      lines.push("");
      lines.push("ICP WIN/LOSS BY SEGMENT:");
      for (const r of segRows.slice(0, 8)) {
        const rate = r.total > 0 ? Math.round((r.conversions / r.total) * 100) : 0;
        const tier = rate >= 20 ? "🟢 HIGH" : rate >= 10 ? "🟡 MED" : "🔴 LOW";
        lines.push(`  ${r.segment}: ${rate}% conversion (${r.conversions}/${r.total}) ${tier}`);
      }
    }

    if (lines.length === 0) {
      return "ICP DATA: Insufficient conversion data — fewer than 3 samples per source/segment. Use default prioritization.";
    }

    lines.unshift("=== ICP PROFILE (who actually buys) ===");
    lines.push("");
    lines.push("STRATEGIST INSTRUCTION: Leads from 🟢 HIGH sources/segments deserve faster follow-up and more personalized outreach. Leads from 🔴 LOW sources are lower priority — use lighter-touch cadence.");

    return lines.join("\n");
  } catch (err) {
    console.error("[ICP] Error building ICP learning context:", err);
    return "";
  }
}

// =================================================================
// MODULE 2A: ICP CADENCE MULTIPLIER
// =================================================================

/**
 * Returns the ICP tier for a lead based on its source and/or segment conversion rate.
 * Used by the scheduling engine to apply cadence multipliers.
 *
 * Multipliers applied in calculateNextFollowUp (P3 + P4 paths):
 *   high   → ×0.7 (30% faster follow-up)
 *   medium → ×1.0 (no change)
 *   low    → ×1.3 (30% slower follow-up)
 *   unknown → ×1.0 (no change — insufficient data)
 */
export async function getIcpTier(
  source: string | null | undefined,
  segment: string | null | undefined,
): Promise<"high" | "medium" | "low" | "unknown"> {
  const db = await getDb();
  if (!db) return "unknown";

  const conversionSql = sql<number>`SUM(CASE WHEN ${leads.pipelineStage} IN ('Paid - Proof Needed', 'Approved + Deposit', 'Delivered', 'paid_proof_needed', 'approved', 'delivered') THEN 1 ELSE 0 END)`;

  try {
    // Check source tier first (more specific signal)
    if (source) {
      const sourceRows = await db.select({
        total: sql<number>`COUNT(*)`,
        conversions: conversionSql,
      })
        .from(leads)
        .where(sql`${leads.source} = ${source}`);
      const row = sourceRows[0];
      if (row && row.total >= 3) {
        const rate = Math.round((row.conversions / row.total) * 100);
        if (rate >= 20) return "high";
        if (rate >= 10) return "medium";
        return "low";
      }
    }

    // Fall back to segment tier
    if (segment) {
      const segRows = await db.select({
        total: sql<number>`COUNT(*)`,
        conversions: conversionSql,
      })
        .from(leads)
        .where(sql`${leads.seasonalSegment} = ${segment}`);
      const row = segRows[0];
      if (row && row.total >= 3) {
        const rate = Math.round((row.conversions / row.total) * 100);
        if (rate >= 20) return "high";
        if (rate >= 10) return "medium";
        return "low";
      }
    }

    return "unknown";
  } catch (err) {
    console.error("[ICP] getIcpTier error:", err);
    return "unknown";
  }
}

export interface IcpSourceStat {
  source: string;
  total: number;
  conversions: number;
  conversionRate: number;
  tier: "high" | "medium" | "low";
  multiplier: number;
}

export interface IcpSegmentStat {
  segment: string;
  total: number;
  conversions: number;
  conversionRate: number;
  tier: "high" | "medium" | "low";
  multiplier: number;
}

export interface IcpStats {
  sourceStats: IcpSourceStat[];
  segmentStats: IcpSegmentStat[];
  lastUpdated: Date;
}

/**
 * Returns structured ICP stats for the dashboard (Self-Learning page ICP tab).
 */
export async function getIcpStats(): Promise<IcpStats> {
  const db = await getDb();
  if (!db) return { sourceStats: [], segmentStats: [], lastUpdated: new Date() };

  const conversionSql = sql<number>`SUM(CASE WHEN ${leads.pipelineStage} IN ('Paid - Proof Needed', 'Approved + Deposit', 'Delivered', 'paid_proof_needed', 'approved', 'delivered') THEN 1 ELSE 0 END)`;

  try {
    const [rawSources, rawSegments] = await Promise.all([
      db.select({
        source: leads.source,
        total: sql<number>`COUNT(*)`,
        conversions: conversionSql,
      })
        .from(leads)
        .where(sql`${leads.source} IS NOT NULL`)
        .groupBy(leads.source)
        .having(sql`COUNT(*) >= 3`)
        .orderBy(sql`${conversionSql} DESC`),

      db.select({
        segment: leads.seasonalSegment,
        total: sql<number>`COUNT(*)`,
        conversions: conversionSql,
      })
        .from(leads)
        .where(sql`${leads.seasonalSegment} IS NOT NULL`)
        .groupBy(leads.seasonalSegment)
        .having(sql`COUNT(*) >= 3`)
        .orderBy(sql`${conversionSql} DESC`),
    ]);

    const toTier = (rate: number): "high" | "medium" | "low" =>
      rate >= 20 ? "high" : rate >= 10 ? "medium" : "low";
    const toMultiplier = (tier: "high" | "medium" | "low") =>
      tier === "high" ? 0.7 : tier === "low" ? 1.3 : 1.0;

    const sourceStats: IcpSourceStat[] = rawSources.map(r => {
      const rate = r.total > 0 ? Math.round((r.conversions / r.total) * 100) : 0;
      const tier = toTier(rate);
      return { source: r.source!, total: r.total, conversions: r.conversions, conversionRate: rate, tier, multiplier: toMultiplier(tier) };
    });

    const segmentStats: IcpSegmentStat[] = rawSegments.map(r => {
      const rate = r.total > 0 ? Math.round((r.conversions / r.total) * 100) : 0;
      const tier = toTier(rate);
      return { segment: r.segment!, total: r.total, conversions: r.conversions, conversionRate: rate, tier, multiplier: toMultiplier(tier) };
    });

    return { sourceStats, segmentStats, lastUpdated: new Date() };
  } catch (err) {
    console.error("[ICP] getIcpStats error:", err);
    return { sourceStats: [], segmentStats: [], lastUpdated: new Date() };
  }
}
