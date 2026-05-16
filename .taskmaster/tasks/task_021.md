# Task ID: 21

**Title:** Phase 3: Database Cleanup — Drop Tables + Rename to decision_log

**Status:** pending

**Dependencies:** 20

**Priority:** high

**Description:** Drop 8 unused tables. Rename brain_council_audit to decision_log. Add new columns: brain_version, tools_called, input/output_guard_result, latency_ms, llm_calls, outbox_id FK, prompt_version, flagged_for_review, flag_reason, reviewed_at.

**Details:**

DROP: ab_experiments, ab_assignments, hall_of_fame, supervisor_audit, error_memory, skill_proposals, strategy_adjustments, deferred_responses. ALTER TABLE brain_council_audit RENAME TO decision_log. Drop old columns: strategist_output, researcher_output, expert_panel_scores, qc_violations, deliberation_output. Add new columns per spec.

**Test Strategy:**

Verify all 8 tables dropped. Verify rename successful. Verify new columns exist with correct types. Verify FK constraint on outbox_id. Verify existing data preserved in renamed table.
