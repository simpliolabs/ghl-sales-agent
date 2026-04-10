import { describe, it, expect } from "vitest";

/**
 * Supervisor tests — structural validation of the invariant enforcement engine.
 * These tests verify the module's exports, types, and configuration without
 * hitting the database (which would require a full integration test setup).
 */

describe("Supervisor Module", () => {
  it("exports runSupervisorCycle function", async () => {
    const mod = await import("./supervisor");
    expect(typeof mod.runSupervisorCycle).toBe("function");
  });

  it("exports runAndStoreSupervisorCycle function", async () => {
    const mod = await import("./supervisor");
    expect(typeof mod.runAndStoreSupervisorCycle).toBe("function");
  });

  it("exports getSupervisorStatus function", async () => {
    const mod = await import("./supervisor");
    expect(typeof mod.getSupervisorStatus).toBe("function");
  });

  it("exports logTimerHeartbeat function", async () => {
    const mod = await import("./supervisor");
    expect(typeof mod.logTimerHeartbeat).toBe("function");
  });

  it("runSupervisorCycle is an async function that returns a Promise", async () => {
    const mod = await import("./supervisor");
    // Verify it's callable and returns a thenable (don't actually run it — requires DB)
    expect(typeof mod.runSupervisorCycle).toBe("function");
    expect(mod.runSupervisorCycle.constructor.name).toBe("AsyncFunction");
  });

  it("getSupervisorStatus returns structured status when no DB", async () => {
    const mod = await import("./supervisor");
    const status = await mod.getSupervisorStatus();
    expect(status).toHaveProperty("healthy");
    expect(status).toHaveProperty("lastCycle");
    expect(status).toHaveProperty("timerHealth");
    // In test environment, DB is connected so healthy can be true or false
    expect(typeof status.healthy).toBe("boolean");
    expect(status.timerHealth).toHaveProperty("healthy");
    expect(status.timerHealth).toHaveProperty("timers");
  });
});

describe("Supervisor Invariant Coverage", () => {
  it("covers all 9 invariants in the source code", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("server/supervisor.ts", "utf-8");

    const invariants = [
      "has_future_schedule",
      "has_segment",
      "has_research",
      "human_takeover_stale",
      "no_channel_dnd_conflict",
      "score_is_current",
      "not_orphaned",
      "circuit_breaker_not_stuck",
      "long_lead_not_neglected",
    ];

    for (const inv of invariants) {
      expect(source).toContain(`invariant: "${inv}"`);
    }
  });

  it("has both violation and correction fields for every invariant push", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("server/supervisor.ts", "utf-8");

    // Every violations.push should have invariant, leadId, violation, correction, success
    // Use dotAll flag to match across newlines within push blocks
    const pushBlocks = source.match(/violations\.push\(\{[\s\S]*?\}\)/g) || [];
    expect(pushBlocks.length).toBeGreaterThanOrEqual(9); // At least one per invariant

    for (const block of pushBlocks) {
      expect(block).toContain("invariant:");
      expect(block).toContain("leadId:");
      expect(block).toContain("violation:");
      expect(block).toContain("correction:");
      expect(block).toContain("success:");
    }
  });
});

describe("Supervisor Timer Configuration", () => {
  it("monitors all critical timers", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("server/supervisor.ts", "utf-8");

    const expectedTimers = [
      "timer_followup_last_run",
      "timer_lookback_last_run",
      "timer_fastscan_last_run",
      "timer_selfreview_last_run",
      "timer_disposition_last_run",
      "timer_outcomes_last_run",
      "timer_overdue_catchup_last_run",
    ];

    for (const timer of expectedTimers) {
      expect(source).toContain(timer);
    }
  });

  it("all timer heartbeats are wired in webhooks.ts", async () => {
    const fs = await import("fs");
    const webhooks = fs.readFileSync("server/webhooks.ts", "utf-8");

    const heartbeats = [
      "timer_followup_last_run",
      "timer_lookback_last_run",
      "timer_fastscan_last_run",
      "timer_selfreview_last_run",
      "timer_disposition_last_run",
      "timer_outcomes_last_run",
      "timer_overdue_catchup_last_run",
    ];

    for (const hb of heartbeats) {
      expect(webhooks).toContain(`logTimerHeartbeat('${hb}')`);
    }
  });

  it("supervisor runs on a 5-minute interval in webhooks.ts", async () => {
    const fs = await import("fs");
    const webhooks = fs.readFileSync("server/webhooks.ts", "utf-8");
    expect(webhooks).toContain("5 * 60 * 1000");
    expect(webhooks).toContain("runAndStoreSupervisorCycle");
  });
});

describe("Supervisor Schema", () => {
  it("supervisor_audit table is defined in schema", async () => {
    const fs = await import("fs");
    const schema = fs.readFileSync("drizzle/schema.ts", "utf-8");
    expect(schema).toContain("supervisorAudit");
    expect(schema).toContain("cycleId");
    expect(schema).toContain("invariant");
    expect(schema).toContain("violation");
    expect(schema).toContain("correction");
    expect(schema).toContain("success");
  });
});

describe("Supervisor API Endpoints", () => {
  it("supervisor endpoints exist in routers.ts", async () => {
    const fs = await import("fs");
    const routers = fs.readFileSync("server/routers.ts", "utf-8");
    expect(routers).toContain("supervisorStatus");
    expect(routers).toContain("triggerSupervisor");
    expect(routers).toContain("supervisorAuditLog");
  });
});

describe("Supervisor Dashboard UI", () => {
  it("Home.tsx includes Supervisor Health panel", async () => {
    const fs = await import("fs");
    const home = fs.readFileSync("client/src/pages/Home.tsx", "utf-8");
    expect(home).toContain("Supervisor Health");
    expect(home).toContain("supervisorStatus");
    expect(home).toContain("triggerSupervisor");
    expect(home).toContain("Timer Health");
    expect(home).toContain("Recent Corrections");
  });
});
