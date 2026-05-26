# Prior-Work Read Report — Adorb Outreach System
**Date:** 2026-05-26  
**Audited commit:** `9ac2b726` (HEAD, deployed)  
**Scope:** Read-only. No DDL, no code changes, no commits this turn.  
**Karpathy principles applied:** Surface unexpected findings; do not reconcile ambiguities; report drift, do not fix it.

---

## Part A — Five Prior-Session Commits

### A.1 — `9f8f3ab` (2026-04-10) — Session 2 Additional Fixes

**Full diff summary:**

Three independent fixes shipped in one commit:

**Fix 1 — `server/webhook-contact.ts` — "Opportunity Created" system message misclassification**

The `handleContactWebhook` path for delayed first-contact was reading GHL conversation history and filtering for recent messages to detect whether a human agent was active. The filter did not exclude GHL system messages (Opportunity Created, workflow triggers, etc.), so these were being counted as human-agent activity and setting `humanTakeover = 1`, blocking AI engagement. The fix added a `SYSTEM_PATTERNS` list and an `isSystemMsg` check:

```diff
+const SYSTEM_PATTERNS = [
+  "opportunity created", "opportunity moved", "opportunity updated",
+  "workflow", "automation", "task created", "task completed",
+  "appointment", "form submitted", "tag added", "tag removed",
+  "note added", "pipeline", "stage changed",
+];
+const isSystemMsg = SYSTEM_PATTERNS.some(p => body.includes(p)) ||
+  body.length < 5 ||
+  (m as any).messageType === "TYPE_ACTIVITY" ||
+  (m as any).contentType === "activity";
+if (isSystemMsg) return false;
```

**Fix 2 — `server/webhook-events.ts` — `noteBody.trim()` crash**

The note webhook was casting `payload.noteBody` as string with `as string`, which does not coerce at runtime. If GHL sent a non-string note body, `.trim()` would throw. Fix: safe coercion pattern:

```diff
-const noteBody = (payload.noteBody || payload.body || payload.note || "") as string;
+const rawNote = payload.noteBody ?? payload.body ?? payload.note ?? "";
+const noteBody = typeof rawNote === "string" ? rawNote : (typeof rawNote === "object" ? JSON.stringify(rawNote) : String(rawNote));
```

**Fix 3 — `server/webhook-message.ts` — `messageBody.substring` crash (first instance)**

Same pattern as the noteBody fix, applied to the message body in `handleMessageWebhook`:

```diff
-const messageBody = (payload.body || payload.message) as string;
+const rawBody = payload.body ?? payload.message ?? "";
+const messageBody = typeof rawBody === "string" ? rawBody : (typeof rawBody === "object" ? JSON.stringify(rawBody) : String(rawBody));
```

**Architect-facing summary:** This commit fixed the same crash class that `59b7de4f` later addressed in `webhooks.ts`. The fix in `9f8f3ab` was applied to `webhook-message.ts` (the downstream handler) but NOT to `webhooks.ts` (the upstream entry point where `acquireMessageLock` calls `.substring()`). That gap persisted from April 10 to May 19 — 39 days — and was responsible for 14,821 errors.

**Cross-check note for v1.9 / Foundation B:** The `SYSTEM_PATTERNS` list in `webhook-contact.ts` (Fix 1) is a prompt-level exclusion list for human-agent detection. Foundation B's send-policy engine will need to be aware of this list if it re-implements or extends the human-agent detection logic. The list is not in a shared constant — it is inline in `webhook-contact.ts` line ~306.

---

### A.2 — `59b7de4` (2026-05-19) — webhooks.ts msgBody String() cast

**Full diff:**

```diff
-const msgBody = (payload.body || payload.message || "") as string;
+const msgBody = String(payload.body ?? payload.message ?? "");
```

