# Architectural Debt Inventory

**Created:** 2026-05-18  
**Last Updated:** 2026-05-19

---

## Section 1: Temporary Patches (Remove When Foundation B Ships)

| # | Patch | Location | Remove When |
|---|-------|----------|-------------|
| 1 | channelHint fallback (`channelHint \|\| channel \|\| lead.preferredChannel`) | `outbox-worker.ts` line ~713 | Foundation B ships proper channel enforcement at enqueue time |
| 2 | 30-min stale-reply TCPA exemption cutoff (`STALE_REPLY_MS`) | `outbox-worker.ts` line ~721 | Foundation B ships queue-age-aware staleness detection |

---

## Section 2: Pre-Existing Gaps (Patch-Class Bugs)

| # | Gap | Severity | Discovered | Notes |
|---|-----|----------|-----------|-------|
| 11 | **Lookback path doesn't trigger first-contact.** Leads created by the Lookback timer (batch scan of GHL contacts) skip the outbox/pending_first_contacts enqueue, so they never get an AI first-contact message. Only the real-time GHL webhook path enqueues outbound AI engagement. Any lead the webhook misses (GHL outage, webhook signature issue, rate limit, or GHL workflow-created contacts) gets picked up by Lookback — then sits silent forever. | **HIGH** — 417 leads in last 7 days matched the gap pattern (though many may have been engaged via other paths). The `pending_first_contacts` table has only 1 row ever, confirming the first-contact-via-table path is essentially unused. | 2026-05-19 (Thuy Huynh, lead 5100068) | Not a Foundation A regression. Pre-existing since system inception. The primary AI engagement path is webhook → outbox, not Lookback → pending_first_contacts. Thuy's case exposed it because her GHL webhook didn't fire. |

---

## Section 3: Investigation Needed

| # | Question | Priority | Context |
|---|----------|----------|---------|
| 12 | Why did Thuy Huynh's GHL webhook not fire? Two possibilities: (a) GHL didn't send it (their infra issue), (b) GHL sent it but our endpoint failed silently. Check `webhook_logs` table for her `ghlContactId = sQeZ8uda1LugTyAPg7TY` around 2026-05-19 05:00-05:10 UTC. | Medium | If (b), there's a hidden webhook handler bug. If (a), we need Lookback-to-first-contact as a safety net. |
| 13 | What is the actual engagement rate for leads created in the last 7 days? The query showed 354/471 leads got AI sends, but 417 matched the "no first-contact" pattern. The discrepancy (354 + 417 > 471) suggests the query conditions overlap or the AI engagement came via a path other than first-contact (e.g., follow-up, fast_scan reply). | Low | Informational. Helps calibrate how critical item #11 actually is. |
