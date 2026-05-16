# Task ID: 15

**Title:** Phase 2: Build Output Guards

**Status:** pending

**Dependencies:** 14

**Priority:** high

**Description:** Create output-guards.ts (~80 lines) with 5 guards: system leak detection, channel mismatch correction, price validation (getQuote required), DNC phrase check, null message with advance action.

**Details:**

Guard 1: Regex for 'brain council|strategist|composer|qc brain|expert panel|json{' → block as system_leak. Guard 2: First response must use inbound channel → force correct (don't block). Guard 3: If message contains $ and no getQuote in toolLog → block as unverified_price. Guard 4: DNC keywords in outgoing → block. Guard 5: null message + advance action → strip pipelineAction.

**Test Strategy:**

Test each guard. Test system leak regex catches all patterns. Test price validation requires getQuote call. Test price mismatch detection. Test channel force on first message. Test null message strips action.