One line changed in `server/webhooks.ts`, in the `case "message":` branch of the main webhook router. This is the `acquireMessageLock(contactId, msgBody)` callsite — `msgBody` is passed directly to `.substring()` inside `acquireMessageLock`. The `as string` cast was a TypeScript lie; `String()` is the correct runtime coercion.

**Architect-facing summary:** This single-line fix stopped the 14,821-error crash run at `2026-05-19T15:59:54Z`. The fix used `String()` — a blunt coercion that produces `"[object Object]"` for objects. The `2dadaf4` commit later replaced this with `extractMessageBody()` (field-priority lookup), which is the production-quality version now deployed.

**Cross-check note for v1.9 / Foundation B:** No overlap. The `webhooks.ts` entry point is upstream of Foundation B's send-policy scope. This fix is complete and superseded by `2dadaf4`.

---

### A.3 — `6adb20a` (2026-05-19) — Harden all as-string payload casts in webhooks.ts

**Full diff — 8 locations changed in `server/webhooks.ts`:**

| Location | Before | After |
|---|---|---|
| `contactId` (main router) | `(payload.contactId \|\| payload.id \|\| "") as string` | `String(payload.contactId ?? payload.id ?? "")` |
| `pipelineStage` (pipeline case) | `(payload.currentStage \|\| ...) as string` | `String(payload.currentStage ?? ...)` |
| `fbPipelineStage` (fallback pipeline) | `(payload.currentStage \|\| ...) as string` | `String(payload.currentStage ?? ...)` |
| `eventType` (addWebhookLog success path) | `(payload.type \|\| payload.event \|\| "unknown") as string` | `String(payload.type ?? payload.event ?? "unknown")` |
| `eventType` (addWebhookLog error path) | `(payload?.type \|\| payload?.event \|\| "unknown") as string` | `String(payload?.type ?? payload?.event ?? "unknown")` |
| `legacyContactId` (legacy message route) | `(legacyPayload.contactId \|\| ...) as string` | `String(legacyPayload.contactId ?? ...)` |
| `legacyMsgBody` (legacy message route) | `(legacyPayload.body \|\| ...) as string` | `String(legacyPayload.body ?? ...)` |
| `legacyContactId` + `legacyStage` (legacy pipeline route) | `as string` casts | `String()` conversions |

The commit also added `ARCHITECTURAL_DEBT_INVENTORY_2026-05-18.md` Section 4 documenting the full as-string audit with risk classification and noting that remaining files (`webhook-message.ts`, `webhook-contact.ts`, etc.) were "staged for Foundation B receive-side hardening."

**Architect-facing summary:** After the emergency `59b7de4f` fix, this commit completed the hardening pass for `webhooks.ts` specifically. It did NOT touch `webhook-message.ts`, `webhook-contact.ts`, or other downstream handlers — those were deferred to Foundation B per the inventory note.

**Cross-check note for v1.9 / Foundation B:** The inventory note in this commit explicitly scoped remaining `as string` casts in other files to Foundation B. This means Foundation B's receive-side hardening spec should enumerate which files still have uncoerced casts. The inventory document (`ARCHITECTURAL_DEBT_INVENTORY_2026-05-18.md`) is the source of truth for that list.

---

### A.4 — `1402c2b` (2026-05-19) — BANNED PHRASES + Rule 11 revision

**Full diff — `server/single-brain.ts` only:**

Rule 11 was revised from a narrow "just following up" ban to a broad generic-opening ban. Rules 15, 16, 17 were added.

**Verbatim current text of Rules 15, 16, 17 as they live in `single-brain.ts` today (lines 441–459):**

> **Rule 15 (lines 441–451):**
> ```
> 15. BANNED PHRASES — these phrases are FORBIDDEN in every outbound message. If your composed message contains any of them, REWRITE it before sending. The principle: no corporate filler, no manufactured intimacy.
>     - "just thinking about"
>     - "just checking in"
>     - "circling back"
>     - "touching base"
>     - "I wanted to reach out"
>     - "make your brand pop"
>     - "make your [anything] pop"
>     - "elevate your brand"
>     - "take your [anything] to the next level"
>     - Any corporate sign-off ("Thanks, ADORB CUSTOM PRINTING", "Best regards", "Warm regards", etc.) — SMS and IG are conversational, not formal
> ```

