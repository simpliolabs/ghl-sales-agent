# PRD: Context-Aware Follow-Up Scheduling Engine

**Product:** Adorb Outreach System
**Author:** Manus AI
**Date:** April 4, 2026
**Status:** Owner-Approved
**Version:** 1.1

---

## 1. Problem Statement

The current follow-up scheduling system assigns `nextFollowUpAt` timestamps based primarily on the lead's **pipeline stage** — a static, one-dimensional signal that ignores the richest data the system already has: conversation history, customer-stated timelines, lead age, reply recency, extracted event dates, and AI-inferred engagement signals.

This produces three critical failures:

1. **Premature outreach** — A lead who says "I don't need these for 2-3 more months" gets scheduled for a 4-hour follow-up because they're in the "Contacted" stage. The AI then messages them the next day, feeling pushy and tone-deaf.

2. **Missed reactivation windows** — A lead who went silent 45 days ago sits with no scheduled follow-up at all, because the stage-based system only fires once. There is no recurring reactivation cadence.

3. **One-size-fits-all timing** — A hot lead who just asked for pricing gets the same 4-hour delay as a lead who casually browsed and never replied. The system cannot distinguish urgency from indifference.

The scheduling engine must shift from **"what stage are they in?"** to **"what does the conversation tell us about when to reach out next?"**

---

## 2. Goals and Success Metrics

### Primary Goals

- Every lead in the system always has a meaningful, context-driven `nextFollowUpAt` value that reflects the optimal next touchpoint.
- The scheduling logic respects customer-stated timelines, extracted event dates, and behavioral signals — not just pipeline position.
- Dormant leads automatically re-enter the outreach cycle through a recurring reactivation cadence.

### Success Metrics

| Metric | Current State | Target |
|--------|--------------|--------|
| Leads with a scheduled follow-up | ~100% (bulk backfill) | 100% at all times |
| Follow-ups driven by conversation context | 0% | 80%+ |
| Dormant leads (30+ days) with active reactivation schedule | 0% | 100% |
| Reply rate on AI outreach | Unmeasured | Baseline + 20% improvement within 60 days |
| Leads flagged "too aggressive" by agents | Unknown | < 2% of outreach volume |

---

## 3. Scheduling Signal Hierarchy

The engine evaluates multiple signals and selects the **highest-priority applicable signal** to determine the next follow-up time. Signals are ranked in strict priority order — the first match wins.

### Priority 1: Customer-Stated Timeline

> "I don't need these until June."
> "Our event is September 15th."
> "Check back in a couple months."

When the customer explicitly states a future date or timeframe, that becomes the anchor. The AI already extracts dates via `extractedDates` in the response and stores them in `aiState.extractedDates` and `leads.contextDates`.

**Scheduling rule:** Schedule outreach for **30-60 days before the stated date**, with a follow-up cadence that accelerates as the date approaches.

| Time Until Stated Date | Schedule Follow-Up At | Rationale |
|------------------------|----------------------|-----------|
| 90+ days away | 60 days before the date | Plant the seed early, give them time |
| 60-90 days away | 30 days before the date | Start the conversation about timelines |
| 30-60 days away | 14 days before the date | Get specific: quantities, designs, budget |
| 14-30 days away | 7 days before the date | Create urgency: "If we start now, you'll have time for revisions" |
| 7-14 days away | 3 days before the date | Final push: "Last call to get this done before [event]" |
| < 7 days away | 1 day before the date | Emergency angle: "We can still do same-day if you need it" |

**Edge case:** If the customer states a vague timeline ("a couple months"), the AI should interpret this as 60 days from the conversation date and apply the same cadence.

**Edge case:** If multiple dates are extracted, use the **earliest** as the primary anchor but store all dates for future reference.

---

### Priority 2: AI-Suggested Engagement Hours

The `generateAIResponse` function already returns `nextEngagementHours` — the AI's real-time assessment of when to follow up based on the full conversation context, bottleneck diagnosis, and urgency funnel position.

