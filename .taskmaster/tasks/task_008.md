# Task ID: 8

**Title:** Phase 1: Build Outbox Worker (Drain Loop)

**Status:** pending

**Dependencies:** 7

**Priority:** high

**Description:** Create outbox-worker.ts — the ONLY path through which messages are sent. Runs every 2 minutes, claims up to 10 rows, processes them through guards → brain → send.

**Details:**

Atomic claim (SKIP LOCKED or optimistic lock). For each row: run input guards → if blocked/deferred, mark accordingly. If payload has draftMessage (pre-composed nurture), skip brain call. Otherwise call brain (legacy or single depending on feature flag). Run output guards. Send via GHL. Log decision. Update lead. Post-send check. On failure: retry up to 3 times with 60s backoff.

**Test Strategy:**

Test concurrent claims don't double-process. Test stale claims (>2min) get reclaimed. Test retry logic. Test pre-composed messages bypass brain. Test failure after 3 retries marks as failed permanently.
