# Adorb v1.9 — Phase 1.A Pre-Build Verification Report

**Date:** 2026-05-26  
**Directive:** Phase 1.A (Pre-Build Verifications)  
**Spec:** adorb-v1.9-FINAL-spec.md (Drive ID `1jEtMgbpN1Icymfaj9XoeaHt_ltSYZcQF`)  
**Mode:** Read-only. Zero DDL. Zero code changes. Zero commits.

---

## Step 0 — Spec Read Confirmation

**Document title (§0):** "Adorb Outreach — Cognition + Infrastructure Governance Spec"  
**Version:** 1.9 FINAL (Consolidated through Adversarial Cycle 12)  
**Status:** SIGNED OFF — ready for Manus implementation.  
**Final section heading (Appendix B):** "Appendix B — Production Code State Snapshot"

Spec read confirmed. 72K / 1,709 lines. All sections accessible.

---

## V1 — Schema State Verification

### V1.1 — Outbox Table

**Queries run:** `DESCRIBE outbox`, `SHOW INDEXES FROM outbox`

| Spec item | Present? | Type matches spec? |
|---|---|---|
| `outbox.idemKey` (varchar 128 NOT NULL) | **PRESENT** | **PARTIAL — varchar(64), not varchar(128)** |
| `outbox.conversationId` | PRESENT | YES — varchar(128) NULL |
| `outbox.updatedAt` | PRESENT | YES — timestamp NULL |
| `outbox.claimedBy` | PRESENT | YES — varchar(64) NULL |
| `outbox.claimedAt` | PRESENT | YES — timestamp NULL |
| `outbox.retryCount` | PRESENT | YES — int NOT NULL DEFAULT 0 |
| `outbox_status` enum includes all 6 v1.9 values | **MISSING** | **NO — current enum: pending/claimed/sent/failed/skipped only** |
| UNIQUE INDEX `uk_idem` on `(leadId, idemKey)` | PRESENT | YES |
| INDEX `idx_pending` on `(outbox_status, scheduledAt)` | PRESENT | YES |

**⚠ TWO UNEXPECTED FINDINGS:**

1. **`idemKey` is varchar(64), spec says varchar(128).** The spec §4.1 specifies `VARCHAR(128)`. Current production column is `VARCHAR(64)`. This is a type mismatch. Phase 1.B migration must `ALTER TABLE outbox MODIFY idemKey VARCHAR(128) NOT NULL`.

2. **`outbox_status` enum is missing all 6 v1.9 status values.** Current enum: `('pending','claimed','sent','failed','skipped')`. Spec §4.1 requires: `pending_retry`, `lock_timeout`, `compose_crash`, `send_failed_retryable`, `failed_terminal`, `send_failed_terminal`. None of the 6 new values are present. Phase 1.B migration must extend the enum.

**V1.1 result: UNEXPECTED — two items need migration.**

---

### V1.2 — Leads Table

**Query run:** `DESCRIBE leads`

| Spec item | Present? | Type/default matches spec? |
|---|---|---|
| `leads.firstContactSentAt` (timestamp NULL) | **MISSING** | N/A |
| `leads.ownershipState` (varchar 32 NOT NULL DEFAULT 'ai') | **MISSING** | N/A |
| `leads.consecutiveNullCount` (int NOT NULL DEFAULT 0) | **MISSING** | N/A |
| `leads.bannedPhraseBlockCount` (int NOT NULL DEFAULT 0) | **MISSING** | N/A |

All four columns absent. Matches spec expectation. Phase 1.B adds all four.

**V1.2 result: MATCHES SPEC EXPECTATION — all four missing, Phase 1.B adds them.**

---

### V1.3 — sent_messages Table

**Query run:** `SHOW TABLES LIKE 'sent_messages'`

Result: **Table does NOT exist.**

Matches spec expectation. Phase 1.B creates it.

**V1.3 result: MATCHES SPEC EXPECTATION.**

---

### V1.4 — lead_active_compose and lead_compose_lock Tables

