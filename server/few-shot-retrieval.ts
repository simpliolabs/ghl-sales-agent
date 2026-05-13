/**
 * Dynamic Few-Shot Retrieval Engine
 * 
 * Replaces LoRA fine-tuning by injecting the most relevant winning examples
 * into the composer prompt at runtime. Uses multi-dimensional similarity
 * matching across framework, channel, persona, approach, and promotion reason.
 * 
 * Scoring algorithm:
 *   - Exact framework match: +4 points
 *   - Exact channel match: +3 points
 *   - Exact persona match: +3 points
 *   - Approach match: +2 points
 *   - Segment match: +1 point
 *   - Recency bonus: +1 if created within last 14 days
 *   - Conversion bonus: +2 if the example led to a conversion
 *   - Stage advance bonus: +1 if the example advanced the pipeline
 * 
 * Falls back through progressively looser matching to always return examples.
 */

import { getDb } from "./db";
import { hallOfFame } from "../drizzle/schema";
import { desc, sql } from "drizzle-orm";

interface FewShotQuery {
  framework: string;
  channel: string;
  persona?: string | null;
  approach?: string | null;
  segment?: string | null;
  limit?: number;
}

interface ScoredExample {
  message: string;
  framework: string;
  channel: string | null;
  persona: string | null;
  approach: string | null;
  segment: string | null;
  promotionReason: string;
  converted: number | null;
  stageAdvanced: number | null;
  replyMinutes: number | null;
  createdAt: Date | null;
  relevanceScore: number;
}

// In-memory cache with 10-minute TTL
const cache = new Map<string, { data: ScoredExample[]; ts: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getCacheKey(query: FewShotQuery): string {
  return `${query.framework}:${query.channel}:${query.persona || ""}:${query.approach || ""}:${query.segment || ""}`;
}

/**
 * Score a hall of fame entry against the current context
 */
function scoreExample(
  entry: any,
  query: FewShotQuery
): number {
  let score = 0;

  // Framework match (highest weight — this determines the messaging style)
  if (entry.framework === query.framework) score += 4;

  // Channel match (important — SMS vs FB vs Email have very different styles)
  if (entry.channel === query.channel) score += 3;

  // Persona match (important — church vs small_business vs event need different tone)
  if (query.persona && entry.persona === query.persona) score += 3;

  // Approach match (first_contact vs follow_up vs reactivation)
  if (query.approach && entry.approach === query.approach) score += 2;

  // Segment match (omnisend segment alignment)
  if (query.segment && entry.segment === query.segment) score += 1;

  // Recency bonus — recent wins are more relevant to current market conditions
  if (entry.createdAt) {
    const ageMs = Date.now() - new Date(entry.createdAt).getTime();
    if (ageMs < 14 * 24 * 60 * 60 * 1000) score += 1; // within 14 days
  }

  // Outcome quality bonuses
  if (entry.converted === 1) score += 2;
  if (entry.stageAdvanced === 1) score += 1;

  // Fast reply bonus (replied within 10 minutes = very engaged)
  if (entry.replyMinutes && entry.replyMinutes <= 10) score += 1;

  return score;
}

/**
 * Retrieve the top N most relevant winning examples for the current context.
 * Uses multi-dimensional scoring to find the best matches.
 */
export async function getRelevantExamples(query: FewShotQuery): Promise<ScoredExample[]> {
  const limit = query.limit || 5;
  const cacheKey = getCacheKey(query);

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data.slice(0, limit);
  }

  const db = await getDb();
  if (!db) return [];

  try {
    // Pull a broad set of candidates (all hall of fame entries)
    // We score them in-memory since the table is small (92 entries currently)
    const candidates = await db.select({
      message: hallOfFame.message,
      framework: hallOfFame.framework,
      channel: hallOfFame.channel,
      persona: hallOfFame.persona,
      approach: hallOfFame.approach,
      segment: hallOfFame.segment,
      promotionReason: hallOfFame.promotionReason,
      converted: hallOfFame.converted,
      stageAdvanced: hallOfFame.stageAdvanced,
      replyMinutes: hallOfFame.replyMinutes,
      createdAt: hallOfFame.createdAt,
    })
      .from(hallOfFame)
      .orderBy(desc(hallOfFame.createdAt))
      .limit(200); // Cap at 200 for performance

    // Score each candidate
    const scored: ScoredExample[] = candidates.map(entry => ({
      ...entry,
      relevanceScore: scoreExample(entry, query),
    }));

    // Sort by relevance score descending, then by recency
    scored.sort((a, b) => {
      if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
      // Tie-break by recency
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });

    // Deduplicate — don't show two examples with very similar messages
    const deduped: ScoredExample[] = [];
    const seen = new Set<string>();
    for (const ex of scored) {
      // Use first 50 chars as dedup key
      const key = ex.message.substring(0, 50).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(ex);
      if (deduped.length >= limit * 2) break; // Keep extra for diversity
    }

    // Ensure diversity — don't return all examples from the same framework
    const final: ScoredExample[] = [];
    const frameworkCounts = new Map<string, number>();
    const MAX_PER_FRAMEWORK = Math.ceil(limit * 0.6); // Max 60% from one framework

    for (const ex of deduped) {
      const fwCount = frameworkCounts.get(ex.framework) || 0;
      if (fwCount >= MAX_PER_FRAMEWORK && final.length < limit) {
        continue; // Skip if this framework is over-represented
      }
      frameworkCounts.set(ex.framework, fwCount + 1);
      final.push(ex);
      if (final.length >= limit) break;
    }

    // If we didn't get enough due to diversity filtering, backfill
    if (final.length < limit) {
      for (const ex of deduped) {
        if (!final.includes(ex)) {
          final.push(ex);
          if (final.length >= limit) break;
        }
      }
    }

    // Cache the results
    cache.set(cacheKey, { data: final, ts: Date.now() });

    return final.slice(0, limit);
  } catch (err) {
    console.error("[FewShotRetrieval] Error:", err);
    return [];
  }
}

