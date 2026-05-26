/**
 * compose-and-send.ts — v1.9 Phase 1.B
 *
 * Outbox row lifecycle wrapper around compose-pipeline.ts.
 *
 * Responsibilities:
 *   - Load lead from DB
 *   - Run input guards (delegate to existing runInputGuards)
 *   - Call runComposePipeline for LLM-generated messages
 *   - Map ComposePipelineResult → outbox status transitions
 *   - Log to decision_log
 *
 * This is the v1.9 entry point that replaces processOutboxRow's Path B.
 * Path A (pre-composed draftMessage) is NOT handled here — it remains in
 * outbox-worker.ts until a future refactor.
 *
 * NOTE: This module is wired but NOT yet called by outbox-worker.ts in Phase 1.B.
 * Phase 1.C will swap processOutboxRow to call composeAndSend instead of the
 * inline Path B block. This module is built now so it can be tested.
 */

import { getLeadById, updateLeadFields } from "./db";
import { runComposePipeline } from "./compose-pipeline";
import type { ComposePipelineResult } from "./compose-pipeline";

export interface ComposeAndSendInput {
  outboxRowId?: number; // optional: undefined when called outside outbox context
  leadId: number;
  source: string;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ComposeAndSendResult {
  status: "sent" | "skipped" | "failed" | "lock_timeout" | "compose_crash";
  reason?: string;
  channel?: string;
  messageId?: string;
  durationMs: number;
}

/**
 * Run the full compose-and-send cycle for an outbox row.
 * Returns a result that the outbox-worker uses to mark the row status.
 */
export async function composeAndSend(input: ComposeAndSendInput): Promise<ComposeAndSendResult> {
  const startTime = Date.now();
  const { outboxRowId, leadId, source, payload, signal } = input;

  // ── Step 1: Load lead ──────────────────────────────────────────────────
  const lead = await getLeadById(leadId);
  if (!lead) {
    return {
      status: "skipped",
      reason: "lead_not_found",
      durationMs: Date.now() - startTime,
    };
  }

  const contactId = lead.ghlContactId;
  if (!contactId) {
    return {
      status: "skipped",
      reason: "no_ghl_contact_id",
      durationMs: Date.now() - startTime,
    };
  }

  // ── Step 2: Resolve channel ────────────────────────────────────────────
  const channel = String(payload.channelHint || payload.channel || lead.preferredChannel || "SMS");
  const trigger = String(payload.trigger || source);
  const incomingMessage = payload.incomingMessage ? String(payload.incomingMessage) : undefined;
  const isInboundReply = Boolean(payload.isInboundReply);
  const overrideReason = payload.overrideReason ? String(payload.overrideReason) : undefined;

  // ── Step 3: Run compose pipeline ──────────────────────────────────────
  let pipelineResult: ComposePipelineResult;
  try {
    pipelineResult = await runComposePipeline({
      leadId,
      outboxRowId,
      source,
      contactId,
      channel,
      incomingMessage,
      isInboundReply,
      overrideReason,
      trigger,
      signal,
    });
  } catch (err: any) {
    return {
      status: "compose_crash",
      reason: `compose_pipeline_threw: ${String(err?.message || err).slice(0, 200)}`,
      durationMs: Date.now() - startTime,
    };
  }

  return {
    status: pipelineResult.status,
    reason: pipelineResult.reason,
    channel: pipelineResult.channel,
    messageId: pipelineResult.messageId,
    durationMs: Date.now() - startTime,
  };
}