**Scheduling rule:** Use `nextEngagementHours` directly when no customer-stated timeline exists and the lead is actively engaged (replied within the last 7 days).

This is the most contextually rich signal because the AI considers:
- The urgency funnel stage (Day 0 through Day 30+)
- The bottleneck type (information, trust, timing, budget, decision authority)
- The sales framework used and whether the lead showed interest
- The sentiment trend

**No override table needed** — the AI's judgment is the rule. The system simply converts `nextEngagementHours` to a timestamp.

---

### Priority 3: Reply Recency Cadence (No Active Conversation)

When the lead has not replied to the last outreach, the system enters a **graduated silence cadence** based on how long ago the last AI message was sent without a reply.

| Days Since Last AI Outreach (No Reply) | Next Follow-Up Delay | Channel Strategy | Message Angle |
|----------------------------------------|---------------------|------------------|---------------|
| 0-1 days | +24 hours | Same channel | Soft follow-up, reference last message |
| 2-3 days | +48 hours | Same channel | New angle, different framework |
| 4-7 days | +72 hours | Try different channel | Fresh value prop, case study |
| 8-14 days | +7 days | Email (value content) | Testimonial, case study, seasonal hook |
| 15-30 days | +14 days | SMS with fresh angle | New offer, seasonal relevance |
| 30-60 days | +30 days | Reactivation email | New value prop, "things have changed" |
| 60-90 days | +30 days | SMS 3 days after email | "Saw something that reminded me of [their business]" |
| 90+ days | +60 days | Email only | Gentle re-introduction, no pressure |

**Critical rule:** Each touchpoint in this cadence must use a **different framework and angle** from the previous one. The AI state tracks `lastAngleUsed` and `lastFrameworkUsed` to enforce this.

**Critical rule:** After **5 consecutive unanswered outreach attempts**, the cadence pauses for 90 days before trying one final reactivation. After that, the lead enters the **Perpetual Nurture** cycle (see Section 6A).

---

### Priority 4: Lead Age + Score Baseline (No Conversation History)

For leads that have never been engaged (bulk imports, form submissions with no conversation), the system uses a combination of lead age and opportunity score to determine initial outreach timing.

| Lead Age | Score 70+ | Score 40-69 | Score < 40 |
|----------|-----------|-------------|------------|
| < 1 hour | Immediate (5 min) | 15 min | 30 min |
| 1-24 hours | 30 min | 1 hour | 2 hours |
| 1-7 days | 1 hour | 4 hours | 8 hours |
| 7-30 days | 4 hours | 12 hours | 24 hours |
| 30-90 days | 24 hours | 48 hours | 72 hours |
| 90+ days | 48 hours | 72 hours | 1 week |

**Rationale:** Fresher, higher-scored leads get faster initial contact. Older leads with low scores are not urgent and should not flood the outreach queue.

---

### Priority 5: Pipeline Stage Events (Supplementary, Not Primary)

Pipeline stage changes generate **event-driven scheduling** that supplements (but does not replace) the context-aware cadence. These are one-time schedule overrides triggered by specific stage transitions.

| Stage Transition | Schedule Override | Rationale |
|-----------------|-------------------|-----------|
| → Quote Sent | +3 days | Follow up on the quote |
| → Paid - Proof Needed | +24 hours | Check in after payment |
| → Proof Sent | +48 hours | "Did you get a chance to review the proof?" |
| → Approved + Deposit | +24 hours | Confirm production timeline |
| → Ready | +4 hours | Notify pickup/shipping |
| → Delivered | +3 days | Ask for review/feedback |
| → Delivered (after review request) | +30 days | Reactivation: "Need anything else?" |
| → Not Qualified | +30 days | Reactivation attempt |

**Key distinction:** These overrides fire once per stage transition. After the override fires, the lead returns to the Reply Recency Cadence (Priority 3) or AI-Suggested timing (Priority 2) based on whether a conversation is active.

---

## 4. The Scheduling Engine Architecture

### 4.1 Core Function: `calculateNextFollowUp`

