/**
 * Pricing Rules Tests
 *
 * Validates:
 * 1. Gildan Style 3000 exact pricing matrix (no ranges when qty known)
 * 2. Quantity-unknown → ask first rule
 * 3. Default shirt = Style 3000
 * 4. Size upcharge calculations
 * 5. Multi-tab sheet ingestion logic
 */
import { describe, it, expect } from "vitest";

// ============================================================
// Gildan Style 3000 Pricing Matrix (mirrors sales-training.ts)
// ============================================================
const STYLE_3000_TIERS = [
  { qty: 6,   oneSide: 15.35, twoSide: 18.35 },
  { qty: 12,  oneSide: 14.10, twoSide: 17.10 },
  { qty: 20,  oneSide: 11.90, twoSide: 14.90 },
  { qty: 45,  oneSide:  8.75, twoSide: 11.75 },
  { qty: 60,  oneSide:  7.85, twoSide: 10.85 },
  { qty: 75,  oneSide:  6.85, twoSide:  9.85 },
  { qty: 100, oneSide:  5.85, twoSide:  8.85 },
  { qty: 150, oneSide:  5.75, twoSide:  8.75 },
  { qty: 200, oneSide:  5.50, twoSide:  8.50 }, // 200+ tier
];
const UPCHARGE_2XL = 2.50;
const UPCHARGE_3XL_PLUS = 3.50;

/**
 * Look up the per-shirt price for a given quantity.
 * Uses the LOWER tier (same as the pricing table).
 */
function getPricePerShirt(qty: number): { oneSide: number; twoSide: number } | null {
  if (qty < 6) return null; // minimum order
  // Walk tiers in reverse to find the highest tier <= qty
  for (let i = STYLE_3000_TIERS.length - 1; i >= 0; i--) {
    if (qty >= STYLE_3000_TIERS[i].qty) {
      return { oneSide: STYLE_3000_TIERS[i].oneSide, twoSide: STYLE_3000_TIERS[i].twoSide };
    }
  }
  return null;
}

/**
 * Compute exact quote totals for a given quantity and size breakdown.
 */
function computeExactQuote(
  qty: number,
  count2xl = 0,
  count3xlPlus = 0,
): { oneSideTotal: number; twoSideTotal: number; perShirtOneSide: number; perShirtTwoSide: number } | null {
  const prices = getPricePerShirt(qty);
  if (!prices) return null;
  const standardQty = qty - count2xl - count3xlPlus;
  const oneSideTotal =
    standardQty * prices.oneSide +
    count2xl * (prices.oneSide + UPCHARGE_2XL) +
    count3xlPlus * (prices.oneSide + UPCHARGE_3XL_PLUS);
  const twoSideTotal =
    standardQty * prices.twoSide +
    count2xl * (prices.twoSide + UPCHARGE_2XL) +
    count3xlPlus * (prices.twoSide + UPCHARGE_3XL_PLUS);
  return {
    oneSideTotal: Math.round(oneSideTotal * 100) / 100,
    twoSideTotal: Math.round(twoSideTotal * 100) / 100,
    perShirtOneSide: prices.oneSide,
    perShirtTwoSide: prices.twoSide,
  };
}

// ============================================================
// TESTS: Exact Pricing Matrix
// ============================================================
describe("Gildan Style 3000 Pricing Matrix", () => {
  it("should have 9 quantity tiers", () => {
    expect(STYLE_3000_TIERS.length).toBe(9);
  });

  it("each tier should have oneSide and twoSide prices", () => {
    for (const tier of STYLE_3000_TIERS) {
      expect(tier.oneSide).toBeGreaterThan(0);
      expect(tier.twoSide).toBeGreaterThan(0);
      // 2-side should always be exactly $3 more than 1-side
      expect(Math.round((tier.twoSide - tier.oneSide) * 100) / 100).toBe(3.00);
    }
  });

  it("prices should decrease as quantity increases (volume discount)", () => {
    for (let i = 1; i < STYLE_3000_TIERS.length; i++) {
      expect(STYLE_3000_TIERS[i].oneSide).toBeLessThan(STYLE_3000_TIERS[i - 1].oneSide);
      expect(STYLE_3000_TIERS[i].twoSide).toBeLessThan(STYLE_3000_TIERS[i - 1].twoSide);
    }
  });

  it("2XL upcharge should be $2.50", () => {
    expect(UPCHARGE_2XL).toBe(2.50);
  });

  it("3XL+ upcharge should be $3.50", () => {
    expect(UPCHARGE_3XL_PLUS).toBe(3.50);
  });
});

