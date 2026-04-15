/**
 * LEAD MEMORY — Module 5B: Continuous Private Memory
 *
 * After each successful Brain Council run, this module:
 *   1. Calls the LLM to extract structured facts from the conversation
 *   2. Upserts those facts into the `lead_memory` table (keyed by leadId + factKey)
 *   3. Provides getLeadMemory(leadId) for injection into Brain Council context
 *
 * Fact categories extracted:
 *   - communication_preference  (e.g., "prefers SMS over email")
 *   - budget_signal             (e.g., "$300 budget mentioned")
 *   - timeline_signal           (e.g., "event in June 2025")
 *   - product_interest          (e.g., "interested in hoodies and t-shirts")
 *   - decision_blocker          (e.g., "waiting on board approval")
 *   - positive_signal           (e.g., "responded positively to case studies")
 *   - negative_signal           (e.g., "mentioned competitor pricing")
 *   - contact_info              (e.g., "mentioned they're in Atlanta, GA")
 *
 * Facts are stored with confidence (high/medium/low) and updated on each run.
 * The memory block is injected into LeadContext as `privateMemory` and appears
 * in the Strategist and Composer prompts as a LEAD MEMORY section.
 */

import { invokeLLM } from "./_core/llm";
import { getDb } from "./db";
import { leadMemory } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";

export interface MemoryFact {
  factKey: string;
  factValue: string;
  confidence: "high" | "medium" | "low";
}

const FACT_KEYS = [
  "communication_preference",
  "budget_signal",
  "timeline_signal",
  "product_interest",
  "decision_blocker",
  "positive_signal",
  "negative_signal",
  "contact_info",
] as const;

// ─── Extraction ────────────────────────────────────────────────────────────

/**
 * Call LLM to extract structured facts from the conversation history.
 * Only returns facts that are clearly supported by the conversation.
 */
export async function extractLeadFacts(
  leadName: string,
  conversationHistory: string,
  existingFacts: MemoryFact[],
): Promise<MemoryFact[]> {
  const existingBlock = existingFacts.length > 0
    ? `\nEXISTING KNOWN FACTS (update if new info contradicts or confirms):\n${existingFacts.map(f => `- ${f.factKey}: ${f.factValue} (${f.confidence})`).join("\n")}`
    : "";

  const prompt = `You are a CRM memory extractor for a custom apparel sales team. Extract structured facts about the lead from the conversation.

LEAD NAME: ${leadName}
${existingBlock}

CONVERSATION HISTORY:
${conversationHistory.substring(0, 3000)}

Extract facts ONLY if clearly stated or strongly implied by the lead (not the sales agent). Return an array of facts.

Fact keys to look for:
- communication_preference: Does the lead prefer a specific channel? Did they respond faster on one channel?
- budget_signal: Any mention of budget, price range, or cost concern?
- timeline_signal: Any mention of event dates, deadlines, or urgency?
- product_interest: What specific products, styles, quantities, or customizations did they mention?
- decision_blocker: Any obstacle mentioned (waiting on approval, comparing vendors, budget freeze)?
- positive_signal: Any enthusiasm, compliments, or buying signals?
- negative_signal: Any hesitation, competitor mention, or negative feedback?
- contact_info: Any location, business name, or contact details mentioned?

Rules:
- Only include facts with clear evidence in the conversation
- Keep factValue concise (under 100 chars)
- Set confidence: "high" = explicitly stated, "medium" = strongly implied, "low" = inferred
- If no evidence for a fact key, omit it entirely
- Return empty array if conversation has no useful facts

Respond ONLY with valid JSON array:
[{"factKey": "...", "factValue": "...", "confidence": "high|medium|low"}, ...]`;

  try {
    const response = await invokeLLM({
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "lead_facts",
          strict: true,
          schema: {
            type: "object",
            properties: {
              facts: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    factKey: { type: "string" },
                    factValue: { type: "string" },
                    confidence: { type: "string" },
                  },
                  required: ["factKey", "factValue", "confidence"],
                  additionalProperties: false,
                },
              },
            },
            required: ["facts"],
            additionalProperties: false,
          },
        },
      },
    });
    const raw = response?.choices?.[0]?.message?.content;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const facts: MemoryFact[] = (parsed?.facts || [])
      .filter((f: any) => FACT_KEYS.includes(f.factKey) && f.factValue && f.factValue.length > 0)
      .map((f: any) => ({
        factKey: String(f.factKey),
        factValue: String(f.factValue).substring(0, 200),
        confidence: (["high", "medium", "low"].includes(f.confidence) ? f.confidence : "medium") as "high" | "medium" | "low",
      }));
    return facts;
  } catch (err) {
    console.error("[LeadMemory] Extraction failed:", err);
    return [];
  }
}

