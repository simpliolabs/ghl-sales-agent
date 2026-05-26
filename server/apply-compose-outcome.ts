/**
 * apply-compose-outcome.ts — v1.9 Phase 1.B (Addendum)
 *
 * Applies the result of a successful brain compose run:
 *   1. Check sent_messages idempotency guard (isSentMessageDuplicate)
 *   2. Send via attemptSend (GHL transport)
 *   3. Record in sent_messages (recordSentMessage)
 *   4. Write conversations row (addConversation)
 *   5. Update lead fields (lastMessageAt, nextFollowUpAt, pipelineStage,
 *      firstContactSentAt, consecutiveNullCount)
 *   6. Patch ghlMessageId in sent_messages
 *
 * Addendum additions (spec §8.1 + §4.6):
 *   - firstContactSentAt: set on successful first_contact send; cleared on terminal failure
 *   - consecutiveNullCount: incremented on null result, reset to 0 on sent
 *   - bannedPhraseBlockCount: incremented on banned_phrase block
 *   - resetFirstContactOnFailure: called from terminal-failure branches
 */

import { eq, sql } from "drizzle-orm";
import { attemptSend, isDelivered } from "./attempt-send";
import { recordSentMessage, isSentMessageDuplicate, updateGhlMessageId } from "./sent-messages";
import { updateLeadFields, getDb } from "./db";
import { leads, outbox } from "../drizzle/schema";
import type { Channel } from "./send-types";

/** Minimum hours before scheduling the next follow-up (prevents 0-hour loops). */
const MIN_NEXT_FOLLOW_UP_HOURS = 4;

export interface ApplyComposeOutcomeInput {
  leadId: number;
  outboxRowId?: number; // optional: undefined when called outside outbox context
  contactId: string;
  channel: string;
  message: string;
  fromName?: string;
  subject?: string;
  trigger: string;
  source: string; // used as triggerSource for first_contact conditional logic
  nextEngagementHours?: number;
  pipelineAction?: string;
  auditId?: number;
  signal?: AbortSignal;
}

export interface ApplyComposeOutcomeResult {
  sent: boolean;
  blocked: boolean;
  failed: boolean;
  reason?: string;
  messageId?: string;
  emailMessageId?: string;
}

/**
 * Build a deterministic idempotency key for a compose outcome.
 * Format: `outbox-{outboxRowId}` — one key per outbox row.
 */
export function buildComposeIdemKey(outboxRowId: number): string {
  return `outbox-${outboxRowId}`;
}

/**
 * Spec §4.6: Reset firstContactSentAt to NULL on terminal first-contact failure.
 * Called from terminal-failure branches when source === 'first_contact'.
 */
