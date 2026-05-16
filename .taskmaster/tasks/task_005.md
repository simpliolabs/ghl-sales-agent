# Task ID: 5

**Title:** Phase 1: Create Outbox Table

**Status:** pending

**Dependencies:** 4

**Priority:** high

**Description:** Create the outbox table with idempotency key, status tracking, scheduling, and retry support.

**Details:**

CREATE TABLE outbox (id BIGINT PRIMARY KEY AUTO_INCREMENT, lead_id INT NOT NULL, idem_key VARCHAR(64) NOT NULL, source ENUM('webhook','responder','follow_up','manual') NOT NULL, payload JSON NOT NULL, status ENUM('pending','claimed','sent','failed','skipped') DEFAULT 'pending', claimed_by VARCHAR(64), claimed_at TIMESTAMP NULL, scheduled_at TIMESTAMP NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, sent_at TIMESTAMP NULL, error TEXT, retry_count INT DEFAULT 0, UNIQUE KEY uk_idem (lead_id, idem_key), INDEX idx_pending (status, scheduled_at)).

**Test Strategy:**

Verify table creation. Test UNIQUE constraint on (lead_id, idem_key) rejects duplicates. Test index usage with EXPLAIN on pending status queries.
