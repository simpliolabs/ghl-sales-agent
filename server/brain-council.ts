/**
 * BRAIN COUNCIL — Multi-brain architecture for Adorb Outreach
 * 
 * Four specialized brains work in sequence:
 * 1. STRATEGIST — Decides approach, channel, timing, angle, personalization tier
 * 2. RESEARCHER — Gathers online context about the lead (web, social, company)
 * 3. COMPOSER — Writes the actual message using brand voice + strategy
 * 4. QC REVIEWER — Reviews message for quality, tone, repetition, accuracy before sending
 * 
 * Flow: Strategy → Research → Compose → QC → Send (or reject + recompose)
 */

import { invokeLLM } from "./_core/llm";
import { getDb, addBrainCouncilAudit } from "./db";
import { aiState, aiTweaks, knowledgeFiles, conversations, leads } from "../drizzle/schema";
import { eq, desc } from "drizzle-orm";

// ============================================================
// TYPES
// ============================================================

export interface BrainCouncilInput {
  leadId: number;
  incomingMessage: string;
  channel: string;
  externalHistory?: string;
  formData?: Array<{ label: string; value: string }>;
  overrideReason?: string; // If admin manually rescheduled, why
}

export interface StrategyDecision {
  approach: "first_contact" | "follow_up" | "reactivation" | "post_delivery" | "seasonal" | "value_add";
  channel: string;
  angle: string;
  framework: "PAS" | "BAB" | "AIDA" | "HORMOZI_ACA" | "HORMOZI_INDIRECT" | "SOCIAL_PROOF" | "CASE_STUDY" | "SOAP_OPERA" | "EMB_WELCOME" | "EMB_WINBACK" | "EMB_POST_PURCHASE" | "EMB_COLD";
  personalizationTier: 1 | 2 | 3;
  toneDirective: string;
  maxLength: number; // max chars for the message
  keyPoints: string[]; // what MUST be included
  avoidPoints: string[]; // what MUST NOT be said
  nextEngagementHours: number;
  reasoning: string;
}

export interface ResearchResult {
  companyInfo: string;
  recentActivity: string;
  likelyPainPoints: string[];
  connectionPoints: string[];
  competitorInsights: string;
  seasonalRelevance: string;
  summary: string;
}

export interface ComposedMessage {
  message: string;
  fromName: string;
  subject?: string; // for email
  internalNotes: string;
}

export interface QCVerdict {
  approved: boolean;
  score: number; // 0-100 quality score
  issues: string[];
  suggestions: string[];
  revisedMessage?: string; // if QC fixes it directly
}

export interface BrainCouncilOutput {
  message: string;
  fromName: string;
  subject?: string;
  framework: string;
  angle: string;
  extractedDates: string[];
  score: number;
  segment: string;
  nextEngagementHours: number;
  qcScore: number;
  strategyReasoning: string;
  researchSummary: string;
}

// ============================================================
// SHARED CONTEXT BUILDER
// ============================================================

async function buildLeadContext(leadId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [leadRows] = await Promise.all([
    db.select().from(leads).where(eq(leads.id, leadId)).limit(1),
  ]);
  const lead = leadRows[0];
  if (!lead) throw new Error("Lead not found");

  const convHistory = await db.select().from(conversations)
    .where(eq(conversations.leadId, leadId))
    .orderBy(desc(conversations.timestamp))
    .limit(30);

  const stateRows = await db.select().from(aiState).where(eq(aiState.leadId, leadId)).limit(1);
  const state = stateRows[0];

  const tweaks = await db.select().from(aiTweaks).where(eq(aiTweaks.status, "active"));
  const tweakInstructions = tweaks.map(t => t.tweakInstruction).join("\n");

  const kbFiles = await db.select().from(knowledgeFiles);
  const kbContent = kbFiles.map(f => `[${f.fileName}]: ${f.contentText || ""}`).join("\n\n");

  const historyStr = convHistory.reverse().map(c =>
    `[${c.senderType}/${c.channel}] ${c.messageBody}`
  ).join("\n");

  const priorAiMessages = convHistory.filter(c => c.senderType === "ai" && c.direction === "outbound");
  const priorOutbound = convHistory.filter(c => c.direction === "outbound");
  const isFirstResponse = priorAiMessages.length === 0;

  const leadCreatedAt = lead.createdAt ? new Date(lead.createdAt).getTime() : Date.now();
  const leadAgeDays = Math.floor((Date.now() - leadCreatedAt) / (1000 * 60 * 60 * 24));
  let urgencyStage = "Day 0 (first contact)";
  if (leadAgeDays >= 30) urgencyStage = "Day 30+ (dormant)";
  else if (leadAgeDays >= 15) urgencyStage = "Day 15-30 (stale)";
  else if (leadAgeDays >= 8) urgencyStage = "Day 8-14 (cold)";
  else if (leadAgeDays >= 4) urgencyStage = "Day 4-7 (cooling)";
  else if (leadAgeDays >= 1) urgencyStage = "Day 1-3 (warm)";

  // Count consecutive unanswered outbound messages
  let unansweredCount = 0;
  for (const c of [...convHistory].reverse()) {
    if (c.direction === "outbound") unansweredCount++;
    else break;
  }

  return {
    lead,
    convHistory,
    state,
    tweakInstructions,
    kbContent,
    historyStr,
    isFirstResponse,
    priorOutbound,
    leadAgeDays,
    urgencyStage,
    unansweredCount,
  };
}

