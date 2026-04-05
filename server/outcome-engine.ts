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
import { getDb } from "./db";
import { brainCouncilAudit, messageOutcomes, leads, conversations, pipelineEvents } from "../drizzle/schema";
import { invokeLLM } from "./_core/llm";

// --- CONSTANTS ---
const ATTRIBUTION_WINDOW_HOURS = 72;
const CONVERSION_STAGES = ["Paid - Proof Needed", "Approved + Deposit", "Delivered"];
const POSITIVE_STAGES = ["Qualified", "Quote Sent", "Paid - Proof Needed", "Proof Sent", "Approved + Deposit", "In Production", "Ready", "Delivered"];

// =================================================================
// 1. ATTRIBUTION — Link inbound replies to the AI message that caused them
// =================================================================

/**
 * Called when an inbound message arrives. Finds the most recent AI audit entry
 * for this lead within the attribution window and records the outcome.
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

  // Find the most recent AI audit entry for this lead within the attribution window
  const recentAudits = await db.select()
    .from(brainCouncilAudit)
    .where(and(
      eq(brainCouncilAudit.leadId, opts.leadId),
      eq(brainCouncilAudit.messageSent, 1),
      gte(brainCouncilAudit.createdAt, windowStart),
    ))
    .orderBy(desc(brainCouncilAudit.createdAt))
    .limit(1);

  if (recentAudits.length === 0) return null;

  const audit = recentAudits[0];
  const sentAt = new Date(audit.createdAt).getTime();
  const replyMinutes = Math.round((opts.replyTimestamp.getTime() - sentAt) / (1000 * 60));

  // Quick sentiment classification (lightweight — no LLM call for speed)
  const sentiment = classifySentimentFast(opts.replyMessage);

  // Check if we already have an outcome for this audit entry
  const existing = await db.select()
    .from(messageOutcomes)
    .where(eq(messageOutcomes.auditId, audit.id))
    .limit(1);

  if (existing.length > 0) {
    // Update existing outcome with reply data if it didn't have one
    if (!existing[0].gotReply) {
      await db.update(messageOutcomes)
        .set({ gotReply: 1, replyMinutes, replySentiment: sentiment, attributedAt: opts.replyTimestamp })
        .where(eq(messageOutcomes.id, existing[0].id));
    }
    return { auditId: audit.id, replyMinutes, sentiment };
  }

  // Create new outcome record
  await db.insert(messageOutcomes).values({
    auditId: audit.id,
    leadId: opts.leadId,
    framework: audit.strategyFramework,
    angle: audit.strategyApproach, // approach is the angle category
    approach: audit.strategyApproach,
    channel: audit.channel,
    segment: undefined, // will be enriched by pattern analysis
    agentName: audit.composerFromName,
    personalizationTier: audit.strategyTier ? parseInt(audit.strategyTier) : undefined,
    gotReply: 1,
    replyMinutes,
    replySentiment: sentiment,
    attributedAt: opts.replyTimestamp,
  });

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

  const recentAudits = await db.select()
    .from(brainCouncilAudit)
    .where(and(
      eq(brainCouncilAudit.leadId, opts.leadId),
      eq(brainCouncilAudit.messageSent, 1),
      gte(brainCouncilAudit.createdAt, windowStart),
    ))
    .orderBy(desc(brainCouncilAudit.createdAt))
    .limit(1);

  if (recentAudits.length === 0) return;

  const audit = recentAudits[0];
  const isConversion = CONVERSION_STAGES.includes(opts.toStage);
  const scoreChange = (opts.newScore !== undefined && opts.previousScore !== undefined)
    ? opts.newScore - opts.previousScore : undefined;

  const existing = await db.select()
    .from(messageOutcomes)
    .where(eq(messageOutcomes.auditId, audit.id))
    .limit(1);

  if (existing.length > 0) {
    await db.update(messageOutcomes)
      .set({
        stageAdvanced: 1,
        toStage: opts.toStage,
        converted: isConversion ? 1 : 0,
        scoreChange,
        attributedAt: new Date(),
      })
      .where(eq(messageOutcomes.id, existing[0].id));
  } else {
    await db.insert(messageOutcomes).values({
      auditId: audit.id,
      leadId: opts.leadId,
      framework: audit.strategyFramework,
      angle: audit.strategyApproach,
      approach: audit.strategyApproach,
      channel: audit.channel,
      agentName: audit.composerFromName,
      personalizationTier: audit.strategyTier ? parseInt(audit.strategyTier) : undefined,
      stageAdvanced: 1,
      toStage: opts.toStage,
      converted: isConversion ? 1 : 0,
      scoreChange,
      attributedAt: new Date(),
    });
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
      lines.push(`  ${f.framework}: ${f.replyRate}% reply rate (${f.replies}/${f.totalSent}), ${f.positiveRate}% positive, ${f.conversionRate}% conversion, avg reply ${f.avgReplyMinutes}min`);
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

  // Top combos
  if (insights.topPerformers.length > 0) {
    lines.push("");
    lines.push("TOP PERFORMING COMBOS:");
    for (const tp of insights.topPerformers.slice(0, 5)) {
      lines.push(`  ${tp.framework} × ${tp.segment}: ${tp.replyRate}% reply rate (n=${tp.sampleSize})`);
    }
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
      gotReply: gotReply ? 1 : 0,
      replyMinutes,
      replySentiment: sentiment,
      stageAdvanced: stageAdvanced ? 1 : 0,
      toStage,
      converted: converted ? 1 : 0,
      attributedAt: gotReply ? new Date(replies[0].timestamp) : (stageAdvanced ? new Date(stageEvents[0].timestamp) : undefined),
    });
    created++;
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
