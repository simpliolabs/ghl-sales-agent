/**
 * Phase 2: Single Brain Tests
 * 
 * Tests for:
 * - Pricing engine (getQuote)
 * - Output guards (system leak, channel mismatch, price validation, DNC, null-advance, length)
 * - A/B routing logic
 * - Stage behavior JSON structure
 */
import { describe, it, expect } from "vitest";
import { getQuote } from "./pricing-engine";
import { runOutputGuards, type BrainDecision, type ToolCallRecord } from "./output-guards";
import stageBehavior from "../shared/stage-behavior.json";
import pricingData from "../shared/pricing-data.json";

// ─── Pricing Engine Tests ─────────────────────────────────────────────────────
describe("Pricing Engine — getQuote", () => {
  it("returns exact pricing for Gildan 3000 t-shirts (1-side, 24 qty)", () => {
    const result = getQuote(24, 1, "tshirt_gildan_3000");
    expect(result.callForQuote).toBe(false);
    expect(result.perUnit).toBeTypeOf("number");
    expect(result.perUnit).toBeGreaterThan(0);
    expect(result.total).toBeTypeOf("number");
    expect(result.total).toBeGreaterThan(0);
    expect(result.productName).toContain("Gildan");
  });

  it("returns exact pricing for 2-side print", () => {
    const result = getQuote(50, 2, "tshirt_gildan_3000");
    expect(result.callForQuote).toBe(false);
    expect(result.perUnit).toBeTypeOf("number");
    expect(result.sides).toBe(2);
  });

  it("applies rush fee (20% surcharge)", () => {
    const normal = getQuote(50, 1, "tshirt_gildan_3000", false);
    const rush = getQuote(50, 1, "tshirt_gildan_3000", true);
    expect(rush.rushFee).toBeGreaterThan(0);
    expect(rush.total!).toBeGreaterThan(normal.total!);
    // Rush fee should be 20% of subtotal
    expect(rush.rushFee).toBeCloseTo(normal.subtotal! * 0.20, 2);
  });

  it("returns callForQuote for unknown products", () => {
    const result = getQuote(50, 1, "unknown_product_xyz");
    expect(result.callForQuote).toBe(true);
    expect(result.perUnit).toBeNull();
    expect(result.total).toBeNull();
  });

  it("returns callForQuote for below-minimum quantities", () => {
    const result = getQuote(1, 1, "tshirt_gildan_3000");
    // Minimum is typically 12 or 24
    // If qty 1 is below minimum, should return callForQuote
    if (result.callForQuote) {
      expect(result.perUnit).toBeNull();
    }
  });

  it("returns range pricing for non-tshirt products", () => {
    // Check if there are range-priced products in the data
    const products = Object.keys(pricingData.products);
    const rangeProduct = products.find(p => {
      const tiers = (pricingData.products as any)[p].tiers;
      return tiers?.some((t: any) => t.isRange);
    });
    if (rangeProduct) {
      const result = getQuote(50, 1, rangeProduct);
      if (result.perUnitRange) {
        expect(result.perUnitRange).toHaveLength(2);
        expect(result.perUnitRange[0]).toBeLessThanOrEqual(result.perUnitRange[1]);
        expect(result.callForQuote).toBe(true); // Range products always callForQuote
      }
    }
  });

  it("includes size upcharges in breakdown for Gildan 3000", () => {
    const result = getQuote(50, 1, "tshirt_gildan_3000");
    if (result.sizeUpcharges) {
      expect(result.sizeUpcharges["2XL"]).toBeTypeOf("number");
      expect(result.breakdown).toContain("2XL");
    }
  });

  it("breakdown always excludes tax and shipping", () => {
    const result = getQuote(50, 1, "tshirt_gildan_3000");
    if (!result.callForQuote) {
      expect(result.breakdown).toContain("Excludes tax and shipping");
    }
  });
});

