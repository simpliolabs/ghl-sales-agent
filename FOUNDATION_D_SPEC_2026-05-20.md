# Foundation D — Multi-Fire Deduplication Spec
**Status:** APPROVED FOR BUILD — 3 required mods applied 2026-05-20  
**Date:** 2026-05-20  
**Author:** Manus (spec from live codebase read)  
**Checkpoint base:** `96183d24`  
**Estimated build time:** 1–2 days  

---

## 1. Problem Statement

The system currently fires multiple outbound AI messages to the same lead within minutes of each other when a single inbound event triggers more than one enqueue path simultaneously. This is called the **multi-fire bug**.

**Confirmed incidents:**
- Adebola (lead `id=1020060`): 3 messages in 3 minutes on 2026-05-18 at ~14:18 UTC
- Vladislav (lead `id=1021619`): 2 messages within 5 minutes
- Kenyetta (lead `id=1020060`): fast_scan + follow_up both enqueued for same inbound

**Root cause:** When an inbound webhook arrives, it triggers:
1. `webhooks.ts` → `enqueueOutbox({ source: 'fast_scan' })` immediately
2. `follow-up-trigger.ts` → `processFollowUpTrigger()` fires on its 10-minute timer and sees the same lead is overdue → `enqueueOutbox({ source: 'follow_up' })`
3. `brain-council-review.ts` → `runBrainCouncilReview()` fires on its own timer and may also enqueue

Each enqueue uses a different `idemKey` (different `triggerSource` string), so the `UNIQUE(leadId, idemKey)` constraint does **not** deduplicate them. All three rows reach `pending` status and the outbox worker processes all three, sending 2–3 messages.

**The existing `makeIdemKey()` dedup is per-path, not per-lead.** It prevents the same path from firing twice within a 5-minute window. It does not prevent two different paths from firing for the same inbound event.

---

## 2. Solution: Compose Lock Table

Introduce a `compose_locks` table that acts as a **per-lead, per-inbound-event mutex**. Before any path enqueues an outbox row in response to an inbound event, it must acquire a compose lock for that lead. If a lock already exists (another path already enqueued for this inbound), the enqueue is silently skipped.

The lock is keyed on `(leadId, inboundEventKey)` where `inboundEventKey` is a hash of the inbound message content + timestamp bucket. This ensures:
- Two paths responding to the **same inbound** → only one enqueues
- Two paths responding to **different inbounds** (lead replied twice) → both enqueue correctly
- Lock expires after 10 minutes → prevents stale locks from blocking legitimate future sends

---

## 3. Schema Migration

### New table: `compose_locks`

