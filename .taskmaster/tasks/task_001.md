# Task ID: 1

**Title:** Phase 0: Disable Legacy Timers via Feature Flag

**Status:** pending

**Dependencies:** None

**Priority:** high

**Description:** Wrap 12 of 20 background timers in a DISABLE_LEGACY_TIMERS feature flag in webhooks.ts. No new code — config change only.

**Details:**

In webhooks.ts (the timer hub), wrap these timers in `if (process.env.DISABLE_LEGACY_TIMERS !== 'true')`: Brain Council Self-Review (30 min), Retroactive Correction Scan (15 min), Lookback Drip (30 min), Event-Driven Triggers (30 min), Stale Schedule Recalculation (1 hr), Overdue Catch-Up (1 hr), Learning Promotion Scan (2 hr), Weekly Monday Review (6 hr), Seasonal Campaign Executor (2 hr), Supervisor (5 min), SLA Timer (30 min), Post-Delivery Executor (30 min). Set DISABLE_LEGACY_TIMERS=true in server env.

**Test Strategy:**

Verify all 12 timers are wrapped. Set env var to true, restart, confirm timers don't fire. Set to false, confirm they resume. Check remaining 8 timers still run.
