/**
 * PRICING ENGINE — The ONLY code allowed to produce prices.
 * 
 * The LLM calls getQuote as a tool. This module reads pricing-data.json
 * and returns exact prices for Gildan 3000 t-shirts, or ranges for other products.
 * 
 * NEVER let the LLM freehand a price — it must call this tool.
 */

import pricingData from "../shared/pricing-data.json";

// ── Multi-design types ─────────────────────────────────────────────────

export interface DesignSpec {
  qty: number;
  sides: 1 | 2;
}

export interface MultiDesignQuoteResult {
  designs: Array<{
    qty: number;
    sides: 1 | 2;
    perUnit: number;
    subtotal: number;
    discountedSubtotal: number;
  }>;
  volumeDiscountApplied: boolean;
  volumeDiscountReason: string | null;
  subtotalBeforeRush: number;
  rushSurcharge: number;
  estimateTotal: number;
  evenSplitAssumed: boolean;
  notes: string[];
  breakdown: string;
}

export interface QuoteResult {
  product: string;
  productName: string;
  qty: number;
  sides: number;
  perUnit: number | null;
  perUnitRange: [number, number] | null;
  subtotal: number | null;
  rushFee: number | null;
  setupFee: number;
  total: number | null;
  sizeUpcharges?: Record<string, number>;
  breakdown: string;
  callForQuote: boolean;
  error?: string;
}

/**
 * Get a quote for a product.
 * 
 * For Gildan 3000 t-shirts: returns exact pricing.
 * For other products: returns a price range.
 * For unknown products or out-of-range quantities: returns callForQuote=true.
 */
/**
 * Multi-design quote calculator.
 *
 * Each design is priced independently at its own quantity tier.
 * Volume discount: 10% off each design if totalQty >= 100 AND designs <= 4.
 * Rush: +20% on the whole order.
 * Size upcharges are NOT included — they finalize the estimate later.
 *
 * @param designs - Array of { qty, sides } per distinct design
 * @param rush - Rush order flag (20% surcharge)
 * @param product - Product key (default: tshirt_gildan_3000)
 * @param evenSplitAssumed - Whether the caller assumed an even split (set by tool wrapper)
 */
