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
import { detectEventType } from "./webhook-helpers";
import { handleContactWebhook } from "./webhook-contact";
import { handleMessageWebhook } from "./webhook-message";
import { handlePipelineWebhook } from "./webhook-pipeline";
import { handleTaskWebhook } from "./webhook-task";
import { retroactiveCorrectionScan } from "./auto-correction";

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
    const payload = req.body;
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
        case "message":
          action = "message_handler";
          await handleMessageWebhook(payload, res);
          break;
        case "pipeline":
          action = "pipeline_handler";
          await handlePipelineWebhook(payload, res);
          break;
        case "task":
          action = "task_handler";
          await handleTaskWebhook(payload, res);
          break;
        default:
          if (payload.body || payload.message || payload.messageType) {
            action = "fallback_message";
            await handleMessageWebhook(payload, res);
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
    try { await handleContactWebhook(req.body, res); } catch (err) {
      console.error("[Webhook] Contact error:", err); res.status(500).json({ error: "Internal error" });
    }
  });

  router.post("/api/webhooks/ghl/message", async (req: Request, res: Response) => {
    try { await handleMessageWebhook(req.body, res); } catch (err) {
      console.error("[Webhook] Message error:", err); res.status(500).json({ error: "Internal error" });
    }
  });

  router.post("/api/webhooks/ghl/pipeline", async (req: Request, res: Response) => {
    try { await handlePipelineWebhook(req.body, res); } catch (err) {
      console.error("[Webhook] Pipeline error:", err); res.status(500).json({ error: "Internal error" });
    }
  });

  return router;
}
