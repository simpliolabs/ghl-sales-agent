/**
 * LEARNING LOOP — Self-improving agent patterns for Adorb Outreach
 * 
 * Implements the self-improving-agent pattern from ClawHub:
 * - Records conversation-level outcomes (full journey per lead)
 * - Identifies recurring patterns from outcomes
 * - Auto-promotes successful patterns to Strategist prompt when recurrence > threshold
 * - Tracks negative patterns as "avoid" rules
 * 
 * Entry format follows [LRN-YYYYMMDD-XXX] convention:
 * - Pattern-Key: stable identifier (e.g., close.thank_you_confirmation)
 * - Category: best_practice | avoid | correction | knowledge_gap
 * - Recurrence-Count: incremented each time pattern occurs
 * - Promotion: when recurrence > PROMOTION_THRESHOLD with positive outcomes → promoted
 */

import { eq, desc, sql, and, gte } from "drizzle-orm";
import { getDb } from "./db";
import { getPlaybookSummaryForLearning } from "./stage-playbook";
import {
  conversationOutcomes,
  learnings,
  leads,
  conversations,
  brainCouncilAudit,
  type InsertConversationOutcome,
  type InsertLearning,
} from "../drizzle/schema";

// --- CONSTANTS ---
const PROMOTION_THRESHOLD = 3; // Promote pattern after 3+ positive recurrences
const DEMOTION_THRESHOLD = 3;  // Mark as "avoid" after 3+ negative recurrences
const MIN_SAMPLE_SIZE = 3;     // Minimum outcomes before pattern is actionable
const MAX_PROMOTED_RULES = 15; // Cap on promoted rules in Strategist prompt
const PATTERN_SCAN_WINDOW_DAYS = 90; // Look back 90 days for pattern analysis

// --- TYPES ---
export interface ConversationJourney {
  leadId: number;
  ghlContactId: string;
  stateSequence: string[];    // e.g., ["new_lead", "exploring", "interested", "committed"]
  approachesUsed: string[];   // e.g., ["introduce_brand", "share_pricing", "confirm_details"]
  frameworksUsed: string[];   // e.g., ["HORMOZI_VALUE", "DIRECT_RESPONSE"]
  outcome: "won" | "lost" | "stale" | "dnc";
  outcomeReason?: string;     // e.g., "price_too_high", "no_reply_14d"
  messageCount: number;
  daysToOutcome: number;
  channel: string;
  finalConvState?: string;
  finalStage?: string;       // Pipeline stage at time of outcome (e.g., "Delivered", "Not Qualified")
  pipelineValue?: number;
}

export interface PatternInsight {
  patternKey: string;
  category: "best_practice" | "avoid" | "correction" | "knowledge_gap";
  description: string;
  details: string;
  suggestedAction: string;
  recurrenceCount: number;
  positiveOutcomes: number;
  negativeOutcomes: number;
  priority: "low" | "medium" | "high" | "critical";
  shouldPromote: boolean;
}

// =================================================================
// 1. RECORD — Capture conversation outcome when lead reaches terminal state
// =================================================================

/**
 * Called when a lead reaches a terminal state (won/lost/stale/dnc).
 * Records the full conversation journey for pattern analysis.
 */
export async function recordConversationOutcome(journey: ConversationJourney): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const now = Date.now();
    const record: InsertConversationOutcome = {
      leadId: journey.leadId,
      ghlContactId: journey.ghlContactId,
      stateSequence: journey.stateSequence,
      approachesUsed: journey.approachesUsed,
      frameworksUsed: journey.frameworksUsed,
      outcome: journey.outcome,
      outcomeReason: journey.outcomeReason,
      messageCount: journey.messageCount,
      daysToOutcome: journey.daysToOutcome,
      channel: journey.channel,
      finalConvState: journey.finalConvState,
      pipelineValue: journey.pipelineValue || 0,
      createdAt: now,
    };

    const [result] = await db.insert(conversationOutcomes).values(record);
    console.log(`[LearningLoop] Recorded outcome: lead=${journey.leadId} outcome=${journey.outcome} reason=${journey.outcomeReason || "none"} states=${journey.stateSequence.length} msgs=${journey.messageCount}`);

    // After recording, check if this creates/updates any patterns
    await updatePatternsFromOutcome(journey);

    return (result as any).insertId || null;
  } catch (err) {
    console.error("[LearningLoop] Error recording outcome:", err);
    return null;
  }
}

/**
 * Build a ConversationJourney from a lead's data.
 * Called by the disposition engine and pipeline handlers when a lead reaches terminal state.
 */
