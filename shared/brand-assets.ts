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
  hours: "Mon-Fri 9am-6pm, Sat 10am-4pm",

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
  return `BRAND ASSETS (single source of truth):
- Company: ${BRAND.companyName}
- Phone: ${BRAND.phone}
- Email: ${BRAND.email}
- Address: ${BRAND.address}
- Hours: ${BRAND.hours}
- Website: ${BRAND.website}
- Bulk Website: ${BRAND.bulkWebsite}
- Products: ${BRAND.products}
- Printing Methods: ${BRAND.printMethods.join(", ")}
- No minimum orders
- Google Reviews: ${BRAND.googleReviews}
- Trustpilot: ${BRAND.trustpilot}
- Website Reviews: ${BRAND.websiteReviews}
- Rating: ${BRAND.reviewStars} Stars · ${BRAND.reviewCount} Verified Reviews`;
}