> **Rule 16 (lines 452–458):**
> ```
> 16. EVERY OUTBOUND MUST HAVE A LEGITIMATE HOOK. Before composing, ask: "Why am I sending this message TODAY, specifically?" Valid hooks:
>     - A new piece of information (relevant case study, pricing change, seasonal trigger)
>     - A specific question that requires a yes/no/short answer
>     - An offer with a clear ask
>     - A reference to something the lead said before that has new context now
>     If you cannot identify a valid hook, return message: null with reason: "no_legitimate_hook".
>     INVALID hooks (these are NOT reasons to send): "It's been a while", "Haven't heard back", "Just wanted to follow up", general product reminders with no specificity, any opening that could apply to any lead in the database.
> ```

> **Rule 17 (line 459):**
> ```
> 17. SIGN-OFFS — SMS and Instagram messages NEVER include a sign-off. Email may include a brief sign-off ONLY with the agent's first name in normal case ("— Mike"). NEVER use ALL CAPS company name as sign-off.
> ```

**Architect-facing summary:** Rules 15 and 17 are partially mirrored in `output-guards.ts` `CONTENT_GUARD_TOKENS` (the Patch 1 output guard). Rule 16 (LEGITIMATE HOOK) is **prompt-only** — there is no mechanical output-guard enforcement for it. If the LLM ignores Rule 16 and composes a message without a legitimate hook, nothing in the output-guard layer will catch it.

**Cross-check note for Foundation B banned-phrase reconciliation:**

The prompt-layer banned phrases (Rule 15) and the output-guard tokens (`CONTENT_GUARD_TOKENS`) are not identical. Comparison:

| Phrase | In Rule 15 prompt | In CONTENT_GUARD_TOKENS |
|---|---|---|
| "just thinking about" | Yes | Yes |
| "just checking in" | Yes | Yes |
| "circling back" | Yes | Yes |
| "touching base" | Yes | Yes |
| "I wanted to reach out" | Yes | Yes |
| "make your brand pop" | Yes | Yes |
| "make your [anything] pop" | Yes | No (only exact "make your brand pop") |
| "elevate your brand" | Yes | Yes |
| "take your [anything] to the next level" | Yes | No (no equivalent in guard) |
| Corporate sign-offs (general) | Yes (Rule 15 + 17) | Yes (4 specific tokens: "thanks, adorb custom printing", "thanks, adorb", "best regards", "warm regards") |

**Gap:** "make your [anything] pop" and "take your [anything] to the next level" are in the prompt but not in the output guard. These are pattern-based bans that would require regex matching in the guard — the current guard uses exact substring matching. Foundation B should decide whether to add regex-capable guard entries or accept prompt-only coverage for these two patterns.

---

### A.5 — `69e6e57` (2026-05-20) — Outbox claim-fetch precision bug

**Full diff:**

```diff
-// Step 2: Fetch what we just claimed (rows where claimedBy = workerId AND claimedAt = now).
+// Step 2: Fetch what we just claimed (rows where claimedBy = workerId AND status = claimed).
+// NOTE: Do NOT filter by claimedAt = now — MySQL/TiDB datetime precision can cause the exact
+// timestamp match to return 0 rows if the stored value rounds differently from the JS Date.
+// The claimedBy worker ID is the correct discriminator.
 const fetchResult = await db.execute(sql`
   SELECT * FROM outbox
   WHERE claimedBy = ${workerId}
-    AND claimedAt = ${now}
     AND outbox_status = 'claimed'
   ORDER BY scheduledAt ASC
+  LIMIT ${limit * 2}
 `);
```

