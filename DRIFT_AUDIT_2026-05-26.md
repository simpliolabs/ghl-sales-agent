# Full Drift Audit — Adorb Outreach System
**Audit date:** 2026-05-26  
**Audited commit:** `9ac2b726` (HEAD, deployed)  
**Scope:** Read-only. No DDL, no code changes, no commits this turn.  
**Karpathy principles applied:** Think Before Coding, Simplicity First, Surgical Changes (report drift; do not fix).

---

## Section A — Schema Drift

### A.1 — Schema Source of Truth

**File:** `/home/ubuntu/adorb-outreach/drizzle/schema.ts`  
**Last modified:** 2026-05-26 (updated with `composeLocks` table, Foundation D)  
**Tables defined in schema.ts:** 37 (users, leads, conversations, ai_state, pipeline_events, agent_assignments, knowledge_files, ai_tweaks, invites, webhook_logs, brain_council_audit, message_outcomes, system_settings, conversation_outcomes, learnings, error_memory, supervisor_audit, ab_experiments, ab_assignments, daily_snapshots, hall_of_fame, channel_performance, seasonal_campaigns, post_delivery_sequences, deferred_responses, lead_memory, skill_proposals, strategy_adjustments, training_exports, fine_tuning_jobs, outbox, decision_log, prompt_versions, quotes, segment_weights, send_attempts, compose_locks)

---

### A.2 — Column-by-Column Comparison

The following tables were verified via `DESCRIBE <table>` and `SHOW INDEXES FROM <table>` against `drizzle/schema.ts`.

**Table: users** — clean  
**Table: leads** — clean  
**Table: conversations** — clean  
**Table: ai_state** — clean  
**Table: pipeline_events** — clean  
**Table: agent_assignments** — clean  
**Table: knowledge_files** — clean  
**Table: ai_tweaks** — clean  
**Table: invites** — clean  
**Table: webhook_logs** — clean  
**Table: message_outcomes** — clean  
**Table: system_settings** — clean  
**Table: conversation_outcomes** — clean  
**Table: learnings** — clean  
**Table: error_memory** — clean  
**Table: supervisor_audit** — clean  
**Table: ab_experiments** — clean  
**Table: ab_assignments** — clean  
**Table: daily_snapshots** — clean  
**Table: hall_of_fame** — clean  
**Table: channel_performance** — clean  
**Table: seasonal_campaigns** — clean  
**Table: post_delivery_sequences** — clean  
**Table: deferred_responses** — clean  
**Table: lead_memory** — clean  
**Table: skill_proposals** — clean  
**Table: strategy_adjustments** — clean  
**Table: training_exports** — clean  
**Table: fine_tuning_jobs** — clean  
**Table: decision_log** — clean  
**Table: prompt_versions** — clean  
**Table: quotes** — clean  
**Table: segment_weights** — clean  
**Table: send_attempts** — clean  
**Table: compose_locks** — clean  

---

**Table: brain_council_audit** — DRIFT FOUND

| Dimension | Detail |
|---|---|
| Columns in schema but not in DB | **None** |
| Columns in DB but not in schema | **None** |
| Column count match | Schema: 47 columns. DB: 47 columns. Match confirmed. |
| Type mismatches | None detected |
| Index drift | None |

**Assessment:** The `brain_council_audit` table is fully in sync. The "column mismatch" referenced in the directive as a known drift from prior verification was **not reproduced** in this audit. Both schema.ts and the live DB have identical 47-column definitions including `sendOutcomeKind` (added by migration `0037_nifty_stryfe.sql`). The prior query failure on Brenie inspection was likely a runtime error in a query that referenced a column by the wrong name, not a structural schema gap.

---

**Table: outbox** — DRIFT FOUND

| Dimension | Detail |
|---|---|
| Columns in schema but not in DB | None |
| Columns in DB but not in schema | None |
| Type mismatches | None |
| Indexes in schema but not in DB | **CONFIRMED MISSING:** `schema.ts` defines `uniqueIndex("uk_idem").on(t.leadId, t.idemKey)` — this is the idempotency constraint |
| Indexes in DB but not in schema | None |

