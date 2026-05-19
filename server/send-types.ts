/**
 * Foundation A: Send-Confirmation Contract
 *
 * SendOutcome is a discriminated union describing the result of attempting
 * to send a message via GHL. The type system uses this to make phantom
 * conversation rows impossible — only `delivered` outcomes can produce
 * a row in the `conversations` table.
 *
 * See ARCHITECTURAL_DEBT_INVENTORY_2026-05-18.md Section 2 item 2 for context.
 */

export type Channel = "SMS" | "WhatsApp" | "Email" | "FB" | "IG" | "Live_Chat";

/**
 * GHL send error types used by `failed` outcomes.
 * Keep in sync with the existing GhlSendErrorType union in webhook-helpers.ts.
 */
export type SendErrorType =
  | "no_phone"
  | "no_email"
  | "no_messageid_returned"
  | "ghl_api_error"
  | "ghl_auth_error"
  | "ghl_rate_limit"
  | "channel_not_configured"
  | "lead_dnc"
  | "human_takeover_active"
  | "timeout"
  | "unknown";

/**
 * Reasons a send was blocked by policy (not attempted).
 * These are NOT failures — they're decisions to defer or skip.
 */
export type SendBlockReason =
  | "tcpa_quiet_hours"
  | "human_feel_quiet_hours"
  | "human_takeover_active"
  | "dnc_active"
  | "rate_limit_exceeded"
  | "channel_disabled"
  | "lead_terminal_stage"
  | "duplicate_send_detected"
  | "no_reachable_channel";

/**
 * The four kinds of outcomes from attempting a send.
 *
 * - `delivered`: GHL confirmed delivery with a messageId. ONLY this kind
 *   may produce a `conversations` row.
 * - `phantom`: GHL returned 200 but no messageId. Message likely not delivered.
 *   Records to `send_attempts` table for audit; DOES NOT write to conversations.
 * - `failed`: GHL returned an error or threw an exception.
 *   Records to `send_attempts` table; may be retried.
 * - `blocked`: Policy gate prevented the attempt. No GHL call was made.
 *   Records to `send_attempts` table with the block reason.
 */
export type SendOutcome =
  | {
      kind: "delivered";
      messageId: string;
      channel: Channel;
      deliveredAt: Date;
      resolvedContactId: string;
      correctionTaken?: string;
      emailMessageId?: string;
    }
  | {
      kind: "phantom";
      reason: string;
      channel: Channel;
      attemptedAt: Date;
      resolvedContactId: string;
      ghlResponseKeys: string[]; // for debugging: what keys WERE in the response
    }
  | {
      kind: "failed";
      reason: string;
      errorType: SendErrorType;
      retryable: boolean;
      channel: Channel;
      attemptedAt: Date;
      resolvedContactId?: string; // may not have resolved
    }
  | {
      kind: "blocked";
      reason: SendBlockReason;
      channel: Channel;
      blockedAt: Date;
      deferUntil?: Date; // present if the policy wants a retry at a specific time
    };

/**
 * Type guard for `delivered` outcomes.
 * Use this to narrow types before calling addConversation.
 */
export function isDelivered(outcome: SendOutcome): outcome is Extract<SendOutcome, { kind: "delivered" }> {
  return outcome.kind === "delivered";
}

/**
 * Type guard for outcomes that should be recorded to send_attempts table.
 * All non-delivered outcomes get audit-logged.
 */
export function shouldRecordAttempt(outcome: SendOutcome): boolean {
  return outcome.kind !== "delivered";
}

/**
 * Input to attemptSend() — all the data needed to attempt a send.
 */
export interface SendRequest {
  leadId: number;
  ghlContactId: string;
  channel: Channel;
  message: string;
  emailSubject?: string;
  emailHtmlBody?: string;
  fromUserId?: string;
  threadId?: string;
  replyMessageId?: string;
  // Trigger context for audit logging:
  trigger: string; // e.g. "first_contact", "inbound_reply", "follow_up"
}
