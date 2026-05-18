# IG Lead Engagement Failure — Diagnostic Report for Claude

**Date:** 2026-05-18 02:40 UTC  
**Author:** Manus AI (Builder)  
**Priority:** URGENT — 4 leads sitting unengaged for 3+ hours  
**Repo:** https://github.com/simpliolabs/ghl-sales-agent  
**Commit (current HEAD):** `9f84210` on `main`

---

## 1. Problem Statement

Instagram leads entering the system via GHL webhooks are not being engaged by the AI. The PO observed 6 leads in the GHL Team Inbox (screenshot provided) that had received no AI response. After investigation, 4 of the 6 are confirmed to have **zero conversations, zero outbox entries, and zero deferred responses** — the AI never attempted to contact them at all. The other 2 (Facebook leads) have conversation records in our DB but the PO reports they are also not engaged in GHL, suggesting a possible GHL send failure.

---

## 2. Affected Leads

| ID | Name | Channel | Created (UTC) | Conversations | Outbox | AI State | preferredChannel | lastOutboundChannel | pipelineStage |
|---|---|---|---|---|---|---|---|---|---|
| 4980409 | Darius Gilbert | IG | 05-17 23:30 | 0 | 0 | angle=?, fw=?, msgCt=0 | ghl | NULL | New Lead |
| 4980400 | Jay | IG | 05-17 23:29 | 0 | 0 | angle=?, fw=?, msgCt=0 | ghl | NULL | New Lead |
| 4980397 | Glenys Romero | IG | 05-17 23:18 | 0 | 0 | angle=?, fw=?, msgCt=0 | NULL | NULL | new_lead |
| 4980398 | Glenys Romero (dup) | IG | 05-17 23:18 | 0 | 0 | angle=?, fw=?, msgCt=0 | NULL | NULL | not_qualified |
| 4980718 | Robert Gonzales Sr. | FB | 05-18 01:25 | 2 (1 in, 1 out) | 0 | angle=single_brain, msgCt=1 | ghl | FB | New Lead |
| 4980381 | Christina Stein | FB | 05-17 23:08 | 2 (1 in, 1 out) | 0 | angle=single_brain, msgCt=1 | ghl | FB | New Lead |

**Key pattern:** All leads have `source=ghl` and `baseScore=50`. All were created Saturday evening 7-9:30 PM ET (outside business hours). The IG leads (Darius, Jay, Glenys) have `ai_state.messageCount=0` and `ai_state.lastAngleUsed=NULL` — Brain Council never ran for them.

---

## 3. What We Already Cleared

