import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { createWebhookRouter } from "../webhooks";
import { recalculateStaleSchedules } from "../scheduling-engine";
import { runSlaCheck } from "../sla-timer";
import { processPostDeliverySteps } from "../post-delivery-executor";
import { processSeasonalCampaigns } from "../seasonal-campaign-executor";
import { warmSlotPointersFromCalendar } from "../ghl";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  // GHL Webhook routes
  app.use(createWebhookRouter());
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);

    // --- STARTUP: Warm slot pointers from GHL calendar (prevent double-booking after restart) ---
    setTimeout(async () => {
      try {
        await warmSlotPointersFromCalendar();
        console.log(`[SlotQueue] Slot pointers warmed from GHL calendar`);
      } catch (err) {
        console.error(`[SlotQueue] Failed to warm slot pointers:`, err);
      }
    }, 10_000); // 10 seconds after startup

    // --- CRON: Recalculate stale schedules every hour ---
    // Handles: score decay, seasonal campaign eligibility, past-due follow-ups
    const RECALC_INTERVAL = 60 * 60 * 1000; // 1 hour
    setTimeout(async () => {
      try {
        console.log(`[Cron] Running initial stale schedule recalculation...`);
        const result = await recalculateStaleSchedules();
        console.log(`[Cron] Initial recalc: ${result.updated} updated, ${result.decayed} decayed, ${result.seasonal} seasonal`);
      } catch (err) {
        console.error(`[Cron] Initial recalc error:`, err);
      }
    }, 30_000); // First run 30 seconds after startup

    setInterval(async () => {
      try {
        console.log(`[Cron] Running hourly stale schedule recalculation...`);
        const result = await recalculateStaleSchedules();
        console.log(`[Cron] Hourly recalc: ${result.updated} updated, ${result.decayed} decayed, ${result.seasonal} seasonal`);
      } catch (err) {
        console.error(`[Cron] Hourly recalc error:`, err);
      }
    }, RECALC_INTERVAL);
    console.log(`[Cron] Stale schedule recalculation scheduled every ${RECALC_INTERVAL / 60000} minutes`);

    // --- CRON: Human Agent SLA Timer every 30 minutes ---
    const SLA_INTERVAL = 30 * 60 * 1000; // 30 minutes
    setTimeout(async () => {
      try {
        const result = await runSlaCheck();
        console.log(`[SLA/Timer] Initial SLA check: ${result.checked} checked, ${result.alerted} alerted`);
      } catch (err) {
        console.error(`[SLA/Timer] Initial SLA check error:`, err);
      }
    }, 45_000); // First run 45 seconds after startup

    setInterval(async () => {
      try {
        const result = await runSlaCheck();
        if (result.alerted > 0) {
          console.log(`[SLA/Timer] SLA check: ${result.checked} checked, ${result.alerted} alerted`);
        }
      } catch (err) {
        console.error(`[SLA/Timer] SLA check error:`, err);
      }
    }, SLA_INTERVAL);
    console.log(`[Cron] Human Agent SLA timer scheduled every ${SLA_INTERVAL / 60000} minutes`);

    // --- CRON: Post-Delivery Sequence Executor every 30 minutes ---
    const PD_INTERVAL = 30 * 60 * 1000;
    setTimeout(async () => {
      try {
        const result = await processPostDeliverySteps();
        console.log(`[PostDelivery/Timer] Initial run: ${result.sent} sent, ${result.skipped} skipped, ${result.errors} errors`);
      } catch (err) {
        console.error(`[PostDelivery/Timer] Initial run error:`, err);
      }
    }, 60_000); // First run 60 seconds after startup

    setInterval(async () => {
      try {
        const result = await processPostDeliverySteps();
        if (result.sent > 0 || result.errors > 0) {
          console.log(`[PostDelivery/Timer] Cycle: ${result.sent} sent, ${result.skipped} skipped, ${result.errors} errors`);
        }
      } catch (err) {
        console.error(`[PostDelivery/Timer] Cycle error:`, err);
      }
    }, PD_INTERVAL);
    console.log(`[Cron] Post-delivery executor scheduled every ${PD_INTERVAL / 60000} minutes`);

    // --- CRON: Seasonal Campaign Executor every 2 hours ---
    const SC_INTERVAL = 2 * 60 * 60 * 1000;
    setTimeout(async () => {
      try {
        const result = await processSeasonalCampaigns();
        console.log(`[SeasonalCampaign/Timer] Initial run: ${result.campaignsProcessed} campaigns, ${result.leadsScheduled} leads scheduled, ${result.errors} errors`);
      } catch (err) {
        console.error(`[SeasonalCampaign/Timer] Initial run error:`, err);
      }
    }, 90_000); // First run 90 seconds after startup

    setInterval(async () => {
      try {
        const result = await processSeasonalCampaigns();
        if (result.leadsScheduled > 0 || result.errors > 0) {
          console.log(`[SeasonalCampaign/Timer] Cycle: ${result.campaignsProcessed} campaigns, ${result.leadsScheduled} leads, ${result.errors} errors`);
        }
      } catch (err) {
        console.error(`[SeasonalCampaign/Timer] Cycle error:`, err);
      }
    }, SC_INTERVAL);
    console.log(`[Cron] Seasonal campaign executor scheduled every ${SC_INTERVAL / 60000} minutes`);

    // --- CRON: Stuck Processing Lock Cleaner every 5 minutes ---
    // Clears processingLockedAt values older than 5 minutes.
    // Prevents silent bot failures like the Rosemari incident where a stuck lock
    // silenced the bot indefinitely. The Brain Council lock TTL is 300s (5 min),
    // so any lock older than 5 min is definitively stuck (server crash, timeout, etc.).
    const STUCK_LOCK_INTERVAL = 5 * 60 * 1000; // 5 minutes
    const STUCK_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes
    setInterval(async () => {
      try {
        const { getDb } = await import("../db");
        const db = await getDb();
        if (!db) return;
        const { leads } = await import("../../drizzle/schema");
        const { sql: sqlFn, isNotNull } = await import("drizzle-orm");
        const cutoff = new Date(Date.now() - STUCK_LOCK_TTL_MS);
        const result = await db.update(leads)
          .set({ processingLockedAt: null })
          .where(sqlFn`processingLockedAt IS NOT NULL AND processingLockedAt < ${cutoff}`);
        const affected = (result as any)?.[0]?.affectedRows || 0;
        if (affected > 0) {
          console.log(`[StuckLockCleaner] Cleared ${affected} stuck processing lock(s) older than 5 minutes`);
        }
      } catch (err) {
        console.error(`[StuckLockCleaner] Error:`, err);
      }
    }, STUCK_LOCK_INTERVAL);
    console.log(`[Cron] Stuck processing lock cleaner scheduled every ${STUCK_LOCK_INTERVAL / 60000} minutes`);
  });
}

startServer().catch(console.error);
