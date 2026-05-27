/**
 * Phase 1: Outbox Worker
 * 
 * The SINGLE path through which all outbound messages are sent.
 * All senders enqueue into the outbox table. This worker drains it.
 * 
 * Architecture:
 *   enqueueOutbox()  — called by all producers (webhook, follow-up, first-contact, nurture, etc.)
 *   drainOutbox()    — called on a timer; claims pending rows and processes them
 *   processOutboxRow() — runs input guards → Brain Council → output guards → send via GHL
 * 
 * Key guarantees:
 *   - Idempotency: UNIQUE(leadId, idemKey) prevents duplicate enqueues in the same time window
 *   - Atomic claim: FOR UPDATE SKIP LOCKED prevents two workers from processing the same row
 *   - Retry: Failed sends are retried up to 3 times with exponential backoff
 *   - Decision log: Every outbox decision is logged for audit and LoRA training
 */

import crypto from "crypto";
import { getDb, isAiOffline, getLeadById, updateLeadFields, getConversationHistory, addConversation } from "./db";
import { outbox, decisionLog } from "../drizzle/schema";
import type { OutboxRow, InsertOutboxRow } from "../drizzle/schema";
import { sql, eq } from "drizzle-orm";
import { sendMessage } from "./ghl";
import { ensureEmailSignature, formatEmailHtml } from "./webhook-helpers";
import { attemptSend, isDelivered } from "./attempt-send";
import type { BrainCouncilInput } from "./brain-types";
import { promptVersions } from "../drizzle/schema";
// Phase 1.C: v1.9 compose pipeline entry point
import { composeAndSend } from "./compose-and-send";
// Phase 5: wrong-business reference detection (commit 60c810cb, restored in PR #8 addendum)
import { checkWrongBusinessPattern } from "./wrong-biz-check";

// ─── PR#3.9: Minimum hours between AI outbound sends per lead ─────────────────
// Prevents the brain from scheduling a follow-up so soon that the dedup guard
// would immediately block it on the next drain cycle.
const MIN_NEXT_FOLLOW_UP_HOURS = 4;

// ─── Constants ───────────────────────────────────────────────────────────────
const INSTANCE_ID = `worker-${process.pid}-${Date.now().toString(36)}`;
const MAX_RETRIES = 6;
const CLAIM_BATCH_SIZE = 5;
const CLAIM_EXPIRY_MS = 120_000; // 2 min — reclaim if worker dies
const DRAIN_INTERVAL_MS = 5_000; // 5 seconds between drain cycles
const PROCESSING_TIMEOUT_MS = 60_000; // 60s — mark as failed if Brain call hangs

// ── A/B Routing: Single Brain vs Legacy Brain Council ─────────────────────────
/**
 * Decides whether to use the single brain (Phase 2) or legacy Brain Council.
 * Reads the active prompt version's abTrafficPercent from the DB.
 * If abTrafficPercent = 0 → always legacy. If 100 → always single brain.
 * Otherwise, random roll per request.
 */
async function shouldUseSingleBrain(): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return false;
    const rows = await db
      .select({ abTrafficPercent: promptVersions.abTrafficPercent })
      .from(promptVersions)
      .where(eq(promptVersions.isActive, 1))
      .orderBy(sql`createdAt DESC`)
      .limit(1);
    if (rows.length === 0) return false;
    const pct = rows[0].abTrafficPercent ?? 0;
    if (pct <= 0) return false;
    if (pct >= 100) return true;
    return Math.random() * 100 < pct;
  } catch (err) {
    console.error("[Outbox] A/B routing check failed, defaulting to legacy:", err);
    return false;
  }
}

// ─── Idempotency Key ────────────────────────────────────────────────────────
/**
 * Generate an idempotency key for a given lead + trigger combination.
 * Same lead + same trigger within the same 5-minute window = same key = deduped.
 */
export function makeIdemKey(leadId: number, triggerSource: string, windowMs = 300_000): string {
  const bucket = Math.floor(Date.now() / windowMs);
  return crypto
    .createHash("sha256")
    .update(`${leadId}:${triggerSource}:${bucket}`)
    .digest("hex")
    .slice(0, 64);
}

// ─── Enqueue ─────────────────────────────────────────────────────────────────
export interface EnqueueOpts {
  leadId: number;
  idemKey: string;
  source: InsertOutboxRow["source"];
  scheduledAt: Date;
  payload: Record<string, unknown>;
}