export function getMultiDesignQuote(
  designs: DesignSpec[],
  rush: boolean = false,
  product: string = "tshirt_gildan_3000",
  evenSplitAssumed: boolean = false
): MultiDesignQuoteResult {
  const p = (pricingData.products as any)[product];
  const notes: string[] = [];

  if (!p) {
    return {
      designs: [], volumeDiscountApplied: false, volumeDiscountReason: null,
      subtotalBeforeRush: 0, rushSurcharge: 0, estimateTotal: 0,
      evenSplitAssumed, notes: [`Product "${product}" not in pricing table.`],
      breakdown: `Product "${product}" not in our pricing table. I'll have our team put together a custom quote for that.`,
    };
  }

  const totalQty = designs.reduce((sum, d) => sum + d.qty, 0);
  const designCount = designs.length;

  // Price each design independently
  const pricedDesigns = designs.map((d) => {
    // Find tier for this design's qty
    const tier = [...p.tiers]
      .filter((t: any) => d.qty >= t.minQty)
      .sort((a: any, b: any) => b.minQty - a.minQty)[0];

    if (!tier) {
      // Qty below minimum — use first tier with actual prices as fallback
      const sideKey = String(d.sides) as "1" | "2";
      const fallbackTier = [...p.tiers]
        .sort((a: any, b: any) => a.minQty - b.minQty)
        .find((t: any) => t.sides?.[sideKey] != null);
      const perUnit = fallbackTier ? (fallbackTier as any).sides[sideKey] : 0;
      const minQty = fallbackTier ? fallbackTier.minQty : 1;
      notes.push(`Design with qty ${d.qty} is below minimum tier (${minQty}). Using ${minQty}-tier price as estimate.`);
      return { qty: d.qty, sides: d.sides as 1 | 2, perUnit, subtotal: perUnit * d.qty, discountedSubtotal: perUnit * d.qty };
    }

    const sideKey = String(d.sides) as "1" | "2";
    const rawPrice = (tier as any).sides?.[sideKey];

    // If the matched tier has null price (e.g., 1-5 "call for quote"), use next tier with actual prices
    if (rawPrice == null) {
      const fallbackTier = [...p.tiers]
        .sort((a: any, b: any) => a.minQty - b.minQty)
        .find((t: any) => t.sides?.[sideKey] != null);
      const perUnit = fallbackTier ? (fallbackTier as any).sides[sideKey] : 0;
      const minQty = fallbackTier ? fallbackTier.minQty : 1;
      notes.push(`Design with qty ${d.qty} is below minimum tier (${minQty}). Using ${minQty}-tier price as estimate.`);
      return { qty: d.qty, sides: d.sides as 1 | 2, perUnit, subtotal: perUnit * d.qty, discountedSubtotal: perUnit * d.qty };
    }

    const perUnit = rawPrice;
    const subtotal = perUnit * d.qty;
    return { qty: d.qty, sides: d.sides as 1 | 2, perUnit, subtotal, discountedSubtotal: subtotal };
  });

  // Volume discount: 10% off if totalQty >= 100 AND designCount <= 4
  let volumeDiscountApplied = false;
  let volumeDiscountReason: string | null = null;
  if (totalQty >= 100 && designCount <= 4) {
    volumeDiscountApplied = true;
    volumeDiscountReason = `10% volume discount applied: ${totalQty} total shirts across ${designCount} designs (requires ≥100 qty and ≤4 designs).`;
    for (const d of pricedDesigns) {
      d.discountedSubtotal = Math.round(d.subtotal * 0.90 * 100) / 100;
    }
  }

  const subtotalBeforeRush = pricedDesigns.reduce((sum, d) => sum + d.discountedSubtotal, 0);
  const rushSurcharge = rush ? Math.round(subtotalBeforeRush * 0.20 * 100) / 100 : 0;
  const estimateTotal = Math.round((subtotalBeforeRush + rushSurcharge) * 100) / 100;

  if (evenSplitAssumed) {
    notes.push("Quantities were split evenly across designs — confirm the actual breakdown with the lead.");
  }
  notes.push("Size upcharges (2XL +$2.50, 3XL-5XL +$3.50) not included — finalize after size breakdown is confirmed.");
  notes.push("Excludes tax and shipping.");

  // Build human-readable breakdown
  const designLines = pricedDesigns.map((d, i) => {
    let line = `  Design ${i + 1}: ${d.qty} × $${d.perUnit.toFixed(2)} (${d.sides}-side) = $${d.subtotal.toFixed(2)}`;
    if (volumeDiscountApplied) {
      line += ` → $${d.discountedSubtotal.toFixed(2)} after 10% discount`;
    }
    return line;
  }).join("\n");

  let breakdown = `${totalQty} shirts, ${designCount} design${designCount > 1 ? "s" : ""} (${p.name}):\n${designLines}`;
  if (volumeDiscountApplied) breakdown += `\n  Volume discount: 10% off (≥100 qty, ≤4 designs)`;
  breakdown += `\n  Subtotal: $${subtotalBeforeRush.toFixed(2)}`;
  if (rush) breakdown += `\n  Rush surcharge (20%): +$${rushSurcharge.toFixed(2)}`;
  breakdown += `\n  Estimate total: $${estimateTotal.toFixed(2)}`;
  if (evenSplitAssumed) breakdown += `\n  ⚠ Even split assumed — confirm actual breakdown with lead.`;
  breakdown += `\n  Size upcharges not included. Excludes tax and shipping.`;

  return {
    designs: pricedDesigns,
    volumeDiscountApplied,
    volumeDiscountReason,
    subtotalBeforeRush,
    rushSurcharge,
    estimateTotal,
    evenSplitAssumed,
    notes,
    breakdown,
  };
}

