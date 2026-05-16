# Task ID: 12

**Title:** Phase 2: Extract Pricing Data from sales-training.ts

**Status:** pending

**Dependencies:** None

**Priority:** high

**Description:** Extract ALL product pricing verbatim from shared/sales-training.ts into server/pricing-data.json. Include t-shirts, hoodies, polos, hats, tote bags — every product with exact tier pricing.

**Details:**

Must be extracted VERBATIM — do not invent numbers. Include: minimumOrder (1, no minimums), per-product tier tables with minQty/maxQty/sides pricing, size upcharges (2XL: $2.50, 3XL-5XL: $3.50), rush fee percent (20%), setup fees. For tiers where price is null, mark as 'call for quote'.

**Test Strategy:**

Cross-reference every number in pricing-data.json against sales-training.ts. Verify no prices are invented. Verify all products are included. Verify tier boundaries are correct.