/**
 * Enqueue a message into the outbox. Idempotent — duplicate idemKeys for the
 * same lead are silently ignored (INSERT IGNORE on the UNIQUE index).
 */
export async function enqueueOutbox(opts: EnqueueOpts): Promise<{ enqueued: boolean; reason?: string }> {
  const db = await getDb();
  if (!db) return { enqueued: false, reason: "db_unavailable" };

  try {
    await db.execute(sql`
      INSERT IGNORE INTO outbox (leadId, idemKey, source, payload, outbox_status, scheduledAt)
      VALUES (${opts.leadId}, ${opts.idemKey}, ${opts.source}, ${JSON.stringify(opts.payload)}, 'pending', ${opts.scheduledAt})
    `);
    console.log(`[Outbox] Enqueued: lead=${opts.leadId} source=${opts.source} key=${opts.idemKey.slice(0, 12)}... scheduled=${opts.scheduledAt.toISOString()}`);
    return { enqueued: true };
  } catch (err: any) {
    // Duplicate key = already enqueued = success (idempotent)
    if (err?.code === "ER_DUP_ENTRY" || err?.errno === 1062) {
      console.log(`[Outbox] Deduped: lead=${opts.leadId} source=${opts.source} key=${opts.idemKey.slice(0, 12)}...`);
      return { enqueued: false, reason: "duplicate" };
    }
    console.error(`[Outbox] Enqueue error:`, err);
    return { enqueued: false, reason: String(err) };
  }
}

// ─── Claim ───────────────────────────────────────────────────────────────────
/**
 * Atomically claim pending outbox rows.
 * Uses a single conditional UPDATE (WHERE outbox_status = 'pending') so concurrent
 * drain cycles cannot both claim the same row — the second UPDATE finds 0 rows.
 * Also reclaims rows that were claimed but never completed (worker crash / expiry).
 */
async function claimOutboxRows(workerId: string, limit: number): Promise<OutboxRow[]> {
  const db = await getDb();
  if (!db) return [];

  const now = new Date();
  const expiry = new Date(now.getTime() - CLAIM_EXPIRY_MS);

  try {
    // Step 1a: Atomic claim of PENDING rows.
    // Single UPDATE with WHERE outbox_status = 'pending' — no separate SELECT needed.
    // Two concurrent calls cannot both claim the same row because the second UPDATE
    // finds outbox_status already = 'claimed' and matches 0 rows.
    await db.execute(sql`
      UPDATE outbox
      SET outbox_status = 'claimed', claimedBy = ${workerId}, claimedAt = ${now}
      WHERE outbox_status = 'pending'
        AND scheduledAt <= ${now}
      ORDER BY scheduledAt ASC
      LIMIT ${limit}
    `);

    // Step 1b: Reclaim expired claimed rows (worker crash / previous drain died mid-flight).
    // These use a separate UPDATE so they don't compete with the LIMIT above.
    await db.execute(sql`
      UPDATE outbox
      SET outbox_status = 'claimed', claimedBy = ${workerId}, claimedAt = ${now}
      WHERE outbox_status = 'claimed'
        AND claimedAt < ${expiry}
      ORDER BY scheduledAt ASC
      LIMIT ${limit}
    `);

    // Step 2: Fetch what we just claimed (rows where claimedBy = workerId AND status = claimed).
    // NOTE: Do NOT filter by claimedAt = now — MySQL/TiDB datetime precision can cause the exact
    // timestamp match to return 0 rows if the stored value rounds differently from the JS Date.
    // The claimedBy worker ID is the correct discriminator.
    const fetchResult = await db.execute(sql`
      SELECT * FROM outbox
      WHERE claimedBy = ${workerId}
        AND outbox_status = 'claimed'
      ORDER BY scheduledAt ASC
      LIMIT ${limit * 2}
    `);
    const fetchData = Array.isArray(fetchResult) && Array.isArray(fetchResult[0]) ? fetchResult[0] : [];
    const claimed = fetchData as unknown as OutboxRow[];

    if (claimed.length > 0) {
      console.log(`[Outbox] Claimed ${claimed.length} row(s) by ${workerId}`);
    }
    return claimed;
  } catch (err) {
    console.error(`[Outbox] Claim error:`, err);
    return [];
  }
}

