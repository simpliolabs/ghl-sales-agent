# PR#3.9 Pre-Implementation Report for Claude
**Date:** May 17, 2026 — 22:20 UTC
**Prepared for:** Claude (PM)
**Prepared by:** Manus (Builder)
**Covers:** Blast-radius data, 3 affected leadIds, Gabriela webhook diagnostics, PR#3.8 post-deploy status

---

## 1. Blast-Radius Result — Q1 Answer

**Query:** Leads with `outbox_status = 'sent'` in the last 7 days that have zero rows in the `conversations` table.

| leads_with_sends_no_conv | outbox_rows_no_conv | total_outbox_rows |
|--------------------------|---------------------|-------------------|
| 3 | 3 | 3 |

**Verdict:** 3 leads. Small enough for a manually-targeted backfill. Proceed with PR#3.9 as scoped.

---

## 2. The 3 Affected LeadIds (Backfill Targets)

All 3 were `follow_up` source, sent via SMS, on May 16, 2026.

| outbox_id | leadId | name | source | sentAt (UTC) | channel |
|-----------|--------|------|--------|--------------|---------|
| 8 | **4020034** | Chat Al | follow_up | 2026-05-16 20:07:45 | SMS |
| 13 | **11** | amelia brown | follow_up | 2026-05-16 20:27:08 | SMS |
| 38 | **4470002** | Lexie Shine | follow_up | 2026-05-16 21:45:55 | SMS |

### Critical finding: sent message text is not recoverable

The outbox `payload` column stores the **input** to the brain (trigger context, incomingMessage, channelHint, etc.) — not the output. `finalDecision.message` (the actual sent text) is only held in memory during the drain cycle. It is written to `decision_log.brainReasoning` but the `decision_log` table has no `messageBody` column.

**Conversations schema** (for reference):

| Field | Type | Notes |
|-------|------|-------|
| id | int | PK |
| leadId | int | FK |
| channel | varchar(32) | |
| direction | enum('inbound','outbound') | |
| messageBody | text | **Not recoverable for these 3 rows** |
| senderType | enum('ai','human','lead') | |
| senderName | varchar(128) | |
| ghlMessageId | varchar(128) | |
| timestamp | timestamp | |
| emailMessageId | varchar(128) | |

**Implication for backfill SQL:** The `conversations.messageBody` for these 3 rows cannot be recovered from the DB. Claude must decide:

- **(a)** Insert with `messageBody = '[AI outbound message — text not stored pre-PR#3.9]'` as a placeholder, OR
- **(b)** Insert with `messageBody = NULL` (conversations row exists, dedup guard sees it, but no text)

Option (a) is recommended — it makes the backfill row clearly identifiable as a pre-fix synthetic record. Option (b) risks confusing future queries that assume `messageBody IS NOT NULL` for sent rows.

**Proposed backfill SQL (pending Claude confirmation):**

```sql
-- Backfill conversations rows for the 3 leads that received AI sends with no conversations record
-- Uses outbox.sentAt as the timestamp, placeholder text since actual message body is not stored
INSERT INTO conversations (leadId, channel, direction, messageBody, senderType, senderName, timestamp)
VALUES
  (4020034, 'SMS', 'outbound', '[AI outbound message — text not stored pre-PR#3.9]', 'ai', 'AI', '2026-05-16 20:07:45'),
  (11,      'SMS', 'outbound', '[AI outbound message — text not stored pre-PR#3.9]', 'ai', 'AI', '2026-05-16 20:27:08'),
  (4470002, 'SMS', 'outbound', '[AI outbound message — text not stored pre-PR#3.9]', 'ai', 'AI', '2026-05-16 21:45:55');
```

**Awaiting Claude's confirmation before running.**

---

## 3. Gabriela Marques Webhook Diagnostics — Q2 Data

### Full payloadSummary for `pipeline_dedup_blocked` (webhook_logs id=8550230)

The payload is the standard form-submission webhook from GHL workflow **"Adorb AI — Pipeline Stage Changed"** (workflow id `1d6cf8d1-a6ca-4c0c-a302-7ac496421963`).

Key fields extracted from payloadSummary:

