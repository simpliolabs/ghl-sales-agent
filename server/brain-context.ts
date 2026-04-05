/**
 * BRAIN CONTEXT — Builds shared context for all brains from lead data
 */

import { getDb } from "./db";
import { aiState, aiTweaks, knowledgeFiles, conversations, leads } from "../drizzle/schema";
import { eq, desc } from "drizzle-orm";
import type { LeadContext } from "./brain-types";

export async function buildLeadContext(leadId: number): Promise<LeadContext> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [leadRows] = await Promise.all([
    db.select().from(leads).where(eq(leads.id, leadId)).limit(1),
  ]);
  const lead = leadRows[0];
  if (!lead) throw new Error("Lead not found");

  const convHistory = await db.select().from(conversations)
    .where(eq(conversations.leadId, leadId))
    .orderBy(desc(conversations.timestamp))
    .limit(30);

  const stateRows = await db.select().from(aiState).where(eq(aiState.leadId, leadId)).limit(1);
  const state = stateRows[0];

  const tweaks = await db.select().from(aiTweaks).where(eq(aiTweaks.status, "active"));
  const tweakInstructions = tweaks.map(t => t.tweakInstruction).join("\n");

  const kbFiles = await db.select().from(knowledgeFiles);
  const kbContent = kbFiles.map(f => `[${f.fileName}]: ${f.contentText || ""}`).join("\n\n");

  const historyStr = convHistory.reverse().map(c =>
    `[${c.senderType}/${c.channel}] ${c.messageBody}`
  ).join("\n");

  const priorAiMessages = convHistory.filter(c => c.senderType === "ai" && c.direction === "outbound");
  const priorOutbound = convHistory.filter(c => c.direction === "outbound");
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
  };
}