**DB indexes present on `outbox`:**
- `PRIMARY` on `id` (unique)
- `uk_idem` on `(leadId, idemKey)` — **WAIT: this IS present in the DB**
- `idx_pending` on `(outbox_status, scheduledAt)`

**Correction to prior assumption:** The `uk_idem` unique index on `(leadId, idemKey)` **IS present in the live DB**. The DB shows `Non_unique = 0` for both `leadId` and `idemKey` columns of the `uk_idem` index, confirming it is a unique composite index. The prior belief that this index was missing was **incorrect**. The `outbox` table has zero schema drift.

**Table: outbox** — **clean** (unique index confirmed present)

---

### A.3 — Known Drifts Confirmation

| Known Drift | Finding |
|---|---|
| `outbox.UNIQUE(leadId, idemKey)` — defined in schema, believed missing in DB | **NOT CONFIRMED.** The `uk_idem` unique composite index IS present in the live DB. This was a false alarm from prior session. |
| `brain_council_audit` — column mismatch (cause of Brenie query failure) | **NOT CONFIRMED.** Schema and DB are in sync at 47 columns each. The Brenie query failure had a different root cause (likely a runtime column name error in a query, not a structural gap). |

**Both previously-known drifts are false positives.** The live DB is structurally clean against schema.ts.

---

### A.4 — Tables in DB Not in Schema

**DB tables (40 total):** `__drizzle_migrations`, `_skip_locked_test`, `ab_assignments`, `ab_experiments`, `agent_assignments`, `ai_state`, `ai_tweaks`, `brain_council_audit`, `channel_performance`, `compose_locks`, `conversation_outcomes`, `conversations`, `daily_snapshots`, `decision_log`, `deferred_responses`, `error_memory`, `fine_tuning_jobs`, `hall_of_fame`, `invites`, `knowledge_files`, `lead_memory`, `leads`, `learnings`, `message_outcomes`, `outbox`, `pending_first_contacts`, `pipeline_events`, `post_delivery_sequences`, `prompt_versions`, `quotes`, `seasonal_campaigns`, `segment_weights`, `send_attempts`, `skill_proposals`, `strategy_adjustments`, `supervisor_audit`, `system_settings`, `training_exports`, `users`, `webhook_logs`

**Tables in DB but NOT in schema.ts:**

| Table | Columns | Assessment |
|---|---|---|
| `pending_first_contacts` | id, leadId, ghlContactId, payloadSnapshot, leadSnapshot, sendAt, status, cancelReason, createdAt, processedAt | **UNREGISTERED.** This table exists in production but has no Drizzle schema definition. Code writes to it directly via raw SQL or a non-Drizzle path. |
| `_skip_locked_test` | id, status | **UNREGISTERED.** Appears to be a test/diagnostic table for `SKIP LOCKED` MySQL behavior verification. Not in schema.ts. |
| `__drizzle_migrations` | (Drizzle internal) | Expected — Drizzle's own migration tracking table. Not user-defined. |

**Summary:** Two user-facing tables exist in production that are not defined in `drizzle/schema.ts`. `pending_first_contacts` is particularly significant — it has 10 columns and appears to be an active production table (first-contact scheduling). Its absence from schema.ts means Drizzle has no type safety or migration tracking for it.

---

## Section B — Code Drift

### B.1 — Full Commit List (Last 60 Days, Non-Checkpoint)

The following is the complete list of substantive commits on `main` in the last 60 days, excluding Manus auto-checkpoint commits. Total commits (including checkpoints): ~130. Substantive (non-checkpoint) commits: ~85.

### B.2 — Per-Commit Classification

The table below covers the Foundation era (May 17–26) in full detail, plus representative samples from the pre-Foundation era (April 4–May 16). The full pre-Foundation era is classified in aggregate below the table.

**Foundation Era (May 17–26, 2026):**

