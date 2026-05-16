# Task ID: 14

**Title:** Phase 2: Build Single Brain (single-brain.ts)

**Status:** pending

**Dependencies:** 11, 13

**Priority:** high

**Description:** Create the single brain with two-step LLM loop: tools then json_schema finalization. ~400 lines. Replaces 7 brains with 1 smart call.

**Details:**

Step 1: Tool execution loop (max 3 rounds) with tools=[getQuote, bookAppointment, createPaymentLink, markDNC, routeToHuman]. Step 2: Final structured output via json_schema returning BrainDecision {message, channel, nextFollowUpHours, pipelineAction, routeToHuman, routeReason, confidence}. System prompt loaded from prompt_versions table. Injects segment_weights (top/avoid approaches), lead memory, conversation history (20 messages), stage behavior from stage-behavior.json.

**Test Strategy:**

Test first contact with zero history uses cold outreach rules. Test inbound reply responds on same channel. Test pricing question calls getQuote. Test getQuote result appears verbatim. Test 'stop messaging' calls markDNC. Test complaint calls routeToHuman. Test json_schema output always matches BrainDecision type.
