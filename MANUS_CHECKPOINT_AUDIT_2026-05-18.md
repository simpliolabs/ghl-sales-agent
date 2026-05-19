# Manus Checkpoint System Audit — 2026-05-18

**Date:** May 19, 2026  
**Author:** Manus AI  
**Triggered by:** Foundation A1/A2/A2.5 code loss discovered during handoff  
**Severity:** Process integrity failure — production diverged from GitHub audit trail

---

## 1. Production Audit — What Is Actually Live

The production deployment at `ghl.adorbcustomtees.com` runs from the Manus `origin` remote (S3-backed: `s3://vida-prod-gitrepo/webdev-git/310519663494566154/28AChv27iDSNmApuHCcaE5`). The deployed commit is `5249af3`.

### File Existence Check

| File | Exists in Production? | Notes |
|------|----------------------|-------|
| `server/attempt-send.ts` | **NO** | Foundation A1 created this. Lost in squash. |
| `server/send-types.ts` | **YES** | Re-added during PR#3.14 fix (commit `365db2e`) because outbox-worker.ts imported `Channel` type from it. Contains types only — no runtime behavior. |
| `server/foundation-a-attempt-send.test.ts` | **NO** | Foundation A1 test file. Lost in squash. |
| `server/foundation-a25-phantom-divert.test.ts` | **NO** | Foundation A2.5 test file. Lost in squash. |
| `drizzle/0035_send_attempts.sql` | **NO** | Migration file. Lost in squash. |
| `drizzle/0035_sloppy_sebastian_shaw.sql` | **NO** | Drizzle meta. Lost in squash. |

### Database Table Check

| Table | Exists in Production DB? | Rows | Notes |
|-------|-------------------------|------|-------|
| `send_attempts` | **YES** | **0 rows** | Migration 0035 was applied to the DB during the brief window Foundation A1 was deployed. Table exists but is completely unused — no code writes to it. |

### Function Signatures (Verbatim from Production)

**`addConversation` in `server/db.ts` (line 254):**
```typescript
export async function addConversation(data: {
  leadId: number;
  channel?: string;
  direction: "inbound" | "outbound";
  messageBody?: string;
  senderType: "ai" | "human" | "lead";
  senderName?: string;
  ghlMessageId?: string;
  emailMessageId?: string;
}) {
```

This is the **pre-Foundation-A signature**. Single overload. No `outcome` parameter. No type narrowing. No phantom protection. The `senderType: "human"` variant was added by the Earl Wheeler fix (not by Foundation A2).

**`sendMessageWithRetry` in `server/webhook-helpers.ts` (line 215):**
```typescript
export async function sendMessageWithRetry(
  contactId: string,
  opts: Parameters<typeof sendMessage>[1],
  lead: { email?: string | null; phone?: string | null; id: number }
): Promise<{
  success: boolean;
  resolvedContactId: string;
  error?: string;
  errorType?: GhlSendErrorType;
  correctionTaken?: string;
  emailMessageId?: string;
  ghlMessageId?: string;
  isPhantom?: boolean;
}>
```

This is the **pre-Foundation-A signature** with the `isPhantom` field added during PR#3.12 (phantom detection). It does NOT call `attemptSend()`. It does NOT record to `send_attempts`. It does NOT use `SendOutcome` discriminated union for flow control.

**`classifySendOutcome` in `server/webhook-helpers.ts` (line 204):**
```typescript
export function classifySendOutcome(result: unknown): {
  messageId?: string;
  emailMessageId?: string;
  isPhantom: boolean;
}
```

This exists and is used by the split-message logic. It was added during PR#3.12 as a lightweight classifier. It is NOT the Foundation A version (which would return a full `SendOutcome` discriminated union).

### Summary: What Foundation A Delivered vs What's Live

| Foundation A Component | Designed | Live in Production |
|----------------------|----------|-------------------|
| `SendOutcome` discriminated union types | YES | **Types file exists** (send-types.ts) but **no code uses it** |
| `attemptSend()` wrapper function | YES | **NO** — file doesn't exist |
| `recordSendAttempt()` in db.ts | YES | **NO** — function doesn't exist |
| `send_attempts` table | YES | **Table exists (empty)** — no code writes to it |
| Outcome-gated `addConversation` overload | YES | **NO** — single simple signature |
| 15 call-site migrations to outcome-gated | YES | **NO** — all 15 sites use old signature |
| Phantom divert in addConversation | YES | **NO** — no phantom check in addConversation |
| `attemptSend` → auto-correction routing | YES | **NO** — auto-correction.ts unchanged |