export async function buildJourneyFromLead(leadId: number, outcome: "won" | "lost" | "stale" | "dnc", outcomeReason?: string): Promise<ConversationJourney | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    // Get lead data
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) return null;

    // Get conversation history to build state sequence
    const convos = await db.select({
      direction: conversations.direction,
      channel: conversations.channel,
      timestamp: conversations.timestamp,
    })
      .from(conversations)
      .where(eq(conversations.leadId, leadId))
      .orderBy(conversations.timestamp);

    // Get audit entries to build approach/framework history
    const audits = await db.select({
      approach: brainCouncilAudit.strategyApproach,
      framework: brainCouncilAudit.strategyFramework,
      createdAt: brainCouncilAudit.createdAt,
    })
      .from(brainCouncilAudit)
      .where(and(
        eq(brainCouncilAudit.leadId, leadId),
        eq(brainCouncilAudit.messageSent, 1),
      ))
      .orderBy(brainCouncilAudit.createdAt);

    // Build state sequence from conv_state changes (or infer from pipeline)
    const stateSequence: string[] = [];
    const convState = (lead as any).convState;
    if (convState) stateSequence.push(convState);
    // If we have intent history, extract state transitions
    const intentHistory = (lead as any).intentHistory;
    if (Array.isArray(intentHistory)) {
      for (const ih of intentHistory) {
        if (ih.intent && !stateSequence.includes(ih.intent)) {
          stateSequence.push(ih.intent);
        }
      }
    }
    // Fallback: use pipeline stage as proxy
    if (stateSequence.length === 0) {
      stateSequence.push(lead.pipelineStage || "new_lead");
    }

    // Build approach/framework lists from audits
    const approachesUsed = Array.from(new Set(audits.map(a => a.approach).filter(Boolean))) as string[];
    const frameworksUsed = Array.from(new Set(audits.map(a => a.framework).filter(Boolean))) as string[];

    // Calculate days to outcome
    const firstMsg = convos[0]?.timestamp;
    const daysToOutcome = firstMsg
      ? Math.max(1, Math.round((Date.now() - new Date(firstMsg).getTime()) / (1000 * 60 * 60 * 24)))
      : 0;

    // Determine primary channel
    const channelCounts = new Map<string, number>();
    for (const c of convos) {
      const ch = c.channel || "unknown";
      channelCounts.set(ch, (channelCounts.get(ch) || 0) + 1);
    }
    const primaryChannel = Array.from(channelCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";

    return {
      leadId,
      ghlContactId: lead.ghlContactId || "",
      stateSequence,
      approachesUsed,
      frameworksUsed,
      outcome,
      outcomeReason,
      messageCount: convos.length,
      daysToOutcome,
      channel: primaryChannel,
      finalConvState: convState || lead.pipelineStage || undefined,
      finalStage: lead.pipelineStage || undefined,
      pipelineValue: lead.pipelineValue || 0,
    };
  } catch (err) {
    console.error("[LearningLoop] Error building journey:", err);
    return null;
  }
}

// =================================================================
// 2. PATTERN DETECTION — Identify recurring patterns from outcomes
// =================================================================

/**
 * After recording an outcome, check if it creates or updates any patterns.
 * Pattern keys are generated from the journey's key characteristics.
 */
async function updatePatternsFromOutcome(journey: ConversationJourney): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const now = Date.now();
  const isPositive = journey.outcome === "won";
  const isNegative = journey.outcome === "lost" || journey.outcome === "dnc";

  // Generate pattern keys from this journey
  const patterns = generatePatternKeys(journey);

  for (const pattern of patterns) {
    try {
      // Check if pattern already exists
      const [existing] = await db.select()
        .from(learnings)
        .where(eq(learnings.patternKey, pattern.key))
        .limit(1);

      if (existing) {
        // Update existing pattern
        const updates: Record<string, any> = {
          recurrenceCount: sql`${learnings.recurrenceCount} + 1`,
          updatedAt: now,
        };
        if (isPositive) updates.positiveOutcomes = sql`${learnings.positiveOutcomes} + 1`;
        if (isNegative) updates.negativeOutcomes = sql`${learnings.negativeOutcomes} + 1`;

        // Update priority based on recurrence
        const newRecurrence = (existing.recurrenceCount || 0) + 1;
        if (newRecurrence >= 10) updates.priority = "critical";
        else if (newRecurrence >= 5) updates.priority = "high";
        else if (newRecurrence >= 3) updates.priority = "medium";

        await db.update(learnings)
          .set(updates)
          .where(eq(learnings.id, existing.id));

        console.log(`[LearningLoop] Pattern updated: ${pattern.key} (recurrence=${newRecurrence})`);
      } else {
        // Create new pattern
        const record: InsertLearning = {
          patternKey: pattern.key,
          category: pattern.category,
          description: pattern.description,
          details: pattern.details,
          suggestedAction: pattern.suggestedAction,
          recurrenceCount: 1,
          positiveOutcomes: isPositive ? 1 : 0,
          negativeOutcomes: isNegative ? 1 : 0,
          priority: "low",
          source: "auto",
          createdAt: now,
          updatedAt: now,
        };

        await db.insert(learnings).values(record);
        console.log(`[LearningLoop] New pattern: ${pattern.key} (${pattern.category})`);
      }
    } catch (err) {
      // Ignore duplicate key errors (race condition safe)
      if (!(err as any)?.message?.includes("Duplicate")) {
        console.error(`[LearningLoop] Pattern error for ${pattern.key}:`, err);
      }
    }
  }
}

/**
 * Generate pattern keys from a conversation journey.
 * Each key represents a learnable pattern.
 */