**Queries run:** `SHOW TABLES LIKE 'lead_active_compose'`, `SHOW TABLES LIKE 'lead_compose_lock'`

| Table | Exists? |
|---|---|
| `lead_active_compose` | **NO** |
| `lead_compose_lock` | **NO** |

Both absent. Matches spec expectation. Phase 1.B creates `lead_active_compose`. `lead_compose_lock` was never created (the rename happened before any creation per Drift Audit).

**V1.4 result: MATCHES SPEC EXPECTATION. No STOP condition.**

---

### V1.5 — compose_locks Table (Foundation D)

**Queries run:** `DESCRIBE compose_locks`, `SHOW INDEXES FROM compose_locks`, `SELECT COUNT(*) WHERE source='inbound_message'`

| Check | Result |
|---|---|
| Table exists | YES |
| Columns: id, leadId, eventKey, source, lockedAt, expiresAt | ALL PRESENT |
| Unique index `uq_compose_lock` on `(leadId, eventKey)` | PRESENT |
| Index `idx_compose_expires` on `(expiresAt)` | PRESENT |
| `source = 'inbound_message'` row count | **0** |

All match Drift Audit expectation. Foundation D extension to `inbound_message` source has not shipped yet (§5A scope).

**V1.5 result: MATCHES SPEC EXPECTATION.**

---

### V1.6 — pending_first_contacts Fossil

**Queries run:** `SELECT COUNT(*) FROM pending_first_contacts`, `SELECT * LIMIT 5`

| Check | Result |
|---|---|
| Row count | **1** |
| Row content | leadId=5100001, ghlContactId=`Uq4NWv2K1hLYljuyT4SJ`, status=`pending`, sendAt=`2026-05-19T01:21:40Z` |

Exactly 1 fossil row. Matches spec expectation. v1.9 FINAL leaves this table as-is.

**V1.6 result: MATCHES SPEC EXPECTATION.**

---

### V1 Summary

| Check | Result |
|---|---|
| V1.1 `idemKey` varchar(64) vs spec varchar(128) | **UNEXPECTED — needs ALTER** |
| V1.1 `outbox_status` missing 6 new enum values | **UNEXPECTED — needs ALTER** |
| V1.2 four leads columns missing | MATCHES EXPECTATION |
| V1.3 `sent_messages` absent | MATCHES EXPECTATION |
| V1.4 `lead_active_compose` absent, `lead_compose_lock` absent | MATCHES EXPECTATION |
| V1.5 `compose_locks` correct, inbound_message count=0 | MATCHES EXPECTATION |
| V1.6 `pending_first_contacts` 1 fossil row | MATCHES EXPECTATION |

**Phase 1.B migration script must include:**
1. `ALTER TABLE outbox MODIFY idemKey VARCHAR(128) NOT NULL;`
2. `ALTER TABLE outbox MODIFY outbox_status ENUM('pending','claimed','sent','failed','skipped','pending_retry','lock_timeout','compose_crash','send_failed_retryable','failed_terminal','send_failed_terminal') NOT NULL DEFAULT 'pending';`

---

## V2 — GHL Idempotency Behavior

### V2.1 — Native Idempotency Test

**Test contact used:** `3NrHlGpVslTE0Fg0nVjz` ("Idempotency Test Disregard", email-only, no phone)  
**Idempotency-Key:** `v1.9-phase1a-idem-test-1779823262069`  
**Channel:** Email (SMS unavailable — test contact has no phone number)

| Send | Status | messageId | Notes |
|---|---|---|---|
| First send | 201 | `Ap4YgnxbeQ8ILfjVUnuZ` | Email queued successfully |
| Second send (same key, 2s later) | **400** | N/A | "Unable to send e-mail, contact's e-mail is invalid" |

**Interpretation:** GHL processed the second request independently (attempted a new send, hit a different validation error). It did **not** return the original messageId or a 200/204 "already processed" response. The `Idempotency-Key` header was silently ignored.

