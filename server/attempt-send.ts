/**
 * Foundation A: Send-Confirmation Contract — Send Wrapper
 *
 * attemptSend() is the ONLY function callers should use to send messages.
 * It returns a typed SendOutcome that callers must discriminate on before
 * deciding whether to write a `conversations` row.
 *
 * Internally (for now) it delegates to the existing sendMessageWithRetry.
 * Once all 9 callers are migrated, sendMessageWithRetry will be deleted
 * and attemptSend will call sendMessage directly.
 */

import { sendMessageWithRetry } from "./webhook-helpers";
import type { SendOutcome, SendRequest, Channel, SendErrorType } from "./send-types";
import { recordSendAttempt } from "./db";

/**
 * Attempt to send a message. Returns a SendOutcome that callers MUST
 * discriminate on. Use isDelivered() to narrow before writing conversations.
 *
 * Side effect: writes to send_attempts table for all non-delivered outcomes.
 * The caller is responsible for writing to conversations on `delivered`.
 */
export async function attemptSend(request: SendRequest): Promise<SendOutcome> {
  const attemptedAt = new Date();

  // Build the opts object sendMessageWithRetry expects.
  // Channel string from SendRequest maps directly to GHL's type field.
  const opts: any = {
    type: request.channel,
    message: request.message,
    emailSubject: request.emailSubject,
    emailHtmlBody: request.emailHtmlBody,
    fromUserId: request.fromUserId,
    threadId: request.threadId,
    replyMessageId: request.replyMessageId,
  };

  try {
    const result = await sendMessageWithRetry(
      request.ghlContactId,
      opts,
      { id: request.leadId } as any // sendMessageWithRetry's `lead` only needs id for logging
    );

    // Translate the existing return shape into SendOutcome.

    if (result.success && result.ghlMessageId && !result.isPhantom) {
      const outcome: SendOutcome = {
        kind: "delivered",
        messageId: result.ghlMessageId,
        channel: request.channel,
        deliveredAt: attemptedAt,
        resolvedContactId: result.resolvedContactId,
        correctionTaken: result.correctionTaken,
        emailMessageId: result.emailMessageId,
      };
      return outcome;
    }

    if (result.success && (result.isPhantom || !result.ghlMessageId)) {
      // GHL returned success but no messageId — phantom send.
      const outcome: SendOutcome = {
        kind: "phantom",
        reason: result.isPhantom
          ? "GHL returned 200 but no messageId in response"
          : "GHL returned success but ghlMessageId was empty",
        channel: request.channel,
        attemptedAt,
        resolvedContactId: result.resolvedContactId,
        ghlResponseKeys: [], // sendMessageWithRetry doesn't surface this; will improve in A2
      };

      // Side effect: log to send_attempts table.
      await recordSendAttempt({
        leadId: request.leadId,
        channel: request.channel,
        outcomeKind: "phantom",
        reason: outcome.reason,
        attemptedAt,
        trigger: request.trigger,
        payload: { request, result } as Record<string, unknown>,
      });

      return outcome;
    }

    // result.success === false → failed.
    const outcome: SendOutcome = {
      kind: "failed",
      reason: result.error || "send failed",
      errorType: (result.errorType as SendErrorType) || "unknown",
      retryable: isRetryable((result.errorType as SendErrorType) || "unknown"),
      channel: request.channel,
      attemptedAt,
      resolvedContactId: result.resolvedContactId,
    };

    await recordSendAttempt({
      leadId: request.leadId,
      channel: request.channel,
      outcomeKind: "failed",
      reason: outcome.reason,
      errorType: outcome.errorType,
      attemptedAt,
      trigger: request.trigger,
      payload: { request, result } as Record<string, unknown>,
    });

    return outcome;
  } catch (err) {
    // Exception bubbled up from sendMessageWithRetry.
    const reason = err instanceof Error ? err.message : String(err);
    const outcome: SendOutcome = {
      kind: "failed",
      reason,
      errorType: "unknown",
      retryable: false, // exceptions are not auto-retried; supervisor will handle
      channel: request.channel,
      attemptedAt,
    };

    await recordSendAttempt({
      leadId: request.leadId,
      channel: request.channel,
      outcomeKind: "failed",
      reason,
      errorType: "unknown",
      attemptedAt,
      trigger: request.trigger,
      payload: { request, error: reason } as Record<string, unknown>,
    });

    return outcome;
  }
}

/**
 * Whether a given error type should be auto-retried by the outbox worker.
 */
function isRetryable(errorType: SendErrorType): boolean {
  switch (errorType) {
    case "ghl_rate_limit":
    case "timeout":
    case "ghl_api_error":
      return true;
    case "no_phone":
    case "no_email":
    case "no_messageid_returned":
    case "ghl_auth_error":
    case "channel_not_configured":
    case "lead_dnc":
    case "human_takeover_active":
    case "unknown":
      return false;
  }
}