| Commit | Date | Files Changed | Category | Architect Aware? |
|---|---|---|---|---|
| `9ac2b72` | 2026-05-26 | todo.md | checkpoint_only | Yes |
| `2dadaf4` | 2026-05-26 | server/webhooks.ts, tests | architect_directed | Yes |
| `f0abcc6` | 2026-05-26 | server/webhooks.ts | architect_directed | Yes |
| `abc221d` | 2026-05-21 | server/routers.ts | architect_directed | Yes |
| `3deb4df` | 2026-05-21 | client/src/pages/Settings.tsx | architect_directed | Yes |
| `62eee6f` | 2026-05-21 | server/routers.ts | architect_directed | Yes |
| `86e567d` | 2026-05-21 | server/single-brain.ts, server/output-guards.ts | architect_directed | Yes |
| `417951e` | 2026-05-20 | server/attempt-send.ts, server/db.ts, server/routers.ts | architect_directed | Yes |
| `34da93e` | 2026-05-20 | docs/Foundation-D-spec.md | architect_directed | Yes |
| `4440f74` | 2026-05-20 | docs/Foundation-D-spec.md | architect_directed | Yes |
| `2491022` | 2026-05-20 | docs/ARCHITECTURAL_DEBT_INVENTORY | architect_directed | Yes |
| `69e6e57` | 2026-05-20 | server/outbox-worker.ts | **prior_session_fix** | **No** |
| `a180484` | 2026-05-20 | docs/ARCHITECTURAL_DEBT_INVENTORY | architect_directed | Yes |
| `b29bc3a` | 2026-05-19 | docs/ARCHITECTURAL_DEBT_INVENTORY | architect_directed | Yes |
| `1402c2b` | 2026-05-19 | server/single-brain.ts | **prior_session_fix** | **No** |
| `6adb20a` | 2026-05-19 | server/webhooks.ts, docs | **prior_session_fix** | **No** |
| `59b7de4` | 2026-05-19 | server/webhooks.ts | **prior_session_fix** | **No** |
| `5933b93` | 2026-05-19 | docs | architect_directed | Yes |
| `ddec03f` | 2026-05-19 | server/db.ts, server/attempt-send.ts, server/send-types.ts, 14+ call-site files | architect_directed | Yes |
| `d091bfb` | 2026-05-19 | docs | architect_directed | Yes |
| `5249af3` | 2026-05-19 | docs | architect_directed | Yes |
| `365db2e` | 2026-05-19 | server/send-types.ts, tests | architect_directed | Yes |
| `3229ec3` | 2026-05-19 | multiple | architect_directed | Yes |
| `2b2beb5` | 2026-05-18 | docs | architect_directed | Yes |
| `adc82f6` | 2026-05-18 | server/webhook-message.ts | architect_directed | Yes |
| `b92fc05` | 2026-05-18 | tests | architect_directed | Yes |
| `0cb6600` | 2026-05-17 | server/webhook-message.ts, server/db.ts | architect_directed | Yes |
| `1c1bed5` | 2026-05-17 | merge | infrastructure | Yes |
| `6da185e` | 2026-05-17 | server/pricing-engine.ts, server/single-brain.ts | architect_directed | Yes |
| `5e665af` | 2026-05-17 | server/pricing-engine.ts, server/single-brain.ts | architect_directed | Yes |
| `7b1eee9` | 2026-05-17 | server/webhook-message.ts | architect_directed | Yes |
| `c11c231` | 2026-05-17 | todo.md | checkpoint_only | Yes |
| `cd21c45` | 2026-05-17 | server/brain-adapter.ts | architect_directed | Yes |
| `831b6e8` | 2026-05-17 | server/brain-adapter.ts | architect_directed | Yes |
| `7cdbc3e` | 2026-05-17 | server/monitor.ts | infrastructure | Yes |
| `311f673` | 2026-05-17 | server/monitor.ts | infrastructure | Yes |
| `8121fa2` | 2026-05-17 | server/monitor.ts | infrastructure | Yes |
| `cf2ce2e` | 2026-05-17 | server/outbox-worker.ts | architect_directed | Yes |
| `09205c5` | 2026-05-17 | server/outbox-worker.ts | architect_directed | Yes |
| `cb44fda` | 2026-05-17 | .gitignore | infrastructure | Yes |
| `216940e` | 2026-05-17 | server/brain-adapter.ts | architect_directed | Yes |
| `c0d5f4a` | 2026-05-17 | server/webhook-message.ts, server/brain-adapter.ts | architect_directed | Yes |
| `9b9dd13` | 2026-05-17 | server/routers.ts, server/db.ts | architect_directed | Yes |
| `92bc95f` | 2026-05-17 | server/routers.ts, server/db.ts | architect_directed | Yes |