// ─── Status Updates ──────────────────────────────────────────────────────────
async function markOutbox(rowId: number | bigint, status: "sent" | "failed" | "skipped", error?: string): Promise<void> {
  const db = await getDb();
  if (!db) return;

  if (status === "sent") {
    await db.execute(sql`UPDATE outbox SET outbox_status = 'sent', sentAt = NOW() WHERE id = ${Number(rowId)}`);
  } else if (error) {
    await db.execute(sql`UPDATE outbox SET outbox_status = ${status}, error = ${error.slice(0, 2000)} WHERE id = ${Number(rowId)}`);
  } else {
    await db.execute(sql`UPDATE outbox SET outbox_status = ${status} WHERE id = ${Number(rowId)}`);
  }
}

async function rescheduleOutbox(rowId: number | bigint, deferUntil: Date): Promise<void> {
  const db = await getDb();
  if (!db) return;

  await db.execute(sql`
    UPDATE outbox SET outbox_status = 'pending', claimedBy = NULL, claimedAt = NULL, scheduledAt = ${deferUntil}
    WHERE id = ${Number(rowId)}
  `);
  console.log(`[Outbox] Rescheduled row ${rowId} to ${deferUntil.toISOString()}`);
}

async function retryOutbox(row: OutboxRow): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const newRetryCount = (row.retryCount || 0) + 1;
  // Exponential backoff: 60s, 120s, 240s
  const backoffMs = 60_000 * Math.pow(2, newRetryCount - 1);
  const nextAttempt = new Date(Date.now() + backoffMs);

  await db.execute(sql`
    UPDATE outbox SET outbox_status = 'pending', claimedBy = NULL, claimedAt = NULL,
      scheduledAt = ${nextAttempt}, retryCount = ${newRetryCount}
    WHERE id = ${Number(row.id)}
  `);
  console.log(`[Outbox] Retry ${newRetryCount}/${MAX_RETRIES} for row ${row.id} — next attempt at ${nextAttempt.toISOString()}`);
}

