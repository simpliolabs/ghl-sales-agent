/**
 * Tests for Blueprint Decisions 1-12
 *
 * Covers:
 * - Decision 1: SOCIAL_PROOF ban
 * - Decision 2: EMB_WINBACK restriction
 * - Decision 3: Channel logic (SMS preference, FB window)
 * - Decision 4: A/B seeder SQL fix + cron changes
 * - Decision 6: Trends injection into strategist
 * - Decision 7: Auto-adopt mature proposals
 * - Decision 9: Training export pipeline
 * - Decision 11: Strategy autopilot
 * - Decision 12: Weekly Monday review
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================
// MOCKS
// ============================================================

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
  getHallOfFameExamples: vi.fn().mockResolvedValue([]),
  promoteToHallOfFame: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./ghl", () => ({
  getContacts: vi.fn().mockResolvedValue({ contacts: [], meta: { total: 0 } }),
  getPipelines: vi.fn().mockResolvedValue([]),
}));

vi.mock("./storage", () => ({
  storagePut: vi.fn().mockResolvedValue({ url: "https://cdn.example.com/file.jsonl", key: "training-exports/test.jsonl" }),
}));

vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ adjustments: [] }) } }],
  }),
}));

vi.mock("./_core/notification", () => ({
  notifyOwner: vi.fn().mockResolvedValue(true),
}));

vi.mock("./cache", () => ({
  cached: vi.fn((_cache: any, _key: string, fn: () => any) => fn()),
  patternCache: new Map(),
}));

vi.mock("./persona-learning", () => ({
  getOutcomeTrends: vi.fn().mockResolvedValue({
    period: "last_7d vs prior_7d",
    trends: [
      { metric: "replyRate", current: 5.2, previous: 6.1, change: -0.9, changePercent: -15, direction: "declining", alert: false },
      { metric: "conversionRate", current: 1.1, previous: 1.0, change: 0.1, changePercent: 10, direction: "stable", alert: false },
      { metric: "dncRate", current: 0.5, previous: 0.4, change: 0.1, changePercent: 25, direction: "declining", alert: true },
    ],
    snapshots: [],
  }),
  getPersonaMatrix: vi.fn().mockResolvedValue([]),
  normalizePersona: vi.fn().mockReturnValue("business_owner"),
  generateDailySnapshot: vi.fn().mockResolvedValue(undefined),
  getPersonaLearningContext: vi.fn().mockResolvedValue(""),
  backfillPersonaOnOutcomes: vi.fn().mockResolvedValue(0),
}));

vi.mock("./outcome-engine", () => ({
  getPatternAnalysis: vi.fn().mockResolvedValue({}),
  backfillOutcomes: vi.fn().mockResolvedValue(0),
  getIcpStats: vi.fn().mockResolvedValue({}),
  buildLearningContext: vi.fn().mockResolvedValue(""),
  buildIcpLearningContext: vi.fn().mockResolvedValue(""),
}));

vi.mock("./learning-loop", () => ({
  getPromotedLearnings: vi.fn().mockResolvedValue(""),
  getViolationAvoidanceRules: vi.fn().mockResolvedValue(""),
  extractAgentPatterns: vi.fn().mockResolvedValue([]),
  recordAgentLearning: vi.fn().mockResolvedValue(0),
}));

vi.mock("./skill-registry", () => ({
  getAllSkills: vi.fn().mockReturnValue([]),
}));

vi.mock("./auto-skill-hunter", () => ({
  runAutoSkillHunter: vi.fn().mockResolvedValue({ patternsFound: 0, proposalsCreated: 0, skippedCooldown: 0 }),
  getSkillProposals: vi.fn().mockResolvedValue([]),
  reviewSkillProposal: vi.fn().mockResolvedValue(true),
  getApprovedSkillsBlock: vi.fn().mockResolvedValue(""),
  autoAdoptMatureProposals: vi.fn().mockResolvedValue({ adopted: 0, checked: 0 }),
}));

vi.mock("./ab-testing", () => ({
  createExperiment: vi.fn().mockResolvedValue("exp-123"),
  listExperiments: vi.fn().mockResolvedValue([]),
  evaluateExperiment: vi.fn().mockResolvedValue({}),
  evaluateAllExperiments: vi.fn().mockResolvedValue({ evaluated: 0, completed: 0, adopted: 0 }),
  setExperimentStatus: vi.fn().mockResolvedValue(true),
  autoSeedExperiments: vi.fn().mockResolvedValue({ created: 0, skipped: 0 }),
}));

vi.mock("./follow-up-trigger", () => ({
  processOverdueFollowUps: vi.fn().mockResolvedValue({ sent: 0, skipped: 0, errors: 0 }),
  processOverdueCatchUp: vi.fn().mockResolvedValue({ sent: 0, skipped: 0, errors: 0 }),
}));

vi.mock("./scheduling-engine", () => ({
  compressSchedule: vi.fn().mockResolvedValue(undefined),
  MAX_FOLLOWUP_DELAY_MS: 86400000,
  selectChannel: vi.fn().mockReturnValue("SMS"),
}));

vi.mock("./supervisor", () => ({
  runAndStoreSupervisorCycle: vi.fn().mockResolvedValue(undefined),
  getSupervisorStatus: vi.fn().mockResolvedValue(null),
}));

vi.mock("./lookback-engine", () => ({
  runLookback: vi.fn().mockResolvedValue({ processed: 0 }),
}));

vi.mock("./lead-disposition", () => ({
  runDispositionSweep: vi.fn().mockResolvedValue({ disposed: 0 }),
}));

vi.mock("./lead-memory", () => ({
  getLeadMemoryFacts: vi.fn().mockResolvedValue([]),
}));

vi.mock("./strategy-autopilot", () => ({
  runStrategyReview: vi.fn().mockResolvedValue({ proposed: 0, expired: 0 }),
  getStrategyAdjustmentHistory: vi.fn().mockResolvedValue([]),
  getActiveStrategyAdjustments: vi.fn().mockResolvedValue(""),
}));

vi.mock("./training-export", () => ({
  createTrainingExport: vi.fn().mockResolvedValue({ id: 1, status: "generating" }),
  listTrainingExports: vi.fn().mockResolvedValue([]),
  getTrainingExport: vi.fn().mockResolvedValue(null),
}));

vi.mock("./ai-brain", () => ({
  scoreLeadQuick: vi.fn().mockResolvedValue(50),
}));

// ============================================================
// DECISION 1: SOCIAL_PROOF BAN
// ============================================================

describe("Decision 1: SOCIAL_PROOF Framework Ban", () => {
  it("should not include SOCIAL_PROOF in strategist available frameworks", async () => {
    const fs = await import("fs");
    const strategistContent = fs.readFileSync("server/strategist.ts", "utf-8");
    
    // Check the STEP 3 instruction line
    const step3Match = strategistContent.match(/Available outreach frameworks:([^.]+)/);
    expect(step3Match).toBeTruthy();
    expect(step3Match![1]).not.toContain("SOCIAL_PROOF");
    
    // Check banned frameworks list includes SOCIAL_PROOF
    const bannedMatch = strategistContent.match(/BANNED FRAMEWORKS[^:]*:([^.]+)/);
    expect(bannedMatch).toBeTruthy();
    expect(bannedMatch![1]).toContain("SOCIAL_PROOF");
  });

  it("should have programmatic ban in brain-council-orchestrator", async () => {
    const fs = await import("fs");
    const orchestratorContent = fs.readFileSync("server/brain-council-orchestrator.ts", "utf-8");
    
    // Check for SOCIAL_PROOF override logic
    expect(orchestratorContent).toContain("SOCIAL_PROOF");
    expect(orchestratorContent).toMatch(/framework.*===.*["']SOCIAL_PROOF["']/);
  });
});

// ============================================================
// DECISION 2: EMB_WINBACK RESTRICTION
// ============================================================

describe("Decision 2: EMB_WINBACK Past Customer Restriction", () => {
  it("should have EMB_WINBACK restriction logic in brain-council-orchestrator", async () => {
    const fs = await import("fs");
    const orchestratorContent = fs.readFileSync("server/brain-council-orchestrator.ts", "utf-8");
    
    // Check for EMB_WINBACK restriction
    expect(orchestratorContent).toContain("EMB_WINBACK");
    // Should check for past customer indicators
    expect(orchestratorContent).toMatch(/delivered|paid|approved|opportunityStatus.*won/i);
  });
});

// ============================================================
// DECISION 3: CHANNEL LOGIC
// ============================================================

describe("Decision 3: Channel Logic Improvements", () => {
  it("should have selectChannel function preferring SMS", async () => {
    const fs = await import("fs");
    const schedulingContent = fs.readFileSync("server/scheduling-engine.ts", "utf-8");
    
    // Check that SMS is preferred over Email
    expect(schedulingContent).toContain("selectChannel");
    // The function should prioritize SMS when phone is available
    expect(schedulingContent).toMatch(/phone.*SMS|SMS.*phone/i);
  });

  it("should have fb-window-manager module", async () => {
    const fs = await import("fs");
    const fbContent = fs.readFileSync("server/fb-window-manager.ts", "utf-8");
    
    expect(fbContent).toContain("isFbWindowOpen");
    expect(fbContent).toContain("24"); // 24-hour window reference
  });

  it("should wire FB window check into brain-council-orchestrator", async () => {
    const fs = await import("fs");
    const orchestratorContent = fs.readFileSync("server/brain-council-orchestrator.ts", "utf-8");
    
    expect(orchestratorContent).toContain("fb-window-manager");
    expect(orchestratorContent).toContain("isFbWindowOpen");
  });
});

// ============================================================
// DECISION 4: A/B SEEDER FIX
// ============================================================

describe("Decision 4: A/B Seeder SQL Fix", () => {
  it("should use camelCase column names in dedup check", async () => {
    const fs = await import("fs");
    const abContent = fs.readFileSync("server/ab-testing.ts", "utf-8");
    
    // Should use variantAConfig (camelCase) not variant_a_config (snake_case)
    expect(abContent).toContain("variantAConfig");
    expect(abContent).toContain("variantBConfig");
    // Should NOT have the old snake_case in the dedup SQL
    expect(abContent).not.toMatch(/variant_a_config.*LIKE/);
    expect(abContent).not.toMatch(/variant_b_config.*LIKE/);
  });
});

// ============================================================
// DECISION 6: TRENDS INJECTION
// ============================================================

describe("Decision 6: Trends Block in Strategist", () => {
  it("should have getTrendsBlock function in strategist", async () => {
    const fs = await import("fs");
    const strategistContent = fs.readFileSync("server/strategist.ts", "utf-8");
    
    expect(strategistContent).toContain("getTrendsBlock");
    expect(strategistContent).toContain("getOutcomeTrends");
    expect(strategistContent).toContain("PERFORMANCE TRENDS");
  });

  it("should import getOutcomeTrends in strategist", async () => {
    const fs = await import("fs");
    const strategistContent = fs.readFileSync("server/strategist.ts", "utf-8");
    
    expect(strategistContent).toMatch(/import.*getOutcomeTrends.*from.*persona-learning/);
  });
});

// ============================================================
// DECISION 7: AUTO-ADOPT MATURE PROPOSALS
// ============================================================

describe("Decision 7: Auto-Adopt Mature Skill Proposals", () => {
  it("should have autoAdoptMatureProposals function", async () => {
    const fs = await import("fs");
    const skillContent = fs.readFileSync("server/auto-skill-hunter.ts", "utf-8");
    
    expect(skillContent).toContain("autoAdoptMatureProposals");
    expect(skillContent).toContain("ADOPT_MATURATION_DAYS");
    expect(skillContent).toContain("ADOPT_VIOLATION_THRESHOLD");
  });

  it("should have getApprovedSkillsBlock function", async () => {
    const fs = await import("fs");
    const skillContent = fs.readFileSync("server/auto-skill-hunter.ts", "utf-8");
    
    expect(skillContent).toContain("getApprovedSkillsBlock");
    expect(skillContent).toContain("ADOPTED SKILLS");
  });

  it("should inject approved skills into composer", async () => {
    const fs = await import("fs");
    const composerContent = fs.readFileSync("server/composer.ts", "utf-8");
    
    expect(composerContent).toContain("getApprovedSkillsBlock");
    expect(composerContent).toMatch(/import.*getApprovedSkillsBlock.*from.*auto-skill-hunter/);
  });
});

// ============================================================
// DECISION 9: TRAINING EXPORT
// ============================================================

describe("Decision 9: Training Export Pipeline", () => {
  it("should have training-export.ts module", async () => {
    const fs = await import("fs");
    const exportContent = fs.readFileSync("server/training-export.ts", "utf-8");
    
    expect(exportContent).toContain("createTrainingExport");
    expect(exportContent).toContain("generateTrainingPairs");
    expect(exportContent).toContain("listTrainingExports");
    expect(exportContent).toContain("JSONL");
  });

  it("should have training_exports table in schema", async () => {
    const fs = await import("fs");
    const schemaContent = fs.readFileSync("drizzle/schema.ts", "utf-8");
    
    expect(schemaContent).toContain("training_exports");
    expect(schemaContent).toContain("trainingExports");
    expect(schemaContent).toContain("exportName");
    expect(schemaContent).toContain("fileUrl");
    expect(schemaContent).toContain("totalPairs");
  });

  it("should have tRPC procedures for training export", async () => {
    const fs = await import("fs");
    const routerContent = fs.readFileSync("server/routers.ts", "utf-8");
    
    expect(routerContent).toContain("trainingExports:");
    expect(routerContent).toContain("createTrainingExport:");
    expect(routerContent).toMatch(/import.*createTrainingExport.*from.*training-export/);
  });
});

// ============================================================
// DECISION 11: STRATEGY AUTOPILOT
// ============================================================

describe("Decision 11: Strategy Autopilot", () => {
  it("should have strategy-autopilot.ts module", async () => {
    const fs = await import("fs");
    const autopilotContent = fs.readFileSync("server/strategy-autopilot.ts", "utf-8");
    
    expect(autopilotContent).toContain("runStrategyReview");
    expect(autopilotContent).toContain("getActiveStrategyAdjustments");
    expect(autopilotContent).toContain("getStrategyAdjustmentHistory");
    expect(autopilotContent).toContain("ACTIVE STRATEGY ADJUSTMENTS");
  });

  it("should have strategy_adjustments table in schema", async () => {
    const fs = await import("fs");
    const schemaContent = fs.readFileSync("drizzle/schema.ts", "utf-8");
    
    expect(schemaContent).toContain("strategy_adjustments");
    expect(schemaContent).toContain("strategyAdjustments");
    expect(schemaContent).toContain("weekId");
    expect(schemaContent).toContain("triggerMetric");
    expect(schemaContent).toContain("expiresAt");
  });

  it("should inject active adjustments into strategist", async () => {
    const fs = await import("fs");
    const strategistContent = fs.readFileSync("server/strategist.ts", "utf-8");
    
    expect(strategistContent).toContain("getActiveStrategyAdjustments");
    expect(strategistContent).toMatch(/import.*getActiveStrategyAdjustments.*from.*strategy-autopilot/);
  });

  it("should be wired into weekly Monday review", async () => {
    const fs = await import("fs");
    const indexContent = fs.readFileSync("server/_core/index.ts", "utf-8");
    
    expect(indexContent).toContain("runStrategyReview");
    expect(indexContent).toContain("strategy-autopilot");
    expect(indexContent).toContain("WeeklyReview/Strategy");
  });
});

// ============================================================
// DECISION 12: WEEKLY MONDAY REVIEW
// ============================================================

describe("Decision 12: Weekly Monday Review Timer", () => {
  it("should have all steps in the weekly review", async () => {
    const fs = await import("fs");
    const indexContent = fs.readFileSync("server/_core/index.ts", "utf-8");
    
    // Step 1: Auto-Skill Hunter
    expect(indexContent).toContain("runAutoSkillHunter");
    // Step 1.5: Auto-adopt
    expect(indexContent).toContain("autoAdoptMatureProposals");
    // Step 2: A/B Experiments
    expect(indexContent).toContain("autoSeedExperiments");
    expect(indexContent).toContain("evaluateAllExperiments");
    // Step 3: Strategy Autopilot
    expect(indexContent).toContain("runStrategyReview");
  });

  it("should have Monday gate for weekly review", async () => {
    const fs = await import("fs");
    const indexContent = fs.readFileSync("server/_core/index.ts", "utf-8");
    
    // Should check for Monday (getDay() === 1)
    expect(indexContent).toMatch(/getDay\(\)\s*===\s*1/);
  });

  it("should have ISO week dedup to prevent double-runs", async () => {
    const fs = await import("fs");
    const indexContent = fs.readFileSync("server/_core/index.ts", "utf-8");
    
    // Should track last run week
    expect(indexContent).toMatch(/lastWeeklyRun|lastRunWeek|currentWeek/);
  });
});

// ============================================================
// DECISION 10: AGENT PATTERNS
// ============================================================

describe("Decision 10: Agent Pattern Extraction", () => {
  it("should have extractPatterns tRPC procedure", async () => {
    const fs = await import("fs");
    const routerContent = fs.readFileSync("server/routers.ts", "utf-8");
    
    expect(routerContent).toContain("extractPatterns:");
    expect(routerContent).toContain("extractAgentPatterns");
    expect(routerContent).toContain("recordAgentLearning");
  });

  it("should import extractAgentPatterns from learning-loop", async () => {
    const fs = await import("fs");
    const routerContent = fs.readFileSync("server/routers.ts", "utf-8");
    
    expect(routerContent).toMatch(/import.*extractAgentPatterns.*from.*learning-loop/);
  });
});
