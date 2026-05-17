import { eq, desc, asc, gte, lte, and, or, ne, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, leads, conversations, aiState, pipelineEvents, agentAssignments, knowledgeFiles, aiTweaks, invites, webhookLogs, brainCouncilAudit, systemSettings, hallOfFame, channelPerformance, seasonalCampaigns, postDeliverySequences, messageOutcomes, deferredResponses, quotes, segmentWeights } from "../drizzle/schema";
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
/**
 * Atomic upsert: INSERT ... ON DUPLICATE KEY UPDATE.
 * Uses the UNIQUE index on ghlContactId to prevent race-condition duplicates.
 * When two webhooks fire simultaneously for the same contact, the DB enforces
 * uniqueness — the second INSERT becomes an UPDATE instead of a duplicate row.
 *
 * Returns the lead record (existing or newly created).
 */
export async function upsertLead(lead: InsertLead) {
  const db = await getDb();
  if (!db) return null;

  // Build the update set: all non-undefined fields except id and ghlContactId.
  // For ON DUPLICATE KEY UPDATE, we only overwrite fields that have real values
  // (not null/undefined) to avoid clobbering existing data with blanks.
  const updateFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(lead)) {
    if (v !== undefined && v !== null && k !== "id" && k !== "ghlContactId") {
      updateFields[k] = v;
    }
  }

  if (lead.ghlContactId) {
    // ATOMIC UPSERT: INSERT or UPDATE in a single statement.
    // If ghlContactId already exists (UNIQUE constraint), MySQL updates the row.
    // If it doesn't exist, MySQL inserts a new row.
    // This eliminates the SELECT→INSERT race condition entirely.
    await db.insert(leads).values(lead).onDuplicateKeyUpdate({
      set: Object.keys(updateFields).length > 0
        ? updateFields
        : { updatedAt: sql`NOW()` }, // Must set something; touch updatedAt as no-op
    });

    // Read back the canonical row (whether it was just inserted or updated)
    const result = await db.select().from(leads).where(eq(leads.ghlContactId, lead.ghlContactId)).limit(1);
    return result[0] || null;
  }

  // No ghlContactId — plain insert (rare edge case)
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

/**
 * Fix 12: Find an existing lead by email or phone (for dedup when GHL sends different contact IDs
 * for the same person). Returns the OLDEST matching lead (lowest ID) to ensure we always merge
 * into the canonical record.
 *
 * Excludes the given ghlContactId so we only find leads with a DIFFERENT GHL contact ID
 * (i.e., the duplicate scenario).
 */
export async function findExistingLeadByIdentity(
  email: string | null | undefined,
  phone: string | null | undefined,
  excludeGhlContactId: string,
): Promise<{ id: number; ghlContactId: string | null } | null> {
  const db = await getDb();
  if (!db) return null;
  if (!email && !phone) return null;

  const conditions = [];
  if (email) {
    conditions.push(sql`${leads.email} = ${email}`);
  }
  if (phone) {
    conditions.push(sql`${leads.phone} = ${phone}`);
  }

  const result = await db.select({
    id: leads.id,
    ghlContactId: leads.ghlContactId,
  }).from(leads).where(
    and(
      or(...conditions),
      sql`${leads.ghlContactId} != ${excludeGhlContactId}`,
    )
  ).orderBy(asc(leads.id)).limit(1);

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
  return db.select().from(leads).where(and(
    sql`${leads.nextFollowUpAt} <= NOW()`,
    eq(leads.humanTakeover, 0),
    sql`COALESCE(${leads.pipelineStage}, 'new_lead') NOT IN ('not_qualified', 'lost')`,
    // HARD GATE 1 — Source-based: Never send AI outreach to imported/transferred contacts
    // until they send an inbound message first (reactivatedFromMigration = 1).
    // Only true one-time migration sources are gated here.
    // 'ghl', 'Facebook', 'fb' are NORMAL active sources (GHL webhooks, FB forms) — NOT migrated.
    // Fix 12: Removed 'Facebook', 'ghl', 'fb' which were blocking all new GHL/FB leads.
    sql`NOT (
      COALESCE(${leads.source}, '') IN ('transferred_contact', 'r', 'n', 'bulk_import')
      AND COALESCE(${leads.reactivatedFromMigration}, 0) = 0
    )`,
    // HARD GATE 2 — Age-based: Never send AI outreach to ANY lead older than 90 days
    // that has never sent an inbound message. This is a catch-all that covers any source
    // not explicitly listed above (e.g. future import batches with new source codes).
    // A lead is considered "never replied" if there is no inbound conversation row.
    sql`NOT (
      ${leads.createdAt} < DATE_SUB(NOW(), INTERVAL 90 DAY)
      AND COALESCE(${leads.reactivatedFromMigration}, 0) = 0
      AND NOT EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.leadId = ${leads.id}
        AND c.direction = 'inbound'
      )
    )`,
  ));
}

