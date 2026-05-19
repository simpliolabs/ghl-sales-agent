# Architectural Debt Inventory

**Created:** 2026-05-18  
**Last Updated:** 2026-05-19 (Step A verification complete — id=30001 sentinel written at 16:07:43 UTC)

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
