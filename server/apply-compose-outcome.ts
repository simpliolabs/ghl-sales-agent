/**
 * apply-compose-outcome.ts — v1.9 Phase 1.B
 *
 * Applies the result of a successful brain compose run:
 *   1. Check sent_messages idempotency guard (isSentMessageDuplicate)
 *   2. Send via attemptSend (GHL transport)
 *   3. Record in sent_messages (recordSentMessage)
 *   4. Write conversations row (addConversation)
 *   5. Update lead fields (lastMessageAt, nextFollowUpAt, pipelineStage)
 *   6. Patch ghlMessageId in sent_messages
 *
 * This is extracted from the inline Path B success block in outbox-worker.ts
 * so it can be tested independently and reused by compose-pipeline.ts.
 */

import { attemptSend, isDelivered } from "./attempt-send";
import { recordSentMessage, isSentMessageDuplicate, updateGhlMessageId } from "./sent-messages";
import { updateLeadFields } from "./db";
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
  source: string;
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
 * This ensures that if apply-compose-outcome is called twice for the same
 * outbox row (e.g. after a crash+retry), the second call is a no-op.
 */
export function buildComposeIdemKey(outboxRowId: number): string {
  return `outbox-${outboxRowId}`;
}

/**
 * Apply the compose outcome: send via GHL, record idempotency, update state.
 */
export async function applyComposeOutcome(
  input: ApplyComposeOutcomeInput,
): Promise<ApplyComposeOutcomeResult> {
  const idemKey = input.outboxRowId != null ? buildComposeIdemKey(input.outboxRowId) : null;
  const channel = input.channel as Channel;

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
    return {
      sent: false,
      blocked: true,
      failed: false,
      reason: `send_blocked: ${sendOutcome.reason || "policy"}`,
    };
  }

  if (sendOutcome.kind === "failed") {
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
  // Import dynamically to avoid circular deps
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