A single, centralized function that replaces all scattered scheduling logic. It accepts the full lead context and returns a `Date` plus metadata explaining why that time was chosen.

```
Input:
  - lead: Full lead record (score, stage, lastMessageAt, contextDates, createdAt)
  - aiState: AI state record (extractedDates, messageCount, lastAngleUsed, sentimentTrend)
  - lastOutboundMessage: Most recent AI/agent outbound message (timestamp, channel)
  - lastInboundMessage: Most recent lead reply (timestamp, channel) — may be null
  - aiSuggestedHours: From generateAIResponse (may be null for non-conversation triggers)
  - triggerEvent: What caused this calculation ("ai_response" | "stage_change" | "scheduled_recalc" | "new_lead" | "bulk_backfill")

Output:
  - nextFollowUpAt: Date
  - reason: string (human-readable explanation)
  - priority: number (1-5, which signal was used)
  - channel: string (suggested outreach channel)
  - cadencePosition: number (where in the silence cadence this lead is)
```

### 4.2 Invocation Points

The scheduling engine is called at every point where lead state changes:

| Trigger | When | Notes |
|---------|------|-------|
| **AI Response Generated** | After every `generateAIResponse` call | Uses Priority 1 or 2 |
| **Inbound Message Received** | When lead replies | Resets silence cadence, recalculates |
| **Pipeline Stage Change** | Webhook fires | Uses Priority 5 override, then falls back |
| **New Lead Created** | Contact webhook or manual sync | Uses Priority 4 |
| **Scheduled Recalculation** | Cron job every 6 hours | Recalculates all leads with stale schedules |
| **Human Agent Activity** | Agent sends message or completes task | Pauses AI schedule for 24h per handoff rules |
| **Bulk Backfill** | Manual admin trigger | Uses Priority 3 or 4 based on history |

### 4.3 Scheduled Recalculation Job

A background cron job runs every 6 hours and recalculates `nextFollowUpAt` for leads where:

- `nextFollowUpAt` is in the past and no outreach was sent (missed schedule)
- `nextFollowUpAt` is null (should never happen, but safety net)
- A `contextDate` is approaching and the current schedule doesn't account for it
- The lead has been in the silence cadence for 30+ days without a recalculation

This ensures no lead falls through the cracks, even if a webhook was missed or the server restarted.

---

## 5. Channel Selection Logic

The scheduling engine also determines **which channel** to use for the next outreach, following the urgency funnel rules already defined in the AI persona.

| Cadence Position | Channel Rule |
|-----------------|--------------|
| First contact | Same channel the lead used to reach out |
| Follow-up 1-2 (Day 0-3) | Same channel |
| Follow-up 3 (Day 4-7) | Try a different channel (FB → SMS, SMS → Email) |
| Follow-up 4+ (Day 8-14) | Email with value content |
| Reactivation (Day 15-30) | SMS with fresh angle |
| Long-term (Day 30+) | Email first, SMS 3 days later |

**Channel availability check:** Before scheduling on a channel, verify the lead has contact info for that channel (phone for SMS, email for Email, etc.). If not, fall back to the next available channel.

---

## 6. Human Takeover Integration

When `humanTakeover` is set to `1` or `lastAgentActivityAt` is within the last 24 hours:

- The scheduling engine **pauses** — no AI follow-up is scheduled.
- After 24 hours of agent inactivity, the engine **resumes** automatically and schedules the next follow-up based on the current context.
- When resuming, the AI acknowledges the gap: "Hey [name], wanted to follow up on our conversation about..."

---

## 7. Observability and Admin Controls

### 7.1 Lead Detail View — Scheduling Card

The Lead Detail page should display a **"Scheduling" card** showing:

- **Next outreach:** Date/time + countdown
- **Reason:** Why this time was chosen (e.g., "Customer mentioned June event — outreach scheduled 30 days before")
- **Cadence position:** Where in the silence cadence (e.g., "Follow-up #3 of 5")
- **Channel:** Suggested outreach channel
- **Signal used:** Which priority level determined the schedule (1-5)
- **Override button:** Admin can manually reschedule

