# Task ID: 4

**Title:** Phase 1: TiDB SKIP LOCKED Pre-Check

**Status:** pending

**Dependencies:** 3

**Priority:** high

**Description:** Test whether TiDB supports SELECT FOR UPDATE SKIP LOCKED. If not, implement optimistic-lock fallback pattern for the outbox worker.

**Details:**

Run test: CREATE TABLE _skip_locked_test (id INT PRIMARY KEY, status VARCHAR(20)); INSERT INTO _skip_locked_test VALUES (1, 'pending'); SELECT * FROM _skip_locked_test WHERE status = 'pending' FOR UPDATE SKIP LOCKED; DROP TABLE _skip_locked_test. If it errors, use the optimistic-lock pattern.

**Test Strategy:**

Run the test SQL against production TiDB. Document result. If SKIP LOCKED fails, implement and test the optimistic-lock fallback with concurrent claim simulation.
