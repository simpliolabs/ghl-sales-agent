# Lead #690005 Root Cause Analysis

## DB State
- name: olevia libby hopson-brooks
- ghlContactId: FX43yaa5aPvAiBJNNjRx
- pipelineStage: New Lead
- omnisendSegment: NULL
- nextFollowUpAt: 2026-04-08T17:22:55 (in the past)
- humanTakeover: 1
- lastAgentActivityAt: 2026-04-08T17:07:54 (~24hr ago)
- source: Facebook
- businessName: NULL (!)
- convState: new_lead
- Conversations: 1 (inbound form submission only)

## BUG 1: Conversation History "Missing"
**Root cause:** Only 1 conversation record exists — the Facebook form submission. Chris McHendry sent a FB message from the GHL UI, but GHL doesn't fire outbound webhooks for UI-sent messages. Our GHL history sync only runs during Brain Council calls (not on page view). Since humanTakeover=1, Brain Council never ran, so the sync never happened.

**Fix needed:** Fetch GHL conversation history on-demand when the lead detail page is loaded (tRPC leads.detail procedure). This ensures the portal always shows the full conversation regardless of whether Brain Council has run.

## BUG 2: nextFollowUpAt Stuck in the Past
**Root cause:** nextFollowUpAt was set to 15 min after inbound (standard new_lead delay). Then humanTakeover was set to 1 (Chris took over). The overdue catch-up timer CORRECTLY skips humanTakeover=1 leads. The disposition sweep's stale takeover check has a `createdAt < 3 DAYS AGO` filter — this lead was created yesterday (Apr 8), so it's too new for the disposition sweep to touch it.

**Fix needed:** The 3-day minimum age filter is too aggressive for the 24hr stale takeover timeout. If we want 24hr auto-release, we need to either:
1. Remove the 3-day filter from the stale takeover query (risky — could release very fresh leads)
2. Add a separate fast-track check for leads where lastAgentActivityAt is >24hr old regardless of age
3. After releasing humanTakeover, also reschedule nextFollowUpAt to near-future

## BUG 3: Segment "Unclassified"
**Root cause:** Segment classification in webhook-contact.ts only runs if `lead.businessName` is truthy (line 108: `if (lead && lead.businessName)`). This lead has businessName=NULL. The form data says "T-shirts" but that's stored in the conversation messageBody, not in the businessName field. No fallback classification exists for leads without a business name.

**Fix needed:** Add fallback segment classification that reads form data from the conversation body when businessName is missing. For a custom t-shirt company, any lead interested in "T-shirts" should be classified as a relevant segment.