export function getQuote(
  qty: number,
  sides: 1 | 2,
  product: string = "tshirt_gildan_3000",
  rush: boolean = false
): QuoteResult {
  const p = (pricingData.products as any)[product];
  if (!p) {
    return {
      product, productName: product, qty, sides,
      perUnit: null, perUnitRange: null, subtotal: null,
      rushFee: null, setupFee: 0, total: null,
      breakdown: `Product "${product}" not in our pricing table. I'll have our team put together a custom quote for that.`,
      callForQuote: true,
    };
  }

  // Find the tier: use the HIGHEST tier whose minQty <= qty
  const tier = [...p.tiers]
    .filter((t: any) => qty >= t.minQty)
    .sort((a: any, b: any) => b.minQty - a.minQty)[0];

  if (!tier) {
    return {
      product, productName: p.name, qty, sides,
      perUnit: null, perUnitRange: null, subtotal: null,
      rushFee: null, setupFee: 0, total: null,
      breakdown: `Quantity ${qty} is below our minimum for ${p.name}. Contact us for a custom quote.`,
      callForQuote: true,
    };
  }

  // Range-priced products (hoodies, hats, mugs, etc.)
  if ((tier as any).isRange) {
    const priceField = (tier as any).price || (tier as any).sides?.[String(sides)];
    if (!priceField) {
      return {
        product, productName: p.name, qty, sides,
        perUnit: null, perUnitRange: null, subtotal: null,
        rushFee: null, setupFee: 0, total: null,
        breakdown: `No pricing available for ${p.name} with ${sides}-side print at qty ${qty}.`,
        callForQuote: true,
      };
    }

    const [low, high] = priceField as [number, number];
    const lowTotal = low * qty;
    const highTotal = high * qty;

    return {
      product, productName: p.name, qty, sides,
      perUnit: null, perUnitRange: [low, high],
      subtotal: null, rushFee: null, setupFee: p.setupFee || 0,
      total: null,
      breakdown: `${qty} × $${low.toFixed(2)}–$${high.toFixed(2)} (${p.name}) = $${lowTotal.toFixed(2)}–$${highTotal.toFixed(2)} estimated range. For an exact quote, I'll have our team price this out for you.`,
      callForQuote: true,
    };
  }

  // Exact-priced products (Gildan 3000 t-shirts)
  const sideKey = String(sides) as "1" | "2";
  const perUnit = (tier as any).sides?.[sideKey];

  if (perUnit === null || perUnit === undefined) {
    return {
      product, productName: p.name, qty, sides,
      perUnit: null, perUnitRange: null, subtotal: null,
      rushFee: null, setupFee: 0, total: null,
      breakdown: `For orders of ${qty} ${p.name}, we quote individually — reply with your full order details.`,
      callForQuote: true,
    };
  }

  const subtotal = perUnit * qty;
  const rushFee = rush ? subtotal * 0.20 : 0; // 20% rush surcharge
  const total = subtotal + rushFee + (p.setupFee || 0);

  const sizeUpcharges = p.sizeUpcharges || undefined;

  let breakdown = `${qty} × $${perUnit.toFixed(2)} (${sides}-side ${p.name})`;
  if (rush) breakdown += ` + $${rushFee.toFixed(2)} rush fee`;
  breakdown += ` = $${total.toFixed(2)} total`;
  if (sizeUpcharges) {
    breakdown += `\n• 2XL sizes: add $${sizeUpcharges["2XL"]}/shirt | 3XL+: add $${sizeUpcharges["3XL-5XL"]}/shirt`;
  }
  breakdown += `\nExcludes tax and shipping.`;

  return {
    product, productName: p.name, qty, sides,
    perUnit, perUnitRange: null, subtotal, rushFee,
    setupFee: p.setupFee || 0, total, sizeUpcharges,
    breakdown, callForQuote: false,
  };
}