function generatePatternKeys(journey: ConversationJourney): Array<{
  key: string;
  category: "best_practice" | "avoid" | "correction" | "knowledge_gap";
  description: string;
  details: string;
  suggestedAction: string;
}> {
  const patterns: Array<{
    key: string;
    category: "best_practice" | "avoid" | "correction" | "knowledge_gap";
    description: string;
    details: string;
    suggestedAction: string;
  }> = [];

  const isPositive = journey.outcome === "won";
  const isNegative = journey.outcome === "lost" || journey.outcome === "dnc";

  // Pattern 1: Framework × Outcome
  for (const fw of journey.frameworksUsed) {
    const key = `framework.${fw.toLowerCase().replace(/\s+/g, "_")}.${journey.outcome}`;
    patterns.push({
      key,
      category: isPositive ? "best_practice" : isNegative ? "avoid" : "correction",
      description: `Framework ${fw} led to ${journey.outcome} outcome`,
      details: `Channel: ${journey.channel}, Messages: ${journey.messageCount}, Days: ${journey.daysToOutcome}, Value: $${journey.pipelineValue}`,
      suggestedAction: isPositive
        ? `Continue using ${fw} for similar leads`
        : `Consider alternative frameworks instead of ${fw} for this lead type`,
    });
  }

  // Pattern 2: Approach sequence → Outcome
  if (journey.approachesUsed.length > 0) {
    const seqKey = journey.approachesUsed.slice(0, 3).join("_then_");
    const key = `sequence.${seqKey}.${journey.outcome}`;
    patterns.push({
      key,
      category: isPositive ? "best_practice" : isNegative ? "avoid" : "correction",
      description: `Approach sequence [${journey.approachesUsed.slice(0, 3).join(" → ")}] led to ${journey.outcome}`,
      details: `Full sequence: ${journey.approachesUsed.join(" → ")}. Channel: ${journey.channel}, Messages: ${journey.messageCount}`,
      suggestedAction: isPositive
        ? `Replicate this approach sequence for similar leads`
        : `Try a different approach sequence — this one tends to ${journey.outcome}`,
    });
  }

  // Pattern 3: Channel × Outcome (for channel strategy learning)
  const chKey = `channel.${journey.channel.toLowerCase()}.${journey.outcome}`;
  patterns.push({
    key: chKey,
    category: isPositive ? "best_practice" : isNegative ? "avoid" : "correction",
    description: `Channel ${journey.channel} led to ${journey.outcome} outcome`,
    details: `Messages: ${journey.messageCount}, Days: ${journey.daysToOutcome}, Value: $${journey.pipelineValue}`,
    suggestedAction: isPositive
      ? `${journey.channel} is effective for this type of lead`
      : `Consider alternative channels for leads that tend to ${journey.outcome} on ${journey.channel}`,
  });

  // Pattern 4: Speed-to-outcome (fast wins vs slow losses)
  if (journey.daysToOutcome <= 3 && isPositive) {
    patterns.push({
      key: `speed.fast_win.${journey.channel.toLowerCase()}`,
      category: "best_practice",
      description: `Fast win (${journey.daysToOutcome} days) on ${journey.channel}`,
      details: `Approaches: ${journey.approachesUsed.join(", ")}. Messages: ${journey.messageCount}`,
      suggestedAction: "Prioritize quick engagement — leads that convert fast use this pattern",
    });
  } else if (journey.daysToOutcome > 14 && isNegative) {
    patterns.push({
      key: `speed.slow_loss.${journey.channel.toLowerCase()}`,
      category: "avoid",
      description: `Slow loss (${journey.daysToOutcome} days) on ${journey.channel}`,
      details: `Approaches: ${journey.approachesUsed.join(", ")}. Messages: ${journey.messageCount}`,
      suggestedAction: "Escalate or change approach earlier — prolonged engagement without progress leads to loss",
    });
  }

  // Pattern 5: Stage × Framework × Outcome (stage-aware learning)
  if (journey.finalStage) {
    const stageKey = journey.finalStage.toLowerCase().replace(/[\s\-\+]+/g, "_");
    for (const fw of journey.frameworksUsed.slice(0, 2)) {
      const key = `stage.${stageKey}.${fw.toLowerCase().replace(/\s+/g, "_")}.${journey.outcome}`;
      patterns.push({
        key,
        category: isPositive ? "best_practice" : isNegative ? "avoid" : "correction",
        description: `At stage "${journey.finalStage}", framework ${fw} led to ${journey.outcome}`,
        details: `Stage playbook: ${getPlaybookSummaryForLearning(journey.finalStage)}. Channel: ${journey.channel}, Messages: ${journey.messageCount}`,
        suggestedAction: isPositive
          ? `Use ${fw} when leads are at "${journey.finalStage}" stage`
          : `Avoid ${fw} at "${journey.finalStage}" — try alternative frameworks`,
      });
    }
  }

  // Pattern 6: Outcome reason (if provided)
  if (journey.outcomeReason) {
    const reasonKey = `reason.${journey.outcomeReason.toLowerCase().replace(/\s+/g, "_")}`;
    patterns.push({
      key: reasonKey,
      category: isNegative ? "knowledge_gap" : "best_practice",
      description: `Outcome reason: ${journey.outcomeReason}`,
      details: `Outcome: ${journey.outcome}, Channel: ${journey.channel}, Approaches: ${journey.approachesUsed.join(", ")}`,
      suggestedAction: isNegative
        ? `Address "${journey.outcomeReason}" proactively in future conversations`
        : `This reason correlates with positive outcomes — reinforce it`,
    });
  }

  return patterns;
}

// =================================================================
// 3. PROMOTION — Auto-promote patterns to Strategist prompt
// =================================================================

/**
 * Periodic scan: check all learnings for promotion eligibility.
 * Promotes patterns that have recurrence >= PROMOTION_THRESHOLD with positive outcomes.
 * Demotes patterns with high negative outcomes to "avoid" category.
 * Returns count of newly promoted patterns.
 */
