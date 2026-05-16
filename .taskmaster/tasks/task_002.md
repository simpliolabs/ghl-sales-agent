# Task ID: 2

**Title:** Phase 0: Adjust Core System Parameters

**Status:** pending

**Dependencies:** None

**Priority:** high

**Description:** Change 4 critical parameters: DB_SEND_COOLDOWN_MS 90s→30s, PROCESSING_LOCK_TTL_MS 5min→1min, DAILY_PROACTIVE_CAP 1→3 (score>=80), HUMAN_TAKEOVER_AUTO_EXPIRE_HOURS 24→4.

**Details:**

In brain-council-orchestrator.ts, update the constants. The cooldown reduction allows faster responses. The lock TTL reduction prevents stuck locks from blocking leads for 5 minutes. The proactive cap increase allows more outreach to hot leads. The takeover expiry reduction clears stale flags faster.

**Test Strategy:**

Unit test each parameter change. Verify cooldown blocks at 30s not 90s. Verify lock expires at 60s. Verify cap allows 3 sends for score>=80 leads. Verify takeover auto-expires after 4 hours.