/**
 * Returns Lost leads (non-imported) that have a valid email and are due for quarterly re-engagement.
 * Imported/transferred contacts are handled separately by getImportedContactsDueForNurture.
 * Criteria:
 *   - pipelineStage = 'lost'
 *   - NOT an imported contact (source NOT IN transferred_contact, r, n, bulk_import)
 *   - email is not null/empty
 *   - emailUnsubscribed = 0
 *   - dndEmail is null or empty (not blocked)
 *   - lastLostNurtureAt is NULL (never nurtured) OR older than 90 days
 * Max 5 per cycle to avoid GHL rate limits.
 */
export async function getLostLeadsForNurture(limit = 5) {
  const db = await getDb();
  if (!db) return [];
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  return db.select().from(leads).where(and(
    sql`COALESCE(${leads.pipelineStage}, 'new_lead') = 'lost'`,
    // Exclude imported contacts — they have their own monthly nurture path
    sql`COALESCE(${leads.source}, '') NOT IN ('transferred_contact', 'r', 'n', 'bulk_import')`,
    sql`${leads.email} IS NOT NULL AND ${leads.email} != ''`,
    eq(leads.emailUnsubscribed, 0),
    sql`(${leads.dndEmail} IS NULL OR ${leads.dndEmail} = '')`,
    sql`(${leads.lastLostNurtureAt} IS NULL OR ${leads.lastLostNurtureAt} < ${ninetyDaysAgo})`,
  )).limit(limit);
}

/**
 * Returns imported/transferred contacts due for monthly re-engagement email.
 * These contacts have never replied (reactivatedFromMigration=0) and get email-only
 * outreach once per month until they activate.
 * Criteria:
 *   - source IN ('transferred_contact', 'r', 'n', 'bulk_import')
 *   - reactivatedFromMigration = 0 (never replied)
 *   - NOT in not_qualified or lost stage
 *   - email is not null/empty
 *   - emailUnsubscribed = 0
 *   - dndEmail is null or empty
 *   - lastLostNurtureAt is NULL OR older than 30 days
 * Max 10 per cycle.
 */