export async function runPromotionScan(): Promise<{ promoted: number; demoted: number; total: number }> {
  const db = await getDb();
  if (!db) return { promoted: 0, demoted: 0, total: 0 };

  const now = Date.now();
  let promoted = 0;
  let demoted = 0;

  try {
    // Find patterns eligible for promotion (not yet promoted, enough recurrence + positive outcomes)
    const candidates = await db.select()
      .from(learnings)
      .where(and(
        eq(learnings.promotedToPrompt, 0),
        gte(learnings.recurrenceCount, PROMOTION_THRESHOLD),
      ));

    // Check how many are already promoted (cap at MAX_PROMOTED_RULES)
    const [{ count: alreadyPromoted }] = await db.select({
      count: sql<number>`COUNT(*)`,
    }).from(learnings).where(eq(learnings.promotedToPrompt, 1));

    let slotsAvailable = MAX_PROMOTED_RULES - alreadyPromoted;

    for (const candidate of candidates) {
      const positiveRate = candidate.positiveOutcomes && candidate.recurrenceCount
        ? (candidate.positiveOutcomes / candidate.recurrenceCount) * 100
        : 0;
      const negativeRate = candidate.negativeOutcomes && candidate.recurrenceCount
        ? (candidate.negativeOutcomes / candidate.recurrenceCount) * 100
        : 0;

      // Promote if mostly positive
      if (positiveRate >= 60 && slotsAvailable > 0 && candidate.category === "best_practice") {
        await db.update(learnings)
          .set({ promotedToPrompt: 1, promotedAt: now, updatedAt: now })
          .where(eq(learnings.id, candidate.id));
        promoted++;
        slotsAvailable--;
        console.log(`[LearningLoop] PROMOTED: ${candidate.patternKey} (${candidate.recurrenceCount} recurrences, ${positiveRate.toFixed(0)}% positive)`);
      }

      // Demote if mostly negative (update category to "avoid" and promote as warning)
      if (negativeRate >= 60 && (candidate.negativeOutcomes || 0) >= DEMOTION_THRESHOLD) {
        await db.update(learnings)
          .set({
            category: "avoid",
            promotedToPrompt: slotsAvailable > 0 ? 1 : 0,
            promotedAt: slotsAvailable > 0 ? now : undefined,
            updatedAt: now,
          })
          .where(eq(learnings.id, candidate.id));
        demoted++;
        if (slotsAvailable > 0) slotsAvailable--;
        console.log(`[LearningLoop] DEMOTED to avoid: ${candidate.patternKey} (${candidate.recurrenceCount} recurrences, ${negativeRate.toFixed(0)}% negative)`);
      }
    }

    const total = candidates.length;
    if (promoted > 0 || demoted > 0) {
      console.log(`[LearningLoop] Promotion scan: ${promoted} promoted, ${demoted} demoted, ${total} candidates evaluated`);
    }

    return { promoted, demoted, total };
  } catch (err) {
    console.error("[LearningLoop] Promotion scan error:", err);
    return { promoted: 0, demoted: 0, total: 0 };
  }
}

// =================================================================
// 4. STRATEGIST INTEGRATION — Get promoted learnings for prompt injection
// =================================================================

/**
 * Returns all promoted learnings formatted for the Strategist prompt.
 * This is injected alongside the existing buildLearningContext() output.
 */
export async function getPromotedLearnings(): Promise<string> {
  const db = await getDb();
  if (!db) return "";

  try {
    const promoted = await db.select()
      .from(learnings)
      .where(eq(learnings.promotedToPrompt, 1))
      .orderBy(desc(learnings.recurrenceCount))
      .limit(MAX_PROMOTED_RULES);

    if (promoted.length === 0) {
      return "PROMOTED LEARNINGS: No patterns promoted yet. System is still learning.";
    }

    const lines: string[] = [
      `PROMOTED LEARNINGS (${promoted.length} auto-discovered patterns):`,
    ];

    const bestPractices = promoted.filter(p => p.category === "best_practice");
    const avoidRules = promoted.filter(p => p.category === "avoid");
    const corrections = promoted.filter(p => p.category === "correction" || p.category === "knowledge_gap");

    if (bestPractices.length > 0) {
      lines.push("");
      lines.push("DO (proven patterns):");
      for (const p of bestPractices) {
        lines.push(`  ✓ ${p.description} (seen ${p.recurrenceCount}x, ${p.positiveOutcomes} positive)`);
        if (p.suggestedAction) lines.push(`    → ${p.suggestedAction}`);
      }
    }

    if (avoidRules.length > 0) {
      lines.push("");
      lines.push("AVOID (negative patterns):");
      for (const p of avoidRules) {
        lines.push(`  ✗ ${p.description} (seen ${p.recurrenceCount}x, ${p.negativeOutcomes} negative)`);
        if (p.suggestedAction) lines.push(`    → ${p.suggestedAction}`);
      }
    }

    if (corrections.length > 0) {
      lines.push("");
      lines.push("CORRECTIONS:");
      for (const p of corrections) {
        lines.push(`  ⚠ ${p.description} (seen ${p.recurrenceCount}x)`);
        if (p.suggestedAction) lines.push(`    → ${p.suggestedAction}`);
      }
    }

    return lines.join("\n");
  } catch (err) {
    console.error("[LearningLoop] Error getting promoted learnings:", err);
    return "";
  }
}

// =================================================================
// 5. ANALYTICS — Get learning stats for dashboard
// =================================================================

export interface LearningStats {
  totalPatterns: number;
  promotedCount: number;
  bestPracticeCount: number;
  avoidCount: number;
  correctionCount: number;
  knowledgeGapCount: number;
  totalOutcomes: number;
  wonOutcomes: number;
  lostOutcomes: number;
  staleOutcomes: number;
  dncOutcomes: number;
  avgDaysToWin: number;
  avgDaysToLoss: number;
  topPatterns: Array<{ patternKey: string; category: string; recurrenceCount: number; positiveOutcomes: number; negativeOutcomes: number }>;
}

