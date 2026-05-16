# Task ID: 32

**Title:** Phase 6: Remove Dead Frontend Pages + Simplify Navigation

**Status:** pending

**Dependencies:** 31

**Priority:** low

**Description:** Remove from routing: AI Performance, Brain Council Log, Self-Learning analytics overlay, Webhook Logs UI. Keep: Dashboard, Hot Leads, All Leads, Lead Detail, Review Queue.

**Details:**

Delete page components for removed pages. Update App.tsx routing. Update DashboardLayout navigation. Lead Detail page: show conversation + single brain audit trail from decision_log. Clean up any references to deleted backend endpoints.

**Test Strategy:**

Verify removed pages return 404. Verify navigation doesn't show dead links. Verify Lead Detail shows decision_log data correctly. Verify no console errors on remaining pages.