export async function getImportedContactsDueForNurture(limit = 10) {
  const db = await getDb();
  if (!db) return [];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return db.select().from(leads).where(and(
    sql`COALESCE(${leads.source}, '') IN ('transferred_contact', 'r', 'n', 'bulk_import')`,
    sql`COALESCE(${leads.reactivatedFromMigration}, 0) = 0`,
    sql`COALESCE(${leads.pipelineStage}, 'new_lead') NOT IN ('not_qualified', 'lost')`,
    sql`${leads.email} IS NOT NULL AND ${leads.email} != ''`,
    eq(leads.emailUnsubscribed, 0),
    sql`(${leads.dndEmail} IS NULL OR ${leads.dndEmail} = '')`,
    sql`(${leads.lastLostNurtureAt} IS NULL OR ${leads.lastLostNurtureAt} < ${thirtyDaysAgo})`,
  )).limit(limit);
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
export async function addConversation(data: { leadId: number; channel?: string; direction: "inbound" | "outbound"; messageBody?: string; senderType: "ai" | "human" | "lead"; senderName?: string; ghlMessageId?: string; emailMessageId?: string; }) {
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

// --- Email threading: get the last email thread ID for a lead ---
/** @deprecated Use getLastEmailThreadInfo instead */
export async function getLastEmailThreadId(leadId: number): Promise<string | null> {
  const info = await getLastEmailThreadInfo(leadId);
  return info?.threadId || null;
}

/** Get the last email's thread ID and subject for reply threading.
 *  Checks BOTH outbound and inbound emails — if the lead replied to our email,
 *  their inbound reply carries the threadId we need to continue the thread. */
export async function getLastEmailThreadInfo(leadId: number): Promise<{ threadId: string; subject: string | null } | null> {
  const db = await getDb();
  if (!db) return null;
  // Check the most recent email in EITHER direction that has an emailMessageId
  const rows = await db.select({
    ghlMessageId: conversations.ghlMessageId,
    emailMessageId: conversations.emailMessageId,
    messageBody: conversations.messageBody,
    direction: conversations.direction,
  })
    .from(conversations)
    .where(and(eq(conversations.leadId, leadId), eq(conversations.channel, "Email")))
    .orderBy(desc(conversations.timestamp))
    .limit(5);
  if (!rows.length) return null;
  // Find the first row with a usable threadId (prefer emailMessageId, fallback to ghlMessageId)
  for (const row of rows) {
    const threadId = row.emailMessageId || row.ghlMessageId || null;
    if (!threadId) continue;
    // Extract subject from message body if it starts with "Subject: ..."
    let subject: string | null = null;
    const body = row.messageBody || "";
    const subjectMatch = body.match(/^Subject:\s*(.+?)\n/i);
    if (subjectMatch) {
      subject = subjectMatch[1].trim();
    }
    return { threadId, subject };
  }
  return null;
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
  // Only return real invited team members:
  // - Must have role admin or viewer (not default 'user')
  // - Must NOT be the owner account
  // - Must have at least a name OR email (not a nameless/emailless ghost)
  return db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, lastSignedIn: users.lastSignedIn, createdAt: users.createdAt })
    .from(users)
    .where(
      and(
        or(eq(users.role, 'admin'), eq(users.role, 'viewer')),
        ne(users.openId, ENV.ownerOpenId),
        // Exclude ghost accounts that have no name AND no email
        or(
          sql`${users.name} IS NOT NULL AND ${users.name} != ''`,
          sql`${users.email} IS NOT NULL AND ${users.email} != ''`
        )
      )
    )
    .orderBy(desc(users.createdAt));
}

/**
 * Purge ghost accounts: users who signed in via OAuth but have no name AND no email.
 * These are anonymous sign-ins that were never properly invited or onboarded.
 * The owner account is always protected regardless.
 */
