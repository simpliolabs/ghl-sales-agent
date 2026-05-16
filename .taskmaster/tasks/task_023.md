# Task ID: 23

**Title:** Phase 3: Write New Test Suite (outbox-worker, single-brain, guards)

**Status:** pending

**Dependencies:** 20, 21

**Priority:** medium

**Description:** Write 34 new tests: outbox-worker.test.ts (10), single-brain.test.ts (14), guards.test.ts (10). Target: 650+ tests passing after Phase 3.

**Details:**

outbox-worker: atomic claim, duplicate idem_key, stale reclaim, retry logic, DNC guard, TCPA defer, humanTakeover block, draftMessage bypass, send failure retry, max retry abort. single-brain: first contact cold rules, same-channel reply, getQuote call, price verbatim, markDNC, routeToHuman, different angle follow-up, breakup timing, tool round limit, json_schema type, confidence range, SMS split separator, FB fallback, segment-specific approaches. guards: DNC block, GHL DND, TCPA defer, takeover timing, system leak, price validation, channel force, null+advance strip.

**Test Strategy:**

All 34 tests pass. No flaky tests. Tests cover both happy path and error paths. Mock LLM calls for deterministic results.
