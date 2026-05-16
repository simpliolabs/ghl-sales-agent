# Task ID: 31

**Title:** Phase 6: Dashboard Overhaul — Revenue Metrics + Review Queue

**Status:** pending

**Dependencies:** 21, 30

**Priority:** medium

**Description:** Replace dashboard with: messages sent / replies / quotes sent / deals closed / revenue. Add 'Flagged Messages' tab to Review Queue.

**Details:**

Revenue dashboard: today/week/allTime metrics. Conversion funnel: contacted → replied → quoted → closed. Review Queue dual-tab: Tab 1 'Agent Handoffs' (routeToHuman=true), Tab 2 'Flagged Messages' (flagged_for_review=1, unacknowledged). Flagged cards show: lead name, sent message, flag reason, Dismiss button, Intervene button.

**Test Strategy:**

Test revenue metrics calculate correctly. Test funnel counts are accurate. Test flagged messages appear in Review Queue. Test Dismiss marks reviewedAt. Test Intervene sets humanTakeover.
