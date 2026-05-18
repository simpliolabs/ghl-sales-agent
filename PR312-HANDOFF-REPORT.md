# PR#3.12 Handoff Report — Phantom Conversation Prevention + MessageId Capture

**Date:** 2026-05-18  
**Status:** Published (checkpoint `adc82f69`, GitHub `adc82f6`)  
**Author:** Manus AI  
**Domains:** `ghl.adorbcustomtees.com`, `adorboutreach-28achv27.manus.space`

---

## Summary

PR#3.12 closes the "phantom conversation" bug where GHL returns HTTP 200 but provides no `messageId` in the response body. Previously, the system would unconditionally write a `conversations` row after any 200 response, creating database records for messages that GHL never actually delivered. This PR adds detection, logging, and `ghlMessageId` capture at all send paths.

---

## Root Cause

GHL's `/conversations/messages` endpoint occasionally returns `{ conversationId, status: "pending" }` without a `messageId` field. This happens when:

1. The contact's channel is disconnected (e.g., IG token expired)
2. GHL's internal queue accepts but never delivers the message
3. Rate limiting silently drops the send

The old code treated any non-error response as success and wrote a `conversations` row with `ghlMessageId=NULL`. These "phantom" rows pollute conversation history and cause the AI to believe it already engaged the lead.

---

## Changes Made

### New Helper: `classifySendOutcome()` (webhook-helpers.ts, lines 201-213)

```typescript
export function classifySendOutcome(result: unknown): { 
  messageId?: string; emailMessageId?: string; isPhantom: boolean 
} {
  const data = result as Record<string, unknown> | undefined;
  const messageId = data?.messageId as string | undefined;
  const emailMessageId = (data?.emailMessageId || data?.messageId) as string | undefined;
  const isPhantom = !messageId;
  if (isPhantom) {
    console.warn(`[SendRetry] PR#3.12: Phantom send detected — GHL returned 200 with no messageId. Response keys: ${data ? Object.keys(data).join(", ") : "null"}`);
  }
  return { messageId: messageId || undefined, emailMessageId: emailMessageId || undefined, isPhantom };
}
```

### Extended Return Type: `sendMessageWithRetry` (webhook-helpers.ts, line 219)

```typescript
Promise<{ 
  success: boolean; resolvedContactId: string; error?: string; 
  errorType?: GhlSendErrorType; correctionTaken?: string; 
  emailMessageId?: string; ghlMessageId?: string; isPhantom?: boolean 
}>
```

All 6 success paths in `sendMessageWithRetry` now call `classifySendOutcome()` and propagate `ghlMessageId` + `isPhantom`.

### Updated Caller Sites (7 total)

| File | Location | Change |
|------|----------|--------|
| `webhook-message.ts` | Line 956 (normalSendResult type) | Added `ghlMessageId?: string; isPhantom?: boolean` to local type |
| `webhook-message.ts` | Line 980-981 | Phantom warning + `ghlMessageId` passed to `addConversation` |
| `webhook-contact.ts` | Line ~852 | `addConversation` now receives `ghlMessageId` |
| `outbox-worker.ts` | Path A (~line 341) | Phantom warning + `ghlMessageId` to `addConversation` |
| `outbox-worker.ts` | Path B (~line 496) | Phantom warning + `ghlMessageId` to `addConversation` |
| `lost-lead-nurture.ts` | Line ~301 | `ghlMessageId` passed to `addConversation` |
| `post-delivery-executor.ts` | Line ~130 | Phantom warning + `ghlMessageId` to `addConversation` |
| `webhook-pipeline.ts` | addConversation call | `ghlMessageId` passed |
| `webhook-task.ts` | Both addConversation calls | `ghlMessageId` passed |

### TypeScript Fix (folded into this PR)

Line 956 of `webhook-message.ts` had a manually-typed local variable `normalSendResult` that was missing the new properties. Fixed by adding `ghlMessageId?: string; isPhantom?: boolean` to the type annotation.

---

## Test Coverage

**File:** `server/pr312-messageid-classification.test.ts` — **7/7 pass**

| # | Test | Validates |
|---|------|-----------|
| 1 | classifySendOutcome returns messageId when GHL provides one | Happy path extraction |
| 2 | classifySendOutcome flags isPhantom=true when GHL returns no messageId | Phantom detection |
| 3 | classifySendOutcome extracts emailMessageId from GHL response | Email messageId path |
| 4 | classifySendOutcome handles null/undefined response gracefully | Defensive coding |
| 5 | sendMessageWithRetry propagates ghlMessageId on normal success | End-to-end propagation |
| 6 | sendMessageWithRetry propagates isPhantom=true when GHL returns empty response | Phantom flag propagation |
| 7 | sendMessageWithRetry propagates ghlMessageId through email fallback path | Fallback path coverage |

---

## Production Verification

After publish, confirm these log lines appear:

```
[SendRetry] PR#3.12: Phantom send detected — GHL returned 200 with no messageId. Response keys: conversationId, status
[Webhook/Msg] PR#3.12: Phantom normal send for lead X
[Outbox] PR#3.12: Phantom Path A send for lead X
```

---

## Post-Publish Actions Required

1. **Phantom backfill query** — find all AI conversations with `ghlMessageId IS NULL` from the last 7 days:
   ```sql
   SELECT id, leadId, channel, createdAt 
   FROM conversations 
   WHERE senderType='ai' AND ghlMessageId IS NULL AND createdAt > NOW() - INTERVAL 7 DAY;
   ```

2. **Re-engage Robert Gonzales Sr. and Christina Stein** — they have phantom AI conversation rows from FB sends. Now safe to re-engage since new sends will be properly tracked.

3. **Monitor `auto-correction.ts`** — still uses `sendMessage` directly (not `sendMessageWithRetry`), creating phantom rows unconditionally. Noted as separate fix for a future PR.

---

## Known Remaining Issues

| Issue | Status | Notes |
|-------|--------|-------|
| `auto-correction.ts` uses `sendMessage` directly | Deferred | Creates phantom rows unconditionally; separate PR needed |
| `ghl.ts:285` TS error (leftover from PR#3.5) | Deferred | Fold into next PR touching ghl.ts |
| Double-message fires as single concatenated message on IG | Flagged | PO will spec; `---` separator visible to user |

---

## Git History

```
adc82f6 PR#3.12 fix: add ghlMessageId + isPhantom to normalSendResult type declaration in webhook-message.ts
d7e1255 PR#3.12: Phantom conversation prevention + messageId capture (original commit, TS error)
47f3e27 PR#3.13: TCPA quiet-hours scoping — channel-specific gates
9f0afb9 PR#3.11: Defensive crash fix + preliminary channel detection
59988bf PR#3.10: require userId for human agent detection
```

---

## Next in Queue

**PR#3.7:** Operator wiring — `knowledge_files` + `ai_tweaks` → Single Brain  
Source files at commit `9f84210`:
- `server/single-brain.ts`
- `server/brain-context.ts`
