# Task ID: 20

**Title:** Phase 3: Rewrite/Simplify 12 Files (~7,635 lines removed)

**Status:** pending

**Dependencies:** 19

**Priority:** high

**Description:** Rewrite brain-council-orchestrator.ts (→50 line stub), qc.ts (→0, replaced by output-guards), conversation-state.ts (→55 lines passive observer). Simplify scheduling-engine.ts, learning-loop.ts, webhook-message.ts, webhook-contact.ts, lead-disposition.ts, db.ts, persona-learning.ts, brain-types.ts, brain-context.ts.

**Details:**

conversation-state.ts becomes a pure function: deriveNextConvState(current, decision, lead) that derives state from tool calls (getQuote→'quoted', bookAppointment→'booked', etc). brain-council-orchestrator.ts becomes a thin import of outbox-worker. db.ts removes all helpers for deleted systems.

**Test Strategy:**

tsc --noEmit = 0 errors. All remaining tests pass. Verify conversation state transitions correctly for each tool call type. Verify outbox worker still functions end-to-end.
