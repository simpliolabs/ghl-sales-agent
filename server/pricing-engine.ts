/**
 * PRICING ENGINE — The ONLY code allowed to produce prices.
 * 
 * The LLM calls getQuote as a tool. This module reads pricing-data.json
 * and returns exact prices for Gildan 3000 t-shirts, or ranges for other products.
 * 
 * NEVER let the LLM freehand a price — it must call this tool.
 */

import pricingData from "../shared/pricing-data.json";

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
