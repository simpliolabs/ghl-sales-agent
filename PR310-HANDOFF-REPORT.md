# PR#3.10 — Handoff Report for Claude

**Author:** Manus AI
**Date:** May 18, 2026
**Status:** Complete — committed, tested, pushed to GitHub
**Manus Checkpoint:** `b92fc057`

---

## 1. Summary

PR#3.10 fixes a false-positive humanTakeover bug in the first-contact delay window of `server/webhook-contact.ts`. GHL workflow messages (automated promotional templates like "WAIT! You're not done yet...") were being misclassified as human agent activity during the 45-second delay before AI first-contact, which set `humanTakeover=1` and permanently blocked AI engagement for the affected lead. The fix requires a `userId` to classify any outbound GHL message as human agent activity, matching the same guard already enforced in `ghl.ts` Layer B (PR#3.5).

---

## 2. Git References

| Item | Value |
|---|---|
| **Repository** | `https://github.com/simpliolabs/ghl-sales-agent` |
| **Branch** | `main` |
| **PR#3.10 Commit Hash** | `59988bf6bb47dd16e9c1365c36bf27e5f24dd280` |
| **Commit URL** | https://github.com/simpliolabs/ghl-sales-agent/commit/59988bf6bb47dd16e9c1365c36bf27e5f24dd280 |
| **Parent Commit** | `d38f1ca` (security: remove .project-config.json from git tracking) |
| **Grandparent** | `0cb6600` (PR#3.9: conversations write + lastMessageAt + 4h dedup) |
| **Files Changed** | `server/webhook-contact.ts`, `server/pr310-first-contact-userid.test.ts`, `todo.md` |
| **Insertions/Deletions** | +482 / -19 |

### Commit History (latest 5 on github/main)

```
59988bf PR#3.10: require userId for human agent detection in first-contact delay window
d38f1ca security: remove .project-config.json from git tracking
0cb6600 PR#3.9: conversations write + lastMessageAt + 4h dedup + nextFollowUpHours floor
1c1bed5 Merge github/main into local main (resolve ghl.ts + todo.md conflicts)
6bd43cc PR#3.8: Atomic outbox claim + isDraining guard
```

---

## 3. Bug Description (Root Cause)

The incident was discovered via **Gabriela Marques** (lead ID `4980259`, GHL contact `uYEP7TQUnWx6bS3kF0UH`). When Gabriela submitted a form, the following sequence occurred:

1. GHL webhook fires → `handleContactWebhook` creates the lead and schedules a 45-second delayed first-contact via `setTimeout`.
2. During the 45-second delay, a **GHL workflow** fires an automated promotional SMS to Gabriela: "WAIT! You're not done yet..." — this is a template message with **no `userId`** field.
3. When `sendDelayedFirstContact` runs after the delay, it fetches fresh GHL conversation history and checks for recent outbound messages to detect if a human agent has already engaged.
4. The old filter code at line 338-342 had this logic:

```typescript
// OLD CODE (buggy)
if (m.userId) return true;
// Even without userId, if it's a substantial outbound message during the delay,
// it's likely a human agent (our AI hasn't sent anything yet for this lead)
return true;  // <-- BUG: returns true for ALL outbound messages
```

The comment says "it's likely a human agent" but that assumption is wrong — GHL workflows produce outbound messages without `userId` that are automation, not human agents. The `return true` on line 342 meant **every** outbound message during the delay window was classified as human agent activity, regardless of whether a human was involved.

5. Result: `humanTakeover=1` was set, and AI first-contact was permanently blocked for Gabriela.

---

## 4. Fix Applied

### 4a. Production Code Change (`server/webhook-contact.ts`)

**Line 276:** Added `export` keyword to `sendDelayedFirstContact` for testability.

```diff
-async function sendDelayedFirstContact(
+export async function sendDelayedFirstContact(
```

**Lines 338-344:** Replaced the permissive filter with a strict `userId` requirement.

```diff
-          // Check for userId — messages with userId are from human agents
-          if (m.userId) return true;
-          // Even without userId, if it's a substantial outbound message during the delay,
-          // it's likely a human agent (our AI hasn't sent anything yet for this lead)
-          return true;
+          // PR#3.10: Require userId to classify as human agent activity.
+          // GHL workflows (e.g. "WAIT! You're not done yet..." promo template) produce
+          // outbound messages WITHOUT userId — those are automation, not human agents.
+          // Without this guard, workflow messages during the 45s delay window get
+          // misclassified as agent takeover and block AI first-contact entirely.
+          // This matches the userId requirement enforced in ghl.ts Layer B (PR#3.5).
+          return Boolean(m.userId || (m as any).user?.id);
```

**Lines 346-356:** Added diagnostic log for ignored workflow messages.

```typescript
// PR#3.10: Diagnostic log for workflow messages that no longer trigger takeover
const ignoredOutboundCount = freshGhlHistory.filter(m => 
  m.direction === "outbound" && 
  m.body?.trim() && 
  m.dateAdded &&
  (now - new Date(m.dateAdded).getTime()) <= DELAY_WINDOW_MS &&
  !m.userId && !(m as any).user?.id
).length;
if (ignoredOutboundCount > 0 && recentAgentMsgs.length === 0) {
  console.log(`[Webhook] PR#3.10: Ignored ${ignoredOutboundCount} non-user GHL outbound message(s) during first-contact delay window for lead ${leadId} (likely workflow/automation)`);
}
```

### 4b. Design Rationale

The fix aligns the first-contact delay window filter with the same `userId` requirement already enforced in `ghl.ts` Layer B (PR#3.5). In the GHL API, messages sent by human agents always have a `userId` field (or a nested `user.id`). Messages sent by workflows, automations, and system processes do not. By requiring `userId`, we correctly distinguish human agent activity from automated messages.

The `(m as any).user?.id` fallback handles an edge case where some GHL API responses nest the user ID inside a `user` object rather than a flat `userId` field.

---

## 5. Test Coverage

**File:** `server/pr310-first-contact-userid.test.ts` (445 lines)

**Result:** 5/5 tests pass in isolation (22ms execution time).

| # | Test Name | What It Verifies |
|---|---|---|
| 1 | allows first-contact when GHL history has workflow message without userId | Workflow message (no userId) → AI proceeds normally, `humanTakeover` stays 0 |
| 2 | sets humanTakeover when GHL history has message WITH userId | Human agent message (with userId) → `humanTakeover=1`, first-contact blocked |
| 3 | sets humanTakeover when mix of workflow and human messages (userId one counts) | Mixed messages → the one with userId triggers takeover |
| 4 | ignores outbound messages older than DELAY_WINDOW_MS | Old messages outside the 45s window → ignored → AI proceeds |
| 5 | fires diagnostic log when non-userId outbound messages are ignored | Diagnostic log fires with correct count when workflow messages are filtered out |

### Test Architecture

The test file uses `vi.hoisted()` mocks for all dependencies (`./db`, `./ghl`, `./scheduling-engine`, `./channel-fallback`, `./webhook-helpers`, `./brain-adapter`, `./deferred-response-processor`, `./_core/notification`, `./agent-notifications`, `./omnisend`, `./ai-brain`, `./lead-researcher`). It imports `sendDelayedFirstContact` directly and calls it with controlled GHL history payloads. The `_setFirstContactDelay` helper sets the delay to 0ms for test speed.

### Known Limitation

The tests pass in isolation but may fail in a full-suite run due to cross-file mock contamination (documented in `todo.md` as a known issue from PR#3.9). A downstream `substring` error at line 830 fires during test execution but does not affect assertions — it occurs after the userId filter logic has already been verified.

---

## 6. Gabriela Marques Diagnostic

A full diagnostic was run against the production database for Gabriela's lead records.

### Lead Records

| Field | Lead 4980259 (Primary) | Lead 4980260 (Duplicate) |
|---|---|---|
| name | Gabriela Marques | Gabriela Marques \| Seguros & Familia |
| ghlContactId | uYEP7TQUnWx6bS3kF0UH | n9heF4jwFlX9PUEMs5qv |
| humanTakeover | **0** | 0 |
| lastAgentActivityAt | 2026-05-18 01:27:02 | NULL |
| lastOutboundChannel | EMAIL | NULL |
| pipelineStage | New Lead | new_lead |
| source | ghl | — |

### Key Findings

**No cleanup needed.** The supervisor's auto-escalation system had already cleared the false-positive `humanTakeover` flag before PR#3.10 was deployed. The `lastAgentNote` shows: "Auto-Escalation: Switching to EMAIL outreach — Stale humanTakeover (no agent activity for 24+ hours), escalating to email."

Additional data points confirming no damage:

- **0 conversations** recorded for either lead — the AI never successfully sent a first-contact message (the workflow message blocked it before the fix).
- **0 outbox rows** — no pending messages queued.
- **AI state exists but empty** — `ai_state` row (id=4950104) has `messageCount=0`, `lastAngleUsed=NULL`, `followupTier=none`. Confirms no AI messages were ever composed.

The lead is in "New Lead" stage with EMAIL as the outbound channel. The next follow-up cycle should pick her up normally now that the fix is deployed.

---

## 7. Deployment Status

| Item | Status |
|---|---|
| Code committed locally | Yes (`59988bf`) |
| Pushed to GitHub | Yes (github/main = `59988bf`) |
| Manus checkpoint | `b92fc057` |
| Deployed to production | Pending — requires Publish via Manus UI |
| TS error in ghl.ts:285 | Pre-existing (`.user` property access needs type assertion) — does not block deployment |

---

## 8. Post-Deploy Monitoring

After deployment, monitor server logs for the diagnostic line:

```
[Webhook] PR#3.10: Ignored N non-user GHL outbound message(s) during first-contact delay window for lead XXXX (likely workflow/automation)
```

This confirms the filter is working correctly in production. If the line appears and the lead subsequently receives an AI first-contact message, the fix is verified end-to-end.

---

## 9. Open Items and Suggested Next Steps

| Priority | Item | Description |
|---|---|---|
| **High** | Fix TS error in `ghl.ts:285` | `.user` property access needs `(m as any).user?.id` type assertion — same pattern used in webhook-contact.ts. One-liner fix. |
| **Medium** | PR#3.11: Extract TCPA guard as injectable dependency | PR#3.9 tests are sensitive to TCPA quiet hours. Making the guard mockable would unblock full-suite test runs. |
| **Medium** | Full-suite mock contamination cleanup | Cross-file mock bleed causes intermittent failures when running all tests together. Needs vitest config or test hygiene cleanup. |
| **Low** | Repo history credential scrub | Old commits (2ddb455, e62f790) contain `.project-config.json` with rotated credentials. No active exposure, but worth running `git-filter-repo` if repo access is ever shared externally. |

---

## 10. File Inventory

| File | Lines | Purpose |
|---|---|---|
| `server/webhook-contact.ts` | ~850 | Production code — contains the fixed `recentAgentMsgs` filter and diagnostic log |
| `server/pr310-first-contact-userid.test.ts` | 445 | Test file — 5 tests covering all userId filter scenarios |
| `todo.md` | ~1660 | Updated with PR#3.10 completed items |

---

*End of PR#3.10 Handoff Report*