export async function purgeGhostUsers(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  // A ghost account has: no name (null or empty) AND no email (null or empty) AND is not the owner
  const ghostCondition = and(
    ne(users.openId, ENV.ownerOpenId),
    or(
      isNull(users.name),
      sql`${users.name} = ''`
    ),
    or(
      isNull(users.email),
      sql`${users.email} = ''`
    )
  );
  const [countRow] = await db
    .select({ cnt: sql<number>`COUNT(*)` })
    .from(users)
    .where(ghostCondition);
  const count = countRow?.cnt ?? 0;
  if (count > 0) {
    await db.delete(users).where(ghostCondition);
  }
  return count;
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
  // Phase 4: Self-Learning metadata
  experimentId?: string;
  variant?: string;
  persona?: string;
  // Module 1: Conversation Stage Detection
  conversationStage?: string;
  // Module 4: Multi-Agent Deliberation
  deliberationUsed?: number;
  deliberationNote?: string;
  // Module 2B: Expert Panel Scoring
  expertPanelBrandScore?: number | null;
  expertPanelConversionScore?: number | null;
  expertPanelComplianceScore?: number | null;
  expertPanelCompositeScore?: number | null;
  expertPanelNotes?: string | null;
  // Module 3A: Skill Catalog
  skillUsed?: string | null;
  // Fine-tuning A/B tracking
  modelUsed?: string | null;
  fineTuningJobId?: number | null;
  // Email subject tracking
  emailSubject?: string;
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

/**
 * Get the last N OUTREACH frameworks used for a lead (excludes DIRECT_RESPONSE and VALUE_FIRST).
 * Used by the diversity enforcement engine to detect framework overuse.
 * Only counts messages that were actually sent (messageSent=1).
 */
export async function getRecentOutreachFrameworks(leadId: number, limit = 5): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const RESPONSIVE = new Set(['DIRECT_RESPONSE', 'VALUE_FIRST']);
  // Fetch extra to account for responsive messages interspersed
  const rows = await db.select({ framework: brainCouncilAudit.strategyFramework })
    .from(brainCouncilAudit)
    .where(and(
      eq(brainCouncilAudit.leadId, leadId),
      eq(brainCouncilAudit.messageSent, 1)
    ))
    .orderBy(desc(brainCouncilAudit.createdAt))
    .limit(limit * 4); // fetch extra to filter out responsive messages
  return rows
    .map(r => r.framework)
    .filter((f): f is string => !!f && !RESPONSIVE.has(f))
    .slice(0, limit);
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
const BRAIN_COUNCIL_LOCK_TTL_SECONDS = 120; // Phase 0: Reduced from 300→120s to match orchestrator

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
// APPOINTMENT CREATION LOCK
// Prevents race condition where contact webhook + message webhook
// both fire simultaneously and each create a duplicate appointment.
// Lock expires after 30 seconds — covers worst-case GHL API latency.
// ============================================================
const APPOINTMENT_LOCK_TTL_SECONDS = 30;

/**
 * Atomically acquire the appointment-creation lock for a lead.
 * Returns true if the lock was acquired (caller may proceed).
 * Returns false if another process already holds the lock (skip creation).
 * Also returns false if the lead already has an appointmentId set.
 */
export async function acquireAppointmentLock(leadId: number): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return true; // fail open if DB unavailable
    // Atomic: only succeeds if no lock AND no existing appointmentId
    const result = await db.execute(
      sql`UPDATE leads SET appointmentCreatingAt = NOW()
          WHERE id = ${leadId}
          AND appointmentId IS NULL
          AND (appointmentCreatingAt IS NULL OR appointmentCreatingAt < DATE_SUB(NOW(), INTERVAL ${APPOINTMENT_LOCK_TTL_SECONDS} SECOND))`
    );
    const affectedRows = (result as any)[0]?.affectedRows ?? (result as any).affectedRows ?? 0;
    return affectedRows > 0;
  } catch (err) {
    console.error('[DB/ApptLock] acquireAppointmentLock error (fail CLOSED):', err);
    return false;
  }
}

export async function releaseAppointmentLock(leadId: number): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.execute(sql`UPDATE leads SET appointmentCreatingAt = NULL WHERE id = ${leadId}`);
  } catch (err) {
    console.error('[DB/ApptLock] releaseAppointmentLock error:', err);
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

// ============================================================
// HALL OF FAME — Winning messages that got replies / conversions
// ============================================================

export async function promoteToHallOfFame(data: {
  auditId: number;
  leadId: number;
  message: string;
  framework: string;
  approach?: string;
  channel?: string;
  segment?: string;
  persona?: string;
  replyMinutes?: number;
  replySentiment?: string;
  stageAdvanced?: number;
  converted?: number;
  pipelineValue?: number;
  promotionReason: string;
}) {
  const db = await getDb();
  if (!db) return null;
  // Avoid duplicate promotions for the same audit entry
  const existing = await db.select({ id: hallOfFame.id })
    .from(hallOfFame)
    .where(eq(hallOfFame.auditId, data.auditId))
    .limit(1);
  if (existing.length > 0) return existing[0];
  const result = await db.insert(hallOfFame).values(data);
  // Invalidate few-shot cache so new examples are picked up immediately
  try { const { invalidateFewShotCache } = await import("./few-shot-retrieval"); invalidateFewShotCache(); } catch {}
  return { id: result[0].insertId };
}

export async function getHallOfFameExamples(opts: {
  framework?: string;
  channel?: string;
  segment?: string;
  persona?: string;
  limit?: number;
}): Promise<Array<{ message: string; framework: string; channel: string | null; segment: string | null; promotionReason: string }>> {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (opts.framework) conditions.push(eq(hallOfFame.framework, opts.framework));
  if (opts.channel) conditions.push(eq(hallOfFame.channel, opts.channel));
  if (opts.segment) conditions.push(eq(hallOfFame.segment, opts.segment));
  if (opts.persona) conditions.push(eq(hallOfFame.persona, opts.persona));
  const rows = await db.select({
    message: hallOfFame.message,
    framework: hallOfFame.framework,
    channel: hallOfFame.channel,
    segment: hallOfFame.segment,
    promotionReason: hallOfFame.promotionReason,
  })
    .from(hallOfFame)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(hallOfFame.createdAt))
    .limit(opts.limit || 5);
  return rows;
}