**Bottom line:** Foundation A is effectively **0% deployed**. The DB table exists as an empty artifact. The types file exists but nothing imports or uses it at runtime. All behavioral changes from A1, A2, and A2.5 are absent from production.

---

## 2. Process Diagnosis — How the Squash Happened

### The Mechanism

The Manus checkpoint system (`webdev_save_checkpoint`) operates as follows:

1. **`origin` remote** points to an S3-backed git repository: `s3://vida-prod-gitrepo/webdev-git/...`
2. **`github` remote** points to the actual GitHub repository: `github.com/simpliolabs/ghl-sales-agent`
3. **The Manus deploy pipeline deploys from `origin`**, not from `github`.
4. **`webdev_save_checkpoint` commits to `origin`** and creates a deployment from that state.

### The Divergence Timeline

```
Checkpoint 56f475e (pre-Foundation A):
  origin/main → 56f475e
  github/main → 56f475e (aligned)

Foundation A1/A2/A2.5 work (commits 364b1b5 → 86be363):
  These were committed to LOCAL main and pushed to github/main.
  origin/main was NOT updated (no webdev_save_checkpoint was called during Foundation work).
  
Bug fix session starts (Earl Wheeler, D.J.A.Y., Martha Ortiz):
  webdev_save_checkpoint is called → creates commit 9d41858 on origin/main.
  BUT: origin/main's parent was 56f475e (pre-Foundation), not 86be363 (post-Foundation).
  The checkpoint system took a SNAPSHOT of the working directory at that moment.
  
The critical failure:
  The working directory at checkpoint time DID contain Foundation A changes.
  BUT the checkpoint system's commit was based on origin/main's HEAD (56f475e).
  When the checkpoint committed, it created a NEW commit (9d41858) that was a diff
  from 56f475e → current working state.
  
  HOWEVER: between Foundation A being committed to github and the checkpoint being saved,
  I ran `git reset --hard` operations to resolve divergence between origin and github.
  These resets moved HEAD back to origin/main (which was at 56f475e), losing the
  Foundation A commits from the working tree.
  
  The checkpoint then captured the working tree WITHOUT Foundation A code.
```

### Root Cause: Three Compounding Failures

1. **No checkpoint was saved after Foundation A work.** Foundation A1, A2, and A2.5 were committed to `github/main` but `webdev_save_checkpoint` was never called. This meant `origin/main` never received these commits.

2. **`git reset --hard` to resolve divergence.** When origin/main and github/main diverged, I used `git reset --hard` to align them. This moved the working tree back to origin's state (which didn't have Foundation A), destroying the Foundation A changes in the working directory.

3. **The checkpoint system uses `origin` as source of truth, not `github`.** Even though github/main had the correct history (Foundation A → bug fixes → TCPA fix), the deploy pipeline only sees `origin`. Commits that exist only on `github` are invisible to production.

### Remote State (Current)

```
origin  → s3://vida-prod-gitrepo/webdev-git/310519663494566154/28AChv27iDSNmApuHCcaE5
github  → https://github.com/simpliolabs/ghl-sales-agent.git

origin/main  = 5249af3 (deployed to production)
github/main  = 5249af3 (aligned — same commit)
HEAD         = 5249af3 (local)
```

**Currently aligned.** But the Foundation A commits (364b1b5, c449ce5, 86be363) exist as **orphaned commits** in the local git object store. They are NOT reachable from any branch head. They are NOT on origin. They are NOT on github/main's current history (they were force-pushed away).

### Answers to Specific Questions