export async function getLearningStats(): Promise<LearningStats> {
  const db = await getDb();
  const empty: LearningStats = {
    totalPatterns: 0, promotedCount: 0, bestPracticeCount: 0, avoidCount: 0,
    correctionCount: 0, knowledgeGapCount: 0, totalOutcomes: 0, wonOutcomes: 0,
    lostOutcomes: 0, staleOutcomes: 0, dncOutcomes: 0, avgDaysToWin: 0,
    avgDaysToLoss: 0, topPatterns: [],
  };
  if (!db) return empty;

  try {
    // Pattern counts
    const patternCounts = await db.select({
      category: learnings.category,
      count: sql<number>`COUNT(*)`,
      promoted: sql<number>`SUM(CASE WHEN ${learnings.promotedToPrompt} = 1 THEN 1 ELSE 0 END)`,
    }).from(learnings).groupBy(learnings.category);

    let totalPatterns = 0;
    let promotedCount = 0;
    let bestPracticeCount = 0;
    let avoidCount = 0;
    let correctionCount = 0;
    let knowledgeGapCount = 0;

    for (const row of patternCounts) {
      totalPatterns += row.count;
      promotedCount += row.promoted;
      if (row.category === "best_practice") bestPracticeCount = row.count;
      else if (row.category === "avoid") avoidCount = row.count;
      else if (row.category === "correction") correctionCount = row.count;
      else if (row.category === "knowledge_gap") knowledgeGapCount = row.count;
    }

    // Outcome counts
    const outcomeCounts = await db.select({
      outcome: conversationOutcomes.outcome,
      count: sql<number>`COUNT(*)`,
      avgDays: sql<number>`AVG(${conversationOutcomes.daysToOutcome})`,
    }).from(conversationOutcomes).groupBy(conversationOutcomes.outcome);

    let totalOutcomes = 0;
    let wonOutcomes = 0;
    let lostOutcomes = 0;
    let staleOutcomes = 0;
    let dncOutcomes = 0;
    let avgDaysToWin = 0;
    let avgDaysToLoss = 0;

    for (const row of outcomeCounts) {
      totalOutcomes += row.count;
      if (row.outcome === "won") { wonOutcomes = row.count; avgDaysToWin = Math.round(row.avgDays || 0); }
      else if (row.outcome === "lost") { lostOutcomes = row.count; avgDaysToLoss = Math.round(row.avgDays || 0); }
      else if (row.outcome === "stale") staleOutcomes = row.count;
      else if (row.outcome === "dnc") dncOutcomes = row.count;
    }

    // Top patterns
    const topPatterns = await db.select({
      patternKey: learnings.patternKey,
      category: learnings.category,
      recurrenceCount: learnings.recurrenceCount,
      positiveOutcomes: learnings.positiveOutcomes,
      negativeOutcomes: learnings.negativeOutcomes,
    })
      .from(learnings)
      .orderBy(desc(learnings.recurrenceCount))
      .limit(10);

    return {
      totalPatterns, promotedCount, bestPracticeCount, avoidCount,
      correctionCount, knowledgeGapCount, totalOutcomes, wonOutcomes,
      lostOutcomes, staleOutcomes, dncOutcomes, avgDaysToWin, avgDaysToLoss,
      topPatterns: topPatterns.map(p => ({
        patternKey: p.patternKey,
        category: p.category,
        recurrenceCount: p.recurrenceCount || 0,
        positiveOutcomes: p.positiveOutcomes || 0,
        negativeOutcomes: p.negativeOutcomes || 0,
      })),
    };
  } catch (err) {
    console.error("[LearningLoop] Error getting stats:", err);
    return empty;
  }
}

// =================================================================
// 6. VIOLATION-BASED LEARNING — Ingest QC violations into the learning loop
// =================================================================

/**
 * Record a QC violation as a learning pattern.
 * Called when the Brain Council blocks a message (after reformulation exhausted).
 * Generates avoidance patterns that can be promoted into the Strategist/Composer prompts.
 */
