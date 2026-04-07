import { eq, desc, asc, gte, and, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, leads, conversations, aiState, pipelineEvents, agentAssignments, knowledgeFiles, aiTweaks, invites, webhookLogs, brainCouncilAudit, systemSettings } from "../drizzle/schema";
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

// ============================================================
// DB-LEVEL BRAIN COUNCIL PROCESSING LOCK
// Prevents concurrent Brain Council runs for the same lead
// across webhook handler, fast scanner, follow-up trigger, and self-review.
// Uses atomic UPDATE WHERE processingLockedAt IS NULL OR expired.
// Lock expires after 90 seconds to prevent permanent deadlocks.
// ============================================================
const BRAIN_COUNCIL_LOCK_TTL_SECONDS = 300; // 5 minutes — covers worst-case 4-LLM-call pipeline

export async function acquireDbBrainCouncilLock(leadId: number): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return true; // fail open if DB unavailable
    // Atomic acquire: only succeeds if no lock or lock expired
    const result = await db.execute(
      sql`UPDATE leads SET processingLockedAt = NOW() WHERE id = ${leadId} AND (processingLockedAt IS NULL OR processingLockedAt < DATE_SUB(NOW(), INTERVAL ${BRAIN_COUNCIL_LOCK_TTL_SECONDS} SECOND))`
    );
    const affectedRows = (result as any)[0]?.affectedRows ?? (result as any).affectedRows ?? 0;
    return affectedRows > 0;
  } catch (err) {
    console.error('[DB/Lock] acquireDbBrainCouncilLock error (fail CLOSED):', err);
    return false; // fail CLOSED — better to skip one message than risk a duplicate
  }
}

export async function releaseDbBrainCouncilLock(leadId: number): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.execute(sql`UPDATE leads SET processingLockedAt = NULL WHERE id = ${leadId}`);
  } catch (err) {
    console.error('[DB/Lock] releaseDbBrainCouncilLock error:', err);
  }
}

// ============================================================
// SYSTEM SETTINGS — key-value store for global toggles
// ============================================================
export async function getSystemSetting(key: string): Promise<string | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const rows = await db.select({ value: systemSettings.settingValue })
      .from(systemSettings)
      .where(eq(systemSettings.settingKey, key))
      .limit(1);
    if (!rows || rows.length === 0) return null;
    return rows[0].value ?? null;
  } catch (err) {
    console.error('[DB/Settings] getSystemSetting error:', err);
    return null;
  }
}

export async function setSystemSetting(key: string, value: string, updatedBy = 'system'): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.execute(
      sql`INSERT INTO \`system_settings\` (\`key\`, \`value\`, \`updatedBy\`) VALUES (${key}, ${value}, ${updatedBy}) ON DUPLICATE KEY UPDATE \`value\` = ${value}, \`updatedBy\` = ${updatedBy}`
    );
  } catch (err) {
    console.error('[DB/Settings] setSystemSetting error:', err);
  }
}

// Returns true if AI is offline (should NOT send messages)
export async function isAiOffline(): Promise<boolean> {
  const val = await getSystemSetting('ai_online');
  // Default is online (val === null means never set = online)
  return val === '0';
}

// ============================================================
// GHL DND (Do Not Disturb) SYNC
// Extracts per-channel DND status from GHL contact data and
// persists it in the leads table. Used by pre-flight checks
// to block sends on DND channels BEFORE wasting LLM calls.
// ============================================================

/**
 * Maps GHL dndSettings object to per-channel DND status strings.
 * GHL dndSettings format:
 * {
 *   "SMS": { "status": "active"|"permanent"|"inactive", "code": "STOP_KEYWORD"|"unsubscribe"|null },
 *   "Email": { "status": "active"|"permanent"|"inactive", "code": "unsubscribe"|null },
 *   ...
 * }
 * Returns null for channels that are not blocked.
 */