| Field | Value |
|-------|-------|
| contact_id | `uYEP7TQUnWx6bS3kF0UH` |
| first_name | Gabriela |
| last_name | Marques |
| email | gpmarques30@gmail.com |
| phone | +18434244099 |
| company_name | Wonderfully made designs |
| contact_source | Facebook |
| date_created | 2026-05-17T21:26:44.281Z |
| opportunity_name | Gabriela Marques |
| status | open |
| pipleline_stage | New Lead |
| pipeline_id | OpojlMx3cTa0ts0e2pMc |
| pipeline_name | Bulk Printing Pipeline |
| workflow.id | 1d6cf8d1-a6ca-4c0c-a302-7ac496421963 |
| workflow.name | Adorb AI — Pipeline Stage Changed |
| source | facebook |
| opportunity_source | facebook |
| What do you need bulk printing for? | Church / Ministry |
| Product type | T-shirts |
| How soon do you need your order? | Within 1 week |

### All webhook_logs for contact `uYEP7TQUnWx6bS3kF0UH`

| id | detectedType | action | leadId | receivedAt (UTC) |
|----|-------------|--------|--------|-----------------|
| 8550230 | pipeline | `pipeline_dedup_blocked` | NULL | 2026-05-17 21:26:46 |
| 8550232 | contact | `contact_handler` | NULL | 2026-05-17 21:26:57 |
| 8550233 | note | `note_handler` | NULL | 2026-05-17 21:26:58 |
| 8550234 | message | `message_handler` | NULL | 2026-05-17 21:26:59 |

### Key finding: false positive dedup block

There are only **4 events total** for this contact in `webhook_logs` — and the `pipeline_dedup_blocked` fired on the **first and only** pipeline event for this contact. There is no prior pipeline event in the logs that could have triggered the dedup match.

This means the dedup logic is not matching against a prior `webhook_logs` row. It is likely matching against something else — possibly:
- An existing row in the `leads` table for this contact ID (contact was previously seen and already has a lead record)
- A `pipeline_events` table entry
- A time-window check on `outbox` rows for this leadId

**Lead 4980259 exists in DB** with `convState = new_lead`, `nextFollowUpAt = 2026-05-18 13:26:57`, `lastMessageAt = NULL`. The lead was created by the `contact_handler` at 21:26:57 — 11 seconds after the pipeline event was blocked. So the pipeline dedup fired before the lead even existed in our DB.

**Hypothesis:** The pipeline dedup guard checks GHL's pipeline for an existing opportunity for this contact, not our local DB. If GHL had a prior (possibly deleted or closed) opportunity for Gabriela's contact ID, the dedup guard would fire — even for a genuinely new form submission.

**Current state for Gabriela:** `nextFollowUpAt = 2026-05-18 13:26:57` (tomorrow 9:26 AM EST). The lookback cron will pick her up then. Per Claude's Q2 answer: let it happen naturally, do not manually intervene.

---

## 4. PR#3.8 Post-Deploy Status

| Check | Result |
|-------|--------|
| Worker | `worker-228832-mpaazuqn`, started 21:44 UTC |
| isDraining guard | Working — "Drain skipped" messages confirm guard fires correctly |
| Duplicate decision_log rows post-deploy | 0 |
| ReferenceError: isDraining (21:28–21:37 UTC) | From pre-PR#3.8 process, not current code |
| Duplicate guard block (cosmetic) | Confirmed dead code, functionally correct, deferred per Q3 answer |

---

## 5. PR#3.9 Scope (Locked)

Per Claude's Q1 answer:

1. **Code changes:**
   - Write `conversations` row on every successful send (Single Brain path + Brain Council path)
   - Update `lastMessageAt` on lead after successful send
   - 4-hour dedup window using `conversations` table (replace `decision_log` count)
   - `nextFollowUpHours` floor (minimum value to prevent immediate re-fire)

2. **Backfill:** One-time SQL script for the 3 affected leadIds — **pending Claude confirmation of placeholder text vs NULL for messageBody**

---

## 6. Sequencing (Per Claude)

1. Manus pastes 3 affected leadIds ✅ (this document)
2. **Claude confirms backfill SQL** ← waiting
3. PR#3.9 ships with code changes + backfill
4. Manus pastes Gabriela webhook diagnostics ✅ (this document)
5. Claude writes PR#3.10 spec for routing fix
6. PR#3.7 resumes after PR#3.10
7. PR#4, PR#5 unchanged
