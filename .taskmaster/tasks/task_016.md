# Task ID: 16

**Title:** Phase 2: Build Stage Behavior JSON + Lead Utils

**Status:** pending

**Dependencies:** None

**Priority:** medium

**Description:** Create stage-behavior.json (9 stages with objective/signals/avoid) and lead-utils.ts (deterministic scoring, rule-based segment classification, context builder).

**Details:**

stage-behavior.json: new_lead, exploring, quote_requested, quote_sent, appointment_scheduled, negotiating, won, lost, stale — each with objective, signals_to_ask_for, avoid. lead-utils.ts: scoreLeadQuick() (deterministic, no LLM), classifySegment() (keyword-based with rare LLM fallback), buildLeadContext() (pure data assembler).

**Test Strategy:**

Test all 9 stages have required fields. Test scoreLeadQuick produces 0-100. Test classifySegment matches keywords correctly. Test LLM fallback only triggers when no keywords match and data exists.
