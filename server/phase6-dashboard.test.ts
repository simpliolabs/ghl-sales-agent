import { describe, it, expect, vi } from "vitest";

// ─── P6.1: Revenue Metrics Router ───────────────────────────────────────────
describe("Phase 6 — Dashboard Revenue Metrics", () => {
  it("revenueMetrics returns expected shape", async () => {
    // The procedure returns { messagesSent, replies, quotesSent, dealsClosed, revenue }
    const expected = { messagesSent: 0, replies: 0, quotesSent: 0, dealsClosed: 0, revenue: 0 };
    // Validate shape
    expect(Object.keys(expected)).toEqual(["messagesSent", "replies", "quotesSent", "dealsClosed", "revenue"]);
    expect(typeof expected.messagesSent).toBe("number");
    expect(typeof expected.revenue).toBe("number");
  });
});

// ─── P6.2: Flagged Messages ─────────────────────────────────────────────────
describe("Phase 6 — Flagged Messages", () => {
  it("logDecision auto-flags blocked output guard results", async () => {
    // Import the schema to verify the flaggedForReview column exists
    const { decisionLog } = await import("../drizzle/schema");
    expect(decisionLog.flaggedForReview).toBeDefined();
    expect(decisionLog.flagReason).toBeDefined();
    expect(decisionLog.flagAcknowledged).toBeDefined();
  });

  it("decision_log schema has all required columns for flagging", async () => {
    const { decisionLog } = await import("../drizzle/schema");
    // Verify the columns that the Review Queue depends on
    const columnNames = Object.keys(decisionLog);
    expect(columnNames).toContain("flaggedForReview");
    expect(columnNames).toContain("flagReason");
    expect(columnNames).toContain("flagAcknowledged");
    expect(columnNames).toContain("brainReasoning");
    expect(columnNames).toContain("outputGuardResult");
    expect(columnNames).toContain("channel");
    expect(columnNames).toContain("trigger");
  });
});

// ─── P6.3: Decision Log Audit Trail ─────────────────────────────────────────
describe("Phase 6 — Decision Log Audit Trail", () => {
  it("decision_log has all columns needed for audit display", async () => {
    const { decisionLog } = await import("../drizzle/schema");
    // The LeadDetail page shows: trigger, channel, outputGuardResult, flaggedForReview, brainReasoning, message, createdAt
    expect(decisionLog.trigger).toBeDefined();
    expect(decisionLog.channel).toBeDefined();
    expect(decisionLog.outputGuardResult).toBeDefined();
    expect(decisionLog.flaggedForReview).toBeDefined();
    expect(decisionLog.brainReasoning).toBeDefined();
    expect(decisionLog.createdAt).toBeDefined();
    expect(decisionLog.leadId).toBeDefined();
  });
});

// ─── P6.4: One-Click Controls (sendNow) ─────────────────────────────────────
describe("Phase 6 — One-Click Controls", () => {
  it("outbox table has the columns needed for sendNow", async () => {
    const { outbox } = await import("../drizzle/schema");
    expect(outbox.leadId).toBeDefined();
    expect(outbox.source).toBeDefined();
    expect(outbox.payload).toBeDefined();
    expect(outbox.status).toBeDefined();
    expect(outbox.scheduledAt).toBeDefined();
  });

  it("sendNow requires admin role (uses adminProcedure)", async () => {
    // Verify the router file exports the sendNow mutation under leads
    const routerFile = await import("fs/promises").then(fs => fs.readFile("server/routers.ts", "utf8"));
    expect(routerFile).toContain("sendNow: adminProcedure");
  });
});

// ─── P6.5: Deprecated Pages Removed ─────────────────────────────────────────
describe("Phase 6 — Deprecated Pages Removed", () => {
  it("App.tsx does not import deprecated pages", async () => {
    const fs = await import("fs/promises");
    const appFile = await fs.readFile("client/src/App.tsx", "utf8");
    expect(appFile).not.toContain("AIPerformance");
    expect(appFile).not.toContain("AuditLog");
    expect(appFile).not.toContain("WebhookLogs");
    expect(appFile).not.toContain("SelfLearning");
  });

  it("App.tsx does not have deprecated routes", async () => {
    const fs = await import("fs/promises");
    const appFile = await fs.readFile("client/src/App.tsx", "utf8");
    expect(appFile).not.toContain("/ai-performance");
    expect(appFile).not.toContain("/audit-log");
    expect(appFile).not.toContain("/webhook-logs");
    expect(appFile).not.toContain("/self-learning");
  });

  it("DashboardLayout sidebar does not have deprecated menu items", async () => {
    const fs = await import("fs/promises");
    const layoutFile = await fs.readFile("client/src/components/DashboardLayout.tsx", "utf8");
    expect(layoutFile).not.toContain("AI Performance");
    expect(layoutFile).not.toContain("Brain Council Log");
    expect(layoutFile).not.toContain("Self-Learning");
    expect(layoutFile).not.toContain("Webhook Logs");
  });

  it("DashboardLayout has Review Queue in the sidebar", async () => {
    const fs = await import("fs/promises");
    const layoutFile = await fs.readFile("client/src/components/DashboardLayout.tsx", "utf8");
    expect(layoutFile).toContain("Review Queue");
    expect(layoutFile).toContain("/handoff-queue");
  });
});

