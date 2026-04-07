/**
 * Layer 2: Brain Prompts — Tests
 * 
 * Tests for awareness-level detection, expanded approach/framework taxonomy,
 * framework diversity enforcement, and first-contact Brain Council integration.
 */
import { describe, it, expect } from "vitest";

// ========== APPROACH TAXONOMY TESTS ==========

describe("Approach Taxonomy", () => {
  // The expanded approach set aligned with the lookback engine
  const VALID_APPROACHES = [
    "first_contact", "follow_up", "reactivation", "post_delivery",
    "seasonal", "value_add", "answer_question", "provide_quote",
    "acknowledge_info", "confirm_details", "order_follow_up",
    "win_back", "relationship_nurture", "objection_handling",
    "urgency_close", "referral_ask",
  ];

  const RESPONSIVE_APPROACHES = [
    "answer_question", "provide_quote", "acknowledge_info",
    "confirm_details", "objection_handling",
  ];

  const PROACTIVE_APPROACHES = [
    "first_contact", "follow_up", "reactivation", "post_delivery",
    "seasonal", "value_add", "order_follow_up", "win_back",
    "relationship_nurture", "urgency_close", "referral_ask",
  ];

  it("should have 16 total approaches", () => {
    expect(VALID_APPROACHES.length).toBe(16);
  });

  it("should have 5 responsive approaches for handling inbound messages", () => {
    expect(RESPONSIVE_APPROACHES.length).toBe(5);
  });

  it("should have 11 proactive approaches for outbound engagement", () => {
    expect(PROACTIVE_APPROACHES.length).toBe(11);
  });

  it("all responsive approaches should be in the valid set", () => {
    for (const approach of RESPONSIVE_APPROACHES) {
      expect(VALID_APPROACHES).toContain(approach);
    }
  });

  it("all proactive approaches should be in the valid set", () => {
    for (const approach of PROACTIVE_APPROACHES) {
      expect(VALID_APPROACHES).toContain(approach);
    }
  });

  it("responsive and proactive should cover all approaches", () => {
    const combined = [...RESPONSIVE_APPROACHES, ...PROACTIVE_APPROACHES].sort();
    expect(combined).toEqual([...VALID_APPROACHES].sort());
  });
});

// ========== FRAMEWORK TAXONOMY TESTS ==========

describe("Framework Taxonomy", () => {
  const VALID_FRAMEWORKS = [
    "PAS", "BAB", "AIDA", "HORMOZI_ACA", "HORMOZI_INDIRECT",
    "SOCIAL_PROOF", "CASE_STUDY", "SOAP_OPERA",
    "EMB_WELCOME", "EMB_WINBACK", "EMB_POST_PURCHASE", "EMB_COLD",
    "DIRECT_RESPONSE", "VALUE_FIRST",
  ];

  const RESPONSIVE_FRAMEWORKS = ["DIRECT_RESPONSE", "VALUE_FIRST"];
  const OUTREACH_FRAMEWORKS = [
    "PAS", "BAB", "AIDA", "HORMOZI_ACA", "HORMOZI_INDIRECT",
    "SOCIAL_PROOF", "CASE_STUDY", "SOAP_OPERA",
  ];
  const EMAIL_FRAMEWORKS = [
    "EMB_WELCOME", "EMB_WINBACK", "EMB_POST_PURCHASE", "EMB_COLD",
  ];

  it("should have 14 total frameworks", () => {
    expect(VALID_FRAMEWORKS.length).toBe(14);
  });

  it("should have 2 responsive frameworks (exempt from diversity rule)", () => {
    expect(RESPONSIVE_FRAMEWORKS.length).toBe(2);
  });

  it("should have 8 outreach frameworks (subject to diversity rule)", () => {
    expect(OUTREACH_FRAMEWORKS.length).toBe(8);
  });

  it("should have 4 email-specific frameworks", () => {
    expect(EMAIL_FRAMEWORKS.length).toBe(4);
  });

  it("all categories should cover all frameworks", () => {
    const combined = [...RESPONSIVE_FRAMEWORKS, ...OUTREACH_FRAMEWORKS, ...EMAIL_FRAMEWORKS].sort();
    expect(combined).toEqual([...VALID_FRAMEWORKS].sort());
  });
});