async function resetFirstContactOnFailure(
  leadId: number,
  reason: string,
  outboxRowId?: number,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(leads)
    .set({ firstContactSentAt: null })
    .where(eq(leads.id, leadId));
  console.log(JSON.stringify({
    event: "first_contact_reset",
    leadId,
    reason,
    outboxRowId: outboxRowId ?? null,
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Spec §8.1: Increment bannedPhraseBlockCount and return the new value.
 */
async function incrementBannedPhraseBlockCount(leadId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  await db.update(leads)
    .set({ bannedPhraseBlockCount: sql`${leads.bannedPhraseBlockCount} + 1` })
    .where(eq(leads.id, leadId));
  const [row] = await db.select({ c: leads.bannedPhraseBlockCount })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  return row?.c ?? 0;
}

/**
 * Apply the compose outcome: send via GHL, record idempotency, update state.
 */
export async function applyComposeOutcome(
  input: ApplyComposeOutcomeInput,
): Promise<ApplyComposeOutcomeResult> {
  const idemKey = input.outboxRowId != null ? buildComposeIdemKey(input.outboxRowId) : null;
  const channel = input.channel as Channel;
  const isFirstContact = input.source === "first_contact";

  // ── Step 1: Idempotency guard (only when outboxRowId is present) ───────
  if (idemKey) {
    const isDuplicate = await isSentMessageDuplicate(input.leadId, idemKey, input.channel);
    if (isDuplicate) {
      return {
        sent: false,
        blocked: true,
        failed: false,
        reason: `idem_duplicate: outbox row ${input.outboxRowId} already sent (idemKey=${idemKey})`,
      };
    }
  }

  // ── Step 2: Send via GHL ───────────────────────────────────────────────
  const sendOutcome = await attemptSend({
    leadId: input.leadId,
    ghlContactId: input.contactId,
    channel,
    message: input.message,
    emailSubject: channel === "Email" ? input.subject : undefined,
    fromName: input.fromName,
    trigger: input.trigger,
    signal: input.signal,
  });

  if (sendOutcome.kind === "blocked") {
    // Spec §8.1: blocked_banned_phrase branch
    // SendBlockReason does not include 'banned_phrase' — output-guards blocks before attemptSend.
    // This branch handles any policy block for first_contact tracking purposes.
    if (isFirstContact) {
      const newCount = await incrementBannedPhraseBlockCount(input.leadId);
      if (input.outboxRowId !== undefined) {
        // Retryable branch: update outbox row with retry logic via raw SQL
        const db = await getDb();
        if (db) {
          await db.execute(sql`
            UPDATE outbox
            SET status = CASE
                  WHEN retryCount + 1 >= 6 THEN 'failed_terminal'
                  ELSE 'pending_retry'
                END,
                retryCount = retryCount + 1,
                error = CONCAT('policy_block:', ${String(sendOutcome.reason)}, ':count_', ${newCount}),
                claimedBy = NULL,
                claimedAt = NULL
            WHERE id = ${input.outboxRowId}
          `);
          // Check if now terminal
          const [row] = await db.select({ status: outbox.status })
            .from(outbox)
            .where(eq(outbox.id, input.outboxRowId))
            .limit(1);
          if (row?.status === "failed_terminal") {
            await resetFirstContactOnFailure(input.leadId, "policy_block_max_retries", input.outboxRowId);
            await updateLeadFields(input.leadId, {
              nextFollowUpAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            });
          }
        }
      } else {
        // Direct caller: no retry mechanism — treat as terminal
        console.log(JSON.stringify({
          event: "policy_block_direct_send",
          leadId: input.leadId,
          reason: sendOutcome.reason,
          newCount,
          timestamp: new Date().toISOString(),
        }));
        await resetFirstContactOnFailure(input.leadId, `policy_block_direct:${String(sendOutcome.reason)}`, undefined);
      }
    }
    return {
      sent: false,
      blocked: true,
      failed: false,
      reason: `send_blocked: ${sendOutcome.reason || "policy"}`,
    };
  }

  if (sendOutcome.kind === "failed") {
    // Spec §8.1: send_failed_retryable / send_failed_terminal branch
    if (isFirstContact) {
      // On non-retryable (terminal) send failure, reset firstContactSentAt.
      // Retryable failures leave it alone — they will retry.
      if (!sendOutcome.retryable) {
        await resetFirstContactOnFailure(
          input.leadId,
          `send_failed_terminal:${sendOutcome.errorType}`,
          input.outboxRowId,
        );
      }
    }
    return {
      sent: false,
      blocked: false,
      failed: true,
      reason: `send_failed: ${sendOutcome.errorType || "unknown"} — ${sendOutcome.reason || ""}`.slice(0, 200),
    };
  }

  // ── Step 3: Record in sent_messages (only when outboxRowId is present) ─
  const ghlMessageId = isDelivered(sendOutcome) ? sendOutcome.messageId : undefined;
  if (idemKey) {
    await recordSentMessage({
      leadId: input.leadId,
      idemKey,
      channel: input.channel,
      ghlMessageId: ghlMessageId ?? null,
    });
  }

  // ── Step 4: Write conversations row ────────────────────────────────────
  const { addConversation } = await import("./db");
  if (isDelivered(sendOutcome)) {
    await addConversation({
      leadId: input.leadId,
      direction: "outbound",
      senderType: "ai",
      messageBody: input.message,
      senderName: input.fromName || "AI",
      outcome: {
        kind: "delivered",
        messageId: sendOutcome.messageId,
        channel,
        deliveredAt: new Date(),
        resolvedContactId: sendOutcome.resolvedContactId,
        emailMessageId: sendOutcome.emailMessageId,
      },
    });
  }

  // ── Step 5: Update lead fields ─────────────────────────────────────────
  const leadUpdates: Record<string, unknown> = {
    lastMessageAt: new Date(),
    consecutiveNullCount: 0, // spec §8.1: reset on successful send
  };

  if (input.nextEngagementHours && input.nextEngagementHours > 0) {
    const clampedHours = Math.max(input.nextEngagementHours, MIN_NEXT_FOLLOW_UP_HOURS);
    leadUpdates.nextFollowUpAt = new Date(Date.now() + clampedHours * 60 * 60 * 1000);
  }

  const pipelineStageMap: Record<string, string> = {
    advance: "quoted",
    mark_won: "won",
    mark_lost: "lost",
  };
  if (input.pipelineAction && pipelineStageMap[input.pipelineAction]) {
    leadUpdates.pipelineStage = pipelineStageMap[input.pipelineAction];
  }

  // Spec §4.6: set firstContactSentAt on successful first_contact send
  if (isFirstContact) {
    leadUpdates.firstContactSentAt = new Date();
  }

  await updateLeadFields(input.leadId, leadUpdates as any);

  // ── Step 6: Patch ghlMessageId if we got one (only when outboxRowId is present) ─
  if (ghlMessageId && idemKey) {
    await updateGhlMessageId(input.leadId, idemKey, input.channel, ghlMessageId);
  }

  return {
    sent: true,
    blocked: false,
    failed: false,
    messageId: ghlMessageId,
    emailMessageId: isDelivered(sendOutcome) ? sendOutcome.emailMessageId : undefined,
  };
}

/**
 * Spec §8.1: Apply the 'null' brain result outcome.
 * Called by compose-pipeline when brain returns no message.
 * Increments consecutiveNullCount.
 */
export async function applyNullBrainOutcome(leadId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(leads)
    .set({ consecutiveNullCount: sql`${leads.consecutiveNullCount} + 1` })
    .where(eq(leads.id, leadId));
}
