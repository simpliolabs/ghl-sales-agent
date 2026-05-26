/**
 * compose-pipeline.ts — v1.9 Phase 1.B
 *
 * Orchestrates the full per-lead compose cycle:
 *   1. Acquire per-lead compose lock (lead_active_compose)
 *   2. Coalesce guard (skip if very recent send)
 *   3. Run Brain (Single Brain via brain-adapter)
 *   4. Apply compose outcome (sent-messages idempotency + GHL send + state updates)
 *   5. Release compose lock
 *
 * This is the v1.9 replacement for the inline processOutboxRow Path B logic.
 * It is called by compose-and-send.ts (which handles the outbox row lifecycle).
 *
 * Returns a ComposePipelineResult that compose-and-send.ts uses to decide
 * how to mark the outbox row.
 */

import { acquireLeadComposeLock, heartbeatLeadComposeLock, releaseLeadComposeLock } from "./lead-active-compose";
import { checkRecentSendCoalesce } from "./coalesce";
import { applyComposeOutcome } from "./apply-compose-outcome";
import type { BrainCouncilInput } from "./brain-types";

export type ComposePipelineStatus =
  | "sent"
  | "skipped"
  | "failed"
  | "lock_timeout"
  | "compose_crash";

export interface ComposePipelineResult {
  status: ComposePipelineStatus;
  reason?: string;
  channel?: string;
  messageId?: string;
  durationMs: number;
}

export interface ComposePipelineInput {
  leadId: number;
  outboxRowId?: number; // optional: undefined when called outside outbox context
  source: string;
  contactId: string;
  channel: string;
  incomingMessage?: string;
  isInboundReply?: boolean;
  overrideReason?: string;
  trigger: string;
  signal?: AbortSignal;
}

/** Unique worker ID for this process instance (used as heldBy in compose lock). */
const WORKER_ID = `outbox-worker-${process.pid}`;

/** Heartbeat interval — extend lock every 30s while brain is running. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Run the full compose pipeline for a single outbox row.
 * Handles lock acquisition, coalesce, brain call, and outcome application.
 */
export async function runComposePipeline(input: ComposePipelineInput): Promise<ComposePipelineResult> {
  const startTime = Date.now();
  const lockKey = `${WORKER_ID}-row${input.outboxRowId ?? "adhoc"}-${Date.now()}`;

  // ── Step 1: Acquire per-lead compose lock ──────────────────────────────
  const lockAcquired = await acquireLeadComposeLock(input.leadId, lockKey);
  if (!lockAcquired) {
    return {
      status: "skipped",
      reason: `compose_lock_held: another worker is composing for lead ${input.leadId}`,
      durationMs: Date.now() - startTime,
    };
  }

  // Start heartbeat to keep lock alive during brain call
  let heartbeatTimer: ReturnType<typeof setInterval> | null = setInterval(async () => {
    try {
      await heartbeatLeadComposeLock(input.leadId, lockKey);
    } catch { /* non-fatal */ }
  }, HEARTBEAT_INTERVAL_MS);

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  try {
    // ── Step 2: Coalesce guard ─────────────────────────────────────────────
    const coalesceResult = await checkRecentSendCoalesce(input.leadId, input.source);
    if (coalesceResult.skip) {
      return {
        status: "skipped",
        reason: coalesceResult.reason,
        durationMs: Date.now() - startTime,
      };
    }

    // ── Step 3: Run Brain ──────────────────────────────────────────────────
    const { runBrainCouncil } = await import("./brain-adapter");
    const brainInput: BrainCouncilInput = {
      leadId: input.leadId,
      incomingMessage: input.incomingMessage || "",
      channel: input.channel,
      isInboundReply: input.isInboundReply,
      overrideReason: input.overrideReason,
      signal: input.signal,
    };

    let brainResult;
    try {
      brainResult = await runBrainCouncil(brainInput);
    } catch (brainErr: any) {
      // Check if this was an abort (lock timeout from outbox-worker)
      if (brainErr?.name === "AbortError" || String(brainErr?.message).includes("aborted")) {
        return {
          status: "lock_timeout",
          reason: `brain_aborted: ${brainErr.message}`,
          durationMs: Date.now() - startTime,
        };
      }
      return {
        status: "compose_crash",
        reason: `brain_threw: ${String(brainErr?.message || brainErr).slice(0, 200)}`,
        durationMs: Date.now() - startTime,
      };
    }

    if (!brainResult || brainResult.blocked) {
      return {
        status: "skipped",
        reason: `brain_blocked: ${brainResult?.blockReason || "unknown"}`,
        durationMs: Date.now() - startTime,
      };
    }

    if (!brainResult.message) {
      return {
        status: "skipped",
        reason: "brain_no_message",
        durationMs: Date.now() - startTime,
      };
    }

    // ── Step 4: Apply compose outcome ──────────────────────────────────────
    const outcomeResult = await applyComposeOutcome({
      leadId: input.leadId,
      outboxRowId: input.outboxRowId,
      contactId: input.contactId,
      channel: brainResult.channel || input.channel,
      message: brainResult.message,
      fromName: brainResult.fromName,
      subject: brainResult.subject,
      trigger: input.trigger,
      source: input.source,
      nextEngagementHours: brainResult.nextEngagementHours,
      pipelineAction: brainResult.pipelineAction as string | undefined,
      auditId: brainResult.auditId,
      signal: input.signal,
    });

    return {
      status: outcomeResult.sent ? "sent" : (outcomeResult.blocked ? "skipped" : "failed"),
      reason: outcomeResult.reason,
      channel: brainResult.channel || input.channel,
      messageId: outcomeResult.messageId,
      durationMs: Date.now() - startTime,
    };

  } catch (err: any) {
    return {
      status: "compose_crash",
      reason: `pipeline_threw: ${String(err?.message || err).slice(0, 200)}`,
      durationMs: Date.now() - startTime,
    };
  } finally {
    stopHeartbeat();
    // Always release the lock
    await releaseLeadComposeLock(input.leadId, lockKey).catch(() => {});
  }
}
