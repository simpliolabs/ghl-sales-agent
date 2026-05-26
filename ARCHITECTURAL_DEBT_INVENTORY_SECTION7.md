---

## Section 7: Reconciled Bug-Class Inventory (2026-05-20)

**Context:** Two nights of production fires surfaced 16 distinct bug classes. This section reconciles all 16 against the existing inventory items, assigns each to the correct foundation, and identifies 4 classes that were not previously captured.

**Foundation map:**
- **Foundation A** — Send confirmation contract ✓ shipped
- **Foundation A.1** — Carrier-failure sub-classification (A's natural follow-on)
- **Foundation B** — Send policy engine (TCPA, humanTakeover gates, channel field unification, stale-reply rules)
- **Foundation C** — Receive integrity (`as string` family + webhook payload classification + Lookback gap + channel promo content poisoning history)
- **Foundation D** — Multi-fire deduplication (fast_scan, outbox worker, trigger crons need shared "already composed" lock)
- **Foundation E** — Outbox worker resilience (exception-safe row processing, heartbeat, stale-claim recovery)
- **Foundation F** — Brain working memory (open-questions tracking, conversation state machine)
- **Content distillation** — Parallel track (Hormozi/Martell frameworks, banned phrases ✓ partially shipped, tone calibration)

---

### Reconciliation Table

| # | Bug Class | Examples | Foundation | Inventory Status |
|---|-----------|----------|------------|-----------------|
| BC-01 | **Phantom send rows (200 OK, no messageId)** | Christina, Robert, 31-lead carrier-failure cohort | Foundation A ✓ | Captured — Items #13, #14 (A.1/A.2) |
| BC-02 | **Carrier failures invisible / dead-number cohort** | Jan 2025 bulk import, 89% phantom rate | Foundation A.1 | Captured — Items #13, #14, #15 |
| BC-03 | **TCPA scattered / over-broad enforcement** | Vladislav (IG blocked on Monday), stale-reply edge cases | Foundation B | Captured — Section 1, Patch #2 |
| BC-04 | **Channel field mismatch (channelHint vs channel)** | Vladislav channel detection failure | Foundation B | Captured — Section 1, Patch #1 |
| BC-05 | **Stale-reply exemption logic** | Vladislav 30-min cutoff too narrow | Foundation B | Captured — Section 1, Patch #2 |
| BC-06 | **humanTakeover false positive from workflow messages** | Gabriela, Earl Wheeler echo, appointment-created events setting takeover | Foundation B | **PARTIALLY captured** — Item #16 covers the `{}` body shape. The appointment-webhook-sets-humanTakeover path is NOT separately captured. Adding as Item #17a below. |
| BC-07 | **humanTakeover NOT set when human DID engage** | Bill Noke, Dang's pre-screenshot state | Foundation B | **NOT captured.** Adding as Item #18 below. |
| BC-08 | **Channel detection runs too late (IG silent crashes)** | Darius, Jay, Glenys — IG channel not detected before outbox fires | Foundation B / Foundation C | **NOT captured separately.** Partially implied by Patch #1 (channelHint). Adding as Item #19 below. |
| BC-09 | **`as string` crash on non-string payloads** | Maycon, JoelyAdelina, Yvette silenced — `webhooks.ts` line 469 crash | Foundation C | Captured — Item #12 (webhook receive audit), Section 4 (as-string audit). Line 469 fixed; line 619 fixed in `6adb20a3`. |
| BC-10 | **`as string` silent corruption to `{}`** | Nir's outbound to Dang, Earl Wheeler human-outbound, Adebola `{}` rows | Foundation C | Captured — Item #16 (human-outbound `{}` body). Section 4 medium-risk tier. |
| BC-11 | **Webhook payload polluting conversation history** | Adebola WhatsApp promo link recorded as `direction=inbound, senderType=lead` | Foundation C | **NOT captured.** Adding as Item #20 below. |
| BC-12 | **Multi-fire on same inbound trigger** | Adebola May 18 (3 AI messages in 3 min), Vladislav (2 in same minute), V (4 in 5 min) | Foundation D | **NOT captured.** Adding as Item #21 below. |
| BC-13 | **Delayed sends after outbox worker crash** | Adebola 19h delay, Dang 4h delay, 15 leads silenced overnight | Foundation E | Captured — Item #17 (outbox claim-fetch precision bug, fixed in `96183d24`). Root cause fixed. Resilience hardening (heartbeat, exception-safe processing) still needed. |
| BC-14 | **Lookback path doesn't enqueue first-contact** | Thuy Huynh | Foundation C | Captured — Item #11. |
| BC-15 | **Bad message content (filler, bot tone, no hook)** | Vanessa, Terrence, Jerry, Adebola pre-fix | Content distillation | Captured — BANNED PHRASES patch shipped in `c5333bfb`. Ongoing content work. |
| BC-16 | **AI re-asks same question across hours** | Delores Mills | Foundation F | **NOT captured.** Adding as Item #22 below. |

---

### New Items Added This Reconciliation

| # | Item | Severity | Foundation | Notes |
|---|------|----------|------------|-------|
| 17a | **Appointment-webhook and GHL workflow events set `humanTakeover = 1` as a side effect.** When GHL fires an `AppointmentCreated` or `AppointmentUpdated` webhook, the handler sets `humanTakeover = 1` on the lead. This is correct for some flows (human scheduled the appointment) but incorrect when the AI scheduled it — the AI-scheduled appointment should not pause the AI. Result: leads with AI-booked appointments go silent after booking. Confirmed in Jerry (id=1020060) and Dang HM (id=1059). | **HIGH** — Directly silences active leads after the AI's best outcome (appointment booked). | Foundation B | Separate from Item #16 (`{}` body). This is the appointment webhook handler logic, not the message body coercion. |
| 18 | **`humanTakeover` is NOT set when a human agent sends a real message via GHL.** When a human agent (e.g., Nir Appelton) sends an SMS through GHL's UI, the inbound webhook fires but the body is coerced to `{}` (Item #16). Because the Safety Net reads `messageBody = '{}'`, it does not recognize the send as a real human engagement and does not set `humanTakeover = 1`. The AI then fires on the same lead hours later. Confirmed: Dang HM received an AI message 4 hours after Nir had already engaged. | **HIGH** — The human-agent-to-AI handoff is broken in both directions: (a) workflow events incorrectly set takeover (Item #17a), (b) real human sends fail to set takeover (this item). | Foundation C (fix the `{}` body first, then Foundation B for the takeover gate logic) | Depends on Item #16 fix. Once the body is correctly stored, the Safety Net should set `humanTakeover = 1` on human-outbound detection. |
| 19 | **Channel detection runs too late — IG leads get SMS outbox rows before channel is confirmed.** When a lead comes in via Instagram DM, the channel is not confirmed until the first webhook fires. If the outbox worker fires before the IG channel is confirmed, it attempts an SMS send — which either fails silently (no phone number) or sends to the wrong channel. Confirmed pattern: Darius, Jay, Glenys received no AI response on IG despite being active leads. | **HIGH** — IG leads are effectively dead in the water if the channel detection race condition fires. | Foundation B | Partially addressed by Patch #1 (channelHint fallback), but the root fix requires channel to be locked at enqueue time, not resolved at send time. |
| 20 | **Non-message webhook payloads (channel promos, appointment events, WhatsApp channel links) are recorded as `direction=inbound, senderType=lead` in `conversations`.** When GHL delivers a webhook for a non-conversational event (e.g., Adebola's WhatsApp channel promo link, appointment-created system messages), the receive path writes it as a lead inbound message. The brain then reads it as a real customer statement and may compose a response to it. Confirmed near-miss: Adebola's promo link was recorded as a lead inbound; the brain didn't fire only because `humanTakeover` was already set. | **HIGH** — If `humanTakeover` had not been set, the brain would have composed a response to a WhatsApp channel promo link as if it were a customer message. The input integrity of the brain's conversation history is compromised for any lead who receives or sends non-conversational webhook events. | Foundation C | Requires classifying webhook event types at the receive path and routing non-conversational events to a separate `webhook_events` log rather than `conversations`. |
| 21 | **Multi-fire deduplication gap: fast_scan fires multiple times on the same inbound before the lead replies.** When a lead sends a message, `fast_scan` is triggered. If the outbox worker is slow or the trigger fires multiple times (e.g., multiple webhook deliveries, scheduler overlap), the brain composes and sends 2–3 messages in rapid succession with no intervening lead reply. Confirmed: Adebola received 3 AI messages in 3 minutes (May 18 13:51–13:54). Vladislav received 2 in the same minute. V received 4 in 5 minutes. Scope query (last 48h): 5 instances across 3 leads. | **HIGH** — Directly causes customer-facing harm (spam-like experience). Sets `humanTakeover = 1` as a side effect (Safety Net detects rapid AI sends), which then silences the lead. The multi-fire is the root cause of the Adebola `humanTakeover` state that caused the 19h delay. | Foundation D | No deduplication lock exists between fast_scan trigger and outbox worker. The fix requires a shared "we already composed for this inbound event" lock — either a DB-level mutex on the inbound message ID, or a `lastProcessedInboundId` field on the lead that the outbox checks before composing. |
| 22 | **Brain has no working memory for open questions.** When the AI asks a question (e.g., "How many shirts are you looking for?") and the lead doesn't answer, the AI re-asks the same question in the next follow-up cycle. Confirmed: Delores Mills received the same quantity question across multiple sessions hours apart. The brain reads conversation history but does not maintain a structured "open questions" state that prevents re-asking. | **MEDIUM** — Causes repetitive, robotic conversation patterns. Lower urgency than crash/silence bugs but directly degrades conversion quality. | Foundation F | Requires a `brain_state` table or `openQuestions` JSON field on the lead that the brain reads before composing. |

---

### Foundation Priority Assessment (Post-Reconciliation)

**Active customer-facing harm RIGHT NOW (bleeding):**

| Foundation | Active Harm | Leads Affected |
|------------|-------------|----------------|
| **D — Multi-fire dedup** | AI sends 2–3 messages in minutes → sets humanTakeover → lead goes silent | 3+ confirmed, likely more undetected |
| **C — Receive integrity** | `{}` body → human sends not detected → AI fires on human-engaged leads | Confirmed: Dang, Adebola, unknown others |
| **C — Receive integrity** | Non-conversational events in conversation history → brain input poisoned | Confirmed near-miss: Adebola |
| **B — Send policy** | IG channel detection race → IG leads get no response | Confirmed: Darius, Jay, Glenys |
| **B — Send policy** | Appointment webhook sets humanTakeover incorrectly → AI-booked leads go silent | Confirmed: Jerry, Dang |

**Structural correctness (not actively bleeding but will cause fires):**

| Foundation | Issue |
|------------|-------|
| **A.1** — Carrier classification | Phantom rows not sub-classified; A.2 automation blocked |
| **E** — Outbox resilience | Worker crash recovery depends on stale-claim expiry; no heartbeat |
| **F** — Working memory | Re-asks same question; degrades conversion |

**Conclusion:** Option A (bleed-stoppers first) is correct. The two foundations causing active harm are D (multi-fire) and C (receive integrity). Foundation B has two active-harm items (IG channel race, appointment webhook) but is otherwise structural. The correct order is:

1. **Foundation D** — Multi-fire dedup (1–2 days, surgical lock)
2. **Foundation C** — Receive integrity (`{}` body fix + non-conversational event classification)
3. **Foundation B** — Send policy engine (channel lock at enqueue, humanTakeover gate logic, TCPA rules)
4. **Foundation E** — Outbox resilience (heartbeat, exception-safe processing)
5. **Foundation A.1** — Carrier classification
6. **Foundation F** — Working memory

Content distillation runs parallel to all foundations.