Before this diagnostic, we cleared false-positive `humanTakeover=1` flags on all 6 leads (caused by the PR#3.10 bug — GHL workflow messages during the 45s delay window). All leads now have `humanTakeover=0`. The `nextFollowUpAt` values are set to 05-18 13:18-13:30 UTC (9:18-9:30 AM ET Monday) — the follow-up trigger will pick them up then, but as generic follow-ups, not first-contacts, and likely on the wrong channel (SMS instead of IG).

---

## 4. Root Cause Analysis

### 4.1 The webhook flow (what should happen)

The contact webhook (`server/webhook-contact.ts`, line 64: `handleContactWebhook`) processes new leads in this order:

1. **Line 68:** `upsertLead()` — creates/updates lead in DB
2. **Line 80-110:** GHL contact ID resolution + enrichment
3. **Line 117-147:** Duplicate lead dedup
4. **Line 149-176:** Segment classification + research + Omnisend push
5. **Line 180-188:** `handleStageAutomation()` — stage automation
6. **Line 190-191:** `calculateNextFollowUp({ triggerEvent: "new_lead" })` — sets `nextFollowUpAt`
7. **Line 207-238:** `createHeadsUpNotification()` — appointment + task + note + owner notification
8. **Line 256-265:** `setTimeout(() => sendDelayedFirstContact(...), FIRST_CONTACT_DELAY_MS)` — schedules the actual AI engagement after 45s

**The critical observation:** For the IG leads, step 6 completed (nextFollowUpAt is set) but step 8's callback never produced any output (no conversations, no ai_state updates, no outbox entries). Either:
- (A) The setTimeout never fired (webhook errored between lines 190 and 256)
- (B) The setTimeout fired but `sendDelayedFirstContact` crashed before reaching Brain Council
- (C) The setTimeout fired but a guard (rate limit, DNC, etc.) blocked it silently

### 4.2 Evidence pointing to (A) or (B)

The `ai_state` for these leads has `lastAngleUsed=NULL` and `messageCount=0`. If `sendDelayedFirstContact` had reached the Brain Council call (line 682), the ai_state would have been updated (line 764-768 for deferred, or later for immediate send). This means the function either never ran or crashed before line 682.

The `preferredChannel=ghl` (not IG) for Darius and Jay confirms that channel detection (line 496+) never ran — it only runs inside `sendDelayedFirstContact`. The `preferredChannel` was set by the initial `upsertLead` from the webhook payload's `source` field, not by the multi-layer channel detection.

### 4.3 What's different about Robert + Christina (FB leads that DID get AI state)?

Robert (4980718) and Christina (4980381) have `ai_state.lastAngleUsed=single_brain` and `messageCount=1`, plus 2 conversation rows each (1 inbound FB, 1 outbound AI FB). This means `sendDelayedFirstContact` DID run for them and Brain Council DID compose a message. The conversations were recorded in our DB.

However, the PO says they're not engaged in GHL. Possible explanations:
- The GHL `sendMessage` API call failed silently (returned success but didn't deliver)
- The message was sent to a stale/wrong GHL contact ID
- The GHL conversation view doesn't show the message for some IG/FB-specific reason

### 4.4 Server logs

The sandbox dev server logs (`devserver.log`) do NOT contain any `[Webhook]` prefixed entries from the time these leads were created (05-17 23:08-01:25 UTC). The logs DO show:
- Connection loss errors at 17:59 UTC (`Connection lost: The server closed the connection`)
- Errors at `webhooks.ts:140` in the supervisor timer
- The Lookback system picking up these leads at 02:36 UTC (after our humanTakeover cleanup) with `engage` recommendations

**Important caveat:** These are the sandbox dev server logs, not the production server logs. The production server at `ghl.adorbcustomtees.com` has its own logs that we cannot access from the sandbox. The webhook processing for these leads happened on the production server, not in the sandbox.

### 4.5 Scheduling math

For a brand-new lead (age < 1h, baseScore=50, tier="mid"), `calculateAgeScoreBaseline` returns `delayHours=0.25` (15 minutes). After ICP multiplier (likely 1.0), `pushToNextBusinessHour` checks if the resulting time falls within Mon-Fri 9am-5pm ET.

These leads were created Saturday 7-9:30 PM ET. Saturday is not a business day. `pushToNextBusinessHour` loops hour-by-hour until it finds a valid business hour: Monday 9 AM ET = 05-19 13:00 UTC. This explains the observed `nextFollowUpAt` values (13:18-13:30 UTC on 05-18 or 05-19).

**This is correct behavior for the follow-up scheduler** — but the first-contact should have fired immediately via `sendDelayedFirstContact` (which does NOT check business hours). The follow-up scheduler is a backup, not the primary engagement path.

---

## 5. Hypotheses (Ranked by Likelihood)

### Hypothesis 1: `sendDelayedFirstContact` crashed on a pre-Brain-Council guard (HIGH confidence)

Between the humanTakeover re-check (line 298) and the Brain Council call (line 682), there are several guards:
- **Line 320:** `fetchGhlConversationHistory(resolvedContactId)` — if this throws, it's caught (line 370) and continues
- **Line 375:** `checkRateLimits()` — could block but would log
- **Line 381:** `checkLeadRateLimit(leadId)` — could block but would log
- **Line 387:** `getRecentAiOutboundCount(leadId, 15)` — could block but would log
- **Line 395:** `getConversationHistory(leadId, 10)` + `checkDnc()` — **if this throws an unhandled error, the entire function crashes**

Wait — line 420-424 shows the DNC check IS wrapped in try/catch with `return` (fail closed). So a DNC error would skip first-contact but not crash.

**Line 427:** `fetchGhlConversationHistory(resolvedContactId)` — this is a SECOND call to GHL API (the first was at line 320). If the GHL API is rate-limited or the contact ID is invalid, this could throw. But it's NOT wrapped in try/catch — **an unhandled error here would crash `sendDelayedFirstContact`**.

Actually, looking more carefully: line 427 is NOT in a try/catch. If `fetchGhlConversationHistory` throws here, the entire function crashes with an unhandled promise rejection. The `.catch` on line 263 would log it but the lead would be silently dropped.

### Hypothesis 2: The webhook itself crashed before reaching setTimeout (MEDIUM confidence)

Steps 3-7 (dedup, research, stage automation, heads-up notification) all run before the setTimeout. If any of these threw an unhandled error, the webhook would return 500 and setTimeout would never fire. But `nextFollowUpAt` IS set (step 6), which means the webhook got at least to line 191. The question is whether it got past line 238 (end of heads-up notification try/catch) to line 256 (setTimeout).

### Hypothesis 3: Production deploy was stale or crashed (MEDIUM confidence)

The PR#3.10 changes were just published. Before that, the production code may have had a different version with different bugs. The leads were created before PR#3.10 was published.

### Hypothesis 4: IG-specific GHL API issue (LOW-MEDIUM confidence)

Instagram messages in GHL may have a different contact ID format or conversation structure that causes `fetchGhlConversationHistory` to fail. The FB leads (Robert, Christina) worked because FB has a different API path than IG in GHL.

---

## 6. Immediate Actions Needed

### 6.1 Fix the unengaged leads NOW (manual intervention)

The follow-up trigger will pick up Darius, Jay, and Glenys at ~9:18-9:30 AM ET today. But:
- Their `preferredChannel` is wrong (`ghl` instead of `IG`)
- They'll be treated as follow-ups, not first-contacts
- The follow-up trigger uses `sourceToChannel(source)` which maps `ghl` → SMS

**Recommended:** Update `preferredChannel` to `IG` for these leads so the follow-up trigger sends on the correct channel:
```sql
UPDATE leads SET preferredChannel = 'IG' WHERE id IN (4980409, 4980400, 4980397);
```

Also consider setting `nextFollowUpAt = NOW()` to trigger immediate engagement instead of waiting until 9 AM ET:
```sql
UPDATE leads SET nextFollowUpAt = NOW(), preferredChannel = 'IG' WHERE id IN (4980409, 4980400, 4980397);
```

### 6.2 Check Robert + Christina in GHL

Robert and Christina have conversation records in our DB showing AI sent a message on FB. Verify in GHL whether:
- The message appears in the GHL conversation view
- The GHL contact ID matches the one in our DB
- The message was actually delivered to Facebook Messenger

### 6.3 Add error handling to line 427

The second `fetchGhlConversationHistory` call at line 427 is not wrapped in try/catch. If it throws, the entire `sendDelayedFirstContact` function crashes silently. Wrap it:

```typescript
// Line 427 — currently:
const ghlHistory = await fetchGhlConversationHistory(resolvedContactId);

// Should be:
let ghlHistory: any[] = [];
try {
  ghlHistory = await fetchGhlConversationHistory(resolvedContactId);
} catch (ghlErr) {
  console.error(`[Webhook] GHL history fetch failed for lead ${leadId} (non-fatal, proceeding with empty history):`, ghlErr);
}
```

### 6.4 Add comprehensive error logging to sendDelayedFirstContact

The `.catch` on line 263 only logs a one-line error. Add structured error logging that captures which step failed:

```typescript
sendDelayedFirstContact(leadId, leadSnapshot, payloadSnapshot, capturedResolvedContactId)
  .catch(err => {
    console.error(`[Webhook] ❌ Delayed first-contact FAILED for lead ${leadId}:`, err.message);
    console.error(`[Webhook] Stack:`, err.stack);
  })
```

---

## 7. Source Files for Reference

All pinned to commit `9f84210` (current github/main HEAD):

| File | Lines | Key Functions | Raw URL |
|---|---|---|---|
| `server/webhook-contact.ts` | 1-269 | `handleContactWebhook` (entry point) | [View](https://github.com/simpliolabs/ghl-sales-agent/blob/9f84210/server/webhook-contact.ts#L64-L269) |
| `server/webhook-contact.ts` | 276-830 | `sendDelayedFirstContact` (delayed engagement) | [View](https://github.com/simpliolabs/ghl-sales-agent/blob/9f84210/server/webhook-contact.ts#L276-L830) |
| `server/scheduling-engine.ts` | 429-454 | `calculateAgeScoreBaseline` (P4 scheduling) | [View](https://github.com/simpliolabs/ghl-sales-agent/blob/9f84210/server/scheduling-engine.ts#L429-L454) |
| `server/scheduling-engine.ts` | 191-216 | `pushToNextBusinessHour` | [View](https://github.com/simpliolabs/ghl-sales-agent/blob/9f84210/server/scheduling-engine.ts#L191-L216) |
| `server/follow-up-trigger.ts` | full | `processOverdueFollowUps` (backup engagement) | [View](https://github.com/simpliolabs/ghl-sales-agent/blob/9f84210/server/follow-up-trigger.ts) |
| `server/ghl.ts` | full | GHL API layer (sendMessage, fetchHistory) | [View](https://github.com/simpliolabs/ghl-sales-agent/blob/9f84210/server/ghl.ts) |
| `server/db.ts` | full | Database access layer | [View](https://github.com/simpliolabs/ghl-sales-agent/blob/9f84210/server/db.ts) |

---

## 8. Questions for Claude

1. **Is the unhandled `fetchGhlConversationHistory` at line 427 the smoking gun?** If the GHL API returns a different error for IG contacts vs FB contacts, this would explain why FB leads (Robert, Christina) got engaged but IG leads (Darius, Jay, Glenys) did not.

2. **Should `sendDelayedFirstContact` have a business-hours gate?** Currently it fires regardless of time. The Brain Council runs, composes a message, and sends it at 11 PM on a Saturday. Is that intentional? The `shouldDeferResponse` check (line 726) only defers during Mon-Fri 9am-5pm — outside those hours, it sends immediately.

3. **Should the follow-up trigger be channel-aware for first-contact recovery?** When `sendDelayedFirstContact` fails and the follow-up trigger picks up the lead, it has no way to know the lead came from IG. The `preferredChannel` was never set because channel detection only runs inside `sendDelayedFirstContact`. Should the webhook set a preliminary `preferredChannel` based on webhook payload source BEFORE the setTimeout?

4. **What's the right PR scope?** This could be:
   - PR#3.11: Defensive error handling in `sendDelayedFirstContact` (wrap line 427, add structured error logging)
   - PR#3.12: Set preliminary `preferredChannel` from webhook payload before setTimeout
   - Or fold both into one PR

---

## 9. Timeline of Events

| Time (UTC) | Time (ET) | Event |
|---|---|---|
| 05-17 23:08 | 7:08 PM Sat | Christina Stein created (lead 4980381) |
| 05-17 23:18 | 7:18 PM Sat | Glenys Romero created (leads 4980397 + 4980398 dup) |
| 05-17 23:29 | 7:29 PM Sat | Jay created (lead 4980400) |
| 05-17 23:30 | 7:30 PM Sat | Darius Gilbert created (lead 4980409) |
| 05-17 ~23:09-23:31 | ~7:09-7:31 PM | setTimeout fires for each lead (45s after creation) |
| 05-17 ~23:09-23:31 | ~7:09-7:31 PM | sendDelayedFirstContact runs — FAILS for IG leads, SUCCEEDS for FB leads |
| 05-18 01:25 | 9:25 PM Sat | Robert Gonzales Sr. created (lead 4980718) — FB lead, AI engages successfully |
| 05-18 ~02:15 | ~10:15 PM | We clear humanTakeover flags on all 6 leads |
| 05-18 02:36 | 10:36 PM | Lookback system picks up all 5 leads, recommends "engage" |
| 05-18 13:18-13:30 | 9:18-9:30 AM Mon | nextFollowUpAt — follow-up trigger will attempt engagement |

---

## 10. Supervisor Log Note

The supervisor is running every ~40s and correcting 70-100 violations per cycle. The latest output:
```
[Supervisor] Cycle complete: 4291 leads checked, 100 violations, 100 corrected, 0 failed (45699ms)
```

This is a separate concern but worth noting — 100 violations per cycle on 4291 leads is a 2.3% violation rate. The supervisor is doing heavy lifting to keep the system consistent.
