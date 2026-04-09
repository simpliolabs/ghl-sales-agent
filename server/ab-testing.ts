/**
 * A/B TESTING ENGINE — Controlled experiments for message variants
 *
 * Lifecycle:
 *   1. Admin creates experiment (framework A vs B, approach A vs B, etc.)
 *   2. On every Brain Council run, active experiments are checked
 *   3. Leads are assigned to variant A or B (deterministic hash for consistency)
 *   4. Variant config is passed to Strategist as an override
 *   5. Outcomes (reply, conversion, DNC) are attributed to the variant
 *   6. Statistical significance is evaluated periodically
 *   7. Winners are auto-adopted into promoted learnings
 *
 * Statistical method: Chi-squared test for independence on 2×2 contingency tables.
 * Confidence threshold: configurable per experiment (default 95%).
 */

import { eq, and, desc, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  abExperiments,
  abAssignments,
  messageOutcomes,
  learnings,
  type AbExperiment,
  type InsertAbExperiment,
} from "../drizzle/schema";

// ============================================================
// 1. EXPERIMENT LIFECYCLE
// ============================================================

export interface ExperimentConfig {
  name: string;
  hypothesis: string;
  variantADescription: string;
  variantBDescription: string;
  variantAConfig: Record<string, string>;  // e.g., { framework: "HORMOZI_ACA" }
  variantBConfig: Record<string, string>;  // e.g., { framework: "SOCIAL_PROOF" }
  targetSegment?: string;
  targetChannel?: string;
  targetApproach?: string;
  primaryMetric?: "reply_rate" | "conversion_rate" | "positive_rate";
  sampleSizeTarget?: number;
  confidenceThreshold?: number;
  autoAdopt?: boolean;
}

/**
 * Create a new A/B experiment. Returns the experiment ID.
 */
