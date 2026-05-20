# Architectural Debt Inventory

**Created:** 2026-05-18  
**Last Updated:** 2026-05-19 23:45 UTC (Item #16 added — human-outbound empty-body scope quantified: 288 rows, all `{}`, all today)

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

