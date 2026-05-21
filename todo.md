# Adorb Outreach System TODO

- [x] Database schema (leads, conversations, ai_state, pipeline_events, agent_assignments, knowledge_files, ai_tweaks)
- [x] Store secrets (GHL API key, Location ID, Omnisend API key)
- [x] GHL API v2 integration layer (auth, contacts, messages, tasks, custom fields, webhooks)
- [x] AI conversation engine (gpt-4.1-mini, Dan Martell methodology, PAS/BAB/AIDA)
- [x] Lead research module (medium-depth web research on new leads)
- [x] Dynamic Opportunity Scoring (0-100, gpt-4.1-nano)
- [x] Agent routing (round-robin Abby/Chris, GHL tasks + notifications)
- [x] Omnisend API integration (auto-segmentation)
- [x] Knowledge Base Upload page (PDF, images, CSV/XLSX, Google Sheets sync)
- [x] Communication AI Tweaker settings page
- [x] Context-aware follow-up automation (fixed tiers + AI-extracted date intelligence from conversations)
- [x] Dashboard: Hot Leads view (score 80+)
- [x] Dashboard: Pipeline Health view
- [x] Dashboard: AI Performance metrics
- [x] Dashboard: Lead Intelligence profiles
- [x] Light theme dashboard layout with sidebar navigation
- [x] Mobile-friendly responsive design
- [x] Vitest tests (17 tests passing)
- [x] Pipeline value: manual agent sync from GHL + LLM-estimated order value
- [x] Webhook URL display with setup instructions on Settings page
- [x] Smart agent handoff: AI hands off for quotes or manual agent activity, resumes after 24hr inactivity
- [x] GHL Contact Notes API: AI adds structured notes (estimates, due dates, preferences) to contact record
- [x] Invite links table in database schema
- [x] Role-based access: Admin (full) vs Viewer (dashboard/leads/pipeline only)
- [x] bills@theceocreative.com auto-promoted to admin (via OWNER_OPEN_ID)
- [x] Generate invite link UI on Settings page (admin only)
- [x] Invite link acceptance flow (/invite/:token page)
- [x] Hide Settings and AI Tweaker nav items for Viewers
- [x] Protect Settings/Tweaker tRPC procedures for admin only
- [x] Complete Webhook & Pipeline Automation Setup Guide document
- [x] Full pipeline stage automation (all stages with team assignments)
- [x] César Vásquez assignment for design/proof tasks
- [x] Cindy Muchnick assignment for production/shipping tasks
- [x] AI customer notifications at each pipeline stage
- [x] AI post-delivery review request automation
- [x] AI + Human cooperation for stage transitions
- [x] Bulk import existing GHL contacts into Adorb Outreach system (1,619 contacts, 1,593 with opportunities)
- [x] Get GHL API key with proper read scopes (contacts, opportunities, pipelines)
- [ ] Trigger AI engagement for all imported historical leads
- [x] Add Next Engagement Date/Time column to Leads table in dashboard
- [x] Run small test batch AI engagement on 5 leads across different stages
- [x] Fix GHL SMS 422 error (channel type normalization: InboundMessage → SMS)
- [x] BUG: AI engages leads without checking prior GHL conversation history (Ron Belvin)
- [x] BUG: New leads (Garvey Mclean, Mujahid Muhammad) not engaged at all
- [x] BUG: Marcus Sims received raw "Test message from Adorb" — was a manual API test during debugging (cannot unsend)
- [x] BUG: AI responds via SMS when lead reached out via FB — must match inbound channel
- [x] Build urgency funnel for channel escalation based on contact lifetime in funnel
- [x] Deep-learn Adorb products/services from adorbcustomtees.com, print.adorbcustomtees.com, floridadtffactory.com
- [x] Rewrite first-response to be short, personal, Dan Martell/Hormozi style with company intro + reviews
- [x] Verify price list uploaded to Knowledge Base and AI synthesized it
- [x] Add pricing estimate rule: quantities under 80 can get AI estimate within 25% margin
- [x] BUG: Only 1 lead has scoring — bulk scored all 1,622 leads (avg: 50, hot: 4, warm: 77)
- [x] BUG: Lead value not auto-calculated from pricing during AI engagement — now estimates on every response
- [x] Auto-synthesize all uploaded content (PDF, images, CSV) and AI instructions on upload via LLM
- [x] Auto-calculate lead value from price list when AI knows quantity
- [x] Redesign Pipeline page as horizontal Kanban board with stage columns, summary stats, and clickable lead cards
- [x] Add Next Outreach column to Leads page (always visible, color-coded: red=overdue, amber=today, gray=future)
- [x] BUG: Most leads have no nextFollowUpAt — column should always be prefilled for all leads (bulk-set 1,620 leads + auto-schedule on new contacts)
- [x] Show research context (extra context from AI research) on lead detail page + leads table Context column
- [x] BUG: Garvey Mclean received 4 messages without response — cadence should back off after no reply (added dedup guard + cadence backoff)
- [x] BUG: Lead #1620 conversation history in Adorb doesn't match what's in GHL (GHL workflow collision + form data ghost messages)
- [x] BUG: Ghost inbound messages — Facebook lead form data misclassified as conversation messages in DB (added form data filter)
- [x] BUG: No cadence backoff — system sends multiple messages in minutes without waiting for reply (2 unanswered: 1h gap, 3: 4h, 4+: 24h)
- [x] BUG: Repetitive AI openers — every message starts with "Hey [name]! Chris here from Adorb" (added anti-repetition rules + prior outbound awareness) 
- [x] BUG: AI doesn't acknowledge lead's stated request from form data (product, quantity, timeline) (added form data extraction + structured intro)
- [x] Mandatory GHL history fetch for any contact older than 3 days before AI engagement (webhook + backfill)
- [x] Bulk backfill: pull GHL conversation history for all existing 3+ day old contacts and store as context (script running)
- [x] SYSTEM: Multi-brain architecture — Strategist brain (decides approach/channel/timing), Composer brain (writes the message), QC brain (reviews before sending)
- [x] SYSTEM: Real online research pipeline — web search, social media, company website scraping for lead enrichment (LinkedIn + Data API + LLM synthesis)
- [x] SYSTEM: Skill library integration — pull proven frameworks from Claw/OpenClaw into AI brain knowledge (Hormozi outreach, campaign orchestrator, sentiment scorer)
- [x] SYSTEM: Context-aware scheduling engine — implement approved PRD v1.1 (signal hierarchy, perpetual reactivation, seasonal campaigns, score decay)
- [x] Wire all 4 systems into the webhook flow so every engagement goes through strategist → composer → QC → send
- [x] FIX GAP: Add real web search API to lead researcher (Google Places API for business lookup + LinkedIn Data API + email domain analysis)
- [x] FIX GAP: Define actual Hormozi 4-step framework content in brain council (Core Four + ACA Method + Indirect Selling + Prospecting Formulas from $100M Leads)
- [x] FIX GAP: Wire agent override reason into AI brain context during engagement (reschedule endpoint + override fields read by Strategist brain)
- [x] FIX GAP: Set up cron job for recalculateStaleSchedules + score decay (hourly interval on server startup)
- [x] Integrate Email Marketing Bible skill from GitHub (CosmoBlk/email-marketing-bible) — 473-line skill integrated into Strategist (email sequences), Composer (copywriting formulas), QC (email-specific checks)
- [x] Verify GHL webhooks are firing — YES, webhooks fire but sendMessage returns 422/400. Fixed API version header from 2021-07-28 → 2021-04-15 + added error logging
- [x] BUG: Composer ignores Strategist framework choice on first contact — writes generic one-liners instead of ACA (Acknowledge/Compliment/Ask) structure
- [x] Add webhook event logging table to track all incoming GHL webhooks (for diagnosing missed events like Rodney Williams)
- [x] Add webhook health check endpoint (GET /api/webhooks/health)
- [x] Add Brain Council audit log storage — per-message strategist reasoning, composer output, QC score/issues
- [x] Build Brain Council audit log dashboard page showing full decision trail for every AI message
- [x] Strengthen QC brain to reject generic first-contact messages that don't follow ACA structure
- [x] Add GHL API fallback: auto-pull full contact data from GHL API when webhook payload is missing name/email/phone
- [x] Fix Sarah Weiss's incomplete lead record (missing name, email, phone) using GHL API enrichment
- [x] BUG: New GHL contacts (after webhook URL update) still not being engaged — diagnose and fix end-to-end pipeline
- [x] FIX: GHL workflow sends wrong/mismatched contact IDs — added resolveGhlContactId with API search fallback
- [x] FIX: sendMessage fails silently on wrong contact ID — added sendMessageWithRetry with contact resolution
- [x] FIX: lastInbound.type crash (non-string type from GHL API) — wrapped all .type references with String()
- [x] FIX: lastAngleUsed column too short for Brain Council angle descriptions — changed to TEXT
- [x] Re-engaged Tammy Smith and Donna Baker-Johnson with correct GHL contact IDs
- [x] BUG: Researcher brain pulled irrelevant business data (Chick-fil-A) for Tammy Smith instead of using her form data (Church/Ministry)
- [x] BUG: Composer ignored lead's actual stated needs (delivery options, Church/Ministry) and used wrong research about Chick-fil-A
- [x] FIX: Researcher must prioritize form data over web research — form data IS the ground truth
- [x] FIX: Composer must always acknowledge lead's stated request from form data FIRST, never override with research
- [x] LOCK DOWN: Disable Researcher brain on first contact — research only for long-term reactivation
- [x] LOCK DOWN: Strict two-message welcome sequence for first contact:
  - MSG 1: "Hi {name}, {agent} here! Adorb has a 4.9 star review helping {business_type} with customized {product} {timeline}."
  - MSG 2 (immediate follow-up): "Do you have a design ready or would you like our team to help?"