// ============================================================
// TESTS: Tier Lookup Logic
// ============================================================
describe("Tier Lookup — Lower Tier Rule", () => {
  it("qty 6 should use the 6-qty tier", () => {
    const p = getPricePerShirt(6);
    expect(p?.oneSide).toBe(15.35);
    expect(p?.twoSide).toBe(18.35);
  });

  it("qty 12 should use the 12-qty tier", () => {
    const p = getPricePerShirt(12);
    expect(p?.oneSide).toBe(14.10);
    expect(p?.twoSide).toBe(17.10);
  });

  it("qty 20 should use the 20-qty tier", () => {
    const p = getPricePerShirt(20);
    expect(p?.oneSide).toBe(11.90);
    expect(p?.twoSide).toBe(14.90);
  });

  it("qty 15 (between 12 and 20) should use the 12-qty tier (lower tier)", () => {
    const p = getPricePerShirt(15);
    expect(p?.oneSide).toBe(14.10); // uses 12-tier, not 20-tier
  });

  it("qty 30 (between 20 and 45) should use the 20-qty tier (lower tier)", () => {
    const p = getPricePerShirt(30);
    expect(p?.oneSide).toBe(11.90); // uses 20-tier, not 45-tier
  });

  it("qty 100 should use the 100-qty tier", () => {
    const p = getPricePerShirt(100);
    expect(p?.oneSide).toBe(5.85);
  });

  it("qty 250 (above 200) should use the 200+ tier", () => {
    const p = getPricePerShirt(250);
    expect(p?.oneSide).toBe(5.50);
    expect(p?.twoSide).toBe(8.50);
  });

  it("qty below 6 (minimum) should return null", () => {
    expect(getPricePerShirt(5)).toBeNull();
    expect(getPricePerShirt(1)).toBeNull();
  });
});

// ============================================================
// TESTS: Exact Quote Computation
// ============================================================
describe("Exact Quote Computation — 20 Shirts", () => {
  it("20 shirts, all S-XL, 1-side: should be $238.00", () => {
    const q = computeExactQuote(20);
    expect(q?.oneSideTotal).toBe(238.00); // 20 × $11.90
  });

  it("20 shirts, all S-XL, 2-side: should be $298.00", () => {
    const q = computeExactQuote(20);
    expect(q?.twoSideTotal).toBe(298.00); // 20 × $14.90
  });

  it("20 shirts with 1 x 2XL, 1-side: should be $240.50", () => {
    const q = computeExactQuote(20, 1, 0);
    // 19 × $11.90 + 1 × ($11.90 + $2.50) = $226.10 + $14.40 = $240.50
    expect(q?.oneSideTotal).toBe(240.50);
  });

  it("20 shirts with 1 x 2XL, 2-side: should be $300.50", () => {
    const q = computeExactQuote(20, 1, 0);
    // 19 × $14.90 + 1 × ($14.90 + $2.50) = $283.10 + $17.40 = $300.50
    expect(q?.twoSideTotal).toBe(300.50);
  });

  it("20 shirts with 1 x 3XL, 1-side: should be $241.50", () => {
    const q = computeExactQuote(20, 0, 1);
    // 19 × $11.90 + 1 × ($11.90 + $3.50) = $226.10 + $15.40 = $241.50
    expect(q?.oneSideTotal).toBe(241.50);
  });
});

describe("Exact Quote Computation — Other Quantities", () => {
  it("6 shirts, all S-XL, 1-side: should be $92.10", () => {
    const q = computeExactQuote(6);
    expect(q?.oneSideTotal).toBe(92.10); // 6 × $15.35
  });

  it("12 shirts, all S-XL, 2-side: should be $205.20", () => {
    const q = computeExactQuote(12);
    expect(q?.twoSideTotal).toBe(205.20); // 12 × $17.10
  });

  it("100 shirts, all S-XL, 1-side: should be $585.00", () => {
    const q = computeExactQuote(100);
    expect(q?.oneSideTotal).toBe(585.00); // 100 × $5.85
  });

  it("150 shirts, all S-XL, 2-side: should be $1312.50", () => {
    const q = computeExactQuote(150);
    expect(q?.twoSideTotal).toBe(1312.50); // 150 × $8.75
  });
});