export async function recordViolationLearning(opts: {
  violationCategory: string;
  violationReason: string;
  leadId: number;
  channel: string;
  framework?: string;
  approach?: string;
  persona?: string;
  qcScore: number;
  reformulationAttempts: number;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const now = Date.now();

  // Generate multiple pattern keys from the violation
  const patterns: Array<{
    key: string;
    category: "avoid" | "correction";
    description: string;
    details: string;
    suggestedAction: string;
  }> = [];

  // Pattern 1: Violation type (general)
  patterns.push({
    key: `violation.${opts.violationCategory}`,
    category: "avoid",
    description: `QC violation: ${opts.violationCategory} — ${opts.violationReason.substring(0, 200)}`,
    details: `Channel: ${opts.channel}, Framework: ${opts.framework || "unknown"}, QC Score: ${opts.qcScore}, Reformulations: ${opts.reformulationAttempts}`,
    suggestedAction: getViolationFixAdvice(opts.violationCategory),
  });

  // Pattern 2: Violation × Framework (if framework contributed to the issue)
  if (opts.framework) {
    patterns.push({
      key: `violation.${opts.violationCategory}.framework.${opts.framework.toLowerCase().replace(/\s+/g, "_")}`,
      category: "correction",
      description: `${opts.violationCategory} tends to occur with ${opts.framework} framework`,
      details: `Reason: ${opts.violationReason.substring(0, 200)}. Channel: ${opts.channel}`,
      suggestedAction: `When using ${opts.framework}, pay extra attention to avoid ${opts.violationCategory}`,
    });
  }

  // Pattern 3: Violation × Persona (if persona-specific)
  if (opts.persona) {
    patterns.push({
      key: `violation.${opts.violationCategory}.persona.${opts.persona}`,
      category: "correction",
      description: `${opts.violationCategory} occurs for ${opts.persona} persona`,
      details: `Reason: ${opts.violationReason.substring(0, 200)}. Framework: ${opts.framework || "unknown"}`,
      suggestedAction: `For ${opts.persona} leads, avoid patterns that trigger ${opts.violationCategory}`,
    });
  }

  for (const pattern of patterns) {
    try {
      const [existing] = await db.select()
        .from(learnings)
        .where(eq(learnings.patternKey, pattern.key))
        .limit(1);

      if (existing) {
        await db.update(learnings)
          .set({
            recurrenceCount: sql`${learnings.recurrenceCount} + 1`,
            negativeOutcomes: sql`${learnings.negativeOutcomes} + 1`,
            updatedAt: now,
            priority: (existing.recurrenceCount || 0) >= 9 ? "critical" :
              (existing.recurrenceCount || 0) >= 4 ? "high" :
              (existing.recurrenceCount || 0) >= 2 ? "medium" : "low",
          })
          .where(eq(learnings.id, existing.id));
      } else {
        await db.insert(learnings).values({
          patternKey: pattern.key,
          category: pattern.category,
          description: pattern.description,
          details: pattern.details,
          suggestedAction: pattern.suggestedAction,
          recurrenceCount: 1,
          positiveOutcomes: 0,
          negativeOutcomes: 1,
          priority: "low",
          source: "qc_violation",
          createdAt: now,
          updatedAt: now,
        });
      }
    } catch (err) {
      if (!(err as any)?.message?.includes("Duplicate")) {
        console.error(`[LearningLoop] Violation pattern error for ${pattern.key}:`, err);
      }
    }
  }

  console.log(`[LearningLoop] Recorded ${patterns.length} violation patterns for ${opts.violationCategory} (lead ${opts.leadId})`);
}

/**
 * Record a successful reformulation as a positive learning.
 * Called when the Brain Council successfully reformulates a message after a QC violation.
 * This teaches the system what fixes work.
 */
export async function recordReformulationSuccess(opts: {
  violationCategory: string;
  framework?: string;
  reformulationAttempt: number;
  originalQcScore: number;
  finalQcScore: number;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const now = Date.now();
  const key = `reformulation.${opts.violationCategory}.success`;

  try {
    const [existing] = await db.select()
      .from(learnings)
      .where(eq(learnings.patternKey, key))
      .limit(1);

    if (existing) {
      await db.update(learnings)
        .set({
          recurrenceCount: sql`${learnings.recurrenceCount} + 1`,
          positiveOutcomes: sql`${learnings.positiveOutcomes} + 1`,
          updatedAt: now,
          details: `Last fix: attempt ${opts.reformulationAttempt}, score ${opts.originalQcScore} → ${opts.finalQcScore}. Framework: ${opts.framework || "unknown"}`,
        })
        .where(eq(learnings.id, existing.id));
    } else {
      await db.insert(learnings).values({
        patternKey: key,
        category: "best_practice",
        description: `Reformulation fixes ${opts.violationCategory} violations effectively`,
        details: `First fix: attempt ${opts.reformulationAttempt}, score ${opts.originalQcScore} → ${opts.finalQcScore}. Framework: ${opts.framework || "unknown"}`,
        suggestedAction: getViolationFixAdvice(opts.violationCategory),
        recurrenceCount: 1,
        positiveOutcomes: 1,
        negativeOutcomes: 0,
        priority: "low",
        source: "qc_reformulation",
        createdAt: now,
        updatedAt: now,
      });
    }

    console.log(`[LearningLoop] Recorded reformulation success for ${opts.violationCategory}`);
  } catch (err) {
    if (!(err as any)?.message?.includes("Duplicate")) {
      console.error(`[LearningLoop] Reformulation success error:`, err);
    }
  }
}

/**
 * Get violation-derived avoidance rules formatted for Composer/Strategist prompt injection.
 * Returns recent, high-recurrence violation patterns as AVOID rules.
 * Cached for 10 minutes to avoid DB hammering.
 */
export async function getViolationAvoidanceRules(): Promise<string> {
  const db = await getDb();
  if (!db) return "";

  try {
    // Get high-recurrence violation patterns from the last 30 days
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const violations = await db.select()
      .from(learnings)
      .where(and(
        sql`${learnings.patternKey} LIKE 'violation.%'`,
        gte(learnings.recurrenceCount, 2),
        gte(learnings.updatedAt, thirtyDaysAgo),
      ))
      .orderBy(desc(learnings.recurrenceCount))
      .limit(10);

    if (violations.length === 0) return "";

    const lines: string[] = [
      `QC VIOLATION AVOIDANCE (${violations.length} recurring patterns from recent messages):`,
    ];

    for (const v of violations) {
      const severity = (v.recurrenceCount || 0) >= 5 ? "⛔" : "⚠";
      lines.push(`  ${severity} ${v.description} (${v.recurrenceCount}x)`);
      if (v.suggestedAction) lines.push(`    → ${v.suggestedAction}`);
    }

    return lines.join("\n");
  } catch (err) {
    console.error("[LearningLoop] Error getting violation avoidance rules:", err);
    return "";
  }
}

/**
 * Get specific fix advice for a violation category.
 * Used by both the learning loop (for recording) and the Composer (for prompt injection).
 */
function getViolationFixAdvice(category: string): string {
  const advice: Record<string, string> = {
    repeated_opener: "Never start with 'Hey [Name]' or 'Hi [Name]' if used before. Start with content, a question, or a bold statement instead.",
    repeated_question: "Don't re-ask questions from prior messages. Provide value — pricing, examples, social proof — instead of asking again.",
    generic_opener: "Reference the lead's SPECIFIC request (product, event, business name) in the opening sentence.",
    context_free_subject: "Email subjects must reference specific context — product type, business name, event, or their request.",
    passive_reactivation: "Lead with specific value — pricing, case study, or social proof. Don't be vague or passive.",
    missing_framework: "Follow ACA structure: Acknowledge their situation, Compliment something specific, Ask a targeted question.",
    form_data_ignored: "Always reference the lead's form data — their product request is the most important context.",
    ignored_request: "When leads ask about pricing/quotes, address it with actual pricing ranges or a commitment to provide a quote.",
    irrelevant_research: "Drop research data that doesn't match the lead's actual request. Focus on form data and conversation history.",
    channel_mismatch: "Always reply on the same channel the lead messaged on.",
    wrong_business: "NEVER reference businesses other than Adorb Custom Tees / the lead's own business.",
    safety_violation: "Never make unfulfillable promises, reference explicit content, or claim capabilities we don't have.",
  };
  return advice[category] || `Avoid triggering ${category} violations in future messages.`;
}

// =================================================================
// 8. AGENT SUCCESS LEARNING — Extract patterns from human agent wins
// =================================================================

import { invokeLLM } from "./_core/llm";

interface AgentPattern {
  patternKey: string;
  description: string;
  details: string;
  suggestedAction: string;
}

/**
 * When a lead with human agent messages reaches a "won" terminal stage,
 * extract the agent's conversation patterns and record them as learnings.
 * The AI can then learn from what Abby/Chris do when they close deals.
 */
export async function extractAgentPatterns(leadId: number): Promise<AgentPattern[]> {
  const db = await getDb();
  if (!db) return [];

  try {
    // Get the lead info
    const [lead] = await db.select()
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) return [];

    // Get all conversation messages for this lead
    const allConvos = await db.select({
      direction: conversations.direction,
      messageBody: conversations.messageBody,
      senderType: conversations.senderType,
      senderName: conversations.senderName,
      channel: conversations.channel,
      timestamp: conversations.timestamp,
    })
      .from(conversations)
      .where(eq(conversations.leadId, leadId))
      .orderBy(conversations.timestamp);

    // Filter to only human agent outbound + lead inbound messages
    const agentMessages = allConvos.filter(c => c.senderType === "human" && c.direction === "outbound");
    const leadMessages = allConvos.filter(c => c.senderType === "lead" && c.direction === "inbound");

    if (agentMessages.length === 0) return [];

    // Build conversation transcript for LLM analysis
    const transcript = allConvos
      .filter(c => c.senderType === "human" || c.senderType === "lead")
      .map(c => {
        const role = c.senderType === "human" ? `Agent (${c.senderName || "Agent"})` : "Customer";
        const time = c.timestamp ? new Date(c.timestamp).toLocaleString() : "";
        return `[${time}] ${role} (${c.channel}): ${(c.messageBody || "").substring(0, 500)}`;
      })
      .join("\n");

    if (transcript.length < 50) return []; // Too short to analyze

    // Use LLM to extract patterns
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are a sales pattern analyst for Adorb Custom Printing (custom t-shirts, apparel, DTF transfers).
Analyze this successful sales conversation between a human agent and a customer that resulted in a CLOSED DEAL.
Extract the specific patterns that led to the successful close.

Return a JSON array of patterns, each with:
- patternKey: a stable snake_case identifier (e.g., "agent.opener.reference_specific_product", "agent.close.confirm_timeline")
- description: one-sentence description of the pattern
- details: 2-3 sentences explaining what the agent did and why it worked
- suggestedAction: actionable instruction the AI should follow to replicate this pattern

Focus on:
1. Opening approach — how did the agent start the conversation?
2. Objection handling — how did they handle pushback or silence?
3. Closing technique — what sealed the deal?
4. Tone and style — formal/casual, message length, emoji use
5. Key phrases or value propositions that resonated
6. Channel strategy — did they switch channels effectively?

Return 3-6 patterns maximum. Only extract clear, replicable patterns.`,
        },
        {
          role: "user",
          content: `Lead: ${lead.name || "Unknown"} (${(lead as any).companyName || "Unknown company"})
Product interest: ${(lead as any).productInterest || "custom apparel"}
Pipeline stage: ${lead.pipelineStage || "delivered"}
Agent messages: ${agentMessages.length}, Customer messages: ${leadMessages.length}

Full conversation transcript:
${transcript}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "agent_patterns",
          strict: true,
          schema: {
            type: "object",
            properties: {
              patterns: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    patternKey: { type: "string", description: "Stable snake_case identifier" },
                    description: { type: "string", description: "One-sentence description" },
                    details: { type: "string", description: "2-3 sentence explanation" },
                    suggestedAction: { type: "string", description: "Actionable instruction for AI" },
                  },
                  required: ["patternKey", "description", "details", "suggestedAction"],
                  additionalProperties: false,
                },
              },
            },
            required: ["patterns"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) return [];

    const parsed = JSON.parse(String(content));
    const patterns: AgentPattern[] = (parsed.patterns || []).slice(0, 6);

    console.log(`[LearningLoop/Agent] Extracted ${patterns.length} patterns from agent success for lead ${leadId}`);
    return patterns;
  } catch (err) {
    console.error(`[LearningLoop/Agent] Error extracting agent patterns for lead ${leadId}:`, err);
    return [];
  }
}