// ─── Storage ───────────────────────────────────────────────────────────────

/**
 * Upsert extracted facts into the lead_memory table.
 * If a fact with the same leadId + factKey already exists, update it.
 */
export async function upsertLeadMemory(leadId: number, facts: MemoryFact[]): Promise<void> {
  if (facts.length === 0) return;
  const db = await getDb();
  if (!db) return;

  const now = Date.now();
  for (const fact of facts) {
    try {
      const existing = await db.select()
        .from(leadMemory)
        .where(and(eq(leadMemory.leadId, leadId), eq(leadMemory.factKey, fact.factKey)))
        .limit(1);

      if (existing.length > 0) {
        await db.update(leadMemory)
          .set({
            factValue: fact.factValue,
            confidence: fact.confidence,
            lastConfirmedAt: now,
          })
          .where(and(eq(leadMemory.leadId, leadId), eq(leadMemory.factKey, fact.factKey)));
      } else {
        await db.insert(leadMemory).values({
          leadId,
          factKey: fact.factKey,
          factValue: fact.factValue,
          confidence: fact.confidence,
          source: "brain_council",
          learnedAt: now,
          lastConfirmedAt: now,
        });
      }
    } catch (err) {
      console.error(`[LeadMemory] Upsert failed for ${fact.factKey}:`, err);
    }
  }
  console.log(`[LeadMemory] Upserted ${facts.length} facts for lead ${leadId}`);
}

// ─── Retrieval ─────────────────────────────────────────────────────────────

/**
 * Retrieve all memory facts for a lead and format them as a prompt block.
 * Returns empty string if no facts exist.
 */
export async function getLeadMemory(leadId: number): Promise<string> {
  const db = await getDb();
  if (!db) return "";
  try {
    const facts = await db.select()
      .from(leadMemory)
      .where(eq(leadMemory.leadId, leadId))
      .orderBy(leadMemory.learnedAt);

    if (facts.length === 0) return "";

    const lines = facts.map(f => {
      const conf = f.confidence === "high" ? "✓" : f.confidence === "medium" ? "~" : "?";
      return `  [${conf}] ${f.factKey}: ${f.factValue}`;
    });

    return `LEAD MEMORY (${facts.length} known facts — use these to personalize, never contradict):\n${lines.join("\n")}`;
  } catch (err) {
    console.error("[LeadMemory] Retrieval failed:", err);
    return "";
  }
}

/**
 * Get raw memory facts for a lead (for dashboard display).
 */
export async function getLeadMemoryFacts(leadId: number): Promise<Array<{
  factKey: string;
  factValue: string;
  confidence: string;
  learnedAt: number;
  lastConfirmedAt: number | null;
}>> {
  const db = await getDb();
  if (!db) return [];
  try {
    const facts = await db.select()
      .from(leadMemory)
      .where(eq(leadMemory.leadId, leadId))
      .orderBy(leadMemory.learnedAt);
    return facts.map(f => ({
      factKey: f.factKey,
      factValue: f.factValue,
      confidence: f.confidence,
      learnedAt: f.learnedAt,
      lastConfirmedAt: f.lastConfirmedAt ?? null,
    }));
  } catch (err) {
    console.error("[LeadMemory] Facts retrieval failed:", err);
    return [];
  }
}

/**
 * Run memory extraction and storage after a successful Brain Council run.
 * Non-blocking — errors are logged but do not affect the caller.
 */
export async function updateLeadMemoryAfterRun(
  leadId: number,
  leadName: string,
  conversationHistory: string,
): Promise<void> {
  try {
    const existing = await getLeadMemoryFacts(leadId);
    const existingFacts: MemoryFact[] = existing.map(f => ({
      factKey: f.factKey,
      factValue: f.factValue,
      confidence: f.confidence as "high" | "medium" | "low",
    }));
    const newFacts = await extractLeadFacts(leadName, conversationHistory, existingFacts);
    if (newFacts.length > 0) {
      await upsertLeadMemory(leadId, newFacts);
    }
  } catch (err) {
    console.error("[LeadMemory] updateLeadMemoryAfterRun failed (non-fatal):", err);
  }
}
