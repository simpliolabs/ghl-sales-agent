/**
 * WEBHOOK ROUTER — Thin entry point that wires GHL webhook handlers
 * 
 * All business logic lives in focused handler modules:
 * - webhook-helpers.ts   → shared utilities, constants, types
 * - webhook-contact.ts   → new contact creation + first-contact sequence
 * - webhook-message.ts   → inbound/outbound message handling + Brain Council
 * - webhook-pipeline.ts  → pipeline stage changes + stage automation
 * - webhook-task.ts      → task completion → auto-advance pipeline
 */

import { Router, Request, Response } from "express";
import { addWebhookLog } from "./db";
import { detectEventType, normalizeWorkflowPayload } from "./webhook-helpers";
import { handleContactWebhook } from "./webhook-contact";
import { handleMessageWebhook } from "./webhook-message";
import { handlePipelineWebhook } from "./webhook-pipeline";
import { handleTaskWebhook } from "./webhook-task";
import { handleAppointmentWebhook, handleNoteWebhook, handleEmailEventWebhook, handleContactDndWebhook, handleOpportunityWebhook } from "./webhook-events";
import { retroactiveCorrectionScan } from "./auto-correction";
import { backfillOutcomes } from "./outcome-engine";
import { processOverdueFollowUps, processOverdueCatchUp } from "./follow-up-trigger";
import { runLookback } from "./lookback-engine";
import { runBrainCouncilSelfReview } from "./brain-council-review";
import { runDispositionSweep } from "./lead-disposition";
import { runPromotionScan } from "./learning-loop";
import { seedKnownErrors } from "./error-memory";
import { runAndStoreSupervisorCycle, logTimerHeartbeat } from "./supervisor";

// --- CONTACT-LEVEL MUTEX ---
// Prevents concurrent processing of the same ghlContactId across different
// webhook types (ContactCreate + InboundMessage race condition).
// When two webhooks arrive simultaneously for the same contact, the second
// one waits up to 5 seconds for the first to finish, then proceeds.
// This is defense-in-depth on top of the atomic upsert in db.ts.
const CONTACT_PROCESSING_LOCK = new Map<string, { promise: Promise<void>; resolve: () => void }>();

function acquireContactLock(contactId: string): { acquired: boolean; waitForPrevious: () => Promise<void> } {
  const existing = CONTACT_PROCESSING_LOCK.get(contactId);
  if (existing) {
    // Another webhook is processing this contact — return a wait function
    return {
      acquired: false,
      waitForPrevious: () => Promise.race([
        existing.promise,
        new Promise<void>(resolve => setTimeout(resolve, 5000)), // 5s max wait
      ]),
    };
  }
  // No existing lock — create one
  let lockResolve: () => void;
  const lockPromise = new Promise<void>(resolve => { lockResolve = resolve; });
  CONTACT_PROCESSING_LOCK.set(contactId, { promise: lockPromise, resolve: lockResolve! });
  return { acquired: true, waitForPrevious: () => Promise.resolve() };
}

function releaseContactLock(contactId: string): void {
  const lock = CONTACT_PROCESSING_LOCK.get(contactId);
  if (lock) {
    lock.resolve();
    CONTACT_PROCESSING_LOCK.delete(contactId);
  }
}

/** For testing: clear all contact locks. */
export function _resetContactLockForTests(): void {
  CONTACT_PROCESSING_LOCK.forEach(lock => lock.resolve());
  CONTACT_PROCESSING_LOCK.clear();
}

// --- IN-MEMORY DEDUP LOCK ---
// Prevents concurrent processing of the same message webhook.
// Key: contactId + messageBody hash, Value: timestamp of lock acquisition.
// Locks expire after 30 seconds to handle crashes/timeouts.
const MESSAGE_DEDUP_LOCK = new Map<string, number>();
const DEDUP_LOCK_TTL_MS = 30_000;

// --- PIPELINE STAGE DEDUP LOCK ---
// GHL can fire multiple webhooks for the same stage change (workflow triggers + direct API events).
// This prevents duplicate notes, tasks, and notifications for the same stage transition.
// Key: contactId + toStage, Value: timestamp. Expires after 60 seconds.
const PIPELINE_DEDUP_LOCK = new Map<string, number>();
const PIPELINE_DEDUP_TTL_MS = 60_000;