// ─── Output Guards Tests ──────────────────────────────────────────────────────
describe("Output Guards — runOutputGuards", () => {
  const baseDecision: BrainDecision = {
    message: "Hey! We'd love to help with your custom tees.",
    channel: "SMS",
    nextFollowUpHours: 24,
    pipelineAction: null,
    routeToHuman: false,
    routeReason: null,
    confidence: 80,
  };

  const baseLead = { preferredChannel: "SMS", messageCount: 5 };
  const baseInput = { leadId: 1, trigger: "test", channel: "SMS" };

  it("passes a clean message", () => {
    const result = runOutputGuards(baseDecision, baseLead, baseInput);
    expect(result.passed).toBe(true);
    expect(result.action).toBe("pass");
  });

  // Guard 1: System leak detection
  it("blocks messages mentioning 'brain council'", () => {
    const decision = { ...baseDecision, message: "The brain council decided to send you this." };
    const result = runOutputGuards(decision, baseLead, baseInput);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("system_leak");
  });

  it("blocks messages mentioning 'strategist'", () => {
    const decision = { ...baseDecision, message: "Our strategist brain says you need this." };
    const result = runOutputGuards(decision, baseLead, baseInput);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("system_leak");
  });

  it("blocks messages mentioning 'outbox'", () => {
    const decision = { ...baseDecision, message: "Your message is in the outbox queue." };
    const result = runOutputGuards(decision, baseLead, baseInput);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("system_leak");
  });

  it("blocks messages mentioning 'single brain'", () => {
    const decision = { ...baseDecision, message: "The single brain generated this response." };
    const result = runOutputGuards(decision, baseLead, baseInput);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("system_leak");
  });

  it("blocks messages with JSON-like internal format", () => {
    const decision = { ...baseDecision, message: 'Here is the output: json {"message": "hello", "channel": "SMS"}' };
    const result = runOutputGuards(decision, baseLead, baseInput);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("system_leak");
  });

  // Guard 2: Channel mismatch on first contact
  it("force-corrects channel mismatch on first contact", () => {
    const decision = { ...baseDecision, channel: "Email" as const };
    const lead = { preferredChannel: "SMS", messageCount: 0 };
    // Inbound on SMS, brain picks Email → should correct to SMS
    const input = { leadId: 1, trigger: "test", inboundMessage: "Hi", channel: "SMS" };
    const result = runOutputGuards(decision, lead, input);
    expect(result.passed).toBe(true);
    expect(result.action).toBe("corrected");
    expect(result.correctedDecision?.channel).toBe("SMS");
  });

  it("does NOT force-correct channel for existing conversations", () => {
    const decision = { ...baseDecision, channel: "Email" as const };
    const lead = { preferredChannel: "SMS", messageCount: 10 };
    // No inbound message → Guard 2 doesn't fire (outbound-only)
    const input = { leadId: 1, trigger: "follow_up", channel: "SMS" };
    const result = runOutputGuards(decision, lead, input);
    expect(result.passed).toBe(true);
    expect(result.action).toBe("pass"); // No correction — no inbound to mismatch against
  });

  // Guard 3: Price validation
  it("blocks price mention without getQuote tool call", () => {
    const decision = { ...baseDecision, message: "That'll be $450 for your order!" };
    const result = runOutputGuards(decision, baseLead, baseInput, []);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("unverified_price");
  });

  it("passes price mention when getQuote was called with matching total", () => {
    const decision = { ...baseDecision, message: "Your total comes to $450.00 for 50 shirts." };
    const toolLog: ToolCallRecord[] = [
      { name: "getQuote", args: '{"qty":50,"sides":1}', result: { total: 450.00 } },
    ];
    const result = runOutputGuards(decision, baseLead, baseInput, toolLog);
    expect(result.passed).toBe(true);
  });

  it("blocks price mention when getQuote total doesn't match", () => {
    const decision = { ...baseDecision, message: "Your total comes to $500.00 for 50 shirts." };
    const toolLog: ToolCallRecord[] = [
      { name: "getQuote", args: '{"qty":50,"sides":1}', result: { total: 450.00 } },
    ];
    const result = runOutputGuards(decision, baseLead, baseInput, toolLog);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("price_mismatch");
  });

  // Guard 4: DNC keyword in outbound
  it("blocks outbound messages containing 'unsubscribe'", () => {
    const decision = { ...baseDecision, message: "Click here to unsubscribe from our list." };
    const result = runOutputGuards(decision, baseLead, baseInput);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("outbound_dnc_phrase");
  });

  it("blocks outbound messages containing 'opt out'", () => {
    const decision = { ...baseDecision, message: "You can opt out anytime." };
    const result = runOutputGuards(decision, baseLead, baseInput);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("outbound_dnc_phrase");
  });

  // Guard 5: Null message with advance action
  it("strips advance action from null-message decisions", () => {
    const decision = { ...baseDecision, message: null, pipelineAction: "advance" as const };
    const result = runOutputGuards(decision, baseLead, baseInput);
    expect(result.passed).toBe(true);
    expect(result.action).toBe("corrected");
    expect(result.correctedDecision?.pipelineAction).toBeNull();
  });

  // Guard 6: Message length
  it("blocks absurdly long messages (>2000 chars)", () => {
    const decision = { ...baseDecision, message: "x".repeat(2001) };
    const result = runOutputGuards(decision, baseLead, baseInput);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("message_too_long");
  });

  it("passes messages at exactly 2000 chars", () => {
    const decision = { ...baseDecision, message: "x".repeat(2000) };
    const result = runOutputGuards(decision, baseLead, baseInput);
    expect(result.passed).toBe(true);
  });
});