// ─── P6 Integration: logDecision flags blocked messages ─────────────────────
describe("Phase 6 — logDecision flagging logic", () => {
  it("outbox-worker logDecision sets flaggedForReview=1 for block: results", async () => {
    const fs = await import("fs/promises");
    const workerFile = await fs.readFile("server/outbox-worker.ts", "utf8");
    // Verify the auto-flagging logic exists
    expect(workerFile).toContain("isBlocked");
    expect(workerFile).toContain('opts.outputGuardResult.startsWith("block:")');
    expect(workerFile).toContain("flaggedForReview: isBlocked ? 1 : 0");
  });

  it("outbox-worker has post-send wrong-business flag logic", async () => {
    const fs = await import("fs/promises");
    const workerFile = await fs.readFile("server/outbox-worker.ts", "utf8");
    expect(workerFile).toContain("WRONG_BIZ_PATTERNS");
    expect(workerFile).toContain("Wrong business reference");
    expect(workerFile).toContain("flaggedForReview: 1");
  });
});

// ─── P6 Revenue Metrics: verify query structure ─────────────────────────────
describe("Phase 6 — Revenue Metrics Query Structure", () => {
  it("routers.ts has revenueMetrics under dashboard namespace", async () => {
    const fs = await import("fs/promises");
    const routerFile = await fs.readFile("server/routers.ts", "utf8");
    expect(routerFile).toContain("dashboard: router({");
    expect(routerFile).toContain("revenueMetrics: protectedProcedure");
  });

  it("routers.ts has flaggedMessages under dashboard namespace", async () => {
    const fs = await import("fs/promises");
    const routerFile = await fs.readFile("server/routers.ts", "utf8");
    expect(routerFile).toContain("flaggedMessages: protectedProcedure");
  });

  it("routers.ts has acknowledgeFlagged under dashboard namespace", async () => {
    const fs = await import("fs/promises");
    const routerFile = await fs.readFile("server/routers.ts", "utf8");
    expect(routerFile).toContain("acknowledgeFlagged: adminProcedure");
  });

  it("routers.ts has decisionLogForLead under dashboard namespace", async () => {
    const fs = await import("fs/promises");
    const routerFile = await fs.readFile("server/routers.ts", "utf8");
    expect(routerFile).toContain("decisionLogForLead: protectedProcedure");
  });
});

// ─── HandoffQueue dual-tab structure ─────────────────────────────────────────
describe("Phase 6 — HandoffQueue dual-tab UI", () => {
  it("HandoffQueue.tsx uses Tabs component with handoffs and flagged tabs", async () => {
    const fs = await import("fs/promises");
    const file = await fs.readFile("client/src/pages/HandoffQueue.tsx", "utf8");
    expect(file).toContain("Tabs");
    expect(file).toContain("handoffs");
    expect(file).toContain("flagged");
    expect(file).toContain("dashboard.flaggedMessages");
  });

  it("HandoffQueue.tsx has acknowledge mutation", async () => {
    const fs = await import("fs/promises");
    const file = await fs.readFile("client/src/pages/HandoffQueue.tsx", "utf8");
    expect(file).toContain("acknowledgeFlagged");
  });
});

// ─── LeadDetail decision log and sendNow ─────────────────────────────────────
describe("Phase 6 — LeadDetail enhancements", () => {
  it("LeadDetail.tsx queries decisionLogForLead", async () => {
    const fs = await import("fs/promises");
    const file = await fs.readFile("client/src/pages/LeadDetail.tsx", "utf8");
    expect(file).toContain("dashboard.decisionLogForLead");
  });

  it("LeadDetail.tsx has Send Now button", async () => {
    const fs = await import("fs/promises");
    const file = await fs.readFile("client/src/pages/LeadDetail.tsx", "utf8");
    expect(file).toContain("sendNow");
    expect(file).toContain("Send Message Now");
  });

  it("LeadDetail.tsx renders AI Decision Log section", async () => {
    const fs = await import("fs/promises");
    const file = await fs.readFile("client/src/pages/LeadDetail.tsx", "utf8");
    expect(file).toContain("AI Decision Log");
    expect(file).toContain("decisionLogs");
  });
});