/**
 * Record agent-extracted patterns into the learnings table.
 * These patterns will be picked up by runPromotionScan() and promoted
 * alongside AI-discovered patterns when they recur across multiple deals.
 */
export async function recordAgentLearning(leadId: number, patterns: AgentPattern[]): Promise<number> {
  const db = await getDb();
  if (!db || patterns.length === 0) return 0;

  let recorded = 0;
  const now = Date.now();

  for (const pattern of patterns) {
    try {
      // Check if this pattern already exists
      const [existing] = await db.select()
        .from(learnings)
        .where(eq(learnings.patternKey, pattern.patternKey))
        .limit(1);

      if (existing) {
        // Increment recurrence + positive outcomes (agent wins are always positive)
        await db.update(learnings)
          .set({
            recurrenceCount: sql`${learnings.recurrenceCount} + 1`,
            positiveOutcomes: sql`${learnings.positiveOutcomes} + 1`,
            updatedAt: now,
            // Boost priority faster for agent-sourced patterns (they are proven in the field)
            priority: (existing.recurrenceCount || 0) + 1 >= 2 ? "high" : "medium",
          })
          .where(eq(learnings.id, existing.id));
        console.log(`[LearningLoop/Agent] Updated pattern: ${pattern.patternKey} (recurrence=${(existing.recurrenceCount || 0) + 1})`);
      } else {
        // Create new agent-sourced pattern
        const record: InsertLearning = {
          patternKey: pattern.patternKey,
          category: "best_practice",
          description: pattern.description,
          details: pattern.details,
          suggestedAction: pattern.suggestedAction,
          recurrenceCount: 1,
          positiveOutcomes: 1,
          negativeOutcomes: 0,
          priority: "medium", // Start at medium since agent patterns are pre-validated
          source: "agent_success",
          createdAt: now,
          updatedAt: now,
        };
        await db.insert(learnings).values(record);
        console.log(`[LearningLoop/Agent] New agent pattern: ${pattern.patternKey}`);
      }
      recorded++;
    } catch (err) {
      console.error(`[LearningLoop/Agent] Error recording pattern ${pattern.patternKey}:`, err);
    }
  }

  console.log(`[LearningLoop/Agent] Recorded ${recorded}/${patterns.length} agent patterns from lead ${leadId}`);
  return recorded;
}