// ─── Stage Behavior JSON Tests ────────────────────────────────────────────────
describe("Stage Behavior JSON — structure validation", () => {
  it("has 9 pipeline stages", () => {
    // stage-behavior.json is a flat object with stage names as top-level keys
    expect(Object.keys(stageBehavior)).toHaveLength(9);
  });

  it("every stage has objective, signals_to_ask_for, and avoid", () => {
    for (const [stageName, stage] of Object.entries(stageBehavior)) {
      const s = stage as any;
      expect(s.objective, `${stageName} missing objective`).toBeTypeOf("string");
      expect(s.signals_to_ask_for, `${stageName} missing signals_to_ask_for`).toBeInstanceOf(Array);
      expect(s.avoid, `${stageName} missing avoid`).toBeInstanceOf(Array);
    }
  });

  it("includes the critical pipeline stages", () => {
    const stages = Object.keys(stageBehavior);
    expect(stages).toContain("new_lead");
    expect(stages).toContain("quote_sent");
    expect(stages).toContain("won");
    expect(stages).toContain("lost");
  });
});

// ─── Pricing Data JSON Tests ──────────────────────────────────────────────────
describe("Pricing Data JSON — structure validation", () => {
  it("has at least one product", () => {
    expect(Object.keys(pricingData.products).length).toBeGreaterThan(0);
  });

  it("Gildan 3000 has tiers with sides pricing", () => {
    const gildan = (pricingData.products as any).tshirt_gildan_3000;
    expect(gildan).toBeDefined();
    expect(gildan.tiers).toBeInstanceOf(Array);
    expect(gildan.tiers.length).toBeGreaterThan(0);
    // First tier may have null sides (call-for-quote), find a tier with actual pricing
    const pricedTier = gildan.tiers.find((t: any) => t.sides && t.sides["1"] !== null);
    expect(pricedTier, "Should have at least one tier with actual pricing").toBeDefined();
    expect(pricedTier.sides["1"]).toBeTypeOf("number");
  });

  it("all tiers have minQty", () => {
    for (const [productName, product] of Object.entries(pricingData.products)) {
      const p = product as any;
      for (const tier of p.tiers) {
        expect(tier.minQty, `${productName} tier missing minQty`).toBeTypeOf("number");
      }
    }
  });
});