function extractDndStatus(dndSettings: Record<string, any>): {
  dndSms: string | null;
  dndEmail: string | null;
  dndFb: string | null;
  dndWhatsapp: string | null;
  dndGmb: string | null;
} {
  const result = { dndSms: null as string | null, dndEmail: null as string | null, dndFb: null as string | null, dndWhatsapp: null as string | null, dndGmb: null as string | null };
  if (!dndSettings || typeof dndSettings !== 'object') return result;

  const channelMap: Record<string, keyof typeof result> = {
    'SMS': 'dndSms',
    'Email': 'dndEmail',
    'FB': 'dndFb',
    'GMB': 'dndGmb',
    'WhatsApp': 'dndWhatsapp',
  };

  for (const [ghlChannel, field] of Object.entries(channelMap)) {
    const setting = dndSettings[ghlChannel];
    if (setting && typeof setting === 'object') {
      const status = (setting.status || '').toLowerCase();
      if (status === 'active' || status === 'permanent') {
        const code = setting.code || setting.message || '';
        result[field] = `${status}/${code}`.substring(0, 32);
      }
    }
  }
  return result;
}

/**
 * Syncs GHL DND settings for a lead. Call this during contact enrichment
 * (webhook-contact.ts) and during the backfill script.
 * @param leadId - Our internal lead ID
 * @param ghlContact - The raw GHL contact object (must have dndSettings)
 */
export async function syncGhlDnd(leadId: number, ghlContact: Record<string, any>): Promise<void> {
  const dndSettings = ghlContact?.dndSettings;
  if (!dndSettings || typeof dndSettings !== 'object') return;

  const dndFields = extractDndStatus(dndSettings);
  const hasAnyDnd = Object.values(dndFields).some(v => v !== null);

  const db = await getDb();
  if (!db) return;

  try {
    await db.update(leads)
      .set({ ...dndFields, dndSyncedAt: new Date() })
      .where(eq(leads.id, leadId));

    if (hasAnyDnd) {
      const blocked = Object.entries(dndFields)
        .filter(([_, v]) => v !== null)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      console.log(`[DND-Sync] Lead ${leadId}: DND active on channels: ${blocked}`);
    }
  } catch (err) {
    console.error(`[DND-Sync] Failed to sync DND for lead ${leadId}:`, err);
  }
}

/**
 * Checks if a specific channel is DND-blocked for a lead.
 * Returns true if the channel is blocked (should NOT send).
 * @param leadId - Our internal lead ID
 * @param channel - The channel to check: "SMS", "Email", "FB", "IG", "WhatsApp"
 */
export async function isChannelDnd(leadId: number, channel: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false; // fail open if DB unavailable — other gates will catch

  try {
    const [lead] = await db.select({
      dndSms: leads.dndSms,
      dndEmail: leads.dndEmail,
      dndFb: leads.dndFb,
      dndWhatsapp: leads.dndWhatsapp,
    })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);

    if (!lead) return false;

    const ch = channel.toUpperCase();
    if (ch === 'SMS' && lead.dndSms) return true;
    if (ch === 'EMAIL' && lead.dndEmail) return true;
    if ((ch === 'FB' || ch === 'IG') && lead.dndFb) return true; // IG uses FB Messenger in GHL
    if (ch === 'WHATSAPP' && lead.dndWhatsapp) return true;
    return false;
  } catch (err) {
    console.error(`[DND-Check] isChannelDnd error for lead ${leadId}:`, err);
    return false; // fail open — other gates will catch
  }
}

/**
 * Gets all DND-blocked channels for a lead.
 * Returns an array of blocked channel names, e.g. ["SMS", "Email"].
 * Used by the Brain Council to know which channels are available.
 */
export async function getBlockedChannels(leadId: number): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];

  try {
    const [lead] = await db.select({
      dndSms: leads.dndSms,
      dndEmail: leads.dndEmail,
      dndFb: leads.dndFb,
      dndWhatsapp: leads.dndWhatsapp,
    })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);

    if (!lead) return [];

    const blocked: string[] = [];
    if (lead.dndSms) blocked.push('SMS');
    if (lead.dndEmail) blocked.push('Email');
    if (lead.dndFb) blocked.push('FB', 'IG');
    if (lead.dndWhatsapp) blocked.push('WhatsApp');
    return blocked;
  } catch (err) {
    console.error(`[DND-Check] getBlockedChannels error for lead ${leadId}:`, err);
    return [];
  }
}