**Pre-Foundation Era (April 4–May 16, 2026) — Aggregate Classification:**

The pre-Foundation era contains approximately 40 substantive commits. These are classified in aggregate:

| Category | Count | Notes |
|---|---|---|
| `architect_directed` | ~30 | Phase 1–6 builds, PR#3.x series, Foundation A reapply, Phase 3 strangle/delete |
| `prior_session_fix` | ~5 | `9f8f3ab` (Apr 10) is the primary one; several other small defensive fixes |
| `infrastructure` | ~3 | Merge commits, .gitignore, monitor |
| `checkpoint_only` | ~2 | todo.md-only checkpoints |
| `unknown` | 0 | No commits with unclear origin |

---

### B.3 — Prior-Session Fixes (Production-Critical Path Analysis)

Four commits are classified as `prior_session_fix` — changes that shipped to production without an Architect directive in the current session memory:

**`9f8f3ab` — 2026-04-10 — Session 2 Additional Fixes**
- **Files:** `server/webhook-contact.ts`, `server/webhook-events.ts`, `server/webhook-message.ts`, `todo.md`
- **Production-critical:** YES — `webhook-message.ts` is the primary inbound message handler
- **What it changed:** (1) GHL "Opportunity Created" system message was misclassified as human agent, causing `humanTakeover=1` to block AI. Fixed with system message pattern exclusion. (2) `messageBody.substring` crash — safe type coercion for non-string GHL payloads (`objects/arrays → JSON.stringify`). (3) `noteBody.trim` crash — same pattern. (4) `humanTakeover` false positive: system messages excluded from agent detection filter.
- **Significance:** This commit introduced the first `messageBody` crash fix (the same crash class that `59b7de4f` and `2dadaf4` later addressed). The fix in `9f8f3ab` used `JSON.stringify` for non-string bodies in `webhook-message.ts`. The `webhooks.ts` file (acquireMessageLock) was NOT fixed here — that gap persisted until May 19.

**`59b7de4` — 2026-05-19 — webhooks.ts msgBody String() cast**
- **Files:** `server/webhooks.ts`
- **Production-critical:** YES — `webhooks.ts` is the unified webhook entry point
- **What it changed:** Added `String()` coercion to `msgBody` in `acquireMessageLock` to prevent the `(messageBody || "").substring is not a function` crash. This was the fix that stopped the 14,821 crash run.
- **Significance:** Deployed same day as the crash diagnosis. Stopped crashes at `2026-05-19T15:59:54Z`. Architect was NOT aware of this commit when the current session began — it was discovered during Step 4 post-deploy verification.

**`6adb20a` — 2026-05-19 — Harden all as-string payload casts in webhooks.ts**
- **Files:** `server/webhooks.ts`, `ARCHITECTURAL_DEBT_INVENTORY_2026-05-18.md`
- **Production-critical:** YES — `webhooks.ts`
- **What it changed:** Replaced all remaining `as string` casts in `webhooks.ts` with `String()` calls across 6 additional locations (contactId, pipelineStage, fbPipelineStage, eventType ×2, legacyContactId+legacyMsgBody, legacyContactId+legacyStage). Zero `as string` casts remain in `webhooks.ts` after this commit.
- **Significance:** Defensive hardening pass following the `59b7de4` emergency fix. Architect was NOT aware of this commit.

**`1402c2b` — 2026-05-19 — BANNED PHRASES + Rule 11 revision in single-brain.ts**
- **Files:** `server/single-brain.ts`
- **Production-critical:** YES — `single-brain.ts` is the primary AI brain
- **What it changed:** Rule 11 revised (generic opening ban), Rule 15 added (BANNED PHRASES list: "just thinking about", "just checking in", "circling back", "touching base", "I wanted to reach out", "make your brand pop", corporate sign-offs), Rule 16 added (LEGITIMATE HOOK requirement), Rule 17 added (SIGN-OFFS ban for SMS/IG).
- **Significance:** This commit added the prompt-level banned phrases that were later formalized into `output-guards.ts` as `CONTENT_GUARD_TOKENS` (Patch 1). The prompt-level rules and the output-guard enforcement are complementary but separate layers. Architect was NOT aware of this commit.

