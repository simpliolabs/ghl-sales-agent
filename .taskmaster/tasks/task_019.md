# Task ID: 19

**Title:** Phase 3: Delete 20 Brain/Strategy/Meta Files (~8,270 lines)

**Status:** pending

**Dependencies:** 18

**Priority:** high

**Description:** Delete: expert-panel.ts, deliberation-judge.ts, closer.ts, objection-handler.ts, brain-council-review.ts, brain-council.ts, auto-correction.ts, strategist.ts, composer.ts, researcher.ts, lead-researcher.ts, auto-skill-hunter.ts, strategy-autopilot.ts, skill-registry.ts, ab-testing.ts, few-shot-retrieval.ts, error-memory.ts, lookback-engine.ts, deferred-response-processor.ts, stage-playbook.ts.

**Details:**

Delete in order: brain files first, then strategy/learning/meta files. After each batch, run tsc --noEmit. Fix any import errors before proceeding. Delete associated test files (~6,000 test lines).

**Test Strategy:**

After deletion: tsc --noEmit = 0 errors. All remaining tests pass. Server starts without crashes. Outbox worker processes messages correctly through single brain path.
