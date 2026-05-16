# Task ID: 7

**Title:** Phase 1: Convert All 4 Senders to Outbox Producers

**Status:** pending

**Dependencies:** 6

**Priority:** high

**Description:** Replace direct runBrainCouncil() calls in webhook-message.ts, follow-up-trigger.ts, webhook-contact.ts, and manual send with enqueueOutbox() calls.

**Details:**

webhook-message.ts: enqueue with trigger 'inbound_reply', scheduledAt=now (or +15min if shouldDefer). follow-up-trigger.ts: enqueue with trigger 'proactive_follow_up', scheduledAt=lead.nextFollowUpAt. webhook-contact.ts: enqueue with trigger 'first_contact', scheduledAt=now+45s. Manual: enqueue with source 'manual', scheduledAt=now.

**Test Strategy:**

Verify each sender creates outbox rows instead of calling brain directly. Test idempotency: rapid-fire webhook doesn't create duplicates. Test scheduling: deferred messages have future scheduled_at.