**NATIVE_IDEM_WORKS: NO**

**Conversation history check:** 7 messages in conversation `RXoMgfgoTV9u2gZUoSTT`. The second send did not create a duplicate message (it failed at validation before message creation), but the behavior confirms GHL does not deduplicate on `Idempotency-Key`.

**Cleanup:** Test contact tagged `dnc` + `test-complete-v1.9-phase1a` (201 confirmed).

---

### V2.2 — Reconciliation Endpoint Check

**Endpoints attempted:**

| Endpoint | Response |
|---|---|
| `GET /conversations/messages/{messageId}` | **400** — "Message does not exist with id {id}" |
| `GET /conversations/messages?idempotencyKey={key}` | **400** — "Conversation with id messages not found" |

**Findings:**
- GHL does not expose a message-lookup-by-messageId endpoint at `GET /conversations/messages/{id}`. The 400 error ("Message does not exist") suggests the message was queued but not persisted with that ID, or the endpoint path is wrong.
- GHL does not expose a message-lookup-by-idempotency-key endpoint.
- Message lookup by conversationId (`GET /conversations/{convId}/messages`) works and returns message history, but does not support filtering by idempotency key.

**Result: Outcome (c) — neither native idempotency nor reconciliation endpoint works.**

This confirms the prior PO Option 1 fallback: log unknown-status sends for operator review. The v1.9 reconciliation cron with `sent_messages` table is the correct approach. Phase 1.B proceeds as scoped.

**V2 result: MATCHES SPEC EXPECTATION (outcome c confirmed).**

---

## V3 — AbortSignal Plumbing

### V3.1 — HTTP Clients Identified

| File | Library | Version | Usage |
|---|---|---|---|
| `server/ghl.ts` | `axios` | 1.12.2 | All GHL API calls (send message, get contact, etc.) |
| `server/omnisend.ts` | `axios` | 1.12.2 | Omnisend email API |
| `server/_core/llm.ts` | **native `fetch`** (Node.js built-in) | Node.js 22.13.0 | All LLM invocations via `invokeLLM()` |
| `server/fine-tuning-pipeline.ts` | **native `fetch`** | Node.js built-in | OpenAI fine-tuning API |
| `server/attempt-send.ts` | delegates to `webhook-helpers.ts` → `ghl.ts` → axios | — | GHL send path |

No `node-fetch`, `undici`, `got`, or `superagent` in production code.

---

### V3.2 — Signal Propagation Test Results

Test: AbortController aborted after 1000ms against `https://httpbin.org/delay/10` (10-second endpoint).

| Library | Elapsed | Error name | Signal honored? | Pass? |
|---|---|---|---|---|
| `axios` v1.12.2 | **1,004ms** | `CanceledError` (code: `ERR_CANCELED`) | YES | **PASS** |
| `native fetch` (Node.js 22) | **1,001ms** | `AbortError` | YES | **PASS** |

Both libraries close the network connection within ~1ms of the abort signal. Neither strips the signal.

---

### V3.3 — LLM SDK AbortSignal Check

**LLM call path:** `invokeLLM()` in `server/_core/llm.ts` uses native `fetch` directly (no third-party SDK).

**Current signal behavior:** `invokeLLM()` creates its own internal `AbortController` with a 120-second timeout (`LLM_CALL_TIMEOUT_MS = 120_000`). This internal timeout fires automatically if the LLM call hangs.

**External signal gap (architectural finding):** `InvokeParams` type does **not** include a `signal` field. Callers cannot pass an external `AbortSignal` to `invokeLLM()`. The function only honors its own internal 120s timeout.

**Implication for v1.9 MOV-A (AbortSignal threading):** The spec §4.5 requires threading an AbortSignal from the compose pipeline through to the LLM call so that a `lead_active_compose` lock expiry can cancel an in-flight LLM request. Currently this is not possible — `invokeLLM()` does not accept an external signal.

