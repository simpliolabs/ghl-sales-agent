/**
 * Foundation A: Send-Confirmation Contract — Send Wrapper
 *
 * attemptSend() is the ONLY function callers should use to send messages.
 * It returns a typed SendOutcome that callers must discriminate on before
 * deciding whether to write a `conversations` row.
 *
 * Internally it delegates to sendMessageWithRetry (the GHL transport layer).
 * Foundation A.5: all 10 production callsites have been migrated to attemptSend.
 * sendMessageWithRetry is now internal-only to this module and webhook-helpers.ts.
 */

import { sendMessageWithRetry } from "./webhook-helpers";
import type { SendOutcome, SendRequest, Channel, SendErrorType } from "./send-types";
import { recordSendAttempt } from "./db";
// Re-export type guards so callers can import from a single module
export { isDelivered, shouldRecordAttempt } from "./send-types";

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
    fromName: request.fromName,
    emailThreadId: request.emailThreadId,
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
    // Map GhlSendErrorType → SendErrorType (the two unions overlap but have different names for some values)
    const mappedErrorType: SendErrorType = (() => {
      const raw = result.errorType as string | undefined;
      if (!raw) return "unknown";
      // GhlSendErrorType values that map directly
      if (raw === "contact_not_found") return "contact_not_found";
      if (raw === "dnd") return "lead_dnc";
      if (raw === "missing_phone") return "no_phone";
      if (raw === "missing_email") return "no_email";
      if (raw === "transient") return "ghl_api_error";
      // Values that exist in both unions with same name
      const directMap: SendErrorType[] = ["no_phone","no_email","no_messageid_returned","ghl_api_error","ghl_auth_error","ghl_rate_limit","channel_not_configured","lead_dnc","human_takeover_active","timeout","contact_not_found","unknown"];
      return (directMap.includes(raw as SendErrorType) ? raw : "unknown") as SendErrorType;
    })();
    const outcome: SendOutcome = {
      kind: "failed",
      reason: result.error || "send failed",
      errorType: mappedErrorType,
      retryable: isRetryable(mappedErrorType),
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
    case "contact_not_found":
    case "unknown":
      return false;
  }
}
