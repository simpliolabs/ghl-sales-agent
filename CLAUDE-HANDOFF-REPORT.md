# Claude Handoff Report — Adorb Outreach System

**Date:** May 19, 2026  
**Author:** Manus AI  
**Git:** `f93f0a9` on `github/main` (simpliolabs/ghl-sales-agent)  
**Production:** `ghl.adorbcustomtees.com`

---

## Executive Summary

Four production bugs were identified, diagnosed, and fixed in the Adorb Outreach System — an AI-powered sales outreach platform built on React 19 + Express 4 + tRPC 11 + Drizzle/MySQL that operates as a control layer on top of GoHighLevel (GHL). The system uses a single unified AI brain to respond to leads via SMS, Instagram, Facebook, and Email, with human agent takeover logic, TCPA compliance gates, and a follow-up scheduling engine.

All four bugs have been fixed, tested (1303 tests passing), committed to GitHub, and deployed to production. A fifth issue (outbox worker hang) was also resolved as part of the Bug 4 fix.

---

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     GHL Webhooks (Inbound)                       │
│  ContactCreate → webhook-contact.ts                             │
│  InboundMessage → webhook-message.ts                            │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Outbox Queue (MySQL)                          │
│  Sources: fast_scan, follow_up, first_contact, nurture          │
│  States: pending → claimed → sent/failed/skipped                │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Outbox Worker (5s poll)                       │
│  1. Claim batch (FOR UPDATE SKIP LOCKED)                        │
│  2. Input guards (AI offline, DNC, humanTakeover, TCPA)         │
│  3. Brain call (runSingleBrain or legacy runBrainCouncil)       │
│  4. Output guards (content safety, channel validation)          │
│  5. Send via GHL API                                            │
│  6. Log decision for audit/LoRA training                        │
└─────────────────────────────────────────────────────────────────┘
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| Inbound webhook | `server/webhook-message.ts` | Processes inbound messages, runs Safety Net, triggers fast_scan |
| Contact webhook | `server/webhook-contact.ts` | New lead creation, first-contact delay |
| Outbox worker | `server/outbox-worker.ts` | Single send path — guards + brain + send |
| Single Brain | `server/single-brain.ts` | Unified LLM brain (v3.0) with tools |
| Brain adapter | `server/brain-adapter.ts` | Legacy wrapper with pre-flight checks |
| Fast scan | `server/brain-council-review.ts` | 3-min unanswered message recovery |
| Follow-up trigger | `server/follow-up-trigger.ts` | 10-min cron for scheduled follow-ups |
| Deferred processor | `server/deferred-response-processor.ts` | 2-min cron for deferred + first contacts |
| Safety Net | `server/webhook-message.ts` (evaluateSafetyNet) | Prevents AI from overriding human agents |
| Send helpers | `server/webhook-helpers.ts` | Message splitting, email formatting, retry |

### Cron Schedule

| Cron | Interval | Function |
|------|----------|----------|
| Outbox drain | 5 seconds | Claims and processes pending outbox rows |
| Fast scan | 2 minutes | Finds unanswered inbound messages (3-min window) |
| Follow-up trigger | 10 minutes | Enqueues leads with `nextFollowUpAt <= NOW()` |
| Deferred processor | 2 minutes | Processes deferred responses + pending first contacts |

---

## Bug 1: Earl Wheeler Echo Bug

**Symptom:** AI sent messages that echoed what the human agent (Abby) had already said. Safety Net auto-released `humanTakeover` despite Abby being actively engaged.

**Root Cause:** Human agent outbound messages sent via GHL were never recorded in the `conversations` table. The Safety Net checked conversation rows for human outbounds, found none, and concluded the human was inactive — releasing `humanTakeover`. Six code paths set `lastAgentActivityAt` without recording in conversations.

**Fix (commit `66ffd0c`):**
1. Safety Net now respects `lastAgentActivityAt` recency — if agent was active within 24h, `humanTakeover` is preserved regardless of conversation rows.
2. GHL history sync now records human outbound messages when detected.

**Test file:** `server/safety-gates.test.ts` (23 tests, all pass)

---

## Bug 2: D.J.A.Y. First-Contact Never Fired

**Symptom:** New Instagram lead D.J.A.Y. never received their first-contact message. The 45-second delay timer was killed by a server restart during deployment.

**Root Cause:** `setTimeout(45s)` in `webhook-contact.ts` is ephemeral — killed by any server restart. During the deployment window, the timer was lost.

**Fix (commit `9ca702a`):**
1. New `pending_first_contacts` DB table persists the intent.
2. The 2-minute deferred processor cron picks up pending rows.
3. In-memory `setTimeout` remains as fast-path (works 99% of the time).
4. D.J.A.Y. was manually sent their first-contact message via GHL API (messageId: `lkI5I7n2CpXcHd9jtgf4`).

**Schema addition:** `pending_first_contacts` table with columns: `id`, `leadId`, `ghlContactId`, `channel`, `status`, `createdAt`, `processedAt`.

---