**Current full `claimOutboxRows` function (lines 127–181 of `outbox-worker.ts`):**

```typescript
async function claimOutboxRows(workerId: string, limit: number): Promise<OutboxRow[]> {
  const db = await getDb();
  if (!db) return [];

  const now = new Date();
  const expiry = new Date(now.getTime() - CLAIM_EXPIRY_MS);

  try {
    // Step 1a: Atomic claim of PENDING rows.
    await db.execute(sql`
      UPDATE outbox
      SET outbox_status = 'claimed', claimedBy = ${workerId}, claimedAt = ${now}
      WHERE outbox_status = 'pending'
        AND scheduledAt <= ${now}
      ORDER BY scheduledAt ASC
      LIMIT ${limit}
    `);

    // Step 1b: Reclaim expired claimed rows (worker crash / previous drain died mid-flight).
    await db.execute(sql`
      UPDATE outbox
      SET outbox_status = 'claimed', claimedBy = ${workerId}, claimedAt = ${now}
      WHERE outbox_status = 'claimed'
        AND claimedAt < ${expiry}
      ORDER BY scheduledAt ASC
      LIMIT ${limit}
    `);

    // Step 2: Fetch what we just claimed (rows where claimedBy = workerId AND status = claimed).
    // NOTE: Do NOT filter by claimedAt = now — MySQL/TiDB datetime precision can cause the exact
    // timestamp match to return 0 rows if the stored value rounds differently from the JS Date.
    const fetchResult = await db.execute(sql`
      SELECT * FROM outbox
      WHERE claimedBy = ${workerId}
        AND outbox_status = 'claimed'
      ORDER BY scheduledAt ASC
      LIMIT ${limit * 2}
    `);
    const fetchData = Array.isArray(fetchResult) && Array.isArray(fetchResult[0]) ? fetchResult[0] : [];
    const claimed = fetchData as unknown as OutboxRow[];

    if (claimed.length > 0) {
      console.log(`[Outbox] Claimed ${claimed.length} row(s) by ${workerId}`);
    }
    return claimed;
  } catch (err) {
    console.error(`[Outbox] Claim error:`, err);
    return [];
  }
}
```

**Architect-facing summary:** The fix is correct and minimal. However, a new behavioral implication was introduced: Step 2 now fetches `LIMIT ${limit * 2}` instead of `LIMIT ${limit}`. This means a single worker can fetch up to `2 * CLAIM_BATCH_SIZE` rows in one cycle if the Step 1b reclaim path picks up expired rows from a prior crashed worker in addition to the Step 1a fresh claim. This is intentional (the comment says "limit * 2 to account for reclaim rows") but means the worker can process more rows per cycle than `CLAIM_BATCH_SIZE` alone would suggest.

**Cross-check note for v1.9 / Foundation B:** Foundation B's send-policy engine will need to be aware that the outbox worker processes up to `2 * CLAIM_BATCH_SIZE` rows per cycle, not just `CLAIM_BATCH_SIZE`. If Foundation B introduces per-lead send-rate limits enforced at the worker level, the effective batch size is `2 * CLAIM_BATCH_SIZE`.

---

## Part B — `pending_first_contacts` Implementation

### B.1 — Schema

```sql
CREATE TABLE `pending_first_contacts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `leadId` int NOT NULL,
  `ghlContactId` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `payloadSnapshot` json DEFAULT NULL,
  `leadSnapshot` json DEFAULT NULL,
  `sendAt` timestamp NOT NULL,
  `status` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `cancelReason` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `processedAt` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci AUTO_INCREMENT=30001