| Question | Answer |
|----------|--------|
| Did the checkpoint system rebase and drop commits? | **No.** It doesn't rebase. It creates new commits on `origin/main` from the working tree snapshot. Foundation A was never on `origin/main` to begin with. |
| Did it force-push origin to a different state? | **No.** Origin was never updated with Foundation A. The force-push was done by me (the agent) to align github with origin after the divergence was discovered. |
| Did someone explicitly revert these commits? | **No explicit revert.** The `git reset --hard` I performed to resolve divergence had the side effect of removing Foundation A from the working tree. The subsequent checkpoint captured the tree without Foundation A. |
| Does production deploy from origin or github? | **Origin (S3).** The Manus deploy pipeline exclusively uses the `origin` remote. GitHub is a secondary mirror. |
| What happens to commits on github that don't make it to origin? | **They are invisible to production.** They exist in GitHub history but have zero effect on what's deployed. |
| Is there automation silently rewriting history? | **No silent automation.** The issue was manual: I force-pushed github to match origin after discovering divergence, which overwrote github's history (which had Foundation A) with origin's history (which didn't). |

### The Fundamental Process Problem

The workflow has been:

```
1. Write code → commit to local
2. Push to github/main (for audit trail)
3. Eventually call webdev_save_checkpoint (pushes to origin, triggers deploy)
```

The gap between steps 2 and 3 is where Foundation A was lost. If a `git reset --hard` happens in that gap (to resolve divergence), the github-only commits are erased from the working tree and never make it to origin.

---

## 3. What We're Changing to Prevent Recurrence

### Rule 1: `webdev_save_checkpoint` IMMEDIATELY After Every Meaningful Commit

No more "commit to github now, checkpoint later." Every commit that changes production behavior must be followed by `webdev_save_checkpoint` within the same task session. If the checkpoint fails, the commit is not considered deployed.

### Rule 2: NEVER Use `git reset --hard` in This Project

The `webdev_rollback_checkpoint` tool exists for a reason. Using raw `git reset --hard` bypasses the checkpoint system's understanding of state and creates divergence. All history manipulation must go through the Manus tools.

### Rule 3: Treat `origin` as the Source of Truth, Not GitHub

GitHub is a mirror/backup. Production deploys from `origin`. All work must be verified against `origin/main`, not `github/main`. If they diverge, `origin` wins — because that's what's actually running.

### Rule 4: Verify Deployment After Every Checkpoint

After `webdev_save_checkpoint`, verify the deployment succeeded (check the system notification). If deployment fails, the code is NOT live regardless of what the checkpoint says.

### Rule 5: Foundation Work Gets Its Own Checkpoint Per Phase

Foundation A1, A2, A2.5 should each have been a separate checkpoint. This ensures each phase is independently deployable and recoverable. No more "batch multiple foundation phases into one eventual checkpoint."

---

## 4. Foundation A Reapply Decision

### Recommendation: Option Y (Consolidated Reapply)

**Rationale:**
- Cherry-picking (Option X) will conflict on `server/db.ts`, `server/outbox-worker.ts`, `server/webhook-message.ts`, and `server/webhook-helpers.ts` — all of which have been modified by the four bug fixes since Foundation A was written.
- The Foundation A commits were written against a pre-bug-fix codebase. The `addConversation` call sites in outbox-worker.ts have been rewritten (outcome property removed, ghlMessageId added directly).
- A single consolidated commit allows careful merge resolution against the current production state.

**What the reapply must include:**
1. `server/attempt-send.ts` — the `attemptSend()` wrapper (new file)
2. `server/db.ts` — add `recordSendAttempt()` function + outcome-gated `addConversation` overload
3. `drizzle/schema.ts` — add `sendAttempts` table definition (table already exists in DB, schema just needs to match)
4. Drizzle migration meta — update journal to reflect 0035 exists
5. Migrate the outbound call sites to use outcome-gated `addConversation`
6. Foundation A2.5 phantom divert logic in `addConversation`

**What the reapply must NOT touch:**
- channelHint fallback (line 713 outbox-worker.ts) — stays until Foundation B
- 30-min stale-reply limit — stays until Foundation B
- pending_first_contacts table — unrelated
- Safety Net lastAgentActivityAt fix — stays
- IG/FB split-message fix — stays until Foundation C
- 60s processing timeout — stays

**New consideration: human senderType overload**

The Earl Wheeler fix introduced `senderType: "human"` to `addConversation`. Foundation A2's original spec didn't account for this. When reapplying, the human outbound recording should get a **separate explicit overload** with:
- Required `ghlMessageId` (we're observing real GHL messages, not sending)
- A `recorded_from: "ghl_history_sync"` field that distinguishes the source
- Type system still rejects NULL messageIds
- Phantom rows remain impossible

This keeps the Foundation A type safety intact while accommodating the Earl Wheeler fix's new code path.

---

## Appendix: Git Graph (Relevant Section)

```
* 5249af3 (HEAD, origin/main, github/main) docs: update commit refs
* 365db2e fix: resolve TS errors + add send-types + TCPA tests + handoff report
* 3229ec3 PR#3.14: TCPA channelHint + stale-reply + processing timeout
* 9d41858 Three production fixes (Earl Wheeler, D.J.A.Y., Martha Ortiz)
* 56f475e revenueMetrics fix
|
| [ORPHANED — not reachable from any branch]
| * 86be363 Foundation A2.5: phantom divert
| * a56f062 Foundation A2: test assertion update
| * c449ce5 Foundation A2: migrate 15 call sites
| * 34e7725 Foundation A1: drizzle meta
| * 364b1b5 Foundation A1: SendOutcome types + attemptSend + schema
| * 4b38e4b (was: previous checkpoint)
|/
* 2b2beb5 PR#3.12 handoff report
```

The Foundation A commits are orphaned. They exist in the local git object store and can be cherry-picked or inspected, but they are not reachable from any named ref (branch or tag).