// ============================================================
// BRAIN 1: STRATEGIST
// ============================================================

const STRATEGIST_PROMPT = `You are the STRATEGIST brain for Adorb Custom Tees' AI outreach system.

Your job is to DECIDE the approach — you do NOT write the message. You analyze the lead's situation and produce a strategic directive that the Composer brain will follow.

=== FRAMEWORKS YOU KNOW ===

HORMOZI CORE FOUR + ACA METHOD (from $100M Leads by Alex Hormozi):

The Core Four Prospecting Techniques:
1. Warm Outreach — reach people who already know you (fastest path to qualified leads)
2. Cold Outreach — reach strangers (numbers game, Rule of 100: contact 100 people/day)
3. Free Content — share valuable content (substance, not fluff)
4. Paid Ads — test small, proceed with caution

The ACA Method (Acknowledge, Compliment, Ask):
- A (Acknowledge): Reference something SPECIFIC about the lead. "Cool, my dad is also an accountant."
- C (Compliment): Sincere, subtle compliment related to the fact. "You must be very detail-oriented."
- A (Ask): Question that transitions to what you're selling. "Does sitting all day prevent you from exercising?"

ACA for Follow-ups:
- Acknowledge: "I know you mentioned you were busy when we last spoke..."
- Compliment: "...which makes sense because successful business owners like you always are."
- Ask: "Have you had a chance to think about [previous topic], or should I follow up next month?"

Hormozi Indirect Selling:
- NEVER say "buy my products"
- Instead: "Do you know anyone who is facing [problem] and looking to achieve [results] within [time]?"
- If they're interested, they'll self-identify. If they know someone, you gain social proof.

Hormozi Prospecting Message Formulas:
- Phone/Voicemail: "Hi [name], it's [your name]. I'm calling in reference to [competitor]. Please call back." (curiosity-driven)
- Email subject: Use curiosity hooks ("I'm watching you"), provide specific value observation, suggest 15-min call
- Social DM: "Are you still looking to [activity]?" — the "still" creates urgency

Hormozi Cold Outreach Cadence:
- Day 0: First contact on their inbound channel only (research-first, never blind)
- Day 7: Follow-up #1 with new value/angle (different hook, same channel)
- Day 14: Follow-up #2 or try different channel (escalate)
- Day 21: Break-up message (leave with class, indirect ask)

Dan Martell Customer Engagement:
- Engagement deeply rooted in conversation, not pitching
- Dynamic reactivation based on specific customer needs
- Reactivate 30-60 days before specific event dates mentioned by customer
- Value-first approach: lead with insight, not with ask

Personalization Tiers:
- Tier 1 (full custom): Research their Google reviews, reference specific details, ACA method
- Tier 2 (template + personal opener): Segment-specific template with name + business personalization
- Tier 3 (minimal custom): Name + source acknowledgment only

CAMPAIGN ORCHESTRATOR PATTERN:
- Auto-terminate sequence when lead replies
- Pre-campaign checklist: no apologetic language, no easy outs, professional not needy
- Timing: immediate → +4h → +1 day → +4 days → +7 days

SENTIMENT PRIORITY SCORING:
- priority = 100 * (0.40*urgency + 0.30*intent + 0.20*recency + 0.10*sentiment_risk)
- P1 (>=75): immediate action | P2 (50-74): scheduled follow-up | P3 (<50): nurture

EMAIL MARKETING BIBLE — STRATEGY FRAMEWORKS (Source: EMB V1.0, 908 sources):

Email ROI: $36-42 per $1 spent (3,600%). SMS: $20-25. Social: $2-5. Email wins.

Automation Flow Priority (by revenue impact per setup hour):
1. Welcome series → 2. Abandoned cart → 3. Browse abandonment → 4. Post-purchase → 5. Win-back → 6. Cross-sell/upsell

Welcome Series (4-6 emails, 1-2 weeks):
- Email 1 (immediate): Deliver promise + ask for reply + one segmentation question
- Email 2 (Day 2): Brand story
- Email 3 (Day 4): Social proof
- Email 4 (Day 7): Best content using segmentation data
- Email 5 (Day 10): Soft sell
- Email 6 (Day 14): Set expectations

Win-Back (target 60-90 day inactive):
1. "We miss you" → 2. Value offer → 3. Breakup email (highest reply rate) → 4. Confirmation + re-subscribe

Engagement-Based Sending Tiers:
- Tier 1: Clicked last 30 days → every campaign
- Tier 2: Clicked last 60 days → 75% of sends
- Tier 3: Clicked last 90 days → best content only
- Tier 4: No engagement 90-180 days → re-engagement flow only
- Tier 5: 180+ days → sunset flow

Cold Email Infrastructure (from EMB Chapter 13):
- NEVER send cold email from primary domain. Use separate domains.
- Limit: 10-30 emails per inbox per day. Warm 2-4 weeks minimum.
- Optimal length: 50-125 words.
- Interest-based CTAs: 2-3x more replies than meeting requests.
- Follow-up: 4 emails over 2-3 weeks. Each MUST add new value.
- Breakup email = 2-3x reply rate of mid-sequence.

Segmentation (from EMB Chapter 3):
- Personalisation hierarchy: Behavioural > Lifecycle > Dynamic content > Send-time > Location > Name
- RFM: Recency (last 30d active, 31-90d warm, 91-180d cooling, 180+ cold)
- Waterfall priority: Abandoned cart → Post-purchase → Browse abandonment → Win-back → Promotional

Deliverability (from EMB Chapter 7):
- Authentication: SPF + DKIM + DMARC all required since Feb 2024
- Domain reputation > IP reputation for Gmail (120-day window)
- Personal sender name > brand name (+3.81% opens)
- Complaint rate must stay under 0.1%
- Only ~60% of "delivered" emails reach visible inbox

=== WHAT KILLS OUTREACH (NEVER DO) ===
- "I'd love to pick your brain"
- "Can I get 15 minutes of your time?"
- Long paragraphs about yourself
- Immediate pitch in first message
- Same message to everyone
- Following up every 2 days
- "Hope this finds you well"
- "Just checking in"
- "Touching base"
- Apologetic language ("sorry to bother")
- Easy outs ("if not relevant, no problem")

=== YOUR OUTPUT ===
Analyze the lead context and produce a strategic directive. Be specific and actionable.`;

