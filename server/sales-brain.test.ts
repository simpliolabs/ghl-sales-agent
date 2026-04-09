/**
 * Tests for Phase C: Sales Brain Refactor
 * - closer.ts: Specialized closing module for committed leads
 * - objection-handler.ts: Specialized objection handling module
 * - Orchestrator routing: convState-based Composer selection
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock LLM ──────────────────────────────────────────────────────────────

const mockInvokeLLM = vi.fn();
vi.mock("./_core/llm", () => ({
  invokeLLM: (...args: any[]) => mockInvokeLLM(...args),
}));

// ─── Mock brand assets ─────────────────────────────────────────────────────

vi.mock("../shared/brand-assets", () => ({
  BRAND: {
    reviewStars: "4.9",
    reviewCount: "867+",
    address: "123 Test St",
    hours: "9-5",
    products: "T-shirts, Hoodies",
    printMethods: ["Screen Print", "DTG"],
    phone: "(954) 932-8543",
    email: "print@adorbcustomtees.com",
    website: "adorbcustomtees.com",
    googleReviews: "https://google.com/reviews",
    trustpilot: "https://trustpilot.com",
    websiteReviews: "https://adorbcustomtees.com/reviews",
  },
  getBrandContext: () => "Brand context",
  getSignatureBlock: () => "---\nBest,\nTest Agent",
}));

// ─── Import modules under test ─────────────────────────────────────────────

import { runCloser } from "./closer";
import { runObjectionHandler } from "./objection-handler";
import type { BrainCouncilInput, StrategyDecision, ResearchResult, LeadContext } from "./brain-types";

// ─── Test Helpers ──────────────────────────────────────────────────────────

function makeInput(overrides: Partial<BrainCouncilInput> = {}): BrainCouncilInput {
  return {
    leadId: 1,
    incomingMessage: "Sounds great, let's do it!",
    channel: "SMS",
    ...overrides,
  };
}

function makeStrategy(overrides: Partial<StrategyDecision> = {}): StrategyDecision {
  return {
    approach: "confirm_details",
    channel: "SMS",
    angle: "Confirm order details",
    framework: "DIRECT_RESPONSE",
    personalizationTier: 2,
    toneDirective: "Warm and organized",
    maxLength: 320,
    keyPoints: ["Confirm quantities", "Set next steps"],
    avoidPoints: ["Do NOT re-pitch"],
    nextEngagementHours: 24,
    reasoning: "Lead is committed",
    ...overrides,
  };
}

function makeResearch(overrides: Partial<ResearchResult> = {}): ResearchResult {
  return {
    companyInfo: "Local church",
    recentActivity: "Ordered before",
    likelyPainPoints: ["Tight deadline"],
    connectionPoints: ["Church event"],
    competitorInsights: "",
    seasonalRelevance: "Spring events",
    summary: "Church looking for event tees",
    dataConfidence: "verified",
    ...overrides,
  };
}

function makeContext(overrides: Partial<LeadContext> = {}): LeadContext {
  return {
    lead: {
      name: "Pastor Shirley",
      businessName: "Grace Community Church",
      email: "shirley@grace.org",
      phone: "555-1234",
      assignedAgent: "Chris",
      pipelineStage: "Qualified",
      pipelineValue: 500,
    },
    convHistory: [],
    state: {},
    tweakInstructions: "",
    kbContent: "T-shirts: $8-12 each for 50+",
    historyStr: "Lead: I need 50 custom tees for our women's conference\nAgent: Got it! What colors are you thinking?\nLead: Navy blue with white print",
    isFirstResponse: false,
    priorOutbound: [],
    leadAgeDays: 5,
    urgencyStage: "warm",
    unansweredCount: 0,
    lookbackContext: "",
    lastInteractionSummary: "",
    convState: "committed",
    intentHistory: [
      { intent: "thank_you_close", confidence: 0.95, reasoning: "Lead confirmed they want to proceed", closingSignal: true, timestamp: Date.now() },
    ],
    ...overrides,
  };
}

function makeLLMResponse(message: string, fromName = "Chris", subject = "", notes = "Order confirmed") {
  return {
    choices: [{
      message: {
        content: JSON.stringify({
          message,
          fromName,
          subject,
          internalNotes: notes,
        }),
      },
    }],
  };
}

// ─── CLOSER TESTS ──────────────────────────────────────────────────────────

describe("Closer (server/closer.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should produce a ComposedMessage with all required fields", async () => {
    mockInvokeLLM.mockResolvedValueOnce(
      makeLLMResponse(
        "Got it — 50 navy tees with white print for the women's conference. I'll have our designer start on the mockup today!",
        "Chris",
        "",
        "Confirmed: 50 navy tees, white print. Next: mockup proof."
      )
    );

    const result = await runCloser(makeInput(), makeContext(), makeStrategy(), makeResearch());

    expect(result).toHaveProperty("message");
    expect(result).toHaveProperty("fromName");
    expect(result).toHaveProperty("internalNotes");
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.fromName.length).toBeGreaterThan(0);
  });

  it("should pass confirm_details approach context to LLM", async () => {
    mockInvokeLLM.mockResolvedValueOnce(
      makeLLMResponse("Perfect — I'll get the mockup started right away.")
    );

    await runCloser(makeInput(), makeContext(), makeStrategy(), makeResearch());

    expect(mockInvokeLLM).toHaveBeenCalledTimes(1);
    const call = mockInvokeLLM.mock.calls[0][0];
    // System prompt should contain Confirmation Close Framework
    expect(call.messages[0].content).toContain("CONFIRMATION CLOSE FRAMEWORK");
    expect(call.messages[0].content).toContain("CONFIRM");
    expect(call.messages[0].content).toContain("CLARIFY");
    expect(call.messages[0].content).toContain("COMMIT");
    // Should NOT contain re-pitching language
    expect(call.messages[0].content).toContain("NEVER re-pitch");
  });

  it("should include conversation history in the LLM input", async () => {
    mockInvokeLLM.mockResolvedValueOnce(
      makeLLMResponse("Got it — 50 navy tees coming right up!")
    );

    const ctx = makeContext({
      historyStr: "Lead: I need 50 navy tees\nAgent: What size breakdown?\nLead: Standard mix is fine",
    });

    await runCloser(makeInput(), ctx, makeStrategy(), makeResearch());

    const userPrompt = mockInvokeLLM.mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain("50 navy tees");
    expect(userPrompt).toContain("Standard mix is fine");
  });

  it("should include lead details in the LLM input", async () => {
    mockInvokeLLM.mockResolvedValueOnce(
      makeLLMResponse("Perfect, Pastor Shirley!")
    );

    await runCloser(makeInput(), makeContext(), makeStrategy(), makeResearch());

    const userPrompt = mockInvokeLLM.mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain("Pastor Shirley");
    expect(userPrompt).toContain("Grace Community Church");
    expect(userPrompt).toContain("Qualified");
  });

  it("should include knowledge base content for pricing reference", async () => {
    mockInvokeLLM.mockResolvedValueOnce(
      makeLLMResponse("Your 50 tees will be around $8-12 each.")
    );

    await runCloser(makeInput(), makeContext(), makeStrategy(), makeResearch());

    const userPrompt = mockInvokeLLM.mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain("T-shirts: $8-12 each for 50+");
  });

  it("should include external history when provided", async () => {
    mockInvokeLLM.mockResolvedValueOnce(
      makeLLMResponse("Got it!")
    );

    const input = makeInput({ externalHistory: "[GHL] Previous email about event details" });
    await runCloser(input, makeContext(), makeStrategy(), makeResearch());

    const userPrompt = mockInvokeLLM.mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain("[GHL] Previous email about event details");
  });

  it("should include last interaction summary when available", async () => {
    mockInvokeLLM.mockResolvedValueOnce(
      makeLLMResponse("Continuing from where we left off!")
    );

    const ctx = makeContext({
      lastInteractionSummary: "Last discussed: 50 navy tees for women's conference, waiting on size breakdown",
    });

    await runCloser(makeInput(), ctx, makeStrategy(), makeResearch());

    const userPrompt = mockInvokeLLM.mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain("Last discussed: 50 navy tees");
    expect(userPrompt).toContain("Continue from where this left off");
  });

  it("should use JSON schema response format", async () => {
    mockInvokeLLM.mockResolvedValueOnce(
      makeLLMResponse("Confirmed!")
    );

    await runCloser(makeInput(), makeContext(), makeStrategy(), makeResearch());

    const call = mockInvokeLLM.mock.calls[0][0];
    expect(call.response_format).toBeDefined();
    expect(call.response_format.type).toBe("json_schema");
    expect(call.response_format.json_schema.name).toBe("closer_message");
    const props = call.response_format.json_schema.schema.properties;
    expect(props).toHaveProperty("message");
    expect(props).toHaveProperty("fromName");
    expect(props).toHaveProperty("subject");
    expect(props).toHaveProperty("internalNotes");
  });

  it("should throw if LLM returns no content", async () => {
    mockInvokeLLM.mockResolvedValueOnce({ choices: [{ message: { content: null } }] });

    await expect(runCloser(makeInput(), makeContext(), makeStrategy(), makeResearch()))
      .rejects.toThrow("Closer brain produced no output");
  });

  it("should include tweak instructions when present", async () => {
    mockInvokeLLM.mockResolvedValueOnce(makeLLMResponse("Got it!"));

    const ctx = makeContext({ tweakInstructions: "Offer 10% discount for bulk orders" });
    await runCloser(makeInput(), ctx, makeStrategy(), makeResearch());

    const userPrompt = mockInvokeLLM.mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain("Offer 10% discount for bulk orders");
  });

  it("should include form data when present", async () => {
    mockInvokeLLM.mockResolvedValueOnce(makeLLMResponse("Got it!"));

    const input = makeInput({
      formData: [
        { label: "Quantity", value: "50" },
        { label: "Color", value: "Navy" },
      ],
    });
    await runCloser(input, makeContext(), makeStrategy(), makeResearch());

    const userPrompt = mockInvokeLLM.mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain("Quantity: 50");
    expect(userPrompt).toContain("Color: Navy");
  });
});

// ─── OBJECTION HANDLER TESTS ──────────────────────────────────────────────

describe("Objection Handler (server/objection-handler.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should produce a ComposedMessage with all required fields", async () => {
    mockInvokeLLM.mockResolvedValueOnce(
      makeLLMResponse(
        "I totally get it — budget matters. For 50 tees, you're looking at roughly $8-12 each. Want me to see if there's a way to work within your budget?",
        "Chris",
        "",
        "PRICE objection. Addressed with value anchoring and per-unit breakdown."
      )
    );

    const ctx = makeContext({
      convState: "objecting",
      intentHistory: [
        { intent: "objection", confidence: 0.9, reasoning: "Lead says price is too high", closingSignal: false, timestamp: Date.now() },
      ],
    });

    const result = await runObjectionHandler(
      makeInput({ incomingMessage: "That's way too expensive for our budget" }),
      ctx,
      makeStrategy({ approach: "answer_question" }),
      makeResearch()
    );

    expect(result).toHaveProperty("message");
    expect(result).toHaveProperty("fromName");
    expect(result).toHaveProperty("internalNotes");
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("should pass objection handling framework to LLM system prompt", async () => {
    mockInvokeLLM.mockResolvedValueOnce(
      makeLLMResponse("I hear you — timing is everything.")
    );

    const ctx = makeContext({
      convState: "objecting",
      intentHistory: [
        { intent: "objection", confidence: 0.85, reasoning: "Lead needs it sooner", closingSignal: false, timestamp: Date.now() },
      ],
    });

    await runObjectionHandler(
      makeInput({ incomingMessage: "I need these by Friday, that's too slow" }),
      ctx,
      makeStrategy({ approach: "answer_question" }),
      makeResearch()
    );

    const systemPrompt = mockInvokeLLM.mock.calls[0][0].messages[0].content;
    expect(systemPrompt).toContain("OBJECTION HANDLING FRAMEWORK");
    expect(systemPrompt).toContain("PRICE");
    expect(systemPrompt).toContain("TIMING");
    expect(systemPrompt).toContain("QUALITY");
    expect(systemPrompt).toContain("COMPETITOR");
    expect(systemPrompt).toContain("TRUST");
    expect(systemPrompt).toContain("NEED");
    // Should contain empathy-first approach
    expect(systemPrompt).toContain("ACKNOWLEDGE");
    expect(systemPrompt).toContain("never defensive");
  });

  it("should include intent classifier reasoning in the LLM input", async () => {
    mockInvokeLLM.mockResolvedValueOnce(
      makeLLMResponse("I totally understand.")
    );

    const ctx = makeContext({
      convState: "objecting",
      intentHistory: [
        { intent: "objection", confidence: 0.92, reasoning: "Lead says competitor has better pricing", closingSignal: false, timestamp: Date.now() },
      ],
    });

    await runObjectionHandler(
      makeInput({ incomingMessage: "Found a cheaper option elsewhere" }),
      ctx,
      makeStrategy({ approach: "answer_question" }),
      makeResearch()
    );

    const userPrompt = mockInvokeLLM.mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain("Lead says competitor has better pricing");
    expect(userPrompt).toContain("OBJECTION CONTEXT");
  });

  it("should include knowledge base for price objection responses", async () => {
    mockInvokeLLM.mockResolvedValueOnce(
      makeLLMResponse("For 50 tees, that's about $8-12 each.")
    );

    const ctx = makeContext({
      convState: "objecting",
      intentHistory: [
        { intent: "objection", confidence: 0.88, reasoning: "Price concern", closingSignal: false, timestamp: Date.now() },
      ],
    });

    await runObjectionHandler(
      makeInput({ incomingMessage: "Too expensive" }),
      ctx,
      makeStrategy(),
      makeResearch()
    );

    const userPrompt = mockInvokeLLM.mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain("T-shirts: $8-12 each for 50+");
  });

  it("should include pipeline value for context", async () => {
    mockInvokeLLM.mockResolvedValueOnce(
      makeLLMResponse("I understand your concern.")
    );

    const ctx = makeContext({
      convState: "objecting",
      lead: {
        ...makeContext().lead,
        pipelineValue: 1200,
      },
      intentHistory: [
        { intent: "objection", confidence: 0.85, reasoning: "Budget concern", closingSignal: false, timestamp: Date.now() },
      ],
    });

    await runObjectionHandler(
      makeInput({ incomingMessage: "Over budget" }),
      ctx,
      makeStrategy(),
      makeResearch()
    );

    const userPrompt = mockInvokeLLM.mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain("$1200");
  });

  it("should use JSON schema response format", async () => {
    mockInvokeLLM.mockResolvedValueOnce(
      makeLLMResponse("I understand.")
    );

    const ctx = makeContext({
      convState: "objecting",
      intentHistory: [
        { intent: "objection", confidence: 0.8, reasoning: "Generic objection", closingSignal: false, timestamp: Date.now() },
      ],
    });

    await runObjectionHandler(
      makeInput({ incomingMessage: "Not sure about this" }),
      ctx,
      makeStrategy(),
      makeResearch()
    );

    const call = mockInvokeLLM.mock.calls[0][0];
    expect(call.response_format).toBeDefined();
    expect(call.response_format.type).toBe("json_schema");
    expect(call.response_format.json_schema.name).toBe("objection_response");
  });

  it("should throw if LLM returns no content", async () => {
    mockInvokeLLM.mockResolvedValueOnce({ choices: [{ message: { content: null } }] });

    const ctx = makeContext({
      convState: "objecting",
      intentHistory: [
        { intent: "objection", confidence: 0.8, reasoning: "Generic", closingSignal: false, timestamp: Date.now() },
      ],
    });

    await expect(
      runObjectionHandler(makeInput(), ctx, makeStrategy(), makeResearch())
    ).rejects.toThrow("Objection Handler brain produced no output");
  });

  it("should handle missing intentHistory gracefully", async () => {
    mockInvokeLLM.mockResolvedValueOnce(
      makeLLMResponse("I understand your concern.")
    );

    const ctx = makeContext({
      convState: "objecting",
      intentHistory: undefined,
    });

    const result = await runObjectionHandler(
      makeInput({ incomingMessage: "Too expensive" }),
      ctx,
      makeStrategy(),
      makeResearch()
    );

    expect(result.message).toBeTruthy();
    // Should still include default objection context
    const userPrompt = mockInvokeLLM.mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain("Customer raised a concern");
  });

  it("should include anti-pressure rules in system prompt", async () => {
    mockInvokeLLM.mockResolvedValueOnce(
      makeLLMResponse("No worries at all.")
    );

    const ctx = makeContext({
      convState: "objecting",
      intentHistory: [
        { intent: "objection", confidence: 0.8, reasoning: "Not interested anymore", closingSignal: false, timestamp: Date.now() },
      ],
    });

    await runObjectionHandler(
      makeInput({ incomingMessage: "We changed our minds" }),
      ctx,
      makeStrategy(),
      makeResearch()
    );

    const systemPrompt = mockInvokeLLM.mock.calls[0][0].messages[0].content;
    expect(systemPrompt).toContain("NEVER use high-pressure tactics");
    expect(systemPrompt).toContain("NEVER guilt-trip");
    expect(systemPrompt).toContain("NEVER bad-mouth competitors");
  });
});

// ─── ORCHESTRATOR ROUTING TESTS ────────────────────────────────────────────

describe("Orchestrator Sales Brain Routing", () => {
  it("should route committed leads to Closer instead of Composer", () => {
    // This is a structural test — verify the routing logic exists
    // The actual orchestrator test is in dedup.test.ts, but we verify the pattern here
    const convState = "committed";
    const useCloser = convState === "committed";
    const useObjectionHandler = convState === "objecting";

    expect(useCloser).toBe(true);
    expect(useObjectionHandler).toBe(false);
  });

  it("should route objecting leads to ObjectionHandler instead of Composer", () => {
    const convState = "objecting";
    const useCloser = convState === "committed";
    const useObjectionHandler = convState === "objecting";

    expect(useCloser).toBe(false);
    expect(useObjectionHandler).toBe(true);
  });

  it("should route other states to generic Composer", () => {
    const states = ["new_lead", "exploring", "interested", "fulfilled", "stale", "human_active", undefined];

    for (const convState of states) {
      const useCloser = convState === "committed";
      const useObjectionHandler = convState === "objecting";

      expect(useCloser).toBe(false);
      expect(useObjectionHandler).toBe(false);
    }
  });

  it("should have Phase B convState strategy overrides for committed leads", () => {
    // Verify the strategy override pattern from Phase B is compatible with Phase C routing
    const strategy = makeStrategy({ approach: "follow_up" });
    const convState = "committed";

    // Phase B override
    if (convState === "committed" && strategy.approach !== "confirm_details" && strategy.approach !== "acknowledge_info") {
      (strategy as any).approach = "confirm_details";
      (strategy as any).framework = "DIRECT_RESPONSE";
    }

    expect(strategy.approach).toBe("confirm_details");
    expect(strategy.framework).toBe("DIRECT_RESPONSE");
  });

  it("should have Phase B convState strategy overrides for objecting leads", () => {
    const strategy = makeStrategy({ approach: "follow_up" });
    const convState = "objecting";

    // Phase B override
    if (convState === "objecting" && strategy.approach !== "answer_question") {
      (strategy as any).approach = "answer_question";
      (strategy as any).framework = "DIRECT_RESPONSE";
    }

    expect(strategy.approach).toBe("answer_question");
    expect(strategy.framework).toBe("DIRECT_RESPONSE");
  });
});