```sql
CREATE TABLE compose_locks (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  leadId      INT NOT NULL,
  eventKey    VARCHAR(64) NOT NULL,
  source      VARCHAR(50) NOT NULL,
  lockedAt    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expiresAt   DATETIME(3) NOT NULL,
  UNIQUE KEY uq_compose_lock (leadId, eventKey),
  INDEX idx_compose_expires (expiresAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Column notes:**
- `leadId` — FK to `leads.id` (not enforced at DB level to avoid cascade issues)
- `eventKey` — SHA-256 hash of `leadId + inboundMessage.substring(0,100) + 5-min time bucket` (same bucketing as `makeIdemKey`)
- `source` — which path acquired the lock (`fast_scan`, `follow_up`, `self_review`, `deferred`)
- `expiresAt` — `lockedAt + 10 minutes`

### Drizzle schema addition (`drizzle/schema.ts`)

```ts
export const composeLocks = mysqlTable("compose_locks", {
  id:        bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  leadId:    int("leadId").notNull(),
  eventKey:  varchar("eventKey", { length: 64 }).notNull(),
  source:    varchar("source", { length: 50 }).notNull(),
  lockedAt:  datetime("lockedAt", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  expiresAt: datetime("expiresAt", { fsp: 3 }).notNull(),
}, (t) => ({
  uqLock:    uniqueIndex("uq_compose_lock").on(t.leadId, t.eventKey),
  idxExpiry: index("idx_compose_expires").on(t.expiresAt),
}));

export type ComposeLock = typeof composeLocks.$inferSelect;
```

---

## 4. New Helper: `acquireComposeLock()`

**File:** `server/compose-lock.ts` (new file)

```ts
import crypto from "crypto";
import { getDb } from "./db";
import { composeLocks } from "../drizzle/schema";
import { sql } from "drizzle-orm";

const LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes
const BUCKET_MS  =  5 * 60 * 1000; // 5-minute bucket (matches makeIdemKey)

/**
 * Generate the event key for a given lead + inbound message.
 * Same lead + same message content within the same 5-min window = same key.
 * Different message content (lead replied again) = different key.
 */
export function makeEventKey(leadId: number, inboundMessage: string): string {
  const bucket = Math.floor(Date.now() / BUCKET_MS);
  return crypto
    .createHash("sha256")
    .update(`compose:${leadId}:${inboundMessage.substring(0, 100)}:${bucket}`)
    .digest("hex")
    .slice(0, 64);
}

/**
 * Attempt to acquire a compose lock for a lead + inbound event.
 * Returns true if the lock was acquired (this path should proceed with enqueue).
 * Returns false if another path already holds the lock (skip this enqueue).
 *
 * Uses INSERT IGNORE for atomic acquisition — no SELECT-then-INSERT race condition.
 */
export async function acquireComposeLock(
  leadId: number,
  inboundMessage: string,
  source: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) return true; // Fail open — if DB is down, don't block sends

  const eventKey = makeEventKey(leadId, inboundMessage);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

  // Purge expired locks first (best-effort, non-blocking)
  try {
    await db.execute(sql`DELETE FROM compose_locks WHERE expiresAt < ${now} LIMIT 100`);
  } catch { /* non-fatal */ }

  try {
    // MOD 1: Use affectedRows — one query, no race window, canonical INSERT IGNORE pattern
    const result = await db.execute(sql`
      INSERT IGNORE INTO compose_locks (leadId, eventKey, source, lockedAt, expiresAt)
      VALUES (${leadId}, ${eventKey}, ${source}, ${now}, ${expiresAt})
    `);
    const affectedRows = (result as any).affectedRows ?? (result as any).rowsAffected ?? 0;
    const acquired = affectedRows > 0;

    if (!acquired) {
      console.log(`[ComposeLock] Lead ${leadId}: lock already held, skipping '${source}' enqueue`);
    }
    return acquired;
  } catch (err) {
    console.error(`[ComposeLock] Error acquiring lock for lead ${leadId}:`, err);
    return true; // Fail open
  }
}
```

---

## 5. Exact Wiring Changes

### 5a. `server/webhooks.ts` — fast_scan enqueue path

**Current code (lines 430–445, unified endpoint fast_scan path):**
```ts
const idemKey = makeIdemKey(leadId, `fast_scan:${channel}`);
const { enqueued } = await enqueueOutbox({
  leadId,
  idemKey,
  source: "fast_scan",
  scheduledAt: new Date(),
  payload: { ... }
});
```

**Change:** Add compose lock acquisition before `enqueueOutbox`. The `inboundMessage` passed to `makeEventKey` should be `String(body)` (the normalized message body already in scope at this point).

```ts
// Foundation D: acquire compose lock before enqueue
const { acquireComposeLock } = await import("./compose-lock");
const lockAcquired = await acquireComposeLock(leadId, String(body), "fast_scan");
if (!lockAcquired) {
  console.log(`[Webhook] Compose lock held — skipping fast_scan enqueue for lead ${leadId}`);
  // Do NOT return — still update lastMessageAt and humanTakeover as needed
} else {
  const idemKey = makeIdemKey(leadId, `fast_scan:${channel}`);
  const { enqueued } = await enqueueOutbox({ ... });
}
```

**Lines affected:** ~430–455 (unified endpoint), ~619–637 (legacy message endpoint)  
**Both fast_scan enqueue sites must be patched.**

---

### 5b. `server/follow-up-trigger.ts` — follow_up enqueue path

**Current code (lines 341–366):**
```ts
const idemKey = makeIdemKey(leadId, `followup:${hintChannel}`);
const { enqueued } = await enqueueOutbox({
  leadId,
  idemKey,
  source: "follow_up",
  ...
});
```

**Change:** The follow-up trigger fires on a timer, not in response to a specific inbound. It should check whether a compose lock exists for this lead (meaning a fast_scan or self_review already enqueued for a recent inbound) and skip if so.

```ts
// Foundation D: skip if a compose lock is held for this lead (recent inbound already being processed)
const { acquireComposeLock } = await import("./compose-lock");
// Use empty string as inboundMessage — follow-up has no specific inbound to key on.
// The lock check uses the 5-min bucket, so if fast_scan acquired a lock in this window, we skip.
const lockAcquired = await acquireComposeLock(leadId, "", "follow_up");
if (!lockAcquired) {
  console.log(`[FollowUp] Compose lock held — skipping follow_up enqueue for lead ${leadId}`);
  stats.skipped++;
  continue;
}
const idemKey = makeIdemKey(leadId, `followup:${hintChannel}`);
const { enqueued } = await enqueueOutbox({ ... });
```

**Lines affected:** ~341–366

**Note:** The empty-string `inboundMessage` means the follow-up's event key will NOT match the fast_scan's event key (which uses the actual message body). This is intentional — the follow-up lock check uses a separate key space. The dedup is achieved because `acquireComposeLock` with `""` will succeed (no lock exists for that key), but the `makeIdemKey` dedup on the outbox table will block the duplicate if both paths are running concurrently.

**Revised approach:** Rather than using `acquireComposeLock` in the follow-up path (which has no inbound message), use a **lead-level recency check** instead:

```ts
// Foundation D: skip if lead has a pending/claimed outbox row from fast_scan in last 10 min
const db = await getDb();
const recentFastScan = await db.execute(sql`
  SELECT id FROM outbox
  WHERE leadId = ${leadId}
    AND source = 'fast_scan'
    AND outbox_status IN ('pending', 'claimed')
    AND createdAt > NOW() - INTERVAL 10 MINUTE
  LIMIT 1
`);
const hasPendingFastScan = Array.isArray(recentFastScan[0]) && recentFastScan[0].length > 0;
if (hasPendingFastScan) {
  console.log(`[FollowUp] Pending fast_scan row found — skipping follow_up enqueue for lead ${leadId}`);
  stats.skipped++;
  continue;
}
```

This is simpler, more correct, and doesn't require the compose lock table in the follow-up path.

**Lines affected:** ~337–366 (insert before the `enqueueOutbox` call)

---

### 5c. `server/brain-council-review.ts` — self_review enqueue path

**Current code (self_review enqueue, lines ~380–410):**
The self_review path enqueues a correction message when the Brain Council detects a previous send was suboptimal. It should also check for a pending fast_scan row before enqueuing.

```ts
// Foundation D: skip if a fast_scan or follow_up row is already pending for this lead
const recentActive = await db.execute(sql`
  SELECT id FROM outbox
  WHERE leadId = ${leadId}
    AND source IN ('fast_scan', 'follow_up')
    AND outbox_status IN ('pending', 'claimed')
    AND createdAt > NOW() - INTERVAL 10 MINUTE
  LIMIT 1
`);
if (Array.isArray(recentActive[0]) && recentActive[0].length > 0) {
  console.log(`[SelfReview] Active outbox row found — skipping self_review for lead ${leadId}`);
  continue;
}
```

**Lines affected:** ~380–410 (before the self_review `enqueueOutbox` call)

---

### 5d. `server/deferred-response-processor.ts` — deferred enqueue path

The deferred path already has a guard: it cancels if `humanTakeover=1` or if a human outbound was detected after deferral. Add the same pending-fast_scan check:

```ts
// Foundation D: skip if a fast_scan row is already pending (inbound just arrived)
const recentFastScan = await db.execute(sql`
  SELECT id FROM outbox
  WHERE leadId = ${deferred.leadId}
    AND source = 'fast_scan'
    AND outbox_status IN ('pending', 'claimed')
    AND createdAt > NOW() - INTERVAL 10 MINUTE
  LIMIT 1
`);
if (Array.isArray(recentFastScan[0]) && recentFastScan[0].length > 0) {
  console.log(`[DeferredProcessor] Active fast_scan found — skipping deferred enqueue for lead ${deferred.leadId}`);
  continue;
}
```

---

## 6. PR Strategy

**Option A (recommended): Single PR, one checkpoint**

All four wiring changes + schema migration in one PR. The changes are mechanical and low-risk individually. Shipping them together means one verification cycle instead of four.

**PR structure:**
1. `drizzle/schema.ts` — add `composeLocks` table definition
2. Migration SQL — `CREATE TABLE compose_locks ...`
3. `server/compose-lock.ts` — new file with `acquireComposeLock()` and `makeEventKey()`
4. `server/webhooks.ts` — add compose lock acquisition at both fast_scan enqueue sites (~line 435, ~line 625)
5. `server/follow-up-trigger.ts` — add pending-fast_scan check before enqueue (~line 341)
6. `server/brain-council-review.ts` — add pending-active check before self_review enqueue
7. `server/deferred-response-processor.ts` — add pending-fast_scan check before deferred enqueue
8. `server/outbox-worker.test.ts` — add regression test: "webhook + follow_up for same lead within 5 min → only one outbox row"

**Estimated diff size:** ~120 lines added, ~0 lines deleted.

---

## 7. Verification Protocol

### Step A (immediate post-deploy)

**1. Foundation A regression check:** Run `verifyFoundationA` to confirm Foundation A sentinel still writes.

**2. Foundation D synthetic verification (MOD 2):** Call `verifyFoundationD` endpoint:

```bash
curl -X POST https://ghl.adorbcustomtees.com/api/trpc/verifyFoundationD \
  -H "Content-Type: application/json" \
  -H "Cookie: <valid admin session cookie>" \
  -d '{}'
