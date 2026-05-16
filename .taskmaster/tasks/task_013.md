# Task ID: 13

**Title:** Phase 2: Build Pricing Engine

**Status:** pending

**Dependencies:** 12

**Priority:** high

**Description:** Create pricing-engine.ts (~100 lines) with getQuote(qty, sides, product, rush) function. This is the ONLY code allowed to produce prices.

**Details:**

Reads from pricing-data.json. Returns QuoteResult with perUnit, subtotal, rushFee, setupFee, total, breakdown string. Returns callForQuote:true for quantities outside table range. Returns error for unknown products. The LLM calls this as a tool — it never composes prices freehand.

**Test Strategy:**

Test every tier boundary. Test rush fee calculation. Test size upcharges. Test callForQuote for edge quantities. Test unknown product error. Test breakdown string format.
