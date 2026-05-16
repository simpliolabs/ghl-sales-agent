# Task ID: 27

**Title:** Phase 5: Dynamic Prompt Injection (Top/Avoid Approaches)

**Status:** pending

**Dependencies:** 26, 14

**Priority:** high

**Description:** Build getTopApproaches() and getAvoidApproaches() functions. Inject into single brain system prompt at decision time.

**Details:**

getTopApproaches(segment, channel, stage, n=3): returns top N approaches by win_rate where (wins+losses)>=3. getAvoidApproaches(segment, channel, n=3): returns bottom N approaches where win_rate<0.1 and samples>=3. Injected into prompt as '• APPROACH: X% reply rate (N samples)' and '• AVOID APPROACH: X% reply rate'.

**Test Strategy:**

Test returns correct top/bottom approaches. Test minimum sample filter. Test empty results when no data. Test prompt injection format matches spec.