// ============================================================
// CHANNEL PERFORMANCE — Per-lead channel success tracking
// ============================================================

export async function upsertChannelPerformance(leadId: number, channel: string, data: {
  sent?: boolean;
  replied?: boolean;
  replyMinutes?: number;
  positiveSentiment?: boolean;
  stageAdvanced?: boolean;
}) {
  const db = await getDb();
  if (!db) return;
  const existing = await db.select()
    .from(channelPerformance)
    .where(and(eq(channelPerformance.leadId, leadId), eq(channelPerformance.channel, channel)))
    .limit(1);
  if (existing.length > 0) {
    const row = existing[0];
    const updates: Record<string, any> = {};
    if (data.sent) {
      updates.messagesSent = (row.messagesSent || 0) + 1;
      updates.lastSentAt = new Date();
    }
    if (data.replied) {
      updates.repliesReceived = (row.repliesReceived || 0) + 1;
      updates.lastReplyAt = new Date();
      if (data.replyMinutes != null) {
        const prevTotal = (row.avgReplyMinutes || 0) * (row.repliesReceived || 0);
        updates.avgReplyMinutes = Math.round((prevTotal + data.replyMinutes) / ((row.repliesReceived || 0) + 1));
      }
    }
    if (data.positiveSentiment) updates.positiveReplies = (row.positiveReplies || 0) + 1;
    if (data.stageAdvanced) updates.stageAdvances = (row.stageAdvances || 0) + 1;
    if (Object.keys(updates).length > 0) {
      await db.update(channelPerformance).set(updates)
        .where(and(eq(channelPerformance.leadId, leadId), eq(channelPerformance.channel, channel)));
    }
  } else {
    await db.insert(channelPerformance).values({
      leadId,
      channel,
      messagesSent: data.sent ? 1 : 0,
      repliesReceived: data.replied ? 1 : 0,
      avgReplyMinutes: data.replyMinutes || null,
      positiveReplies: data.positiveSentiment ? 1 : 0,
      stageAdvances: data.stageAdvanced ? 1 : 0,
      lastSentAt: data.sent ? new Date() : null,
      lastReplyAt: data.replied ? new Date() : null,
    });
  }
}

