# outbox.source Taxonomy Investigation — 2026-05-26

**Directive:** Phase 1.B Step 0 investigation. Read-only. No DDL, no code changes, no commits.

---

## Q1 — Actual Production Usage by Source Value

Query run: `SELECT source, COUNT(*), MIN(createdAt), MAX(createdAt), SUM(last_30d), SUM(last_7d) FROM outbox GROUP BY source ORDER BY total_rows DESC`

| source | total (all-time) | last 30d | last 7d | first_seen | last_seen |
|---|---|---|---|---|---|
| `follow_up` | 830 | 830 | 433 | 2026-05-16 | 2026-05-26 |
| `fast_scan` | 112 | 112 | 46 | 2026-05-16 | 2026-05-23 |
| `deferred` | 14 | 14 | 8 | 2026-05-18 | 2026-05-22 |
| `webhook` | 0 | 0 | 0 | — | — |
| `responder` | 0 | 0 | 0 | — | — |
| `manual` | 0 | 0 | 0 | — | — |
| `nurture` | 0 | 0 | 0 | — | — |
| `correction` | 0 | 0 | 0 | — | — |
| `first_contact` | 0 | 0 | 0 | — | — |
| `self_review` | 0 | 0 | 0 | — | — |

**Key finding:** Only 3 of 10 enum values have ever produced a row. The outbox table itself is young (first row: 2026-05-16 — 10 days ago). Total rows: 956 across all time.

---

## Q2 — Code Callsites: Who Passes What to enqueueOutbox?

Five active callsites found. No `enqueueWithDedup` wrapper exists.

| File | Line | source value | Trigger context |
|---|---|---|---|
| `server/follow-up-trigger.ts` | 362 | `"follow_up"` | Scheduled cron — leads where `nextFollowUpAt <= NOW()`, runs every 10 min |
| `server/brain-council-review.ts` | 269 | `"self_review"` | Brain council recovery scan — leads with open issues needing re-evaluation |
| `server/brain-council-review.ts` | 423 | `"fast_scan"` | Fast-scan cron — leads with unreplied inbound messages > 3 min, runs every 3 min |
| `server/deferred-response-processor.ts` | 118 | `"deferred"` | Deferred response processor — agent-first delay window (15 min business hours) |
| `server/routers.ts` | 391 | `"manual"` | Admin UI "Send Now" button — `sendNow` tRPC mutation |

**Critical structural finding:** `server/webhook-message.ts` does **not** call `enqueueOutbox`. Inbound webhook replies are sent **directly** via `attemptSend()` (Foundation A.5), bypassing the outbox entirely. The outbox is used only for scheduled/cron-triggered sends. This is the most important finding for Q5/Q6.

**No higher-level wrapper functions** (e.g., `enqueueFirstContact`, `enqueueFollowUp`) exist. All callsites call `enqueueOutbox()` directly.

---

## Q3 — TriggerSource TypeScript Definition

**Finding:** There is no `TriggerSource` type in the codebase. The TypeScript type for `source` is derived directly from the Drizzle schema:

```typescript
// server/outbox-worker.ts line 89:
source: InsertOutboxRow["source"];

// drizzle/schema.ts line 703:
source: mysqlEnum("source", [
  "webhook", "responder", "follow_up", "manual", "nurture", 
  "correction", "first_contact", "self_review", "fast_scan", "deferred"
]).notNull(),
```

**TypeScript-to-SQL alignment:** PERFECT. The TypeScript type is inferred directly from the Drizzle `mysqlEnum` definition, so it is always in sync with the schema by construction. No drift possible between TS and SQL for this column.

**No `TriggerSource` named type exists** — the spec's use of "TriggerSource" is a spec-level concept, not a production TypeScript type.

---

## Q4 — Dead Enum Value Classification

| Value | DB rows (all-time) | Code refs (source: 'X') | Classification |
|---|---|---|---|
| `follow_up` | 830 | `follow-up-trigger.ts:362` | **LIVE** |
| `fast_scan` | 112 | `brain-council-review.ts:423` | **LIVE** |
| `deferred` | 14 | `deferred-response-processor.ts:118` | **LIVE** |
| `manual` | 0 | `routers.ts:394` | **DORMANT** — code path exists, no rows yet (admin UI feature, not yet used) |
| `self_review` | 0 | `brain-council-review.ts:272` | **DORMANT** — code path exists, no rows yet (brain council recovery, not triggered) |
| `webhook` | 0 | none | **DEAD** — in enum since initial commit, never used in any callsite, never produced a row |
| `responder` | 0 | none | **DEAD** — in enum since initial commit, never used in any callsite, never produced a row |
| `nurture` | 0 | none | **DEAD** — in enum since initial commit, never used in any callsite, never produced a row |
| `correction` | 0 | none | **DEAD** — `correction` appears in `learning-loop.ts` as a knowledge category, not as an outbox source |
| `first_contact` | 0 | none | **DEAD** — `first_contact` appears in `strategist.ts`/`brain-types.ts` as a *strategy approach* label, not as an outbox source. The `pending_first_contacts` table (now removed from schema) was the original first-contact mechanism. |

**Summary:** 3 live, 2 dormant, 5 dead. The 5 dead values were defined in the initial schema commit (`223dcb4`) as anticipated future sources that were never implemented as outbox callsites.

---

## Q5 — Spec ↔ Production Semantic Mapping