async function runStrategist(input: BrainCouncilInput, context: Awaited<ReturnType<typeof buildLeadContext>>): Promise<StrategyDecision> {
  const { lead, state, historyStr, isFirstResponse, leadAgeDays, urgencyStage, unansweredCount } = context;

  const strategistInput = `
LEAD PROFILE:
- Name: ${lead.name || "Unknown"}
- Business: ${lead.businessName || "Unknown"}
- Source: ${lead.source || "Unknown"}
- Pipeline Stage: ${lead.pipelineStage}
- Score: ${lead.opportunityScore}/100
- Assigned Agent: ${lead.assignedAgent || "Unassigned"}
- Research: ${JSON.stringify(lead.researchData || {})}

ENGAGEMENT STATE:
- First response? ${isFirstResponse ? "YES" : "NO"}
- Lead age: ${leadAgeDays} days (${urgencyStage})
- Channel: ${input.channel}
- Unanswered outbound messages: ${unansweredCount}
- Total messages: ${context.convHistory.length}
- Last framework used: ${state?.lastFrameworkUsed || "none"}
- Last angle used: ${state?.lastAngleUsed || "none"}
- Sentiment trend: ${state?.sentimentTrend || "neutral"}
- Objections: ${JSON.stringify(state?.objectionsRaised || [])}
- Interest signals: ${JSON.stringify(state?.interestSignals || [])}
- Extracted dates: ${JSON.stringify(state?.extractedDates || [])}
${input.overrideReason ? `- Admin override reason (from input): ${input.overrideReason}` : ""}
${lead.overrideReason ? `- Last admin override: ${lead.overrideReason} (by ${lead.overrideBy || "admin"} at ${lead.overrideAt ? new Date(lead.overrideAt).toLocaleString() : "unknown"})` : ""}

FORM DATA (if any):
${input.formData?.map(f => `- ${f.label}: ${f.value}`).join("\n") || "None"}

CONVERSATION HISTORY:
${input.externalHistory ? input.externalHistory + "\n" + historyStr : historyStr || "No previous messages"}

INCOMING MESSAGE:
${input.incomingMessage}

Produce your strategic directive now.`;

  const response = await invokeLLM({
    messages: [
      { role: "system", content: STRATEGIST_PROMPT },
      { role: "user", content: strategistInput },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "strategy_decision",
        strict: true,
        schema: {
          type: "object",
          properties: {
            approach: { type: "string", description: "first_contact|follow_up|reactivation|post_delivery|seasonal|value_add" },
            channel: { type: "string", description: "SMS|Email|FB|IG|WhatsApp" },
            angle: { type: "string", description: "The specific angle/hook to use" },
            framework: { type: "string", description: "PAS|BAB|AIDA|HORMOZI_ACA|HORMOZI_INDIRECT|SOCIAL_PROOF|CASE_STUDY" },
            personalizationTier: { type: "number", description: "1=full custom, 2=template+personal opener, 3=minimal" },
            toneDirective: { type: "string", description: "Specific tone instructions for the composer" },
            maxLength: { type: "number", description: "Max characters for the message" },
            keyPoints: { type: "array", items: { type: "string" }, description: "What MUST be included" },
            avoidPoints: { type: "array", items: { type: "string" }, description: "What MUST NOT be said" },
            nextEngagementHours: { type: "number", description: "Hours until next follow-up" },
            reasoning: { type: "string", description: "Why this strategy was chosen" },
          },
          required: ["approach", "channel", "angle", "framework", "personalizationTier", "toneDirective", "maxLength", "keyPoints", "avoidPoints", "nextEngagementHours", "reasoning"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error("Strategist brain produced no output");
  return JSON.parse(content as string);
}

// ============================================================
// BRAIN 2: RESEARCHER
// ============================================================

const RESEARCHER_PROMPT = `You are the RESEARCHER brain for Adorb Custom Tees' AI outreach system.

Your job is to synthesize all available information about a lead into actionable research context. You analyze:
- Their business name and what it suggests
- Their website (if available)
- Their source channel and what it implies
- Their conversation history for clues
- Their segment and what that segment typically needs
- Seasonal relevance (current date, upcoming events/holidays)

You produce a research brief that helps the Composer write a highly personalized message.

=== ADORB'S SEGMENTS AND TYPICAL NEEDS ===
- Church/Ministry: Sunday shirts, VBS, retreats, choir, youth group, missions trips
- Sports Team: Uniforms, fan gear, tournament shirts, spirit wear
- School: Spirit wear, fundraisers, clubs, graduation, teacher appreciation
- HVAC/Trades: Work uniforms, branded polos, truck decals
- Event Planner: Corporate events, galas, conferences, team building
- Brand/Business: Merch, uniforms, promotional items, grand opening
- Nonprofit: Fundraiser shirts, awareness campaigns, volunteer gear
- Other: Personal events (reunions, birthdays, bachelorette)

=== SEASONAL CALENDAR ===
- Jan-Feb: New Year resolutions, Valentine's Day, Super Bowl
- Mar-Apr: Spring break, Easter, March Madness, prom
- May-Jun: Graduation, Mother's/Father's Day, end of school, summer camps
- Jul-Aug: Back to school, summer events, 4th of July
- Sep-Oct: Fall sports, homecoming, Halloween, Hispanic Heritage Month
- Nov-Dec: Thanksgiving, Christmas, holiday parties, year-end gifts

Be concise and actionable. Focus on what helps write a better message.`;

async function runResearcher(input: BrainCouncilInput, context: Awaited<ReturnType<typeof buildLeadContext>>, strategy: StrategyDecision): Promise<ResearchResult> {
  const { lead, historyStr } = context;

  const researchInput = `
LEAD DATA:
- Name: ${lead.name || "Unknown"}
- Business: ${lead.businessName || "Unknown"}
- Website: ${lead.website || "N/A"}
- Email: ${lead.email || "N/A"}
- Source: ${lead.source || "Unknown"}
- Segment: ${lead.omnisendSegment || "Unclassified"}
- Existing Research: ${JSON.stringify(lead.researchData || {})}

STRATEGY CONTEXT:
- Approach: ${strategy.approach}
- Angle: ${strategy.angle}
- Personalization Tier: ${strategy.personalizationTier}

CONVERSATION HISTORY:
${input.externalHistory ? input.externalHistory + "\n" + historyStr : historyStr || "No previous messages"}

FORM DATA:
${input.formData?.map(f => `- ${f.label}: ${f.value}`).join("\n") || "None"}

Current date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}

Produce your research brief now.`;

  const response = await invokeLLM({
    messages: [
      { role: "system", content: RESEARCHER_PROMPT },
      { role: "user", content: researchInput },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "research_result",
        strict: true,
        schema: {
          type: "object",
          properties: {
            companyInfo: { type: "string", description: "What we know/infer about their organization" },
            recentActivity: { type: "string", description: "Any recent signals from conversation or data" },
            likelyPainPoints: { type: "array", items: { type: "string" }, description: "Their probable pain points" },
            connectionPoints: { type: "array", items: { type: "string" }, description: "Specific things to reference for personalization" },
            competitorInsights: { type: "string", description: "What alternatives they might be considering" },
            seasonalRelevance: { type: "string", description: "Any seasonal hooks relevant right now" },
            summary: { type: "string", description: "1-2 sentence research summary for the composer" },
          },
          required: ["companyInfo", "recentActivity", "likelyPainPoints", "connectionPoints", "competitorInsights", "seasonalRelevance", "summary"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) return {
    companyInfo: "Unknown", recentActivity: "None", likelyPainPoints: [],
    connectionPoints: [], competitorInsights: "Unknown", seasonalRelevance: "None",
    summary: "Insufficient data for research",
  };
  return JSON.parse(content as string);
}

// ============================================================
// BRAIN 3: COMPOSER
// ============================================================

const COMPOSER_PROMPT = `You are the COMPOSER brain for Adorb Custom Tees' AI outreach system.

You receive a STRATEGY DIRECTIVE and RESEARCH BRIEF, and you write the actual message. You are the voice of Adorb — warm, direct, confident, like texting a friend who runs a printing business.

=== ADORB BRAND VOICE ===
- Warm and personal, never corporate
- Short sentences, conversational tone
- Confident but not pushy
- Specific, never generic
- Like texting a friend who happens to be great at custom printing

=== ADORB FACTS (use naturally, don't dump) ===
- 4.9 stars, 1.1 Million+ happy customers
- Same-day turnaround available
- No minimum orders
- Based in Hallandale Beach, FL
- Products: T-shirts, hoodies, hats, mugs, bottles, pens, notebooks, stickers, business cards, flyers
- Printing: DTF, Embroidery, UV, UV DTF
- Phone: (954) 932-8543
- Email: print@adorbcustomtees.com

=== MESSAGE RULES ===
- SMS: 1-3 sentences max
- Email: 3-5 sentences max, include subject line
- Every message needs exactly ONE clear CTA
- Never dump multiple CTAs or list all services
- Never fake personalization
- Reference their prior conversation if it exists
- Sound like a continuation, not a cold pitch

=== EMAIL MARKETING BIBLE — COPYWRITING FRAMEWORKS ===
(Source: EMB V1.0, George Hartley, 908 sources, 65K words)

Subject Lines:
- 64% decide to open based on subject line. Under 25 chars = highest opens.
- Personalisation: +14% opens. First-person CTA > second-person (25-35% lift).
- "Start my free trial" > "Sign up" (90% lift in CTAs).

Body Copy Frameworks (use the one assigned by Strategist):
- AIDA: Attention → Interest → Desire → Action. Best for promotional.
- PAS: Problem → Agitate → Solution. Best for cold email, B2B.
- BAB: Before → After → Bridge. Best for case studies.
- Soap Opera Sequence: Multi-email narrative. 70%+ open rates deep in sequence.
- 1-3-1 Newsletter: One big story + three shorter items + one CTA.

Body Copy Rules:
- Inverted pyramid: key message first. Short paragraphs. Write, then cut 30%.
- 3:1 ratio: three value emails per one promotional.
- Buttons > text links (+27% CTR). Single CTA: +42% clicks vs multiple.
- Place CTA above fold AND below main content (+35% total clicks).

Cold Email Rules (from EMB Chapter 13):
- Optimal length: 50-125 words. Personalised opening → problem/observation → value prop → soft CTA.
- Interest-based CTAs get 2-3x more replies than meeting requests.
- Each follow-up MUST add new value. Breakup email = 2-3x reply rate of mid-sequence.
- NEVER: "I hope this email finds you well", "I'd love to pick your brain", "Just following up"

Personalisation Levels (from EMB):
- Hyper-personalised (5+ min research): 15-25% reply rate
- Semi-personalised (1-2 min): 8-15% reply rate
- Segmented (template/segment): 3-8% reply rate

Win-Back Email Sequence (from EMB Chapter 4):
- Target: 60-90 day inactive. Sequence: 3-4 emails over 2-3 weeks.
- Email 1: "We miss you" + what they're missing
- Email 2: Value offer (content, not discount)
- Email 3: Breakup email ("Should we remove you?") — highest reply rate
- Email 4: Final confirmation + easy re-subscribe

Post-Purchase Sequence (from EMB Chapter 4):
- Day 7-10: Satisfaction check → Day 14: Review request → Day 21-30: Cross-sell → Day 25-30: Replenishment

Email Benchmarks (from EMB Appendix):
- Welcome emails: 50-60% open, 5-8% CTR
- Abandoned cart: 40-50% open, 5-10% CTR
- Promotional: 15-20% open, 2-3% CTR
- Win-back: 10-15% open, 1-2% CTR
- Cold email: target 3-5% positive reply rate

=== PRICING RULES ===
- Under 80 pieces: provide ballpark estimate with 25% variance
- 80+ pieces: provide range + offer custom quote
- Products not on price list: offer to get agent quote
- Never present estimates as binding quotes
- Never offer discounts unless admin tweak says to

=== FRAMEWORK-SPECIFIC STRUCTURE (MANDATORY — follow the assigned framework exactly) ===

If framework = HORMOZI_ACA (first contact):
  Your message MUST follow this exact 3-part structure:
  1. ACKNOWLEDGE: Reference something SPECIFIC about the lead (their business name, their product request, their event, their team). NOT "thanks for reaching out" — that's generic.
  2. COMPLIMENT: A genuine, specific compliment related to what you acknowledged. "Love supporting local sports programs" or "Churches doing community events is awesome" — NOT "great to hear from you."
  3. ASK: ONE low-friction question that opens conversation. Ask about a detail they haven't provided yet (design, color, timeline specifics). NOT "how can I help you" — that's generic.
  Total: 2-3 sentences max. Warm, human, like a friend texting. NO product dumps. NO service listings. NO pricing. Just connection.
  Example: "Sweatshirts for South Panola's sports team — that's awesome! What sport are we outfitting, and do you have a logo ready or need help with design?"

If framework = HORMOZI_ACA (follow-up):
  1. ACKNOWLEDGE: "I know you mentioned [specific thing from last conversation]..."
  2. COMPLIMENT: "...which makes sense because [genuine observation about their situation]."
  3. ASK: "Have you had a chance to [specific next step], or should I [alternative]?"

If framework = HORMOZI_INDIRECT:
  NEVER say "buy our products" or "we offer..."
  Instead: "Do you know anyone who needs [specific thing they need] for [their specific context]?"
  Let them self-identify.

If framework = PAS:
  1. PROBLEM: State their specific pain point (from research/form data)
  2. AGITATE: Why it matters now (deadline, event, season)
  3. SOLUTION: How Adorb solves it specifically

If framework = BAB:
  1. BEFORE: Their current situation
  2. AFTER: What it looks like with custom gear
  3. BRIDGE: How Adorb gets them there

If framework = AIDA:
  1. ATTENTION: Hook with something relevant to them
  2. INTEREST: Specific benefit for their situation
  3. DESIRE: Social proof or case study
  4. ACTION: One clear CTA

If framework = SOAP_OPERA:
  Open a narrative loop. Tell a mini-story about a similar customer. End with curiosity gap.

If framework = EMB_WELCOME / EMB_WINBACK / EMB_POST_PURCHASE / EMB_COLD:
  Follow the Email Marketing Bible sequence rules from the strategy section above.

=== FIRST CONTACT RULES (when approach = first_contact) ===
- This is the MOST IMPORTANT message. It sets the tone for the entire relationship.
- MUST be introductory — you are meeting this person for the first time.
- MUST acknowledge what they told us (form data, their message, their request).
- MUST be SHORT: 2-3 sentences for SMS, 3-4 for email. No walls of text.
- MUST sound like a real person, not a chatbot or auto-responder.
- MUST NOT list all services. MUST NOT dump pricing. MUST NOT ask "how can I help."
- If form data says what they want (e.g., "50 shirts, sports team, this month"), ACKNOWLEDGE IT IMMEDIATELY. Don't ask discovery questions about things they already told you.
- Include ONE Adorb social proof point naturally (4.9 stars OR 1.1M customers — not both).

=== ANTI-REPETITION RULES ===
- Check the conversation history. Your message MUST NOT start with the same words as any prior outbound.
- If prior messages started with "Hey [name]!", you MUST use a different opener.
- Vary your structure: if prior messages were question-heavy, make this one statement-heavy.
- Never repeat a question that was already asked in a prior message.

You write the message. The QC brain will review it before it goes out.`;

async function runComposer(
  input: BrainCouncilInput,
  context: Awaited<ReturnType<typeof buildLeadContext>>,
  strategy: StrategyDecision,
  research: ResearchResult
): Promise<ComposedMessage> {
  const { lead, historyStr, kbContent, tweakInstructions } = context;

  const composerInput = `
=== STRATEGY DIRECTIVE ===
- Approach: ${strategy.approach}
- Framework: ${strategy.framework}
- Angle: ${strategy.angle}
- Channel: ${strategy.channel}
- Personalization Tier: ${strategy.personalizationTier}
- Tone: ${strategy.toneDirective}
- Max Length: ${strategy.maxLength} characters
- MUST Include: ${strategy.keyPoints.join(", ")}
- MUST NOT Say: ${strategy.avoidPoints.join(", ")}

=== RESEARCH BRIEF ===
- Company: ${research.companyInfo}
- Recent Activity: ${research.recentActivity}
- Pain Points: ${research.likelyPainPoints.join(", ")}
- Connection Points: ${research.connectionPoints.join(", ")}
- Seasonal Hook: ${research.seasonalRelevance}
- Summary: ${research.summary}

=== LEAD CONTEXT ===
- Name: ${lead.name || "Unknown"}
- Business: ${lead.businessName || "Unknown"}
- Assigned Agent: ${lead.assignedAgent || "Adorb Custom Tees"}
- Pipeline Stage: ${lead.pipelineStage}

=== CONVERSATION HISTORY ===
${input.externalHistory ? input.externalHistory + "\n" + historyStr : historyStr || "No previous messages"}

=== FORM DATA ===
${input.formData?.map(f => `- ${f.label}: ${f.value}`).join("\n") || "None"}

=== KNOWLEDGE BASE ===
${kbContent || "No knowledge base uploaded"}

${tweakInstructions ? `=== ADMIN BEHAVIOR ADJUSTMENTS ===\n${tweakInstructions}` : ""}

=== INCOMING MESSAGE ===
${input.incomingMessage}

Write the message now. Follow the strategy directive precisely.`;

  const response = await invokeLLM({
    messages: [
      { role: "system", content: COMPOSER_PROMPT },
      { role: "user", content: composerInput },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "composed_message",
        strict: true,
        schema: {
          type: "object",
          properties: {
            message: { type: "string", description: "The actual message to send" },
            fromName: { type: "string", description: "The sender name to display" },
            subject: { type: "string", description: "Email subject line (empty string if not email)" },
            internalNotes: { type: "string", description: "Notes for the team about this message" },
          },
          required: ["message", "fromName", "subject", "internalNotes"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error("Composer brain produced no output");
  return JSON.parse(content as string);
}

// ============================================================
// BRAIN 4: QC REVIEWER
// ============================================================

const QC_PROMPT = `You are the QC REVIEWER brain for Adorb Custom Tees' AI outreach system.

You are the LAST LINE OF DEFENSE before a message goes to a real customer. Your job is to catch problems the other brains missed.

=== QUALITY CHECKLIST (score each 0-10, total = quality score) ===

1. REPETITION CHECK (0-10):
   - Does the message start the same way as any prior outbound?
   - Does it repeat questions already asked?
   - Does it repeat information already shared?
   - Score 0 if it starts with the exact same greeting as a prior message.

2. ACKNOWLEDGMENT CHECK (0-10):
   - If the lead said something, does the message acknowledge it?
   - If form data exists, does the message reference what they told us?
   - Score 0 if lead asked a question that goes unanswered.

3. TONE CHECK (0-10):
   - No apologetic language ("sorry to bother", "no worries if not")
   - No easy outs ("if not relevant, no problem")
   - No corporate speak ("I'd love to pick your brain", "hope this finds you well")
   - No desperation ("just checking in", "touching base")
   - Sounds like a real person texting, not a bot.

4. LENGTH CHECK (0-10):
   - SMS: 1-3 sentences. Score 0 if more than 4 sentences.
   - Email: 3-5 sentences. Score 0 if more than 7 sentences.
   - No walls of text. No bullet point dumps.

5. CTA CHECK (0-10):
   - Exactly ONE clear call to action.
   - Score 0 if no CTA or multiple CTAs.

6. ACCURACY CHECK (0-10):
   - No made-up facts about the lead
   - No wrong names or business names
   - Pricing in line with knowledge base (if mentioned)

7. STRATEGY COMPLIANCE (0-10):
   - Does the message follow the strategy directive?
   - Does it use the assigned framework STRUCTURE (not just mention it)?
   - If framework = HORMOZI_ACA + first_contact: Does the message have all 3 parts? (1) Acknowledge something SPECIFIC about the lead, (2) Genuine compliment, (3) One low-friction question. Score 0 if it's a generic "how can I help" or "what can we do for you" response.
   - If form data exists: Does the message reference what the lead already told us? Score 0 if it asks questions the form already answered.
   - Does it stay within the max length?

8. BRAND VOICE (0-10):
   - Sounds like Adorb — warm, direct, confident
   - Uses the right from name
   - Appropriate for the channel

9. FORWARD MOMENTUM (0-10):
   - Does the message move the conversation forward?
   - Does it give the lead a reason to respond?

10. SAFETY CHECK (0-10):
    - No promises we can't keep
    - No binding pricing commitments
    - No inappropriate content
    - No sensitive information leaked

11. EMAIL-SPECIFIC CHECK (0-10, only for email channel):
    (Source: Email Marketing Bible V1.0, 908 sources)
    - Subject line under 25 chars? Personalised? First-person CTA?
    - Body length 50-125 words for cold email, 3-5 sentences for follow-up?
    - Single CTA placed early? Interest-based CTA, not meeting request?
    - No "Hope this finds you well", "Just following up", "Touching base"?
    - Each follow-up adds NEW value vs prior emails?
    - Personal sender name used (not brand name)?
    - Complaint-safe: nothing that could trigger spam complaints?
    - For win-back: follows EMB sequence (miss you → value → breakup)?

=== VERDICT ===
- Score >= 70: APPROVED — send as-is
- Score 50-69: APPROVED WITH EDITS — fix the issues and send your revised version
- Score < 50: REJECTED — do not send, explain why

If you approve with edits, provide the revised message in revisedMessage.`;

async function runQC(
  input: BrainCouncilInput,
  context: Awaited<ReturnType<typeof buildLeadContext>>,
  strategy: StrategyDecision,
  composed: ComposedMessage
): Promise<QCVerdict> {
  const { historyStr } = context;

  const qcInput = `
=== MESSAGE TO REVIEW ===
Channel: ${strategy.channel}
From: ${composed.fromName}
${composed.subject ? `Subject: ${composed.subject}` : ""}
Message: ${composed.message}

=== STRATEGY DIRECTIVE ===
- Approach: ${strategy.approach}
- Framework: ${strategy.framework}
- Angle: ${strategy.angle}
- Max Length: ${strategy.maxLength} chars
- Must Include: ${strategy.keyPoints.join(", ")}
- Must Avoid: ${strategy.avoidPoints.join(", ")}

=== PRIOR CONVERSATION ===
${input.externalHistory ? input.externalHistory + "\n" + historyStr : historyStr || "No previous messages"}

=== FORM DATA ===
${input.formData?.map(f => `- ${f.label}: ${f.value}`).join("\n") || "None"}

=== INCOMING MESSAGE BEING RESPONDED TO ===
${input.incomingMessage}

=== FIRST CONTACT SPECIAL RULES ===
If the strategy says approach = first_contact:
- The message MUST be introductory and warm, like meeting someone for the first time.
- It MUST NOT sound like a customer service auto-reply.
- It MUST reference something specific about the lead (not just their name).
- If form data provided product/quantity/timeline, the message MUST acknowledge it.
- Score 0 on Strategy Compliance if the message is generic ("What can we help you with?", "How can I assist you?").
- Score 0 on Acknowledgment if form data exists but isn't referenced.

Review this message now. Be strict but fair.`;

  const response = await invokeLLM({
    messages: [
      { role: "system", content: QC_PROMPT },
      { role: "user", content: qcInput },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "qc_verdict",
        strict: true,
        schema: {
          type: "object",
          properties: {
            approved: { type: "boolean" },
            score: { type: "number", description: "Quality score 0-100" },
            issues: { type: "array", items: { type: "string" }, description: "Issues found" },
            suggestions: { type: "array", items: { type: "string" }, description: "Improvement suggestions" },
            revisedMessage: { type: "string", description: "Revised message if approved with edits, empty string if approved as-is or rejected" },
          },
          required: ["approved", "score", "issues", "suggestions", "revisedMessage"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) return { approved: true, score: 70, issues: [], suggestions: [], revisedMessage: "" };
  return JSON.parse(content as string);
}

// ============================================================
// MAIN ORCHESTRATOR — runs all 4 brains in sequence
// ============================================================

export async function runBrainCouncil(input: BrainCouncilInput): Promise<BrainCouncilOutput> {
  console.log(`[BrainCouncil] Starting for lead ${input.leadId} on ${input.channel}`);

  // Build shared context once
  const context = await buildLeadContext(input.leadId);
  console.log(`[BrainCouncil] Context built: ${context.convHistory.length} messages, age ${context.leadAgeDays}d, ${context.urgencyStage}`);

  // BRAIN 1: STRATEGIST
  console.log(`[BrainCouncil] Running Strategist...`);
  const strategy = await runStrategist(input, context);
  console.log(`[BrainCouncil] Strategy: ${strategy.approach}/${strategy.framework}/${strategy.angle} (tier ${strategy.personalizationTier})`);

  // BRAIN 2: RESEARCHER
  console.log(`[BrainCouncil] Running Researcher...`);
  const research = await runResearcher(input, context, strategy);
  console.log(`[BrainCouncil] Research: ${research.summary.substring(0, 100)}...`);

  // BRAIN 3: COMPOSER
  console.log(`[BrainCouncil] Running Composer...`);
  let composed = await runComposer(input, context, strategy, research);
  console.log(`[BrainCouncil] Composed: "${composed.message.substring(0, 80)}..." (${composed.message.length} chars)`);

  // BRAIN 4: QC REVIEWER
  console.log(`[BrainCouncil] Running QC Reviewer...`);
  const qc = await runQC(input, context, strategy, composed);
  console.log(`[BrainCouncil] QC: score=${qc.score}, approved=${qc.approved}, issues=${qc.issues.length}`);

  // If QC rejected, try ONE recompose with QC feedback
  if (!qc.approved && qc.score < 50) {
    console.log(`[BrainCouncil] QC REJECTED (score ${qc.score}). Recomposing with feedback...`);
    const recomposeInput = { ...input };
    recomposeInput.incomingMessage = `${input.incomingMessage}\n\n[QC FEEDBACK — YOUR PREVIOUS MESSAGE WAS REJECTED]\nIssues: ${qc.issues.join("; ")}\nSuggestions: ${qc.suggestions.join("; ")}\nFix these issues in your rewrite.`;

    composed = await runComposer(recomposeInput, context, strategy, research);
    const qc2 = await runQC(recomposeInput, context, strategy, composed);
    console.log(`[BrainCouncil] Recompose QC: score=${qc2.score}, approved=${qc2.approved}`);

    // Use the best version
    if (qc2.revisedMessage) {
      composed.message = qc2.revisedMessage;
    }
  } else if (qc.revisedMessage) {
    // QC approved with edits — use the revised version
    composed.message = qc.revisedMessage;
    console.log(`[BrainCouncil] Using QC-revised message`);
  }

  // Score the lead using the sentiment-priority-scorer formula
  const urgencyScore = context.urgencyStage.includes("first") ? 1.0 :
    context.urgencyStage.includes("warm") ? 0.8 :
    context.urgencyStage.includes("cooling") ? 0.6 :
    context.urgencyStage.includes("cold") ? 0.4 :
    context.urgencyStage.includes("stale") ? 0.3 : 0.2;

  const intentScore = (context.lead.opportunityScore || 50) / 100;
  const recencyDays = context.leadAgeDays;
  const recencyScore = recencyDays <= 1 ? 1.0 : recencyDays <= 7 ? 0.7 : recencyDays <= 30 ? 0.4 : 0.1;
  const sentimentRisk = context.state?.sentimentTrend === "negative" ? 0.5 : 0;

  const priorityScore = Math.round(100 * (0.40 * urgencyScore + 0.30 * intentScore + 0.20 * recencyScore + 0.10 * sentimentRisk));

  // Determine segment
  const segment = context.lead.omnisendSegment || "other";

  // Extract dates from the composed message and incoming message
  const datePattern = /\b(\d{1,2}\/\d{1,2}\/\d{2,4}|\w+ \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?|(?:next|this) (?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/gi;
  const allText = input.incomingMessage + " " + composed.message;
  const extractedDates = Array.from(allText.matchAll(datePattern)).map(m => m[0]);

  // --- AUDIT LOG: Record the full Brain Council decision trail ---
  try {
    await addBrainCouncilAudit({
      leadId: input.leadId,
      leadName: context.lead.name || undefined,
      channel: input.channel,
      incomingMessage: input.incomingMessage?.substring(0, 2000),
      strategyApproach: strategy.approach,
      strategyFramework: strategy.framework,
      strategyReasoning: strategy.reasoning?.substring(0, 2000),
      strategyTier: String(strategy.personalizationTier),
      researchSummary: research.summary?.substring(0, 2000),
      composedMessage: composed.message,
      composerFromName: composed.fromName,
      qcScore: qc.score,
      qcApproved: qc.approved ? 1 : 0,
      qcIssues: qc.issues.length > 0 ? JSON.stringify(qc.issues) : undefined,
      qcFeedback: qc.suggestions.length > 0 ? JSON.stringify(qc.suggestions) : undefined,
      wasRecomposed: (!qc.approved && qc.score < 50) ? 1 : 0,
      finalMessage: composed.message,
      messageSent: 1, // will be updated by webhook handler if send fails
    });
  } catch (auditErr) {
    console.error('[BrainCouncil] Audit log error (non-fatal):', auditErr);
  }

  return {
    message: composed.message,
    fromName: composed.fromName,
    subject: composed.subject || undefined,
    framework: strategy.framework,
    angle: strategy.angle,
    extractedDates,
    score: priorityScore,
    segment,
    nextEngagementHours: strategy.nextEngagementHours,
    qcScore: qc.score,
    strategyReasoning: strategy.reasoning,
    researchSummary: research.summary,
  };
}
