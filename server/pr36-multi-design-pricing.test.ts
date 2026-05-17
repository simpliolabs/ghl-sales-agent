/**
 * PR#3.6 — Multi-Design Pricing Engine Tests
 *
 * Covers:
 * 1. Single-design fallback (one element in array)
 * 2. Multi-design WITHOUT volume discount (e.g., 60 shirts / 2 designs)
 * 3. Multi-design WITH volume discount (e.g., 120 shirts / 3 designs)
 * 4. Edge case: exactly 100 shirts / exactly 4 designs — discount applies
 * 5. Edge case: 100 shirts / 5 designs — discount does NOT apply
 * 6. Rush surcharge stacking with volume discount
 * 7. Even-split assumed flag propagation
 * 8. Unknown product fallback
 * 9. Below-minimum tier fallback for small per-design quantities
 */
import { describe, it, expect } from "vitest";
import { getMultiDesignQuote, getQuote, type DesignSpec } from "./pricing-engine";

describe("getMultiDesignQuote", () => {
  // ── 1. Single-design fallback ──────────────────────────────────────────
  it("single-design array matches getQuote for same qty/sides", () => {
    const multi = getMultiDesignQuote([{ qty: 25, sides: 2 }]);
    const single = getQuote(25, 2);

    // Single design, no volume discount → should match getQuote's subtotal
    expect(multi.designs).toHaveLength(1);
    expect(multi.designs[0].qty).toBe(25);
    expect(multi.designs[0].sides).toBe(2);
    expect(multi.designs[0].perUnit).toBe(single.perUnit);
    expect(multi.designs[0].subtotal).toBe(single.subtotal);
    expect(multi.volumeDiscountApplied).toBe(false);
    expect(multi.estimateTotal).toBe(single.subtotal);
  });

  // ── 2. Multi-design WITHOUT volume discount ────────────────────────────
  it("2 designs, 60 total shirts — no volume discount (< 100)", () => {
    // 30 shirts each, 2-side → 20-tier ($14.90/shirt)
    const designs: DesignSpec[] = [
      { qty: 30, sides: 2 },
      { qty: 30, sides: 2 },
    ];
    const result = getMultiDesignQuote(designs);

    expect(result.designs).toHaveLength(2);
    expect(result.volumeDiscountApplied).toBe(false);
    expect(result.volumeDiscountReason).toBeNull();

    // 30 shirts at 20-tier = $14.90/shirt → $447.00 each
    const expectedPerDesign = 14.90 * 30; // $447.00
    expect(result.designs[0].subtotal).toBeCloseTo(expectedPerDesign, 2);
    expect(result.designs[0].discountedSubtotal).toBeCloseTo(expectedPerDesign, 2);
    expect(result.estimateTotal).toBeCloseTo(expectedPerDesign * 2, 2);
    expect(result.rushSurcharge).toBe(0);
  });

  // ── 3. Multi-design WITH volume discount ───────────────────────────────
  it("3 designs, 120 total shirts — 10% volume discount applies", () => {
    // 40 each, 2-side → 20-tier ($14.90/shirt)
    const designs: DesignSpec[] = [
      { qty: 40, sides: 2 },
      { qty: 40, sides: 2 },
      { qty: 40, sides: 2 },
    ];
    const result = getMultiDesignQuote(designs);

    expect(result.volumeDiscountApplied).toBe(true);
    expect(result.volumeDiscountReason).toContain("10% volume discount");
    expect(result.volumeDiscountReason).toContain("120");
    expect(result.volumeDiscountReason).toContain("3 designs");

    // 40 × $14.90 = $596.00 per design, discounted = $536.40
    const rawPerDesign = 14.90 * 40;
    const discountedPerDesign = Math.round(rawPerDesign * 0.90 * 100) / 100;
    expect(result.designs[0].subtotal).toBeCloseTo(rawPerDesign, 2);
    expect(result.designs[0].discountedSubtotal).toBeCloseTo(discountedPerDesign, 2);
    expect(result.estimateTotal).toBeCloseTo(discountedPerDesign * 3, 2);
  });

  // ── 4. Edge: exactly 100 shirts / exactly 4 designs — discount applies ─
  it("exactly 100 shirts / 4 designs — discount applies (boundary)", () => {
    const designs: DesignSpec[] = [
      { qty: 25, sides: 1 },
      { qty: 25, sides: 1 },
      { qty: 25, sides: 1 },
      { qty: 25, sides: 1 },
    ];
    const result = getMultiDesignQuote(designs);

    expect(result.volumeDiscountApplied).toBe(true);
    // 25 each at 20-tier ($11.90/shirt) → $297.50 per design
    const rawPerDesign = 11.90 * 25;
    const discountedPerDesign = Math.round(rawPerDesign * 0.90 * 100) / 100;
    expect(result.designs[0].subtotal).toBeCloseTo(rawPerDesign, 2);
    expect(result.designs[0].discountedSubtotal).toBeCloseTo(discountedPerDesign, 2);
    expect(result.estimateTotal).toBeCloseTo(discountedPerDesign * 4, 2);
  });

  // ── 5. Edge: 100 shirts / 5 designs — discount does NOT apply ──────────
  it("100 shirts / 5 designs — no discount (> 4 designs)", () => {
    const designs: DesignSpec[] = [
      { qty: 20, sides: 1 },
      { qty: 20, sides: 1 },
      { qty: 20, sides: 1 },
      { qty: 20, sides: 1 },
      { qty: 20, sides: 1 },
    ];
    const result = getMultiDesignQuote(designs);

    expect(result.volumeDiscountApplied).toBe(false);
    expect(result.volumeDiscountReason).toBeNull();

    // 20 each at 20-tier ($11.90/shirt) → $238.00 per design
    const rawPerDesign = 11.90 * 20;
    expect(result.designs[0].subtotal).toBeCloseTo(rawPerDesign, 2);
    expect(result.designs[0].discountedSubtotal).toBeCloseTo(rawPerDesign, 2);
    expect(result.estimateTotal).toBeCloseTo(rawPerDesign * 5, 2);
  });

  // ── 6. Rush surcharge stacking with volume discount ────────────────────
  it("rush + volume discount: 20% rush applied AFTER 10% discount", () => {
    // 120 shirts / 3 designs, rush
    const designs: DesignSpec[] = [
      { qty: 40, sides: 2 },
      { qty: 40, sides: 2 },
      { qty: 40, sides: 2 },
    ];
    const result = getMultiDesignQuote(designs, true); // rush = true

    expect(result.volumeDiscountApplied).toBe(true);

    // 40 × $14.90 = $596.00 per design, discounted = $536.40
    const rawPerDesign = 14.90 * 40;
    const discountedPerDesign = Math.round(rawPerDesign * 0.90 * 100) / 100;
    const subtotalBeforeRush = discountedPerDesign * 3;
    const expectedRush = Math.round(subtotalBeforeRush * 0.20 * 100) / 100;
    const expectedTotal = Math.round((subtotalBeforeRush + expectedRush) * 100) / 100;

    expect(result.subtotalBeforeRush).toBeCloseTo(subtotalBeforeRush, 2);
    expect(result.rushSurcharge).toBeCloseTo(expectedRush, 2);
    expect(result.estimateTotal).toBeCloseTo(expectedTotal, 2);
  });

  // ── 7. Even-split assumed flag propagation ─────────────────────────────
  it("evenSplitAssumed flag propagates to result and notes", () => {
    const result = getMultiDesignQuote(
      [{ qty: 10, sides: 1 }, { qty: 10, sides: 1 }],
      false, "tshirt_gildan_3000", true
    );
    expect(result.evenSplitAssumed).toBe(true);
    expect(result.notes.some(n => n.includes("even"))).toBe(true);
    expect(result.breakdown).toContain("Even split assumed");
  });

  it("evenSplitAssumed=false does not add even-split note", () => {
    const result = getMultiDesignQuote(
      [{ qty: 10, sides: 1 }, { qty: 10, sides: 1 }],
      false, "tshirt_gildan_3000", false
    );
    expect(result.evenSplitAssumed).toBe(false);
    expect(result.breakdown).not.toContain("Even split assumed");
  });

  // ── 8. Unknown product fallback ────────────────────────────────────────
  it("unknown product returns empty designs + breakdown message", () => {
    const result = getMultiDesignQuote(
      [{ qty: 20, sides: 1 }],
      false, "nonexistent_product"
    );
    expect(result.designs).toHaveLength(0);
    expect(result.estimateTotal).toBe(0);
    expect(result.breakdown).toContain("not in our pricing table");
  });

  // ── 9. Below-minimum tier fallback ─────────────────────────────────────
  it("per-design qty below minimum tier uses lowest tier as estimate", () => {
    // 3 designs × 3 shirts each = 9 total. Per-design qty 3 is below min tier 6.
    const result = getMultiDesignQuote([
      { qty: 3, sides: 1 },
      { qty: 3, sides: 1 },
      { qty: 3, sides: 1 },
    ]);
    // Should still produce a result (using 6-tier price as fallback)
    expect(result.designs).toHaveLength(3);
    expect(result.designs[0].perUnit).toBeGreaterThan(0);
    expect(result.notes.some(n => n.includes("below minimum tier"))).toBe(true);
  });

  // ── 10. Mixed sides across designs ─────────────────────────────────────
  it("designs with different sides get priced independently", () => {
    // Design 1: 50 shirts, 1-side → 45-tier ($8.75)
    // Design 2: 50 shirts, 2-side → 45-tier ($11.75)
    const result = getMultiDesignQuote([
      { qty: 50, sides: 1 },
      { qty: 50, sides: 2 },
    ]);

    expect(result.volumeDiscountApplied).toBe(true); // 100 total, 2 designs
    expect(result.designs[0].perUnit).toBe(8.75);
    expect(result.designs[1].perUnit).toBe(11.75);
    expect(result.designs[0].subtotal).toBeCloseTo(8.75 * 50, 2);
    expect(result.designs[1].subtotal).toBeCloseTo(11.75 * 50, 2);
  });

  // ── 11. Breakdown string includes key information ──────────────────────
  it("breakdown string includes design count, totals, and notes", () => {
    const result = getMultiDesignQuote([
      { qty: 20, sides: 2 },
      { qty: 20, sides: 2 },
    ]);
    expect(result.breakdown).toContain("40 shirts");
    expect(result.breakdown).toContain("2 designs");
    expect(result.breakdown).toContain("Design 1");
    expect(result.breakdown).toContain("Design 2");
    expect(result.breakdown).toContain("Size upcharges not included");
  });

  // ── 12. Size upcharges note always present ─────────────────────────────
  it("notes always include size upcharge reminder", () => {
    const result = getMultiDesignQuote([{ qty: 20, sides: 1 }]);
    expect(result.notes.some(n => n.includes("Size upcharges"))).toBe(true);
  });
});