export async function getBestChannelForLead(leadId: number): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select({
    channel: channelPerformance.channel,
    replies: channelPerformance.repliesReceived,
    positives: channelPerformance.positiveReplies,
    sent: channelPerformance.messagesSent,
    avgReply: channelPerformance.avgReplyMinutes,
  })
    .from(channelPerformance)
    .where(eq(channelPerformance.leadId, leadId));
  if (rows.length === 0) return null;
  // Score: 3 * replies + 5 * positives + 2 * (1 if avgReply < 60 min) - 0.5 * sent-without-reply
  const scored = rows.map(r => ({
    channel: r.channel,
    score: 3 * (r.replies || 0) + 5 * (r.positives || 0) + ((r.avgReply && r.avgReply < 60) ? 2 : 0) - 0.5 * Math.max(0, (r.sent || 0) - (r.replies || 0)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].score > 0 ? scored[0].channel : null;
}

// ============================================================
// POST-DELIVERY SEQUENCES
// ============================================================

export async function createPostDeliverySequence(leadId: number, channel: string) {
  const db = await getDb();
  if (!db) return;
  // Check if sequence already exists for this lead
  const existing = await db.select({ id: postDeliverySequences.id })
    .from(postDeliverySequences)
    .where(eq(postDeliverySequences.leadId, leadId))
    .limit(1);
  if (existing.length > 0) return; // already has a sequence

  const now = Date.now();
  const STEP_TYPES = ["satisfaction_check", "review_request", "upsell_referral"] as const;
  const steps = [
    { step: 1, stepType: STEP_TYPES[0], scheduledAt: new Date(now + 3 * 24 * 60 * 60 * 1000) },  // Day 3
    { step: 2, stepType: STEP_TYPES[1], scheduledAt: new Date(now + 10 * 24 * 60 * 60 * 1000) }, // Day 10
    { step: 3, stepType: STEP_TYPES[2], scheduledAt: new Date(now + 21 * 24 * 60 * 60 * 1000) }, // Day 21
  ];
  for (const s of steps) {
    await db.insert(postDeliverySequences).values({
      leadId,
      step: s.step,
      stepType: s.stepType,
      scheduledAt: s.scheduledAt,
      channel,
      status: "pending",
    });
  }
}

export async function getDuePostDeliverySteps(limit = 20): Promise<Array<{
  id: number;
  leadId: number;
  step: number;
  stepType: string;
  channel: string | null;
}>> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({
    id: postDeliverySequences.id,
    leadId: postDeliverySequences.leadId,
    step: postDeliverySequences.step,
    stepType: postDeliverySequences.stepType,
    channel: postDeliverySequences.channel,
  })
    .from(postDeliverySequences)
    .where(and(
      eq(postDeliverySequences.status, "pending"),
      lte(postDeliverySequences.scheduledAt, new Date()),
    ))
    .orderBy(asc(postDeliverySequences.scheduledAt))
    .limit(limit);
  return rows;
}

export async function markPostDeliveryStepSent(id: number, auditId?: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(postDeliverySequences).set({
    status: "sent",
    sentAt: new Date(),
    auditId: auditId || null,
  }).where(eq(postDeliverySequences.id, id));
}

export async function markPostDeliveryStepReplied(leadId: number) {
  const db = await getDb();
  if (!db) return;
  // Mark all pending steps as "replied" — lead is active, don't need to nudge
  await db.update(postDeliverySequences).set({ status: "replied" })
    .where(and(eq(postDeliverySequences.leadId, leadId), eq(postDeliverySequences.status, "pending")));
}

// ============================================================
// SEASONAL CAMPAIGNS
// ============================================================

export async function getActiveCampaigns(): Promise<Array<{
  id: number;
  name: string;
  angle: string;
  targetSegments: any;
  maxLeadsPerDay: number | null;
  totalSent: number | null;
}>> {
  const db = await getDb();
  if (!db) return [];
  const now = new Date();
  const rows = await db.select({
    id: seasonalCampaigns.id,
    name: seasonalCampaigns.name,
    angle: seasonalCampaigns.angle,
    targetSegments: seasonalCampaigns.targetSegments,
    maxLeadsPerDay: seasonalCampaigns.maxLeadsPerDay,
    totalSent: seasonalCampaigns.totalSent,
  })
    .from(seasonalCampaigns)
    .where(and(
      eq(seasonalCampaigns.status, "active"),
      lte(seasonalCampaigns.startDate, now),
      gte(seasonalCampaigns.endDate, now),
    ));
  return rows;
}

export async function incrementCampaignSent(campaignId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(seasonalCampaigns)
    .set({ totalSent: sql`${seasonalCampaigns.totalSent} + 1` })
    .where(eq(seasonalCampaigns.id, campaignId));
}

export async function incrementCampaignReply(campaignId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(seasonalCampaigns)
    .set({ totalReplies: sql`${seasonalCampaigns.totalReplies} + 1` })
    .where(eq(seasonalCampaigns.id, campaignId));
}

// ============================================================
// HUMAN AGENT SLA — Leads in human takeover that are silent
// ============================================================

export async function getHumanTakeoverLeadsSilent(silentHours: number): Promise<Array<{
  id: number;
  name: string | null;
  assignedAgent: string | null;
  lastAgentActivityAt: Date | null;
  lastMessageAt: Date | null;
  lastSlaAlertAt: Date | null;
  ghlContactId: string | null;
  silentHours: number;
}>> {
  const db = await getDb();
  if (!db) return [];
  const cutoff = new Date(Date.now() - silentHours * 60 * 60 * 1000);
  const rows = await db.select({
    id: leads.id,
    name: leads.name,
    assignedAgent: leads.assignedAgent,
    lastAgentActivityAt: leads.lastAgentActivityAt,
    lastMessageAt: leads.lastMessageAt,
    lastSlaAlertAt: leads.lastSlaAlertAt,
    ghlContactId: leads.ghlContactId,
    humanTakeover: leads.humanTakeover,
  })
    .from(leads)
    .where(and(
      eq(leads.humanTakeover, 1),
      // Either agent hasn't acted since cutoff, or never acted
    ));
  // Filter in JS for complex date logic (business hours)
  const result: Array<{
    id: number;
    name: string | null;
    assignedAgent: string | null;
    lastAgentActivityAt: Date | null;
    lastMessageAt: Date | null;
    lastSlaAlertAt: Date | null;
    ghlContactId: string | null;
    silentHours: number;
  }> = [];
  for (const r of rows) {
    const lastActivity = r.lastAgentActivityAt || r.lastMessageAt;
    if (!lastActivity) continue;
    const hoursSilent = (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60);
    if (hoursSilent >= silentHours) {
      result.push({
        id: r.id,
        name: r.name,
        assignedAgent: r.assignedAgent,
        lastAgentActivityAt: r.lastAgentActivityAt,
        lastMessageAt: r.lastMessageAt,
        lastSlaAlertAt: r.lastSlaAlertAt ?? null,
        ghlContactId: r.ghlContactId ?? null,
        silentHours: Math.round(hoursSilent * 10) / 10,
      });
    }
  }
  return result;
}

// --- Deferred Responses (Agent-First Delay) ---

export async function insertDeferredResponse(data: {
  leadId: number;
  ghlContactId: string;
  channel: string;
  messageBody: string;
  emailSubject?: string;
  emailHtml?: string;
  fromName?: string;
  sendAt: Date;
  brainCouncilOutput?: unknown;
}) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(deferredResponses).values({
    leadId: data.leadId,
    ghlContactId: data.ghlContactId,
    channel: data.channel,
    messageBody: data.messageBody,
    emailSubject: data.emailSubject || null,
    emailHtml: data.emailHtml || null,
    fromName: data.fromName || null,
    sendAt: data.sendAt,
    brainCouncilOutput: data.brainCouncilOutput || null,
  });
  return { id: result[0].insertId };
}

