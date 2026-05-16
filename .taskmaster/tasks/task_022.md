# Task ID: 22

**Title:** Phase 3: Re-enable 3 Timers as Outbox Producers + Nurture Conversion

**Status:** pending

**Dependencies:** 21

**Priority:** medium

**Description:** Re-enable Fast Missed-Reply Scanner, Post-Delivery Executor, Seasonal Campaign Executor — all as outbox producers. Convert nurture systems to outbox producers.

**Details:**

Each timer now calls enqueueOutbox() instead of sending directly. Fast Missed-Reply: trigger='missed_reply'. Post-Delivery: trigger='post_delivery_step'. Seasonal: trigger='seasonal_campaign'. Lost Lead Nurture: trigger='lost_lead_nurture'. Import Nurture: trigger='import_nurture'. All use appropriate idem_keys to prevent duplicates.

**Test Strategy:**

Verify each timer creates outbox rows, not direct sends. Verify idempotency keys prevent duplicate enqueues. Verify outbox worker processes these triggers correctly.