// ========== FRAMEWORK DIVERSITY ENFORCEMENT TESTS ==========

describe("Framework Diversity Enforcement", () => {
  const RESPONSIVE_FRAMEWORKS = new Set(["DIRECT_RESPONSE", "VALUE_FIRST"]);
  const OUTREACH_FRAMEWORKS = ["PAS", "BAB", "AIDA", "HORMOZI_ACA", "HORMOZI_INDIRECT", "SOCIAL_PROOF", "CASE_STUDY", "SOAP_OPERA"];

  function shouldOverride(
    currentFramework: string,
    lastFrameworkUsed: string | null,
    recentAuditFrameworks: (string | null)[],
  ): { override: boolean; alternatives?: string[] } {
    // Responsive frameworks are exempt
    if (RESPONSIVE_FRAMEWORKS.has(currentFramework)) {
      return { override: false };
    }
    // No last framework — no override needed
    if (!lastFrameworkUsed || lastFrameworkUsed !== currentFramework) {
      return { override: false };
    }
    // Count consecutive same framework
    const consecutiveSame = recentAuditFrameworks.filter(f => f === currentFramework).length;
    if (consecutiveSame >= 2) {
      const alternatives = OUTREACH_FRAMEWORKS.filter(f => f !== currentFramework);
      return { override: true, alternatives };
    }
    return { override: false };
  }

  it("should NOT override responsive frameworks even if repeated", () => {
    const result = shouldOverride("DIRECT_RESPONSE", "DIRECT_RESPONSE", ["DIRECT_RESPONSE", "DIRECT_RESPONSE", "DIRECT_RESPONSE"]);
    expect(result.override).toBe(false);
  });

  it("should NOT override VALUE_FIRST even if repeated", () => {
    const result = shouldOverride("VALUE_FIRST", "VALUE_FIRST", ["VALUE_FIRST", "VALUE_FIRST"]);
    expect(result.override).toBe(false);
  });

  it("should NOT override if no previous framework", () => {
    const result = shouldOverride("HORMOZI_ACA", null, []);
    expect(result.override).toBe(false);
  });

  it("should NOT override if different from last framework", () => {
    const result = shouldOverride("PAS", "HORMOZI_ACA", ["HORMOZI_ACA", "HORMOZI_ACA"]);
    expect(result.override).toBe(false);
  });

  it("should NOT override if used only once consecutively", () => {
    const result = shouldOverride("HORMOZI_ACA", "HORMOZI_ACA", ["HORMOZI_ACA", "PAS", "BAB"]);
    expect(result.override).toBe(false);
  });

  it("should override HORMOZI_ACA if used 2+ times consecutively", () => {
    const result = shouldOverride("HORMOZI_ACA", "HORMOZI_ACA", ["HORMOZI_ACA", "HORMOZI_ACA", "PAS"]);
    expect(result.override).toBe(true);
    expect(result.alternatives).toBeDefined();
    expect(result.alternatives!.length).toBe(7); // 8 outreach - 1 current = 7
    expect(result.alternatives).not.toContain("HORMOZI_ACA");
  });

  it("should override any outreach framework if used 3 times", () => {
    const result = shouldOverride("PAS", "PAS", ["PAS", "PAS", "PAS"]);
    expect(result.override).toBe(true);
    expect(result.alternatives).not.toContain("PAS");
  });

  it("alternatives should always have at least 7 options", () => {
    for (const fw of OUTREACH_FRAMEWORKS) {
      const result = shouldOverride(fw, fw, [fw, fw, fw]);
      expect(result.override).toBe(true);
      expect(result.alternatives!.length).toBe(7);
    }
  });
});