// ─── Decision Log ────────────────────────────────────────────────────────────
export async function logDecision(opts: {
  outboxId?: number | bigint | null;
  leadId: number;
  trigger: string;
  brainReasoning?: string | null;
  promptVersion?: string | null;
  channel?: string | null;
  inputGuardResult?: string | null;
  outputGuardResult?: string | null;
  durationMs?: number | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const isBlocked = opts.outputGuardResult && opts.outputGuardResult.startsWith("block:");
  try {
    await db.insert(decisionLog).values({
      outboxId: opts.outboxId != null ? Number(opts.outboxId) : null,
      leadId: opts.leadId,
      trigger: opts.trigger,
      brainReasoning: opts.brainReasoning ?? undefined,
      promptVersion: opts.promptVersion ?? undefined,
      channel: opts.channel ?? undefined,
      inputGuardResult: opts.inputGuardResult ?? undefined,
      outputGuardResult: opts.outputGuardResult ? opts.outputGuardResult.substring(0, 255) : undefined,
      durationMs: opts.durationMs ?? undefined,
      flaggedForReview: isBlocked ? 1 : 0,
      flagReason: isBlocked ? `Output guard blocked: ${opts.outputGuardResult}`.substring(0, 255) : undefined,
    });
  } catch (err) {
    console.error(`[Outbox] Decision log error:`, err);
  }
}

// ─── Process Single Row ──────────────────────────────────────────────────────
/**
 * Process a single outbox row.
 *
 * Phase 1.C architecture:
 *   - Path A (pre-composed draftMessage): handled inline via attemptSend (unchanged)
 *   - Path B (LLM-generated): delegated to composeAndSend() which runs the full
 *     v1.9 compose pipeline (lock → coalesce → brain → applyComposeOutcome)
 *
 * composeAndSend handles all outbox state transitions for Path B.
 * Path A retains direct markOutbox calls because it bypasses the compose pipeline.
 */
export async function processOutboxRow(row: OutboxRow): Promise<void> {
  const startTime = Date.now();
  const payload = (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>;
  const leadId = row.leadId;

  try {
    // 1. Load lead
    const lead = await getLeadById(leadId);
    if (!lead) {
      await markOutbox(row.id, "skipped", "lead_not_found");
      await logDecision({ outboxId: row.id, leadId, trigger: String(payload.trigger || row.source), inputGuardResult: "block:lead_not_found", durationMs: Date.now() - startTime });
      return;
    }

    // 2. Input guards (lightweight TypeScript checks, no LLM)
    const guardResult = await runInputGuards(lead, row);
    if (guardResult.blocked) {
      await markOutbox(row.id, "skipped", guardResult.reason);
      await logDecision({ outboxId: row.id, leadId, trigger: String(payload.trigger || row.source), inputGuardResult: `block:${guardResult.reason}`, durationMs: Date.now() - startTime });
      return;
    }
    if (guardResult.deferred && guardResult.deferUntil) {
      await rescheduleOutbox(row.id, guardResult.deferUntil);
      await logDecision({ outboxId: row.id, leadId, trigger: String(payload.trigger || row.source), inputGuardResult: `defer:${guardResult.reason}`, durationMs: Date.now() - startTime });
      return;
    }

    // 3. Generate message
    const contactId = lead.ghlContactId;
    if (!contactId) {
      await markOutbox(row.id, "skipped", "no_ghl_contact_id");
      await logDecision({ outboxId: row.id, leadId, trigger: String(payload.trigger || row.source), inputGuardResult: "block:no_contact_id", durationMs: Date.now() - startTime });
      return;
    }

        if (payload.draftMessage) {
      // Path A: Pre-composed content (static nurture, correction sequences)
      // Foundation A.5: use typed attemptSend wrapper
      const channel = String(payload.channel || lead.preferredChannel || "SMS");
      const sendOpts = buildSendOpts(channel, String(payload.draftMessage), payload);
      const sendOutcomeA = await attemptSend({
        leadId,
        ghlContactId: contactId,
        channel: channel as import('./send-types').Channel,
        message: String(payload.draftMessage),
        emailSubject: sendOpts?.type === 'Email' ? (sendOpts as any).subject : undefined,
        emailHtmlBody: sendOpts?.type === 'Email' ? (sendOpts as any).html : undefined,
        fromName: (sendOpts as any)?.fromName,
        trigger: String(payload.trigger || row.source),
      });
      if (sendOutcomeA.kind === 'failed') {
        // Dead-contact case
        if (sendOutcomeA.errorType === 'contact_not_found') {
          await updateLeadFields(leadId, {
            pipelineStage: "not_qualified",
            nextFollowUpAt: new Date("2099-01-01"),
          });
          await markOutbox(row.id, "failed", "ghl_contact_deleted");
          await logDecision({
            outboxId: row.id, leadId,
            trigger: String(payload.trigger || row.source),
            inputGuardResult: "pass",
            outputGuardResult: "block:ghl_contact_deleted",
            durationMs: Date.now() - startTime,
          });
          return;
        }
        // Other failure types
        await markOutbox(row.id, "failed", sendOutcomeA.reason || sendOutcomeA.errorType || "send_failed");
        await logDecision({ outboxId: row.id, leadId, trigger: String(payload.trigger || row.source), channel, outputGuardResult: `error:${(sendOutcomeA.reason || sendOutcomeA.errorType || "send_failed").slice(0, 100)}`, durationMs: Date.now() - startTime });
        console.warn(`[Outbox] Path A send failed for lead ${leadId}: ${sendOutcomeA.errorType} - ${sendOutcomeA.reason}`);
        return;
      }
      if (sendOutcomeA.kind === 'blocked') {
        await markOutbox(row.id, "skipped", `blocked:${sendOutcomeA.reason || 'policy'}`);
        await logDecision({ outboxId: row.id, leadId, trigger: String(payload.trigger || row.source), channel, outputGuardResult: `block:${sendOutcomeA.reason}`, durationMs: Date.now() - startTime });
        return;
      }
      // delivered or phantom
      await markOutbox(row.id, "sent");
      if (sendOutcomeA.kind === 'phantom') console.warn(`[Outbox] PR#3.12: Phantom Path A send for lead ${leadId}`);
      // PR#3.9: Write conversations row so dedup guard can see this send
      await addConversation({ leadId, direction: 'outbound', senderType: 'ai', messageBody: String(payload.draftMessage), senderName: 'AI', outcome: { kind: 'delivered', messageId: isDelivered(sendOutcomeA) ? sendOutcomeA.messageId : '', channel: channel as import('./send-types').Channel, deliveredAt: new Date(), resolvedContactId: sendOutcomeA.resolvedContactId, emailMessageId: isDelivered(sendOutcomeA) ? sendOutcomeA.emailMessageId : undefined } });
      // PR#3.9: Update lastMessageAt on lead
      await updateLeadFields(leadId, { lastMessageAt: new Date() });
      await logDecision({
        outboxId: row.id, leadId,
        trigger: String(payload.trigger || row.source),
        channel,
        brainReasoning: "pre-composed draft",
        inputGuardResult: "pass",
        outputGuardResult: "pass",
        durationMs: Date.now() - startTime,
      });
      return;
    }

        // Path B: LLM-generated — v1.9 compose pipeline
    // Phase 1.C: delegate to composeAndSend which runs:
    //   acquireLeadComposeLock → checkRecentSendCoalesce → runBrainCouncil → applyComposeOutcome
    // All outbox state transitions (sent/skipped/failed) are handled inside composeAndSend.
    {
      const composeResult = await composeAndSend({
        outboxRowId: Number(row.id),
        leadId,
        source: row.source,
        payload,
      });

      // Map compose result to outbox status
      if (composeResult.status === "sent") {
        await markOutbox(row.id, "sent");
      } else if (composeResult.status === "skipped" || composeResult.status === "lock_timeout") {
        await markOutbox(row.id, "skipped", composeResult.reason);
      } else {
        // failed or compose_crash
        await markOutbox(row.id, "failed", composeResult.reason);
        if ((row.retryCount || 0) < MAX_RETRIES) {
          await retryOutbox(row);
        }
      }

      await logDecision({
        outboxId: row.id,
        leadId,
        trigger: String(payload.trigger || row.source),
        channel: composeResult.channel,
        inputGuardResult: "pass",
        outputGuardResult: composeResult.status === "sent" ? "pass" : `${composeResult.status}:${composeResult.reason || "unknown"}`,
        durationMs: composeResult.durationMs,
      });
      // Phase 5 wrong-business check — post-send detection per commit 60c810cb
      if (composeResult.status === "sent" && composeResult.message) {
        try {
          const wrongBizCheck = checkWrongBusinessPattern(composeResult.message);
          if (wrongBizCheck.matched) {
            const matchStr = composeResult.message.match(new RegExp(wrongBizCheck.pattern!, "i"))?.[0] || "unknown";
            console.warn(`[Outbox] ⚠️ POST-SEND wrong-business detected in message to lead ${leadId}: "${matchStr}"`);
            try {
              const { notifyOwner } = await import("./_core/notification");
              await notifyOwner({
                title: `⚠️ Wrong Business Reference: Lead #${leadId}`,
                content: `A sent message to lead #${leadId} references "${matchStr}" which is not Adorb Custom Tees.\n\nMessage excerpt: ${composeResult.message.substring(0, 200)}...\n\nThis was detected post-send. Please review and manually correct if needed.`,
                priority: "standard",
              });
            } catch { /* notification non-fatal */ }
          }
        } catch (wbErr) {
          console.error("[Outbox] Post-send wrong-business check error (non-fatal):", wbErr);
        }
      }
      return;
    }



  } catch (err: any) {
    // ── Dead-contact guard: GHL says contact no longer exists ─────────────
    const errStatus = err?.response?.status;
    const errBody = err?.response?.data;
    const isContactNotFound =
      errStatus === 400 &&
      typeof errBody?.message === "string" &&
      errBody.message.toLowerCase().includes("contact not found");

    if (isContactNotFound) {
      await updateLeadFields(leadId, {
        pipelineStage: "not_qualified",
        nextFollowUpAt: new Date("2099-01-01"),
      });
      await markOutbox(row.id, "failed", "ghl_contact_deleted");
      console.warn(`[Outbox] Lead ${leadId} marked not_qualified — GHL contact returned "Contact not found" (ghlContactId may be stale or deleted)`);
      await logDecision({
        outboxId: row.id, leadId,
        trigger: String(payload?.trigger || row.source),
        inputGuardResult: "pass",
        outputGuardResult: "block:ghl_contact_deleted",
        durationMs: Date.now() - startTime,
      });
      return;
    }

    console.error(`[Outbox] Error processing row ${row.id}:`, err);
    await markOutbox(row.id, "failed", String(err?.message || err));

    // Retry if under limit
    if ((row.retryCount || 0) < MAX_RETRIES) {
      await retryOutbox(row);
    }

    await logDecision({
      outboxId: row.id, leadId,
      trigger: String(payload?.trigger || row.source),
      inputGuardResult: "pass",
      outputGuardResult: `error:${String(err?.message || err).slice(0, 100)}`,
      durationMs: Date.now() - startTime,
    });
  }
}

// ─── Input Guards ────────────────────────────────────────────────────────────
interface GuardResult {
  blocked: boolean;
  deferred: boolean;
  reason?: string;
  deferUntil?: Date;
}

const DNC_KEYWORDS = [
  "stop", "unsubscribe", "opt out", "opt-out", "remove me", "do not contact",
  "don't contact", "dont contact", "take me off", "no more", "leave me alone",
  "not interested", "remove my number", "wrong number", "wrong person",
];

export async function runInputGuards(lead: any, item?: OutboxRow): Promise<GuardResult> {
  // Guard 1: AI offline
  try {
    if (await isAiOffline()) {
      return { blocked: true, deferred: false, reason: "ai_offline" };
    }
  } catch {
    return { blocked: true, deferred: false, reason: "ai_offline_check_failed" };
  }

  // Guard 2: DNC keyword scan (last 5 inbound messages)
  try {
    const recent = await getConversationHistory(lead.id, 10);
    const recentInbound = recent
      .filter((c: any) => c.direction === "inbound" && c.senderType === "lead")
      .slice(0, 5);
    for (const msg of recentInbound) {
      const body = (msg.messageBody || "").toLowerCase();
      if (DNC_KEYWORDS.some(kw => body.includes(kw))) {
        await updateLeadFields(lead.id, { humanTakeover: 1 });
        return { blocked: true, deferred: false, reason: "dnc_keyword" };
      }
    }
  } catch (err) {
    console.error(`[Outbox/Guard] DNC check error for lead ${lead.id}:`, err);
  }

  // Guard 3: humanTakeover active (and not expired)
  if (lead.humanTakeover === 1) {
    const FOUR_HOURS = 4 * 60 * 60 * 1000;
    if (lead.lastAgentActivityAt) {
      const agentAge = Date.now() - new Date(lead.lastAgentActivityAt).getTime();
      if (agentAge < FOUR_HOURS) {
        return { blocked: true, deferred: false, reason: "human_takeover" };
      }
      // Expired — auto-release
      await updateLeadFields(lead.id, { humanTakeover: 0 });
    } else {
      // No agent activity timestamp — block (permanent takeover)
      return { blocked: true, deferred: false, reason: "human_takeover_permanent" };
    }
  }

  // Guard 4: Pipeline stage terminal
  const terminalStages = ["won", "lost", "abandoned", "not_qualified"];
  if (lead.pipelineStage && terminalStages.includes(lead.pipelineStage)) {
    return { blocked: true, deferred: false, reason: `terminal_stage:${lead.pipelineStage}` };
  }

  // Guard 5: TCPA quiet hours — PR#3.13: channel-scoped, reply-exempt
  try {
    const itemPayload = item ? (typeof item.payload === "string" ? JSON.parse(item.payload) : item.payload) as Record<string, unknown> : {};
    // FIX: Read channelHint (used by follow-up-trigger and fast_scan) in addition to channel
    const channel = String(itemPayload?.channelHint || itemPayload?.channel || lead?.preferredChannel || "").toLowerCase();
    const trigger = String(itemPayload?.source || itemPayload?.trigger || "").toLowerCase();

    // PR#3.13: Inbound replies on any channel are exempt from TCPA
    // FIX: Stale replies (>30 min old) lose their reply exemption — a 6-hour-old
    // "reply" is no longer timely and must respect TCPA quiet hours.
    const REPLY_TRIGGERS = ["inbound_reply", "fast_scan", "message_received", "reply"];
    const isReplyTrigger = REPLY_TRIGGERS.some(t => trigger.includes(t));
    const STALE_REPLY_MS = 30 * 60 * 1000; // 30 minutes
    const itemAge = item?.scheduledAt ? Date.now() - new Date(item.scheduledAt).getTime() : 0;
    const isReply = isReplyTrigger && itemAge < STALE_REPLY_MS;

    // PR#3.13: Only SMS/WhatsApp are TCPA-covered channels
    const isTcpaCovered = (channel === "sms" || channel === "whatsapp");

    if (isTcpaCovered && !isReply) {
      const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
      const hour = etNow.getHours();
      // TCPA quiet hours: 9pm-9am ET (matches industry standard, aligns with other guards)
      if (hour >= 21 || hour < 9) {
        const next9am = new Date(etNow);
        if (hour >= 21) next9am.setDate(next9am.getDate() + 1);
        next9am.setHours(9, 0, 0, 0);
        console.log(`[OutboxWorker] PR#3.13: TCPA quiet hours — deferring ${channel} outbox ${item?.id || "?"} until ${next9am.toISOString()}`);
        return { blocked: false, deferred: true, reason: "tcpa_quiet_hours", deferUntil: next9am };
      }
    }

    // PR#3.13: Non-TCPA channels (IG/FB/Email) get human-feel deferral only
    // for cold outreach, never for replies. Pushes 11 PM - 7 AM sends to 8 AM.
    if (!isTcpaCovered && !isReply) {
      const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
      const hour = etNow.getHours();
      // Human-feel: defer 11 PM - 7 AM cold outreach to 8 AM
      if (hour >= 23 || hour < 7) {
        const next8am = new Date(etNow);
        if (hour >= 23) next8am.setDate(next8am.getDate() + 1);
        next8am.setHours(8, 0, 0, 0);
        console.log(`[OutboxWorker] PR#3.13: Human-feel deferral — ${channel} outbox ${item?.id || "?"} until ${next8am.toISOString()}`);
        return { blocked: false, deferred: true, reason: "human_feel_quiet_hours", deferUntil: next8am };
      }
    }
  } catch (err) {
    console.error(`[Outbox/Guard] TCPA check error:`, err);
  }

  return { blocked: false, deferred: false };
}

// ─── Send Helpers ────────────────────────────────────────────────────────────
function buildSendOpts(channel: string, message: string, payload: Record<string, unknown>): Parameters<typeof sendMessage>[1] {
  const normalizedChannel = channel.toUpperCase();
  const typeMap: Record<string, "SMS" | "Email" | "WhatsApp" | "FB" | "IG" | "Live_Chat"> = {
    SMS: "SMS", EMAIL: "Email", WHATSAPP: "WhatsApp", FB: "FB", IG: "IG",
    LIVE_CHAT: "Live_Chat", FACEBOOK: "FB", INSTAGRAM: "IG",
  };
  const type = typeMap[normalizedChannel] || "SMS";

  if (type === "Email") {
    // Apply signature (idempotent — function checks if already present)
    const withSig = ensureEmailSignature(message);

    // Derive subject if not provided
    const subject = String(payload.subject || payload.emailSubject || deriveEmailSubject(withSig));

    return {
      type,
      message: withSig,                    // plain-text version
      subject,
      html: formatEmailHtml(withSig),      // HTML version with signature, <hr>, links
      fromName: String(payload.fromName || resolveAgentFromName(payload) || ""),
      threadId: payload.threadId ? String(payload.threadId) : undefined,
      replyMessageId: payload.replyMessageId ? String(payload.replyMessageId) : undefined,
    };
  }
  return { type, message };
}

function deriveEmailSubject(message: string): string {
  // Strip greeting and take first ~50 chars as subject
  const cleaned = message
    .replace(/^(Hey|Hi|Hello)\b[^,.!?\n]*[,.!?]?\s*/i, '')
    .split(/[\n.!?]/)[0]
    .trim();
  const truncated = cleaned.length > 60 ? cleaned.slice(0, 57).trimEnd() + '...' : cleaned;
  return truncated || "Following up from Adorb Custom Tees";
}

function resolveAgentFromName(payload: Record<string, unknown>): string {
  // If payload includes an assigned agent name, use "Chris at Adorb Custom Tees" or similar
  const agent = payload.assignedAgent || payload.agent;
  if (typeof agent === 'string' && agent.length > 0) {
    const firstName = agent.split(/\s+/)[0];
    return `${firstName} at Adorb Custom Tees`;
  }
  return "Adorb Custom Tees";
}

// isDraining guard: prevents a slow drain cycle from overlapping with the next
// interval tick. If drainOutbox() is still running when the timer fires again,
// the new call returns immediately instead of spawning a second concurrent drain.
let isDraining = false;

// ─── Drain Loop ──────────────────────────────────────────────────────────────
/**
 * Main drain function. Claims pending rows and processes them sequentially.
 * Called on a timer from the server startup.
 */
export async function drainOutbox(): Promise<{ processed: number; sent: number; skipped: number; failed: number }> {
  const stats = { processed: 0, sent: 0, skipped: 0, failed: 0 };

  // Guard: skip if a previous drain cycle is still in progress.
  // Prevents the 5-second interval from spawning concurrent drains when
  // a brain call takes longer than the interval (common for 5-20s LLM calls).
  if (isDraining) {
    console.log(`[Outbox] Drain skipped — previous cycle still running (${INSTANCE_ID})`);
    return stats;
  }
  isDraining = true;

  try {
    const rows = await claimOutboxRows(INSTANCE_ID, CLAIM_BATCH_SIZE);
    if (rows.length === 0) return stats;

    for (const row of rows) {
      stats.processed++;
      try {
        // FIX: Processing timeout — if Brain call hangs beyond 60s, mark as failed
        // instead of leaving the row in 'claimed' state indefinitely.
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`processing_timeout:${PROCESSING_TIMEOUT_MS}ms`)), PROCESSING_TIMEOUT_MS);
        });
        await Promise.race([processOutboxRow(row), timeoutPromise]);
        // Check the final status
        const db = await getDb();
        if (db) {
          const fetchResult = await db.execute(sql`SELECT outbox_status FROM outbox WHERE id = ${Number(row.id)}`);
          const fetchData = Array.isArray(fetchResult) && Array.isArray(fetchResult[0]) ? fetchResult[0] : [];
          const status = fetchData.length > 0 ? (fetchData[0] as any).outbox_status : undefined;
          if (status === "sent") stats.sent++;
          else if (status === "skipped") stats.skipped++;
          else if (status === "failed") stats.failed++;
        }
      } catch (err: any) {
        stats.failed++;
        // If timeout fired, explicitly mark the row as failed so it doesn't stay 'claimed'
        if (err?.message?.startsWith("processing_timeout:")) {
          console.error(`[Outbox] TIMEOUT: Row ${row.id} exceeded ${PROCESSING_TIMEOUT_MS}ms — marking as failed`);
          try { await markOutbox(row.id, "failed", "processing_timeout_60s"); } catch {}
        } else {
          console.error(`[Outbox] Unhandled error in row ${row.id}:`, err);
        }
      }
    }

    if (stats.processed > 0) {
      console.log(`[Outbox] Drain cycle: ${stats.processed} processed, ${stats.sent} sent, ${stats.skipped} skipped, ${stats.failed} failed`);
    }
    } catch (err) {
    console.error(`[Outbox] Drain cycle error:`, err);
  } finally {
    isDraining = false;
  }
  return stats;
}
// ─── Timer Registration ──────────────────────────────────────────────────────
let drainTimer: ReturnType<typeof setInterval> | null = null;

