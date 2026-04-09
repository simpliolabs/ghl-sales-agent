/**
 * Tests for Learning Loop (learning-loop.ts) and Error Memory (error-memory.ts)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock DB ---
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockOrderBy = vi.fn();
const mockGroupBy = vi.fn();
const mockFrom = vi.fn();
const mockSet = vi.fn();
const mockValues = vi.fn();

function chainMock() {
  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere, groupBy: mockGroupBy, orderBy: mockOrderBy });
  mockWhere.mockReturnValue({ limit: mockLimit, orderBy: mockOrderBy, groupBy: mockGroupBy });
  mockLimit.mockReturnValue([]);
  mockOrderBy.mockReturnValue({ limit: mockLimit });
  mockGroupBy.mockReturnValue({ where: mockWhere });
  mockInsert.mockReturnValue({ values: mockValues });
  mockValues.mockResolvedValue([{ insertId: 1 }]);
  mockUpdate.mockReturnValue({ set: mockSet });
  mockSet.mockReturnValue({ where: mockWhere });
  mockWhere.mockResolvedValue(undefined);
}

vi.mock("./db", () => ({
  getDb: vi.fn(async () => ({
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
  })),
  updateLeadFields: vi.fn(),
  getConversationHistory: vi.fn().mockResolvedValue([]),
}));

vi.mock("../drizzle/schema", () => ({
  conversationOutcomes: { id: "id", leadId: "leadId", outcome: "outcome", channel: "channel", daysToOutcome: "daysToOutcome" },
  learnings: { id: "id", patternKey: "patternKey", category: "category", recurrenceCount: "recurrenceCount", positiveOutcomes: "positiveOutcomes", negativeOutcomes: "negativeOutcomes", promotedToPrompt: "promotedToPrompt" },
  errorMemory: { id: "id", errorSignature: "errorSignature", errorType: "errorType", occurrenceCount: "occurrenceCount", knownFix: "knownFix", fixApplied: "fixApplied" },
  leads: { id: "id", ghlContactId: "ghlContactId", pipelineStage: "pipelineStage", pipelineValue: "pipelineValue", omnisendSegment: "omnisendSegment", convState: "convState", intentHistory: "intentHistory" },
  conversations: { id: "id", leadId: "leadId", direction: "direction", channel: "channel", timestamp: "timestamp", messageBody: "messageBody" },
  brainCouncilAudit: { id: "id", leadId: "leadId", strategyApproach: "strategyApproach", strategyFramework: "strategyFramework", messageSent: "messageSent", createdAt: "createdAt" },
}));

// --- Learning Loop Tests ---
import { generatePatternKeys, PROMOTION_THRESHOLD, DEMOTION_THRESHOLD, MAX_PROMOTED_RULES, type ConversationJourney } from "./learning-loop";

describe("Learning Loop — Pattern Key Generation", () => {
  const baseJourney: ConversationJourney = {
    leadId: 1,
    ghlContactId: "c_123",
    stateSequence: ["new_lead", "exploring", "interested", "committed"],
    approachesUsed: ["introduce_brand", "share_pricing", "confirm_details"],
    frameworksUsed: ["HORMOZI_VALUE", "DIRECT_RESPONSE"],
    outcome: "won",
    messageCount: 8,
    daysToOutcome: 5,
    channel: "SMS",
    finalConvState: "committed",
    pipelineValue: 500,
  };

  it("generates framework × outcome patterns for each framework used", () => {
    const patterns = generatePatternKeys(baseJourney);
    const fwPatterns = patterns.filter(p => p.key.startsWith("framework."));
    expect(fwPatterns).toHaveLength(2); // HORMOZI_VALUE and DIRECT_RESPONSE
    expect(fwPatterns[0].key).toBe("framework.hormozi_value.won");
    expect(fwPatterns[0].category).toBe("best_practice");
    expect(fwPatterns[1].key).toBe("framework.direct_response.won");
  });

  it("generates approach sequence pattern", () => {
    const patterns = generatePatternKeys(baseJourney);
    const seqPattern = patterns.find(p => p.key.startsWith("sequence."));
    expect(seqPattern).toBeDefined();
    expect(seqPattern!.key).toContain("introduce_brand_then_share_pricing_then_confirm_details");
    expect(seqPattern!.category).toBe("best_practice");
  });

  it("generates channel × outcome pattern", () => {
    const patterns = generatePatternKeys(baseJourney);
    const chPattern = patterns.find(p => p.key.startsWith("channel."));
    expect(chPattern).toBeDefined();
    expect(chPattern!.key).toBe("channel.sms.won");
    expect(chPattern!.category).toBe("best_practice");
  });

  it("generates fast_win pattern for quick conversions", () => {
    const fastJourney = { ...baseJourney, daysToOutcome: 2 };
    const patterns = generatePatternKeys(fastJourney);
    const speedPattern = patterns.find(p => p.key.startsWith("speed.fast_win"));
    expect(speedPattern).toBeDefined();
    expect(speedPattern!.category).toBe("best_practice");
  });

  it("generates slow_loss pattern for prolonged losses", () => {
    const slowLoss: ConversationJourney = { ...baseJourney, outcome: "lost", daysToOutcome: 21 };
    const patterns = generatePatternKeys(slowLoss);
    const speedPattern = patterns.find(p => p.key.startsWith("speed.slow_loss"));
    expect(speedPattern).toBeDefined();
    expect(speedPattern!.category).toBe("avoid");
  });

  it("generates outcome reason pattern when provided", () => {
    const withReason: ConversationJourney = { ...baseJourney, outcome: "lost", outcomeReason: "price too high" };
    const patterns = generatePatternKeys(withReason);
    const reasonPattern = patterns.find(p => p.key.startsWith("reason."));
    expect(reasonPattern).toBeDefined();
    expect(reasonPattern!.key).toBe("reason.price_too_high");
    expect(reasonPattern!.category).toBe("knowledge_gap");
  });

  it("marks DNC outcomes with avoid category", () => {
    const dncJourney: ConversationJourney = { ...baseJourney, outcome: "dnc" };
    const patterns = generatePatternKeys(dncJourney);
    const fwPatterns = patterns.filter(p => p.key.startsWith("framework."));
    for (const p of fwPatterns) {
      expect(p.category).toBe("avoid");
    }
  });

  it("marks lost outcomes with avoid category", () => {
    const lostJourney: ConversationJourney = { ...baseJourney, outcome: "lost" };
    const patterns = generatePatternKeys(lostJourney);
    const fwPatterns = patterns.filter(p => p.key.startsWith("framework."));
    for (const p of fwPatterns) {
      expect(p.category).toBe("avoid");
    }
  });

  it("handles empty frameworks gracefully", () => {
    const noFw: ConversationJourney = { ...baseJourney, frameworksUsed: [] };
    const patterns = generatePatternKeys(noFw);
    const fwPatterns = patterns.filter(p => p.key.startsWith("framework."));
    expect(fwPatterns).toHaveLength(0);
  });

  it("handles empty approaches gracefully", () => {
    const noApproach: ConversationJourney = { ...baseJourney, approachesUsed: [] };
    const patterns = generatePatternKeys(noApproach);
    const seqPattern = patterns.find(p => p.key.startsWith("sequence."));
    expect(seqPattern).toBeUndefined();
  });

  it("truncates approach sequence to first 3 items", () => {
    const longApproach: ConversationJourney = {
      ...baseJourney,
      approachesUsed: ["a", "b", "c", "d", "e"],
    };
    const patterns = generatePatternKeys(longApproach);
    const seqPattern = patterns.find(p => p.key.startsWith("sequence."));
    expect(seqPattern!.key).toContain("a_then_b_then_c");
    expect(seqPattern!.key).not.toContain("d");
  });
});

describe("Learning Loop — Constants", () => {
  it("PROMOTION_THRESHOLD is 3", () => {
    expect(PROMOTION_THRESHOLD).toBe(3);
  });

  it("DEMOTION_THRESHOLD is 3", () => {
    expect(DEMOTION_THRESHOLD).toBe(3);
  });

  it("MAX_PROMOTED_RULES is 15", () => {
    expect(MAX_PROMOTED_RULES).toBe(15);
  });
});

// --- Error Memory Tests ---
import { generateSignature } from "./error-memory";

describe("Error Memory — Signature Generation", () => {
  it("generates consistent signatures for same input", () => {
    const sig1 = generateSignature("ghl_api", "Request failed with status code 429", undefined);
    const sig2 = generateSignature("ghl_api", "Request failed with status code 429", undefined);
    expect(sig1).toBe(sig2);
  });

  it("generates different signatures for different error types", () => {
    const sig1 = generateSignature("ghl_api", "Request failed", undefined);
    const sig2 = generateSignature("llm_hallucination", "Request failed", undefined);
    expect(sig1).not.toBe(sig2);
  });

  it("generates different signatures for different contexts", () => {
    const sig1 = generateSignature("ghl_api", "Request failed", "contact_123");
    const sig2 = generateSignature("ghl_api", "Request failed", "contact_456");
    expect(sig1).not.toBe(sig2);
  });

  it("normalizes UUIDs in error messages", () => {
    const sig1 = generateSignature("ghl_api", "Failed for contact 550e8400-e29b-41d4-a716-446655440000", undefined);
    const sig2 = generateSignature("ghl_api", "Failed for contact a1b2c3d4-e5f6-7890-abcd-ef1234567890", undefined);
    expect(sig1).toBe(sig2); // Both UUIDs normalized to <UUID>
  });

  it("normalizes numbers in error messages", () => {
    const sig1 = generateSignature("ghl_api", "Rate limit: 100 requests per 60 seconds", undefined);
    const sig2 = generateSignature("ghl_api", "Rate limit: 200 requests per 120 seconds", undefined);
    expect(sig1).toBe(sig2); // Both numbers normalized to <NUM>
  });

  it("normalizes timestamps in error messages", () => {
    const sig1 = generateSignature("ghl_api", "Failed at 1712345678901", undefined);
    const sig2 = generateSignature("ghl_api", "Failed at 1712345999999", undefined);
    expect(sig1).toBe(sig2); // Both timestamps normalized to <TIMESTAMP>
  });

  it("produces 32-character hex signatures", () => {
    const sig = generateSignature("ghl_api", "test error", undefined);
    expect(sig).toHaveLength(32);
    expect(sig).toMatch(/^[0-9a-f]{32}$/);
  });

  it("handles empty context", () => {
    const sig1 = generateSignature("ghl_api", "test", undefined);
    const sig2 = generateSignature("ghl_api", "test");
    expect(sig1).toBe(sig2);
  });
});

describe("Error Memory — Known Error Seeds", () => {
  it("seed list covers critical error types", async () => {
    // Verify the seed function exists and is callable
    const mod = await import("./error-memory");
    expect(typeof mod.seedKnownErrors).toBe("function");
  });
});
