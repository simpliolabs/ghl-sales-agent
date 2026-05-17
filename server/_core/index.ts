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
import { processLostLeadNurture, processImportedContactNurture } from "../lost-lead-nurture";
import { warmSlotPointersFromCalendar } from "../ghl";
import { ENV } from "./env";
import { startOutboxWorker } from "../outbox-worker";
import { startPR3Monitor } from "../pr3-verification-monitor";

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

    // --- Phase 1: Start the Outbox drain worker ---
    // The outbox worker polls every 5s and processes pending outbound messages.
    // This is the ONLY path through which outbound messages should be sent.
    startOutboxWorker();

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

    // --- CRON: Post-Delivery Sequence Executor every 30 minutes --- [LEGACY: gated by DISABLE_LEGACY_TIMERS]
    if (!ENV.disableLegacyTimers) {
      const PD_INTERVAL = 30 * 60 * 1000;
      setTimeout(async () => {
        try {
          const result = await processPostDeliverySteps();
          console.log(`[PostDelivery/Timer] Initial run: ${result.sent} sent, ${result.skipped} skipped, ${result.errors} errors`);
        } catch (err) {
          console.error(`[PostDelivery/Timer] Initial run error:`, err);
        }
      }, 60_000);
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
    } else {
      console.log(`[Phase0] Post-delivery timer DISABLED by DISABLE_LEGACY_TIMERS`);
    }

    // --- CRON: Seasonal Campaign Executor every 2 hours --- [LEGACY: gated by DISABLE_LEGACY_TIMERS]
    if (!ENV.disableLegacyTimers) {
      const SC_INTERVAL = 2 * 60 * 60 * 1000;
      setTimeout(async () => {
        try {
          const result = await processSeasonalCampaigns();
          console.log(`[SeasonalCampaign/Timer] Initial run: ${result.campaignsProcessed} campaigns, ${result.leadsScheduled} leads scheduled, ${result.errors} errors`);
        } catch (err) {
          console.error(`[SeasonalCampaign/Timer] Initial run error:`, err);
        }
      }, 90_000);
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
    } else {
      console.log(`[Phase0] Seasonal campaign timer DISABLED by DISABLE_LEGACY_TIMERS`);
    }

    // --- PR#3 Verification Monitor (TEMPORARY — remove after verifications captured) ---
    startPR3Monitor();

    // --- CRON: Stuck Processing Lock Cleaner every 5 minutes ---
    // Clears processingLockedAt values older than 5 minutes.
    // Prevents silent bot failures like the Rosemari incident where a stuck lock
    // silenced the bot indefinitely. The Brain Council lock TTL is 300s (5 min),
    // so any lock older than 5 min is definitively stuck (server crash, timeout, etc.).
    const STUCK_LOCK_INTERVAL = 2 * 60 * 1000; // Phase 0: Reduced from 5min→2min to match new 120s lock TTL
    const STUCK_LOCK_TTL_MS = 2 * 60 * 1000; // Phase 0: Reduced from 5min→2min to match new 120s lock TTL
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

    // --- CRON: Lost Lead Quarterly Nurture — runs once daily at 8 AM ET --- [LEGACY: gated by DISABLE_LEGACY_TIMERS]
    if (!ENV.disableLegacyTimers) {
      const LOST_NURTURE_INTERVAL = 24 * 60 * 60 * 1000;
      const now = new Date();
      const etHour = parseInt(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }).format(now));
      const msUntilFirstRun = etHour < 8
        ? (() => { const next8am = new Date(now); next8am.setHours(now.getHours() + (8 - etHour), 0, 0, 0); return next8am.getTime() - now.getTime(); })()
        : 5 * 60 * 1000;
      setTimeout(async () => {
        try {
          const result = await processLostLeadNurture();
          if (result.sent > 0 || result.errors > 0) {
            console.log(`[LostNurture/Timer] Initial run: ${result.sent} sent, ${result.skipped} skipped, ${result.errors} errors`);
          }
        } catch (err) {
          console.error(`[LostNurture/Timer] Initial run error:`, err);
        }
        setInterval(async () => {
          try {
            const result = await processLostLeadNurture();
            if (result.sent > 0 || result.errors > 0) {
              console.log(`[LostNurture/Timer] Daily cycle: ${result.sent} sent, ${result.skipped} skipped, ${result.errors} errors`);
            }
          } catch (err) {
            console.error(`[LostNurture/Timer] Daily cycle error:`, err);
          }
        }, LOST_NURTURE_INTERVAL);
      }, msUntilFirstRun);
      console.log(`[Cron] Lost lead nurture scheduled daily (first run in ${Math.round(msUntilFirstRun / 60000)} minutes)`);
    } else {
      console.log(`[Phase0] Lost lead nurture timer DISABLED by DISABLE_LEGACY_TIMERS`);
    }

    // --- CRON: Monthly import contact nurture (email-only, 30-day cadence) --- [LEGACY: gated by DISABLE_LEGACY_TIMERS]
    if (!ENV.disableLegacyTimers) {
      const IMPORT_NURTURE_INTERVAL = 6 * 60 * 60 * 1000;
      setTimeout(async () => {
        try {
          const result = await processImportedContactNurture();
          if (result.sent > 0 || result.errors > 0) {
            console.log(`[ImportNurture/Timer] Initial run: ${result.sent} sent, ${result.blocked} blocked, ${result.skipped} skipped, ${result.errors} errors`);
          }
        } catch (err) {
          console.error(`[ImportNurture/Timer] Initial run error:`, err);
        }
        setInterval(async () => {
          try {
            const result = await processImportedContactNurture();
            if (result.sent > 0 || result.errors > 0) {
              console.log(`[ImportNurture/Timer] Cycle: ${result.sent} sent, ${result.blocked} blocked, ${result.skipped} skipped, ${result.errors} errors`);
            }
          } catch (err) {
            console.error(`[ImportNurture/Timer] Cycle error:`, err);
          }
        }, IMPORT_NURTURE_INTERVAL);
      }, 30 * 60 * 1000);
      console.log(`[Cron] Monthly import contact nurture scheduled (first run in 30 minutes, then every 6 hours)`);
    } else {
      console.log(`[Phase0] Import nurture timer DISABLED by DISABLE_LEGACY_TIMERS`);
    }

    // --- CRON: Process deferred responses (agent-first delay) every 2 minutes ---
    const DEFERRED_INTERVAL = 2 * 60 * 1000; // 2 minutes
    setInterval(async () => {
      try {
        const { processDeferredResponses } = await import("../deferred-response-processor");
        const result = await processDeferredResponses();
        if (result.sent > 0 || result.cancelled > 0) {
          console.log(`[DeferredResponse/Timer] ${result.sent} sent, ${result.cancelled} cancelled, ${result.errors} errors`);
        }
      } catch (err) {
        console.error("[DeferredResponse/Timer] Error:", err);
      }
    }, DEFERRED_INTERVAL);
    console.log(`[Cron] Deferred response processor scheduled every ${DEFERRED_INTERVAL / 60000} minutes`);

    // --- CRON: Event-Driven Triggers (Module 5A) every 30 minutes --- [LEGACY: gated by DISABLE_LEGACY_TIMERS]
    if (!ENV.disableLegacyTimers) {
      const EVENT_TRIGGER_INTERVAL = 30 * 60 * 1000;
      setInterval(async () => {
        try {
          const { processEventDrivenTriggers } = await import("../event-driven-triggers");
          const result = await processEventDrivenTriggers();
          if (result.triggered > 0 || result.errors > 0) {
            console.log(`[EventTrigger/Timer] ${result.triggered} triggered, ${result.skipped} skipped, ${result.errors} errors`);
            for (const d of result.details) {
              console.log(`  → ${d.trigger}: Lead ${d.leadId} (${d.leadName})`);
            }
          }
        } catch (err) {
          console.error("[EventTrigger/Timer] Error:", err);
        }
      }, EVENT_TRIGGER_INTERVAL);
      console.log(`[Cron] Event-driven triggers scheduled every ${EVENT_TRIGGER_INTERVAL / 60000} minutes`);
    } else {
      console.log(`[Phase0] Event-driven triggers timer DISABLED by DISABLE_LEGACY_TIMERS`);
    }

    // --- CRON: Weekly Monday Review (Decisions 4B, 12) --- [LEGACY: gated by DISABLE_LEGACY_TIMERS]
    if (!ENV.disableLegacyTimers) {
      const WEEKLY_CHECK_INTERVAL = 6 * 60 * 60 * 1000;
      const isMonday = () => new Date().getDay() === 1;
      let lastWeeklyRunWeek = -1;
      const getIsoWeek = () => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
        const week1 = new Date(d.getFullYear(), 0, 4);
        return 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
      };

      setTimeout(async () => {
        try {
          const { evaluateAllExperiments } = await import("../ab-testing");
          const evalResult = await evaluateAllExperiments();
          if (evalResult.evaluated > 0) {
            console.log(`[ABTest/Init] Evaluated ${evalResult.evaluated}, completed ${evalResult.completed}, adopted ${evalResult.adopted}`);
          }
        } catch (err) {
          console.error("[ABTest/Init] Initial evaluation error:", err);
        }
      }, 5 * 60 * 1000);

      setInterval(async () => {
        if (!isMonday()) return;
        const currentWeek = getIsoWeek();
        if (currentWeek === lastWeeklyRunWeek) return;
        lastWeeklyRunWeek = currentWeek;

        console.log(`[WeeklyReview] Starting Monday weekly review (week ${currentWeek})...`);

        try {
          const { runAutoSkillHunter } = await import("../auto-skill-hunter");
          const result = await runAutoSkillHunter();
          if (result.proposalsCreated > 0) {
            console.log(`[WeeklyReview/Skills] ${result.patternsFound} patterns, ${result.proposalsCreated} proposed, ${result.skippedCooldown} on cooldown`);
          }
        } catch (err) {
          console.error("[WeeklyReview/Skills] Error:", err);
        }

        try {
          const { autoAdoptMatureProposals } = await import("../auto-skill-hunter");
          const adoptResult = await autoAdoptMatureProposals();
          if (adoptResult.adopted > 0) {
            console.log(`[WeeklyReview/Adopt] Auto-adopted ${adoptResult.adopted} mature proposals (checked ${adoptResult.checked})`);
          }
        } catch (err) {
          console.error("[WeeklyReview/Adopt] Error:", err);
        }

        try {
          const { autoSeedExperiments, evaluateAllExperiments } = await import("../ab-testing");
          const evalResult = await evaluateAllExperiments();
          if (evalResult.evaluated > 0) {
            console.log(`[WeeklyReview/AB] Evaluated ${evalResult.evaluated}, completed ${evalResult.completed}, adopted ${evalResult.adopted}`);
          }
          const seedResult = await autoSeedExperiments();
          if (seedResult.created > 0) {
            console.log(`[WeeklyReview/AB] Seeded ${seedResult.created} new experiment(s)`);
          }
        } catch (err) {
          console.error("[WeeklyReview/AB] Error:", err);
        }

        try {
          const { runStrategyReview } = await import("../strategy-autopilot");
          const stratResult = await runStrategyReview();
          if (stratResult.proposed > 0) {
            console.log(`[WeeklyReview/Strategy] Proposed ${stratResult.proposed} adjustments, expired ${stratResult.expired}`);
          }
        } catch (err) {
          console.error("[WeeklyReview/Strategy] Error:", err);
        }

        // Step 4: Training Data Export (collect winning pairs for future use)
        try {
          const { createTrainingExport } = await import("../training-export");
          const exportResult = await createTrainingExport(`weekly-${new Date().toISOString().slice(0,10)}`, { onlyReplied: true });
          console.log(`[WeeklyReview/TrainingExport] Export ${exportResult?.id || 'unknown'} created (status: ${exportResult?.status || 'unknown'})`);
        } catch (err) {
          console.error("[WeeklyReview/TrainingExport] Error:", err);
        }

        console.log(`[WeeklyReview] Monday weekly review complete.`);
      }, WEEKLY_CHECK_INTERVAL);
      console.log(`[Cron] Weekly Monday Review (Skills + A/B) scheduled — checks every ${WEEKLY_CHECK_INTERVAL / 3600000}h, executes on Monday`);
    } else {
      console.log(`[Phase0] Weekly review timer DISABLED by DISABLE_LEGACY_TIMERS`);
    }
  });
}

startServer().catch(console.error);