### 7.2 Leads Table — Enhanced Next Outreach Column

The existing "Next Outreach" column should show a tooltip with the scheduling reason on hover, so agents can quickly understand why a lead is scheduled for a particular time without opening the detail view.

### 7.3 Dashboard — Scheduling Health Widget

A new dashboard widget showing:

- Total leads with active schedules vs. total leads
- Leads overdue for outreach (schedule in the past, no message sent)
- Distribution of leads across cadence positions
- Average time between outreach attempts

### 7.4 Admin Tweaks Integration

The AI Tweaker should support scheduling-related instructions:

- "Pause all outreach for the next 48 hours" (holiday, system maintenance)
- "Speed up cadence for all leads in [segment]" (seasonal push)
- "Skip reactivation for leads tagged [tag]"

---

## 8. Data Model Changes

### 8.1 New Fields on `leads` Table

| Field | Type | Purpose |
|-------|------|---------|
| `schedulingReason` | `varchar(255)` | Human-readable explanation of why this follow-up time was chosen |
| `schedulingPriority` | `tinyint` | Which priority signal (1-5) determined the schedule |
| `cadencePosition` | `int` | Position in the silence cadence (0 = active conversation, 1-5 = follow-up attempts, 6+ = reactivation) |
| `suggestedChannel` | `varchar(32)` | Channel the engine recommends for next outreach |
| `consecutiveNoReplies` | `int` | Count of consecutive AI outreach with no lead reply |
| `lastOutboundAt` | `timestamp` | When the last AI or agent message was sent |
| `reactivationCount` | `int` | How many times this lead has been through the reactivation cycle |
| `scheduleOverrideReason` | `text` | Free-text reason provided by agent when manually rescheduling |
| `scheduleOverrideBy` | `varchar(128)` | Name of the agent/admin who overrode the schedule |
| `scheduleOverrideAt` | `timestamp` | When the override was made |
| `lastEngagementAt` | `timestamp` | Last meaningful engagement (inbound reply or replied-to outbound) for score decay calculation |
| `lastSeasonalPushAt` | `timestamp` | When the last seasonal campaign email was sent |
| `perpetualNurturePosition` | `int` | Position in the Perpetual Nurture quarterly cycle (0 = not in cycle) |

### 8.2 Existing Fields Used (No Changes Needed)

| Field | Table | Usage |
|-------|-------|-------|
| `nextFollowUpAt` | `leads` | The calculated next outreach timestamp |
| `lastMessageAt` | `leads` | Last message from any party |
| `contextDates` | `leads` | Extracted event dates from conversations |
| `extractedDates` | `ai_state` | AI-extracted dates per lead |
| `messageCount` | `ai_state` | Total AI messages sent |
| `lastAngleUsed` | `ai_state` | Prevents repeating the same approach |
| `sentimentTrend` | `ai_state` | Positive/negative/neutral trend |

---

## 9. Edge Cases and Safety Rails

### 9.1 Rate Limiting

- **Per-lead cap:** Maximum 1 outreach per 24 hours per lead, regardless of scheduling logic.
- **Global cap:** Maximum 50 outreach messages per hour across all leads (prevents GHL API rate limits and spam flags).
- **Daily cap:** Maximum 200 outreach messages per day.

### 9.2 Do-Not-Contact Signals

The engine must **immediately stop scheduling** if:

- The lead explicitly opts out ("stop", "unsubscribe", "remove me", or similar language).
- The lead's GHL contact is marked as DND (Do Not Disturb).
- An agent manually marks the lead as "Not Qualified" (AI-initiated "Not Qualified" does not trigger a hard stop — the lead enters Perpetual Nurture instead).

**Note:** Leads are never permanently removed from scheduling solely due to non-response. They enter the Perpetual Nurture cycle instead (see Section 6A).

### 9.3 Business Hours