export async function getPendingDeferredResponses() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(deferredResponses).where(and(
    eq(deferredResponses.status, "pending"),
    sql`${deferredResponses.sendAt} <= NOW()`,
  ));
}

export async function updateDeferredResponseStatus(id: number, status: "sent" | "cancelled", cancelReason?: string) {
  const db = await getDb();
  if (!db) return;
  await db.update(deferredResponses).set({
    status,
    cancelReason: cancelReason || null,
    processedAt: new Date(),
  }).where(eq(deferredResponses.id, id));
}

export async function hasPendingDeferredResponse(leadId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const result = await db.select({ count: sql<number>`count(*)` }).from(deferredResponses).where(and(
    eq(deferredResponses.leadId, leadId),
    eq(deferredResponses.status, "pending"),
  ));
  return (result[0]?.count || 0) > 0;
}


// ─── Phase 4: Quotes ────────────────────────────────────────────────────────
import type { InsertQuoteRow, QuoteRow } from "../drizzle/schema";

export async function insertQuote(data: Omit<InsertQuoteRow, "id" | "createdAt" | "sentAt">): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(quotes).values(data);
  return result[0].insertId;
}

export async function getQuotesByLead(leadId: number, limit = 20): Promise<QuoteRow[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(quotes)
    .where(eq(quotes.leadId, leadId))
    .orderBy(desc(quotes.createdAt))
    .limit(limit);
}