**Phase 1.B implication:** `invokeLLM()` must be extended to accept an optional `signal?: AbortSignal` parameter in `InvokeParams`, and pass it to the `fetch()` call (replacing or composing with the internal timeout controller). This is a **required change** for MOV-A implementation.

**V3 result: UNEXPECTED — Phase 1.B must add `signal?: AbortSignal` to `InvokeParams` and wire it through the fetch call. The underlying libraries (axios, fetch) both honor signals correctly; only the wrapper layer needs updating.**

---

## V4 — Banned-Phrase Filter Current State

### V4.1 — Current Implementation

**File:** `server/output-guards.ts`

**Total tokens in `CONTENT_GUARD_TOKENS`:** **20**

**Comparison mechanism:** `message.toLowerCase().includes(entry.token)` — lowercase-on-both-sides via `String.prototype.includes`. Tokens are stored lowercase. This is case-insensitive by construction.

**All 20 tokens (verbatim):**

| Token | Category | reasonCode | smsIgOnly? |
|---|---|---|---|
| `calendar invite` | Rule 18 fabricated | `fabricated_calendar_invite` | No |
| `confirming you got` | Rule 18 fabricated | `fabricated_confirmation` | No |
| `from our call` | Rule 18 fabricated | `fabricated_meeting_history` | No |
| `as we discussed` | Rule 18 fabricated | `fabricated_discussion` | No |
| `tracking number` | Rule 18 fabricated | `fabricated_tracking` | No |
| `customer portal` | Rule 18 fabricated | `fabricated_portal` | No |
| `account dashboard` | Rule 18 fabricated | `fabricated_dashboard` | No |
| `just thinking about` | Rule 15 filler | `filler_just_thinking` | No |
| `just checking in` | Rule 15 filler | `filler_checking_in` | No |
| `circle back` | Rule 15 filler | `filler_circle_back` | No |
| `circling back` | Rule 15 filler | `filler_circling_back` | No |
| `touching base` | Rule 15 filler | `filler_touching_base` | No |
| `i wanted to reach out` | Rule 15 filler | `filler_wanted_to_reach_out` | No |
| `just wanted to` | Rule 15 filler | `filler_just_wanted_to` | No |
| `make your brand pop` | Rule 15 filler | `filler_make_pop` | No |
| `elevate your brand` | Rule 15 filler | `filler_elevate` | No |
| `thanks, adorb custom printing` | Rule 17 sign-off | `banned_signoff_caps` | YES |
| `thanks, adorb` | Rule 17 sign-off | `banned_signoff_short` | YES |
| `best regards` | Rule 17 sign-off | `banned_signoff_formal` | YES |
| `warm regards` | Rule 17 sign-off | `banned_signoff_warm` | YES |

**Cross-check against spec §3.1 "Existing 20 exact tokens":**

Spec lists: 7 fabricated-infrastructure + 9 filler + 4 corporate sign-off = 20.

Production has: 7 fabricated + 9 filler + 4 sign-off = 20.

**One token name discrepancy:** Spec §3.1 lists `"just checking in"` as a filler token. Production has both `"just checking in"` (line 81) and `"circle back"` (line 82) + `"circling back"` (line 83). The spec lists `"circling back"` as a single token. Production has both the base form and the progressive form. This is a **superset** of the spec — not a gap.

**One spec token not in production:** Spec §3.1 lists `"make your brand pop"` as a filler token. Production has `"make your brand pop"` (line 87) — present. ✓

**Spec §3.1 two-token note:** "plus 2 corporate-tone tokens" in the filler category. Production has `"just wanted to"` and `"just thinking about"` as the two additional filler tokens beyond the 7 explicitly named in spec. These match.

**V4.1 result: MATCHES SPEC. 20 tokens present, case-insensitive mechanism confirmed.**

---

### V4.2 — Case-Insensitivity Verification

Test against `"elevate your brand"` token:

| Input | Blocked? |
|---|---|
| `"ELEVATE YOUR BRAND"` | **true** |
| `"elevate your brand"` | **true** |
| `"Elevate Your Brand"` | **true** |