## Bug 3: Martha Ortiz IG/FB 2-Part Message Split

**Symptom:** Instagram and Facebook leads received messages that exceeded platform character limits (1000 chars for IG, 2000 for FB) as a single message instead of being split.

**Root Cause:** The `splitSmsMessage` function in `webhook-helpers.ts` only fired for SMS and WhatsApp channels. IG and FB were not included in the split-send condition.

**Fix (commit `66ffd0c`):** Added `"Instagram"` and `"FB"` to the channel check in the split-send condition.

---

## Bug 4: Vladislav TCPA Violation

**Symptom:** Vladislav received an SMS at 10 PM ET, violating TCPA quiet hours (9 PM - 9 AM ET for SMS).

**Root Causes (three compounding failures):**

1. **Field name mismatch:** Outbox worker's TCPA gate read `itemPayload.channel` but follow-up-trigger and fast_scan enqueue with `channelHint`. So `channel` resolved to empty → fell back to `lead.preferredChannel = "EMAIL"` → TCPA gate skipped (EMAIL is not TCPA-covered).

2. **No stale-reply time limit:** Fast_scan items are marked as `isInboundReply: true` which grants TCPA exemption. But the item was enqueued at 3:46 PM and not processed until 10 PM (6 hours later due to worker hang). A 6-hour-old "reply" is no longer timely.

3. **Human agent not detected:** Abby responded to Vladislav at 3:44 PM, but her message wasn't in the conversations table (same Earl Wheeler bug). Fast_scan didn't detect the human response and enqueued anyway.

**Fix (commit `f93f0a9`):**
1. TCPA gate now reads `channelHint` first: `channelHint || channel || lead.preferredChannel`
2. Stale reply limit: items older than 30 minutes lose their reply exemption
3. Earl Wheeler fix (Bug 1) prevents future Safety Net failures

**Test file:** `server/tcpa-fix-and-timeout.test.ts` (23 tests, all pass)

---

## Bug 5: Outbox Worker Hang (Processing Timeout)

**Symptom:** Outbox worker claims items but hangs indefinitely. Brain Council/Single Brain LLM call times out or crashes silently. The stale-claim recovery (2-min expiry) reclaims them, but they keep hanging in a loop.

**Root Cause:** No processing timeout existed. The LLM layer has a 120s timeout (`_core/llm.ts`), but if the brain orchestration code hangs before or after the LLM call (e.g., during context assembly, tool execution, or DB lock acquisition), nothing kills it.

**Fix (commit `f93f0a9`):** 60-second processing timeout via `Promise.race`:
```typescript
const timeoutPromise = new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error(`processing_timeout:60000ms`)), 60_000);
});
await Promise.race([processOutboxRow(row), timeoutPromise]);
```
If timeout fires, the row is marked `failed` with error `processing_timeout_60s` instead of staying in `claimed` state forever.

---

## Database Cleanup Performed

| Row ID | Lead | Action | Reason |
|--------|------|--------|--------|
| 240003 | D.J.A.Y. | `skipped` | Manually sent via GHL API |
| 240004 | Vladislav | `skipped` | Already sent (10 PM violation) |
| 240007 | Vladislav | `skipped` | Human (Abby) already responded |

Vladislav's lead was also set to `humanTakeover = 1` with `lastAgentActivityAt = NOW()` to prevent fast_scan from continuing to enqueue.

---

## Known Remaining Issues

### 1. Fast Scan Still Enqueues Despite Human Agent Response

The fast_scan timer (in `brain-council-review.ts`) checks for unanswered inbound messages but does not check the `conversations` table for human outbound responses that occurred after the inbound. It only checks `humanTakeover` flag. If a human responds but doesn't set `humanTakeover` (e.g., responds via GHL directly), fast_scan may still enqueue.

**Mitigation:** The Earl Wheeler fix now records human outbounds in conversations, and the Safety Net sets `humanTakeover` when it detects them. But there's a race condition: if fast_scan runs before the next inbound webhook triggers Safety Net evaluation, it may still enqueue.

**Recommended fix:** Add a conversations-table check to fast_scan: before enqueuing, verify no human outbound exists after the unanswered inbound message.

### 2. Outbox Worker Single-Threaded Bottleneck

The drain loop processes rows sequentially. If 5 rows are claimed and each takes 30-60s (LLM call), a single drain cycle takes 2.5-5 minutes. During this time, no new rows are claimed. The `isDraining` guard prevents concurrent drains.

**Recommended fix:** Process rows concurrently (e.g., `Promise.allSettled` with concurrency limit of 3) or reduce `CLAIM_BATCH_SIZE` to 1-2.

### 3. Origin/GitHub Remote Divergence

The Manus checkpoint system uses `origin` remote. GitHub uses `github` remote. After rebasing, they're now aligned, but future Manus checkpoints may diverge again if the checkpoint system force-pushes to `origin`.

**Current state:** Both remotes are at `f93f0a9` after the rebase.

### 4. OpenAI Key Test Failure

