# Task ID: 29

**Title:** Phase 5: A/B Test Prompt Version Anchoring + Model Selection

**Status:** pending

**Dependencies:** 28

**Priority:** medium

**Description:** Add abTestPromptVersion column to fine_tuning_jobs. Freeze prompt version when A/B starts. Update single-brain.ts getActiveModel() to check for promoted LoRA model.

**Details:**

When starting A/B: record current prompt version. When evaluating: only count decision_log rows where prompt_version matches anchored version. Auto-promote if fine-tuned win rate > base by 5% with n>=100 per arm. getActiveModel(): check fineTuningJobs for promoted=1, abTestActive=0, return fineTunedModel or fall back to gpt-4.1-mini.

**Test Strategy:**

Test prompt version is frozen at A/B start. Test evaluation filters by anchored version. Test promotion threshold (5% improvement, n>=100). Test getActiveModel returns promoted model when available.
