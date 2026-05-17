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
import { getDb, isAiOffline, getLeadById, updateLeadFields, getConversationHistory } from "./db";
import { outbox, decisionLog } from "../drizzle/schema";
import type { OutboxRow, InsertOutboxRow } from "../drizzle/schema";
import { sql, eq } from "drizzle-orm";
import { sendMessage } from "./ghl";
import type { BrainCouncilInput } from "./brain-types";
import { promptVersions } from "../drizzle/schema";

// ─── Constants ───────────────────────────────────────────────────────────────
const INSTANCE_ID = `worker-${process.pid}-${Date.now().toString(36)}`;
const MAX_RETRIES = 3;
const CLAIM_BATCH_SIZE = 5;
const CLAIM_EXPIRY_MS = 120_000; // 2 min — reclaim if worker dies
const DRAIN_INTERVAL_MS = 5_000; // 5 seconds between drain cycles

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
 * Atomically claim pending outbox rows using FOR UPDATE SKIP LOCKED.
 * Also reclaims rows that were claimed but never completed (worker crash).
 */
async function claimOutboxRows(workerId: string, limit: number): Promise<OutboxRow[]> {
  const db = await getDb();
  if (!db) return [];

  const now = new Date();
  const expiry = new Date(now.getTime() - CLAIM_EXPIRY_MS);

  try {
    // Step 1: Find claimable IDs with FOR UPDATE SKIP LOCKED
    const result = await db.execute(sql`
      SELECT id FROM outbox
      WHERE (outbox_status = 'pending' AND scheduledAt <= ${now})
         OR (outbox_status = 'claimed' AND claimedAt < ${expiry})
      ORDER BY scheduledAt ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);

    const rowData = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : [];
    if (!rowData.length) return [];

    const ids: number[] = rowData.map((r: any) => Number(r.id));

    // Step 2: Claim them
    for (const rowId of ids) {
      await db.execute(sql`
        UPDATE outbox
        SET outbox_status = 'claimed', claimedBy = ${workerId}, claimedAt = ${now}
        WHERE id = ${rowId}
      `);
    }

    // Step 3: Fetch the full rows
    const claimed: OutboxRow[] = [];
    for (const rowId of ids) {
      const fetchResult = await db.execute(sql`SELECT * FROM outbox WHERE id = ${rowId}`);
      const fetchData = Array.isArray(fetchResult) && Array.isArray(fetchResult[0]) ? fetchResult[0] : [];
      if (fetchData.length > 0) claimed.push(fetchData[0] as unknown as OutboxRow);
    }

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

  try {
    await db.insert(decisionLog).values({
      outboxId: opts.outboxId != null ? Number(opts.outboxId) : null,
      leadId: opts.leadId,
      trigger: opts.trigger,
      brainReasoning: opts.brainReasoning ?? undefined,
      promptVersion: opts.promptVersion ?? undefined,
      channel: opts.channel ?? undefined,
      inputGuardResult: opts.inputGuardResult ?? undefined,
      outputGuardResult: opts.outputGuardResult ?? undefined,
      durationMs: opts.durationMs ?? undefined,
    });
  } catch (err) {
    console.error(`[Outbox] Decision log error:`, err);
  }
}

// ─── Process Single Row ──────────────────────────────────────────────────────
/**
 * Process a single outbox row:
 * 1. Load the lead
 * 2. Run input guards (AI offline, DNC, humanTakeover, quiet hours)
 * 3. Call Brain Council (or use pre-composed message)
 * 4. Send via GHL
 * 5. Log the decision
 * 
 * NOTE: For Phase 1, we still call the existing runBrainCouncil pipeline.
 * Phase 2 will replace this with the single brain.
 */
async function processOutboxRow(row: OutboxRow): Promise<void> {
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
    const guardResult = await runInputGuards(lead);
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
      const channel = String(payload.channel || lead.preferredChannel || "SMS");
      const sendOpts = buildSendOpts(channel, String(payload.draftMessage), payload);
      const result = await sendMessage(contactId, sendOpts);

      if (result?.blocked) {
        await markOutbox(row.id, "skipped", `send_blocked:${result.reason}`);
        await logDecision({ outboxId: row.id, leadId, trigger: String(payload.trigger || row.source), channel, outputGuardResult: `block:${result.reason}`, durationMs: Date.now() - startTime });
        return;
      }

      await markOutbox(row.id, "sent");
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

        // Path B: LLM-generated — Single Brain (Phase 2) with A/B fallback to Brain Council
    const useSingleBrain = await shouldUseSingleBrain();

    if (useSingleBrain) {
      // ── Phase 2: Single Brain path ──────────────────────────────────────
      const { runSingleBrain } = await import("./single-brain");
      const brainOutput = await runSingleBrain({
        leadId: lead.id,
        trigger: String(payload.trigger || row.source),
        inboundMessage: payload.incomingMessage ? String(payload.incomingMessage) : undefined,
        channel: String(payload.channelHint || lead.preferredChannel || "SMS"),
      });

      const { decision, guardResult, toolLog: brainToolLog, model, promptVersion, durationMs, llmCalls } = brainOutput;

      // Output guard blocked?
      if (!guardResult.passed) {
        await markOutbox(row.id, "skipped", `output_guard:${guardResult.reason}`);
        await logDecision({
          outboxId: row.id, leadId,
          trigger: String(payload.trigger || row.source),
          brainReasoning: decision.message || undefined,
          promptVersion,
          channel: decision.channel,
          inputGuardResult: "pass",
          outputGuardResult: `block:${guardResult.reason}`,
          durationMs,
        });
        return;
      }

      // Apply corrected decision if guard modified it
      const finalDecision = guardResult.correctedDecision || decision;

      // Route to human?
      if (finalDecision.routeToHuman) {
        await updateLeadFields(lead.id, { humanTakeover: 1 });
        await markOutbox(row.id, "skipped", `route_to_human:${finalDecision.routeReason || "brain_requested"}`);
        await logDecision({
          outboxId: row.id, leadId,
          trigger: String(payload.trigger || row.source),
          brainReasoning: `ROUTE_TO_HUMAN: ${finalDecision.routeReason || "brain requested"}`,
          promptVersion,
          channel: finalDecision.channel,
          inputGuardResult: "pass",
          outputGuardResult: "pass",
          durationMs,
        });
        return;
      }

      // DNC action?
      if (finalDecision.pipelineAction === "dnc") {
        await updateLeadFields(lead.id, { humanTakeover: 1, pipelineStage: "not_qualified" });
        await markOutbox(row.id, "skipped", "dnc_action");
        await logDecision({
          outboxId: row.id, leadId,
          trigger: String(payload.trigger || row.source),
          brainReasoning: "DNC action from brain",
          promptVersion,
          channel: finalDecision.channel,
          inputGuardResult: "pass",
          outputGuardResult: "pass",
          durationMs,
        });
        return;
      }

      // No message to send?
      if (!finalDecision.message) {
        await markOutbox(row.id, "skipped", "no_message");
        await logDecision({
          outboxId: row.id, leadId,
          trigger: String(payload.trigger || row.source),
          brainReasoning: "Brain returned no message",
          promptVersion,
          channel: finalDecision.channel,
          inputGuardResult: "pass",
          outputGuardResult: "pass",
          durationMs,
        });
        return;
      }

      // ── Send the message via GHL ──────────────────────────────────────
      const sendOpts = buildSendOpts(finalDecision.channel, finalDecision.message, payload);
      const result = await sendMessage(contactId, sendOpts);

      if (result?.blocked) {
        await markOutbox(row.id, "skipped", `send_blocked:${result.reason}`);
        await logDecision({
          outboxId: row.id, leadId,
          trigger: String(payload.trigger || row.source),
          brainReasoning: finalDecision.message,
          promptVersion,
          channel: finalDecision.channel,
          inputGuardResult: "pass",
          outputGuardResult: `block:send_${result.reason}`,
          durationMs,
        });
        return;
      }

      // ── Success! Update state ─────────────────────────────────────────
      await markOutbox(row.id, "sent");

      // Schedule next follow-up if brain suggested one
      if (finalDecision.nextFollowUpHours > 0) {
        const nextAt = new Date(Date.now() + finalDecision.nextFollowUpHours * 60 * 60 * 1000);
        await updateLeadFields(lead.id, { nextFollowUpAt: nextAt });
      }

      // Update pipeline stage if brain requested
      if (finalDecision.pipelineAction === "advance" || finalDecision.pipelineAction === "mark_won" || finalDecision.pipelineAction === "mark_lost") {
        const stageMap: Record<string, string> = {
          advance: "quoted", // Brain advances to next logical stage
          mark_won: "won",
          mark_lost: "lost",
        };
        const newStage = stageMap[finalDecision.pipelineAction];
        if (newStage) {
          await updateLeadFields(lead.id, { pipelineStage: newStage });
        }
      }

      await logDecision({
        outboxId: row.id, leadId,
        trigger: String(payload.trigger || row.source),
        brainReasoning: finalDecision.message,
        promptVersion,
        channel: finalDecision.channel,
        inputGuardResult: "pass",
        outputGuardResult: guardResult.action === "corrected" ? `corrected:${guardResult.reason}` : "pass",
        durationMs,
      });

    } else {
      // ── Legacy fallback: Brain Council path ────────────────────────────
      const { runBrainCouncil } = await import("./brain-adapter");
      const brainInput: BrainCouncilInput = {
        leadId: lead.id,
        incomingMessage: String(payload.incomingMessage || ""),
        channel: String(payload.channelHint || lead.preferredChannel || "SMS"),
        externalHistory: payload.externalHistory ? String(payload.externalHistory) : undefined,
        isInboundReply: Boolean(payload.isInboundReply),
        overrideReason: payload.overrideReason ? String(payload.overrideReason) : undefined,
      };
      const brainResult = await runBrainCouncil(brainInput);
      if (!brainResult || brainResult.blocked) {
        await markOutbox(row.id, "skipped", `brain_blocked:${brainResult?.blockReason || "unknown"}`);
        await logDecision({
          outboxId: row.id, leadId,
          trigger: String(payload.trigger || row.source),
          brainReasoning: brainResult?.strategyReasoning || undefined,
          inputGuardResult: "pass",
          outputGuardResult: `block:${brainResult?.blockReason || "unknown"}`,
          durationMs: Date.now() - startTime,
        });
        return;
      }
      // Brain Council sends internally (legacy architecture)
      await markOutbox(row.id, "sent");
      await logDecision({
        outboxId: row.id, leadId,
        trigger: String(payload.trigger || row.source),
        brainReasoning: brainResult.strategyReasoning || undefined,
        channel: brainResult.channel || lead.preferredChannel || undefined,
        inputGuardResult: "pass",
        outputGuardResult: "pass",
        durationMs: Date.now() - startTime,
      });
    }

  } catch (err: any) {
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

async function runInputGuards(lead: any): Promise<GuardResult> {
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

  // Guard 5: TCPA quiet hours (8pm-8am in lead's timezone, default ET)
  try {
    const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const hour = etNow.getHours();
    if (hour >= 20 || hour < 8) {
      // Defer to 8am ET next day
      const next8am = new Date(etNow);
      if (hour >= 20) next8am.setDate(next8am.getDate() + 1);
      next8am.setHours(8, 0, 0, 0);
      return { blocked: false, deferred: true, reason: "tcpa_quiet_hours", deferUntil: next8am };
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
    return {
      type,
      message,
      subject: String(payload.subject || ""),
      html: String(payload.html || message),
      fromName: String(payload.fromName || ""),
      threadId: payload.threadId ? String(payload.threadId) : undefined,
      replyMessageId: payload.replyMessageId ? String(payload.replyMessageId) : undefined,
    };
  }
  return { type, message };
}

// ─── Drain Loop ──────────────────────────────────────────────────────────────
/**
 * Main drain function. Claims pending rows and processes them sequentially.
 * Called on a timer from the server startup.
 */
export async function drainOutbox(): Promise<{ processed: number; sent: number; skipped: number; failed: number }> {
  const stats = { processed: 0, sent: 0, skipped: 0, failed: 0 };

  try {
    const rows = await claimOutboxRows(INSTANCE_ID, CLAIM_BATCH_SIZE);
    if (rows.length === 0) return stats;

    for (const row of rows) {
      stats.processed++;
      try {
        await processOutboxRow(row);
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
      } catch (err) {
        stats.failed++;
        console.error(`[Outbox] Unhandled error in row ${row.id}:`, err);
      }
    }

    if (stats.processed > 0) {
      console.log(`[Outbox] Drain cycle: ${stats.processed} processed, ${stats.sent} sent, ${stats.skipped} skipped, ${stats.failed} failed`);
    }
  } catch (err) {
    console.error(`[Outbox] Drain cycle error:`, err);
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