// =================================================================
// 8. SUBJECT LINE PATTERN LEARNING
// =================================================================

/**
 * Analyzes email subject line performance from message_outcomes.
 * Groups subjects by pattern (question, personalized, urgency, etc.)
 * and records which patterns get the best open rates.
 * 
 * Called periodically (e.g., daily) to build subject line intelligence.
 */
export async function analyzeSubjectLinePatterns(): Promise<{ analyzed: number; patternsRecorded: number }> {
  const db = await getDb();
  if (!db) return { analyzed: 0, patternsRecorded: 0 };

  try {
    const { messageOutcomes: mo } = await import("../drizzle/schema");

    // Get all email outcomes with subject lines from the last 90 days
    const windowStart = new Date(Date.now() - PATTERN_SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const outcomes = await db.select({
      emailSubject: mo.emailSubject,
      emailOpened: mo.emailOpened,
      gotReply: mo.gotReply,
      replySentiment: mo.replySentiment,
      converted: mo.converted,
    })
      .from(mo)
      .where(and(
        sql`${mo.emailSubject} IS NOT NULL AND ${mo.emailSubject} != ''`,
        eq(mo.channel, "Email"),
        gte(mo.attributedAt, windowStart),
      ));

    if (outcomes.length < MIN_SAMPLE_SIZE) {
      return { analyzed: outcomes.length, patternsRecorded: 0 };
    }

    // Classify subject lines into patterns
    const patternBuckets: Record<string, { opens: number; total: number; replies: number; positive: number; examples: string[] }> = {};

    for (const o of outcomes) {
      const subject = (o.emailSubject || "").toLowerCase();
      const pattern = classifySubjectPattern(subject);

      if (!patternBuckets[pattern]) {
        patternBuckets[pattern] = { opens: 0, total: 0, replies: 0, positive: 0, examples: [] };
      }
      patternBuckets[pattern].total++;
      if (o.emailOpened) patternBuckets[pattern].opens++;
      if (o.gotReply) patternBuckets[pattern].replies++;
      if (o.replySentiment === "positive") patternBuckets[pattern].positive++;
      if (patternBuckets[pattern].examples.length < 3) {
        patternBuckets[pattern].examples.push(o.emailSubject || "");
      }
    }

    // Record patterns with enough data
    let patternsRecorded = 0;
    const now = Date.now();

    for (const [pattern, stats] of Object.entries(patternBuckets)) {
      if (stats.total < MIN_SAMPLE_SIZE) continue;

      const openRate = Math.round((stats.opens / stats.total) * 100);
      const replyRate = Math.round((stats.replies / stats.total) * 100);
      const patternKey = `subject.${pattern}`;
      const isPositive = openRate >= 40; // 40%+ open rate is good
      const isNegative = openRate < 15;  // <15% open rate is bad

      const description = `Email subject pattern '${pattern}': ${openRate}% open rate, ${replyRate}% reply rate (n=${stats.total})`;
      const details = `Examples: ${stats.examples.join(" | ")}`;

      // Upsert the learning
      const [existing] = await db.select()
        .from(learnings)
        .where(eq(learnings.patternKey, patternKey))
        .limit(1);

      if (existing) {
        await db.update(learnings).set({
          description,
          details,
          recurrenceCount: stats.total,
          positiveOutcomes: isPositive ? stats.total : (existing.positiveOutcomes || 0),
          negativeOutcomes: isNegative ? stats.total : (existing.negativeOutcomes || 0),
          category: isNegative ? "avoid" : "best_practice",
          updatedAt: now,
        }).where(eq(learnings.id, existing.id));
      } else {
        await db.insert(learnings).values({
          patternKey,
          category: isNegative ? "avoid" : "best_practice",
          description,
          details,
          suggestedAction: isPositive
            ? `Prefer '${pattern}' subject line pattern — ${openRate}% open rate`
            : isNegative
            ? `Avoid '${pattern}' subject line pattern — only ${openRate}% open rate`
            : undefined,
          recurrenceCount: stats.total,
          positiveOutcomes: isPositive ? stats.total : 0,
          negativeOutcomes: isNegative ? stats.total : 0,
          priority: isPositive ? "high" : isNegative ? "high" : "medium",
          source: "subject_analysis",
          createdAt: now,
          updatedAt: now,
        });
      }
      patternsRecorded++;
    }

    if (patternsRecorded > 0) {
      console.log(`[LearningLoop/Subject] Analyzed ${outcomes.length} emails, recorded ${patternsRecorded} subject patterns`);
    }

    return { analyzed: outcomes.length, patternsRecorded };
  } catch (err) {
    console.error("[LearningLoop/Subject] Error:", err);
    return { analyzed: 0, patternsRecorded: 0 };
  }
}

/**
 * Classify a subject line into a pattern category.
 */
function classifySubjectPattern(subject: string): string {
  if (subject.endsWith("?")) return "question";
  if (/\byour\b/.test(subject) || /\byou\b/.test(subject)) return "personalized_you";
  if (/still|yet|update/.test(subject)) return "follow_up";
  if (/quick|fast|just/.test(subject)) return "casual_short";
  if (/idea|thought/.test(subject)) return "suggestion";
  if (/ready|need|looking/.test(subject)) return "need_based";
  if (/new|fresh|latest|just launched/.test(subject)) return "novelty";
  if (/save|deal|offer|free|discount/.test(subject)) return "promotional";
  if (subject.length <= 20) return "ultra_short";
  if (subject.length <= 35) return "short";
  return "standard";
}

// =================================================================
// EXPORTS for testing
// =================================================================
export { generatePatternKeys, classifySubjectPattern, PROMOTION_THRESHOLD, DEMOTION_THRESHOLD, MIN_SAMPLE_SIZE, MAX_PROMOTED_RULES, getViolationFixAdvice };
