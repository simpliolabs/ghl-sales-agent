# Task ID: 30

**Title:** Phase 5: Confusion Detection + Post-Send Self-Review

**Status:** pending

**Dependencies:** 18, 14

**Priority:** medium

**Description:** Add confusion detection in webhook-message.ts using patterns from signal-patterns.ts. Add post-send check in outbox-worker for wrong-business references. Surface flagged messages in dashboard.

**Details:**

Confusion detection: if CONFUSION_PATTERNS match inbound reply → flag prior AI message as negative outcome → enqueue recovery with trigger='confusion_recovery'. Post-send check: after proactive sends, check if message references a business name that doesn't match lead.businessName → set flaggedForReview=true in decision_log.

**Test Strategy:**

Test confusion patterns detect 'who is this', 'wrong number', etc. Test flagging creates outbox entry with correct trigger. Test post-send check catches wrong-business reference. Test flaggedForReview is set correctly.