export async function getLatestQuoteForLead(leadId: number): Promise<QuoteRow | null> {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(quotes)
    .where(eq(quotes.leadId, leadId))
    .orderBy(desc(quotes.createdAt))
    .limit(1);
  return result[0] || null;
}

export async function updateQuoteStatus(quoteId: number, status: "approved" | "declined" | "expired", timestamp?: Date): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const updates: Record<string, unknown> = { status };
  if (status === "approved") updates.approvedAt = timestamp || new Date();
  if (status === "declined") updates.declinedAt = timestamp || new Date();
  await db.update(quotes).set(updates).where(eq(quotes.id, quoteId));
}

export async function expireOldQuotes(daysOld = 30): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  const result = await db.update(quotes)
    .set({ status: "expired" })
    .where(and(
      eq(quotes.status, "sent"),
      lte(quotes.sentAt, cutoff),
    ));
  return (result as any)[0]?.affectedRows || 0;
}

// ─── Phase 5: Segment Weights (adaptive learning) ─────────────────────────────

/**
 * Record a win or loss for a given (segment, channel, stage, approach) combo.
 * Uses INSERT...ON DUPLICATE KEY UPDATE for atomic increment.
 * Recalculates win_rate after each update.
 */
export async function recordSegmentOutcome(
  segment: string,
  channel: string,
  stage: string,
  approach: string,
  outcome: "win" | "loss"
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const winInc = outcome === "win" ? 1 : 0;
  const lossInc = outcome === "loss" ? 1 : 0;
  await db.execute(sql`
    INSERT INTO segment_weights (segment, channel, stage, approach, wins, losses, winRate)
    VALUES (${segment}, ${channel}, ${stage}, ${approach}, ${winInc}, ${lossInc}, ${winInc})
    ON DUPLICATE KEY UPDATE
      wins = wins + ${winInc},
      losses = losses + ${lossInc},
      winRate = (wins + ${winInc}) / GREATEST((wins + ${winInc}) + (losses + ${lossInc}), 1)
  `);
}

/**
 * Get top N approaches by win_rate for a given segment/channel/stage combo.
 * Only returns approaches with at least `minSamples` total outcomes (wins+losses).
 */
export async function getTopApproaches(
  segment: string,
  channel: string,
  stage: string,
  n = 3,
  minSamples = 3
): Promise<Array<{ approach: string; winRate: number; samples: number }>> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({
    approach: segmentWeights.approach,
    winRate: segmentWeights.winRate,
    wins: segmentWeights.wins,
    losses: segmentWeights.losses,
  }).from(segmentWeights).where(and(
    eq(segmentWeights.segment, segment),
    eq(segmentWeights.channel, channel),
    eq(segmentWeights.stage, stage),
    sql`(${segmentWeights.wins} + ${segmentWeights.losses}) >= ${minSamples}`,
  )).orderBy(desc(segmentWeights.winRate)).limit(n);
  return rows.map(r => ({
    approach: r.approach,
    winRate: Number(r.winRate),
    samples: r.wins + r.losses,
  }));
}

/**
 * Get bottom N approaches (to avoid) for a given segment/channel combo.
 * Returns approaches with win_rate < 0.1 and at least `minSamples` outcomes.
 */
export async function getAvoidApproaches(
  segment: string,
  channel: string,
  n = 3,
  minSamples = 3
): Promise<Array<{ approach: string; winRate: number; samples: number }>> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({
    approach: segmentWeights.approach,
    winRate: segmentWeights.winRate,
    wins: segmentWeights.wins,
    losses: segmentWeights.losses,
  }).from(segmentWeights).where(and(
    eq(segmentWeights.segment, segment),
    eq(segmentWeights.channel, channel),
    sql`(${segmentWeights.wins} + ${segmentWeights.losses}) >= ${minSamples}`,
    sql`${segmentWeights.winRate} < 0.1`,
  )).orderBy(asc(segmentWeights.winRate)).limit(n);
  return rows.map(r => ({
    approach: r.approach,
    winRate: Number(r.winRate),
    samples: r.wins + r.losses,
  }));
}
