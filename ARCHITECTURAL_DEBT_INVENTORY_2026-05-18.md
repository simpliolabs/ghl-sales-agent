# Architectural Debt Inventory

**Created:** 2026-05-18  
**Last Updated:** 2026-05-20 14:15 UTC (Section 7 added — full 16-class reconciliation, Items #17a–#22 added, foundation priority order established)

---

## Section 1: Temporary Patches (Remove When Foundation B Ships)

| # | Patch | Location | Remove When |
|---|-------|----------|-------------|
| 1 | channelHint fallback (`channelHint \|\| channel \|\| lead.preferredChannel`) | `outbox-worker.ts` line ~713 | Foundation B ships proper channel enforcement at enqueue time |
| 2 | 30-min stale-reply TCPA exemption cutoff (`STALE_REPLY_MS`) | `outbox-worker.ts` line ~721 | Foundation B ships queue-age-aware staleness detection |

---

## Section 2: Pre-Existing Gaps (Patch-Class Bugs)

| # | Gap | Severity | Discovered | Notes |
|---|-----|----------|-----------|-------|
| 12 | **Webhook receive pipeline has no audit trail.** Foundation A's `send_attempts` table only captures failures in the *send* path. When the *receive* path crashes (as it did at `webhooks.ts` line 469, dropping all non-string inbound messages for ~12+ hours undetected), there is no equivalent table to surface the failure. The only signal was customer complaints and inbox silence. A future foundation needs a `webhook_failures` audit table that captures every webhook that crashed before reaching its handler's intended outcome. This is the receive-side equivalent of what Foundation A did for sends. | **HIGH** — The `webhooks.ts` crash silently dropped messages from at least 4 leads (Maycon Espindola, JoelyAdelina Elizondo, Yvette Reed, Thuy Huynh) for ~12+ hours with zero system-level alerting. | 2026-05-19 (webhooks.ts `as string` cast crash) | Do not fix tonight. Stage as Foundation B receive-side work. Root cause: `as string` TypeScript assertion is not a runtime conversion. See `MANUS_CHECKPOINT_AUDIT_2026-05-18.md` Rule 6. |
| 11 | **Lookback path doesn't trigger first-contact.** Leads created by the Lookback timer (batch scan of GHL contacts) skip the outbox/pending_first_contacts enqueue, so they never get an AI first-contact message. Only the real-time GHL webhook path enqueues outbound AI engagement. Any lead the webhook misses (GHL outage, webhook signature issue, rate limit, or GHL workflow-created contacts) gets picked up by Lookback — then sits silent forever. | **HIGH** — 417 leads in last 7 days matched the gap pattern (though many may have been engaged via other paths). The `pending_first_contacts` table has only 1 row ever, confirming the first-contact-via-table path is essentially unused. | 2026-05-19 (Thuy Huynh, lead 5100068) | Not a Foundation A regression. Pre-existing since system inception. The primary AI engagement path is webhook → outbox, not Lookback → pending_first_contacts. Thuy's case exposed it because her GHL webhook didn't fire. |

---

## Section 3: Investigation Needed

| # | Question | Priority | Context |
|---|----------|----------|---------|
| 12 | Why did Thuy Huynh's GHL webhook not fire? Two possibilities: (a) GHL didn't send it (their infra issue), (b) GHL sent it but our endpoint failed silently. Check `webhook_logs` table for her `ghlContactId = sQeZ8uda1LugTyAPg7TY` around 2026-05-19 05:00-05:10 UTC. | Medium | If (b), there's a hidden webhook handler bug. If (a), we need Lookback-to-first-contact as a safety net. |
| 13 | What is the actual engagement rate for leads created in the last 7 days? The query showed 354/471 leads got AI sends, but 417 matched the "no first-contact" pattern. The discrepancy (354 + 417 > 471) suggests the query conditions overlap or the AI engagement came via a path other than first-contact (e.g., follow-up, fast_scan reply). | Low | Informational. Helps calibrate how critical item #11 actually is. |

---

## Section 4: Defensive Audit — `as string` Payload Time Bombs

**Audit run:** 2026-05-19 16:10 UTC  
**Command:** `grep -rn "as string" server/ | grep -i "payload"`  
**Status:** DO NOT FIX TONIGHT — document and stage for Foundation B receive-side hardening.

The root cause of the `webhooks.ts` line 469 crash was an `as string` TypeScript assertion used as a runtime conversion. The pattern `(payload.x || "") as string` is safe only when `payload.x` is guaranteed to be a string or falsy. When GHL sends a non-string value (object, array, number) in that field, the `|| ""` fallback is skipped (truthy object), and `.substring()` is called on the object — crashing the handler.

**Line 469 was fixed.** The following are remaining hits that share the same structural shape and are candidates for the same crash under adversarial or unexpected GHL payloads:

### High-Risk: Calls `.substring()` or string methods on the cast value

| File | Line | Cast | Risk | Notes |
|------|------|------|------|-------|
| `webhooks.ts` | 619 | `(legacyPayload.body \|\| legacyPayload.message \|\| "") as string` | **HIGH** | Legacy `/api/webhooks/ghl/message` endpoint. Passed directly to `acquireMessageLock()` which calls `.substring(0, 100)`. Same crash shape as the fixed line 469. |
| `webhook-message.ts` | 60 | `(payload.messageType \|\| ... \|\| "SMS") as string` | **MEDIUM** | Passed to `normalizeChannel()`. If GHL sends a non-string `messageType` (e.g., a number), `normalizeChannel` may fail. Line 51 already has safe coercion for `messageBody` — this field was missed. |

### Medium-Risk: Cast value used in string comparisons or DB writes (crash unlikely but data corruption possible)

| File | Lines | Pattern | Risk | Notes |
|------|-------|---------|------|-------|
| `webhook-events.ts` | 25-26, 48-51, 85, 94-95, 166-167, 303, 347-348, 380, 386, 392 | `(payload.X \|\| "") as string` for contactId, event, appointmentId, startTime, notes, status, oppId, oppName | **MEDIUM** | If GHL sends a non-string for these fields, the value silently becomes `[object Object]` in DB writes and comparisons. No crash, but corrupted data. |
| `webhook-contact.ts` | 122, 650, 674 | `payload.email as string`, `payload.phone as string`, `(payload.source as string \|\| "")`, `(payload.tags as string[])` | **MEDIUM** | Contact creation path. Non-string email/phone would corrupt lead record. |
| `webhook-pipeline.ts` | 213-217 | `(payload.contactId \|\| ...) as string`, `(payload.fromStage \|\| ...) as string`, `(payload.toStage \|\| ...) as string` | **MEDIUM** | Pipeline stage dedup and stage automation depend on these being real strings. |
| `webhook-task.ts` | 29-31 | `(payload.contactId \|\| ...) as string`, `(payload.title \|\| ...) as string`, `(payload.status \|\| "") as string` | **LOW-MEDIUM** | Task auto-advance path. Non-string title/status would cause silent mismatch in title comparisons. |
| `webhook-message.ts` | 48, 62, 286, 293, 302, 483, 491 | `payload.contactId as string`, `(payload.direction \|\| "inbound") as string`, various messageId casts | **LOW-MEDIUM** | `contactId` is used as a primary key lookup — if non-string, DB query returns no rows (silent failure, not crash). |

### Low-Risk: AI/LLM response content casts (not webhook payloads)

| File | Lines | Pattern | Notes |
|------|-------|---------|-------|
| `ai-brain.ts`, `brain-council.ts`, `strategist.ts`, `closer.ts`, `researcher.ts`, etc. | Multiple | `content as string` on LLM response | These are OpenAI API responses where `content` is typed as `string \| null`. The `as string` assertion is a TypeScript convenience — if `content` is null, `JSON.parse(null as string)` throws, but this is caught by the existing try/catch wrappers in each function. Low priority. |

### Immediate Action Required (Before Next Deploy)

**`webhooks.ts` line 619** is the only remaining HIGH-risk hit — it is the legacy message endpoint that uses the same crash-shape as the fixed line 469. It should be patched in the next commit:

```typescript
// BEFORE (line 619):
const legacyMsgBody = (legacyPayload.body || legacyPayload.message || "") as string;

// AFTER:
const legacyMsgBody = String(legacyPayload.body ?? legacyPayload.message ?? "");
```

All other hits are staged for Foundation B receive-side hardening. Do not fix in bulk tonight — each file needs individual review to ensure the String() coercion doesn't change downstream behavior (e.g., `JSON.stringify` on an object body may be intentional in some paths).

---

## Section 5: Foundation A Follow-On Work (A.1 and A.2)

**Context:** Foundation A's Step B verification (2026-05-19 17:36 UTC) revealed 31 phantom rows in `send_attempts` for the bulk-import lead cohort (1020023–1020070). GHL check on lead 1020023 (Terrence Note) confirmed: GHL returned HTTP 200 with no `messageId` because Twilio returned Error 30003 (number unreachable/dead). Foundation A correctly diverted these to `send_attempts` instead of writing false-success `conversations` rows. Pre-Foundation-A, these were written as NULL-`ghlMessageId` conversation rows — invisible failures.

**Historical baseline:** 7-day pre-Foundation-A null-`ghlMessageId` rate in `conversations` was 30–100% per day (366 sends, ~300+ null IDs). The cold reactivation strategy has been operating against a largely dead lead list for months.

### Foundation A.1 — Carrier-Failure Sub-Classification

| # | Item | Priority | Notes |
|---|------|----------|-------|
| 13 | **Phantom sub-classification by carrier error code.** Currently all empty-messageId outcomes are `outcomeKind: "phantom"`. GHL's response body often contains Twilio error codes (30003 = unreachable, 30004 = blacklisted, 30005 = unknown destination, etc.) that would allow us to distinguish "dead number" from "GHL being weird" from "genuine unknown." The `sendMessage` function in `ghl.ts` should capture the full GHL response body when `messageId` is absent and store it in `send_attempts.payload`. The `classifySendOutcome` function should then sub-classify: `failed_carrier_unreachable`, `failed_dnd_set`, `failed_blacklisted`, vs residual `phantom`. | **MEDIUM** — Improves audit data quality. Enables Foundation A.2 automation. Does not fix a crash. | Requires reading the full GHL response shape when `messageId` is absent. Current payload only stores `messageBodyPreview` and `senderType`. |

### Foundation A.2 — Dead-Number Outbox Handling

| # | Item | Priority | Notes |
|---|------|----------|-------|
| 14 | **Outbox should stop retrying leads with confirmed dead phone numbers.** Currently a lead with a dead number (Twilio 30003) will be re-queued by the follow-up scheduler and the outbox will attempt the same dead send again. After Foundation A.1 classifies the failure as `failed_carrier_unreachable`, the outbox decision logic should: (a) set `humanTakeover = 1` with reason `carrier_unreachable` after N confirmed carrier failures on the same lead, and (b) optionally push `nextFollowUpAt` out 30+ days to prevent immediate re-queue. **Scope:** 33 leads identified with phantom sends in the 7-day window post-Foundation-A deploy. The full historical cohort (bulk Jan 2025 import, `reactivationCount=3`, `cadencePosition=4`) is estimated at 300+ leads. | **HIGH** — Prevents continued API waste and customer-facing damage (sending to dead numbers). Requires Foundation A.1 first. | Do not implement tonight. Requires A.1 carrier classification to be accurate before A.2 automation acts on it. |
| 15 | **Lead list hygiene for the Jan 2025 bulk import cohort.** ~300+ leads with `createdAt` between 2025-01-01 and 2025-02-28, `reactivationCount >= 2`, `cadencePosition >= 4` should be audited for phone number validity before the next reactivation cycle. Options: (a) run a phone number validation service (Twilio Lookup, NumVerify) against the cohort before the next send, (b) mark them `humanTakeover = 1` pending manual review, (c) simply stop reactivating leads with `reactivationCount >= 3` until a human reviews. | **MEDIUM** — Business decision, not a code fix. Recommend PO review. | The 89% phantom rate on the 16:38–18:36 UTC window (31/35 sends) is the clearest signal of cohort-level data rot. |

---

## Section 6: Human-Agent Outbound Recording Bug (Item #16)

| # | Item | Priority | Notes |
|---|------|----------|-------|
| 16 | **Human-agent outbound recording path stores empty body (`{}`) when webhook payload is non-string.** When a human agent (e.g., Nir) sends an SMS via GHL, the inbound webhook delivers the message body in a format that the recording path coerces to `{}` instead of the actual text. The row is written to `conversations` with `senderType='human'`, `direction='outbound'`, and `messageBody='{}'`. The AI's Safety Net sees the row (human sent *something*) but cannot read the content — so it does not classify the send as a real human engagement. This caused the AI to fire on Dang HM 4 hours after Nir had already engaged, because Nir's message appeared as an empty system event rather than a real outbound. **Scope quantified (2026-05-19):** 288 rows in the last 30 days with `messageBody='{}'`, all from today (earliest: 16:05 UTC, latest: 23:42 UTC). Affected leads include Dang HM (id=1059), David DeBrule (id=630), Andrea Allen Radford (id=5130043), Adebola Esther Adesina (id=4860035), and others. This is the same `as string` TypeScript assertion shape as the `webhooks.ts` line 469 crash, but manifesting as silent data corruption rather than a crash. The receiving file is likely `webhook-message.ts` or the Earl Wheeler fix path at commit `66ffd0c`. | **HIGH** — Directly causes the AI to fire on leads where a human agent has already engaged, because the Safety Net cannot read the human outbound body. The Dang HM incident is the confirmed case. Unknown number of additional affected leads in the last 30 days. | **Do not fix tonight.** Include in the medium-tier `as string` cleanup already staged for Foundation B receive-hardening. Before fixing: (a) locate the exact write path in `webhook-message.ts` or the Earl Wheeler commit, (b) apply `String()` coercion at the body extraction point, (c) verify the Safety Net re-reads the corrected body correctly. The 288-row scope is entirely from today — the bug was introduced or became active on 2026-05-19. Pre-today rows are unaffected (no `{}` body rows before 16:05 UTC today). |

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

---

## Section 8: Foundation D Ratification + New Inventory Items (2026-05-20)

**Last Updated:** 2026-05-20 15:50 UTC

---

### Foundation Status

| Foundation | Status | Ratified | Verification Chain |
|------------|--------|----------|--------------------|
| **Foundation A** | Shipped | ✓ 2026-05-19 | Step A + Step B sentinels confirmed live |
| **Foundation D** | Shipped | ✓ 2026-05-20 | Three live `verifyFoundationD` calls: `2026-05-20T15:44:20Z`, `2026-05-20T15:44:38Z` (both on `7479a728`). Root bug found during verification: `affectedRows` was read from wrong nesting level of Drizzle/MySQL result (`result.affectedRows` instead of `result[0].affectedRows`), causing `acquireComposeLock()` to silently return `false` on every call in production. Fixed in `7479a728`. Two-checkpoint sentinel chain: `9bb15a81` (initial deploy) → `7479a728` (idempotent fix). |
| **Foundation C** | Pending | — | Next in sequence (Option A roadmap) |
| **Foundation B** | Pending | — | After Foundation C |

---

### New Inventory Items

| # | Item | Severity | Foundation | Notes |
|---|------|----------|------------|-------|
| 23 | **Business-hours human-priority gating missing from fast_scan path.** `shouldDeferResponse()` (15-minute agent-first window, Mon-Fri 9am-5pm ET) is wired in `webhook-message.ts` and `webhook-contact.ts` but is **not called** in `brain-council-review.ts` (fast_scan path) or `outbox-worker.ts`. Any inbound that arrives during the 2-minute fast_scan window is picked up by fast_scan and bypasses the deferral entirely. **Scope (last 7 days):** 27 fast_scan decisions during business hours across 3 business days (avg 9/day; Wed May 20 = 20, Tue May 19 = 3, Mon May 18 = 4). Dmitriy Grechukha (lead 1319) is the confirmed customer-visible incident: inbound at 15:03:50 UTC, AI reply at 15:04:56 UTC (~66 seconds), no human window given. | **HIGH** — Produces customer-visible policy violation any time fast_scan picks up the inbound before webhook-message. fast_scan is the dominant inbound-reply path (268 decisions in 7 days vs 6 deferred). | **Foundation B** | Do not patch in isolation. Wire `shouldDeferResponse()` into the fast_scan compose path as part of Foundation B's centralized send-policy engine. Band-aid option (30-min Manus job): gate fast_scan behind `process.env.FAST_SCAN_BUSINESS_HOURS_DEFER=true` — PO to decide if needed before Foundation C ships. |
| 24 | **AI commits to physical-world capabilities it cannot fulfill.** Confirmed: Dmitriy Grechukha conversation (2026-05-20) — AI said "Come on by whenever you're free to check out our polo t-shirts" (15:04:56 UTC) and "We'll be ready for you when you get here" (15:06:25 UTC). Customer arrived at the physical location; no one was prepared to greet him (he texted "I'm here. Can someone open the door please" at 15:11:03 UTC). The AI is making implicit promises about physical-world readiness (door open, staff present, items ready) that it has no ability to verify or fulfill. | **MEDIUM** — Causes customer-facing trust damage when the AI's implied promises don't match physical reality. Lower urgency than crash/silence bugs but directly degrades conversion quality for walk-in leads. | **Content distillation (Stage 3)** | Band-aid option: add system prompt rule prohibiting "we'll be ready for you" / "come on by" / "someone will be there" phrasing. Full fix requires the AI to understand it cannot make physical-world commitments. |

---

### Updated Foundation B Scope (Post-Item #23)

Foundation B now includes the following items:
- Patch #1 — channelHint field unification at enqueue time
- Patch #2 — TCPA rules centralized (SMS/WhatsApp strict, IG/FB human-feel, inbound-reply exemption)
- Item #17a — Appointment-webhook humanTakeover false positive
- Item #18 — humanTakeover NOT set on real human sends (depends on Item #16 fix in Foundation C)
- Item #19 — IG channel detection race (channel lock at enqueue time)
- Item #23 — Business-hours human-priority gating for fast_scan path ← **NEW**

---

### Scope Query Results (2026-05-20)

**Query:** fast_scan decisions during business hours (9am-5pm ET, Mon-Fri), last 7 days.

| Date | fast_scan biz-hours count |
|------|--------------------------|
| 2026-05-20 (Wed) | 20 |
| 2026-05-19 (Tue) | 3 |
| 2026-05-18 (Mon) | 4 |
| **7-day total** | **27** |
| **Avg/business day** | **9.0** |

Total fast_scan decisions (all hours, 7d): 268. Trigger breakdown: `follow_up` 6,959 · `fast_scan` 268 · `deferred` 6.

**Decision:** Option X confirmed (D → C → B). 9/day is below the 30/day threshold for sequencing swap. Foundation C ships next.

---

## Section 9 — Foundation C.1.1 Patch + Verification Discipline (2026-05-20)

**Last Updated:** 2026-05-20 17:55 UTC

### Foundation C.1.1 — Outbound Branch Hole Closed

**Root cause:** The empty-body guard in `handleMessageWebhook` was placed AFTER the `direction === 'outbound'` branch that writes to `conversations`. GHL outbound webhooks with `body: {}` bypassed the guard and wrote `{}` rows. The C.1 Step A synthetic tests only exercised the inbound path — they did not cover the outbound branch.

**Fix:** Moved the empty-body guard to immediately after `effectiveMessageBody` is finalized (after attachment handling), before any conversation-write branch. Added `__synth__` contactId short-circuit at top of handler so future verification tests cannot pollute leads/conversations tables.

**Evidence of hole:** 6 rows in `conversations` with `body_hex=7B7D` (literal `{}`) written during C.1 verification window, all from real-time outbound GHL webhooks for Ron Castellon (leadId=4980121).

---

### Item #25 — Synthetic Verification Endpoint Design (MEDIUM)

**Category:** Verification infrastructure  
**Foundation:** C.1.1 (shipped)

Synthetic verification webhooks must use a `__synth__` contactId prefix that short-circuits all real processing (no lead creation, no conversation writes, no GHL calls) while still exercising the coercion logic under test. This prevents test pollution of the leads/conversations tables and makes verification results unambiguous.

**Shipped in C.1.1:** `__synth__` short-circuit added to top of `handleMessageWebhook`. All C.1/C.1.1 tests updated to use `__synth__` prefix.

---

### Item #26 — Verification Branch Coverage Discipline (HIGH)

**Category:** Process / verification quality  
**Scope:** All future foundation verification specs

Every foundation verification spec must enumerate the code branches it tests and explicitly state which branches are NOT covered. The C.1 Step A tests covered only the inbound empty-body path — they missed the outbound branch, which produced 6 real production `{}` rows.

**Rule going forward:** Before marking a foundation as "verified," list every `addConversation` call site in the patched file and confirm each one is covered by at least one synthetic test. If a branch is not covered, it must be documented as a known gap with a follow-up item.

This is the second time in this session (and third or fourth overall) that a fix shipped as "verified" but missed a code path. The discipline is mandatory, not optional.