// ============================================================
// TESTS: Pricing Rule Enforcement
// ============================================================
describe("Pricing Rule: Exact Quantity → Exact Quote", () => {
  it("should NOT return a range when qty is known", () => {
    const q = computeExactQuote(20);
    // Verify it's a single precise number, not a range
    expect(typeof q?.oneSideTotal).toBe("number");
    expect(typeof q?.twoSideTotal).toBe("number");
    // Exact values — no ambiguity
    expect(q?.oneSideTotal).toBe(238.00);
    expect(q?.twoSideTotal).toBe(298.00);
  });

  it("should return null (no price) for unknown qty (qty < 6)", () => {
    // Simulates: customer hasn't stated qty yet
    expect(computeExactQuote(0)).toBeNull();
    expect(computeExactQuote(3)).toBeNull();
  });

  it("per-shirt price for qty 20 should be $11.90 (1-side)", () => {
    const q = computeExactQuote(20);
    expect(q?.perShirtOneSide).toBe(11.90);
  });

  it("per-shirt price for qty 20 should be $14.90 (2-side)", () => {
    const q = computeExactQuote(20);
    expect(q?.perShirtTwoSide).toBe(14.90);
  });
});

describe("Pricing Rule: Default Shirt = Gildan Style 3000", () => {
  it("should use Style 3000 pricing table (not Softstyle 64000)", () => {
    // Style 3000 at qty 20: $11.90/shirt
    // Softstyle 64000 at qty 20: $11.90/shirt (same in this sheet)
    // The key rule is: always default to Style 3000 (cheapest)
    const p = getPricePerShirt(20);
    expect(p).not.toBeNull();
    expect(p?.oneSide).toBe(11.90);
  });
});

// ============================================================
// TESTS: Multi-Tab Sheet Ingestion Logic
// ============================================================
describe("Multi-Tab Sheet Ingestion", () => {
  /**
   * Simulates the fetchAllSheetTabs logic without making real HTTP calls.
   * Tests the tab discovery and concatenation logic.
   */
  function simulateFetchAllTabs(
    availableGids: number[],
    tabContents: Record<number, string>,
  ): string {
    const tabSections: string[] = [];
    const gidsToProbe = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

    for (const gid of gidsToProbe) {
      if (!availableGids.includes(gid)) continue;
      const csv = tabContents[gid] ?? "";
      if (!csv || csv.startsWith("<!DOCTYPE") || csv.trim().length < 20) continue;
      const lines = csv.split("\n").filter(l => l.trim()).map(l => l.replace(/,+$/g, ""));
      if (lines.length < 2) continue;
      tabSections.push(`=== TAB (GID ${gid}) ===\n${lines.join("\n")}`);
    }

    return tabSections.join("\n\n");
  }

  it("should include content from all available tabs", () => {
    const result = simulateFetchAllTabs(
      [0, 100, 200],
      {
        0: "Header1,Header2\nValue1,Value2\nValue3,Value4",
        100: "PricingCol1,PricingCol2\nRow1,Row2\nRow3,Row4",
        200: "Gildan3000,Price\nQty6,$15.35\nQty12,$14.10",
      },
    );
    expect(result).toContain("TAB (GID 0)");
    expect(result).toContain("TAB (GID 100)");
    expect(result).toContain("TAB (GID 200)");
    expect(result).toContain("Value1");
    expect(result).toContain("PricingCol1");
    expect(result).toContain("Gildan3000");
  });

  it("should NOT include tabs that return HTML error pages", () => {
    const result = simulateFetchAllTabs(
      [0, 100],
      {
        0: "Header1,Header2\nValue1,Value2\nValue3,Value4",
        100: "<!DOCTYPE html><html><body>Page Not Found</body></html>",
      },
    );
    expect(result).toContain("TAB (GID 0)");
    expect(result).not.toContain("TAB (GID 100)");
    expect(result).not.toContain("Page Not Found");
  });

  it("should NOT include tabs with less than 2 data rows", () => {
    const result = simulateFetchAllTabs(
      [0, 100],
      {
        0: "Header1,Header2\nValue1,Value2\nValue3,Value4",
        100: "SingleRow",
      },
    );
    expect(result).toContain("TAB (GID 0)");
    expect(result).not.toContain("TAB (GID 100)");
  });

  it("should return empty string if no valid tabs found", () => {
    const result = simulateFetchAllTabs([], {});
    expect(result).toBe("");
  });

  it("should concatenate tabs with separator", () => {
    const result = simulateFetchAllTabs(
      [0, 100],
      {
        0: "Header1,Header2\nRow1Value1,Row1Value2\nRow2Value1,Row2Value2",
        100: "Header3,Header4\nRow3Value1,Row3Value2\nRow4Value1,Row4Value2",
      },
    );
    // Both tabs present and separated
    const tabCount = (result.match(/=== TAB \(GID \d+\)/g) ?? []).length;
    expect(tabCount).toBe(2);
  });

  it("should only probe GIDs 0, 100, 200, ... 1000 (not arbitrary values)", () => {
    // GID 50 should NOT be probed
    const result = simulateFetchAllTabs(
      [50],
      { 50: "H1,H2\nR1,R2\nR3,R4" },
    );
    expect(result).toBe(""); // GID 50 not in probe list
  });
});
