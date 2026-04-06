import { eq, desc, asc, gte, and, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, leads, conversations, aiState, pipelineEvents, agentAssignments, knowledgeFiles, aiTweaks, invites, webhookLogs, brainCouncilAudit } from "../drizzle/schema";
import type { InsertLead } from "../drizzle/schema";
import { ENV } from './_core/env';
import { cached, conversationCache, contextCache, generalCache, patternCache } from './cache';

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try { _db = drizzle(process.env.DATABASE_URL); } catch (error) { console.warn("[Database] Failed to connect:", error); _db = null; }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot upsert user: database not available"); return; }
  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];
    const assignNullable = (field: TextField) => { const value = user[field]; if (value === undefined) return; const normalized = value ?? null; values[field] = normalized; updateSet[field] = normalized; };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
    if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; } else if (user.openId === ENV.ownerOpenId) { values.role = 'admin'; updateSet.role = 'admin'; }
    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) { console.error("[Database] Failed to upsert user:", error); throw error; }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// --- Leads ---
export async function upsertLead(lead: InsertLead) {
  const db = await getDb();
  if (!db) return null;
  if (lead.ghlContactId) {
    const existing = await db.select().from(leads).where(eq(leads.ghlContactId, lead.ghlContactId)).limit(1);
    if (existing.length > 0) {
      const updateFields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(lead)) { if (v !== undefined && k !== "id" && k !== "ghlContactId") updateFields[k] = v; }
      if (Object.keys(updateFields).length > 0) await db.update(leads).set(updateFields).where(eq(leads.ghlContactId, lead.ghlContactId));
      return existing[0];
    }
  }
  const result = await db.insert(leads).values(lead);
  return { id: result[0].insertId, ...lead };
}

export async function getLeadById(id: number) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(leads).where(eq(leads.id, id)).limit(1);
  return result[0] || null;
}

export async function getLeadByGhlContactId(ghlContactId: string) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(leads).where(eq(leads.ghlContactId, ghlContactId)).limit(1);
  return result[0] || null;
}

export async function getHotLeads(minScore = 80) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(leads).where(gte(leads.opportunityScore, minScore)).orderBy(desc(leads.opportunityScore));
}

export async function getAllLeads(limit = 100) {
  const db = await getDb();
  if (!db) return [];
  // Sort by nextFollowUpAt ASC — next lead to contact is always at the top
  // Leads with null nextFollowUpAt come last (no scheduled outreach)
  return db.select().from(leads).orderBy(asc(leads.nextFollowUpAt), desc(leads.updatedAt)).limit(limit);
}

export async function getLeadsDueForFollowUp() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(leads).where(and(sql`${leads.nextFollowUpAt} <= NOW()`, eq(leads.humanTakeover, 0)));
}

export async function updateLeadScore(leadId: number, score: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(leads).set({ opportunityScore: score }).where(eq(leads.id, leadId));
}

export async function updateLeadFields(leadId: number, fields: Partial<InsertLead>) {
  const db = await getDb();
  if (!db) return;
  await db.update(leads).set(fields).where(eq(leads.id, leadId));
}

// --- Conversations ---
export async function addConversation(data: { leadId: number; channel?: string; direction: "inbound" | "outbound"; messageBody?: string; senderType: "ai" | "human" | "lead"; senderName?: string; ghlMessageId?: string; }) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(conversations).values(data);
  // Invalidate conversation cache for this lead
  conversationCache.invalidatePrefix(`conv`);
  return { id: result[0].insertId, ...data };
}

export async function getConversationHistory(leadId: number, limit = 50) {
  return cached(conversationCache, `convH:${leadId}:${limit}`, async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(conversations).where(eq(conversations.leadId, leadId)).orderBy(desc(conversations.timestamp)).limit(limit);
  });
}

// --- Dedup: count recent AI outbound messages within a time window ---
export async function getRecentAiOutboundCount(leadId: number, withinMinutes: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000);
  const result = await db.select({ count: sql<number>`count(*)` }).from(conversations)
    .where(and(
      eq(conversations.leadId, leadId),
      eq(conversations.direction, "outbound"),
      eq(conversations.senderType, "ai"),
      gte(conversations.timestamp, cutoff)
    ));
  return result[0]?.count || 0;
}

// --- AI State ---
export async function upsertAiState(leadId: number, state: Partial<typeof aiState.$inferInsert>) {
  const db = await getDb();
  if (!db) return;
  const existing = await db.select().from(aiState).where(eq(aiState.leadId, leadId)).limit(1);
  if (existing.length > 0) { await db.update(aiState).set(state).where(eq(aiState.leadId, leadId)); }
  else { await db.insert(aiState).values({ leadId, ...state }); }
  // Invalidate AI state cache for this lead
  contextCache.invalidate(`aiState:${leadId}`);
  contextCache.invalidate(`state:${leadId}`);
}