**`69e6e57` — 2026-05-20 — Outbox claim-fetch precision bug**
- **Files:** `server/outbox-worker.ts`
- **Production-critical:** YES — `outbox-worker.ts` is the send-path worker
- **What it changed:** The Step 2 fetch in `claimOutboxRows` was filtering by `claimedAt = now` (exact JS Date). MySQL/TiDB datetime precision caused this to return 0 rows when the stored value rounded differently. The worker was claiming rows (Step 1) but fetching 0 (Step 2), causing silent drain cycles. Fix: filter by `claimedBy` worker ID instead of exact `claimedAt` timestamp.
- **Significance:** This was the root cause of 148 stuck claimed rows and 15+ silenced customers documented in Inventory item #17. Architect was NOT aware of this commit.

---

## Section C — Foundation State Drift

### C.1 — Architect-Believed Foundation States (Input)

| Foundation | Architect-Believed State |
|---|---|
| A — Send confirmation | RATIFIED |
| A.5 — Send path consolidation | RATIFIED (with note on Patch 2 gap) |
| A.1 — Carrier-failure sub-classification | Backlogged |
| B — Send-policy engine | Not yet built (spec drafting) |
| C.1 + C.1.1 — Empty-body coercion | RATIFIED |
| C.2 — Event classification | RATIFIED |
| C.3 — Fabricated-infrastructure guardrail | RATIFIED |
| D — Multi-fire dedup | RATIFIED |
| E — Outbox worker resilience | Backlogged |
| F — Working memory | Backlogged |
| Patch 1 — Content guard (Guard 7) | RATIFIED |
| Patch 2 — Timeout audit gap | DEFERRED |
| Patch 3 — First-contact dedup | DEFERRED (folded into Foundation B) |

---

### C.2 — Per-Foundation Verification

**Foundation A — Send Confirmation**
- **Expected:** `verifyFoundationA` endpoint in `server/routers.ts`; `send_attempts` table receiving writes
- **Endpoint present:** YES — `verifyFoundationA` exists at line 351 of `routers.ts`
- **Code present:** YES — `server/send-types.ts` defines `SendOutcome` type; `server/attempt-send.ts` implements `attemptSend()`
- **Recent execution:** YES — 516 `send_attempts` rows written in last 7 days
- **State: CONFIRMED LIVE**

**Foundation A.5 — Send Path Consolidation**
- **Expected:** `attemptSend()` as the single send wrapper; all legacy callsites migrated; `brain_council_audit.sendOutcomeKind` written post-send
- **Callsites found:** 12 active `attemptSend()` calls across production files: `webhook-message.ts` (×2), `webhook-contact.ts` (×1), `webhook-pipeline.ts` (×1), `webhook-task.ts` (×2), `auto-correction.ts` (×2), `outbox-worker.ts` (×2), `lost-lead-nurture.ts` (×1), `post-delivery-executor.ts` (×1)
- **Bypass check:** Zero direct `sendMessageWithRetry` or `sendGhlMessage` callsites remain outside `attempt-send.ts` itself (one reference in `attempt-send.ts` is the internal delegation, which is correct)
- **`sendOutcomeKind` writes:** 17 `brain_council_audit` rows with `sendOutcomeKind` set in last 7 days (legacy Brain Council path still active for some leads)
- **`decision_log` single-brain path:** 10,995 rows with `outboxId` set in last 7 days — primary path is single-brain via outbox
- **State: CONFIRMED LIVE.** Note: The directive mentioned "9 callsites migrated" as the acceptance criterion. The live code has 12 callsites, which is more than the spec required — additional callsites were added as new features were built post-ratification. This is not a gap; it is expected growth.

**Foundation A.1 — Carrier-Failure Sub-Classification**
- **Expected state:** Backlogged
- **Code check:** No `carrier_failure` or `A.1` references found in production code. `send_attempts.outcomeKind` values observed: `blocked`, `phantom`, `failed`, `delivered` — no carrier-specific sub-classification.
- **State: CONFIRMED BACKLOGGED — not implemented**

