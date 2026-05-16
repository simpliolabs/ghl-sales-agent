# Task ID: 6

**Title:** Phase 1: Build Outbox Enqueue + Idempotency Key

**Status:** pending

**Dependencies:** 5

**Priority:** high

**Description:** Create enqueueOutbox() function with SHA256 idempotency key formula: sha256(leadId:triggerSource:timeBucket).slice(0,64). Time bucket = 5-minute window.

**Details:**

For inbound replies, include first 50 chars of body in key. For follow-ups, use 'follow_up' as trigger. For first contact, use 'first_contact'. INSERT IGNORE into outbox — if idem_key already exists for that lead, silently skip (idempotent). Export makeIdemKey() for all producers.

**Test Strategy:**

Test that same trigger within 5-min window produces same key. Test different triggers produce different keys. Test INSERT IGNORE behavior on duplicate. Test inbound reply key includes message body hash.