- SMS and phone outreach should only be scheduled during business hours: **Mon-Fri 9 AM - 6 PM ET**, **Sat 10 AM - 2 PM ET**.
- Email can be scheduled at any time but should prefer **Tue-Thu 9-11 AM ET** for optimal open rates.
- If a calculated follow-up falls outside business hours, it should be pushed to the next available business hour window.

### 9.4 Holiday Blackouts

- No outreach on major US holidays (New Year's Day, Memorial Day, July 4th, Labor Day, Thanksgiving, Christmas).
- Admin can add custom blackout dates via the AI Tweaker.

---

## 10. Migration Plan for Existing 1,622 Leads

### Phase 1: Data Enrichment (Before Scheduling)

For each existing lead, calculate and populate the new fields:

1. Query conversation history to determine `consecutiveNoReplies` and `lastOutboundAt`.
2. Check `aiState.extractedDates` and `leads.contextDates` for any customer-stated timelines.
3. Calculate `cadencePosition` based on the gap between `lastOutboundAt` and now.
4. Set `reactivationCount` based on lead age and message history.

### Phase 2: Recalculate All Schedules

Run `calculateNextFollowUp` for every lead using the enriched data. This replaces the current stage-based bulk assignment with context-aware timing.

### Phase 3: Stagger Execution

To avoid flooding GHL with 1,600 messages at once, stagger the calculated follow-ups:

- Leads with `cadencePosition` 0 (active conversation): Schedule as calculated.
- Leads with `cadencePosition` 1-3 (recent silence): Spread across the next 48 hours.
- Leads with `cadencePosition` 4+ (cold/dormant): Spread across the next 2 weeks.
- Leads with `reactivationCount` 2+ (heavily worked): Spread across the next 30 days.

---

## 11. Interaction with Existing AI Brain

The scheduling engine does **not** replace the AI brain's `nextEngagementHours` output. Instead, it provides a **fallback and override layer**:

- When the AI brain generates a response, its `nextEngagementHours` is used as Priority 2.
- When no AI response is being generated (scheduled recalculation, stage change), the engine uses Priorities 3-5.
- Priority 1 (customer-stated timeline) always overrides the AI brain's suggestion.

The AI brain's system prompt should be updated to be more explicit about `nextEngagementHours`:

> "When suggesting nextEngagementHours, consider: Has the customer stated a specific timeline? If yes, suggest hours that align with the 30-60 day pre-event window. Has the customer gone silent? Suggest progressively longer delays. Is the customer actively engaged and asking questions? Suggest 2-4 hours for fast follow-up."

---

## 12. Testing Strategy

### Unit Tests

| Test Case | Expected Behavior |
|-----------|-------------------|
| Lead says "my event is in September" | `nextFollowUpAt` set to ~30 days before September date |
| Lead says "don't need these for 2-3 months" | `nextFollowUpAt` set to ~60 days out |
| Lead replied 2 hours ago | Uses AI `nextEngagementHours` |
| Lead ghosted 5 days ago | Schedules 72h out on a different channel |
| Lead ghosted 35 days ago | Schedules reactivation email |
| Lead ghosted after 5 attempts | Pauses for 90 days |
| Lead says "stop" or "unsubscribe" | No follow-up scheduled, DNC flag set |
| Stage changes to "Delivered" | Schedules 3-day review request |
| New lead, score 85, created 10 min ago | Schedules in 5 minutes |
| New lead, score 30, created 3 days ago | Schedules in 8 hours |
| Human agent sends message | AI schedule paused for 24h |
| Calculated time falls on Sunday 8 PM | Pushed to Monday 9 AM ET |
| Lead ghosted after 5 attempts + 90-day pause | Enters Perpetual Nurture, quarterly email scheduled |
| Perpetual Nurture email gets a reply | Lead exits nurture, re-enters active cadence at Priority 2 |
| School segment lead in July, no active cadence | Receives back-to-school seasonal push email |
| Church segment lead in October, active conversation | Seasonal push skipped (active cadence takes precedence) |
| Lead received seasonal push 30 days ago, new season starts | Skipped (60-day cooldown not met) |
| Agent manually reschedules with reason "waiting on board approval" | AI references board approval in next message |
| Lead score 70, no engagement for 45 days | Score decayed to ~55 (3 pts/week for 5 weeks) |
| Decayed lead (score 15) replies to email | Score recalculated fresh by AI, decay overridden |
| Lead score at floor (5), 200 days no engagement | Score stays at 5, still receives Perpetual Nurture emails |

### Integration Tests

- End-to-end webhook → scheduling → outreach execution flow.
- Cron recalculation correctly updates stale schedules.
- Channel fallback when lead has no phone number.

---

## 13. Owner Decisions (Resolved)

All five open questions have been resolved by the owner. Their decisions are incorporated into the PRD as concrete specifications below.

---

### 13.1 Perpetual Reactivation via Email (Decision: YES, never stop)

The system **never stops trying** to reactivate a lead. After the initial silence cadence exhausts 5 consecutive unanswered attempts and the 90-day pause, the lead enters the **Perpetual Nurture** cycle:

| Cycle | Timing | Channel | Content Strategy |
|-------|--------|---------|------------------|
| Quarterly Email #1 | 90 days after last attempt | Email only | Advanced creative: industry insight, case study, or seasonal relevance tied to their segment |
| Quarterly Email #2 | 180 days after last attempt | Email only | New value prop: new product line, new capability, or price change |
| Quarterly Email #3 | 270 days after last attempt | Email only | Social proof: "Businesses like yours have been ordering..." with real data |
| Quarterly Email #4+ | Every 90 days indefinitely | Email only | Rotate through creative angles; never repeat the same approach |

The Perpetual Nurture cycle is **email-only** to minimize intrusiveness. Each email must demonstrate **advanced engagement creativity** — no generic "just checking in" messages. The AI brain must generate genuinely valuable content:

- Industry-specific insights relevant to their segment (e.g., "5 churches in South Florida just ordered matching retreat gear for summer")
- Seasonal hooks tied to their business calendar (e.g., back-to-school for schools, holiday season for churches)
- Case studies from similar businesses with real results
- New product announcements or capability expansions
- ROI-focused content that proves value, not sales pressure

Emails must be sent from `print@adorbcustomtees.com` with curiosity-driven subject lines that provide value. The AI must use the lead's full conversation history and research context to personalize each email.

**Exit condition:** The lead replies to any email, at which point they re-enter the active cadence at Priority 2 (AI-Suggested Engagement Hours).

**Hard stop:** Only an explicit opt-out ("stop", "unsubscribe") or GHL DND flag stops the cycle.

---

### 13.2 Seasonal Campaign Push (Decision: YES, when no active cadence)

The scheduling engine supports a **Seasonal Push** mode that accelerates outreach for leads in specific segments during relevant seasons. This activates **only when the lead has no other active cadence interaction** — it does not interrupt active conversations or the silence cadence.

| Season | Months | Target Segments | Push Angle |
|--------|--------|----------------|------------|
| Back-to-School | July - August | `school`, `sports_team` | "Getting your team ready for the new year?" |
| Holiday Season | October - November | `church`, `nonprofit`, `brand` | "Holiday events coming up — matching gear makes it special" |
| Spring Events | March - April | `event_planner`, `church` | "Spring fundraisers, Easter events — we've got you covered" |
| Summer Rush | May - June | `sports_team`, `school`, `brand` | "Summer camps, tournaments, team gear — same-day turnaround" |
| Year-End | December | All segments | "New year, fresh brand — start 2027 with custom gear" |

**Activation rules:**

1. The lead must be in the Perpetual Nurture cycle, the Reply Recency Cadence at position 4+, or have no active cadence.
2. The lead's segment must match the target segments for the current season.
3. The lead has not received a seasonal push email in the last 60 days.
4. The seasonal push does **not** count toward the silence cadence position — it is a supplementary touchpoint.

**Implementation:** A cron job checks at the start of each seasonal window and schedules one seasonal push email for qualifying leads, staggered across the first 2 weeks of the season.

---

### 13.3 Agent Override Visibility (Decision: YES)

When an admin or agent manually reschedules a lead's `nextFollowUpAt`, the system captures the override context and makes it available to the AI brain:

**New field on `leads` table:**

| Field | Type | Purpose |
|-------|------|--------|
| `scheduleOverrideReason` | `text` | Free-text reason provided by the agent when manually rescheduling |
| `scheduleOverrideBy` | `varchar(128)` | Name of the agent/admin who overrode the schedule |
| `scheduleOverrideAt` | `timestamp` | When the override was made |

**AI brain integration:** When `scheduleOverrideReason` is populated, it is injected into the AI context prompt under a new section:

> AGENT OVERRIDE CONTEXT:
> Agent [name] manually rescheduled this lead on [date] with reason: "[reason]"
> Adjust your messaging angle to account for this context.

This allows the AI to adapt its approach — for example, if an agent writes "Customer said they're waiting on budget approval from their board," the AI can reference that in its next message: "Hey [name], any update from the board on the budget?"

**UI:** The Lead Detail scheduling card shows the override reason, who set it, and when. The Leads table tooltip also surfaces this information.

---

### 13.4 Cross-Channel Daily Limits (Decision: NO)

The system uses a **single global daily cap of 200 messages/day** across all channels. No per-channel sub-limits are enforced. The rationale is simplicity — channel selection is already governed by the urgency funnel and cadence position, so adding per-channel caps would create unnecessary complexity and potentially block outreach when one channel's quota is exhausted but another is available.

---

### 13.5 Lead Score Decay (Decision: YES)

Opportunity scores decay over time for leads with no engagement, pushing them down the scheduling priority. The decay is applied during the 6-hour recalculation cron job.

| Days Since Last Engagement | Score Decay | Minimum Floor |
|---------------------------|-------------|---------------|
| 0-14 days | No decay | N/A |
| 15-30 days | -2 points/week | 30 |
| 31-60 days | -3 points/week | 20 |
| 61-90 days | -5 points/week | 10 |
| 90+ days | -5 points/week | 5 |

**"Engagement" is defined as:** Any inbound message from the lead, or any outbound message that received a reply within 7 days.

**Score recovery:** When a lead re-engages (replies to any message), the score is immediately recalculated by the AI brain via `scoreLeadQuick`, which overrides the decayed value with a fresh assessment.

**Score floor:** Scores never decay below 5. This ensures even the coldest leads remain visible in the system and eligible for Perpetual Nurture emails.

**Impact on scheduling:** Lower scores push leads further back in the Priority 4 table (Lead Age + Score Baseline), meaning decayed leads get slower initial re-engagement when they re-enter the active cadence. This is intentional — the system invests more energy in leads that show signs of life.

---

## 14. Implementation Phases

| Phase | Scope | Estimated Effort |
|-------|-------|------------------|
| **Phase 1** | Build `calculateNextFollowUp` function with all 5 priority levels | Core engine |
| **Phase 2** | Schema migration — add new fields to `leads` table (including override fields, decay tracking) | Database |
| **Phase 3** | Wire into all invocation points (webhooks, AI response, stage change) | Integration |
| **Phase 4** | Backfill migration for existing 1,622 leads | Data migration |
| **Phase 5** | Background cron job for scheduled recalculation + score decay | Infrastructure |
| **Phase 6** | Perpetual Nurture email cycle with advanced creative generation | AI + Email |
| **Phase 7** | Seasonal Campaign Push engine with segment-aware scheduling | Campaigns |
| **Phase 8** | Agent override capture UI + AI brain context injection | Agent tooling |
| **Phase 9** | UI updates — scheduling card, enhanced tooltips, dashboard widget | Frontend |
| **Phase 10** | Business hours + holiday blackout logic | Refinement |
| **Phase 11** | Rate limiting and DNC safety rails | Safety |
| **Phase 12** | Testing and validation | Quality |

---

*This PRD supersedes the previous stage-based scheduling approach. The core principle: **the conversation drives the cadence, not the pipeline stage.***