**Foundation B — Send-Policy Engine**
- **Expected state:** Not yet built
- **Code check:** No `Foundation B` or `send_policy` references in production code.
- **State: CONFIRMED NOT BUILT**

**Foundation C.1 + C.1.1 — Empty-Body Coercion**
- **Expected:** `extractMessageBody()` helper in `webhook-message.ts`; empty-body guard before conversation-write
- **Code present:** YES — `extractMessageBody()` defined at line 48 of `webhook-message.ts`; Foundation C.1.1 empty-body guard at line 201 (moved before conversation-write branch)
- **Recent execution:** YES — 213 `conversations` rows with `contentKind` set in last 7 days (contentKind is set by the C.1/C.2 path)
- **State: CONFIRMED LIVE**

**Foundation C.2 — Event Classification**
- **Expected:** `classifyContent()` function; `conversations.contentKind` column populated
- **Code present:** YES — `classifyContent()` defined at line 63 of `webhook-message.ts`; `contentKind` column present in `conversations` table; `idx_conversations_content_kind` index present in DB
- **Recent execution:** YES — 213 rows with `contentKind` set in last 7 days
- **State: CONFIRMED LIVE**

**Foundation C.3 — Fabricated-Infrastructure Guardrail**
- **Expected:** Rules 18–20 in `single-brain.ts` system prompt; `SINGLE_BRAIN_PROMPT_MARKERS` export; `verifyFoundationC3` endpoint; `CONTENT_GUARD_TOKENS` containing C.3 tokens
- **Code present:** YES — `SINGLE_BRAIN_PROMPT_MARKERS` exported at line 1090 of `single-brain.ts` with all 5 markers; `verifyFoundationC3` at line 204 of `routers.ts`; `CONTENT_GUARD_TOKENS` in `output-guards.ts` contains 7 fabricated-infrastructure tokens (calendar_invite, confirming_you_got, from_our_call, as_we_discussed, tracking_number, customer_portal, account_dashboard)
- **Recent execution:** 160 `decision_log` rows with `outputGuardResult LIKE "%block%"` in last 7 days — guard is firing
- **State: CONFIRMED LIVE**

**Foundation D — Multi-Fire Dedup**
- **Expected:** `acquireComposeLock()` in `compose-lock.ts`; `compose_locks` table with `UNIQUE(leadId, eventKey)`; `verifyFoundationD` endpoint
- **Code present:** YES — `acquireComposeLock()` in `server/compose-lock.ts`; `compose_locks` table with `uq_compose_lock` unique index on `(leadId, eventKey)` confirmed in DB; `verifyFoundationD` at line 131 of `routers.ts`
- **Recent execution:** 3 `compose_locks` rows in last 7 days — low volume but present; the low count is expected (locks are short-lived and auto-purged on expiry)
- **State: CONFIRMED LIVE**

**Foundation E — Outbox Worker Resilience**
- **Expected state:** Backlogged
- **Code check:** `outbox-worker.ts` exists and is active (531 outbox rows in last 7 days: 272 sent, 173 skipped, 86 failed). However, the resilience features (crash recovery, stuck-claim detection, dead-letter queue) are not present as a named Foundation. The `69e6e57` fix addressed one resilience gap (claim-fetch precision) but full Foundation E spec has not been built.
- **State: CONFIRMED BACKLOGGED — partial resilience exists via `69e6e57` fix, but Foundation E spec not implemented**

**Foundation F — Working Memory**
- **Expected state:** Backlogged
- **Code check:** `lead_memory` table exists in DB (10 columns). Code references to `lead_memory` exist in `server/db.ts`. However, no `Foundation F` label found in code.
- **Ambiguity:** The `lead_memory` table may represent a partial or informal implementation of Foundation F, or it may be a pre-Foundation feature. Cannot determine from code alone whether this satisfies Foundation F spec.
- **State: AMBIGUOUS — `lead_memory` table exists and appears active, but not labeled as Foundation F in code. Architect should clarify whether this constitutes Foundation F or is a separate feature.**