export async function getAiState(leadId: number) {
  return cached(contextCache, `aiState:${leadId}`, async () => {
    const db = await getDb();
    if (!db) return null;
    const result = await db.select().from(aiState).where(eq(aiState.leadId, leadId)).limit(1);
    return result[0] || null;
  });
}

// --- Pipeline Events ---
export async function addPipelineEvent(data: { leadId: number; fromStage?: string; toStage: string; triggeredBy: "ai" | "human" | "webhook"; metadata?: unknown; }) {
  const db = await getDb();
  if (!db) return;
  await db.insert(pipelineEvents).values(data);
}

export async function getPipelineEvents(leadId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(pipelineEvents).where(eq(pipelineEvents.leadId, leadId)).orderBy(desc(pipelineEvents.timestamp));
}

export async function getPipelineStats() {
  return cached(generalCache, `pipeline:stats`, async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ stage: leads.pipelineStage, count: sql<number>`count(*)`, totalValue: sql<string>`COALESCE(SUM(${leads.pipelineValue}), 0)` }).from(leads).groupBy(leads.pipelineStage);
  }, 3 * 60 * 1000);
}

// --- Agent Assignments ---
export async function addAgentAssignment(data: { leadId: number; agentName: string; assignmentReason?: string; }) {
  const db = await getDb();
  if (!db) return;
  await db.insert(agentAssignments).values(data);
  await db.update(leads).set({ assignedAgent: data.agentName }).where(eq(leads.id, data.leadId));
}

export async function getAgentWorkload() {
  return cached(generalCache, `agent:workload`, async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ agent: leads.assignedAgent, count: sql<number>`count(*)` }).from(leads).where(sql`${leads.assignedAgent} IS NOT NULL`).groupBy(leads.assignedAgent);
  }, 3 * 60 * 1000);
}

// --- Knowledge Files ---
export async function addKnowledgeFile(data: { fileName: string; fileType: string; fileUrl?: string; googleSheetUrl?: string; contentText?: string; }) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(knowledgeFiles).values(data);
  generalCache.invalidate(`kb:files`);
  generalCache.invalidate(`kb:all`);
  return { id: result[0].insertId, ...data };
}

export async function getKnowledgeFiles() {
  return cached(generalCache, `kb:files`, async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(knowledgeFiles).orderBy(desc(knowledgeFiles.createdAt));
  }, 10 * 60 * 1000);
}

export async function updateKnowledgeFile(id: number, fields: Partial<typeof knowledgeFiles.$inferInsert>) {
  const db = await getDb();
  if (!db) return;
  await db.update(knowledgeFiles).set(fields).where(eq(knowledgeFiles.id, id));
  generalCache.invalidate(`kb:files`);
  generalCache.invalidate(`kb:all`);
}

export async function deleteKnowledgeFile(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(knowledgeFiles).where(eq(knowledgeFiles.id, id));
  generalCache.invalidate(`kb:files`);
  generalCache.invalidate(`kb:all`);
}

// --- AI Tweaks ---
export async function addAiTweak(instruction: string, adminId?: number) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(aiTweaks).values({ tweakInstruction: instruction, adminId });
  generalCache.invalidate(`tweaks:list`);
  generalCache.invalidate(`tweaks:active`);
  return { id: result[0].insertId };
}

export async function getActiveTweaks() {
  return cached(generalCache, `tweaks:list`, async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(aiTweaks).where(eq(aiTweaks.status, "active")).orderBy(desc(aiTweaks.appliedAt));
  }, 5 * 60 * 1000);
}

export async function archiveTweak(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(aiTweaks).set({ status: "archived" }).where(eq(aiTweaks.id, id));
  generalCache.invalidate(`tweaks:list`);
  generalCache.invalidate(`tweaks:active`);
}

// --- AI Performance ---
export async function getAiPerformanceStats() {
  return cached(generalCache, `perf:stats`, async () => {
    const db = await getDb();
    if (!db) return { totalMessages: 0, aiMessages: 0, avgScore: 0, hotLeads: 0, totalLeads: 0 };
  const [totalMsg] = await db.select({ count: sql<number>`count(*)` }).from(conversations);
  const [aiMsg] = await db.select({ count: sql<number>`count(*)` }).from(conversations).where(eq(conversations.senderType, "ai"));
  const [scoreAvg] = await db.select({ avg: sql<number>`COALESCE(AVG(${leads.opportunityScore}), 0)` }).from(leads);
  const [hot] = await db.select({ count: sql<number>`count(*)` }).from(leads).where(gte(leads.opportunityScore, 80));
  const [total] = await db.select({ count: sql<number>`count(*)` }).from(leads);
    return { totalMessages: totalMsg.count, aiMessages: aiMsg.count, avgScore: Math.round(scoreAvg.avg), hotLeads: hot.count, totalLeads: total.count };
  }, 3 * 60 * 1000);
}