/**
 * Build the few-shot block for injection into the composer prompt.
 * This replaces the simpler getHallOfFameBlock with a smarter version.
 */
export async function getDynamicFewShotBlock(
  framework: string,
  channel: string,
  persona?: string | null,
  approach?: string | null,
  segment?: string | null
): Promise<string> {
  const examples = await getRelevantExamples({
    framework,
    channel,
    persona,
    approach,
    segment,
    limit: 5,
  });

  if (examples.length === 0) return "";

  const lines = examples.map((ex, i) => {
    const meta: string[] = [];
    meta.push(ex.framework);
    if (ex.channel) meta.push(ex.channel);
    if (ex.persona) meta.push(ex.persona);
    if (ex.converted === 1) meta.push("CONVERTED");
    else if (ex.stageAdvanced === 1) meta.push("ADVANCED");
    else if (ex.replyMinutes && ex.replyMinutes <= 5) meta.push(`reply:${ex.replyMinutes}min`);

    const truncMsg = ex.message.length > 250
      ? ex.message.substring(0, 250) + "..."
      : ex.message;

    return `${i + 1}. [${meta.join("/")}] (score:${ex.relevanceScore}) "${truncMsg}"`;
  }).join("\n");

  return `=== WINNING EXAMPLES — These messages got fast/positive replies in similar contexts. Study their tone, structure, and hooks. ===
${lines}
IMPORTANT: Use these as INSPIRATION for tone and structure. Write a UNIQUE message tailored to THIS specific lead. Never copy verbatim.`;
}

/**
 * Invalidate cache for a specific query or all entries
 */
export function invalidateFewShotCache(query?: FewShotQuery): void {
  if (query) {
    cache.delete(getCacheKey(query));
  } else {
    cache.clear();
  }
}
