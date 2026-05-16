# Task ID: 10

**Title:** Phase 1: Remove Legacy Cooldown/Lock Stack

**Status:** pending

**Dependencies:** 8

**Priority:** high

**Description:** Delete the 90-second DB cooldown check, the 5-min processing lock logic, the already-responded check, and daily send cap producer logic from brain-council-orchestrator.ts.

**Details:**

These are all replaced by the outbox idempotency key and the single-drain-point architecture. Keep the daily cap enforcement in outbox-worker only (not in the orchestrator). The orchestrator becomes a thin stub that imports outbox-worker.

**Test Strategy:**

Verify brain-council-orchestrator.ts no longer has cooldown/lock/dedup logic. Verify outbox-worker enforces daily cap. Run full integration test: rapid webhook fire → only 1 outbox row created → only 1 message sent.
