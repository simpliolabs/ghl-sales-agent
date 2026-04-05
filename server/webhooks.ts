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
import { retroactiveCorrectionScan } from "./auto-correction";
import { backfillOutcomes } from "./outcome-engine";
import { processOverdueFollowUps } from "./follow-up-trigger";
import { runLookback } from "./lookback-engine";

// --- IN-MEMORY DEDUP LOCK ---
// Prevents concurrent processing of the same message webhook.
// Key: contactId + messageBody hash, Value: timestamp of lock acquisition.
// Locks expire after 30 seconds to handle crashes/timeouts.
const MESSAGE_DEDUP_LOCK = new Map<string, number>();
const DEDUP_LOCK_TTL_MS = 30_000;

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

  // --- FOLLOW-UP TRIGGER: Process overdue leads every 10 minutes ---
  setInterval(async () => {
    try {
      const result = await processOverdueFollowUps();
      if (result.processed > 0) console.log(`[FollowUp/Timer] ${result.sent} sent, ${result.skipped} skipped, ${result.errors} errors`);
    } catch (err) {
      console.error('[FollowUp/Timer] Error:', err);
    }
  }, 10 * 60 * 1000);

  // Run initial follow-up check 90s after startup
  setTimeout(async () => {
    try {
      const result = await processOverdueFollowUps();
      console.log(`[FollowUp/Timer] Initial run: ${result.sent} sent, ${result.skipped} skipped, ${result.errors} errors`);
    } catch (err) {
      console.error('[FollowUp/Timer] Initial run error:', err);
    }
  }, 90 * 1000);

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
        case "contact":
          action = "contact_handler";
          await handleContactWebhook(payload, res);
          break;
        case "message": {
          action = "message_handler";
          const msgBody = (payload.body || payload.message || "") as string;
          if (!acquireMessageLock(contactId, msgBody)) {
            action = "dedup_blocked";
            res.json({ success: true, action: "dedup_blocked" });
            break;
          }
          try {
            await handleMessageWebhook(payload, res);
          } finally {
            releaseMessageLock(contactId, msgBody);
          }
          break;
        }
        case "pipeline":
          action = "pipeline_handler";
          await handlePipelineWebhook(payload, res);
          break;
        case "task":
          action = "task_handler";
          await handleTaskWebhook(payload, res);
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
            try {
              await handleMessageWebhook(payload, res);
            } finally {
              releaseMessageLock(contactId, fbMsgBody);
            }
          } else if (payload.currentStage || payload.toStage || payload.stageName || payload.pipelineId) {
            action = "fallback_pipeline";
            await handlePipelineWebhook(payload, res);
          } else if (payload.id || payload.contactId) {
            action = "fallback_contact";
            await handleContactWebhook(payload, res);
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
    try { await handlePipelineWebhook(normalizeWorkflowPayload(req.body), res); } catch (err) {
      console.error("[Webhook] Pipeline error:", err); res.status(500).json({ error: "Internal error" });
    }
  });

  return router;
}