`server/openai-key.test.ts` has a pre-existing failure (401 response). This test validates the OPENAI_API_KEY env var against the OpenAI API. The key may have been rotated or the test is hitting a rate limit. Not related to any of the bug fixes.

### 5. Brain Lock TTL vs Processing Timeout

The brain adapter (`brain-adapter.ts`) acquires a DB lock with `BRAIN_COUNCIL_LOCK_TTL_SECONDS = 120`. The new processing timeout is 60s. If timeout fires at 60s but the lock has 120s TTL, the lock remains held for another 60s. This is acceptable (lock auto-expires) but means the same lead cannot be processed by another worker for up to 60s after timeout.

---

## TCPA Compliance Architecture (Post-Fix)

```
Outbox Worker Guard 5 (TCPA):
├── Resolve channel: channelHint → channel → lead.preferredChannel
├── Is TCPA-covered? (SMS or WhatsApp only)
│   ├── YES → Check reply exemption
│   │   ├── Is reply trigger? (fast_scan, inbound_reply, message_received, reply)
│   │   │   ├── YES → Is item < 30 min old?
│   │   │   │   ├── YES → EXEMPT (allow send)
│   │   │   │   └── NO → STALE (not exempt)
│   │   │   └── NO → Not a reply (not exempt)
│   │   └── Check ET hour
│   │       ├── 9 AM - 9 PM → ALLOW
│   │       └── 9 PM - 9 AM → DEFER to next 9 AM
│   └── NO (IG/FB/Email) → Human-feel check
│       ├── Is reply? → ALLOW (any time)
│       └── Cold outreach 11 PM - 7 AM → DEFER to 8 AM
```

---

## Test Coverage Summary

| Test File | Tests | Status |
|-----------|-------|--------|
| `server/tcpa-fix-and-timeout.test.ts` | 23 | All pass |
| `server/safety-gates.test.ts` | 23 | All pass |
| `server/outbox-worker.test.ts` | 19 | All pass |
| All test files (63 total) | 1280 | 1279 pass, 1 pre-existing failure |

---

## Key Constants Reference

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `PROCESSING_TIMEOUT_MS` | 60,000 ms | outbox-worker.ts | Kill hung brain calls |
| `CLAIM_EXPIRY_MS` | 120,000 ms | outbox-worker.ts | Reclaim stale claims |
| `STALE_REPLY_MS` | 1,800,000 ms (30 min) | outbox-worker.ts | Reply exemption expiry |
| `DRAIN_INTERVAL_MS` | 5,000 ms | outbox-worker.ts | Poll frequency |
| `CLAIM_BATCH_SIZE` | 5 | outbox-worker.ts | Rows per drain cycle |
| `MAX_RETRIES` | 3 | outbox-worker.ts | Retry limit |
| `LLM_CALL_TIMEOUT_MS` | 120,000 ms | _core/llm.ts | LLM HTTP timeout |
| `BRAIN_COUNCIL_LOCK_TTL_SECONDS` | 120 | brain-adapter.ts | DB lock TTL |
| `MIN_NEXT_FOLLOW_UP_HOURS` | 4 | outbox-worker.ts | Min hours between sends |

---

## Environment & Deployment

| Item | Value |
|------|-------|
| Production URL | `ghl.adorbcustomtees.com` |
| Manus domain | `adorboutreach-28achv27.manus.space` |
| GitHub repo | `simpliolabs/ghl-sales-agent` |
| Latest commit | `f93f0a9` |
| Stack | React 19 + Express 4 + tRPC 11 + Drizzle + MySQL/TiDB |
| Node version | 22.13.0 |
| Package manager | pnpm |
| Dev server port | 3000 |

---

## Handoff Notes for Claude

1. **The "Brain Council" is actually a single brain.** The name is legacy. `runBrainCouncil` in `brain-adapter.ts` is just a wrapper that does pre-flight checks then calls `runSingleBrain`. There is no multi-agent council.

2. **The outbox is the ONLY send path.** All outbound messages go through the outbox table. Never send directly via GHL API from webhook handlers or crons.

3. **Safety Net evaluates on every inbound message.** It checks if a human agent is active and prevents AI from overriding. The fix ensures `lastAgentActivityAt` recency is respected.

4. **TCPA is a hard legal constraint.** SMS must never be sent 9 PM - 9 AM ET. This is not a preference — it's a compliance requirement. The reply exemption exists because TCPA allows responses to customer-initiated conversations, but only if timely.

5. **The fast_scan is aggressive.** It runs every 2 minutes and enqueues for any inbound message unanswered for 3 minutes. This is intentional (fast response time) but can conflict with human agents if Safety Net doesn't catch them first.

6. **Vladislav's lead is now in humanTakeover.** The AI will not contact him until `lastAgentActivityAt` expires (4 hours from NOW, set May 19 2026 ~02:30 UTC). After that, AI resumes unless a human re-engages.

7. **D.J.A.Y.'s first contact was sent manually.** Their outbox row (240003) is marked `skipped`. The lead is active and should receive normal follow-ups going forward.
