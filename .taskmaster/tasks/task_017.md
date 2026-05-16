# Task ID: 17

**Title:** Phase 2: A/B Feature Flag Routing (Legacy vs Single Brain)

**Status:** pending

**Dependencies:** 14, 15, 8

**Priority:** high

**Description:** Add SINGLE_BRAIN_PCT env var routing in outbox-worker. lead.id % 100 < PCT routes to single brain, rest to legacy. Ramp: 10% → 50% → 100%.

**Details:**

In outbox-worker.ts: const useSingleBrain = (lead.id % 100) < Number(process.env.SINGLE_BRAIN_PCT ?? '0'). Start at 10% for 48h, then 50% for 7 days if reply rate within 5% of legacy, then 100%. Gate to Phase 3: single brain at 50% for 7 days with reply rate >= legacy, zero pricing hallucinations.

**Test Strategy:**

Test routing: lead.id=5 with PCT=10 → single brain. lead.id=15 with PCT=10 → legacy. Test PCT=0 → all legacy. Test PCT=100 → all single brain. Verify both paths produce valid BrainDecision.