```

**Indexes:** PRIMARY on `id` only. No index on `leadId`, `status`, or `sendAt`.

**Notable:** `AUTO_INCREMENT=30001` — the table was created with a starting auto-increment of 30001, not 1. This is unusual and suggests the table was either pre-seeded or the auto-increment was manually set. Only 1 row has ever been inserted (all-time total = 1, `lastRow = 2026-05-19T01:21:40Z`).

### B.2 — Code That Writes To or Reads From the Table

**Finding: No production code currently references `pending_first_contacts`.**

The grep of `server/**/*.ts` for `pending_first_contacts`, `pendingFirstContacts`, `insertPendingFirstContact`, `getPendingFirstContacts`, `processPendingFirstContacts`, and `hasPendingFirstContact` returned **zero results**.

The table was created by commit `9ca702a` (2026-05-17), which added:
- `pendingFirstContacts` table definition to `drizzle/schema.ts`
- `insertPendingFirstContact()`, `getPendingFirstContacts()`, `updatePendingFirstContactStatus()`, `hasPendingFirstContact()` helper functions to `server/db.ts`
- `processPendingFirstContacts()` function to `server/deferred-response-processor.ts`
- A cron call in `server/_core/index.ts` to run `processPendingFirstContacts()` every 2 minutes

Commit `ddec03f` (2026-05-19, Foundation A consolidated reapply) **removed the `pendingFirstContacts` table definition from `drizzle/schema.ts`**. This was confirmed by `git diff 9ca702a ddec03f -- drizzle/schema.ts` showing the full table definition removed.

The db.ts helper functions and deferred-response-processor.ts code were also removed (confirmed by grep returning zero results for all function names). The cron call in `_core/index.ts` was also removed.

**The table exists in the DB (with 1 row, last written 2026-05-19T01:21:40Z) but the entire implementation was stripped from the codebase by `ddec03f`.**

### B.3 — Full Code of Relevant Functions

**Not applicable.** No functions currently touch this table. The implementation was removed by `ddec03f`. The 1 row in the DB is a fossil from the 2026-05-17 implementation window.

### B.4 — Recent Activity

| Metric | Value |
|---|---|
| Rows in last 7 days | 0 |
| Cancel reasons in last 7 days | 0 |
| All-time total rows | 1 |
| Last row created | 2026-05-19T01:21:40Z |

**The table is completely dormant.** The single row was written during the brief window when the implementation was live (2026-05-17 to 2026-05-19). After `ddec03f` removed the code, no further writes have occurred.

### B.5 — Cross-Check: What Is `pending_first_contacts` Relative to v1.9 §4.6?

**Manus's read: (c) — `pending_first_contacts` implements an older/partial pattern that was intentionally removed. v1.9 §4.6 supersedes it.**

Evidence:
- The table was created as a crash-survival mechanism for the in-memory `setTimeout` first-contact delay (45-second window). It was a persistence layer for a specific race condition (server restart during the delay window).
- It was removed by `ddec03f` (Foundation A consolidated reapply) — the commit that rebuilt the entire send path through `attemptSend()` and the outbox. The outbox pattern (`enqueueOutbox()` with `scheduledAt = now + 45s`) supersedes the `pending_first_contacts` mechanism entirely.
- The ARCHITECTURAL_DEBT_INVENTORY note confirms: "The `pending_first_contacts` table has only 1 row ever, confirming the first-contact-via-table path is essentially unused."
- The table exists in the DB as a fossil. The DB table was not dropped when the code was removed (likely because there was no migration to drop it, and dropping a table requires a migration).

**Implication for v1.9 §4.6:** v1.9 §4.6 should NOT reference `pending_first_contacts`. The first-contact scheduling mechanism is now the outbox (`enqueueOutbox()` with `scheduledAt`). The `pending_first_contacts` table is dead infrastructure. The Architect should decide whether to formally drop it (DDL) or leave it as a harmless fossil.

**FLAG:** The `pending_first_contacts` table has `AUTO_INCREMENT=30001`. This is anomalous for a table with 1 row. It suggests either (a) the auto-increment was manually set to a high value to avoid ID collisions with a prior version of the table, or (b) TiDB/MySQL auto-increment behavior caused the counter to jump. This is not a risk but is worth noting.

---

## Part C — Foundation D `compose_locks` Implementation

### C.1 — Schema

```sql
CREATE TABLE `compose_locks` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `leadId` int NOT NULL,
  `eventKey` varchar(64) NOT NULL,
  `source` varchar(50) NOT NULL,
  `lockedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_compose_lock` (`leadId`,`eventKey`),
  KEY `idx_compose_expires` (`expiresAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin AUTO_INCREMENT=11283873
```

**Indexes:**
- `PRIMARY` on `id` (unique)
- `uq_compose_lock` on `(leadId, eventKey)` — the dedup constraint
- `idx_compose_expires` on `expiresAt` — for the purge query

**Notable:** `AUTO_INCREMENT=11283873`. This is a very high counter for a table with only 3 rows ever written (all from vitest). TiDB uses a pre-allocated auto-increment range per node — the counter reflects allocated IDs, not actual rows. This is normal TiDB behavior and is not a concern.

### C.2 — Code References

| File | Line | Description |
|---|---|---|
| `server/compose-lock.ts` | 50 | `acquireComposeLock()` — the lock acquisition function (full implementation) |
| `server/compose-lock.ts` | 64 | `DELETE FROM compose_locks WHERE expiresAt < now LIMIT 100` — purge expired locks |
| `server/compose-lock.ts` | 72 | `INSERT IGNORE INTO compose_locks ...` — atomic lock acquisition |
| `server/brain-council-review.ts` | 28 | `import { acquireComposeLock }` |
| `server/brain-council-review.ts` | 417 | `acquireComposeLock(row.leadId, row.lastInbound ?? "", "fast_scan")` — only production callsite |
| `server/routers.ts` | 43 | `import { acquireComposeLock }` |
| `server/routers.ts` | 140–142 | `verifyFoundationD` endpoint — test-only, deletes and re-acquires locks for verification |

### C.3 — Full `acquireComposeLock` Implementation

```typescript
// LOCK_TTL_MS = 10 minutes
// BUCKET_MS = 5 minutes (eventKey bucket)

export function makeEventKey(leadId: number, inboundMessage: string): string {
  const bucket = Math.floor(Date.now() / BUCKET_MS);
  return crypto
    .createHash("sha256")
    .update(`compose:${leadId}:${inboundMessage.substring(0, 100)}:${bucket}`)
    .digest("hex")
    .slice(0, 64);
}

export async function acquireComposeLock(
  leadId: number,
  inboundMessage: string,
  source: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) return true; // Fail open

  const eventKey = makeEventKey(leadId, inboundMessage);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

  // Purge expired locks (best-effort, non-blocking)
  try {
    await db.execute(sql`DELETE FROM compose_locks WHERE expiresAt < ${now} LIMIT 100`);
  } catch { /* non-fatal */ }

  try {
    const result = await db.execute(sql`
      INSERT IGNORE INTO compose_locks (leadId, eventKey, source, lockedAt, expiresAt)
      VALUES (${leadId}, ${eventKey}, ${source}, ${now}, ${expiresAt})
    `);
    const affectedRows = (result as any)[0]?.affectedRows ?? (result as any).affectedRows ?? (result as any).rowsAffected ?? 0;
    return affectedRows > 0;
  } catch (err) {
    console.error(`[ComposeLock] Error acquiring lock for lead ${leadId}:`, err);
    return true; // Fail open
  }
}
```

**Key behavioral properties:**
- **Acquisition mechanism:** `INSERT IGNORE` + `affectedRows` check. Atomic — no SELECT-then-INSERT race condition.
- **eventKey construction:** SHA-256 of `compose:{leadId}:{inboundMessage[:100]}:{5-min-bucket}`. Same lead + same message content within the same 5-minute window = same key.
- **Heartbeat mechanism:** None. The lock is a one-shot TTL (10 minutes). There is no heartbeat to extend it.
- **Release path:** None explicit. Locks expire after 10 minutes and are purged by the `DELETE ... WHERE expiresAt < now` call on the next `acquireComposeLock` invocation.
- **Stale lock cleanup:** Purge-on-acquire pattern — each call to `acquireComposeLock` deletes up to 100 expired locks before attempting the insert. No background cleanup job.
- **Fail-open:** If DB is unavailable, returns `true` (proceed with send). This prevents DB outages from silencing customers.

### C.4 — Recent Activity

| Metric | Value |
|---|---|
| Total locks (last 7 days) | 3 |
| Distinct leads | 1 |
| Distinct event keys | 3 |
| Sources | `vitest` only |
| All-time total | 3 |
| First lock | 2026-05-26T14:00:00.071Z |
| Last lock | 2026-05-26T14:01:09.106Z |

**The `compose_locks` table has NEVER been written to by production code.** All 3 rows are from the `verifyFoundationD` vitest test run on 2026-05-26 (today, during the Patch 2 deploy verification). The `fast_scan` source (the only production callsite in `brain-council-review.ts`) has zero rows in the table.

### C.5 — Cross-Check: `compose_locks` vs v1.9 `lead_compose_lock`

**Manus's read: (b) — Complementary, different concerns, but with a significant gap.**

The two mechanisms address different granularities:

| Dimension | `compose_locks` (Foundation D, live) | `lead_compose_lock` (v1.9 spec) |
|---|---|---|
| Key | `(leadId, eventKey)` — per-event | `leadId` only — per-lead |
| Purpose | Prevent multi-fire from concurrent webhook deliveries of the SAME event | Prevent concurrent composition for ANY event for the same lead |
| TTL | 10 minutes | Heartbeat-based (alive while composing) |
| Release | Expiry only | Explicit release on completion |
| Scope | Only `fast_scan` path (brain-council-review.ts) | Would cover all compose paths |

**The gap:** `compose_locks` is only called from `brain-council-review.ts` (the `fast_scan` path). It is NOT called from:
- `webhook-message.ts` (the primary inbound message handler)
- `outbox-worker.ts` (the send-path worker)
- `lost-lead-nurture.ts`, `post-delivery-executor.ts`, or any other enqueue path

This means Foundation D's multi-fire dedup only protects the `fast_scan` path. The primary `webhook-message.ts` → outbox enqueue path has no compose lock. The outbox's `UNIQUE(leadId, idemKey)` constraint provides a different kind of dedup (idempotency on the enqueue side) but does not prevent two different `idemKey` values from being enqueued for the same lead from the same inbound event.

**FLAG:** The drift audit reported Foundation D as "CONFIRMED LIVE" with 3 compose_locks rows in the last 7 days. Those 3 rows are vitest rows, not production rows. The `fast_scan` source has zero production rows. This means Foundation D's compose lock has never fired in production. The mechanism is correctly implemented but is not being exercised by real traffic.

**Implication for v1.9 `lead_compose_lock`:** v1.9's `lead_compose_lock` (per-lead, heartbeat-based) is NOT redundant with `compose_locks` (per-event, TTL-based). They address different concerns. Whether both are needed depends on whether the Architect wants per-lead serialization (one compose at a time per lead, regardless of event) or per-event dedup (same event can't fire twice). The current `compose_locks` provides the latter. v1.9's `lead_compose_lock` would provide the former.

---

## Closeout

**DDL this turn:** zero  
**Code commits this turn:** zero  
**git log --oneline -3:**

```
9ac2b72 Checkpoint: Patch 2 Revised deploy checkpoint — extractMessageBody helper...
2dadaf4 Checkpoint: Revised webhook 400 fix. Replaced String(messageBody) with extractMessageBody()...
f0abcc6 Checkpoint: Fixed the root cause of GHL workflow 400 errors...
```

No new commits beyond `9ac2b726`.