// --- Invites ---
export async function createInvite(data: { token: string; role: "admin" | "viewer"; createdBy: number; expiresAt: Date; }) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(invites).values(data);
  return { id: result[0].insertId, ...data };
}

export async function getInviteByToken(token: string) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(invites).where(eq(invites.token, token)).limit(1);
  return result[0] || null;
}

export async function markInviteUsed(token: string, userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(invites).set({ usedBy: userId, usedAt: new Date() }).where(eq(invites.token, token));
}

export async function getActiveInvites(createdBy: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(invites).where(eq(invites.createdBy, createdBy)).orderBy(desc(invites.createdAt));
}

export async function deleteInvite(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(invites).where(eq(invites.id, id));
}

export async function getAllUsers() {
  const db = await getDb();
  if (!db) return [];
  return db.select({ id: users.id, name: users.name, email: users.email, role: users.role, lastSignedIn: users.lastSignedIn, createdAt: users.createdAt }).from(users).orderBy(desc(users.createdAt));
}

export async function updateUserRole(userId: number, role: "user" | "admin" | "viewer") {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ role }).where(eq(users.id, userId));
}

export async function getRecentAiMessages(limit = 20) {
  const db = await getDb();
  if (!db) return [];
  return db.select({ id: conversations.id, leadId: conversations.leadId, channel: conversations.channel, messageBody: conversations.messageBody, senderName: conversations.senderName, timestamp: conversations.timestamp, leadName: leads.name, businessName: leads.businessName })
    .from(conversations).leftJoin(leads, eq(conversations.leadId, leads.id)).where(eq(conversations.senderType, "ai")).orderBy(desc(conversations.timestamp)).limit(limit);
}

// --- Webhook Logs ---
export async function addWebhookLog(data: {
  eventType?: string;
  detectedType?: string;
  contactId?: string;
  leadId?: number;
  payloadSummary?: string;
  action?: string;
  error?: string;
  processingMs?: number;
}) {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(webhookLogs).values(data);
  } catch (err) {
    console.error('[DB] Failed to log webhook:', err);
  }
}

export async function getRecentWebhookLogs(limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(webhookLogs).orderBy(desc(webhookLogs.receivedAt)).limit(limit);
}

// --- Brain Council Audit ---
export async function addBrainCouncilAudit(data: {
  leadId: number;
  leadName?: string;
  channel?: string;
  incomingMessage?: string;
  strategyApproach?: string;
  strategyFramework?: string;
  strategyReasoning?: string;
  strategyTier?: string;
  researchSummary?: string;
  composedMessage?: string;
  composerFromName?: string;
  qcScore?: number;
  qcApproved?: number;
  qcIssues?: string;
  qcFeedback?: string;
  wasRecomposed?: number;
  recomposeScore?: number;
  finalMessage?: string;
  messageSent?: number;
  sendError?: string;
  // Accountability fields
  blocked?: number;
  blockReason?: string;
  violationCategory?: string;
  ownerNotified?: number;
  fallbackUsed?: number;
  fallbackMessage?: string;
  // Auto-correction fields
  correctionSent?: number;
  correctionMessage?: string;
  correctionReason?: string;
}) {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(brainCouncilAudit).values(data);
  } catch (err) {
    console.error('[DB] Failed to log brain council audit:', err);
  }
}

export async function getBrainCouncilAuditLog(limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(brainCouncilAudit).orderBy(desc(brainCouncilAudit.createdAt)).limit(limit);
}

export async function getBrainCouncilAuditForLead(leadId: number, limit = 20) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(brainCouncilAudit).where(eq(brainCouncilAudit.leadId, leadId)).orderBy(desc(brainCouncilAudit.createdAt)).limit(limit);
}

// Update an audit entry with correction data
export async function updateAuditCorrection(auditId: number, data: {
  correctionSent: number;
  correctionMessage: string;
  correctionReason: string;
}) {
  const db = await getDb();
  if (!db) return;
  try {
    await db.update(brainCouncilAudit).set(data).where(eq(brainCouncilAudit.id, auditId));
  } catch (err) {
    console.error('[DB] Failed to update audit correction:', err);
  }
}

// Get recent sent messages that had violations but were still sent (for retroactive correction)
export async function getUncorrectedViolations(limit = 10) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(brainCouncilAudit)
    .where(
      and(
        eq(brainCouncilAudit.messageSent, 1),
        eq(brainCouncilAudit.correctionSent, 0),
        sql`${brainCouncilAudit.violationCategory} IS NOT NULL AND ${brainCouncilAudit.violationCategory} != ''`
      )
    )
    .orderBy(desc(brainCouncilAudit.createdAt))
    .limit(limit);
}