function acquirePipelineLock(contactId: string, toStage: string): boolean {
  const now = Date.now();
  // Clean expired locks
  Array.from(PIPELINE_DEDUP_LOCK.entries()).forEach(([key, ts]) => {
    if (now - ts > PIPELINE_DEDUP_TTL_MS) PIPELINE_DEDUP_LOCK.delete(key);
  });
  const lockKey = `${contactId}:${toStage}`;
  if (PIPELINE_DEDUP_LOCK.has(lockKey)) {
    console.log(`[Webhook/Dedup] Duplicate pipeline stage webhook blocked: ${lockKey}`);
    return false;
  }
  PIPELINE_DEDUP_LOCK.set(lockKey, now);
  return true;
}

function releasePipelineLock(contactId: string, toStage: string): void {
  PIPELINE_DEDUP_LOCK.delete(`${contactId}:${toStage}`);
}

/** Exported only for test teardown — clears all pipeline dedup locks. */
export function _resetPipelineLockForTests(): void {
  PIPELINE_DEDUP_LOCK.clear();
}

function acquireMessageLock(contactId: string, messageBody: string): boolean {
  // Clean expired locks
  const now = Date.now();
  Array.from(MESSAGE_DEDUP_LOCK.entries()).forEach(([key, ts]) => {
    if (now - ts > DEDUP_LOCK_TTL_MS) MESSAGE_DEDUP_LOCK.delete(key);
  });
  // Create a simple hash key from contactId + first 100 chars of message body
  const lockKey = `${contactId}:${(messageBody || "").substring(0, 100)}`;
  if (MESSAGE_DEDUP_LOCK.has(lockKey)) {
    console.log(`[Webhook/Dedup] Duplicate message webhook blocked: ${lockKey.substring(0, 60)}...`);
    return false; // Lock already held — this is a duplicate
  }
  MESSAGE_DEDUP_LOCK.set(lockKey, now);
  return true; // Lock acquired
}

function releaseMessageLock(contactId: string, messageBody: string): void {
  const lockKey = `${contactId}:${(messageBody || "").substring(0, 100)}`;
  MESSAGE_DEDUP_LOCK.delete(lockKey);
}