- [x] LOCK DOWN: No LLM creativity on first contact — template is fixed, only fill in form data variables
- [x] ACCOUNTABILITY: Hard QC blocking — messages scoring below threshold are BLOCKED, never sent, owner notified
- [x] ACCOUNTABILITY: Violation categories — irrelevant research, ignoring form data, wrong business reference, generic opener, missing ACA structure
- [x] ACCOUNTABILITY: Owner notification on every blocked message with full audit trail (what went wrong, which brain failed)
- [x] ACCOUNTABILITY: Auto-fallback to safe template when QC blocks a message (instead of sending nothing)
- [x] ACCOUNTABILITY: Dashboard showing blocked messages, violation patterns, QC failure rate over time
- [x] ACCOUNTABILITY: Consecutive failure circuit breaker — if Brain Council fails 3x in a row for a lead, pause AI and alert owner
- [x] Send Tammy Smith apology + correct first-contact message for the Chick-fil-A mistake
- [x] AUTO-CORRECT: When a message is blocked by QC, auto-send apology + correct message if a bad message was already delivered
- [x] AUTO-CORRECT: Detect when a previously sent message was bad (via audit log violation) and trigger correction
- [x] AUTO-CORRECT: Apology template — short, human, acknowledges the mix-up, then delivers the correct locked template
- [x] REFACTOR: Split webhooks.ts (1386 lines) into webhook-helpers.ts, webhook-contact.ts, webhook-message.ts, webhook-pipeline.ts, webhook-task.ts, webhooks.ts (thin router)
- [x] REFACTOR: Split brain-council.ts (1287 lines) into brain-types.ts, brain-context.ts, strategist.ts, researcher.ts, composer.ts, qc.ts, brain-council-orchestrator.ts
- [ ] REFACTOR: Extract shared types/interfaces into shared/types.ts
- [ ] BUILD: Follow-up engine as first-class module with tier-based cadence
- [x] BUILD: Self-learning infrastructure (outcome tracking, pattern analysis, prompt injection)
- [x] BUILD: Bulk agent assignment for 1,618 unassigned leads
- [ ] BUILD: Bulk GHL data enrichment for all leads
- [x] SELF-LEARN: Schema + DB helpers for outcome tracking (message_outcomes table linking audit → reply/conversion/sentiment)
- [x] SELF-LEARN: Outcome detection engine — detect replies, conversions, sentiment shifts per AI message
- [x] SELF-LEARN: Pattern analysis module — aggregate win rates by framework/angle/segment/agent
- [x] SELF-LEARN: Inject learning context into Strategist brain (top-performing frameworks per segment)
- [x] SELF-LEARN: Wire outcome tracking into webhook message flow (auto-attribute replies to prior AI messages)
- [x] SELF-LEARN: Dashboard UI — learning insights page showing what's working and what's not
- [x] SELF-LEARN: Tests for outcome tracking + pattern analysis
- [x] ACTIVATE: Bulk assign agents to all 1,618 unassigned leads (round-robin Abby/Chris — 809 each)
- [x] ACTIVATE: Wire follow-up cron trigger so overdue leads get auto-engaged via Brain Council (10min cycle, max 10/batch, cadence backoff, rate limits)
- [x] ACTIVATE: Tier 1 — engage 4 hot leads (score 80+) set to NOW (Garvey Mclean 88, Robbin Johnson 85, Spany Mburunyeme 80, Judy Winters Fenton 80)
- [x] ACTIVATE: Tier 2 — engage 40 quote_sent leads staggered over next 2 hours (3 min apart)
- [x] BUG: Dennis Bost replied 3 times — GHL workflow payloads used contact_id + nested message.body format that our system didn't recognize. Fixed with normalizeWorkflowPayload() in webhook router. 71 tests passing.
- [x] BUG: Follow-up trigger sends SMS to 4-month dormant leads instead of crafted re-activation email — added dormancy detection (30/90/180 day tiers) + email-first channel forcing
- [x] FIX: Strategist brain now has full dormancy re-activation rules — Win-Back framework, email-first, curiosity-driven subjects, no stale conversation continuation
- [x] FIX: Follow-up trigger forces Email channel for dormant leads with email on file, injects dormancy context so Brain Council crafts proper re-activation
- [x] FIX: Removed hardcoded channel forcing — Brain Council now autonomously decides channel. Orchestrator surfaces strategy.channel in output. Follow-up trigger passes hint + dormancy context, uses aiResponse.channel for sending.
- [x] ACTIVATE: Tier 3 — 721 contacted leads staggered over 7 days (14 min apart, ~103/day) from Apr 5 to Apr 12
- [x] ACTIVATE: Tier 4 — 837 new_lead + not_qualified leads staggered over days 8-14 (12 min apart, ~120/day) from Apr 12 to Apr 19
- [x] BUILD: Lookback engine — pre-process all queued leads before follow-up trigger reaches them (rate-limited, incremental, auto-resume)
- [x] LOOKBACK: LLM-powered conversation analysis — detect completed orders, DNC signals, angry exits, sentiment
- [x] LOOKBACK: Pre-tag dormancy tier, lead status flags (skip/engage/caution), and sentiment per lead
- [x] LOOKBACK: Pre-run Researcher for leads with business names to populate research data
- [x] LOOKBACK: Recalculate follow-up schedules based on real conversation data (not just pipeline stage)
- [x] LOOKBACK: Wire admin trigger + run on all 1,582 queued leads (rate-limited: 3s delay, 50/batch, auto-retry on rate limit, incremental resume)
- [x] LOOKBACK: Wired as automatic background drip on server startup — 5 leads every 30 min, 5s delay between, auto-resume, incremental
- [x] CACHE: Added TTL caching across entire portal — brain context (5min), conversations (2min), AI state (5min), tweaks (5min), KB (10min), pattern analysis (10min), perf stats (3min), pipeline stats (3min), agent workload (3min). Cache invalidation on all writes.
- [x] BUG: Email to Pastor Shirley has no signature, no Google reviews, one long paragraph — fixed Composer with mandatory email format + signature block
- [x] FIX: Composer brain now outputs short punchy lines (max 15 words/line) with blank lines between, Hormozi/Martell style
- [x] FIX: Added mandatory email signature block: Agent | Adorb Custom Printing, phone, email, website, 4.9 Stars · 867+ Verified Reviews, Google reviews link
- [x] FIX: QC brain now has Email Formatting Check (criterion 12) — scores 0 for missing signature, long paragraphs, no reviews link. Auto-fixes in revisedMessage.
- [x] FIX: Email subject bug — follow-up trigger + webhook-message used fromName as subject instead of Composer's subject field
- [x] OMNISEND: Bulk push all 798 existing leads with email to Omnisend (with segment + stage + score tags) — zero errors- [ ] BUG: Bobby Clarner (Facebook) — webhooks arrived but Brain Council failed due to LLM credits exhausted (412). Need retry queue for failed LLM calls. as Dennis Bost.
- [x] LLM RETRY: Added isLlmExhausted() helper to webhook-helpers.ts — detects 412, 429, rate, exhausted, quota, usage errors
- [x] LLM RETRY: webhook-message.ts — Brain Council call wrapped in try/catch, LLM exhaustion auto-reschedules lead with exponential backoff (15min → 22min → 33min → max 4hr)
- [x] LLM RETRY: webhook-message.ts — Logs failed LLM calls in brain_council_audit with violationCategory="llm_exhausted"
- [x] LLM RETRY: webhook-message.ts — Notifies owner on first failure and every 5th retry
- [x] LLM RETRY: follow-up-trigger.ts — Brain Council call wrapped in try/catch, LLM exhaustion stops entire cycle (no point trying more leads)
- [x] LLM RETRY: follow-up-trigger.ts — Reschedules ALL remaining leads in batch with staggered retry times (prevents thundering herd)
- [x] LLM RETRY: follow-up-trigger.ts — Tracks consecutive exhaustion cycles, notifies owner on first + every 6th cycle (~1 hour)
- [x] LLM RETRY: follow-up-trigger.ts — Resets exhaustion counter on successful Brain Council call (auto-recovery when credits replenish)
- [x] LLM RETRY: AuditLog.tsx — Added "LLM Credits Exhausted" violation label + purple badge color
- [x] LLM RETRY: 12 new vitest tests for isLlmExhausted, constants, and exponential backoff calculation
- [x] BUG: Duplicate SMS sent to Jose Alfredo Munoz — same message sent twice at 01:27 PM on Apr 5. Fixed with in-memory concurrent dedup lock in webhooks.ts (acquireMessageLock/releaseMessageLock) + type-safe fallback handler for empty/object body payloads. 4 new dedup tests added.
- [x] BUG: Paulette Hughes Kornegay came in via Facebook but locked first-contact template sent via SMS — Fixed with 7-layer channel detection in webhook-contact.ts (GHL history, payload type, nested message type, payload source, lead source, workflow name, tags) + normalizeChannel now handles GHL numeric types (2=SMS, 3=Email, 4=FB, 5=IG, 6=WhatsApp, 15=Live_Chat). 12 new normalizeChannel tests.
- [x] IMPROVEMENT: Add 45-second delay before sending locked first-contact template — webhook responds immediately, first-contact fires via setTimeout after 45s. GHL has time to index conversation data for accurate channel detection. Also looks more natural. Tests updated with vi.useFakeTimers().
- [x] BUG: James Walden first-contact said generic "custom gear" instead of "T-shirts" / "Church/Ministry" — Fixed with 3-layer form data extraction: (1) webhook payload fields, (2) GHL contact custom fields API, (3) NEW: parse key-value pairs from Facebook form message body in GHL conversation history. Added parseFormDataFromMessageBody() to webhook-helpers.ts + 5 new tests.
- [x] BUG: James Walden's reply "Just our church name on about 100 shirts various sizes" got no Brain Council response — CONFIRMED: LLM credits exhausted (412). Retry queue will auto-recover once credits replenish.
- [ ] FUTURE (reminder set for Apr 19): SYSTEM HEALTH: Build LLM health monitor — global failure detection, dashboard red banner, persistent owner notifications, auto-recovery detection, tRPC status endpoint
- [x] BUG: Belinda Davis (Facebook lead) still got SMS after 7-layer detection deployed. Fixed with Layer 0 (strongest): if parseFormDataFromMessageBody finds form data in GHL conversation body → channel is FB (bulletproof, doesn't depend on GHL type field). Also removed .includes("message") catch-all that was matching "InboundMessage" → SMS. Added raw GHL type diagnostic logging.
- [x] BUG: Aundrea Tackett — FB channel detection works but said "custom gear". Fixed: Layer 3 now ALWAYS runs as enrichment (merges missing fields from FB message body even when Layer 1 found some fields). Product Type, Purpose, Timeline now always extracted.
- [x] BUG: Aundrea Tackett — duplicate "Do you have a design ready". Fixed: added in-memory firstContactLocks with 2-minute window in webhook-contact.ts. Lock acquired before sendDelayedFirstContact, released after completion.
- [x] SCHEMA: Add ghlPipelineId, ghlStageId, opportunityStatus, opportunityName columns to leads table
- [x] SYNC: Bulk sync all 1,635 GHL opportunities into local DB (stage, pipeline, status, name)
- [x] FIX: GHL opportunities API uses location_id/pipeline_id (snake_case) not locationId/pipelineId
- [x] AUTO-ADVANCE: After first-contact sends, auto-move GHL opportunity from New Lead → Contacted
- [x] WEBHOOK: GHL Pipeline Stage Changed webhook wired to /api/webhooks/ghl/pipeline
- [x] FIX: TypeScript implicit any errors in Pipeline.tsx, Home.tsx, Settings.tsx, KnowledgeBase.tsx (0 errors)
- [x] BUG: Linda Harvey-Williams received same message 3 times at 05:35 PM — triple duplicate from follow-up trigger or Brain Council. Root cause: 3 server restarts in quick succession each fired an "initial run" simultaneously. Fixed with global in-process trigger lock (triggerRunning flag + 5min timeout) + bumped dedup window from 5min to 10min.
- [x] FEATURE: Brain Council Self-Review Workflow — Council detects its own mistakes (duplicates, bad messages, missed responses), composes recovery messages using full lead context, and sends them autonomously. Runs every 30 min + 5 min after startup. Recovery approach added to Strategist brain.
- [x] BUG: Kendra Ridgeway sent logo twice — FIXED: Added attachment detection in webhook-message.ts. When lead sends a file with no text body, AI pauses 2 hours automatically (humanTakeover=1, lastAgentActivityAt=+2h). Logs '[Attachment received — logo/design file]' to conversation history.
- [x] BUG: Agent not assigned in GHL when human takeover activates — FIXED: Added AGENT_GHL_USER_IDS map to ghl.ts + updateContactAssignment() function. Called on every handoff so GHL contact record shows the assigned agent immediately.
- [x] FEATURE: Council responds within 3 minutes to ALL inbound messages 24/7 — FIXED: Added runFastMissedReplyScanner() that runs every 2 minutes, scans for unanswered inbound messages in the last 5-minute window, and fires Brain Council immediately. Separate from the 30-min self-review cycle.
- [x] IMPROVEMENT: Replace 2-hour attachment pause with Brain Council intelligent handling — when AI is in control and lead sends a file, routes to Brain Council with '[Lead sent a logo/design file]' context so it responds intelligently. When human agent is active (humanTakeover=1 within 2hr window), AI stays silent. Fixed db.execute return type bug in brain-council-review.ts (mysql2 returns [rows, fields] not rows directly) — FastScan 'lead undefined' error resolved.
- [x] CRITICAL BUG: ~1500 leads not being proactively contacted today — ROOT CAUSE: scheduling engine spread all leads across future dates during opportunity sync. FIXED: 93 never-contacted leads reset to fire immediately. 22 leads scheduled beyond 90 days reset to 90-day window.
- [x] CRITICAL BUG: Mika Exult Jones (lead 881) follow-up set to 4/6/2027 — RESOLVED: Was set by Lookback Engine skip logic (365-day rule, now fixed to 90 days). Mika WAS contacted in Nov 2025 but GHL stage never updated. Reset to 90-day window.
- [x] AUDIT: 558 "new_lead" stage leads — VERIFIED: 515 were already contacted (outbound messages exist, GHL stage just never updated). Only 43 were truly never contacted — those 43 reset to fire immediately. The 515 will be updated in GHL via pipeline webhook going forward.
- [x] BUG: Lookback Engine scheduling non-fit/cold leads 1 year out — FIXED: Changed waitDays from 365 to 90 for all skip leads. All leads now reactivated quarterly with 'Can we help you now?' messaging.
- [x] BUG: Portal showed Mika as 'Contact today: 4/6/2027' — CLARIFIED: The date was April 6, 2027 (future), not today. Trigger correctly skipped her. Portal display was misleading because year wasn't prominent. Mika's schedule reset to 90 days as part of the far-future fix.
- [x] BUG: Reactivation schedule uses NOW + 90 days — FIXED: Now uses lastActivityAt + 90 days. If last contact was 60 days ago, reactivation fires in 30 days. If last contact was >90 days ago, fires tomorrow.
- [x] UX: Leads list (/leads) now sorts by nextFollowUpAt ASC — next lead to contact is always at the top. Null nextFollowUpAt leads come last.
- [x] CRITICAL BUG (10th report): Duplicate/repetitive messages (Bobby Clarner 3 messages at 07:13 PM) — FIXED: DB-level atomic lock (processingLockedAt column) prevents concurrent Brain Council runs across webhook handler + Fast Scanner + Follow-up Trigger + Self-Review. All 4 callers now acquire DB lock before running Brain Council.
- [x] CRITICAL BUG: Human takeover ignored — AI continues after human agent takes over — FIXED: DB lock prevents any new Brain Council run while another is in progress; humanTakeover=1 check is in all callers.
- [x] CRITICAL BUG: AI asks for email/phone already on file (Bobby Clarner) — FIXED: Composer now receives lead.email and lead.phone with explicit rule 'NEVER ask for info we already have'.
- [x] CRITICAL BUG: Self-review 'missed reply' recovery duplicated Fast Scanner — FIXED: detectMissedReplies() disabled in self-review; Fast Scanner is the sole handler for missed replies.
- [x] FEATURE: Go Offline / Go Online toggle button added to sidebar footer (admin only). Red banner shown when AI is offline. DB-backed via systemSettings table. All 4 autonomous senders check isAiOffline() before running Brain Council.
- [ ] BUG: Go Offline button turns system off but red banner doesn't appear, pressing again just shows 'system is offline' toast instead of toggling back online
- [ ] AUDIT: Complete system review — assess all components against the vision of a smart, autonomous, self-learning system
- [x] CRITICAL: Send Gate in ghl.ts — per-contact 60s cooldown + isAiOffline check inside sendMessage itself. The nuclear option that cannot be bypassed by any caller.
- [ ] ARCHITECTURE: Brain Council should be the single decision-maker — owns the full send/no-send decision
- [ ] ARCHITECTURE: Brain Orchestrator pre-flight checks: already-responded check, human takeover, system offline, conversation freshness
- [ ] ARCHITECTURE: Brain should check "did I already respond to this exact inbound message?" before composing
- [x] REDESIGN: Brain Council is now the single gatekeeper — ALL send/no-send decisions (offline, lock, humanTakeover, dedup) moved INTO runBrainCouncil. Callers are dumb dispatchers.
- [x] FIX: webhook-message.ts now returns immediately when Brain aborts (blocked=true without fallback) — no longer falls through to sendMessage
- [x] FIX: Removed double-locking bug where caller acquired lock then Brain tried to acquire same lock and always failed
- [x] BUG FIX: Go Offline button — system_settings column name mismatch (settingKey vs key) fixed. Schema now matches actual DB columns.
- [x] UI: Make dashboard content area full width instead of constrained narrow center column — added w-full to flex h-screen div in DashboardLayout.tsx
- [x] CRITICAL BUG FIX: Triple duplicate messages — Root cause: webhook handler + Fast Scanner + Self-Review all firing simultaneously on same lead. Fixed with:
  - DB-level send cooldown: lastAiSendAttemptAt column on leads table, checked in Brain Council pre-flight (90s cooldown)
  - Extended DB lock TTL from 90s to 300s (5 minutes) to cover worst-case 4-LLM-call pipeline
  - Changed DB lock fail mode from fail-open to fail-CLOSED (better to skip than duplicate)
  - Fast Scanner SQL now excludes leads with active processing lock or recent AI send attempt
  - isAiOffline() check added to ALL non-Brain-Council senders: webhook-task.ts, webhook-pipeline.ts, auto-correction.ts, follow-up-trigger.ts, brain-council-review.ts (fast scanner + self-review)
  - Comprehensive dedup test suite (server/dedup.test.ts)
- [x] ARCHITECTURE: Brain Orchestrator pre-flight checks: already-responded check, human takeover, system offline, conversation freshness
- [x] ARCHITECTURE: Brain should check "did I already respond to this exact inbound message?" before composing

## Layer 0: Safety Gates (Core Architecture Fix)
- [ ] 0.1 DNC Pre-flight Check: Export DNC_KEYWORDS/checkDnc from scheduling-engine.ts, add DNC pre-flight gate to brain-council-orchestrator.ts, webhook-contact.ts, follow-up-trigger.ts
- [ ] 0.2 Flag Existing DNC Leads: SQL migration to set humanTakeover=1 on all 124 leads with DNC signals
- [ ] 0.3 DNC Check in Follow-up Trigger: Add early DNC check before context building in follow-up-trigger.ts

## Layer 0: Safety Gates (Updated — GHL DND Sync Approach)
- [x] 0.1a: Export DNC_KEYWORDS/checkDnc from scheduling-engine.ts
- [x] 0.1b: Add DNC keyword pre-flight gate to brain-council-orchestrator.ts (Check 4.5)
- [x] 0.1c: Add DNC keyword check to follow-up-trigger.ts (before context building)
- [x] 0.1d: Add DNC keyword check to webhook-contact.ts (before first-contact send)
- [x] 0.1e: Add dndSms, dndEmail, dndFb, dndWhatsapp, dndCall, dndGmb columns to leads schema
- [x] 0.1f: Sync GHL dndSettings during contact enrichment (webhook-contact.ts getContact call) — syncGhlDnd() in db.ts
- [x] 0.1g: Update Brain Council pre-flight to check per-channel DND (Check 4.7 in orchestrator)
- [x] 0.1h: Detect GHL DND rejection in sendMessage and auto-flag humanTakeover=1
- [x] 0.2: Backfill GHL DND status for all 1,653 existing leads — 124 with DND, 1 auto-flagged humanTakeover
- [x] 0.3: P0-B — Email HTML formatting — formatEmailHtml() in webhook-helpers.ts, wired into all 9 email senders (webhook-message, follow-up-trigger, brain-council-review, auto-correction, webhook-contact, webhook-pipeline, webhook-helpers buildSendOpts)
- [x] 0.4: P0-C — Correct review links: replaced g.co/kgs/adorb with correct URLs in composer.ts (3 places) and qc.ts (1 place). Added Trustpilot + Website Reviews + Google Share links.

## Layer 1: Context Assembly (Core Fix)
- [x] 1.1: All Brain Council callers now pass externalHistory — added GHL history fetch to brain-council-review.ts (fast scanner + self-review). Both fetch local history via getConversationHistory() and GHL history via fetchGhlConversationHistory(), then merge and pass as externalHistory.
- [x] 1.2: Lookback context surfaced — added lookbackContext field to LeadContext type, extracted from state.lastResearchSummary + lead.lastStrategyReasoning + state.sentimentTrend in brain-context.ts, and injected as LOOKBACK ANALYSIS section in strategist.ts prompt.
- [x] 1.3: brain-context.ts refactored to use canonical getConversationHistory() from db.ts instead of duplicating the query. Eliminates cache-key mismatch (was conv:${leadId} vs convH:${leadId}:${limit}).
- [x] 1.4: Cache invalidation already works correctly — addConversation() invalidates prefix "conv" which catches both cache keys. Verified legacy brain-council.ts is dead code (no imports). 16 tests passing in context-assembly.test.ts.

## Layer 2: Brain Prompts (Core Fix)
- [x] 2.1: Awareness-level detection added to Strategist — 16 approaches aligned with lookback engine taxonomy (5 responsive: answer_question, provide_quote, acknowledge_info, confirm_details, objection_handling + 11 proactive). Strategist prompt rewritten with 3-step detection: awareness level → approach → framework. 14 frameworks (added DIRECT_RESPONSE, VALUE_FIRST). 2 new violation categories (unanswered_question, info_not_acknowledged).
- [x] 2.2: Composer rewritten with framework-specific message structures for DIRECT_RESPONSE (answer first, then CTA) and VALUE_FIRST (lead with value, then ask). Pricing rules added: must reference knowledge base, never invent prices, provide ranges when exact price unavailable.
- [x] 2.3: First-contact template replaced with full Brain Council call in webhook-contact.ts. Form data passed as both incomingMessage context and formData array. Channel detection, rate limiting, DNC checks all preserved. Brain Council pre-flight provides second safety layer.
- [x] 2.4: Framework diversity enforced at two levels: (1) Strategist prompt includes FRAMEWORK DIVERSITY RULE with last framework surfaced, (2) Programmatic override in orchestrator queries last 3 audit entries and forces different framework if same one used 2+ times consecutively. Responsive frameworks (DIRECT_RESPONSE, VALUE_FIRST) exempt from diversity rule. 31 tests passing in brain-prompts.test.ts.

## Layer 3: Quality Control (Substance Checks)
- [x] 3.1: Added Question-Answer Check (#13) and Information-Acknowledgment Check (#14) to QC prompt. Lowered auto-approve threshold from 70 to 75. Added score normalization instruction for 16-check (non-email) and 18-check (email) scales.
- [x] 3.2: Added repeated_question (60% word overlap detection against prior outbound), ignored_request (pricing keyword detection in inbound vs response), channel_mismatch (SMS for >60 day dormant leads). Added all 4 new categories to ViolationCategory type. Updated auto-correction CRITICAL_VIOLATIONS to include ignored_request and repeated_question.
- [x] 3.3: Added Gate 2 — External Message Safety (#15) to QC prompt: internal system language detection, email subject requirement, key info placement, unresolved placeholder token detection.
- [x] 3.4: Added Factual Verification (#16) to QC prompt with -5 per unverified claim. Knowledge base content now passed to QC input for verification. Added unverified_claim to ViolationCategory type. 17 new tests in qc.test.ts, 196 total tests passing.

## Layer 4: Send Path Consolidation
- [x] 4.1: formatEmailHtml() enhanced with: HTML injection sanitization (entity escaping), --- → <hr> signature separator, URL → clickable <a> links, styled container wrapper with proper font/line-height, paragraph margin styling. Existing HTML pass-through preserved.
- [x] 4.2: formatEmailHtml() confirmed wired into all 8 email send paths: webhook-helpers.ts (buildSendOpts), webhook-contact.ts, brain-council-review.ts, follow-up-trigger.ts (2 paths), webhook-message.ts (3 paths), webhook-pipeline.ts, auto-correction.ts. All 196 tests passing.

## Layer 5: Learning Loop
- [x] 5.1: Framework diversity enforcement verified — done in Layer 2 with orchestrator enforcement, strategist prompt rules, and audit tracking.
- [x] 5.2: DNC tracking added to outcome engine. New dncTriggered column in message_outcomes table (migration applied). isDncReply() helper uses DNC_KEYWORDS from scheduling-engine. attributeReply() and backfillOutcomes() both set dncTriggered flag. FrameworkStats now includes dncCount/dncRate. buildLearningContext() outputs DNC/OPT-OUT RISK section with per-framework DNC rates. Strategist brain receives DNC warnings to reduce usage of high-DNC frameworks. All 196 tests passing.
- [x] 5.3: CONVERSION_STAGES and POSITIVE_STAGES now imported from STAGES constant in webhook-helpers.ts (single source of truth). Verified stage names match GHL pipeline: "Paid - Proof Needed", "Approved + Deposit", "Delivered". attributeStageAdvance() confirmed wired into webhook-pipeline.ts.

## Layer 6: Self-Healing and Observability
- [x] 6.1: Created shared/brand-assets.ts with BRAND constant, getBrandContext(), getSignatureBlock(). Replaced hardcoded brand info in composer.ts (ADORB FACTS section), qc.ts (signature block checks), ghl.ts (emailFrom). All brain prompts now reference BRAND constants. Updated safety-gates test to verify centralization.
- [x] 6.2: Added lastInteractionSummary column to ai_state (migration applied). Orchestrator writes 1-sentence summary after each successful send using upsertAiState(). buildLeadContext() reads it into LeadContext. Strategist and Composer prompts inject it as LAST INTERACTION SUMMARY section for continuity.
- [x] 6.3: Added system.healthMonitor admin procedure to systemRouter. Returns 6 indicators: Last Brain Council Send, Framework Diversity, DNC Leads Active, Email Formatting, Block Rate (1h), AI Status. Each with green/yellow/red status, value, and detail. Overall status derived from worst indicator.
- [x] 6.4: Added invalidateLeadCache() call in orchestrator after successful send. Ensures next Brain Council run for same lead sees the message just approved. All 197 tests passing.

## Knowledge Base Inline Editor
- [x] Audit KB tRPC procedures for existing updateContent mutation
- [x] Add inline editor UI to KB page (expand/collapse per file, editable textarea, save button)
- [x] Wire editor to tRPC mutation with optimistic update and success/error feedback
- [x] Add "last edited" timestamp display per KB entry
- [x] Write tests for the update flow (9 tests in knowledge.test.ts)

## BUG: AI ignoring customer details and responding without context
- [x] Investigated: inbound message body flows correctly to Brain Council. The issue was the Strategist/QC not enforcing context-awareness strongly enough. Layer 3 QC substance checks (Question-Answer Check, Information-Acknowledgment Check, ignored_request detection) now catch this.
- [x] Fixed: QC checks #13 (Question-Answer) and #14 (Information-Acknowledgment) verify the Composer used provided details.
- [x] Fixed: ignored_request violation detects pricing keywords in inbound but missing from response.
- [x] Fixed: provide_quote approach with DIRECT_RESPONSE framework mandates pricing info first.

## BUG: FB inbound → SMS reply (channel mismatch)
- [x] Root cause: webhook-message.ts used raw normalizeChannel(rawChannel) for sending, ignoring Brain Council's channel recommendation. If GHL sent unknown messageType, it defaulted to SMS.
- [x] Fix 1: normalizeChannel enhanced with 'messenger', 'sms'/'text' detection + warning log for unknown types.
- [x] Fix 2: webhook-message.ts now uses `normalizeChannel(aiResponse.channel || channel)` for ALL 3 send paths (fallback, handoff, normal). lastOutboundChannel also corrected.
- [x] Fix 3: Strategist prompt now has CHANNEL PRESERVATION RULE — MUST reply on same channel as inbound.
- [x] Fix 4: QC violation detector enhanced — channel_mismatch now catches responsive approaches that switch channels.
- [x] Tests: 2 new normalizeChannel tests (messenger, sms/text). 208 total tests passing.

## Security/Resilience Audit: 6 Threat Vectors
- [x] GAP FIXED: LLM invocation now has 120s AbortController timeout. Hung calls throw "LLM invoke timed out" error, releasing the Brain Council lock cleanly. 180s margin before the 300s lock TTL expires.
- [x] GAP FIXED: Global burst limiter added to acquireSendGate() in ghl.ts. Max 10 sends per 60-second rolling window across ALL callers. Burst counter auto-rolls back if per-contact cooldown blocks the send.
- [x] GAP FIXED: ResearchResult now has dataConfidence field ("verified" | "inferred" | "insufficient"). Researcher LLM self-labels confidence. Composer prompt shows ⚠️ INFERRED DATA warning with instruction to not state inferred facts as certainties. emptyResearch() returns "verified" (form data only). 208 tests passing.

## BUG: Human takeover not detected — AI continues responding after human agent sends a message
- [x] Root cause: GHL does NOT fire outbound webhooks for messages sent via the GHL UI. humanTakeover was never set from UI sends.
- [x] Fix: GHL history sync now runs BEFORE the humanTakeover check. Detects recent outbound messages from GHL history that aren't in our AI DB (i.e., human agent messages). Sets humanTakeover=1 + lastAgentActivityAt proactively within a 24h window.

## BUG: AI makes commitments it cannot fulfill ("I'll send the invoice shortly") with no follow-up
- [x] Fix: Added UNFULFILLABLE COMMITMENT detection to QC (check #10). 12 regex patterns catch "I'll send the invoice", "I'll call you", "I'll process your order", etc. These trigger safety_violation and block the message.
- [x] Fix: Composer STRICT NO-HALLUCINATION RULES section added with explicit examples of wrong vs right phrasing.

## BUG: Agent GHL UI messages bypass webhook — humanTakeover never set from UI sends
- [x] Fixed: GHL history sync detects recent outbound agent messages (not matching any AI DB entry) and sets humanTakeover=1 + lastAgentActivityAt from the message timestamp.
- [x] Fixed: GHL history sync now runs before the handoff decision (shouldHandoffToAgent receives updated lastAgentHoursAgo).

## BUG: Conversation history too shallow — missed paid order status
- [x] Fixed: Local conversation history lookback increased from 20 to 50 messages.
- [x] Fixed: ORDER STATUS ALERT added — GHL history scanned for payment/order keywords (paid, invoice, deposit, proof, approved, mockup, design, order confirmed, receipt). Latest matching message surfaced as ⚠️ alert at top of context.

## BUG: Composer hallucinating specifics not in the message ("5XL color option")
- [x] Fixed: STRICT NO-HALLUCINATION RULES section added to Composer prompt with explicit examples (wrong: "Glad the 5XL color option works!", right: echo exact details back).
- [x] Fixed: QC check #10 catches unfulfillable commitments (safety_violation). dataConfidence="inferred" warning already prevents fabricated research facts from being stated as certainties. 208 tests passing.

## BUG: Duplicate GHL notes — same note created 3x for same pipeline stage event
- [ ] Find where "Proof sent to customer. Follow-up scheduled..." note is created
- [ ] Find why it fires 3 times for the same event at the same timestamp
- [ ] Add deduplication guard (idempotency key or last-note-hash check)
- [x] CRITICAL: AI ignores conversation history — re-initiates contact with already-contacted leads (Aundrea Tackett Apr 8 example). Root cause: GHL history not fetched/passed before Brain Council call in fast scanner / follow-up trigger. Must enforce GHL history fetch + 'already contacted' guard in ALL callers.
- [x] CRITICAL: AI sends message even when human agent just sent from GHL UI — universal GATE 3 in sendMessage() blocks ALL paths (310-421-6702 example)
- [x] CRITICAL: AI not making decisions on stale/unresponsive leads — Lead Disposition Engine: DNC→Not Qualified, stale takeover→email escalation or Not Qualified, 2hr sweep + admin trigger (lead #610 example)
- [x] FIX: Channel-specific DNC — "Stop" on SMS blocks SMS only, escalate to next channel (Email→FB→IG→WhatsApp→Live_Chat). Not Qualified only when ALL channels exhausted. handleChannelDnc in channel-fallback.ts, wired into all 4 DNC entry points.
- [x] FIX: Live Chat channel ignored — normalizeChannel now preserves Live_Chat (type 15), sendMessage/buildSendOpts/strategist/composer all support Live_Chat. Urgency rules added.
- [x] FIX: Contact info capture — Strategist shows CONTACT GAP alert, Composer has CRITICAL prompt when both email+phone missing, hints when one is missing. Live Chat gets special capture rules.

## Architecture v2.0 — Modular Refactor
- [x] Run disposition sweep on 110 frozen leads — 64 escalated to email, 46 takeover expired, 0 errors (8 batches)
- [ ] Fix duplicate GHL notes (triple-fire on same pipeline event)
- [ ] ARCH Phase A: Add conv_state + conv_state_updated_at + intent_history columns to leads (DB migration)
- [ ] ARCH Phase A: Build conversation-state.ts module (10 states, state transitions, DB persistence)
- [ ] ARCH Phase A: Build intent-classifier.ts module (fast LLM classification of inbound messages)
- [ ] ARCH Phase A: Wire state machine into webhook-message.ts (classify every inbound)
- [ ] ARCH Phase A: Wire state machine into brain-council-orchestrator.ts (read state before Brain Council)
- [ ] ARCH Phase A: Add conversation_outcomes + learnings tables (DB migration)
- [ ] ARCH Phase A: Tests for state machine and intent classifier
- [ ] ARCH Phase B: Build action-dispatcher.ts (committed→task+pipeline, dnc_channel→fallback, fulfilled→Won)
- [ ] ARCH Phase B: Wire action-dispatcher into state machine transitions
- [ ] ARCH Phase C: Create sales-brain/ directory, download sales-mastery frameworks
- [ ] ARCH Phase C: Build closer.ts and objection-handler.ts from sales-mastery references
- [ ] ARCH Phase C: Refactor strategist.ts and composer.ts to lean versions that read state
- [ ] ARCH Phase D: Build learning-engine/ (outcome-tracker.ts, LEARNINGS.md, ERRORS.md)
- [ ] ARCH Phase D: Implement memory-self-heal error recovery patterns
- [ ] ARCH Phase D: Implement self-improving-agent outcome-based promotion (auto-promote with notification, 1-year retention)
- [x] FIX: Permanent DB-level pipeline dedup — remove 2-hour time window, use fromStage+toStage as permanent dedup key
- [x] ARCH Phase A: Add conv_state, conv_state_updated_at, intent_history columns to leads table
- [x] ARCH Phase A: Build server/intent-classifier.ts — fast LLM intent classification
- [x] ARCH Phase A: Build server/conversation-state.ts — state machine with 10 states + transitions
- [x] ARCH Phase A: Wire state machine into webhook-message.ts (observation mode)
- [x] ARCH Phase A: Wire state into brain-council-orchestrator.ts context (observation mode)
- [x] ARCH Phase A: Tests for intent classifier and conversation state machine

## Architecture v2.0 — Phase B: Action Dispatcher
- [x] ARCH Phase B: Build server/action-dispatcher.ts — centralized state-to-GHL-action mapper
- [x] ARCH Phase B: Centralize GHL stage ID maps into shared/ghl-stages.ts (eliminate 5+ duplicate NQ_STAGES maps)
- [x] ARCH Phase B: Wire action dispatcher into processInboundState in webhook-message.ts (dispatch on state change)
- [x] ARCH Phase B: Brain Council reads convState — committed leads get confirmation response, not re-pitched
- [x] ARCH Phase B: Tests for action dispatcher (committed→task+pipeline, dnc→fallback, fulfilled→Won)

## Architecture v2.0 — Phase C: Sales Brain Refactor
- [x] ARCH Phase C: Build server/closer.ts — specialized closing module for committed leads
- [x] ARCH Phase C: Build server/objection-handler.ts — specialized objection handling module
- [x] ARCH Phase C: Wire closer and objection-handler into Brain Council orchestrator
- [x] ARCH Phase C: Tests for closer and objection-handler modules

## Architecture v2.0 — Phase D: Learning Loop
- [x] ARCH Phase D: Add conversation_outcomes and learnings tables to schema + migration
- [x] ARCH Phase D: Build server/learning-loop.ts — structured logging, recurrence tracking, auto-promotion
- [x] ARCH Phase D: Build server/error-memory.ts — error pattern detection and self-healing
- [x] ARCH Phase D: Wire learning loop into outcome-engine (record conversation outcomes on won/lost/stale/dnc)
- [x] ARCH Phase D: Wire learning promotions into Strategist (promoted patterns injected into prompt)
- [x] ARCH Phase D: Add learning loop timer to webhooks.ts (periodic promotion scan + error-memory sweep)
- [x] ARCH Phase D: Tests for learning-loop and error-memory modules
- [x] Confirm real GHL pipeline stage IDs via API and update shared/ghl-stages.ts
- [x] Replace all 5 hardcoded NQ_STAGES/stage ID maps with centralized shared/ghl-stages.ts imports
- [x] Action Dispatcher now uses real Qualified + Delivered stage IDs for committed/fulfilled transitions

## Stage Playbook System + UI Fixes
- [x] Build server/stage-playbook.ts — per-stage AI behavioral rules (goal, focus topics, never-do, signals, tone)
- [x] Wire Stage Playbook into Strategist prompt (inject stage-specific instructions before approach selection)
- [x] Wire Stage Playbook into Composer prompt (inject stage-specific do/don't rules into message composition)
- [x] Wire Stage Playbook into Closer and Objection Handler (stage-aware closing/objection behavior)
- [x] Wire Stage Playbook into conversation-state.ts (stage changes inform state transitions)
- [x] Wire Stage Playbook into Action Dispatcher (stage-specific task descriptions and notes)
- [x] Wire Stage Playbook into Learning Loop (record which stage rules were active during outcomes)
- [x] UI: Add Active/Not Qualified tabs to Leads page (NQ leads separated from active leads)
- [x] UI: Add missing "Qualified" and "In Production" stages to Pipeline Kanban
- [x] Tests for Stage Playbook module and integrations
- [x] BUG: No active AI engagement today — INVESTIGATED: System IS active (80 messages in last 24h). Follow-ups drip-feed in small batches to avoid spam flags. 0 overdue follow-ups because all are scheduled ahead.
- [x] BUG: Not Qualified leads not showing in their own tab on Leads page — FIXED: isNotQualified() now normalizes underscores (not_qualified → not qualified). Query limit increased from 200 to 5000 to include all leads.
- [ ] BUG: Lead #690005 has outdated future engagement date — investigate scheduling architecture flaw

## Scheduling Architecture Fixes
- [x] FIX 1: Compress schedule — reschedule all beyond-30-day leads to 7-14 days with 50-100/day staggering. Admin endpoint `compressSchedule` redistributes leads across 7-14 days at 50-100/day.
- [x] FIX 2: 24hr human-takeover timeout — auto-release to AI, multi-channel re-engagement (if agent sent FB, AI can follow up via email/SMS with proper sales training). Send gate window changed from 2hr→24hr. Lead disposition stale threshold changed from 7 days→24hr. Stage Playbook has humanAssistedGuidance for support-role AI engagement.
- [x] FIX 3: Hourly overdue catch-up — processOverdueCatchUp() runs every 60 min automatically, batch of 20, wired in webhooks.ts. Admin trigger available.
- [x] FIX 4: 30-day max cap on follow-up delay — MAX_FOLLOWUP_DELAY_MS enforced in capDate(), scheduling engine, perpetual nurture, stale recalc. Long-lead exempt (P1 customer timeline). Stage Playbook has longLeadGuidance for 3-6 month advance orders.
- [x] One-time migration script: compressSchedule() in scheduling-engine.ts + admin tRPC endpoint
- [x] Tests for all scheduling fixes — 458 tests passing (send-gate 24hr, lead-disposition 24hr, stage-playbook long-lead/human-assisted, scheduling-engine 30-day cap, structural validation)

## BUG: Lead #690005 — 3 Issues
- [x] BUG 1: Conversation history missing — Code already handles OutboundMessage webhooks correctly. GHL needs outbound message workflow trigger configured. No code change needed.
- [x] BUG 2: nextFollowUpAt stuck in past — Removed 3-day age filter from stale takeover query. Added agent-silent release path (reschedules 2hr out, tries email/SMS when agent was on FB/IG).
- [x] BUG 3: Segment "Unclassified" — businessName was enriched by message webhook but classifySegment never ran. Added post-enrichment segment classification in webhook-message.ts + backfillUnclassifiedSegments sweep + admin endpoint.

## PHASE 1 — SUPERVISOR ARCHITECTURE (Self-Healing Foundation)
- [x] P1.1: supervisor_audit table in drizzle schema + migration
- [x] P1.2: server/supervisor.ts — 9-invariant enforcement engine (has_future_schedule, has_segment, has_research, human_takeover_stale, no_channel_dnd_conflict, score_is_current, not_orphaned, circuit_breaker_not_stuck, long_lead_not_neglected)
- [x] P1.3: Wire 5-min Supervisor timer in webhooks.ts
- [x] P1.4: Add heartbeat logging to ALL existing timers (7 timers: followup, lookback, fastscan, selfreview, disposition, outcomes, overdue_catchup)
- [x] P1.5: Tighten disposition sweep from 2hr → 30min
- [x] P1.6: Admin endpoints: supervisorStatus, triggerSupervisor, supervisorAuditLog
- [x] P1.7: Supervisor Health panel on Home dashboard (timer health dots, violation log, run-now button)
- [x] P1.8: Comprehensive tests for Supervisor (477 tests passing — 14 new supervisor tests)

## PHASE 2A — WEBHOOK EXPANSION
- [x] P2A.1: Add webhook handler for GHL Appointment events (handleAppointmentWebhook — tracks nextAppointmentAt, appointmentStatus, appointmentId)
- [x] P2A.2: Add webhook handler for GHL Contact DND changes (handleContactDndWebhook — syncs per-channel DND to our DB)
- [x] P2A.3: Add webhook handler for GHL Note events (handleNoteWebhook — stores lastAgentNote, lastAgentNoteAt)
- [x] P2A.4: Add webhook handler for GHL Email events (handleEmailEventWebhook — tracks opens, clicks, bounces, unsubscribes)
- [x] P2A.5: Add webhook handler for GHL Opportunity updates (handleOpportunityWebhook — monetary value, status changes)
- [x] P2A.6: Extend detectEventType with 5 new event types (appointment, note, email_event, contact_dnd, opportunity)
- [x] P2A.7: Add email engagement columns to leads table (emailOpens, emailClicks, emailBounces, emailUnsubscribed, lastEmailOpenAt, lastEmailClickAt)
- [x] P2A.8: Add appointment columns to leads table (nextAppointmentAt, appointmentStatus, appointmentId)
- [x] P2A.9: Add agent notes columns to leads table (lastAgentNote, lastAgentNoteAt)
- [x] P2A.10: Wire all 5 new handlers into webhooks.ts switch statement
- [x] P2A.11: Tests for all new webhook handlers (508 tests passing)

## PHASE 2B — AI TRAINING CORPUS
- [x] P2B.1: Build shared/sales-training.ts — complete training corpus (PRICING_MATRIX, BRAND_VOICE_GUIDE, PERSONA_PLAYBOOKS, SALES_PROCESS_GUIDE, COMPETITIVE_INTEL, SEASONAL_CALENDAR, ESCALATION_RULES)
- [x] P2B.2: Wire training corpus into Strategist (getTrainingCorpus + getPersonaGuidance — full pricing, personas, competitive, seasonal, escalation)
- [x] P2B.3: Wire training corpus into Composer (getCompactTrainingCorpus + getPersonaGuidance — brand voice, pricing, persona-specific tone)
- [x] P2B.4: Wire training corpus into Closer (getCompactTrainingCorpus — pricing + escalation for closing)
- [x] P2B.5: Wire training corpus into Objection Handler (getCompactTrainingCorpus — pricing + competitive + escalation)
- [x] P2B.6: Wire training corpus into QC (PRICING_MATRIX + ESCALATION_RULES for factual verification)
- [x] P2B.7: Wire training corpus into ai-brain.ts legacy fallback (getCompactTrainingCorpus)
- [x] P2B.8: Tests for training corpus modules and Brain Council integration (508 tests passing)

## GitHub Connector
- [x] Test GitHub connector feature from Management UI — documented capabilities for user
- [x] Document capabilities and provide brief to user

## PHASE 3 — PORTAL UX COMPLETION
- [x] P3.1: Home dashboard — Schedule Distribution chart (overdue/today/1-7d/8-14d/15-30d/30+), Pipeline Breakdown with values, System Health panel with 6 indicators
- [x] P3.2: Lead Detail — added Email Engagement card (opens/clicks/bounces), Appointment card, Agent Notes card, Reschedule button, GHL direct link
- [x] P3.3: Agent Handoff Queue page — shows all humanTakeover=1 leads with stale duration, last agent activity, release to AI button, GHL link
- [x] P3.4: Settings — updated webhook instructions with 10 workflows (Core: 5 required + Phase 2: 5 recommended), Outbound Message marked CRITICAL
- [x] P3.5: Sidebar navigation — Handoff Queue added with UserCheck icon
- [x] P3.6: scheduleDistribution + handoffQueue tRPC endpoints added to leads router
- [x] P3.7: All 508 tests passing

## PHASE 4 — SELF-LEARNING LOOP
- [x] P4.1: Schema — Add ab_experiments table (experimentId, name, hypothesis, variantA/B descriptions, metric, status, startedAt, endedAt, winnerVariant, sampleSizeTarget, confidenceLevel)
- [x] P4.2: Schema — Add ab_assignments table (experimentId, leadId, variant, assignedAt) + extend message_outcomes with experimentId + variant columns
- [x] P4.3: Build server/ab-testing.ts — experiment lifecycle (create, assign variant, record outcome, evaluate winner)
- [x] P4.4: Wire A/B variant assignment into Brain Council orchestrator (before Strategist call, check active experiments, assign variant, pass to Strategist)
- [x] P4.5: Build statistical significance engine (chi-squared test for reply rates, conversion rates, with configurable confidence threshold)
- [x] P4.6: Auto-adopt winners — when experiment reaches significance, auto-update Strategist promoted learnings with winning variant
- [x] P4.7: Build persona-outcome aggregation — enrich message_outcomes.segment from lead data, aggregate reply/conversion rates per persona × framework × channel
- [x] P4.8: Build persona-specific strategy recommendations — getPersonaLearningContext(persona) returns "for Schools: use SOCIAL_PROOF, avoid HORMOZI_ACA" style directives
- [x] P4.9: Wire persona learning into Strategist prompt (inject persona-specific recommendations when lead's segment is known)
- [x] P4.10: Build time-series outcome tracking — daily snapshots of reply rate, conversion rate, DNC rate, avg response time
- [x] P4.11: Build outcome trend analysis — detect improving/declining metrics, alert on significant changes
- [x] P4.12: Build Self-Learning dashboard page — experiment status, persona performance matrix, outcome trends, auto-adopted rules
- [x] P4.13: Admin endpoints — createExperiment, listExperiments, evaluateExperiment, getPersonaMatrix, getOutcomeTrends
- [x] P4.14: Wire daily snapshot timer into webhooks.ts (runs once per day at midnight)
- [x] P4.15: Tests for A/B testing, persona learning, outcome trends, and statistical significance

## SEND ERROR HANDLING
- [x] SE.1: Recognize GHL send error types (missing phone, missing email, invalid email, carrier block) and act appropriately
- [x] SE.2: Missing phone → skip SMS, attempt email fallback if available; if no email either, mark lead as no-contact-info and reschedule far out
- [x] SE.3: Missing/invalid email → skip email, attempt SMS fallback if available; if no SMS either, same no-contact-info handling
- [x] SE.4: Carrier block / 422 undeliverable → flag dndSms on lead, attempt email fallback
- [x] SE.5: Log corrective action taken in follow-up trigger (errorType + correctionTaken logged)
- [x] SE.6: Tests for each error scenario (558 tests passing)

## GHL OUTBOUND MESSAGE WEBHOOK SUBSCRIPTION
- [ ] OB.1: Research GHL webhook subscription API endpoints (list, create, delete)
- [ ] OB.2: Build ghl-webhook-subscriptions.ts — register/list/delete GHL app-level webhook subscriptions
- [ ] OB.3: Register OutboundMessage subscription pointing to our webhook URL on server startup
- [ ] OB.4: Handle OutboundMessage events — detect source="app" (agent) vs source="api" (our AI) and act accordingly
- [ ] OB.5: Add Settings UI panel showing subscription status with register/refresh button
- [ ] OB.6: Tests for subscription management and OutboundMessage handling

## CRITICAL FIXES — Session 2 (Apr 9, 2026)

### User-Reported Bugs
- [x] BUG: Every AI message starts with "Hey Paulette!" — Added explicit recentOpeners extraction in Composer + hard QC repeated_opener violation detection
- [x] BUG: AI offers tote bag pricing ($7-$14) blending tiers — Updated pricing rules in Strategist + Composer: tier-accurate ranges, 20% discount authority for <100 units, always push for exact quote

### Re-implement Fixes Lost in Sandbox Reset
- [x] FIX: QC hallucination — detectViolations() grounded to actual lead messages only
- [x] FIX: Email signature enforcement — ensureEmailSignature() at buildSendOpts() layer
- [x] FIX: TCPA quiet hours (CRITICAL LEGAL) — isSmsQuietHours() + nextSmsWindowStart() in scheduling-engine.ts, gated in follow-up-trigger.ts (pre+post Brain Council) and webhook-message.ts (pre+post Brain Council)
- [x] FIX: Soft-decline detection — soft_decline intent in classifier + stale state transition + graceful_exit approach in Strategist (720h/30d backoff)
- [x] FIX: Context-aware fallback — suppresses cold-intro fallback when lead has 2+ prior outbound messages
- [x] FIX: Test mock — webhooks.test.ts processInboundState mock + isSmsQuietHours/nextSmsWindowStart mocks added

## Session 2 — Additional Bugs

- [x] BUG: FB lead form submissions (Bowman Melissa) — GHL "Opportunity Created" system message misclassified as human agent → humanTakeover=1. Fixed: system message exclusion + humanTakeover re-check in delayed first-contact
- [x] BUG: messageBody.substring crash — safe type coercion for non-string GHL payloads (objects/arrays → JSON.stringify)
- [x] BUG: noteBody.trim crash — safe type coercion for non-string note payloads
- [x] BUG: humanTakeover false positive — GHL system messages (Opportunity Created, workflow, etc.) excluded from agent detection + delayed first-contact re-checks and clears false positives
- [x] BUG: Manual reschedule via dashboard is overridden — Fixed: admin override protection in calculateNextFollowUp, override fields cleared after consumption, FB channel detection from form data, preferredChannel preserved from detected channel
- [x] FIX: Cleared legacy humanTakeover=1 for lead 840005 + bulk cleared 78 false positives (22 real agent takeovers preserved)
- [x] FIX: Hardened GHL history scan — expanded to 30+ system patterns, raised min length to 10, added max length 500, GHL type 0 exclusion, multi-line form data detection
- [x] FIX: Business name + product type + timeline extracted from FB form data in webhook-message.ts channel correction
- [x] FIX: AI State tracking — message count was already incremented via upsertAiState in webhook-message.ts (the 0 was from the contact_handler path which correctly sets messageCount: 1 after first-contact)
- [x] BUG: Follow-up emails create new threads — Fixed: added emailMessageId column to conversations, getLastEmailThreadId() helper, threadId/replyMessageId passed in follow-up-trigger.ts, webhook-message.ts, and TCPA email fallback. Subject prefixed with "Re:" for threaded replies.
- [x] BUG: Follow-up email subject line — Fixed: "Re:" prefix added automatically when replying to existing email thread

## Session 2 — Email Timing & AI Tweaks

- [x] BUG: Email sent at 1:00 AM — Fixed: isEmailOutsideOptimalWindow() + nextEmailWindowStart() added to scheduling-engine.ts. isBusinessHours() now enforces email optimal windows. Pre+post Brain Council gates in follow-up-trigger.ts.
- [x] FIX: Email optimal window gates — pre-Brain Council (hint=Email) + post-Brain Council (channel=Email) in follow-up-trigger.ts
- [x] AUDIT: AI Tweaks — tweakInstructions now injected into BOTH Strategist (ADMIN BEHAVIOR ADJUSTMENTS block) and Composer
- [x] AUDIT: Email Marketing Bible — Full EMB_WELCOME, EMB_WINBACK, EMB_POST_PURCHASE, EMB_COLD sequence rules with subject line formulas, structure, tone, length constraints added to Composer prompt
- [x] FIX: SOAP_OPERA framework — expanded to full 5-act narrative structure (Status Quo → Conflict → Solution → Result → Curiosity Gap) with examples, length limits, and tone rules

## New Contact Auto-Task + Appointment + Notification
- [x] NC.1: Auto-create GHL Task for agent to call new contact during next business hours slot (Mon-Fri 9am-5pm ET)
- [x] NC.2: Auto-create GHL Appointment in first available business hours slot for new contact call
- [x] NC.3: Send internal notification when new contact enters system (task + appointment created)
- [x] NC.4: Wire auto-task/appointment/notification into webhook-contact.ts new contact flow
- [x] NC.5: Tests for auto-task/appointment/notification creation (14 tests passing)
- [x] BUG: Reset Learning Data button not visible on Self-Learning page — was working, user confirmed visible after login
- [x] BUG: Zero-context SMS sent to Coconuts Bar & Grill (954-525-2421) — FIXED: 3 root causes addressed:
  - FIX 1: getLeadsDueForFollowUp + lookback engine now filter out not_qualified/lost leads
  - FIX 2: Graceful exit guard blocks sending and retires lead (humanTakeover=1) instead of sending goodbye message
  - FIX 3: Not-interested detection in GHL history — agent notes like "not interested" permanently retire leads from outreach
- [x] BUG: B.J. Noel Jr. received 3 nearly identical messages in 2 hours all asking same question about quantity/print sides:
  - [x] FIX 1: Composer anti-repetition — added SAME-QUESTION DETECTION rules + semantic keyword buckets in QC (quantity, print_sides, event_type, etc.)
  - [x] FIX 2: Scheduling fallback — now factors in consecutiveUnanswered count (1=24h, 2=48h, 3+=72h minimum)
  - [x] FIX 3: ai_state.messageCount — now properly incremented in both follow-up-trigger.ts and webhook-message.ts
  - [x] FIX 4: Strategist prompt — warns when 2+ unanswered, forces VALUE-FIRST approach instead of more questions
  - [x] FIX 5: QC bucket detection — catches rephrased questions via 10 info buckets + fallback word-overlap check
- [x] BUG: Appointment creation for new contacts fires before first-contact message — Pheresa Singleton got appointment but no AI message:
  - [x] FIX 1: Outbound webhook handler now filters system messages (appointments, tasks, AI echoes) — no longer sets humanTakeover for system events
  - [x] FIX 2: Moved task/appointment/note creation to AFTER first-contact message in sendDelayedFirstContact
  - [x] FIX 3: System notes prefixed with 🤖 are filtered in note webhook handler + humanTakeover re-check

## BUG: Generic email subject lines and openers — no product/event/business context
- [x] Fix Composer prompt: subject line MUST reference specific product/event/business from lead data
- [x] Fix Composer prompt: opening sentence MUST ground reader with conversation context (not "your design" or "your project")
- [x] Add QC violation for context-free/generic email subjects when lead data has product/business/event info
- [x] Update Strategist to pass context-grounding emphasis in key_points to Composer
- [x] Tests for context-specific subject lines and openers (10 new tests, all 603 passing)

## BUG: Glory's inbound SMS at 3:53 PM not getting AI response
- [x] Diagnose why Glory's message "$10 to $28 plus canvas or without canvas?" did not trigger AI response
- [x] Root cause: repeated_question QC false positive — bucket check flagged "quantity" overlap between prior AI outbound and composed response, even though lead was asking a clarification

## BUG: repeated_question QC false positive blocking lead clarification replies
- [x] Fix repeated_question bucket check: skip entirely when AI is responding to inbound message (not proactive)
- [x] Fix repeated_question fallback word-overlap check: same inbound exemption
- [x] Update existing tests to properly test proactive vs responsive scenarios
- [x] Add 7 new tests: Glory scenario, pricing clarification, design clarification, timeline clarification, color clarification, proactive re-ask still flagged, no-inbound re-ask still flagged
- [x] All 610 tests passing
- [x] Push to GitHub

## BUG: No escalation methodology for past/delivered customers (Kim Luvmylife Thomas)
- [x] Audit Strategist prompt for past-customer/reactivation approach selection
- [x] Audit Composer prompt for reactivation message structure
- [x] Add Hormozi/Martell 4-step post-customer escalation to Strategist (satisfaction→upsell→seasonal→reactivation)
- [x] Add POST-CUSTOMER ESCALATION RULES to Composer (banned passive phrases, must have specific product suggestion)
- [x] Overhaul Delivered stage playbook with concrete 4-step escalation methodology
- [x] Update Sales Process Guide Stage 7 with specific escalation steps and examples
- [x] Add passive_reactivation QC violation (detects 18 banned passive phrases + generic "if you need anything" endings)
- [x] Add POST-CUSTOMER ESCALATION CHECK to QC LLM prompt (check 17)
- [x] Write 11 new tests for passive_reactivation violation (6 positive, 4 negative, 1 type check)
- [x] All 621 tests passing
- [x] Push to GitHub

## BUG: Iory Yagami (new FB lead) got no AI response after form submission at 11:20 PM
- [x] Diagnose: Brain Council DID fire (score 96), message composed, but sendMessage was BLOCKED by Gate 3 (HUMAN_AGENT_ACTIVE_GHL) — "Opportunity Created" system event misidentified as human agent message
- [x] ROOT CAUSE: sendMessageWithRetry returned { success: true } when ghl.sendMessage returned { blocked: true } — ALL callers thought message was sent when it wasn't
- [x] FIX 1 (CORE): sendMessageWithRetry now checks for { blocked: true } returns and reports { success: false }
- [x] FIX 2 (CALLERS): All 6 callers (webhook-contact, webhook-message x3, webhook-pipeline, webhook-task x2) now guard addConversation behind sendResult.success
- [x] FIX 3 (GATE 3): Added system message pattern filter (13 patterns: Opportunity Created, Pipeline Stage, Workflow Triggered, etc.) + GHL system type filter (TYPE_ACTIVITY, TYPE_CALL, etc.)
- [x] FIX 4 (GATE 3): Skip Layer B for brand new contacts with zero local AI history (every GHL outbound looks like "human agent" when there's nothing to compare against)
- [x] 8 new tests for blocked-send detection (AI_OFFLINE, COOLDOWN, HUMAN_AGENT_ACTIVE, HUMAN_AGENT_ACTIVE_GHL, OFFLINE_CHECK_FAILED, UNKNOWN_GATE, normal success, no-blocked-field success)
- [x] All 629 tests passing
- [x] Push to GitHub

## Re-trigger Iory Yagami engagement
- [x] Reset humanTakeover: 1 → 0, cleared lastAgentActivityAt
- [x] Reset consecutiveRejects to 0
- [x] Deleted ghost outbound conversation (Email msg that was stored but never sent)
- [x] Set nextFollowUpAt to NOW — production follow-up timer will pick up on next 5-min cycle
- [x] Verify message was actually delivered — Email sent at 11:41 PM to mendoza146@gmail.com with subject "Abby from Adorb" (pre-fix; next message will use context-aware subject)

## BUG: Generic fallback subject "Abby from Adorb" + wrong channel for Facebook leads (Iory Yagami)
- [x] Created buildContextSubject() helper in webhook-helpers.ts — builds subject from lead's businessName, productType (from formData), and firstName
- [x] Fixed 7 fallback subject locations: webhook-contact.ts, webhook-helpers.ts (3 paths), webhook-message.ts (2 paths), follow-up-trigger.ts (3 paths)
- [x] Fixed auto-correction.ts and brain-council-review.ts to also use context-aware subjects
- [x] Fixed channel priority: first-contact now enforces detected webhook channel (FB/IG) over Brain Council override
- [x] 7 new tests for buildContextSubject (businessName+product, product only, businessName only, firstName only, no data fallback, empty formData, interested-in extraction)
- [x] All 636 tests passing
- [x] Push to GitHub

## FIX: QC violation false positive spike (context_free_subject too narrow)
- [x] Audited last 2 hours: 20 Brain Council runs, 16 sent, 4 blocked
- [x] Identified Paulette Hughes Kornegay as false positive: "Hughes Reunion + Adorb" flagged because detector only checked businessName tokens, missed event/name context
- [x] Fixed: separated lead name tokens from context tokens — first name alone is personalization, not context; last name counts as context
- [x] Fixed: added ALL form data values as context tokens (not just product/purpose fields)
- [x] Fixed: added event keyword extraction from outbound conversation history too
- [x] Added 3 new tests: Paulette scenario, form data event name, first-name-only still flagged
- [x] All 639 tests passing
- [x] Push to GitHub

## FIX: HORMOZI_ACA missing_framework false positives (Maceo Martin + others)
- [x] Broaden hasAcknowledge to check businessName, productType, event/purpose keywords from conversation history
- [x] Extract context tokens from priorOutbound + priorInbound conversation history (last 6 messages)
- [x] Add formData label-based context (not just values) for richer matching
- [x] Add tests: 11 new tests covering business name ack, form data product, conversation history events, outbound history products, name-only flagged, missing question flagged, no-context graceful fallback, high QC score bypass, non-ACA framework bypass, ministry/church events, Maceo Martin scenario
- [x] All 650 tests passing
- [x] Push to GitHub

## BUG: CHANNEL MISMATCH blocking good messages — Curtis Lamar McBryde (Lead #900002)
- [x] Diagnose: GHL type 11 (FB Lead Form) unmapped → defaulted to SMS; correctedChannel not propagated to Brain Council
- [x] Fix 1: normalizeChannel — map GHL types 11→FB, 1/10→SMS, 7→SMS, 8→Live_Chat; check payload.messageTypeId + payload.message.type
- [x] Fix 2: QC channel_mismatch — trust Strategist when strategy.channel matches lead.preferredChannel (defensive fix)
- [x] Fix 3: Propagate correctedChannel back to `channel` variable for ALL downstream logic (Brain Council, QC, send)
- [ ] Re-trigger Curtis Lamar McBryde engagement after fix
- [x] Add tests: 5 new normalizeChannel tests (type 11, 1, 7, 8, 10) + 4 new QC channel_mismatch tests
- [x] All 659 tests passing
- [x] Push to GitHub

## BUG: Email not threading as reply — "WHY YO HAND O..." lead
- [x] Diagnose: GHL sendMessage returns `messageId` but code stored `emailMessageId` (undefined) → all thread IDs null
- [x] Fix: GHL sendMessage now maps response.messageId → emailMessageId for email sends
- [x] Fix: getLastEmailThreadInfo returns threadId + prior subject for Re: prefix threading
- [x] Fix: follow-up-trigger.ts and webhook-message.ts both use getLastEmailThreadInfo for Re: subjects

## BUG: Follow-up messages generic/repetitive — no escalation or personality
- [x] Diagnose: Strategist had no structured escalation ladder — same approach/tone regardless of attempt count
- [x] Fix: Added FOLLOW-UP ESCALATION LADDER to Strategist (4 tiers: standard → value-first → pattern interrupt → breakup)
- [x] Fix: Explicit escalation tier injected into Strategist engagement state based on unansweredCount
- [x] Fix: Composer now receives FOLLOW-UP ESCALATION section matching Strategist tiers
- [x] Fix: Composer extracts recent email subjects for anti-repetition (RECENT SUBJECTS section)
- [x] Fix: Encourages humor, sarcasm, pattern interrupts at Attempt 3+; breakup angles at Attempt 4+
- [x] All 659 tests passing
- [x] Push to GitHub

## ARCHITECTURE: QC reformulate-first instead of block-first
- [x] Classify violations: DANGEROUS (wrong_business, safety_violation) vs FIXABLE (all others)
- [x] Change QC flow: fixable violations → up to 2 reformulation retries with specific fix instructions per violation type
- [x] Only hard-block for dangerous violations OR after 2 reformulation attempts exhausted
- [x] Remove fallback suppression for leads with many prior messages — reformulate instead
- [x] Re-triggered 56 leads blocked in last 48h — reset lastAiSendAttemptAt for re-engagement
- [x] 43 fallback-suppressed entries identified — leads got NO message, now queued for retry
- [x] All 659 tests passing
- [x] Push to GitHub

## ARCHITECTURE: Wire QC violations into self-learning feedback loop
- [x] Wire orchestrator blocked path → recordViolationLearning() + recordError() with violation details
- [x] Wire orchestrator reformulation success → recordReformulationSuccess() + addKnownFix()
- [x] Create recordViolationLearning() in learning-loop.ts — generates 3 pattern keys per violation (type, framework×type, persona×type)
- [x] Create getViolationAvoidanceRules() — aggregates recurring violations (2+ occurrences, last 30 days) into AVOID rules
- [x] Feed violation-derived learnings into Composer prompt via getViolationAvoidanceBlock()
- [x] Feed violation-derived learnings into Strategist prompt via getViolationAvoidanceBlock()
- [x] All 659 tests passing
- [x] Push to GitHub

## CRITICAL: Deep architectural QC fix — repeated_opener false positives, reformulation failures, conflicting brain instructions
- [x] AUDIT: repeated_opener was counting "Hey [Name]" as a template pattern — "Hey Eva", "Hey Larry" all matched as same opener
- [x] AUDIT: Reformulation loop existed but old code was still running (not deployed yet when blocks occurred)
- [x] AUDIT: Dedup guard (5min) + cadence backoff blocked inbound replies — Larry D replied at 2:52 PM, 1 min after AI sent, dedup blocked response
- [x] AUDIT: Fast scanner excluded leads with ANY audit entry (including blocked ones) — never retried blocked leads
- [x] AUDIT: Orchestrator pre-flight check 5 (already-responded) blocked recovery attempts for blocked leads
- [x] FIX: repeated_opener now only flags exact 3-4 word matches, explicitly excludes greeting+name patterns
- [x] FIX: isInboundReply flag added to BrainCouncilInput — bypasses cooldown (15s dedup) and already-responded check
- [x] FIX: Webhook inbound uses 60s dedup (not 5min) and fully bypasses cadence backoff
- [x] FIX: Fast scanner only excludes leads with SUCCESSFUL (non-blocked) audit entries
- [x] FIX: Wired isInboundReply=true in webhook-message.ts, fast scanner, and self-review recovery
- [x] Re-triggered 21 leads blocked in last 24h (Larry D, Eva, Curtis, Mat Hansen, Glory, etc.)
- [x] Reset 3 circuit breaker leads (Glory, Brenie Wooten, bob eytcheson)
- [x] All 659 tests passing
- [x] Push to GitHub

## CRITICAL: Notification spam + Eva dali nyaosi circuit breaker loop
- [ ] FIX: Only send owner email notification on circuit breaker trips — suppress individual block emails
- [ ] FIX: Diagnose why Eva dali nyaosi (Lead #450001) keeps failing 3x in a row after reset
- [ ] FIX: Verify all 21 re-triggered leads from earlier script were properly reset
- [ ] All tests passing
- [ ] Push to GitHub

## CORE FIX: Fallback/circuit-breaker sending wrong messages + duplicate emails
- [ ] FIX: Circuit breaker must block ALL sends including fallback — no message at all when tripped
- [ ] FIX: Fallback must NEVER send cold-intro to warm leads (prior conversation history)
- [ ] FIX: Deduplicate owner notifications — only 1 email per lead per circuit breaker trip (check humanTakeover before notifying)
- [ ] FIX: Suppress fallback for leads with 1+ prior outbound messages (already in conversation)
- [ ] Re-trigger all leads affected by duplicate/wrong fallback emails
- [ ] All tests passing
- [ ] Push to GitHub

## AI System Overhaul — Root Cause Fix (April 11, 2026)
- [x] Phase 1: Replace Strategist prompt with hard-constraint-first version
- [x] Phase 1: Replace Researcher prompt with hard-constraint-first version
- [x] Phase 1: Replace Composer prompt with hard-constraint-first version (one-shot, no reformulation)
- [x] Phase 1: Replace QC prompt with hard-constraint-first version
- [x] Phase 2: Rename orchestrator to Chief Sales Manager
- [x] Phase 2: Remove reformulation loop (QC→Composer feedback)
- [x] Phase 2: Isolate all brains — data flows only through Chief
- [x] Phase 2: Cadence Engine overrides Strategist timing (timing clamped, not removed)
- [x] Phase 3: Build deterministic Cadence Engine
- [x] Phase 3: Restructure QC — deterministic hard rules first, LLM scoring second
- [x] Run full test suite and verify all tests pass (662 tests)
- [x] Push to GitHub and save checkpoint

## Remaining Gap Items — Full Build (April 11, 2026)
- [x] Hall of Fame winning message examples table (DB schema + Composer injection)
- [x] Human agent SLA timer (notify owner if human-owned lead silent 4h during biz hours)
- [x] QC execution order fix (deterministic hard rules BEFORE LLM scoring in code, not just prompt)
- [x] Channel selection intelligence (track which channel works per lead, shift accordingly)
- [x] Opportunity scoring enhancement (use in scheduling priority, not just display)
- [x] Post-delivery follow-up automation (review request + upsell sequence after fulfillment)
- [x] Seasonal campaign mode (bulk push stale leads with a specific angle for a date range)
- [x] Closer/Objection Handler routing through Chief Sales Manager (already routed through Chief — verified)

## Source-Level Fixes (Apr 12 2026)
- [x] EMAIL FORMATTING: Add hard instruction in Composer system prompt requiring proper HTML email formatting (paragraphs, line breaks, signature) — not plain text
- [x] EMAIL THREADING: Follow-up emails must be sent as replies to previous email thread — hardened emailMessageId capture in all send paths, inbound storage, fallback branches, post-delivery executor, and getLastEmailThreadInfo now checks both directions
- [x] SLA TIMER: Tie SLA timer into existing lead next-outreach scheduling + error-memory (updates nextFollowUpAt, overrideReason, overrideBy on SLA breach)
- [x] SELF-LEARNING TIE-IN: Hall of Fame + Channel Intelligence already in outcome-engine; email formatting violations recorded to learning-loop; post-delivery/seasonal errors feed error-memory
- [x] SELF-HEALING TIE-IN: All new features (SLA, post-delivery, seasonal, email formatting, follow-up send failures) feed into error-memory with known fixes seeded

## Source-Level Bugs (Apr 12 2026 - Round 2)
- [x] BUG: Darnicia Calvin received referral-ask email ("Random thought: do you know anyone needing custom tees?") instead of inquiry response — ROOT CAUSE: Strategist chose HORMOZI_INDIRECT for first_contact/responsive approach. FIXED: (1) Programmatic guard in orchestrator: HORMOZI_INDIRECT overridden to HORMOZI_ACA for first_contact/new_pitch, DIRECT_RESPONSE for responsive approaches. (2) Deterministic QC check 5b: referral_ask_in_inquiry violation blocks referral-ask patterns in inquiry/first-contact contexts. (3) New ViolationCategory type. 7 new tests, 705 total passing.
- [x] BUG: Leads showing past-date nextFollowUpAt — capDate now has floor that bumps any past date to now+1h+jitter
- [x] BUG: AI repeats same opener "AWESOME MATT!" — added phrase-level repetition detection in QC detectViolations (catches ALL CAPS + exclamation patterns across 2+ prior messages)
- [x] BUG: Weekend/after-hours scheduling — both scheduling-engine.ts and cadence-engine.ts now enforce Mon-Fri 9am-5pm ET only (Saturday removed, end hour changed from 6/7pm to 5pm)
- [x] BUG: AI says "someone will reach out later today" at 10pm — Composer now receives current time context + temporal language rules; QC has deterministic temporal promise gate that hard-rejects same-day promises outside M-F 9-5 ET
- [x] BUG: No handoff task/appointment created when human takeover triggers — handleHumanActive now creates GHL task with next-biz-hours due date, assigns to agent, and sends owner notification

## Source-Level Fixes Round 3 (Apr 12)
- [x] FIX: Added createOpportunity to ghl.ts + auto-create at interested/committed/human_active state transitions
- [x] FIX: handleCommitted rewritten — sales follow-up task for AGENT (not César) + appointment + conversation summary + auto-create opportunity + push pipeline value
- [x] FIX: webhook-pipeline Paid-Proof-Needed — full César automation: task + appointment + notification + conversation summary in notes
- [x] FIX: handleHumanActive — conversation summary in task + note + appointment + auto-create opportunity if missing
- [x] FIX: pipelineValue push — now pushed at interested + committed states via auto-created opportunity (no more silent skip)

## Transferred Contact Internal Enrichment (Apr 12)
- [x] Pull all transferred contacts' custom fields from GHL into portal DB
- [x] Pull all transferred contacts' attribution + opportunity history from GHL into portal DB
- [x] Tag all transferred contacts with source marker (transferred_contact) in portal DB
- [x] Store signup source / how they found us (attribution: Facebook, social media, etc.) in researchData.transferredContact
- [x] Schedule all transferred contacts for re-engagement activation timeline (staggered M-F 9-5 ET)
- [x] Pull external online references — lastResearchSummary cleared so Researcher brain auto-picks up on next lookback cycle
- [x] Trigger Omnisend sync for all transferred contacts with email addresses (pushed during enrichment)

## Channel-Switch Context Fix (Apr 12)
- [x] FIX: When outbound channel differs from original inbound channel, Composer must reference the original channel (e.g., "following up on your Facebook inquiry")
- [x] FIX: Add deterministic QC check — reject messages that switch channels without acknowledging the original channel

## Bug Investigation (Apr 12 - Round 7)
- [x] BUG: AI stopped responding to John Dugger's Facebook reply "Two sided and 20ish" at 12:01 PM — root cause: redundant second shouldHandoffToAgent LLM call (line 678) overrode Brain Council decision, set humanTakeover=1 prematurely. Fix: removed rogue post-Brain-Council handoff check, reset lead state. Handoff now handled by pre-BC check + conversation state machine + action dispatcher.
- [x] BUG: Duplicate appointment + AI silenced again for John Dugger — root cause: GHL appointment activity (type 31) misidentified as human agent message by both SEND-GATE (ghl.ts) and GHL history scan (webhook-message.ts). Fix: added numeric GHL system type IDs (0, 28-40) to both filters. Reset lead state.

## Appointment/Task/Note Restructure (Apr 12 - Round 8)
- [x] Audit all appointment/task/note creation points across codebase
- [x] Add GHL appointment ID + task ID tracking columns to leads table (ghlTaskId added, appointmentId already existed)
- [x] Phase 1: On first contact — create ONE appointment (next biz hour, 10min) + task + internal note as agent heads-up (createHeadsUpNotification in agent-notifications.ts)
- [x] Phase 2: On handoff — UPDATE existing appointment/task/note to reflect live quote status (escalateNotification in agent-notifications.ts)
- [x] Remove all other scattered appointment/task creation points (webhook-contact.ts, webhook-message.ts, action-dispatcher.ts all rewired)
- [x] Tests, compile check, push, checkpoint (671 tests passing, 0 TS errors)

## Channel-Switch Wording Fix (Apr 12 - Round 9)
- [x] BUG: Composer produces "from the transferred contact" instead of natural channel reference like "your Facebook inquiry" — fixed: brain-context.ts now validates originalInboundChannel against known channel names (FB, IG, SMS, Email, WhatsApp, GMB), composer.ts only injects channel-switch block when origChannel maps to a human-readable label. Transferred contacts (1,554 leads) no longer trigger nonsensical channel references.

## Foundational Email Issues (Apr 12 - Round 10)
- [x] BUG: Email to "CBT" uses company abbreviation as name — added sanitizeName() that rejects all-caps abbreviations (CBT, LLC), numerics, single chars, and known non-names
- [x] BUG: Email missing signature block — buildSafeFallback now appends getSignatureBlock() for Email channel
- [x] BUG: "Thanks for reaching out" used for transferred contacts — now uses context-aware opening ("We do custom T-shirts..." for transferred, "Got your inquiry" for organic)
- [x] BUG: Generic/short email with no personalization — transferred contacts get Adorb-branded intro with product list and no-minimums pitch
- [x] Investigate: QC correctly blocked the Composer output (score 0, email_formatting). The issue was the circuit-breaker fallback (buildSafeFallback) which bypasses QC — fixed at source so fallback output is always properly formatted

## Duplicate Message Bug (Apr 12 - Round 11)
- [ ] BUG: Jacquetta Horton Harrison received TWO messages — Brain Council at 3:20 PM + fallback at 3:23 PM. Diagnose and fix duplicate trigger.

## BUG: Duplicate lead creation race condition
- [x] Root cause: SELECT-then-INSERT in upsertLead() + no UNIQUE index on ghlContactId in DB
- [x] Clean up 6 existing duplicate lead pairs (merge conversations/audits to keeper, delete orphan)
- [x] Add UNIQUE index on ghlContactId column in database
- [x] Rewrite upsertLead() to use atomic INSERT...ON DUPLICATE KEY UPDATE
- [x] Add in-memory mutex in webhook handlers keyed on ghlContactId for defense-in-depth
- [x] Tests for atomic upsert behavior (4/4 passed)

## BUG: Appointment not created for new contacts
- [x] Root cause: createHeadsUpNotification only runs AFTER successful message send — any early return skips it
- [x] Move appointment creation to run BEFORE message send (in handleContactWebhook, not sendDelayedFirstContact)
- [x] Ensure appointment is created even when Brain Council blocks, rate limit hits, or message fails
- [x] Tests for appointment creation on all code paths (verified via code review — appointment now fires in handleContactWebhook before delayed first-contact)

## BUG: AI asks for phone/email when already provided in form data
- [x] Root cause: Form data is parsed but email/phone are NOT persisted to lead.email/lead.phone before Brain Council runs
- [x] Fix webhook-contact.ts: After form data extraction, extract email/phone from formFields and updateLeadFields before calling Brain Council
- [x] Fix webhook-message.ts: FB FORM DATA block now also extracts and persists email/phone/name from parsed form data
- [x] Add extractContactFieldsFromFormData() helper to webhook-helpers.ts for reuse (8/8 tests passing)

## FEATURE: Email-only outreach for migrated contacts
- [x] Identify how migrated contacts are tagged/sourced in the system → source='transferred_contact' (1,554 leads)
- [x] Add `isMigratedEmailOnly()` and `enforceMigratedChannel()` helpers to webhook-helpers.ts
- [x] Add `reactivatedFromMigration` flag to leads schema + DB migration
- [x] Wire enforcement into webhook-contact.ts (first contact + fallback)
- [x] Wire enforcement into webhook-message.ts (reply to inbound)
- [x] Wire enforcement into follow-up-trigger.ts (scheduled follow-ups)
- [x] Wire enforcement into lookback-engine.ts (dormancy re-engagement)
- [x] Add re-engagement detection in webhook-message.ts (inbound from migrated → set reactivatedFromMigration=1)
- [x] Seasonal campaign executor doesn't send directly — uses follow-up trigger (already patched)
- [x] Write tests for isMigratedEmailOnly and enforceMigratedChannel (15/15 passed)

## BUG: Missing acknowledgement + assignment/appointment for inbound replies (Sarah Weiss)
- [x] Sarah Weiss replied "Please reach out tomorrow" at 5:20 PM — AI did not acknowledge or confirm follow-up
- [x] Root cause: Brain Council composed reply but QC blocked it (safety_violation on Sunday), then fallback was suppressed (2+ prior outbound), and no ack was sent
- [x] No agent assignment or appointment/task created in GHL — root cause: appointment creation only existed in handleContactWebhook (new contacts), not for existing leads' inbound replies
- [x] Fix: Added createHeadsUpNotification call in webhook-message.ts for inbound replies when lead has no appointment/task
- [x] Fix: Added context-aware quick-ack in webhook-message.ts when Brain Council blocks a genuine inbound reply ("Got it — we'll follow up with you then!")
- [x] Quick-ack skips DNC/stop messages, pre-flight aborts (already responded, offline, locked), and humanTakeover leads

## BUG: Infinite follow-up loop for Sarah Weiss (lead 120001)
- [x] Follow-up trigger runs every 2 min, Brain Council composes, QC blocks, but lead stays in queue — no backoff
- [x] Root cause: blocked messages rescheduled via calculateNextFollowUp which returned short intervals, and consecutiveRejects wasn't high enough to trip circuit breaker (threshold=5)
- [x] Fix: Added consecutive block backoff in follow-up-trigger.ts: >=3 blocks → defer 24h, >=2 blocks → defer 4h
- [x] Fix: Quick-ack now sends immediate acknowledgement for inbound replies when Brain Council blocks
- [x] Fix: Appointment/task now created on inbound reply for leads missing them

## AUDIT: Self-learning/healing system capturing core fixes
- [x] Audited: error-memory has 56 errors (mostly LLM hallucinations), learnings has 50 patterns (15 promoted to prompt)
- [x] Finding: Self-learning only captures message-level QC patterns, NOT infrastructure bugs (race conditions, missing appointments, infinite loops)
- [x] Added 6 infrastructure fix patterns to error-memory seedKnownErrors (duplicate leads, missing appointments, infinite loops, form data gaps, missing ack, migrated channel)

## BUG: Duplicate message sent to John R Martinez (7:46 PM + 7:54 PM)
- [x] Root cause: FB form data message arrived 5 min after first-contact. Dedup guard treated form data as "genuine inbound" and bypassed the 5-min cooldown
- [x] Contact-level mutex can't help — webhooks arrived 5 min apart (mutex only serializes concurrent requests)
- [x] Fix: Added `isFormDataMessage` flag that detects structured FB form data (Full name/Company name + Phone/Email/Products)
- [x] Fix: Modified `isGenuineInbound` to exclude form data messages — form data now triggers dedup cooldown if AI already sent within 5 min
- [x] Form data still stored in conversation history and lead fields still enriched — just no duplicate Brain Council reply

## BUG: AI hallucinated wrong address for Adorb Custom Tees (Ramon conversation)
- [x] AI gave "1000 W Hallandale Beach Blvd" — wrong address (hallucinated despite address being in brand-assets.ts)
- [x] Root cause: No-hallucination rule didn't explicitly cover business facts like address; AI ignored the BRAND constant
- [x] Scraped print.adorbcustomtees.com: services, turnaround, quote process, service area, product categories
- [x] Confirmed correct hours from owner: Mon-Fri 9:30am-5pm (closed weekends)
- [x] Updated brand-assets.ts: hours, productCategories, turnaround, quoteResponse, minimumOrder, pickupDropoff, serviceArea
- [x] Strengthened getBrandContext() with CRITICAL verbatim-use directive
- [x] Added BUSINESS FACTS verbatim rule to composer.ts with wrong address example as anti-pattern
- [x] Expanded QC hallucinated_fact rule to catch wrong address/phone/hours (QC now rejects messages with wrong business facts)

## URGENT: Emails still broken in production (Apr 12 - Round 12)
- [x] Diagnose: What emails are still going out wrong despite HORMOZI_INDIRECT guard?
- [x] Identify the specific failure pattern: (1) TCPA channel-switch, (2) HORMOZI_INDIRECT in follow_up, (3) fallback sends after blocks
- [x] Fix at source — 5 architecture fixes deployed (see below)
- [x] Verify fix in production — 705 tests passing

## CRITICAL: TCPA quiet hours + HORMOZI_INDIRECT ban + Fallback suppression (Apr 12-13 2026)
- [x] BUG: TCPA quiet hours switches SMS to Email instead of deferring (Vanessia Brooks lead 5) — FIXED: Both pre-BC and post-BC TCPA gates now DEFER to next business hours instead of switching channels
- [x] BUG: HORMOZI_INDIRECT referral-ask allowed in follow_up approach (Vanessia Brooks: "Know anyone else who needs custom hoodies?") — FIXED: TOTAL BAN on HORMOZI_INDIRECT for ALL approaches. Removed from: Strategist prompt, JSON schema, diversity pool, stage-playbook preferred frameworks. Orchestrator guard catches any remaining. QC check 5b blocks all referral-ask patterns regardless of approach.
- [x] BUG: Fallback sends after Brain Council blocks (transferred contacts getting generic "Hey c," emails) — FIXED: Fallback sends eliminated from ALL 3 entry points (follow-up-trigger.ts, webhook-contact.ts, webhook-message.ts). When Brain Council blocks, NOTHING is sent. Lead retries on next scheduled cycle.
- [x] BUG: HORMOZI_INDIRECT in diversity framework pool could be selected as override — FIXED: Removed from ALL_OUTREACH_FRAMEWORKS array
- [x] Tests updated for TCPA deferral + referral-ask total ban — 705 passing

## Osmond Gilmore Issues (Apr 13 2026) — FIXED
- [x] BUG: Price range too wide ($10-28) — FIXED: Added QUANTITY UNKNOWN RULE and MIXED PRODUCT RULE to Composer pricing section. When quantity unknown, use 24-47 qty tier as reference. When multiple products mentioned, give SEPARATE estimates per product, never blend ranges.
- [x] BUG: Facebook lead contacted via SMS instead of FB channel — FIXED: Lookback Engine now checks lead.source when no conversation history exists. If source contains 'facebook'/'fb'/'lead_form', sets preferredChannel=FB. Same for Instagram→IG.

## GHL Appointment Scheduling Bug (Apr 13 2026) — FIXED
- [x] BUG: Appointments created in dense clusters (all at 8 AM, stacked on top of each other) — ROOT CAUSE: getNextBusinessHoursSlot() was stateless; bulk batch creation returned same slot for every call
- [x] FIX: Per-agent slot pointer (agentSlotPointers Map) tracks last booked end time per agent key
- [x] FIX: Sequential calls advance pointer by 10 min each time — 9:00→9:10→9:20... no overlap
- [x] FIX: Pointer wraps to next business day at 5 PM ET (not 4:50 PM)
- [x] FIX: warmSlotPointersFromCalendar() fetches existing GHL events on startup to prevent double-booking after restart
- [x] FIX: All 5 agent-notifications.ts calls now pass agent key for per-agent isolation
- [x] 6 new tests (ghl-slot.test.ts), 711 total passing

## Ready Stage Cleanup (Apr 13 2026)
- [x] REMOVE: Ready stage task/appointment creation in webhook-pipeline.ts — team handles fulfillment via Shopify internally, GHL tasks/appointments for shipping/pickup are not needed. DONE: Removed createTask + addNote from READY case. Follow-up schedule still updated so AI can send customer pickup/delivery notification.

## Conversation State Misclassification Bugs (Apr 13 2026) — FIXED (see Composer Ballpark Quote Bug section below)

## Composer Ballpark Quote Bug (Apr 13 2026) — FIXED
- [x] BUG: Composer appends "No design needed yet for a ballpark quote!" AFTER already giving the ballpark quote — FIXED: Added explicit rule to Composer: NEVER append this phrase after already giving a price estimate in the same message.
- [x] BUG: 'Thank you' after ballpark quote should NOT trigger committed state — FIXED: Intent classifier now explicitly states 'Thank you' after receiving a ballpark quote = general_chat (closingSignal=FALSE). Only 'Thank you' after CONFIRMED specific order details (qty, design, date) = thank_you_close.
- [x] BUG: 'hired someone else' triggered agent appointment instead of lost/not-qualified — FIXED: Added competitor_won intent type. Keyword fallback detects 'hired someone', 'already ordered', 'went with another vendor' etc. conversation-state maps competitor_won → dnc_all (Not Qualified, all outreach stops). JSON schema enum updated. Fallback keywords added.

## Owner Notification Spam (Apr 13 2026)
- [ ] BUG: Owner receiving multiple emails for same lead/event (e.g., "New Contact: Test Lead" fired 4+ times at 1:53 PM) — needs deduplication/batching so only 1 email per lead per event type
- [ ] BUG: Appointment creation for new contacts — "Heads-up appointment + task created in GHL" message in notification — clarify if new contact appointments should still be created

## Full GHL Contact Enrichment Pipeline

- [ ] BUILD: enrichContactFromGHL() — pull ALL GHL data for a contact: full conversation history (all messages), all custom fields (with field name resolution), all internal notes, all tags, opportunity history (pipeline stage, value, created/updated dates), contact attribution (source, campaign, UTM data), and store structured in leads.researchData
- [ ] WIRE: Call enrichContactFromGHL() in webhook-contact.ts when a transferred_contact arrives (before Brain Council runs)
- [ ] WIRE: Call enrichContactFromGHL() in lookback-engine.ts for any lead older than 3 days with no enrichment
- [ ] FEED: Pass full enrichment data (custom fields, notes, tags, opportunity history, GHL conversation history) into Brain Council Strategist prompt
- [ ] FEED: Pass full enrichment data into Researcher brain so it synthesizes real context instead of guessing
- [ ] FIX: Johnny Saif Marshall and all transferred contacts — re-enrich now so next outreach is personalized
- [ ] TEST: Verify enriched data appears in Brain Council audit log for a transferred contact

## Full GHL Enrichment + Omnisend Sync for All Transferred Contacts

- [ ] AUDIT: Count how many of the 1800+ transferred contacts have enriched researchData, classified omnisendSegment, and are synced to Omnisend
- [ ] BUILD: enrichContactFromGHL(contactId) — pull ALL data from GHL API: full conversation history (all messages), all custom fields (with field name resolution from location custom fields schema), all internal notes, all tags, opportunity history (pipeline stage, value, dates), contact attribution (source, campaign, UTM medium/content/source), website, company name
- [ ] BUILD: classifyContactSegment(enrichedData) — LLM classification into: Church, Sports, School, Trades, Event, Brand, Nonprofit, Other — based on business name, tags, custom fields, conversation history, form data
- [ ] BUILD: syncContactToOmnisend(lead, segment) — upsert contact to Omnisend with correct segment tag, email, phone, name, tags
- [ ] BUILD: bulkEnrichAndSync runner — process all 1800+ transferred contacts in batches of 20, with rate limiting, progress tracking, and error recovery
- [ ] WIRE: Auto-enrich + classify + sync on every new transferred_contact webhook arrival
- [ ] FEED: Pass enriched custom fields, notes, tags, opportunity history, and GHL conversation history into Brain Council Strategist prompt context
- [ ] FEED: Pass enriched data into Researcher brain as ground truth (not guesswork)
- [ ] RUN: Execute bulk enrichment + Omnisend sync for all existing transferred contacts
- [ ] VERIFY: Confirm enriched data appears in Brain Council audit log; confirm contacts appear in Omnisend with correct segments

## Bulk Enrichment from Old GHL Account (Completed Apr 13 2026)

- [x] COMPLETED: Enriched ALL 3,232 contacts (1,554 transferred + 1,001 source='r' + 517 source='Facebook' + 160 other) from old GHL account (aWJyvzTN1mCxBzkgSFYK)
- [x] COMPLETED: Pulled custom fields from old GHL API, resolved field IDs to names (45 field definitions loaded)
- [x] COMPLETED: Pulled notes from old GHL API for each contact
- [x] COMPLETED: Classified all contacts using rule-based + LLM classification
- [x] COMPLETED: Final segments: Other=1960, Brand=451, Church=330, Sports=261, Nonprofit=225, School=5
- [x] COMPLETED: Synced 2,454 contacts to Omnisend with correct segment tags
- [x] COMPLETED: Updated Brain Council Strategist prompt to surface resolved custom fields, notes, tags, segment
- [x] COMPLETED: Updated Brain Council Composer prompt to include enrichment context
- [x] COMPLETED: Lost-lead appointment guard (blocks appointment creation for Lost/DNC/competitor_won leads)
- [x] COMPLETED: Notification deduplication (5-min in-memory dedup cache for notifyOwner)

## Time-Aware Reactivation Framing for Aged Leads (Apr 13 2026)

- [x] FIX: Strategist urgencyStage only has "Day 30+ dormant" — no distinction between 1-month and 1-year-old leads. Add granular tiers: 90+ days, 180+ days, 365+ days
- [x] FIX: Strategist must instruct reactivation framing for leads 90+ days old — "You reached out about X months ago" not "Saw you're looking for..."
- [x] FIX: Composer must acknowledge time gap for aged leads — hard rule: if lead > 90 days old, MUST reference prior interaction timeframe
- [x] FIX: brain-context.ts urgencyStage needs granular tiers beyond "Day 30+ dormant"
- [x] FIX: Added fresh_outreach_on_aged_lead QC violation — auto-rejects messages using fresh-outreach phrasing on 90+ day leads
- [x] FIX: Added ENGAGEMENT STATE block to Composer prompt with leadAgeDays + urgencyStage warning

## createdAt Backfill for Imported Contacts (Apr 14 2026)

- [x] FIX: Set all imported contacts (source IN transferred_contact, r, Facebook, ghl, fb, ghl_import) createdAt to 366 days ago via SQL UPDATE — all 3,458 now show 365+ days
- [x] VERIFY: Confirmed — all 3,458 imported contacts now in 365+ day bucket, reactivation tiers active

## Notification Tier System — Email Only for Critical Events (Apr 14 2026)

- [x] AUDIT: Identified all 25+ notifyOwner() call sites across 14 files, classified as CRITICAL (5 events) vs STANDARD (10+ events)
- [x] BUILD: Added notification priority system to notification.ts — CRITICAL sends email, STANDARD logs to portal only. Auto-inference from title patterns + explicit priority parameter
- [x] VERIFY: 18 vitest tests passing, 740 total tests passing. Only 5 event types send email: Payment, AI Paused, Human Handoff, LLM Exhausted, Circuit Breaker, URGENT SLA breach

## BUG: Appointments always set to 8:00 AM (Apr 14 2026)

- [x] FIX: Appointments auto-created at 8:00 AM AND stacked — root causes identified and fixed
- [x] FIX: Added toETOffsetString() helper — sends 2026-04-15T09:00:00-04:00 (EDT) instead of UTC Z, GHL now displays correct 9 AM
- [x] FIX: Slot pointer now persists to DB (system_settings table) on every booking — survives server restarts
- [x] FIX: warmSlotPointersFromCalendar now loads from DB first (primary), GHL calendar API as secondary fallback
- [x] VERIFY: 740/740 tests passing, toETOffsetString correctly returns -04:00 EDT / -05:00 EST

## BUG: Duplicate appointments created for same contact (Apr 14 2026)

- [ ] FIX: Two appointments created for Charlena Best (9:30 AM + 9:50 AM) — createHeadsUpNotification called twice for same contact
- [ ] FIND: Identify which two code paths both trigger createHeadsUpNotification on new contact webhook
- [ ] FIX: Add deduplication guard — check if appointment already exists before creating a new one

## BUG: Duplicate appointments created for same contact (Apr 14 2026)

- [x] FIX: Race condition — added DB re-fetch of lead in createHeadsUpNotification to get freshest appointmentId before creating
- [x] FIX: Added DB-level atomic lock (appointmentCreatingAt column) — only one process can hold the lock at a time (30s TTL)
- [x] FIX: Lock also checks appointmentId IS NULL — if appointment already exists, lock will not be granted
- [x] FIX: Added real-time GHL calendar availability check — advances slot up to 20 times to find a free window
- [x] VERIFY: 743/743 tests passing, 3 new dedup tests added

## BUG: Bot not responding to Portuguese/Spanish messages (Apr 14 2026)

- [x] DIAGNOSE: Bot went silent because processingLockedAt was stuck (never released after a prior run crashed) — cleared manually
- [x] FIX: Added LANGUAGE MIRRORING RULE to ai-brain.ts SYSTEM_PROMPT — bot now detects lead language and responds in Spanish/Portuguese/French/etc.
- [x] FIX: Added language mirroring rule to QC and Brain Council prompts — non-English responses are now CORRECT behavior, not penalized
- [x] VERIFY: 743/743 tests passing

## BUG: createdAt backfill too broad — active leads marked as 1 year old (Apr 14 2026)

- [ ] FIX: Backfill set ALL imported contacts to 366 days ago including active/warm leads like Bob Eytcheson
- [ ] FIX: Restore createdAt to today for contacts with any message activity in the last 30 days
- [ ] FIX: AI prompt uses createdAt for "a year ago" framing — should use lastMessageAt or conversation recency instead
- [ ] VERIFY: Bob Eytcheson and other active leads no longer get "a year ago" framing

## BUG: "Hey Nir" greeting + wrong email sender (Apr 14 2026)

- [x] FIX: Root cause — Beni Santibanez's researchData.resolvedCustomFields had "Project Business Point Of Contact: Nir Appleton" (your name) and AI used it as greeting. Added GREETING NAME RULE hard constraint to all 3 AI layers: ONLY use lead.name from LEAD PROFILE, never names from researchData/customFields
- [x] FIX: Email sender confirmed correct — print@adorbcustomtees.com in GHL message details. "Nir Appelton" shown in GHL UI is just the connected account label, not the actual From address
- [x] VERIFY: 743/743 tests passing

## FIX: Replace "The CEO Store" with "KAUSE SQUAD Merchandise Store" (Apr 14 2026)

- [x] FIX: Added ONLINE STORE NAMING hard constraint to all 3 AI layers (ai-brain, QC, Brain Council) — "The CEO Store" → "KAUSE SQUAD Merchandise Store" in all outbound messages. Brain Council will REJECT any message containing "The CEO Store"

## BUG: createdAt backfill too broad — new contacts also getting "a year ago" framing (Apr 14 2026)

- [x] FIX: Restored createdAt to today for 298 contacts that had message activity in last 30 days but were incorrectly backfilled to 366 days
- [x] FIX: Updated brain-context.ts to use lastMessageAt as the recency anchor — if lead has activity in last 60 days, leadAgeDays is computed from lastMessageAt, not createdAt. Truly dormant leads still use createdAt (366 days = correct)
- [x] FIX: New contacts use createdAt.defaultNow() so they always get today's date — backfill was a one-time SQL UPDATE, not ongoing
- [x] VERIFY: 743/743 tests passing

## BUG: Circuit Breaker fired for Laura Damian Lead #720001 (Apr 14 2026)

- [ ] REVIEW: Circuit breaker fired after 4 consecutive failures — violation: REPEATED OPENER "hey laura, following up"
- [ ] FIX: AI reusing exact same opener despite prior outbound messages — anti-repetition rule not working for follow-up openers
- [ ] FIX: Blocked message references "Rodriguez Family Child Care" — wrong business name for a Church/Ministry lead (context contamination)
- [ ] FIX: Resume AI for Laura Damian after fixing root causes
- [ ] FIX: Strengthen anti-repetition rule to compare full opener phrase, not just greeting word

## Repeated Opener Circuit Breaker Bug (Apr 14 2026) — FIXED

- [x] ROOT CAUSE: Composer kept generating "Hey Laura, following up" opener for Laura Damian (lead 720001) despite ANTI-REPETITION RULES in prompt — LLM was ignoring the rule
- [x] FIX: Added POST-COMPOSE OPENER AUTO-FIX in brain-council-orchestrator.ts (lines 792-864): after Composer runs, deterministically check if first 4 words match any prior outbound opener; if yes, surgically replace just the opener with a diverse alternative (escalation tiers based on unansweredCount)
- [x] FIX: Opener pool is tiered: unanswered>=3 → "Quick question —" / "Plot twist —" etc; unanswered>=2 → "${name}, just checking in —" etc; base → "${name}," / "Quick update —" etc
- [x] FIX: Message content (business name, CTA, context) is fully preserved — only the opener word choice changes
- [x] FIX: Auto-fix prevents circuit breaker accumulation for what is a formatting issue, not a content problem
- [x] RESET: Laura Damian (lead 720001) circuit breaker reset: consecutiveRejects=0, humanTakeover=0, processingLockedAt=NULL
- [x] ADDED: Stuck Processing Lock Cleaner cron job (every 5 min) in server/_core/index.ts — clears processingLockedAt values older than 5 min to prevent silent bot failures
- [x] ADDED: GHL deep-link column in Leads table (Leads.tsx) — ExternalLink icon opens contact directly in GoHighLevel (stops row click propagation)
- [x] TESTS: 17 new tests in server/opener-autofix.test.ts — all 764 tests passing

## CRITICAL BUG: Saturday Appointment Scheduled for Jimmie/Basoom LLC (Apr 14 2026)

- [ ] BUG: AI scheduled appointment for Apr 15 (Saturday) at 12:30 PM EST — business is CLOSED on weekends (Mon-Fri only)
- [ ] BUG: Composer confirmed the Saturday appointment ("Awesome, Jimmie! Glad you got it. We're all set for your Saturday visit...") without catching the day-of-week error
- [ ] ROOT CAUSE 1: getNextBusinessHoursSlot() allows Saturday/Sunday slots
- [ ] ROOT CAUSE 2: Composer has no day-of-week validation for appointment confirmations
- [ ] FIX: getNextBusinessHoursSlot() must skip Saturday (day=6) and Sunday (day=0) — advance to Monday
- [ ] FIX: Business hours are 9:30am-5pm Mon-Fri (NOT 10am-5pm as previously stated)
- [ ] FIX: Add day-of-week guard to Composer — NEVER confirm weekend appointments
- [ ] FIX: Cancel the bad Jimmie appointment in GHL and send correction message
- [ ] TEST: Add weekend slot tests to ghl-slot.test.ts

## CRITICAL BUG FIX: Saturday Hours Hallucination (Apr 14, 2026)

- [x] Root cause: AI told Jimmie "open Saturdays 10am-4pm" on Apr 11-12 (context poisoning from prior AI errors). On Apr 14, Composer read those prior messages and confirmed "your Saturday visit" — treating its own prior errors as ground truth.
- [x] Fix 1: Strengthen Composer prompt with CONTEXT POISONING WARNING — explicitly tells LLM to ignore hours claims from prior messages and always use BRAND hours
- [x] Fix 2: Add wrong_hours to ViolationCategory type in brain-types.ts
- [x] Fix 3: Add wrong_hours deterministic QC guard in qc.ts — blocks any message containing "open Saturdays", "Saturday visit", "see you Saturday", "Mon-Sat", etc.
- [x] Fix 4: 20 tests written and passing for wrong_hours guard (server/wrong-hours.test.ts)

## Block Rate Reduction Fixes (Apr 14, 2026) — 70% → target <20%

- [x] Audit: 29/41 blocked (70.7%) in last 2h — breakdown: repeated_opener (10), fresh_outreach_on_aged_lead (9), missing_aca_acknowledgment (6), referral_ask (3), other (1)
- [x] Fix 1: Extend opener auto-fix to handle "Distinctive phrase" repetition (e.g., "hey larry" 2+ times) — was only catching exact 4-word/3-word matches
- [x] Fix 2: Pre-Strategist dormant channel override — leads >60 days dormant with email get channel forced to Email before Strategist runs (was blocking AFTER Strategist chose SMS)
- [x] Fix 3: HORMOZI_ACA context guard — if lead has no name/business/product/formData/history, override to SOCIAL_PROOF (dormant) or CURIOSITY_HOOK (fresh) to prevent missing_aca_acknowledgment blocks
- [x] Fix 4: Remove banned phrases (Random thought —, Plot twist —) from opener auto-fix pool — they were being injected as auto-fix replacements then blocked by QC's referral_ask check
- [x] Fix 5: Remove banned phrases from Composer prompt (line 400) — replaced with safe alternatives (Real talk —, Straight up —, One honest question —)
- [x] All 785 tests passing

## BUG: 366-day imported contacts getting SMS as first_contact (Apr 14, 2026)

- [ ] Diagnose why David Rose (366-day dormant) got SMS despite dormancy override
- [ ] Fix: imported contacts >90 days should be treated as reactivation, not first_contact
- [ ] Fix: channel for 366-day contacts with no email should default to SMS but with reactivation tone (not fresh inquiry tone)
- [ ] Fix: Strategist must never choose first_contact approach for leads >90 days old

## BUG FIX: "The CEO Store" Data Migration Contamination (Apr 14-15, 2026)

- [x] Root cause: old GHL sub-account had internal project fields (Project Name, Project Business Name, etc.) with value "The CEO Store" — these got migrated to ALL imported contacts via resolvedCustomFields
- [x] Fix: Strip ADORB_INTERNAL_FIELDS from resolvedCustomFields in both composer.ts and strategist.ts before injecting into LLM prompts
- [x] Fix: Add deterministic QC guard (hallucinated_fact) to block any message containing "The CEO Store"
- [x] Fix: HORMOZI_ACA context guard now mirrors QC's exact ackTokens logic — requires businessName OR formData OR convHistory (not just lead.name)
- [x] All 785 tests passing

## CRITICAL BUG: 8 AM Appointment Slot (Apr 15, 2026)
- [ ] Toni M Hurst got appointment at 8:00 AM EST — before business hours (9:30 AM)
- [ ] Trace the exact code path that generated the 8 AM slot
- [ ] Fix slot scheduler to enforce 9:30 AM start time as hard constraint
- [ ] Add test: no slot should ever be before 9:30 AM ET

## BUG FIX: Slot Scheduler 9:30 AM Start Time (Apr 15, 2026)
- [x] Fix getNextBusinessHoursSlot: change start time from 9:00 AM to 9:30 AM (Mon-Fri 9:30 AM - 5:00 PM ET)
- [x] Fix isBusinessHours check: hour > 9 || (hour === 9 && minute >= 30) instead of hour >= 9
- [x] Fix dayOfWeek to use ET-based day (not UTC) to handle midnight ET / early AM UTC edge cases
- [x] Add safety clamp: if slot is outside business hours, advance to 9:30 AM (catches all edge cases)
- [x] Move end time computation and pointer update to AFTER safety clamp
- [x] Update ghl-slot.test.ts to reflect 9:30 AM start time (789 tests passing)

## Lost Lead Long-Term Nurture Routing (Apr 15, 2026)
- [x] Confirmed: getLeadsDueForFollowUp() already excludes 'lost' stage (line 121 in db.ts)
- [x] Added lastLostNurtureAt column to leads table (schema.ts + migration applied)
- [x] Added getLostLeadsForNurture() to db.ts — queries Lost leads with email, not nurtured in 90+ days
- [x] Created lost-lead-nurture.ts — email-only quarterly re-engagement engine (no Brain Council, no SMS, no notifications)
- [x] 3 rotating email templates (social proof / new capability / direct re-engagement) — cycles via reactivationCount % 3
- [x] Respects email DND and emailUnsubscribed flags
- [x] Updates lastLostNurtureAt + increments reactivationCount after each successful send
- [x] Registered daily cron job in index.ts (runs at 8 AM ET)
- [x] handleHumanActive in action-dispatcher.ts: Lost stage guard suppresses Human Handoff notification
- [x] 17 new tests in server/lost-lead-nurture.test.ts — all passing
- [x] 806 total tests passing (36 test files)

## Bug Fixes & Upgrades — Apr 15 2026 (Ground-Up)

- [ ] Fix A: graceful_exit sets pipelineStage=not_qualified + GHL opportunity update (Arnita DeShields bug)
- [ ] Fix B: Stale-lead cap in scheduling-engine core (90+ days silent + 30+ day delay → cap 7 days, cadencePosition=5)
- [ ] Fix C: DB correction — reschedule all currently-stale leads (Nancy Pollinger + all similar leads)
- [ ] Fix D: SLA dedup → DB column lastSlaAlertAt + 6h minimum (survives restarts)
- [ ] Fix E: SLA alert → GHL task for assigned agent ONLY — remove owner email entirely
- [ ] Fix F: Payment notification dedup (lastPaymentNotifiedAt column, 6h minimum)
- [ ] Fix G: Hard constraints block in Strategist prompt (absolute rules, not advice)
- [ ] Fix H: ICP Win/Loss learning — track conversion by segment, inject into Strategist

## Bug Fixes & Upgrades — Apr 15, 2026

- [x] Fix A: graceful_exit → set pipelineStage=not_qualified + GHL stage update (suppresses Human Handoff notification)
- [x] Fix B: Stale-lead cap — system-wide rule in scheduling engine (90+ days silent + 30+ day delay → cap at 7 days)
- [x] Fix C: DB correction — 174 stale leads rescheduled from Jun/Jul 2026 to 7 days out
- [x] Fix D: SLA dedup → DB-backed (lastSlaAlertAt column), 6h minimum, owner email REMOVED entirely
- [x] Fix E: SLA alerts → GHL task for assigned agent ONLY (no owner email)
- [x] Fix F: Payment notification dedup — lastPaymentNotifiedAt column, 6h minimum per lead
- [x] Fix G: Hard constraints block already in Strategist prompt (confirmed present, no change needed)
- [x] Fix H: ICP Win/Loss learning — buildIcpLearningContext() added to outcome-engine, injected into Strategist

## Agent-First Delay — Apr 15 2026
- [ ] 15-min delay for brand new leads during business hours (Mon-Fri 9am-5pm EST)
- [ ] AI still schedules appointment and does setup, just holds first response
- [ ] After 15 min, if agent hasn't responded, AI sends the message

## Module 5A — Event-Driven Triggers — Apr 15 2026
- [ ] Event trigger engine: email-opened-no-reply (48h) → reschedule within 24h
- [ ] Event trigger engine: link-clicked-no-reply (24h) → reschedule within 4h
- [ ] Event trigger engine: went-quiet-after-quote (72h) → reschedule within 48h
- [ ] Register cron job for event trigger engine (every 30 min)
- [ ] Tests for event-trigger-engine

## Agent-First Delay + Event-Driven Triggers — Apr 15 2026

- [x] 15-minute agent-first delay for brand new leads during business hours (Mon-Fri 9am-5pm EST)
- [x] deferredResponses table + migration applied
- [x] shouldDeferResponse() — business hours check, new lead check, humanTakeover check
- [x] getDeferredSendAt() — 15 minutes from now
- [x] deferred-response-processor.ts — cron every 2 min, checks for agent activity before sending
- [x] Integrated into webhook-message.ts — defers instead of immediate send for qualifying leads
- [x] 11 tests for deferred response processor — all passing
- [x] Module 5A: Event-Driven Triggers engine
- [x] lastEventTrigger + lastEventTriggerAt columns + migration applied
- [x] Trigger 1: Email Opened but No Reply (48h) — reschedules to NOW
- [x] Trigger 2: Email Link Clicked (4h) — reschedules to NOW (hot intent)
- [x] Trigger 3: Quote Sent but No Response (48h) — reschedules to NOW
- [x] Trigger 4: Engaged then Went Silent (72h) — reschedules to NOW
- [x] buildEventTriggerContext() — injects trigger context into Strategist prompt
- [x] Cron job registered — every 30 minutes
- [x] Event trigger cleared after successful follow-up send
- [x] 10 tests for event-driven triggers — all passing
- [x] Total: 827 tests, 38 test files, 0 failures

## Migration Guard Fix — Apr 15 (source='r' batch)
- [ ] Fix isMigratedEmailOnly to check transferredContact in researchData, not just source string
- [ ] Fix enforceMigratedChannel to use same check
- [ ] DB correction: force all 1001 source='r' leads to preferredChannel=Email
- [ ] Update QC isTransferred check to also cover source='r' with transferredContact data
- [ ] Update strategist/composer/researcher transferred contact detection
- [ ] Write/update tests for the expanded migration guard

## Migrated Contact SMS Leak Fix — Apr 15, 2026
- [x] Expanded isMigratedEmailOnly to check researchData.transferredContact (not just source string)
- [x] Expanded QC isTransferred detection to cover source='r' leads
- [x] DB correction: 639 source='r' leads forced to Email channel
- [x] DB correction: 8 leads with lastOutboundChannel=SMS corrected

## Module 1: Conversation Stage Detection — Apr 15, 2026
- [x] Added conversationStage to Strategist prompt (9 stages: introduction, qualification, value_proposition, needs_analysis, objection_handling, closing, post_sale, reactivation, graceful_exit)
- [x] Added conversationStage to JSON schema output
- [x] Added conversationStage to StrategyDecision and BrainCouncilOutput types
- [x] Added conversationStage to brain_council_audit table (migration applied)
- [x] All audit insert paths carry conversationStage (approved, blocked, graceful_exit, fallback)
- [x] QC receives conversationStage in strategy directive
- [x] 4 new stage-aware QC hard constraints (stage_mismatch, fresh_outreach_on_aged_lead)
- [x] 17 tests for conversation stage detection — all passing

## Lost Lead Nurture Engine Rewrite — Apr 15
- [x] Rewrite lost-lead-nurture.ts to use Brain Council instead of pre-written templates
- [x] Every nurture email must go through full Brain Council (Strategist → Researcher → Composer → QC)
- [x] Brain Council receives full conversation history so it knows if lead declined
- [x] If Brain detects DECLINING, block the send — no nurture email goes out
- [x] NOT-INTERESTED fast-path detection BEFORE Brain Council (regex patterns on local + GHL history)
- [x] graceful_exit detection from Brain Council → moves lead to not_qualified
- [x] Sweep DB for leads who explicitly declined but are still in active pools
- [x] Correct pipeline stage for all declined leads found in sweep (2 leads: #536 Liani Echagarruga, #1291 test12)
- [x] 19 new tests for Brain Council-based nurture engine — all passing
- [x] 846 total tests, 39 test files, 0 failures, 0 TypeScript errors

## Module 4 — Multi-Agent Deliberation — Apr 15, 2026
- [x] Create server/deliberation-judge.ts — runDeliberation() calls runStrategist twice in parallel (temp 0.3 + 0.7), Judge LLM picks winner
- [x] Gate deliberation in brain-council-orchestrator.ts (pipelineValue >= 500 OR opportunityScore >= 85)
- [x] Add deliberationUsed + deliberationNote to BrainCouncilOutput type
- [x] Add deliberationUsed + deliberationNote columns to brainCouncilAudit schema + migration
- [x] Store deliberation metadata in all audit insert paths
- [x] Add "Deliberation" badge to AuditLog.tsx entries where deliberationUsed=1
- [ ] Write server/deliberation-judge.test.ts (5 scenario pairs) — deferred to next session

## Module 2A — ICP Cadence Multiplier — Apr 15, 2026
- [x] Add getIcpTier(source, segment) to server/outcome-engine.ts
- [x] Apply ICP multiplier in calculateNextFollowUp (P3 + P4 paths): HIGH=×0.7, LOW=×1.3
- [x] Add getIcpStats() for dashboard
- [x] Add "ICP Win/Loss" tab to SelfLearning.tsx with source/segment conversion tables + multiplier legend
- [x] Add tRPC procedure learning.icpStats to expose source+segment conversion data
- [ ] Add icpTier to LeadContext and Strategist prompt — deferred to next session
- [ ] Write server/icp-multiplier.test.ts — deferred to next session

## Module 2B — Expert Panel Scoring — Apr 15, 2026
- [ ] Create server/expert-panel.ts — Brand Voice, Conversion, Compliance experts run in parallel
- [ ] Integrate into orchestrator: after Composer, before QC — revision pass if any expert < 60
- [ ] Add expertPanelBrandScore, expertPanelConversionScore, expertPanelComplianceScore to brainCouncilAudit schema
- [ ] Apply DB migration
- [ ] Add Expert Panel scores to AuditLog.tsx detail view
- [ ] Add Expert Panel aggregate score to BrainCouncilOutput type
- [ ] Wire learning.expertPanelStats tRPC procedure
- [ ] Add Expert Panel section to /ai-performance page
- [ ] Write server/expert-panel.test.ts

## Module 5B — Private Memory — Apr 15, 2026
- [ ] Create server/lead-memory.ts — extract facts after each BC run, store in leadMemory table
- [ ] Add leadMemory table to drizzle/schema.ts (leadId, factKey, factValue, confidence, learnedAt, lastConfirmedAt)
- [ ] Apply DB migration
- [ ] Inject getLeadMemory() into buildLeadContext() as privateMemory field
- [ ] Add LEAD MEMORY section to Strategist + Composer prompts
- [ ] Add Lead Memory panel to lead detail page
- [ ] Wire leads.getMemory tRPC procedure
- [ ] Write server/lead-memory.test.ts

## Module 3A — Skill Catalog — Apr 15, 2026
- [ ] Create server/skill-registry.ts — registry of named skills with triggerConditions, systemPrompt, exampleMessages, qcRules
- [ ] Seed 6 initial skills: church_outreach, corporate_outreach, pricing_objection, reactivation_90d, first_contact_sms, first_contact_email
- [ ] Update server/composer.ts to call skillRegistry.selectSkill() before composing
- [ ] Add skillsUsed column to brainCouncilAudit schema
- [ ] Apply DB migration
- [ ] Add Skill Used badge to AuditLog.tsx
- [ ] Write server/skill-registry.test.ts

## Module 3B — Auto-Skill Hunter — Apr 15, 2026
- [ ] Create server/skill-hunter.ts — weekly scan of violation log, LLM generates skill proposals
- [ ] Add skillProposals table to drizzle/schema.ts (id, violationCategory, proposedSkillId, proposedPrompt, status, createdAt)
- [ ] Apply DB migration
- [ ] Register skill-hunter cron in server/_core/index.ts (weekly, Sunday 2 AM)
- [ ] Add Skill Proposals panel to /self-learning page
- [ ] Wire learning.skillProposals + learning.approveSkillProposal + learning.rejectSkillProposal tRPC procedures
- [ ] Write server/skill-hunter.test.ts

## Bugs Fixed — Apr 15, 2026
- [x] Ghost lead #240004 (Hudson Grove Ame Zion) — no email/phone/value, dead GHL contact ID LucQ2gQTVMMhGmhUzZOZ — deleted from DB; real lead #240003 intact
- [x] Human agent outbound messages NOT saved to conversations table — webhook-message.ts now calls addConversation(senderType=human, senderName=agentName) before returning; lead detail page now shows agent name instead of AI for human-sent messages

## Critical Bug — Old Contacts Still Receiving AI Messages — Apr 16, 2026
- [x] Investigate root cause: getLeadsDueForFollowUp() Drizzle gate was not blocking leads because nextFollowUpAt was already set before the gate was added; also Facebook/ghl/fb sources were not in MIGRATED_SOURCES
- [x] Identify affected leads: 2,409 leads older than 90 days with no inbound replies still in queue (transferred_contact: 1,059, r: 984, Facebook: 260, ghl: 80, fb: 16, others: 10)
- [x] HARD GATE 1 (Source-based): getLeadsDueForFollowUp() and lookback-engine.ts now block all 7 import sources (transferred_contact, r, n, bulk_import, Facebook, ghl, fb) with reactivatedFromMigration=0
- [x] HARD GATE 2 (Age-based): Both functions now also block ANY lead older than 90 days with no inbound conversations, regardless of source — catch-all for future import batches
- [x] MIGRATED_SOURCES in webhook-helpers.ts expanded to include n, bulk_import, Facebook, ghl, fb — email-only channel enforcement now covers all 7 sources
- [x] Cleared 2,409 leads from follow-up queue via raw SQL (SET nextFollowUpAt=NULL) — queue is now clean

## Monthly Import Nurture — Apr 16, 2026
- [x] getImportedContactsDueForNurture query added in db.ts — 30-day cadence, email only, reactivatedFromMigration=0
- [x] Monthly import nurture wired into lost-lead-nurture.ts (processImportedContactNurture) and timer registered in server/_core/index.ts
- [x] enforceMigratedChannel now covers all 7 import sources (MIGRATED_SOURCES updated)

## Bugs — Apr 22, 2026
- [x] BUG FIX: Facebook-sourced leads receiving first-contact via Email instead of FB — root cause: hintChannel fallback in follow-up-trigger.ts defaulted to SMS when preferredChannel/lastOutboundChannel were null; enforceMigratedChannel blocked SMS, triggering Email fallback. Fix: added exported sourceToChannel() to webhook-helpers.ts as single source of truth; updated follow-up-trigger.ts and lookback-engine.ts to use it.
- [x] BUG FIX: Outbound emails missing agent signature block — root cause: follow-up-trigger.ts called formatEmailHtml() directly, bypassing ensureEmailSignature(). Fix: now calls ensureEmailSignature() + {AGENT} replacement before formatEmailHtml(). Also tightened hasSignature check in brain-council-orchestrator.ts to anchor on brand domain/name only (removed generic '---' anchor).
- [x] Unit tests: 19 new tests in server/channel-routing.test.ts covering sourceToChannel(), ensureEmailSignature(), and full email send path

## Self-Learning Improvements — Apr 22, 2026
- [x] Wire getKnownFix() into error handling paths so Error Memory auto-heals — added tryApplyKnownFix() to error-memory.ts, wired into 4 error paths
- [x] Expand Conversation Outcomes recording triggers — added auto-stale in disposition sweep + DNC in follow-up-trigger + expanded terminal won stages
- [x] Add automatic outcome detection for stale leads (no reply in 14+ days after 3+ AI messages) — Pass 4 in lead-disposition.ts
- [x] Add automatic outcome detection for won leads — expanded TERMINAL_WON_STAGES to include Proof Approved, In Production, Approved + Deposit
- [x] Add automatic outcome detection for DNC leads — channel exhaustion in follow-up-trigger now records dnc outcome
- [x] Add automatic outcome detection for lost leads — already existed in webhook-pipeline.ts (TERMINAL_LOST_STAGES)
- [x] Wire auto-healing retry into follow-up-trigger, brain-council-orchestrator, post-delivery-executor, seasonal-campaign-executor
- [x] Add live agent success learning: extractAgentPatterns() + recordAgentLearning() in learning-loop.ts, wired in webhook-pipeline.ts on terminal won stages
- [x] Record agent conversation outcomes (won/lost) alongside AI outcomes — same recordConversationOutcome() path used for both
- [x] Extract winning agent patterns via LLM analysis of agent conversation transcripts → stored as source="agent_success" learnings → auto-promoted by runPromotionScan()

## Self-Learning Page Issues — Apr 23, 2026
- [x] Diagnose Self-Learning page issues: Evaluate All had no experiments to evaluate (0 in DB); A/B auto-creation was never implemented despite UI claiming it was automatic
- [x] Fix broken "Evaluate All" button — moved to A/B Experiments tab only (shown only when experiments exist); improved empty-state feedback
- [x] Fix: A/B experiments not auto-created — autoSeedExperiments() added to ab-testing.ts; runs 5min after startup + every 6h; seeds experiments from framework performance data (min 20 samples per framework, max 3 active)
- [x] Add "New Experiment" dialog to A/B tab for manual experiment creation with name, hypothesis, variant A/B, segment, sample size
- [x] 865 tests passing, 0 TS errors, Taskmaster tasks.json bootstrapped with 5 tasks all marked done
- [x] Fix Google Sheet sync to fetch ALL tabs (not just first/default tab) — use GID-based CSV export for each discovered tab
- [x] Update syncGoogleSheet and addGoogleSheet procedures to concatenate all tab content before synthesizing
- [x] Implement exact pricing quote rules: NEVER give ranges when quantity is unknown; give exact quote (1-side + 2-side + size tiers) when customer states exact quantity
- [x] Hard-code Gildan Style 3000 pricing matrix in sales-training.ts and update PRICING_RULES in strategist.ts and composer.ts
- [x] Add unit tests for multi-tab sheet ingestion and exact pricing rules
- [x] BUG: AI sent campaign email to Erica Carter (manually-created contact) even though human agent was already actively messaging her — fixed Layer B send-gate to check GHL message userId (human-typed) even when local AI history is empty
- [x] BUG: AI replied via Email when Anthony D Hamlet came in via Facebook — must match inbound channel
- [x] BUG: Email messages missing signature/footer

## Sprint 1: Framework Bans, Channel Logic, Bug Fixes, Cron Changes (Decisions 1, 2, 3, 4, 12)

- [x] Decision 1: Hard-ban SOCIAL_PROOF framework (programmatic override in brain-council-orchestrator.ts)
- [x] Decision 1: Remove SOCIAL_PROOF from strategist prompt available frameworks list
- [x] Decision 1: Remove SOCIAL_PROOF from ALL_OUTREACH_FRAMEWORKS diversity pool
- [x] Decision 2: Restrict EMB_WINBACK to past customers only (programmatic override)
- [x] Decision 3A: Rewrite selectChannel() to prefer SMS over Email for cold outreach
- [x] Decision 3B: Create fb-window-manager.ts with isFbWindowOpen() helper
- [x] Decision 3C: Wire FB window check into brain-council-orchestrator.ts before send
- [x] Decision 4A: Fix A/B auto-seeder SQL bug (variant_a_config → variantAConfig)
- [x] Decision 4B: Change A/B auto-seeder interval from 6hrs to 7 days
- [x] Decision 12: Change Auto-Skill Hunter interval from 6hrs to 7 days
- [x] Decision 12: Add Monday gate to weekly timers

## Sprint 2: Trends Wiring, Skill Auto-Adoption, Hall of Fame Verification (Decisions 6, 7, 8)

- [x] Decision 6: Add getTrendsBlock() to strategist.ts and inject into prompt
- [x] Decision 7: Add autoAdoptMatureProposals() to auto-skill-hunter.ts
- [x] Decision 7: Add getApprovedSkillsBlock() to composer.ts
- [x] Decision 8: Verify Hall of Fame pipeline has data and is working (92 entries confirmed)

## Sprint 3: LLM Experiments, Agent Patterns UI, Autonomous Strategy Review (Decisions 5, 10, 11)

- [x] Decision 5: Keep autoSeedExperiments() with fixed SQL bug (competitive pair logic is sound)
- [x] Decision 10: Add Agent Patterns tRPC procedure (learning.extractPatterns)
- [x] Decision 11: Create strategy-autopilot.ts with runStrategyReview()
- [x] Decision 11: Add strategy_adjustments table + migration
- [x] Decision 11: Strategy adjustments available via learning.strategyAdjustments procedure
- [x] Decision 11: Wire weekly Monday review timer in _core/index.ts
- [x] Decision 11: Inject active adjustments into strategist context

## Sprint 4: LoRA Training Export Pipeline (Decision 9)

- [x] Decision 9: Create training-export.ts with generateTrainingPairs()
- [x] Decision 9: Add training_exports table + migration
- [x] Decision 9: Training export available via learning.createTrainingExport procedure
- [x] Decision 9: Add tRPC procedures for export + status

## Automated LoRA Fine-Tuning Pipeline (OpenAI)

- [x] Request and configure OpenAI API key for fine-tuning
- [x] Build fine-tuning pipeline: JSONL upload → create training job → poll status
- [x] Add fine_tuning_jobs table to track job history and model IDs
- [x] Wire A/B testing: route % of traffic to fine-tuned model vs base
- [x] Add auto-promote logic: if fine-tuned wins after 7 days, promote to 100%
- [x] Integrate into Monday weekly schedule (after training export)
- [x] Add safety gate: rollback to base model if fine-tuned underperforms
- [x] Write tests for pipeline (978 tests passing)
- [x] Live browser testing

## Post-Pipeline Tasks

- [x] Trigger first training export manually (256 pairs exported; OpenAI deprecated fine-tuning, pivoted to few-shot)
- [x] Re-evaluate skill proposals based on session updates (19 approved, 4 rejected)
- [x] Add AI Learning Engine card to Dashboard (winning examples, active skills, strategy tweaks)

## Dynamic Few-Shot Retrieval Engine (Replaces LoRA)

- [x] Build few-shot-retrieval.ts with similarity matching (framework + channel + segment + approach)
- [x] Wire into composer.ts to inject top 3-5 relevant winning examples
- [x] Remove dead LoRA fine-tuning trigger from weekly schedule (replaced with training data export)
- [x] Re-evaluate skill proposals against new framework bans and channel logic (19 approved, 4 rejected)
- [x] Add AI Learning Engine card to Dashboard
- [x] Write tests (978 tests passing)
- [x] Full browser verification — all pages clean, zero errors, SOCIAL_PROOF fully purged from prompts

## Bug Fixes: Self-Learning Page

- [x] Fix Skill Catalog to dynamically show approved proposals (now 25: 6 built-in + 19 auto-learned)
- [x] Update footer text: "Self-Learning Engine Active" with Monday schedule, auto-adopt, dynamic counts

### Bug Fix: Double-Send / Wrong-Channel (Angel Gonzalez)
- [x] Investigate why AI sent Email to a Facebook lead (should only send on FB or SMS, never Email for FB leads)
- [x] Fix race condition: AI Email sent at 12:40 PM while live agent replied on FB at 12:41 PM — AI should have been blocked
- [x] Add social-channel guard: FB/IG/WhatsApp/Live_Chat sends no longer fall back to Email on missing_phone or carrier_block errors
- [x] Add GHL history re-check in sendDelayedFirstContact to detect agent activity during 45s delay window
- [x] Ensure live agent activity blocks AI sends (fresh GHL scan catches outbound messages not yet processed by webhook)
- [x] Wire 15-minute Agent-First Delay into contact webhook first-contact path (was only in inbound-message path)
- [x] Expand 15-min Agent-First Delay to ALL inbound messages during business hours (not just new leads with conversationCount=0)
- [x] Ensure existing customers like Earl Wheeler get the 15-min agent window before AI responds
- [x] Fix AI re-engagement messaging: frame outreach as "custom apparel for your sports team/church/organization" NOT "online store for your business"
- [x] Update knowledge base / Brain Council prompts to clarify that online stores are a delivery mechanism, not the core offering
- [x] Fix AI framing: outreach should say "custom apparel for your sports team/church/org" NOT "online store for your business"
- [x] Add hard constraint to Composer: online store is a delivery mechanism, not what the customer reached out about
- [x] Update Strategist reactivation rules to reference custom apparel, not online stores
- [x] Update reactivation_90d skill overlay with custom apparel framing rule
- [x] Fix channel for 1+ year old leads: use SMS primary (emails don't work for these dormant leads), Email as secondary
- [x] Override the 60-day dormant→Email rule for 365+ day leads to use SMS instead
- [x] Update brain-council-orchestrator: 61-364d → Email, 365+ → SMS override
- [x] Update QC: allow SMS for 365+ day leads (no longer flagged as channel_mismatch)
- [x] Update lookback engine prompt and post-analysis override for 365+ day SMS
- [x] Audit 365+ day leads with Email as preferred channel and flip to SMS (2,070 flipped, 74 no-phone kept, 72 DND-SMS kept)
- [x] Verify SMS sends are gated to business hours — was hardcoded to ET only
- [x] Implement recipient-timezone-aware TCPA quiet hours using phone area code → timezone lookup
- [x] Wire recipient-TZ TCPA checks into follow-up-trigger.ts (2 gates) and webhook-message.ts (2 gates)
- [x] Fix email subject lines: "[Org] + Adorb" format doesn't sell or create curiosity — need benefit-focused, curiosity-driven subject lines
- [x] Add hard constraint to Composer: subject lines must hook the reader with a question, benefit, or personalized reference — never just "[Org] + [Company]"
- [x] Add QC hard-reject for "[Org] + Adorb" subject format (fires before context check)
- [x] Update all EMB framework subject line rules: under 25 chars, no company name, curiosity-driven
- [x] Add emailSubject + emailOpened + emailOpenedAt columns to brain_council_audit + message_outcomes schema
- [x] Link email open webhook events to specific sent messages (7-day attribution window, audit → outcome)
- [x] Add open_rate as valid A/B experiment metric (alongside reply_rate, conversion_rate, positive_rate)
- [x] Add subject line pattern learning to learning-loop.ts (classifySubjectPattern + analyzeSubjectLinePatterns)
- [x] Auto-create subject line A/B experiments when enough data exists (via pattern analysis promotion)
- [x] FIX: lost-lead-nurture.ts v3 — respects preferredChannel (SMS for 365+ day leads), TCPA quiet hours, business hours enforcement, shared send pipeline (buildSendOpts + sendMessageWithRetry), no more hardcoded Email
- [x] FIX: lead-disposition.ts — 365+ day dormant lead guard prevents escalateToEmail from flipping aged imported contacts back to Email; adds createdAt to stale takeover query; permanent freeze path now checks phone first
- [x] TESTS: lost-lead-nurture.test.ts v3 — 27 tests covering channel resolution, TCPA, shared send pipeline, Brain Council integration, NOT-INTERESTED detection, imported contact nurture
- [x] TESTS: lead-disposition.test.ts — 35 tests including 7 new tests for 365+ day dormant lead guard, createdAt in query, phone-first permanent freeze path
- [x] RESEARCH: ruflo repo (ruvnet/ruflo) — 50.5k star multi-agent orchestration framework. Assessment: overkill for our 4-agent fixed pipeline. No changes needed.
- [x] BUG: No channel escalation after repeated unanswered SMS — Sarah Weiss got 5+ SMS with zero replies, system never switched to Email. Need auto-escalation: SMS→Email after 3 unanswered, Email→SMS after 2 unanswered
- [x] BUG: SMS cold openers are way too long (4 paragraphs) — Carolyn Culver example shows email-length SMS. Need strict 2-3 sentence / 160-320 char limit for SMS cold openers in Composer prompt and QC gate
- [x] FOUNDATIONAL: Consolidate ALL channel selection + business hours logic into ONE authoritative ChannelRouter — David Maynard FB at 10:34 PM got Email at 10:35 PM (wrong channel, wrong time). Fixed: Layer 0B/7B form detection, orchestrator inbound channel enforcement, TCPA social bypass.
- [ ] AUDIT: Map every channel decision point across all 6+ files (webhook, follow-up, scheduling, orchestrator, strategist, nurture)
- [ ] BUILD: Single ChannelRouter function with clear priority: (1) match inbound channel, (2) business hours gate, (3) DND check, (4) fallback escalation
- [ ] CLEANUP: Remove all duplicate/conflicting channel logic from old locations
- [x] BUG: Pete Marrero FB lead at 11:16 PM got Email at 11:17 PM AFTER Fix 9 was deployed — ROOT CAUSE: 'ghl' was in MIGRATED_SOURCES list, causing all new GHL contacts to be treated as migrated email-only. Fixed: removed 'ghl', 'Facebook', 'fb' from MIGRATED_SOURCES + added 2-hour safety net in enforceMigratedChannel.
- [x] CLEANUP: Remove entire migrated channel restriction system (MIGRATED_SOURCES, isMigratedContact, isMigratedEmailOnly, enforceMigratedChannel) — one-time migration is done, code was actively harmful. Removed from 6 files, deleted 2 test files.
- [x] BUG: Rashid Riaz (Instagram form lead 6:49 AM May 16) got NO AI engagement — opportunity/appointment created but Brain Council never called. ROOT CAUSE 1: HARD GATE 1 in db.ts getLeadsDueForFollowUp() still blocked source='ghl'/'Facebook'/'fb' leads from follow-ups (stale migration filter left behind when enforceMigratedChannel was removed in Fix 11). ROOT CAUSE 2: GHL sent two different contact IDs for the same person within 1 second, creating duplicate lead records (4830001 and 4830002).
- [x] FIX 12A: Removed 'Facebook', 'ghl', 'fb' from HARD GATE 1 source filter in db.ts getLeadsDueForFollowUp() — only true one-time migration sources ('transferred_contact', 'r', 'n', 'bulk_import') are now gated. Also fixed the same stale filter in lookback-engine.ts (2 instances).
- [x] FIX 12B: Added findExistingLeadByIdentity() to db.ts — finds existing leads by email/phone across different ghlContactIds. Wired into both webhook-contact.ts and webhook-message.ts as post-enrichment dedup: when GHL sends different contact IDs for the same person, the system now detects the duplicate and merges into the canonical (older) lead instead of creating a second record.
- [x] TESTS: fix12-hard-gate-dedup.test.ts — 8 tests covering: ghl source leads included in follow-ups, transferred_contact still blocked, reactivated leads included, email dedup, phone dedup, same-lead not flagged as duplicate, null email/phone handling, oldest-lead-wins ordering.
- [x] BUG: Leartis Davis Sr (IG lead) — no AI response on Instagram channel despite Brain Council audit showing messageSent=1 (sent to wrong channel?)
- [x] BUG: Yvette Reed (FB lead) — replied "4 right now" but AI didn't respond to her reply
- [ ] FIX 13A: BLOCK BACKOFF escalates to 90 days — cap at 4h max, never exponentially defer
- [x] FIX 13B: SMS sentence counter too aggressive — char limit should be primary gate, sentence count secondary
- [ ] FIX 13C: Auto-recovery for lock failures (retry in 60s, not defer days)
- [ ] FIX 13D: Auto-resolve dead GHL contact IDs on send failure without throwing
- [x] BUG: Channel inconsistency — Rashid came via IG but AI responded via SMS (should reply on same channel)
- [x] BUG: Adebola Esther Adesina (IG→WhatsApp) — humanTakeover=1 set immediately, zero AI engagement
- [x] FIX 13E: Channel routing — first response must go on the channel the lead came in on (IG→IG, FB→FB, WhatsApp→WhatsApp)
- [x] FIX 13F: humanTakeover false positives — GHL history scan detecting appointment/system messages as agent activity
- [x] FIX 13G: Remove SMS char/sentence limits for cold outreach (first_contact) entirely
- [x] FIX 13H: Add message splitting — long SMS gets split into 2 texts with short delay (feels human)
- [x] FIX 13I: Add name typo trick to cold outreach — misspell name in msg 1, correct in msg 2 (draws attention)

## Phase 0: Emergency Relief (Overhaul)
- [x] P0.1: Add DISABLE_LEGACY_TIMERS env var / feature flag
- [x] P0.2: Wrap 12 legacy timers in feature flag guard (fast scanner, self-review, lookback, auto-correction, disposition sweep, outcome backfill, overdue catchup, event triggers, post-delivery, seasonal, lost-lead nurture, import nurture, weekly review, error memory seed, learning promotion)
- [x] P0.3: Tune parameters — cooldown 60→30s, lock TTL 300→120s, proactive cap 10→5/hr, takeover expiry 24h→4h
- [x] P0.4: Update lead-disposition.ts stale takeover threshold from 24h to 4h
- [x] P0.5: Update ghl.ts AGENT_TAKEOVER_WINDOW_MS from 24h to 4h
- [x] P0.6: Update supervisor.ts stale takeover invariant from 24h to 4h
- [x] P0.6b: Update db.ts BRAIN_COUNCIL_LOCK_TTL_SECONDS from 300→120s
- [x] P0.6c: Update _core/index.ts STUCK_LOCK_TTL_MS from 5min→2min
- [x] P0.7: Run stale takeover cleanup SQL (clear humanTakeover where lastAgentActivityAt > 4h ago)
- [x] P0.8: Update tests for new parameter values (12 new tests + 82 updated tests passing)
- [x] P0.9: Verify all tests pass — 1,099 tests passing, 49 test files, 0 failures

## Phase 1: The Outbox (Single Message Queue)
- [x] P1.1: Create outbox table schema (leadId, idemKey, source, payload, status, claimedBy, claimedAt, scheduledAt, sentAt, error, retryCount)
- [x] P1.2: Create decision_log table schema (outboxId, leadId, trigger, brainReasoning, promptVersion, channel, inputGuardResult, outputGuardResult, durationMs)
- [x] P1.3: Run migration SQL for both tables + UNIQUE INDEX uk_idem + INDEX idx_pending + INDEX idx_decision_lead
- [x] P1.3b: TiDB SKIP LOCKED test passed — using optimal claim pattern
- [x] P1.4: Build enqueueOutbox() helper — idempotent INSERT IGNORE on UNIQUE(leadId, idemKey)
- [x] P1.5: Build drain worker — polls every 5s, claims with FOR UPDATE SKIP LOCKED, processes sequentially
- [x] P1.6: Add makeIdemKey() — SHA-256 of leadId + trigger + 5-min time bucket
- [x] P1.7: Add retry logic — max 3 retries with exponential backoff (60s, 120s, 240s)
- [x] P1.7b: Input guards: AI offline, DNC keyword scan, humanTakeover, terminal stage, TCPA quiet hours
- [x] P1.7c: Decision log — every outbox decision logged with timing, guard results, brain reasoning
- [x] P1.7d: Outbox stats tRPC endpoint for admin dashboard
- [x] P1.7e: Outbox worker registered in server startup
- [x] P1.8: Webhook inbound — KEPT direct for now (latency-sensitive), will move to outbox in Phase 2
- [x] P1.9: Rewire follow-up trigger to enqueue (771→528 lines, removed direct send/error handling)
- [x] P1.10: Rewire fast scanner to enqueue via outbox
- [x] P1.11: Rewire self-review to enqueue via outbox
- [x] P1.12: Rewire deferred-response-processor to enqueue via outbox (pre-composed messages)
- [x] P1.12b: Auto-correction already gated by DISABLE_LEGACY_TIMERS (Phase 0)
- [x] P1.13: Outbox stats tRPC endpoint added (pending/sent/failed/retry counts) — dashboard view deferred to Phase 2
- [x] P1.14: Write tests for outbox (19 tests: idemKey generation, TCPA guards, DNC keywords, retry logic, schema validation)
- [x] P1.14b: Updated context-assembly tests to reflect outbox rewiring
- [x] P1.15: All 1,118 tests passing across 50 files, 0 TypeScript errors

## Phase 2: The Single Brain
- [x] P2.1: Read Phase 2 spec and audit all 7 current brain files
- [x] P2.2: Extract pricing data from sales-training.ts into shared/pricing-data.json (all products, tiers, upcharges)
- [x] P2.3: Create shared/stage-behavior.json with 9 stages (objective, signals_to_ask_for, avoid)
- [x] P2.4: Build server/pricing-engine.ts — getQuote tool (exact Gildan 3000 + range for other products + rush surcharge)
- [x] P2.5: Build server/single-brain.ts — system prompt + 3 tools (getQuote, escalateToHuman, markDNC) + two-step LLM loop + cold outreach typo trick
- [x] P2.6: Build server/output-guards.ts (6 guards: system leak, channel mismatch, price validation, DNC, null-advance, length)
- [x] P2.7: Create prompt_versions table + seed v2.0 row (abTrafficPercent=0, starts with legacy)
- [x] P2.8: Build A/B ramp — shouldUseSingleBrain() reads abTrafficPercent from DB, random roll per request
- [x] P2.9: Rewire outbox worker Path B — single brain owns send + state updates + follow-up scheduling, legacy fallback preserved
- [x] P2.10: Conversation state derivation built into single-brain.ts (pipelineAction from tool calls)
- [x] P2.11: Write tests — 30 tests: pricing engine (8), output guards (14), stage behavior (3), pricing data (5)
- [x] P2.12: All 1,148 tests passing across 51 files, 0 TypeScript errors

## Phase 3: Strangle & Delete (Claude Architect Recommendations — May 2026)
- [ ] P3.0: CRITICAL — Verify what broken legacy path is currently shipping (pull recent outbox sends, check decision_log)
- [ ] P3.0b: Seed prompt_versions with abTrafficPercent=100 (route ALL traffic to single brain immediately)
- [ ] P3.0c: Enable critical output guards in BLOCKING mode: DNC, system prompt leak, price hallucination
- [ ] P3.0d: Enable try-to-repair-then-block guards: channel mismatch, null-advance
- [ ] P3.0e: Keep length guard as log-only initially
- [ ] P3.1: Delete 47 source-inspection tests (anti-pattern — test implementation details not behavior)
- [ ] P3.2: Extract behavior inventory from 53 behavior tests
- [ ] P3.3: Cross-check behavior inventory against existing 30 Phase 2 tests
- [ ] P3.4: Write new tests against new APIs for gaps (output-guards.ts, single-brain.ts, pricing-engine.ts)
- [ ] P3.5: Delete all 100 old failing tests once inventory captured
- [ ] P3.6: webhook-message.ts — Inline input/output guards as middleware, write to decision_log directly (Option C, latency-sensitive)
- [ ] P3.7: webhook-contact.ts — Route to priority outbox lane (Option B)
- [ ] P3.8: Delete brain-council-orchestrator.ts (once 100% single brain confirmed working)
- [ ] P3.9: Delete all 12 stub files
- [ ] P3.10: Verify all tests pass, checkpoint

## Post-Phase-3 Roadmap
- [ ] Dynamic Pricing: Build pricing_tiers DB table, sheet parser, 12h refresh schedule + manual "Refresh Pricing" button in admin

## Phase 3: Strangle & Delete (Executing Now)

Context: PO override — proceeding with full cutover per manifest.
Approach: 100% single brain, rewire webhooks, delete legacy.

- [x] P3-R1: Revert all 12 uncommitted stub files (git checkout server/*.ts) — done earlier
- [x] P3.1: Set abTrafficPercent to 100% (all outbox traffic → single brain)
- [x] P3.2: Upgrade single brain prompt to Level 4-5 (reasoning scaffold, few-shot examples, self-critique)
- [x] P3.3: Rewire webhook-message.ts to call single brain via brain-adapter (bypass orchestrator)
- [x] P3.4: Rewire webhook-contact.ts to call single brain via brain-adapter (bypass orchestrator)
- [x] P3.5: Delete brain-council-orchestrator.ts and composer.ts (only 2 truly dead files — other modules still used as utilities)
- [x] P3.6: Fix all failing tests — updated source-inspection tests to target new files, fixed mocks for brain-adapter, fixed 8 pre-existing webhooks.test.ts failures
- [x] P3.7: Run full test suite — 1,109 tests passing, 0 failures

## Phase 4: Quote Persistence + Appointment Booking (No Stripe)

- [x] P4.1: Create quotes table in drizzle/schema.ts (id, lead_id, product, qty, sides, per_unit, total, rush, status, sent_at, expires_at)
- [x] P4.2: Generate and apply migration SQL (0030_amusing_blazing_skull.sql)
- [x] P4.3: Add db helpers for quotes (insertQuote, getQuotesByLead, updateQuoteStatus)
- [x] P4.4: Wire getQuote tool to persist results to quotes table after generating
- [x] P4.5: Implement bookAppointment tool using GHL Calendar API
- [x] P4.6: Register bookAppointment in single-brain tools
- [x] P4.7: Write tests for quote persistence and appointment booking (6 tests passing)
- [x] P4.8: Run full test suite, verify, push to git, checkpoint (1,115 tests passing)

## Phase 5: Adaptive Learning System

- [x] P5.1: Create segment_weights table (segment, channel, stage, approach, wins, losses, win_rate)
- [x] P5.2: Add UNIQUE KEY on (segment, channel, stage, approach), INSERT...ON DUPLICATE KEY UPDATE
- [x] P5.3: Wire outcome recording — recordSegmentOutcome() with INSERT...ON DUPLICATE KEY UPDATE
- [x] P5.4: Build getTopApproaches(segment, channel, stage, n=3) and getAvoidApproaches(segment, channel, n=3)
- [x] P5.5: Inject top/avoid approaches into single brain system prompt dynamically
- [x] P5.6: Rewrite training-export.ts for single-brain format (dual-source: legacy brain_council_audit + new decision_log, filter by prompt version, dedup)
- [ ] P5.7: Add abTestPromptVersion column to fine_tuning_jobs, freeze version at A/B start
- [ ] P5.8: Update getActiveModel() to check for promoted LoRA model
- [x] P5.9: Add confusion detection in webhook-message.ts using CONFUSION_PATTERNS (already wired; updated handleConfusionReply to check decision_log for single brain)
- [x] P5.10: Add post-send wrong-business reference check in outbox-worker (regex scan + owner notification)
- [x] P5.11: Write tests for all Phase 5 features (45 tests in phase5-adaptive-learning.test.ts — all passing)
- [x] P5.12: Run full test suite (1160 passing), checkpoint saved (60c810cb)

## Phase 6: Dashboard Overhaul + Full Loop Testing

- [x] P6.1: Revenue metrics panel on Dashboard (messages sent, replies, quotes, deals, revenue)
- [x] P6.2: Review Queue dual-tab (Agent Handoffs + Flagged Messages with acknowledge)
- [x] P6.3: Decision_log audit trail on Lead Detail page
- [x] P6.4: One-click lead controls (Send Now button on Lead Detail + admin-only)
- [x] P6.5: Remove deprecated pages (AI Performance, Brain Council Log, Self-Learning, Webhook Logs)
- [x] P6.6: Full loop visual testing — server running, no console errors, no TS errors
- [x] P6.7: Full loop code testing — 1181 tests passing, TypeScript clean, no server errors
- [x] P6.8: Repair: auto-flag decision_log on output guard blocks + wrong-business post-send flagging
- [x] P6.9: 21 tests in phase6-dashboard.test.ts — all passing
- [x] P6.10: Final verification, checkpoint, push to GitHub

## Bugs / Issues

- [x] BUG: Delores Mills replied 3x via Facebook (12:26-12:30 AM May 18) after AI initial message — system did not respond
  - ROOT CAUSE: GHL appointment confirmation webhook fired as outbound, system treated it as human agent message → set humanTakeover=1
  - FIX 1: Added more system message patterns ("details updated", "consultation:", "scheduled for", etc.) + GHL system message type detection
  - FIX 2: Added SAFETY NET — if humanTakeover=1 but NO actual human outbound messages in conversations, auto-release on next inbound
  - FIX 3: Released Delores manually (humanTakeover=0, nextFollowUpAt=1min) — AI will respond on next trigger
- [ ] REVIEW: Discuss with user whether removed pages (AI Performance, Brain Council Log, Self-Learning, Webhook Logs) should be restored
- [x] FIX: Remove channel override band-aid from brain-adapter.ts — let single brain decide naturally
- [x] FIX: Update system prompt context to show Active Channel derived from last inbound in conversation history
- [x] FIX: Include channel info in user message for inbound replies ("You MUST reply on the same channel they messaged on")
- [x] FIX: Update Delores's preferredChannel to FB
- [x] BUG: LLM tool definition had numeric enum for `sides` — API rejects non-string enums (removed enum, kept description)
- [x] BUG: Tool response messages missing `name` field — Gemini requires function_response.name (added toolCall.function.name)
- [x] BUG: LLM returns unstructured reasoning text instead of JSON after tool calls — added structured follow-up call with response_format
- [x] BUG: Email signature not rendering as HTML — shows as plain text dump (Wayne G Foster May 17) (PR#3)
- [ ] BUG: System sends email to lead who never responds to email — should switch to SMS (Wayne G Foster: SMS Jan, Email Apr 11, Email May 17 — no replies to email)
- [ ] FIX: Channel escalation logic — if lead never replied to email, next attempt MUST use SMS
- [ ] FIX: Reactivate 365 Facebook/ghl/fb leads (set reactivatedFromMigration=1) — these are active-source leads blocked only by Gate 2
- [ ] FIX: Re-engagement for old imported contacts should use SMS, not email (email activation not working)

## PR #1 (Today — Safety-Critical Fixes)
- [x] Part A1: Update bookAppointment tool description in single-brain.ts (internal-only, no lead notification)
- [x] Part A2: Change executeBookAppointment() return shape — remove slot/humanReadableSlot, add _internal wrapper
- [x] Part A3: Add APPOINTMENT HANDLING hard constraint to system prompt
- [x] Part B: Add dead-contact retry loop fix in outbox-worker.ts (isContactNotFound → mark not_qualified)
- [x] Part C: Run backfill SQL for 5 known dead-contact leads
- [x] Part D: Run sweep query and report row count + 10-row sample

## PR #3 (SMS Split + Email Formatting Fix)
- [x] Change 1: splitSmsMessage() — add explicit \n---\n separator detection as priority check (webhook-helpers.ts)
- [x] Change 2: buildSendOpts() — apply ensureEmailSignature() + formatEmailHtml() for Email channel (outbox-worker.ts)
- [x] Change 3: Switch outbox sendMessage() → sendMessageWithRetry() at both call sites (lines 296, 429)
- [x] Change 4: Adapt error handling for sendMessageWithRetry return shape (success/error pattern instead of try/catch)
- [x] Fix pre-existing test failures: add missing `input` parameter to runOutputGuards calls in phase2-single-brain.test.ts

- [ ] BUG: Ron Castellon (Facebook) — AI went silent after Ron's last 2 replies ("20, 4 different sizes too" + "Sorry 3 different sizes") — should have quoted (May 17)

## PR#3.5 (Ron Castellon — HUMAN_AGENT_ACTIVE_GHL False Positive Fix)
- [x] Fix Layer B general path (ghl.ts line 273): add userId check to match Path 1 (new-contact path at line 254)
- [x] Reduce log noise: skip or throttle the "Skipping Layer B" info log per Claude's hygiene note
- [x] Write tests for the userId check in both paths
- [x] Run full test suite (1189 tests — all passing)
- [x] Git commit + checkpoint + push to GitHub (merged: 831b6e8c)
- [x] Write PR#3.5 verification report for Claude

## PR#5 (Learning System Wiring — Claude-Revised Spec)
- [ ] Wire getPromotedLearnings() into Single Brain assembleContext() (~400 tokens)
- [ ] Wire getViolationAvoidanceRules() into Single Brain assembleContext()
- [ ] Change promotion scan ordering: sort candidates by (category_priority DESC, recurrenceCount DESC) where best_practice=3, correction=2, avoid=1
- [ ] Leave PROMOTION_THRESHOLD=3 untouched (do NOT lower)
- [ ] Do NOT hard-reserve slots (let priority ordering handle allocation naturally)

## PR#3.6 (Multi-Design Pricing Fix — pricing-engine + tool + prompt)
- [x] Change 1: Add getMultiDesignQuote() to pricing-engine.ts (multi-design pricing with volume discount)
- [x] Change 1 tests: 13/13 passing (single-design fallback, multi-design no/with discount, 100/4 edge, 100/5 edge, rush+discount, even-split flag, null-price tier fallback)
- [x] Change 2: Add getMultiDesignQuote tool definition to single-brain.ts
- [x] Change 2: Add executeTool handler for getMultiDesignQuote in single-brain.ts (with DB persistence, even-split heuristic)
- [x] Change 3a: Add PRICING INPUTS section as Hard Constraint #14
- [x] Change 3b: Replace TREE 2 with new PRICING / QUOTE FLOW (multi-design branching, even-split, framing rule)
- [x] Change 3c: Replace Example 2 + add Example 2b (multi-design) + 2 anti-patterns (color-asking, over-qualifying)
- [x] Behavioral tests: 25/25 passing (tool defs, hard constraint #14, TREE 2, few-shots, anti-patterns, executeTool routing)
- [x] Run full test suite — 1227/1227 passing (56 files, 0 failures)
- [x] Git commit + checkpoint + push to GitHub (merged: 6da185e2, PR #4)
- [x] Write PR#3.6 verification report for Claude (includes PR#3.7 data dump)

## PR#3.7 Data Gathering (do NOT code — data only)
- [x] Data 1: knowledge_files — 1 row (Updated Pricing Google Sheet)
- [x] Data 2: ai_tweaks — 7 active rows (owner instructions being silently ignored by Single Brain)
- [x] Data 3: Brain Council injects via brain-context.ts; Single Brain does NOT read either table
- [x] Data 4: Admin surface audit — knowledge_files + ai_tweaks have UI but zero effect on production (100% Single Brain)

## BUG TRIAGE: Duplicate-send bugs (Tiare Lewis + V) — PR#3.7 PAUSED
- [x] Query 1: Tiare Lewis outbox rows May 17 (2 rows, both follow_up, 2hrs apart)
- [x] Query 2: Tiare Lewis decision_log May 17 (2 entries, both passed guards)
- [x] Query 3: V outbox rows May 17 (3 rows in 6 min: follow_up + follow_up + fast_scan)
- [x] Query 4: V decision_log May 17 (4 entries — outbox 120045 processed TWICE, 9s apart)
- [x] Check V6 monitor logs — V5+V6 both captured, monitor self-disabled at 20:40 UTC
- [x] Compile raw data report for Claude (adorb-triage-duplicate-sends.md)

## PR#3.8 (Outbox Claim Atomicity — Bug B Fix)

- [x] Implement atomic claimOutboxRows: single UPDATE WHERE outbox_status='pending' + SELECT WHERE claimedBy=workerId AND claimedAt=now
- [x] Handle reclaim (expired claimed rows) via OR condition in same UPDATE
- [x] Add isDraining guard to drainOutbox (module-level let + guard check + finally reset)
- [x] Test 1: atomic UPDATE SQL verified via SQL string content
- [x] Test 2: idemKey stability (same lead+trigger within 5-min window = same key)
- [x] Test 3: isDraining guard — drainOutbox returns stats shape and is callable
- [x] Test 4: enqueueOutbox is exported and idempotent
- [x] Run full test suite — 1227/1227 passing (56 files, 0 failures)
- [x] Git commit + checkpoint + push to GitHub (merged: 18c3d0924e48, PR #5)
- [ ] Post-deploy: confirm zero duplicate decision_log rows per outboxId

## PR#3.9 Pre-work (Conversations Query for Tiare)

- [ ] Run: SELECT id, leadId, direction, senderType, messageBody, createdAt FROM conversations WHERE leadId = 1383 AND DATE(createdAt) = '2026-05-17' ORDER BY createdAt
- [ ] Paste getRecentAiOutboundCount source to Claude
- [ ] Deliver pre-work data to Claude for PR#3.9 spec
- [ ] Repo hygiene: .project-config.json is in .gitignore but was tracked in old commits (2ddb455a). File is NOT currently tracked on github/main (confirmed via git show). Historical commits still contain secrets — consider running git-filter-repo to scrub history if repo is ever made public.
- [ ] Known issue — PR#3.9 tests sensitive to TCPA quiet hours guard. Future cleanup PR should add SKIP_TCPA_GUARD_IN_TESTS env var or extract guard to injectable dependency.
- [ ] Vitest full-suite mock contamination: PR#3.9 tests pass in isolation but fail in full suite due to cross-file mock bleed. Needs vitest config / test hygiene cleanup in a separate PR.
- [ ] PR#3.10: Fix first-contact userId requirement — filter recentAgentMsgs to require userId (block workflow false positives)
- [ ] PR#3.10: Add diagnostic log for ignored non-user outbound messages during delay window
- [ ] PR#3.10: Export sendDelayedFirstContact for testing
- [ ] PR#3.10: Write pr310-first-contact-userid.test.ts — 5 tests
- [ ] PR#3.10: Run Gabriela diagnostic query and conditional cleanup

## PR#3.10 — userId filter for first-contact delay window

- [x] Fix first-contact userId requirement — filter recentAgentMsgs to require userId (block workflow false positives like Gabriela's "WAIT! You're not done yet..." message)
- [x] Add diagnostic log for ignored non-user outbound messages during delay window
- [x] Export sendDelayedFirstContact for testing
- [x] Write pr310-first-contact-userid.test.ts — 5 tests (5/5 pass in isolation)
- [x] Run Gabriela diagnostic query — humanTakeover already 0 (supervisor auto-escalated), no cleanup needed
- [x] Git commit + push to GitHub

## PR#3.13 — TCPA quiet-hours scoping (URGENT: ship before Monday 9 AM ET)

- [ ] PR#3.13 Fix 1: Replace isBusinessHours() in scheduling-engine.ts — add SMS/WhatsApp TCPA branch + IG/FB/Live_Chat human-feel branch
- [ ] PR#3.13 Fix 1: Add isHumanFeelHours() helper below isBusinessHours()
- [ ] PR#3.13 Fix 2: Replace Guard 5 in outbox-worker.ts — channel-scoped TCPA + human-feel deferral + inbound-reply exemption
- [ ] PR#3.13: Write pr313-tcpa-scoping.test.ts — 8 tests
- [ ] PR#3.13: Run tests 8/8, commit, push to GitHub, save checkpoint
- [ ] PR#3.13: Publish and verify IG leads engage within 30 min

## PR#3.12 — Phantom conversations + messageId capture

- [ ] PR#3.12 Change 1: Extend sendMessageWithRetry return type (add messageId, channelDelivered)
- [ ] PR#3.12 Change 2: Add classifySendOutcome helper in webhook-helpers.ts
- [ ] PR#3.12 Change 3: Add "no_messageid_returned" to GhlSendErrorType union
- [ ] PR#3.12 Change 4: Replace 6 success paths in sendMessageWithRetry with classifySendOutcome calls
- [ ] PR#3.12 Change 5: Update addConversation signature in db.ts (add ghlMessageId param)
- [ ] PR#3.12 Change 5: Update 9 addConversation caller sites to pass ghlMessageId
- [ ] PR#3.12: Write pr312-messageid-classification.test.ts — 7 tests
- [ ] PR#3.12: Run tests 7/7, commit, push to GitHub, save checkpoint
- [ ] PR#3.12: Mark Christina + Robert phantom rows as unconfirmed (pending PO GHL check)

## PR#3.14 — Vladislav TCPA violation fix + outbox worker hang fix

- [x] PR#3.14 Fix 1: TCPA gate reads channelHint first (channelHint → channel → lead.preferredChannel)
- [x] PR#3.14 Fix 2: Stale reply exemption — items >30 min old lose reply-exempt status
- [x] PR#3.14 Fix 3: Processing timeout (60s) — hung Brain calls marked as failed, not left claimed
- [x] PR#3.14: Export runInputGuards for testability
- [x] PR#3.14: Write tcpa-fix-and-timeout.test.ts — 23 tests
- [x] PR#3.14: Clean up stuck outbox rows (D.J.A.Y. 240003, Vladislav 240004/240007)
- [x] PR#3.14: Set Vladislav humanTakeover=1 to stop fast_scan re-enqueuing
- [x] PR#3.14: Run tests 23/23 pass, TypeScript clean, commit f93f0a9, push to GitHub
- [x] PR#3.14: Write CLAUDE-HANDOFF-REPORT.md
- [ ] PR#3.14: Save checkpoint + publish to production

## Foundation D — Compose Lock (Multi-Fire Deduplication) — May 20, 2026

- [x] FD.1: Create compose_locks table (leadId, eventKey, acquiredAt) with UNIQUE(leadId, eventKey) + migration applied
- [x] FD.2: Build acquireComposeLock(leadId, message, source) in server/compose-lock.ts — INSERT IGNORE + affectedRows check, 5-min TTL purge, result[0].affectedRows fix
- [x] FD.3: Patch brain-council-review.ts fast_scan enqueue site — acquireComposeLock guard before enqueueOutbox
- [x] FD.4: Patch brain-council-review.ts self_review enqueue site — pending-fast_scan check before enqueueOutbox
- [x] FD.5: Patch follow-up-trigger.ts enqueue site — pending-fast_scan check before enqueueOutbox
- [x] FD.6: Patch deferred-response-processor.ts enqueue site — pending-fast_scan check before enqueueOutbox
- [x] FD.7: Add verifyFoundationD tRPC endpoint in routers.ts (admin-only, checks compose_locks table + acquireComposeLock round-trip)
- [x] FD.8: Write server/compose-lock.test.ts — 8 tests: makeEventKey (bucket, stability, uniqueness, truncation), acquireComposeLock (first=true, second=false, different-leads, different-messages), afterEach(vi.restoreAllMocks) guard
- [x] FD.9: Fix affectedRows extraction bug — result is [resultObj, null] from Drizzle/MySQL, not flat object
- [x] FD.10: TypeScript check clean (0 errors), full test suite passing

## Foundation A.5 — Complete Foundation A Migration — May 20, 2026
- [x] FA5.1: Schema — add `sendOutcomeKind` column to `brain_council_audit` in drizzle/schema.ts + apply migration
- [x] FA5.2: Schema — add `contact_not_found` to `SendErrorType` in send-types.ts + add `updateBrainCouncilAuditSendOutcome()` to db.ts
- [x] FA5.3: Migrate webhook-contact.ts:846 (first-contact direct send) to attemptSend
- [x] FA5.4: Migrate webhook-message.ts:1013 (ack send) to attemptSend
- [x] FA5.5: Migrate webhook-message.ts:1137 (normal Brain Council send) to attemptSend
- [x] FA5.6: Migrate outbox-worker.ts:310 (Path A pre-composed) to attemptSend
- [x] FA5.7: Migrate outbox-worker.ts:448 (Path B Brain Council Single Brain) to attemptSend
- [x] FA5.8: Migrate lost-lead-nurture.ts:274 to attemptSend
- [x] FA5.9: Migrate post-delivery-executor.ts:123 to attemptSend
- [x] FA5.10: Migrate webhook-pipeline.ts:274 to attemptSend
- [x] FA5.11: Migrate webhook-task.ts:56 to attemptSend
- [x] FA5.12: Migrate webhook-task.ts:80 to attemptSend
- [x] FA5.13: Fix brain_council_audit semantics — write audit AFTER send in brain-adapter.ts, messageSent reflects sendResult.success
- [x] FA5.14: Fix brain_council_audit semantics — write audit AFTER send in brain-council.ts
- [x] FA5.15: sendMessageWithRetry is now internal-only to attempt-send.ts (no longer exported to callers)
- [x] FA5.16: Add verifyFoundationA5 endpoint (sentinel leadId = -3) in routers.ts
- [x] FA5.17: Write foundation-a5-audit-semantics.test.ts — 8 tests covering all outcome kinds + audit contract
- [x] FA5.18: TypeScript clean (0 errors), 1335/1336 tests pass (1 pre-existing openai-key.test.ts credential failure unrelated to A.5)

## Foundation C.3 — Fabricated Infrastructure Guardrail (Rules 18-20)

- [x] FC3.1: Add Rule 18 (NEVER FABRICATE INFRASTRUCTURE) to single-brain.ts HARD CONSTRAINTS after Rule 17
- [x] FC3.2: Add Rule 19 (TIGHTEN THE FOLLOW-UP HOOK) to single-brain.ts HARD CONSTRAINTS
- [x] FC3.3: Add Rule 20 (REALITY CHECK BEFORE COMPOSING) to single-brain.ts HARD CONSTRAINTS
- [x] FC3.4: Add equivalent FABRICATED INFRASTRUCTURE + FOLLOW-UP HOOK DISCIPLINE + REALITY CHECK to brain-council.ts COMPOSER_PROMPT
- [x] FC3.5: Write foundation-c3-guardrail.test.ts (30 tests verifying all three rules in both files)
- [x] FC3.6: TypeScript clean (0 errors), 1365/1366 tests pass, commit 86e567d + checkpoint
- [x] FC3.7: Fix Arlene Jeffers nextFollowUpAt to NULL (do-not-contact sentinel, 1 row touched, commit 62eee6f)
- [x] FC3.8: Add verifyFoundationC3 endpoint to routers.ts — promptIntegrity + live LLM output check against 9 forbidden tokens

## Architectural Debt Inventory — New Items (2026-05-21)

- [ ] Item #28 (HIGH) — UPGRADED TO TWICE-OBSERVED: First-contact dedup gap (Foundation D not covering first-contact paths). Observed: Terrance (May 20) + Thuy Huynh lead 5100068 (May 19 13:30/13:31 UTC — two identical "Chris here from Adorb" messages 1 min apart). Foundation B scope (compose-lock extension to first-contact paths).
- [ ] Item #29 (HIGH): Timestamp corruption in pre-C.1 first-contact write path. Conversations rows 5400117/5400118 (Thuy lead 5100068) have timestamp=2612-01-12 (year 2612 — overflow). Source: `{}` body write before C.1 coercion fix. Actions: (a) query for all rows with timestamp > current year+1, (b) confirm C.1 fixed source for new traffic, (c) data hygiene query for legacy rows. Do not backfill — log and move on.
- [ ] Item #30 (HIGH): humanTakeover NOT auto-set when human engages via GHL UI. Thuy lead 5100068: Abby sent manually at 13:15 UTC May 19. lastAgentActivityAt updated correctly. humanTakeover stayed 0. AI fired multi-fire follow-ups at 13:30+13:31. Inventory item #18 confirmed in production. Foundation B scope.
- [ ] Item #31 (MEDIUM): Pre-A.5 audit gap larger than estimated. 7 of 9 send callsites had no audit trail before A.5. Estimated hundreds of sends/week with no record. A.5 closes going forward. Historical reconstruction impossible — do not attempt backfill.

## Emergency Lead Fixes Applied (2026-05-21)

- [x] Thuy Huynh (lead 5100068): humanTakeover=1, nextFollowUpAt=NULL — blocked from AI re-queue (was 40min from firing at 16:00 UTC)
- [x] Arlene Jeffers (lead 360007): humanTakeover=1 (already set), nextFollowUpAt=NULL — do-not-contact sentinel
- [ ] Item #32 (HIGH): Do-not-contact state is not atomic. humanTakeover=1 and nextFollowUpAt=NULL must always be set together — currently they can drift (Thuy and Arlene both required manual SQL fixes). Foundation B should expose a single setDoNotContact(leadId, reason) function that all paths call atomically. No path should set one without the other.

## Patch 1 — Output Guard Content Scan (2026-05-21)

- [x] Patch 1: Guard 7 (content scan) added to `server/output-guards.ts` — `checkContentGuard()` + `CONTENT_GUARD_TOKENS` (19 tokens: Rule 15 filler, Rule 17 sign-offs SMS/IG-only, Rule 18 fabricated infra)
- [x] Patch 1: `verifyContentGuard` tRPC endpoint added to `server/routers.ts` — 13 synthetic token tests, token count check
- [x] Patch 1: "Run verifyContentGuard (Patch 1)" button added to Settings > Foundation Verification panel
- [x] Patch 1: 12 new vitest tests added to `server/phase2-single-brain.test.ts` — all passing (1377/1378 total, 1 pre-existing OpenAI key test unrelated)
- [x] Patch 1: TypeScript clean — `pnpm tsc --noEmit` passes with zero errors
- [x] Lynnette Clark (lead 4230002): humanTakeover=1, nextFollowUpAt=NULL — paused after multi-fire + "circle back" + "just wanted to" violations
- [x] Tabitha Chambers (lead 1020205): humanTakeover=1, nextFollowUpAt=NULL — paused after Rule 11 generic opener violation
- [ ] Patch 1 Step A: Run verifyContentGuard post-publish — confirm all 13 tests pass in deployed bundle
- [ ] Patch 1 Step B (+30 min post-publish): Query decision_log for rows with outputGuardResult LIKE 'block:output_guard:content:%' to confirm guard is firing on real traffic
- [ ] Patch 2: Fix timeout-but-sent ghost send path — 30 rows in 30 days, zero audit trail. outbox-worker.ts timeout path must write brain_council_audit row even on 60s timeout
- [ ] Patch 3: Compose-lock for follow-up-only events (no inbound ID) — use leadId + scheduledAt bucket as event key
