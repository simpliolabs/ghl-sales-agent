# Task ID: 3

**Title:** Phase 0: Stale Takeover Cleanup (One-Shot SQL)

**Status:** pending

**Dependencies:** 1, 2

**Priority:** high

**Description:** Run one-shot SQL to clear stale humanTakeover flags where lastAgentActivityAt > 4 hours ago and no recent human outbound messages.

**Details:**

Execute: UPDATE leads SET humanTakeover = 0 WHERE humanTakeover = 1 AND lastAgentActivityAt < NOW() - INTERVAL 4 HOUR AND id NOT IN (SELECT DISTINCT leadId FROM conversations WHERE direction = 'outbound' AND senderType = 'human' AND createdAt > NOW() - INTERVAL 4 HOUR). Monitor for 24h after.

**Test Strategy:**

Count humanTakeover=1 leads before and after. Verify only stale ones (no recent human activity) are cleared. Confirm AI starts engaging these leads within 1 hour.