```

Expected response:
```json
{"success": true, "first_acquired": true, "second_acquired": false, "message": "Compose lock dedup confirmed live"}
```

This proves the lock acquires correctly AND that the dedup blocks the second call in the live customer-facing runtime. Do not declare Foundation D shipped without this response.

### Step B (+1h)
```sql
-- Check for any lead with 2+ outbox rows in the same 10-minute window
SELECT leadId, COUNT(*) as cnt, MIN(createdAt) as first, MAX(createdAt) as last
FROM outbox
WHERE createdAt > NOW() - INTERVAL 24 HOUR
  AND source IN ('fast_scan', 'follow_up', 'self_review')
GROUP BY leadId, FLOOR(UNIX_TIMESTAMP(createdAt) / 600)
HAVING cnt > 1
ORDER BY cnt DESC
LIMIT 20;
```
Expected: 0 rows (no lead has 2+ rows from different sources in the same 10-min window).

### Step C (+24h)
Repeat the Step B query over the full 24h window. Also check:
```sql
-- Confirm compose_locks table is being used
SELECT source, COUNT(*) as cnt FROM compose_locks
WHERE lockedAt > NOW() - INTERVAL 24 HOUR
GROUP BY source;
```
Expected: `fast_scan` lock count > 0 (confirms the lock is being acquired on real traffic).

### Manual verification
After deploy, send a test inbound message to a test lead. Confirm only 1 outbox row is created, not 2–3.

---

## 8. Out of Scope for Foundation D

The following are related but explicitly deferred:

| Item | Reason |
|------|--------|
| `humanTakeover` false positive from appointment webhooks (BC-06) | Foundation B scope — requires send-policy engine |
| `humanTakeover` NOT set when human engaged (BC-07) | Foundation B scope |
| Channel detection race (BC-08) | Foundation B scope |
| Webhook payload poisoning conversation history (BC-11) | Foundation C scope — receive integrity |
| Outbox worker heartbeat / crash recovery (BC-13) | Foundation E scope — outbox resilience |

---

## 9. Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `acquireComposeLock` fails open (DB down) → multi-fire still possible | Low | Fail-open is correct — don't block sends when DB is unavailable |
| Compose lock blocks a legitimate second send (lead replied twice in 5 min) | Low | Event key includes message content — different messages = different keys |
| Pending-fast_scan check blocks follow_up for a lead that fast_scan already processed | Low | Check is `IN ('pending', 'claimed')` — once fast_scan completes (sent/skipped/failed), follow_up proceeds normally |
| Migration fails on production TiDB | Very low | `CREATE TABLE ... IF NOT EXISTS` + `INSERT IGNORE` are both idempotent |
| Bucket-boundary multi-fire (webhooks 1–2 seconds apart spanning a 5-min boundary, e.g. 13:59:59 and 14:00:01) | Very low — webhook duplicates typically arrive within milliseconds of each other, not across minute boundaries | Acceptable for Foundation D. If observed in production, replace fixed-window buckets with sliding-window check (`lockedAt > NOW() - INTERVAL 5 MINUTE`) in a future foundation iteration. This is a known limitation of fixed-window bucketing and is explicitly documented here so it is not a surprise. |

---

## 10. Definition of Done

- [ ] `compose_locks` table created via migration SQL
- [ ] `server/compose-lock.ts` written with `acquireComposeLock()` and `makeEventKey()`
- [ ] `server/webhooks.ts` patched at both fast_scan enqueue sites
- [ ] `server/follow-up-trigger.ts` patched with pending-fast_scan check
- [ ] `server/brain-council-review.ts` patched with pending-active check
- [ ] `server/deferred-response-processor.ts` patched with pending-fast_scan check
- [ ] TypeScript: zero errors (`pnpm tsc --noEmit`)
- [ ] Vitest: regression test added and passing
- [ ] Step A: `verifyFoundationA` sentinel written post-deploy (Foundation A regression)
- [ ] Step A: `verifyFoundationD` returns `{success: true, first_acquired: true, second_acquired: false}` (Foundation D synthetic proof)
- [ ] Step B query returns 0 multi-fire rows
- [ ] Step C query confirms compose_locks table is active
