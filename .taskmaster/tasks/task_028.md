# Task ID: 28

**Title:** Phase 5: LoRA Pipeline Rewiring (training-export.ts)

**Status:** pending

**Dependencies:** 21, 14

**Priority:** high

**Description:** Rewrite training-export.ts to generate pairs from decision_log using single-brain prompt format. Include tool call turns in JSONL. Filter by current prompt version.

**Details:**

Quality filters: (gotReply=1 AND replyType NOT IN ('dnc','complaint','confusion')) OR converted=1. AND prompt_version=currentActiveVersion. AND output_guard_result='pass'. AND message length>=20. AND confidence>=60. Include tool calls as multi-turn (assistant tool_calls → tool results → final assistant message). Minimum 50 pairs to train. Keep full auto-promote/rollback pipeline.

**Test Strategy:**

Test training pair generation with mock decision_log data. Test quality filters exclude bad data. Test tool call reconstruction in JSONL format. Test minimum pair guard skips training when insufficient data.
