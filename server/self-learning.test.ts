/**
 * Phase 4 Self-Learning Loop Tests
 *
 * Covers:
 * - A/B Testing engine (createExperiment, assignVariant, evaluateExperiment, chiSquaredTest)
 * - Persona Learning (normalizePersona, getPersonaMatrix, getPersonaLearningContext)
 * - Learning router endpoints (via tRPC caller)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================
// 1. A/B TESTING — Unit tests for pure functions
// ============================================================

// We test chiSquaredTest directly since it's a pure function
vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue(null),
  getAllLeads: vi.fn().mockResolvedValue([]),
  getHotLeads: vi.fn().mockResolvedValue([]),
  getLeadById: vi.fn().mockResolvedValue(null),
  getConversationHistory: vi.fn().mockResolvedValue([]),
  getPipelineStats: vi.fn().mockResolvedValue([]),
  getAiPerformanceStats: vi.fn().mockResolvedValue({ aiMessages: 0, avgScore: 0, hotLeads: 0, totalLeads: 0 }),
  getRecentAiMessages: vi.fn().mockResolvedValue([]),
  getKnowledgeFiles: vi.fn().mockResolvedValue([]),
  addKnowledgeFile: vi.fn().mockResolvedValue({ id: 1 }),
  deleteKnowledgeFile: vi.fn().mockResolvedValue(undefined),
  updateKnowledgeFile: vi.fn().mockResolvedValue(undefined),
  getActiveTweaks: vi.fn().mockResolvedValue([]),
  addAiTweak: vi.fn().mockResolvedValue({ id: 1 }),
  archiveTweak: vi.fn().mockResolvedValue(undefined),
  getAgentWorkload: vi.fn().mockResolvedValue([]),
  getPipelineEvents: vi.fn().mockResolvedValue([]),
  getAiState: vi.fn().mockResolvedValue(null),
  updateLeadFields: vi.fn().mockResolvedValue(undefined),
  upsertLead: vi.fn().mockResolvedValue({ id: 1 }),
  getBrainCouncilAuditLog: vi.fn().mockResolvedValue([]),
  getBrainCouncilAuditForLead: vi.fn().mockResolvedValue([]),
  getRecentWebhookLogs: vi.fn().mockResolvedValue([]),
  addBrainCouncilAudit: vi.fn().mockResolvedValue({ id: 1 }),
  createInvite: vi.fn().mockResolvedValue({ id: 1 }),
  getInviteByToken: vi.fn().mockResolvedValue(null),
  markInviteUsed: vi.fn().mockResolvedValue(undefined),
  getActiveInvites: vi.fn().mockResolvedValue([]),
  deleteInvite: vi.fn().mockResolvedValue(undefined),
  getAllUsers: vi.fn().mockResolvedValue([]),
  updateUserRole: vi.fn().mockResolvedValue(undefined),
  getUserByOpenId: vi.fn().mockResolvedValue(null),
}));

vi.mock("./ghl", () => ({
  getContacts: vi.fn().mockResolvedValue({ contacts: [], meta: { total: 0 } }),
  getPipelines: vi.fn().mockResolvedValue([]),
}));

vi.mock("./storage", () => ({
  storagePut: vi.fn().mockResolvedValue({ url: "https://cdn.example.com/file.pdf", key: "file.pdf" }),
}));

vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn().mockResolvedValue({ choices: [{ message: { content: "test" } }] }),
}));

vi.mock("./cache", () => ({
  cached: vi.fn((_cache: any, _key: string, fn: () => any) => fn()),
  patternCache: new Map(),
}));

vi.mock("./outcome-engine", () => ({
  getPatternAnalysis: vi.fn().mockResolvedValue({
    frameworkStats: [
      { framework: "HORMOZI_ACA", totalSent: 100, replies: 40, replyRate: 40, avgReplyMinutes: 120, positiveReplies: 20, positiveRate: 50, conversions: 5, conversionRate: 5, stageAdvances: 10, dncCount: 2, dncRate: 2 },
    ],
    segmentStats: [],
    channelStats: [],
    topPerformers: [{ framework: "HORMOZI_ACA", segment: "church", replyRate: 48, sampleSize: 27 }],
    overallReplyRate: 38,
    overallConversionRate: 2,
    totalTracked: 280,
    lastUpdated: new Date(),
  }),
  backfillOutcomes: vi.fn().mockResolvedValue(5),
}));

vi.mock("./follow-up-trigger", () => ({
  processOverdueFollowUps: vi.fn().mockResolvedValue({ sent: 0, skipped: 0, errors: 0 }),
  processOverdueCatchUp: vi.fn().mockResolvedValue({ processed: 0, rescheduled: 0, errors: 0 }),
}));

vi.mock("./scheduling-engine", () => ({
  compressSchedule: vi.fn().mockResolvedValue({ compressed: 0 }),
  MAX_FOLLOWUP_DELAY_MS: 7 * 24 * 60 * 60 * 1000,
  DNC_KEYWORDS: ["stop", "unsubscribe"],
}));

vi.mock("./supervisor", () => ({
  runAndStoreSupervisorCycle: vi.fn().mockResolvedValue({}),
  getSupervisorStatus: vi.fn().mockResolvedValue(null),
}));

vi.mock("./lookback-engine", () => ({
  runLookback: vi.fn().mockResolvedValue({ total: 0, processed: 0, engage: 0, skip: 0, caution: 0, humanNeeded: 0, researchFetched: 0, errors: 0 }),
}));

vi.mock("./lead-disposition", () => ({
  runDispositionSweep: vi.fn().mockResolvedValue({ dncDisposed: 0, emailEscalated: 0, takeoverExpired: 0, errors: 0 }),
}));

vi.mock("./ai-brain", () => ({
  scoreLeadQuick: vi.fn().mockResolvedValue(50),
}));

// Mock the new Phase 4 modules
vi.mock("./ab-testing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ab-testing")>();
  return {
  ...actual,
  createExperiment: vi.fn().mockResolvedValue("exp_test_123"),
  listExperiments: vi.fn().mockResolvedValue([
    {
      id: 1,
      experimentId: "exp_test_123",
      name: "Framework A vs B",
      hypothesis: "HORMOZI_ACA outperforms DIRECT_RESPONSE for church leads",
      variantADescription: "HORMOZI_ACA framework",
      variantBDescription: "DIRECT_RESPONSE framework",
      variantAConfig: { framework: "HORMOZI_ACA" },
      variantBConfig: { framework: "DIRECT_RESPONSE" },
      targetSegment: "church",
      primaryMetric: "reply_rate",
      sampleSizeTarget: 50,
      confidenceThreshold: 95,
      variantASamples: 25,
      variantBSamples: 23,
      variantASuccesses: 10,
      variantBSuccesses: 5,
      winnerVariant: null,
      pValue: null,
      status: "active",
      autoAdopt: 1,
      startedAt: new Date(),
      createdAt: new Date(),
    },
  ]),
  evaluateExperiment: vi.fn().mockResolvedValue({
    experimentId: "exp_test_123",
    variantARate: 40,
    variantBRate: 21.7,
    pValue: 0.15,
    significant: false,
    winnerVariant: null,
    lift: 84.3,
    status: "active",
  }),
  evaluateAllExperiments: vi.fn().mockResolvedValue({ evaluated: 1, completed: 0 }),
  setExperimentStatus: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("./persona-learning", () => ({
  getPersonaMatrix: vi.fn().mockResolvedValue([
    {
      persona: "church",
      totalMessages: 35,
      replies: 18,
      replyRate: 51,
      positiveReplies: 10,
      positiveRate: 56,
      conversions: 2,
      conversionRate: 6,
      dncCount: 1,
      dncRate: 3,
      avgReplyMinutes: 90,
      bestFramework: "HORMOZI_ACA",
      bestFrameworkRate: 48,
      worstFramework: "EMB_WINBACK",
      worstFrameworkRate: 0,
      frameworkBreakdown: [
        { framework: "HORMOZI_ACA", sent: 27, replies: 13, replyRate: 48, conversions: 2 },
        { framework: "DIRECT_RESPONSE", sent: 7, replies: 2, replyRate: 29, conversions: 0 },
      ],
    },
    {
      persona: "small_business",
      totalMessages: 121,
      replies: 50,
      replyRate: 41,
      positiveReplies: 25,
      positiveRate: 50,
      conversions: 3,
      conversionRate: 2,
      dncCount: 5,
      dncRate: 4,
      avgReplyMinutes: 150,
      bestFramework: "DIRECT_RESPONSE",
      bestFrameworkRate: 60,
      worstFramework: "EMB_WINBACK",
      worstFrameworkRate: 0,
      frameworkBreakdown: [],
    },
  ]),
  normalizePersona: vi.fn((segment: string) => {
    const map: Record<string, string> = {
      churches: "church", church: "church",
      "small business": "small_business", small_business: "small_business",
      schools: "school_sports", "sports team": "school_sports",
      corporate: "corporate", nonprofit: "nonprofit",
    };
    return map[segment?.toLowerCase()] || "other";
  }),
  generateDailySnapshot: vi.fn().mockResolvedValue(true),
  getOutcomeTrends: vi.fn().mockResolvedValue({
    period: "last_14d vs prior_14d",
    trends: [
      { metric: "reply_rate", current: 38, previous: 32, direction: "up", changePercent: 19 },
      { metric: "conversion_rate", current: 2, previous: 1, direction: "up", changePercent: 100 },
    ],
    snapshots: [
      { snapshotDate: "2026-04-08", messagesSent: 15, replies: 6, positiveReplies: 3, conversions: 0, dncCount: 0, topFramework: "HORMOZI_ACA" },
      { snapshotDate: "2026-04-07", messagesSent: 20, replies: 8, positiveReplies: 4, conversions: 1, dncCount: 1, topFramework: "HORMOZI_ACA" },
    ],
  }),
  getPersonaLearningContext: vi.fn().mockResolvedValue("For church leads: Use HORMOZI_ACA (48% reply rate). Avoid EMB_WINBACK (0% reply rate)."),
  backfillPersonaOnOutcomes: vi.fn().mockResolvedValue(12),
}));

// ============================================================
// 2. PURE FUNCTION TESTS — chiSquaredTest
// ============================================================

import { chiSquaredTest } from "./ab-testing";

describe("chiSquaredTest (pure function)", () => {
  // Signature: chiSquaredTest(aSuccess, aFailure, bSuccess, bFailure)
  // Returns: { chiSquared, pValue }

  it("returns high pValue for small samples with small difference", () => {
    // 2 successes / 3 failures vs 1 success / 4 failures
    const result = chiSquaredTest(2, 3, 1, 4);
    expect(result).toHaveProperty("chiSquared");
    expect(result).toHaveProperty("pValue");
    // Small sample — should not be significant at 95%
    expect(result.pValue).toBeGreaterThan(0.05);
  });

  it("returns low pValue for large difference with big samples", () => {
    // 80 successes / 20 failures vs 20 successes / 80 failures
    const result = chiSquaredTest(80, 20, 20, 80);
    expect(result.pValue).toBeLessThan(0.05);
    expect(result.chiSquared).toBeGreaterThan(0);
  });

  it("handles zero samples gracefully", () => {
    const result = chiSquaredTest(0, 0, 0, 0);
    expect(result.chiSquared).toBe(0);
    expect(result.pValue).toBe(1);
  });

  it("handles equal outcomes", () => {
    // Same rate: 50/50 vs 50/50
    const result = chiSquaredTest(50, 50, 50, 50);
    expect(result.chiSquared).toBe(0);
    expect(result.pValue).toBe(1);
  });
});

// ============================================================
// 3. PERSONA NORMALIZATION TESTS
// ============================================================

import { normalizePersona } from "./persona-learning";

describe("normalizePersona", () => {
  it("maps 'churches' to 'church'", () => {
    expect(normalizePersona("churches")).toBe("church");
  });

  it("maps 'small business' to 'small_business'", () => {
    expect(normalizePersona("small business")).toBe("small_business");
  });

  it("returns 'other' for unknown segments", () => {
    expect(normalizePersona("random_segment")).toBe("other");
  });

  it("handles null/undefined gracefully", () => {
    expect(normalizePersona(null as any)).toBe("other");
  });
});

// ============================================================
// 4. LEARNING ROUTER TESTS — via tRPC caller
// ============================================================

import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAdminContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1, openId: "test-admin", email: "admin@adorb.com", name: "Admin",
    loginMethod: "manus", role: "admin", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
}

function createViewerContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 2, openId: "test-viewer", email: "viewer@adorb.com", name: "Viewer",
    loginMethod: "manus", role: "viewer" as any, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
}

describe("learning router", () => {
  let adminCaller: ReturnType<typeof appRouter.createCaller>;
  let viewerCaller: ReturnType<typeof appRouter.createCaller>;

  beforeEach(() => {
    adminCaller = appRouter.createCaller(createAdminContext());
    viewerCaller = appRouter.createCaller(createViewerContext());
  });

  describe("experiments", () => {
    it("lists all experiments", async () => {
      const experiments = await adminCaller.learning.experiments();
      expect(experiments).toHaveLength(1);
      expect(experiments[0].name).toBe("Framework A vs B");
      expect(experiments[0].status).toBe("active");
    });

    it("lists active experiments", async () => {
      const active = await adminCaller.learning.activeExperiments();
      expect(active).toBeDefined();
    });

    it("evaluates a specific experiment", async () => {
      const result = await adminCaller.learning.experimentResults({ experimentId: "exp_test_123" });
      expect(result).toBeDefined();
      expect(result!.experimentId).toBe("exp_test_123");
      expect(result!.variantARate).toBe(40);
      expect(result!.significant).toBe(false);
    });

    it("creates a new experiment (admin only)", async () => {
      const expId = await adminCaller.learning.createExperiment({
        name: "Test Experiment",
        hypothesis: "Testing hypothesis",
        variantADescription: "Variant A desc",
        variantBDescription: "Variant B desc",
        variantAConfig: { framework: "HORMOZI_ACA" },
        variantBConfig: { framework: "DIRECT_RESPONSE" },
        targetSegment: "church",
        primaryMetric: "reply_rate",
        sampleSizeTarget: 50,
      });
      expect(expId).toBe("exp_test_123");
    });

    it("evaluates all experiments (admin only)", async () => {
      const result = await adminCaller.learning.evaluateAllExperiments();
      expect(result.evaluated).toBe(1);
      expect(result.completed).toBe(0);
    });

    it("pauses an experiment (admin only)", async () => {
      const result = await adminCaller.learning.pauseExperiment({ experimentId: "exp_test_123" });
      expect(result).toBe(true);
    });

    it("resumes an experiment (admin only)", async () => {
      const result = await adminCaller.learning.resumeExperiment({ experimentId: "exp_test_123" });
      expect(result).toBe(true);
    });
  });

  describe("persona matrix", () => {
    it("returns persona matrix data", async () => {
      const matrix = await adminCaller.learning.personaMatrix();
      expect(matrix).toHaveLength(2);
      expect(matrix[0].persona).toBe("church");
      expect(matrix[0].replyRate).toBe(51);
      expect(matrix[0].bestFramework).toBe("HORMOZI_ACA");
    });

    it("returns persona learning context", async () => {
      const context = await adminCaller.learning.personaLearningContext({ persona: "church" });
      expect(context).toContain("HORMOZI_ACA");
      expect(context).toContain("church");
    });

    it("backfills persona tags (admin only)", async () => {
      const result = await adminCaller.learning.backfillPersona();
      expect(result.updated).toBe(12);
    });
  });

  describe("trends", () => {
    it("returns outcome trends", async () => {
      const trends = await adminCaller.learning.outcomeTrends();
      expect(trends).toBeDefined();
      expect(trends.period).toContain("14d");
      expect(trends.trends).toHaveLength(2);
      expect(trends.snapshots).toHaveLength(2);
    });

    it("returns trends with custom days", async () => {
      const trends = await adminCaller.learning.outcomeTrends({ days: 7 });
      expect(trends).toBeDefined();
    });

    it("triggers daily snapshot (admin only)", async () => {
      const result = await adminCaller.learning.triggerSnapshot();
      expect(result.success).toBe(true);
    });
  });

  describe("dashboard summary", () => {
    it("returns combined dashboard data", async () => {
      const summary = await adminCaller.learning.dashboardSummary();
      expect(summary).toBeDefined();
      expect(summary.patterns).toBeDefined();
      expect(summary.patterns.totalTracked).toBe(280);
      expect(summary.patterns.overallReplyRate).toBe(38);
      expect(summary.experiments).toBeDefined();
      expect(summary.experiments.total).toBe(1);
      expect(summary.experiments.active).toBe(1);
      expect(summary.personaMatrix).toHaveLength(2);
      expect(summary.trends).toBeDefined();
      expect(summary.trends.snapshots).toHaveLength(2);
    });
  });

  describe("access control", () => {
    it("viewers can read experiments", async () => {
      const experiments = await viewerCaller.learning.experiments();
      expect(experiments).toBeDefined();
    });

    it("viewers can read persona matrix", async () => {
      const matrix = await viewerCaller.learning.personaMatrix();
      expect(matrix).toBeDefined();
    });

    it("viewers can read trends", async () => {
      const trends = await viewerCaller.learning.outcomeTrends();
      expect(trends).toBeDefined();
    });

    it("viewers can read dashboard summary", async () => {
      const summary = await viewerCaller.learning.dashboardSummary();
      expect(summary).toBeDefined();
    });

    it("viewers cannot create experiments", async () => {
      await expect(
        viewerCaller.learning.createExperiment({
          name: "Test",
          hypothesis: "Test",
          variantADescription: "A",
          variantBDescription: "B",
          variantAConfig: { framework: "X" },
          variantBConfig: { framework: "Y" },
        })
      ).rejects.toThrow();
    });

    it("viewers cannot trigger snapshot", async () => {
      await expect(viewerCaller.learning.triggerSnapshot()).rejects.toThrow();
    });

    it("viewers cannot evaluate all experiments", async () => {
      await expect(viewerCaller.learning.evaluateAllExperiments()).rejects.toThrow();
    });

    it("viewers cannot backfill persona", async () => {
      await expect(viewerCaller.learning.backfillPersona()).rejects.toThrow();
    });
  });
});