export function startOutboxWorker(): void {
  if (drainTimer) return; // Already running
  console.log(`[Outbox] Worker started (${INSTANCE_ID}), draining every ${DRAIN_INTERVAL_MS / 1000}s`);
  drainTimer = setInterval(async () => {
    try {
      await drainOutbox();
    } catch (err) {
      console.error(`[Outbox] Worker error:`, err);
    }
  }, DRAIN_INTERVAL_MS);
}

export function stopOutboxWorker(): void {
  if (drainTimer) {
    clearInterval(drainTimer);
    drainTimer = null;
    console.log(`[Outbox] Worker stopped`);
  }
}

// ─── Outbox Stats (for admin dashboard) ──────────────────────────────────────
export async function getOutboxStats(): Promise<{
  pending: number;
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  recentDecisions: any[];
}> {
  const db = await getDb();
  if (!db) return { pending: 0, claimed: 0, sent: 0, failed: 0, skipped: 0, recentDecisions: [] };

  const statusResult = await db.execute(sql`
    SELECT outbox_status, COUNT(*) as cnt FROM outbox GROUP BY outbox_status
  `);
  const statusRows = Array.isArray(statusResult) && Array.isArray(statusResult[0]) ? statusResult[0] : [];
  const counts: Record<string, number> = {};
  for (const row of statusRows as any[]) {
    counts[row.outbox_status] = Number(row.cnt);
  }

  const decisionsResult = await db.execute(sql`
    SELECT * FROM decision_log ORDER BY createdAt DESC LIMIT 50
  `);
  const decisions = Array.isArray(decisionsResult) && Array.isArray(decisionsResult[0]) ? decisionsResult[0] : [];

  return {
    pending: counts.pending || 0,
    claimed: counts.claimed || 0,
    sent: counts.sent || 0,
    failed: counts.failed || 0,
    skipped: counts.skipped || 0,
    recentDecisions: decisions as any[],
  };
}