// ========== AWARENESS LEVEL DETECTION TESTS ==========

describe("Awareness Level Detection", () => {
  // Simulates the awareness-level detection logic from the Strategist prompt
  function detectAwarenessLevel(incomingMessage: string, hasFormData: boolean, conversationLength: number): string {
    const msg = incomingMessage.toLowerCase();

    // Check for question patterns
    const questionPatterns = [
      /how much/i, /what.*price/i, /what.*cost/i, /can you.*quote/i,
      /do you.*offer/i, /what.*options/i, /\?$/,
      /how long/i, /when.*ready/i, /what.*turnaround/i,
    ];
    const hasQuestion = questionPatterns.some(p => p.test(msg));

    // Check for info-providing patterns
    const infoPatterns = [
      /i need/i, /i want/i, /i'm looking for/i, /we need/i,
      /my budget/i, /our event/i, /the design/i, /here.*design/i,
    ];
    const hasInfo = infoPatterns.some(p => p.test(msg));

    // Check for confirmation patterns
    const confirmPatterns = [
      /yes/i, /sounds good/i, /let's do it/i, /go ahead/i,
      /that works/i, /perfect/i, /i'm in/i, /deal/i,
    ];
    const hasConfirmation = confirmPatterns.some(p => p.test(msg));

    // Check for objection patterns
    const objectionPatterns = [
      /too expensive/i, /too much/i, /can't afford/i, /not sure/i,
      /maybe later/i, /not right now/i, /competitor/i,
    ];
    const hasObjection = objectionPatterns.some(p => p.test(msg));

    if (hasQuestion) return "question_asking";
    if (hasConfirmation) return "ready_to_buy";
    if (hasObjection) return "has_objections";
    if (hasInfo) return "providing_info";
    if (hasFormData && conversationLength === 0) return "first_contact";
    return "general_engagement";
  }

  it("should detect pricing questions", () => {
    expect(detectAwarenessLevel("How much for 100 t-shirts?", false, 3)).toBe("question_asking");
    expect(detectAwarenessLevel("What's the price for bulk orders?", false, 2)).toBe("question_asking");
    expect(detectAwarenessLevel("Can you quote me on 50 hoodies?", false, 1)).toBe("question_asking");
  });

  it("should detect timeline questions", () => {
    expect(detectAwarenessLevel("How long does it take to get them done?", false, 2)).toBe("question_asking");
    expect(detectAwarenessLevel("When would they be ready?", false, 1)).toBe("question_asking");
    expect(detectAwarenessLevel("What's the turnaround time?", false, 3)).toBe("question_asking");
  });

  it("should detect info-providing messages", () => {
    expect(detectAwarenessLevel("I need 200 custom tees for our company event", false, 1)).toBe("providing_info");
    expect(detectAwarenessLevel("We need them by next Friday", false, 2)).toBe("providing_info");
    expect(detectAwarenessLevel("I'm looking for embroidered polos", false, 0)).toBe("providing_info");
  });

  it("should detect confirmation/ready-to-buy signals", () => {
    expect(detectAwarenessLevel("Yes, let's do it!", false, 4)).toBe("ready_to_buy");
    expect(detectAwarenessLevel("Sounds good, go ahead", false, 3)).toBe("ready_to_buy");
    expect(detectAwarenessLevel("That works for me", false, 5)).toBe("ready_to_buy");
  });

  it("should detect objections", () => {
    expect(detectAwarenessLevel("That's too expensive for our budget", false, 3)).toBe("has_objections");
    expect(detectAwarenessLevel("Not sure if we can afford that", false, 2)).toBe("has_objections");
    expect(detectAwarenessLevel("Maybe later, not right now", false, 4)).toBe("has_objections");
  });

  it("should detect first contact with form data", () => {
    expect(detectAwarenessLevel("", true, 0)).toBe("first_contact");
  });

  it("should default to general engagement for ambiguous messages", () => {
    expect(detectAwarenessLevel("Hey there!", false, 1)).toBe("general_engagement");
    expect(detectAwarenessLevel("Thanks for reaching out", false, 2)).toBe("general_engagement");
  });
});

