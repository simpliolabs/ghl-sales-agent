# Task ID: 26

**Title:** Phase 5: Create segment_weights Table + Outcome Recording

**Status:** pending

**Dependencies:** 21

**Priority:** high

**Description:** Create segment_weights table (segment × channel × stage × approach → wins/losses/win_rate). Wire outcome recording: reply within 72h = win, no reply after 72h = loss.

**Details:**

Table: segment_weights (id, segment, channel, stage, approach, wins, losses, win_rate, updated_at) with UNIQUE KEY on (segment, channel, stage, approach). Use INSERT...ON DUPLICATE KEY UPDATE for atomic increment. Recalculate win_rate after each update. Minimum 3 samples before surfacing in prompt.

**Test Strategy:**

Test win/loss recording. Test win_rate calculation. Test ON DUPLICATE KEY UPDATE works correctly. Test minimum sample threshold (3) filters correctly.