export function createWebhookRouter(): Router {
  const router = Router();

  // ═══ SUPERVISOR: 5-minute invariant enforcement cycle ═══
  let supervisorRunning = false;
  setInterval(async () => {
    if (supervisorRunning) return;
    supervisorRunning = true;
    try {
      const result = await runAndStoreSupervisorCycle();
      console.log(`[Supervisor/Timer] Cycle: ${result.leadsChecked} checked, ${result.violationsFound} violations, ${result.correctionsMade} corrected, ${result.correctionsFailed} failed (${result.durationMs}ms)`);
    } catch (err) {
      console.error('[Supervisor/Timer] Error:', err);
    } finally {
      supervisorRunning = false;
    }
  }, 5 * 60 * 1000);

  // Run initial Supervisor cycle 3 minutes after startup
  setTimeout(async () => {
    if (supervisorRunning) return;
    supervisorRunning = true;
    try {
      const result = await runAndStoreSupervisorCycle();
      console.log(`[Supervisor/Timer] Initial cycle: ${result.leadsChecked} checked, ${result.violationsFound} violations, ${result.correctionsMade} corrected (${result.durationMs}ms)`);
    } catch (err) {
      console.error('[Supervisor/Timer] Initial cycle error:', err);
    } finally {
      supervisorRunning = false;
    }
  }, 3 * 60 * 1000);

  // --- RETROACTIVE CORRECTION SCAN (every 15 minutes) ---
  setInterval(async () => {
    try {
      const corrected = await retroactiveCorrectionScan();
      if (corrected > 0) console.log(`[AutoCorrect/Timer] Retroactive scan corrected ${corrected} messages`);
    } catch (err) {
      console.error('[AutoCorrect/Timer] Scan error:', err);
    }
  }, 15 * 60 * 1000);

  // --- SELF-LEARNING: Backfill outcome records every 30 minutes ---
  setInterval(async () => {
    try {
      const created = await backfillOutcomes();
      if (created > 0) console.log(`[Learn/Timer] Backfilled ${created} outcome records`);
      await logTimerHeartbeat('timer_outcomes_last_run');
    } catch (err) {
      console.error('[Learn/Timer] Backfill error:', err);
    }
  }, 30 * 60 * 1000);

  // Run initial backfill 60s after startup
  setTimeout(async () => {
    try {
      const created = await backfillOutcomes();
      console.log(`[Learn/Timer] Initial backfill: ${created} outcome records created`);
    } catch (err) {
      console.error('[Learn/Timer] Initial backfill error:', err);
    }
  }, 60 * 1000);

  // --- LEARNING LOOP: Promotion scan every 2 hours ---
  setInterval(async () => {
    try {
      const result = await runPromotionScan();
      if (result.promoted > 0 || result.demoted > 0) {
        console.log(`[Learn/Promotion] Scan: ${result.promoted} promoted, ${result.demoted} demoted, ${result.total} evaluated`);
      }
    } catch (err) {
      console.error('[Learn/Promotion] Scan error:', err);
    }
  }, 2 * 60 * 60 * 1000);

  // --- ERROR MEMORY: Seed known errors on startup ---
  setTimeout(async () => {
    try {
      const seeded = await seedKnownErrors();
      console.log(`[ErrorMemory/Timer] Seeded ${seeded} known error patterns`);
    } catch (err) {
      console.error('[ErrorMemory/Timer] Seed error:', err);
    }
  }, 90 * 1000);

  // --- FOLLOW-UP TRIGGER: Process overdue leads every 10 minutes ---
  setInterval(async () => {
    try {
      const result = await processOverdueFollowUps();
      if (result.processed > 0) console.log(`[FollowUp/Timer] ${result.sent} sent, ${result.skipped} skipped, ${result.errors} errors`);
      await logTimerHeartbeat('timer_followup_last_run');
    } catch (err) {
      console.error('[FollowUp/Timer] Error:', err);
    }
  }, 10 * 60 * 1000);

  // Run initial follow-up check 90s after startup
  setTimeout(async () => {
    try {
      const result = await processOverdueFollowUps();
      console.log(`[FollowUp/Timer] Initial run: ${result.sent} sent, ${result.skipped} skipped, ${result.errors} errors`);
      await logTimerHeartbeat('timer_followup_last_run');
    } catch (err) {
      console.error('[FollowUp/Timer] Initial run error:', err);
    }
  }, 90 * 1000);

  // --- HOURLY OVERDUE CATCH-UP: Find leads that fell through cracks (batch of 20) ---
  let overdueCatchupRunning = false;
  setInterval(async () => {
    if (overdueCatchupRunning) return;
    overdueCatchupRunning = true;
    try {
      const result = await processOverdueCatchUp();
      if (result.processed > 0) console.log(`[OverdueCatchUp/Timer] ${result.processed} processed, ${result.rescheduled} rescheduled, ${result.errors} errors`);
      await logTimerHeartbeat('timer_overdue_catchup_last_run');
    } catch (err) {
      console.error('[OverdueCatchUp/Timer] Error:', err);
    } finally {
      overdueCatchupRunning = false;
    }
  }, 60 * 60 * 1000); // Every 60 minutes

  // Run initial overdue catch-up 2 minutes after startup
  setTimeout(async () => {
    if (overdueCatchupRunning) return;
    overdueCatchupRunning = true;
    try {
      const result = await processOverdueCatchUp();
      console.log(`[OverdueCatchUp/Timer] Initial run: ${result.processed} processed, ${result.rescheduled} rescheduled, ${result.errors} errors`);
    } catch (err) {
      console.error('[OverdueCatchUp/Timer] Initial run error:', err);
    } finally {
      overdueCatchupRunning = false;
    }
  }, 2 * 60 * 1000);

  // --- LOOKBACK DRIP: Auto-analyze unprocessed leads every 30 minutes (5 per batch) ---
  let lookbackRunning = false;
  setInterval(async () => {
    if (lookbackRunning) return; // Prevent overlapping runs
    lookbackRunning = true;
    try {
      const result = await runLookback({
        maxLeads: 5,
        delayBetweenMs: 5000,
        onlyUnprocessed: true,
        skipResearch: false,
      });
      if (result.processed > 0) {
        console.log(`[Lookback/Timer] Drip: ${result.processed} analyzed (${result.engage} engage, ${result.skip} skip, ${result.caution} caution, ${result.humanNeeded} human, ${result.errors} errors)`);
      }
      await logTimerHeartbeat('timer_lookback_last_run');
    } catch (err) {
      console.error('[Lookback/Timer] Drip error:', err);
    } finally {
      lookbackRunning = false;
    }
  }, 30 * 60 * 1000);

  // Run initial lookback drip 2 minutes after startup
  setTimeout(async () => {
    if (lookbackRunning) return;
    lookbackRunning = true;
    try {
      const result = await runLookback({
        maxLeads: 5,
        delayBetweenMs: 5000,
        onlyUnprocessed: true,
        skipResearch: false,
      });
      console.log(`[Lookback/Timer] Initial drip: ${result.processed} analyzed (${result.engage} engage, ${result.skip} skip, ${result.errors} errors)`);
    } catch (err) {
      console.error('[Lookback/Timer] Initial drip error:', err);
    } finally {
      lookbackRunning = false;
    }
  }, 2 * 60 * 1000);

  // --- FAST MISSED-REPLY SCANNER: Catch unanswered inbound messages within 3 minutes ---
  // This runs every 2 minutes and only looks at messages from the last 5 minutes
  // to ensure the Council responds like a live agent within 3 minutes
  let fastScanRunning = false;
  setInterval(async () => {
    if (fastScanRunning) return;
    fastScanRunning = true;
    try {
      const { runFastMissedReplyScanner } = await import('./brain-council-review');
      const count = await runFastMissedReplyScanner();
      if (count > 0) console.log(`[FastScan/Timer] Responded to ${count} missed message(s) within 3-min window`);
      await logTimerHeartbeat('timer_fastscan_last_run');
    } catch (err) {
      console.error('[FastScan/Timer] Error:', err);
    } finally {
      fastScanRunning = false;
    }
  }, 2 * 60 * 1000);

  // --- BRAIN COUNCIL SELF-REVIEW: Detect and recover from mistakes every 30 minutes ---
  let councilReviewRunning = false;
  setInterval(async () => {
    if (councilReviewRunning) return;
    councilReviewRunning = true;
    try {
      const stats = await runBrainCouncilSelfReview();
      if (stats.recovered > 0) console.log(`[CouncilReview/Timer] ${stats.reviewed} reviewed, ${stats.recovered} recovered, ${stats.skipped} skipped, ${stats.errors} errors`);
      await logTimerHeartbeat('timer_selfreview_last_run');
    } catch (err) {
      console.error('[CouncilReview/Timer] Error:', err);
    } finally {
      councilReviewRunning = false;
    }
  }, 30 * 60 * 1000);
  // Run initial Council review 5 minutes after startup (give system time to settle)
  setTimeout(async () => {
    if (councilReviewRunning) return;
    councilReviewRunning = true;
    try {
      const stats = await runBrainCouncilSelfReview();
      console.log(`[CouncilReview/Timer] Initial review: ${stats.reviewed} reviewed, ${stats.recovered} recovered, ${stats.skipped} skipped, ${stats.errors} errors`);
    } catch (err) {
      console.error('[CouncilReview/Timer] Initial review error:', err);
    } finally {
      councilReviewRunning = false;
    }
  }, 5 * 60 * 1000);

  // --- LEAD DISPOSITION SWEEP: Clean up stuck/stale leads every 2 hours ---
  let dispositionRunning = false;
  setInterval(async () => {
    if (dispositionRunning) return;
    dispositionRunning = true;
    try {
      const stats = await runDispositionSweep();
      if (stats.processed > 0) {
        console.log(`[Disposition/Timer] ${stats.dncDisposed} DNC disposed, ${stats.emailEscalated} email escalated, ${stats.takeoverExpired} takeover expired, ${stats.errors} errors`);
      }
    } catch (err) {
      console.error('[Disposition/Timer] Error:', err);
    } finally {
      dispositionRunning = false;
    }
      await logTimerHeartbeat('timer_disposition_last_run');
  }, 30 * 60 * 1000); // Every 30 minutes (tightened from 2hr)

  // Run initial disposition sweep 3 minutes after startup
  setTimeout(async () => {
    if (dispositionRunning) return;
    dispositionRunning = true;
    try {
      const stats = await runDispositionSweep();
      console.log(`[Disposition/Timer] Initial sweep: ${stats.dncDisposed} DNC disposed, ${stats.emailEscalated} email escalated, ${stats.takeoverExpired} takeover expired, ${stats.errors} errors`);
    } catch (err) {
      console.error('[Disposition/Timer] Initial sweep error:', err);
    } finally {
      dispositionRunning = false;
    }
  }, 3 * 60 * 1000);

  // --- WEBHOOK HEALTH CHECK ---
  router.get("/api/webhooks/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      message: "Adorb Outreach webhook endpoint is healthy",
    });
  });

  // --- UNIFIED GHL WEBHOOK ENDPOINT ---
  router.post("/api/webhooks/ghl", async (req: Request, res: Response) => {
    const startTime = Date.now();
    const payload = normalizeWorkflowPayload(req.body);
    const contactId = (payload.contactId || payload.id || "") as string;
    let detectedType = "unknown";
    let action = "";
    let logError = "";

    try {
      detectedType = detectEventType(payload);

      const payloadSummary = JSON.stringify({
        ...Object.fromEntries(
          Object.entries(payload).map(([k, v]) => [
            k,
            typeof v === 'string' ? v.substring(0, 200) : v
          ])
        ),
      }).substring(0, 2000);

      switch (detectedType) {
        case "contact": {
          action = "contact_handler";
          // CONTACT-LEVEL MUTEX: Serialize concurrent webhooks for the same contact.
          // If an InboundMessage webhook is already processing this contact,
          // wait up to 5s for it to finish before proceeding.
          const contactLock = acquireContactLock(contactId);
          if (!contactLock.acquired) {
            console.log(`[Webhook/Mutex] Contact ${contactId}: waiting for concurrent webhook to finish`);
            await contactLock.waitForPrevious();
            // Re-acquire the lock now that the previous one is done
            acquireContactLock(contactId);
          }
          try {
            await handleContactWebhook(payload, res);
          } finally {
            releaseContactLock(contactId);
          }
          break;
        }
        case "message": {
          action = "message_handler";
          const msgBody = (payload.body || payload.message || "") as string;
          if (!acquireMessageLock(contactId, msgBody)) {
            action = "dedup_blocked";
            res.json({ success: true, action: "dedup_blocked" });
            break;
          }
          // CONTACT-LEVEL MUTEX: Serialize concurrent webhooks for the same contact.
          // If a ContactCreate webhook is already processing this contact,
          // wait up to 5s for it to finish before proceeding.
          const msgContactLock = acquireContactLock(contactId);
          if (!msgContactLock.acquired) {
            console.log(`[Webhook/Mutex] Message for contact ${contactId}: waiting for concurrent webhook to finish`);
            await msgContactLock.waitForPrevious();
            acquireContactLock(contactId);
          }
          try {
            await handleMessageWebhook(payload, res);
          } finally {
            releaseContactLock(contactId);
            releaseMessageLock(contactId, msgBody);
          }
          break;
        }
        case "pipeline": {
          action = "pipeline_handler";
          const pipelineStage = (payload.currentStage || payload.toStage || payload.stageName || "") as string;
          if (!acquirePipelineLock(contactId, pipelineStage)) {
            action = "pipeline_dedup_blocked";
            res.json({ success: true, action: "pipeline_dedup_blocked" });
            break;
          }
          try {
            await handlePipelineWebhook(payload, res);
          } finally {
            // Keep lock for 60s — do NOT release immediately, to block late-arriving duplicates
            // releasePipelineLock is intentionally NOT called here
          }
          break;
        }
        case "task":
          action = "task_handler";
          await handleTaskWebhook(payload, res);
          break;
        case "appointment":
          action = "appointment_handler";
          await handleAppointmentWebhook(payload, res);
          break;
        case "note":
          action = "note_handler";
          await handleNoteWebhook(payload, res);
          break;
        case "email_event":
          action = "email_event_handler";
          await handleEmailEventWebhook(payload, res);
          break;
        case "contact_dnd":
          action = "contact_dnd_handler";
          await handleContactDndWebhook(payload, res);
          break;
        case "opportunity":
          action = "opportunity_handler";
          await handleOpportunityWebhook(payload, res);
          break;
        default:
          if ((typeof payload.body === "string" && payload.body) || (typeof payload.message === "string" && payload.message) || payload.messageType) {
            action = "fallback_message";
            const fbMsgBody = String(payload.body || payload.message || "");
            if (!acquireMessageLock(contactId, fbMsgBody)) {
              action = "dedup_blocked";
              res.json({ success: true, action: "dedup_blocked" });
              break;
            }
            // Contact-level mutex for fallback message path
            const fbMsgContactLock = acquireContactLock(contactId);
            if (!fbMsgContactLock.acquired) {
              await fbMsgContactLock.waitForPrevious();
              acquireContactLock(contactId);
            }
            try {
              await handleMessageWebhook(payload, res);
            } finally {
              releaseContactLock(contactId);
              releaseMessageLock(contactId, fbMsgBody);
            }
          } else if (payload.currentStage || payload.toStage || payload.stageName || payload.pipelineId) {
            action = "fallback_pipeline";
            const fbPipelineStage = (payload.currentStage || payload.toStage || payload.stageName || "") as string;
            if (!acquirePipelineLock(contactId, fbPipelineStage)) {
              action = "pipeline_dedup_blocked";
              res.json({ success: true, action: "pipeline_dedup_blocked" });
              break;
            }
            await handlePipelineWebhook(payload, res);
          } else if (payload.id || payload.contactId) {
            action = "fallback_contact";
            // Contact-level mutex for fallback contact path
            const fbContactLock = acquireContactLock(contactId);
            if (!fbContactLock.acquired) {
              await fbContactLock.waitForPrevious();
              acquireContactLock(contactId);
            }
            try {
              await handleContactWebhook(payload, res);
            } finally {
              releaseContactLock(contactId);
            }
          } else {
            action = "unrecognized";
            res.json({ success: true, action: "unrecognized_event" });
          }
      }

      addWebhookLog({
        eventType: (payload.type || payload.event || "unknown") as string,
        detectedType,
        contactId: contactId || undefined,
        payloadSummary,
        action,
        processingMs: Date.now() - startTime,
      }).catch(() => {});

    } catch (err) {
      logError = err instanceof Error ? err.message : String(err);
      console.error("[Webhook] Error:", err);

      addWebhookLog({
        eventType: (payload?.type || payload?.event || "unknown") as string,
        detectedType,
        contactId: contactId || undefined,
        action,
        error: logError,
        processingMs: Date.now() - startTime,
      }).catch(() => {});

      if (!res.headersSent) {
        res.status(500).json({ error: "Internal error" });
      }
    }
  });

  // Keep legacy endpoints for backward compatibility
  router.post("/api/webhooks/ghl/contact", async (req: Request, res: Response) => {
    try { await handleContactWebhook(normalizeWorkflowPayload(req.body), res); } catch (err) {
      console.error("[Webhook] Contact error:", err); res.status(500).json({ error: "Internal error" });
    }
  });

  router.post("/api/webhooks/ghl/message", async (req: Request, res: Response) => {
    const legacyPayload = normalizeWorkflowPayload(req.body);
    const legacyContactId = (legacyPayload.contactId || legacyPayload.id || "") as string;
    const legacyMsgBody = (legacyPayload.body || legacyPayload.message || "") as string;
    if (!acquireMessageLock(legacyContactId, legacyMsgBody)) {
      res.json({ success: true, action: "dedup_blocked" });
      return;
    }
    try {
      await handleMessageWebhook(legacyPayload, res);
    } catch (err) {
      console.error("[Webhook] Message error:", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    } finally {
      releaseMessageLock(legacyContactId, legacyMsgBody);
    }
  });

  router.post("/api/webhooks/ghl/pipeline", async (req: Request, res: Response) => {
    const legacyPayload = normalizeWorkflowPayload(req.body);
    const legacyContactId = (legacyPayload.contactId || legacyPayload.id || "") as string;
    const legacyStage = (legacyPayload.currentStage || legacyPayload.toStage || legacyPayload.stageName || "") as string;
    if (!acquirePipelineLock(legacyContactId, legacyStage)) {
      res.json({ success: true, action: "pipeline_dedup_blocked" });
      return;
    }
    try { await handlePipelineWebhook(legacyPayload, res); } catch (err) {
      console.error("[Webhook] Pipeline error:", err); res.status(500).json({ error: "Internal error" });
    }
  });

  return router;
}
