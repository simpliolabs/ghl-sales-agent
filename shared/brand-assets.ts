/**
 * BRAND ASSETS — Single source of truth for all brand constants
 *
 * Instead of hardcoding phone, email, address, review links, and signature blocks
 * across 10+ files, all brand constants live here. Brain prompts reference these
 * constants, and the Composer/QC use them for signature blocks and verification.
 *
 * To update any brand asset: change it HERE, and all prompts pick it up automatically.
 */

export const BRAND = {
  // --- Company Identity ---
  companyName: "Adorb Custom Tees",
  printingBrand: "Adorb Custom Printing",
  bulkBrand: "Adorb Bulk Printing",

  // --- Contact Info ---
  phone: "(954) 932-8543",
  email: "print@adorbcustomtees.com",
  address: "389 NE 2nd Ave, Hallandale Beach, FL 33009",
  city: "Hallandale Beach",
  state: "FL",
  hours: "Mon-Fri 9:30am-5pm (closed weekends)",

  // --- Websites ---
  website: "adorbcustomtees.com",
  bulkWebsite: "print.adorbcustomtees.com",

  // --- Review Links (verified correct — do NOT use g.co/kgs/adorb) ---
  googleReviews: "https://share.google/Bl291vQ1iaSRs9jmG",
  trustpilot: "https://www.trustpilot.com/review/adorbcustomtees.com",
  websiteReviews: "https://adorbcustomtees.com/pages/reviews",
  reviewStars: "4.9",
  reviewCount: "867+",

  // --- Printing Capabilities ---
  printMethods: ["DTF", "Embroidery", "UV", "UV DTF"],
  products: "T-shirts, hoodies, hats, mugs, bottles, pens, notebooks, stickers, business cards, flyers",
  productCategories: [
    "Apparel Printing & Embroidery (t-shirts, hoodies, hats)",
    "Corporate & Event Gifts (mugs, bottles, pens, notebooks)",
    "Business Cards & Flyer Printing",
    "Mug & Bottle Printing",
    "Hat Printing & Embroidery",
  ],

  // --- Service Details ---
  turnaround: "Same-day turnaround available",
  quoteResponse: "We respond to quote requests within 1 business day",
  minimumOrder: "No minimum order",
  pickupDropoff: "All drop off & pick up at: 389 NE 2nd Ave, Hallandale Beach, FL 33009",
  serviceArea: "South Florida (Hallandale Beach, Miami, Fort Lauderdale, Hollywood, Aventura, Miramar, Pembroke Pines, Davie, Plantation, Hialeah) + nationwide dropshipping",

  // --- Signature Block Template ---
  // Use {agentName} as placeholder — replaced at send time
  signatureBlock: `---
{agentName} | Adorb Custom Printing
(954) 932-8543
print@adorbcustomtees.com
adorbcustomtees.com
⭐ 4.9 Stars · 867+ Verified Reviews
See our reviews: https://adorbcustomtees.com/pages/reviews`,

  // --- Agent Names ---
  defaultAgentName: "Chris",
  agentNames: ["Chris", "Mia", "Jordan", "Alex"],
} as const;

/**
 * Generate a signature block for a specific agent name.
 */
export function getSignatureBlock(agentName: string): string {
  return BRAND.signatureBlock.replace("{agentName}", agentName);
}

/**
 * Generate the brand context string for brain prompts.
 * This replaces the hardcoded brand info in composer.ts, qc.ts, etc.
 */
export function getBrandContext(): string {
  return `BRAND ASSETS (single source of truth — use ONLY these facts, never invent alternatives):
- Company: ${BRAND.companyName} / ${BRAND.printingBrand}
- Phone: ${BRAND.phone}
- Email: ${BRAND.email}
- Address (EXACT — never substitute): ${BRAND.address}
- Pickup/Drop-off: ${BRAND.pickupDropoff}
- Hours (EXACT): ${BRAND.hours}
- Website: ${BRAND.website}
- Printing Quote Website: ${BRAND.bulkWebsite}
- Products: ${BRAND.products}
- Printing Methods: ${BRAND.printMethods.join(", ")}
- Turnaround: ${BRAND.turnaround}
- Quote Response: ${BRAND.quoteResponse}
- Minimum Order: ${BRAND.minimumOrder}
- Service Area: ${BRAND.serviceArea}
- Google Reviews: ${BRAND.googleReviews}
- Trustpilot: ${BRAND.trustpilot}
- Website Reviews: ${BRAND.websiteReviews}
- Rating: ${BRAND.reviewStars} Stars · ${BRAND.reviewCount} Verified Reviews

CRITICAL: If asked for the address, phone, hours, or any business fact — use ONLY the values above verbatim. NEVER guess, approximate, or substitute a different address/number.`;
}