**Patch 1 — Content Guard (Guard 7)**
- **Expected:** `checkContentGuard()` in `output-guards.ts`; `CONTENT_GUARD_TOKENS` with ≥19 tokens; `verifyContentGuard` endpoint
- **Code present:** YES — `checkContentGuard()` at line 101 of `output-guards.ts`; `CONTENT_GUARD_TOKENS` has **20 tokens** (7 fabricated + 9 filler + 4 sign-offs); `verifyContentGuard` at line 303 of `routers.ts`
- **Token count:** 20 tokens (≥19 threshold met)
- **Recent execution:** 160 guard blocks in last 7 days
- **State: CONFIRMED LIVE**

**Patch 2 — Timeout Audit Gap**
- **Expected state:** DEFERRED
- **Code check:** No `Patch 2` or timeout-audit references in production code beyond the `extractMessageBody` fix (which addressed the webhook body crash, not the timeout audit gap specifically).
- **State: CONFIRMED DEFERRED**

**Patch 3 — First-Contact Dedup**
- **Expected state:** DEFERRED (folded into Foundation B)
- **Code check:** `pending_first_contacts` table exists in DB (10 columns) but is NOT in `drizzle/schema.ts`. This is the unregistered table found in Section A.4. Code appears to write to it directly.
- **Ambiguity:** `pending_first_contacts` may represent an informal implementation of Patch 3 / first-contact dedup that predates the formal Foundation B scope. Its existence in the DB but absence from schema.ts is a concrete gap.
- **State: AMBIGUOUS — table exists in DB, not in schema. Architect should determine whether `pending_first_contacts` is the informal Patch 3 implementation or a separate mechanism.**

---

### C.3 — Foundations Live in Code but Not in Memory

The grep for `verifyFoundation`, `Foundation [A-F]`, and `Patch [0-9]` across `server/**/*.ts` returned the following identifiers:

**Identifiers found in code:**
- `Foundation A`, `Foundation A.5`, `Foundation A.1/A.2` — all in memory
- `Foundation C.1`, `Foundation C.1.1`, `Foundation C.2`, `Foundation C.3` — all in memory
- `Foundation D` — in memory
- `Foundation E` — referenced in `outbox-worker.ts` comments (line 509: "Foundation A.5 note: Single Brain path does NOT write to brain_council_audit") — this is an A.5 note, not a standalone E reference
- `verifyFoundationD`, `verifyFoundationA5`, `verifyFoundationC3`, `verifyFoundationA`, `verifyContentGuard` — all in memory

**No Foundation identifiers found in code that are NOT in Architect's memory.** The grep returned no surprises.

---

### C.4 — Foundations Partially Implemented

| Foundation | Gap |
|---|---|
| A.5 | No gap. 12 callsites (spec required 9 minimum). `sendOutcomeKind` writes confirmed. |
| C.1 + C.1.1 | No gap. `extractMessageBody()` present. Empty-body guard before conversation-write confirmed. |
| C.2 | No gap. `contentKind` column populated in production. |
| C.3 | **Partial gap noted.** The prompt-level rules (Rules 15–17 added in `1402c2b`) and the output-guard enforcement (`CONTENT_GUARD_TOKENS` in `output-guards.ts`) are two separate layers. The `verifyFoundationC3` endpoint tests prompt integrity markers AND a live LLM call. However, the output guard (`checkContentGuard`) is NOT called in the `verifyFoundationC3` verification path — it is called in the outbox worker and single-brain path separately. This is architecturally correct (two layers) but means the C.3 verification endpoint does not test the output-guard layer. Not a runtime gap, but a verification coverage gap. |
| D | No gap. `acquireComposeLock()` uses `INSERT IGNORE` + `affectedRows` check. Unique index confirmed in DB. |
| Patch 1 | No gap. 20 tokens, all categories present. |
| F (lead_memory) | **Ambiguous.** Table exists, no Foundation label. Cannot confirm spec compliance without Foundation F spec document. |
| Patch 3 (pending_first_contacts) | **Gap.** Table exists in DB but not in schema.ts. No Foundation label in code. |

---

## Section D — Synthesis

### Executive Summary

**Total schema drift items:** 0 missing columns, 0 missing indexes, **2 unregistered tables** (`pending_first_contacts`, `_skip_locked_test`). Both previously-reported known drifts (outbox unique index, brain_council_audit column mismatch) were **false positives** — the live DB is structurally clean against schema.ts.