export async function createExperiment(config: ExperimentConfig): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;

  const experimentId = `exp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  try {
    await db.insert(abExperiments).values({
      experimentId,
      name: config.name,
      hypothesis: config.hypothesis,
      variantADescription: config.variantADescription,
      variantBDescription: config.variantBDescription,
      variantAConfig: config.variantAConfig,
      variantBConfig: config.variantBConfig,
      targetSegment: config.targetSegment || null,
      targetChannel: config.targetChannel || null,
      targetApproach: config.targetApproach || null,
      primaryMetric: config.primaryMetric || "reply_rate",
      sampleSizeTarget: config.sampleSizeTarget || 50,
      confidenceThreshold: config.confidenceThreshold || 95,
      autoAdopt: config.autoAdopt !== false ? 1 : 0,
    });

    console.log(`[ABTest] Created experiment: ${experimentId} — "${config.name}"`);
    return experimentId;
  } catch (err) {
    console.error("[ABTest] Error creating experiment:", err);
    return null;
  }
}

/**
 * Pause or resume an experiment.
 */
export async function setExperimentStatus(experimentId: string, status: "active" | "paused"): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  try {
    await db.update(abExperiments)
      .set({ status })
      .where(eq(abExperiments.experimentId, experimentId));
    return true;
  } catch (err) {
    console.error("[ABTest] Error updating status:", err);
    return false;
  }
}

/**
 * Get all experiments (optionally filtered by status).
 */
export async function listExperiments(status?: string): Promise<AbExperiment[]> {
  const db = await getDb();
  if (!db) return [];

  try {
    const query = status
      ? db.select().from(abExperiments).where(eq(abExperiments.status, status)).orderBy(desc(abExperiments.createdAt))
      : db.select().from(abExperiments).orderBy(desc(abExperiments.createdAt));
    return await query;
  } catch (err) {
    console.error("[ABTest] Error listing experiments:", err);
    return [];
  }
}

// ============================================================
// 2. VARIANT ASSIGNMENT
// ============================================================

/**
 * Assign a lead to a variant for an experiment.
 * Uses deterministic hashing so the same lead always gets the same variant.
 * Returns the variant config to apply, or null if no experiment applies.
 */
export async function assignVariant(
  leadId: number,
  segment: string | null,
  channel: string,
  approach?: string,
): Promise<{ experimentId: string; variant: "A" | "B"; config: Record<string, string> } | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    // Get all active experiments
    const active = await db.select()
      .from(abExperiments)
      .where(eq(abExperiments.status, "active"));

    if (active.length === 0) return null;

    // Find the first matching experiment for this lead
    for (const exp of active) {
      // Check targeting filters
      if (exp.targetSegment && segment && !segment.toLowerCase().includes(exp.targetSegment.toLowerCase())) continue;
      if (exp.targetChannel && channel.toLowerCase() !== exp.targetChannel.toLowerCase()) continue;
      if (exp.targetApproach && approach && approach !== exp.targetApproach) continue;

      // Check if we've reached sample size
      const aSamples = exp.variantASamples || 0;
      const bSamples = exp.variantBSamples || 0;
      const target = exp.sampleSizeTarget || 50;
      if (aSamples >= target && bSamples >= target) continue; // Experiment is full

      // Check if lead is already assigned to this experiment
      const [existing] = await db.select()
        .from(abAssignments)
        .where(and(
          eq(abAssignments.experimentId, exp.experimentId),
          eq(abAssignments.leadId, leadId),
        ))
        .limit(1);

      let variant: "A" | "B";
      if (existing) {
        variant = existing.variant as "A" | "B";
      } else {
        // Deterministic assignment: hash(experimentId + leadId) mod 2
        variant = deterministicVariant(exp.experimentId, leadId, aSamples, bSamples);

        // Record assignment
        await db.insert(abAssignments).values({
          experimentId: exp.experimentId,
          leadId,
          variant,
        });

        // Increment sample count
        if (variant === "A") {
          await db.update(abExperiments)
            .set({ variantASamples: sql`${abExperiments.variantASamples} + 1` })
            .where(eq(abExperiments.experimentId, exp.experimentId));
        } else {
          await db.update(abExperiments)
            .set({ variantBSamples: sql`${abExperiments.variantBSamples} + 1` })
            .where(eq(abExperiments.experimentId, exp.experimentId));
        }

        console.log(`[ABTest] Assigned lead ${leadId} → ${exp.experimentId} variant ${variant}`);
      }

      const config = variant === "A"
        ? (exp.variantAConfig as Record<string, string>)
        : (exp.variantBConfig as Record<string, string>);

      return { experimentId: exp.experimentId, variant, config };
    }

    return null;
  } catch (err) {
    console.error("[ABTest] Error assigning variant:", err);
    return null;
  }
}

/**
 * Deterministic variant assignment using a simple hash.
 * Balances groups by assigning to the smaller group when imbalanced.
 */
function deterministicVariant(experimentId: string, leadId: number, aSamples: number, bSamples: number): "A" | "B" {
  // If one group is significantly smaller, assign there for balance
  if (aSamples > bSamples + 3) return "B";
  if (bSamples > aSamples + 3) return "A";

  // Otherwise, deterministic hash
  let hash = 0;
  const str = `${experimentId}:${leadId}`;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return (Math.abs(hash) % 2 === 0) ? "A" : "B";
}

// ============================================================
// 3. STATISTICAL SIGNIFICANCE
// ============================================================

export interface ExperimentResult {
  experimentId: string;
  name: string;
  variantA: { samples: number; successes: number; rate: number };
  variantB: { samples: number; successes: number; rate: number };
  chiSquared: number;
  pValue: number;
  isSignificant: boolean;
  winnerVariant: "A" | "B" | null;
  lift: number; // percentage improvement of winner over loser
  status: string;
}

/**
 * Evaluate an experiment for statistical significance.
 * Uses chi-squared test on 2×2 contingency table.
 */
export async function evaluateExperiment(experimentId: string): Promise<ExperimentResult | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const [exp] = await db.select()
      .from(abExperiments)
      .where(eq(abExperiments.experimentId, experimentId))
      .limit(1);

    if (!exp) return null;

    // Count successes per variant from message_outcomes
    const metric = exp.primaryMetric || "reply_rate";
    const successColumn = metric === "reply_rate" ? messageOutcomes.gotReply
      : metric === "conversion_rate" ? messageOutcomes.converted
      : messageOutcomes.replySentiment; // positive_rate

    const variantStats = await db.select({
      variant: messageOutcomes.variant,
      total: sql<number>`COUNT(*)`,
      successes: metric === "positive_rate"
        ? sql<number>`SUM(CASE WHEN ${messageOutcomes.replySentiment} = 'positive' THEN 1 ELSE 0 END)`
        : sql<number>`SUM(CASE WHEN ${successColumn} = 1 THEN 1 ELSE 0 END)`,
    })
      .from(messageOutcomes)
      .where(eq(messageOutcomes.experimentId, experimentId))
      .groupBy(messageOutcomes.variant);

    const aStats = variantStats.find(v => v.variant === "A") || { total: 0, successes: 0 };
    const bStats = variantStats.find(v => v.variant === "B") || { total: 0, successes: 0 };

    const aRate = aStats.total > 0 ? (aStats.successes / aStats.total) * 100 : 0;
    const bRate = bStats.total > 0 ? (bStats.successes / bStats.total) * 100 : 0;

    // Chi-squared test
    const { chiSquared, pValue } = chiSquaredTest(
      aStats.successes, aStats.total - aStats.successes,
      bStats.successes, bStats.total - bStats.successes,
    );

    const confidenceThreshold = (exp.confidenceThreshold || 95) / 100;
    const isSignificant = pValue < (1 - confidenceThreshold) && aStats.total >= 10 && bStats.total >= 10;

    let winnerVariant: "A" | "B" | null = null;
    let lift = 0;
    if (isSignificant) {
      winnerVariant = aRate > bRate ? "A" : "B";
      const loserRate = winnerVariant === "A" ? bRate : aRate;
      lift = loserRate > 0 ? Math.round(((Math.max(aRate, bRate) - loserRate) / loserRate) * 100) : 0;
    }

    // Update experiment with results
    await db.update(abExperiments)
      .set({
        variantASamples: aStats.total,
        variantBSamples: bStats.total,
        variantASuccesses: aStats.successes,
        variantBSuccesses: bStats.successes,
        winnerVariant: winnerVariant,
        pValue: pValue.toFixed(6),
      })
      .where(eq(abExperiments.experimentId, experimentId));

    // Auto-complete and adopt if significant
    if (isSignificant && exp.status === "active") {
      await db.update(abExperiments)
        .set({
          status: "completed",
          endedAt: new Date(),
          winnerVariant,
        })
        .where(eq(abExperiments.experimentId, experimentId));

      console.log(`[ABTest] Experiment ${experimentId} COMPLETED — Winner: Variant ${winnerVariant} (${Math.max(aRate, bRate).toFixed(1)}% vs ${Math.min(aRate, bRate).toFixed(1)}%, p=${pValue.toFixed(4)}, lift=${lift}%)`);

      // Auto-adopt winner
      if (exp.autoAdopt) {
        await adoptWinner(exp, winnerVariant!);
      }
    }

    return {
      experimentId: exp.experimentId,
      name: exp.name,
      variantA: { samples: aStats.total, successes: aStats.successes, rate: Math.round(aRate * 10) / 10 },
      variantB: { samples: bStats.total, successes: bStats.successes, rate: Math.round(bRate * 10) / 10 },
      chiSquared: Math.round(chiSquared * 1000) / 1000,
      pValue: Math.round(pValue * 10000) / 10000,
      isSignificant,
      winnerVariant,
      lift,
      status: exp.status,
    };
  } catch (err) {
    console.error("[ABTest] Error evaluating experiment:", err);
    return null;
  }
}

/**
 * Chi-squared test for 2×2 contingency table.
 * Input: successes and failures for group A and group B.
 * Returns chi-squared statistic and approximate p-value.
 */
export function chiSquaredTest(
  aSuccess: number, aFailure: number,
  bSuccess: number, bFailure: number,
): { chiSquared: number; pValue: number } {
  const n = aSuccess + aFailure + bSuccess + bFailure;
  if (n === 0) return { chiSquared: 0, pValue: 1 };

  // Expected values
  const rowA = aSuccess + aFailure;
  const rowB = bSuccess + bFailure;
  const colSuccess = aSuccess + bSuccess;
  const colFailure = aFailure + bFailure;

  if (rowA === 0 || rowB === 0 || colSuccess === 0 || colFailure === 0) {
    return { chiSquared: 0, pValue: 1 };
  }

  const eAS = (rowA * colSuccess) / n;
  const eAF = (rowA * colFailure) / n;
  const eBS = (rowB * colSuccess) / n;
  const eBF = (rowB * colFailure) / n;

  // Apply Yates' correction for small samples
  const yates = n < 40 ? 0.5 : 0;
  const chiSquared =
    Math.pow(Math.max(0, Math.abs(aSuccess - eAS) - yates), 2) / eAS +
    Math.pow(Math.max(0, Math.abs(aFailure - eAF) - yates), 2) / eAF +
    Math.pow(Math.max(0, Math.abs(bSuccess - eBS) - yates), 2) / eBS +
    Math.pow(Math.max(0, Math.abs(bFailure - eBF) - yates), 2) / eBF;

  // Approximate p-value from chi-squared with 1 degree of freedom
  // Using the Wilson-Hilferty approximation
  const pValue = chiSquaredToPValue(chiSquared, 1);

  return { chiSquared, pValue };
}

/**
 * Approximate p-value from chi-squared statistic with df degrees of freedom.
 * Uses the regularized incomplete gamma function approximation.
 */
function chiSquaredToPValue(chiSq: number, df: number): number {
  if (chiSq <= 0) return 1;
  if (chiSq > 1000) return 0;

  // For df=1, use the complementary error function approximation
  const z = Math.sqrt(chiSq);
  // Abramowitz and Stegun approximation 7.1.26
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804014327; // 1/sqrt(2*PI)
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pValue = 2 * d * Math.exp(-z * z / 2) * poly;

  return Math.max(0, Math.min(1, pValue));
}

// ============================================================
// 4. AUTO-ADOPT WINNERS
// ============================================================

/**
 * When an experiment reaches significance, auto-adopt the winning variant
 * by creating a promoted learning entry.
 */
async function adoptWinner(exp: AbExperiment, winnerVariant: "A" | "B"): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const winnerConfig = winnerVariant === "A"
    ? (exp.variantAConfig as Record<string, string>)
    : (exp.variantBConfig as Record<string, string>);
  const winnerDesc = winnerVariant === "A" ? exp.variantADescription : exp.variantBDescription;
  const loserDesc = winnerVariant === "A" ? exp.variantBDescription : exp.variantADescription;

  const patternKey = `experiment.${exp.experimentId}.winner`;
  const now = Date.now();

  try {
    // Check if learning already exists
    const [existing] = await db.select()
      .from(learnings)
      .where(eq(learnings.patternKey, patternKey))
      .limit(1);

    if (existing) return; // Already adopted

    await db.insert(learnings).values({
      patternKey,
      category: "best_practice",
      description: `A/B Test Winner: "${exp.name}" — ${winnerDesc} outperformed ${loserDesc}`,
      details: `Experiment: ${exp.experimentId}. Config: ${JSON.stringify(winnerConfig)}. Target: segment=${exp.targetSegment || "all"}, channel=${exp.targetChannel || "all"}, approach=${exp.targetApproach || "all"}.`,
      suggestedAction: `Use ${JSON.stringify(winnerConfig)} for ${exp.targetSegment ? `"${exp.targetSegment}" leads` : "all leads"} — proven by controlled experiment.`,
      recurrenceCount: Math.max(exp.variantASamples || 0, exp.variantBSamples || 0),
      positiveOutcomes: winnerVariant === "A" ? (exp.variantASuccesses || 0) : (exp.variantBSuccesses || 0),
      negativeOutcomes: 0,
      promotedToPrompt: 1,
      promotedAt: now,
      priority: "high",
      source: "experiment",
      createdAt: now,
      updatedAt: now,
    });

    // Mark experiment as adopted
    await db.update(abExperiments)
      .set({ status: "adopted", adoptedAt: new Date() })
      .where(eq(abExperiments.experimentId, exp.experimentId));

    console.log(`[ABTest] AUTO-ADOPTED: ${exp.experimentId} — Variant ${winnerVariant} (${winnerDesc}) promoted to Strategist`);
  } catch (err) {
    console.error("[ABTest] Error adopting winner:", err);
  }
}

// ============================================================
// 5. PERIODIC EVALUATION
// ============================================================

/**
 * Evaluate all active experiments. Called periodically (e.g., every 6 hours).
 * Returns summary of results.
 */
export async function evaluateAllExperiments(): Promise<{
  evaluated: number;
  completed: number;
  adopted: number;
}> {
  const db = await getDb();
  if (!db) return { evaluated: 0, completed: 0, adopted: 0 };

  const active = await db.select()
    .from(abExperiments)
    .where(eq(abExperiments.status, "active"));

  let evaluated = 0;
  let completed = 0;
  let adopted = 0;

  for (const exp of active) {
    const result = await evaluateExperiment(exp.experimentId);
    if (result) {
      evaluated++;
      if (result.isSignificant) {
        completed++;
        if (exp.autoAdopt) adopted++;
      }
    }
  }

  if (evaluated > 0) {
    console.log(`[ABTest] Evaluation sweep: ${evaluated} evaluated, ${completed} completed, ${adopted} adopted`);
  }

  return { evaluated, completed, adopted };
}

// ============================================================
// EXPORTS for testing
// ============================================================
export { deterministicVariant, adoptWinner };
