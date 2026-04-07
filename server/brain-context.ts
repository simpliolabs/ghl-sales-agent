/**
 * BRAIN CONTEXT — Builds shared context for all brains from lead data
 * Uses TTL caching to avoid redundant DB queries across brain modules.
 */

import { getDb, getConversationHistory } from "./db";
import { aiState, aiTweaks, knowledgeFiles, leads } from "../drizzle/schema";
import { eq, type InferSelectModel } from "drizzle-orm";
import type { LeadContext } from "./brain-types";
import { cached, contextCache, conversationCache, generalCache } from "./cache";

import { conversations } from "../drizzle/schema";
type ConversationRow = InferSelectModel<typeof conversations>;
type AiStateRow = InferSelectModel<typeof aiState>;
type AiTweakRow = InferSelectModel<typeof aiTweaks>;
type KnowledgeFileRow = InferSelectModel<typeof knowledgeFiles>;

export async function buildLeadContext(leadId: number): Promise<LeadContext> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [leadRows] = await Promise.all([
    db.select().from(leads).where(eq(leads.id, leadId)).limit(1),
  ]);
  const lead = leadRows[0];
  if (!lead) throw new Error("Lead not found");

  // Use canonical getConversationHistory from db.ts (cached under convH:${leadId}:30, 2 min TTL)
  // This avoids the previous cache-key mismatch where brain-context used conv:${leadId}
  // and db.ts used convH:${leadId}:${limit} — now both go through the same path.
  const convHistory = await getConversationHistory(leadId, 30) as ConversationRow[];

  // Cache AI state per lead (5 min TTL)
  const stateRows: AiStateRow[] = await cached(contextCache, `state:${leadId}`, async () =>
    db.select().from(aiState).where(eq(aiState.leadId, leadId)).limit(1)
  );
  const state = stateRows[0];

  // Cache tweaks globally (5 min TTL — rarely changes)
  const tweaks: AiTweakRow[] = await cached(generalCache, `tweaks:active`, async () =>
    db.select().from(aiTweaks).where(eq(aiTweaks.status, "active"))
  , 5 * 60 * 1000);
  const tweakInstructions = tweaks.map((t: AiTweakRow) => t.tweakInstruction).join("\n");

  // Cache knowledge base globally (10 min TTL — rarely changes)
  const kbFiles: KnowledgeFileRow[] = await cached(generalCache, `kb:all`, async () =>
    db.select().from(knowledgeFiles)
  , 10 * 60 * 1000);
  const kbContent = kbFiles.map((f: KnowledgeFileRow) => `[${f.fileName}]: ${f.contentText || ""}`).join("\n\n");

  const historyStr = convHistory.reverse().map((c: ConversationRow) =>
    `[${c.senderType}/${c.channel}] ${c.messageBody}`
  ).join("\n");

  const priorAiMessages = convHistory.filter((c: ConversationRow) => c.senderType === "ai" && c.direction === "outbound");
  const priorOutbound = convHistory.filter((c: ConversationRow) => c.direction === "outbound");
  const isFirstResponse = priorAiMessages.length === 0;

  const leadCreatedAt = lead.createdAt ? new Date(lead.createdAt).getTime() : Date.now();
  const leadAgeDays = Math.floor((Date.now() - leadCreatedAt) / (1000 * 60 * 60 * 24));
  let urgencyStage = "Day 0 (first contact)";
  if (leadAgeDays >= 30) urgencyStage = "Day 30+ (dormant)";
  else if (leadAgeDays >= 15) urgencyStage = "Day 15-30 (stale)";
  else if (leadAgeDays >= 8) urgencyStage = "Day 8-14 (cold)";
  else if (leadAgeDays >= 4) urgencyStage = "Day 4-7 (cooling)";
  else if (leadAgeDays >= 1) urgencyStage = "Day 1-3 (warm)";

  let unansweredCount = 0;
  for (const c of [...convHistory].reverse()) {
    if (c.direction === "outbound") unansweredCount++;
    else break;
  }

  // Extract lookback context from AI state and lead fields
  // The lookback engine stores analysis in state.lastResearchSummary (format: "[LOOKBACK] keyContext | Status: X | Approach: Y")
  // and lead.lastStrategyReasoning (format: "[LOOKBACK] approach | keyContext")
  let lookbackContext = "";
  const lookbackParts: string[] = [];
  if (state?.lastResearchSummary && String(state.lastResearchSummary).includes("[LOOKBACK]")) {
    lookbackParts.push(String(state.lastResearchSummary).replace("[LOOKBACK] ", ""));
  }
  if (lead.lastStrategyReasoning && String(lead.lastStrategyReasoning).includes("[LOOKBACK]")) {
    const reasoning = String(lead.lastStrategyReasoning).replace("[LOOKBACK] ", "");
    if (!lookbackParts.some(p => p.includes(reasoning))) {
      lookbackParts.push(reasoning);
    }
  }
  if (state?.sentimentTrend) {
    lookbackParts.push(`Sentiment: ${state.sentimentTrend}`);
  }
  lookbackContext = lookbackParts.length > 0 ? lookbackParts.join(" | ") : "";

  return {
    lead,
    convHistory,
    state,
    tweakInstructions,
    kbContent,
    historyStr,
    isFirstResponse,
    priorOutbound,
    leadAgeDays,
    urgencyStage,
    unansweredCount,
    lookbackContext,
  };
}

/**
 * Invalidate cached context for a lead after a new message or state change.
 * Call this after addConversation() or upsertAiState() for the same lead.
 */
export function invalidateLeadCache(leadId: number): void {
  conversationCache.invalidate(`conv:${leadId}`);
  contextCache.invalidate(`state:${leadId}`);
}

/**
 * Invalidate global caches after knowledge base or tweak changes.
 */
export function invalidateGlobalCache(): void {
  generalCache.invalidate(`tweaks:active`);
  generalCache.invalidate(`kb:all`);
}