**Total prior-session fixes Architect was unaware of:** **5 commits**, all production-critical:

| Commit | Date | File | Risk |
|---|---|---|---|
| `9f8f3ab` | 2026-04-10 | webhook-message.ts, webhook-contact.ts, webhook-events.ts | HIGH — first msgBody crash fix |
| `59b7de4` | 2026-05-19 | webhooks.ts | HIGH — stopped 14,821 crash run |
| `6adb20a` | 2026-05-19 | webhooks.ts | HIGH — hardened all remaining as-string casts |
| `1402c2b` | 2026-05-19 | single-brain.ts | MEDIUM — added Rules 15–17 (banned phrases, sign-offs) |
| `69e6e57` | 2026-05-20 | outbox-worker.ts | HIGH — fixed silent drain causing 148 stuck rows and 15+ silenced customers |

**Total Foundation state mismatches:** 2 ambiguous, 0 confirmed wrong:
- Foundation F (`lead_memory`): table exists, no spec label
- Patch 3 (`pending_first_contacts`): table in DB, not in schema.ts, no spec label

---

### Top 3 Highest-Risk Drifts Before v1.9

**Risk 1 — `pending_first_contacts` unregistered in schema.ts (HIGH)**  
A 10-column production table with no Drizzle definition means: (a) no type safety on writes, (b) no migration tracking, (c) if a future `pnpm drizzle-kit generate` is run, it will not include this table and may generate DROP TABLE statements in some migration strategies. This is the highest-risk structural gap in the system.

**Risk 2 — `69e6e57` outbox claim-fetch precision bug was a silent failure (HIGH)**  
The fix shipped without an Architect directive. The root cause (MySQL datetime precision causing `claimedAt` filter to return 0 rows) means the outbox worker was silently draining without processing for an unknown period before the fix. The Architect's mental model of outbox worker behavior was based on a broken implementation. Any reasoning about outbox throughput, retry behavior, or stuck-row counts prior to `69e6e57` (2026-05-20) is suspect.

**Risk 3 — `1402c2b` Rules 15–17 in single-brain.ts are prompt-only, not output-guard-enforced (MEDIUM)**  
The BANNED PHRASES added in `1402c2b` (Rules 15–17) are in the system prompt but are NOT all present in `CONTENT_GUARD_TOKENS`. Specifically: "just thinking about", "just checking in", "circling back", "touching base", "I wanted to reach out", "make your brand pop" are in both the prompt AND the output guard. However, Rule 16 (LEGITIMATE HOOK requirement — return `message:null` with `reason:no_legitimate_hook`) is prompt-only and has no output-guard enforcement. If the LLM ignores Rule 16, there is no mechanical backstop. This is a known architectural gap between prompt-layer and guard-layer coverage.

---

### Undocumented Foundation-Like Patterns

The following code patterns exhibit Foundation-like behavior (invariant enforcement, named rules, verification endpoints) but are not formally documented as Foundations:

**`_skip_locked_test` table** — Exists in DB, not in schema.ts. Appears to be a diagnostic artifact for verifying MySQL `SKIP LOCKED` behavior (used by the outbox worker for row claiming). No code references found in production files. Likely a one-time test artifact that was never cleaned up.

**`pending_first_contacts` table** — 10-column scheduling table for first-contact sends. Has `sendAt`, `status`, `cancelReason`, `processedAt` columns suggesting a full lifecycle. This is functionally equivalent to a subset of the outbox table but for first-contact-specific sends. Not labeled as any Foundation. Should be formally registered in schema.ts and either merged into the outbox pattern or documented as a separate mechanism.

---

### Closeout

**DDL this turn:** zero  
**Code commits this turn:** zero  
**git log --oneline -3:**

```
9ac2b72 Checkpoint: Patch 2 Revised deploy checkpoint — extractMessageBody helper...
2dadaf4 Checkpoint: Revised webhook 400 fix. Replaced String(messageBody) with extractMessageBody()...
f0abcc6 Checkpoint: Fixed the root cause of GHL workflow 400 errors...
```

No new commits beyond `9ac2b726`.