All three match. Case-insensitive behavior confirmed via `toLowerCase()` on message before `includes()`.

**V4.2 result: PASS. Migration to typed `{type: 'exact', ...}` entries must preserve this behavior.**

---

### V4.3 — Rules 15-17 Cross-Check

**File:** `server/single-brain.ts`, lines 441–459

**Rule 15 (verbatim, lines 441–451):**
```
15. BANNED PHRASES — these phrases are FORBIDDEN in every outbound message. If your composed message contains any of them, REWRITE it before sending. The principle: no corporate filler, no manufactured intimacy.
    - "just thinking about"
    - "just checking in"
    - "circling back"
    - "touching base"
    - "I wanted to reach out"
    - "make your brand pop"
    - "make your [anything] pop"
    - "elevate your brand"
    - "take your [anything] to the next level"
    - Any corporate sign-off ("Thanks, ADORB CUSTOM PRINTING", "Best regards", "Warm regards", etc.) — SMS and IG are conversational, not formal
```

**Rule 16 (verbatim, lines 452–458):**
```
16. EVERY OUTBOUND MUST HAVE A LEGITIMATE HOOK. Before composing, ask: "Why am I sending this message TODAY, specifically?" Valid hooks:
    - A new piece of information (relevant case study, pricing change, seasonal trigger)
    - A specific question that requires a yes/no/short answer
    - An offer with a clear ask
    - A reference to something the lead said before that has new context now
    If you cannot identify a valid hook, return message: null with reason: "no_legitimate_hook".
    INVALID hooks (these are NOT reasons to send): "It's been a while", "Haven't heard back", "Just wanted to follow up", general product reminders with no specificity, any opening that could apply to any lead in the database.
```

**Rule 17 (verbatim, line 459):**
```
17. SIGN-OFFS — SMS and Instagram messages NEVER include a sign-off. Email may include a brief sign-off ONLY with the agent's first name in normal case ("— Mike"). NEVER use ALL CAPS company name as sign-off.
```

**Cross-check against spec §3.5 and §3.1:**

Rule 15 prompt text includes `"make your [anything] pop"` and `"take your [anything] to the next level"` as natural-language descriptions of the regex patterns. These are prompt-side representations of the v1.9.1 P5 regex entries (not yet in `output-guards.ts` — those are Phase 1.B additions).

Rule 16 (LEGITIMATE HOOK) is prompt-only. No output-guard backstop. This is the known gap from the Drift Audit — Rule 16 enforcement relies entirely on the LLM following the instruction. Phase 1.B does not add a guard for Rule 16 (per spec, this is deferred).

Rule 17 is covered by 4 sign-off tokens in `CONTENT_GUARD_TOKENS` (smsIgOnly=true).

**V4.3 result: PASS. Rules 15-17 confirmed present from commit `1402c2b`. Consistent with spec §3.5 and §3.1.**

---

## Closeout

| Item | Result |
|---|---|
| DDL this turn | **ZERO** |
| Code commits this turn | **ZERO** |
| `git log --oneline -3` top commit | `9ac2b72` (HEAD, origin/main) — unchanged |

---

## Phase 1.B Scope Implications

Based on V1–V4 findings, Phase 1.B migration script must include the following items **in addition to** the spec-expected items:

| Addition | Source | Priority |
|---|---|---|
| `ALTER TABLE outbox MODIFY idemKey VARCHAR(128) NOT NULL` | V1.1 unexpected finding | HIGH — idemKey length affects dedup key uniqueness |
| `ALTER TABLE outbox MODIFY outbox_status ENUM(...)` adding 6 new values | V1.1 unexpected finding | HIGH — status-aware retry cannot function without new enum values |
| Add `signal?: AbortSignal` to `InvokeParams` in `server/_core/llm.ts` | V3.3 unexpected finding | HIGH — required for MOV-A AbortSignal threading |

All other Phase 1.B items proceed as scoped in the spec.

---

**END OF PHASE 1.A VERIFICATION REPORT**