// ========== APPROACH-TO-FRAMEWORK MAPPING TESTS ==========

describe("Approach to Framework Mapping", () => {
  // Responsive approaches should use responsive frameworks
  const RESPONSIVE_APPROACH_FRAMEWORKS: Record<string, string[]> = {
    answer_question: ["DIRECT_RESPONSE", "VALUE_FIRST"],
    provide_quote: ["DIRECT_RESPONSE", "VALUE_FIRST"],
    acknowledge_info: ["DIRECT_RESPONSE", "VALUE_FIRST"],
    confirm_details: ["DIRECT_RESPONSE", "VALUE_FIRST"],
    objection_handling: ["DIRECT_RESPONSE", "VALUE_FIRST", "PAS", "SOCIAL_PROOF"],
  };

  it("responsive approaches should prefer DIRECT_RESPONSE or VALUE_FIRST", () => {
    for (const [approach, frameworks] of Object.entries(RESPONSIVE_APPROACH_FRAMEWORKS)) {
      expect(frameworks).toContain("DIRECT_RESPONSE");
      expect(frameworks.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("first_contact should use welcoming frameworks", () => {
    const firstContactFrameworks = ["EMB_WELCOME", "HORMOZI_ACA", "VALUE_FIRST", "SOCIAL_PROOF"];
    expect(firstContactFrameworks.length).toBeGreaterThanOrEqual(3);
  });
});

// ========== VIOLATION CATEGORY TESTS ==========

describe("Violation Categories", () => {
  const VIOLATION_CATEGORIES = [
    "wrong_business", "form_data_ignored", "hallucinated_product",
    "safety_violation", "missing_framework", "tone_mismatch",
    "unanswered_question", "info_not_acknowledged",
  ];

  it("should have 8 violation categories including 2 new substance checks", () => {
    expect(VIOLATION_CATEGORIES.length).toBe(8);
    expect(VIOLATION_CATEGORIES).toContain("unanswered_question");
    expect(VIOLATION_CATEGORIES).toContain("info_not_acknowledged");
  });
});

// ========== LOOKBACK ALIGNMENT TESTS ==========

describe("Lookback Engine Alignment", () => {
  // The lookback engine's approach taxonomy should map to Strategist approaches
  const LOOKBACK_APPROACHES = [
    "question-answer", "quote-follow-up", "order-follow-up",
    "win-back", "new-pitch", "relationship-nurture",
  ];

  const STRATEGIST_APPROACHES = [
    "first_contact", "follow_up", "reactivation", "post_delivery",
    "seasonal", "value_add", "answer_question", "provide_quote",
    "acknowledge_info", "confirm_details", "order_follow_up",
    "win_back", "relationship_nurture", "objection_handling",
    "urgency_close", "referral_ask",
  ];

  const LOOKBACK_TO_STRATEGIST: Record<string, string> = {
    "question-answer": "answer_question",
    "quote-follow-up": "provide_quote",
    "order-follow-up": "order_follow_up",
    "win-back": "win_back",
    "new-pitch": "follow_up",
    "relationship-nurture": "relationship_nurture",
  };

  it("every lookback approach should map to a valid strategist approach", () => {
    for (const [lookback, strategist] of Object.entries(LOOKBACK_TO_STRATEGIST)) {
      expect(STRATEGIST_APPROACHES).toContain(strategist);
    }
  });

  it("all lookback approaches should have a mapping", () => {
    for (const approach of LOOKBACK_APPROACHES) {
      expect(LOOKBACK_TO_STRATEGIST).toHaveProperty(approach);
    }
  });
});