| Spec value | Spec semantics | Production equivalent | Match confidence | Rationale |
|---|---|---|---|---|
| `first_contact` | Initial reach-out to a new lead | **NO DIRECT MATCH** | — | New leads are handled by `webhook-message.ts` → `attemptSend()` directly (not via outbox). The outbox `first_contact` enum value was intended for this but was never wired. The `pending_first_contacts` table (removed May 19) was the prior mechanism. |
| `follow_up` | Scheduled follow-up to existing lead | `follow_up` | **HIGH** | Exact semantic match. `follow-up-trigger.ts` cron fires for leads where `nextFollowUpAt <= NOW()`. |
| `inbound` | Reply to a lead's incoming message | **NO DIRECT MATCH** | — | Inbound replies go through `webhook-message.ts` → `attemptSend()` directly, bypassing the outbox. The `webhook` enum value was presumably intended for this but was never wired. |
| `reactivation` | Re-engagement of long-inactive lead | **NO DIRECT MATCH** | — | `reactivation` is a *strategy approach* label in `brain-types.ts` and `strategist.ts`, not an outbox source. The `nurture` enum value was presumably intended for this but was never wired. |

---

## Q6 — Hypothesis Validation

### H1: Spec's `inbound` ≡ production's `webhook`

**Verdict: INCONCLUSIVE (with important nuance)**

The `webhook` enum value was defined in the initial schema as an anticipated source, but **no callsite ever used it**. Inbound webhook replies currently bypass the outbox entirely — `webhook-message.ts` calls `attemptSend()` directly. So `webhook` does not currently represent inbound replies in production; it represents an *intended but never-implemented* outbox path for inbound replies.

The spec's `inbound` concept is semantically correct for what the system *should* do (route inbound replies through the outbox). The production `webhook` value is the closest enum candidate, but it has never been used. If v1.9 routes inbound replies through the outbox (MOV-A), the correct source value could be either `inbound` (new, spec-aligned) or `webhook` (existing, never-used).

### H2: Spec's `reactivation` ≡ production's `nurture`

**Verdict: INCONCLUSIVE (both are dead)**

The `nurture` enum value was defined in the initial schema but has zero rows and zero callsites. No nurture cron or re-engagement trigger was ever built. The spec's `reactivation` concept has no production equivalent. Both `nurture` (production) and `reactivation` (spec) represent the same intended concept — re-engagement of dormant leads — but neither is implemented.

### H3: The 6 non-spec values are dead OR represent finer-grained taxonomy

**Verdict: PARTIALLY CONFIRMED**

- `responder`, `nurture`, `correction`, `webhook`: **DEAD** — zero rows, zero callsites
- `self_review`: **DORMANT** — code path exists (brain council recovery), no rows yet
- `manual`: **DORMANT** — code path exists (admin UI Send Now), no rows yet

The 4 dead values (`responder`, `nurture`, `correction`, `webhook`) were defined in the initial schema as anticipated future sources that were never implemented. They represent planned-but-never-built taxonomy.

---

## Q7 — Synthesis & Recommendation

### The Core Finding

The production outbox is 10 days old and has only 3 active source values: `follow_up`, `fast_scan`, `deferred`. The spec's 4 TriggerSource values (`first_contact`, `follow_up`, `inbound`, `reactivation`) assume the outbox handles all send paths. **It currently does not.** Inbound replies (`inbound`) and new-lead first contacts (`first_contact`) bypass the outbox entirely.

### Recommendation: (b) with modification — DON'T ADD `inbound`/`reactivation` yet; instead, Architect patches spec

**Rationale:**

1. **`inbound`**: The spec assumes inbound replies route through the outbox. They currently don't — `webhook-message.ts` sends directly. If v1.9 Phase 1.B adds `composeAndSendForLead()` as the new outbox path for inbound replies, the correct source value is either `webhook` (reuse existing dead enum value) or `inbound` (new, cleaner name). **Recommendation: reuse `webhook` — it was always intended for this, avoids an ALTER TABLE, and is already in the TypeScript type.**

2. **`reactivation`**: No reactivation cron exists. The spec references `reactivation` in `checkRecentSendCoalesce` bypass logic, but if no code produces `reactivation` rows, the bypass condition is unreachable. **Recommendation: don't add `reactivation` to the enum yet — add it only when the reactivation cron is built (a future phase). For now, Architect patches the spec's coalesce bypass to use `follow_up` for aged leads instead.**

3. **`first_contact`**: Already in the enum (dead). If v1.9 adds a first-contact outbox path, this value is ready to use.

### Summary table for Architect decision

| Spec value | Action | Rationale |
|---|---|---|
| `first_contact` | **No change needed** — already in enum | Reactivate when first-contact outbox path is built |
| `follow_up` | **No change needed** — live and correct | Perfect match |
| `inbound` | **Reuse `webhook`** — don't add new value | `webhook` was always intended for this; avoids ALTER TABLE |
| `reactivation` | **Defer** — add only when reactivation cron is built | No production path produces this value; adding it now is premature |

### Dead value removal

The 4 dead values (`responder`, `nurture`, `correction`, `webhook`) are candidates for removal but **should NOT be removed this turn**. Removing enum values requires an ALTER TABLE and risks breaking any code path that might produce them (including any future code). Document as technical debt; remove in a dedicated cleanup migration after v1.9 is stable.

---

## Closeout

**DDL this turn:** zero  
**Code commits this turn:** zero  
**git log --oneline -3:**
```
9ac2b72 (HEAD -> main, origin/main) Checkpoint: Patch 2 Revised deploy checkpoint...
2dadaf4 Checkpoint: Revised webhook 400 fix...
f0abcc6 Checkpoint: Fixed the root cause of GHL workflow 400 errors...
```
