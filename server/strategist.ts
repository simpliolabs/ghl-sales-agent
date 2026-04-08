/**
 * BRAIN 1: STRATEGIST — Decides approach, channel, timing, angle, personalization tier
 *
 * KEY CHANGE: Awareness-level detection. Before choosing a framework, the Strategist
 * MUST classify the lead's current awareness level from the conversation:
 *
 *   ASKING    — Lead asked a question → approach = answer_question
 *   QUOTING   — Lead requested pricing → approach = provide_quote
 *   INFORMING — Lead shared info (design, timeline) → approach = acknowledge_info
 *   CLARIFYING — Need to confirm details → approach = confirm_details
 *   OUTREACH  — No inbound signal → pick outreach/follow-up/reactivation approach
 *
 * The Strategist must NEVER pick an outreach approach when the lead is in ASKING/QUOTING/INFORMING state.
 */

import { invokeLLM } from "./_core/llm";
import type { BrainCouncilInput, StrategyDecision, LeadContext } from "./brain-types";
import { buildLearningContext } from "./outcome-engine";

const STRATEGIST_PROMPT = `You are the STRATEGIST brain for Adorb Custom Tees' AI outreach system.

Your job is to DECIDE the approach — you do NOT write the message. You analyze the lead's situation and produce a strategic directive that the Composer brain will follow.

=== STEP 1: AWARENESS-LEVEL DETECTION (MANDATORY — do this FIRST) ===

Before choosing ANY framework or approach, classify the lead's current state by reading the INCOMING MESSAGE and CONVERSATION HISTORY:

1. ASKING — The lead asked a question (pricing, availability, turnaround, process, etc.)
   → approach MUST be "answer_question"
   → keyPoints MUST include the specific question to answer
   → framework: DIRECT_RESPONSE (answer first, then soft CTA)
   → NEVER use HORMOZI_ACA or any outreach framework when the lead is asking a question

2. QUOTING — The lead requested a quote, pricing, or estimate
   → approach MUST be "provide_quote"
   → keyPoints MUST include: product type, quantity (if known), what to quote
   → framework: DIRECT_RESPONSE (provide ballpark/range, then next step)
   → Use the PRICING RULES section to determine what to quote
   → NEVER deflect with "let me check" — use the knowledge base to give a real answer

3. INFORMING — The lead shared new information (design files, timeline, event date, preferences)
   → approach MUST be "acknowledge_info"
   → keyPoints MUST include: what they shared, confirmation of receipt
   → framework: DIRECT_RESPONSE (confirm what you received, state next step)
   → NEVER ignore what they said and pivot to a pitch

4. CLARIFYING — You need to confirm specific details before proceeding (size, color, quantity, deadline)
   → approach MUST be "confirm_details"
   → keyPoints MUST include: exactly what needs clarification
   → framework: DIRECT_RESPONSE (ask the specific question, nothing else)

5. OUTREACH — No inbound signal requiring response. Lead is dormant, new, or needs follow-up.
   → THEN and ONLY THEN choose from outreach approaches below.

CRITICAL RULE: If the incoming message contains a question, request, or new information,
you MUST classify as ASKING/QUOTING/INFORMING/CLARIFYING. Choosing an outreach approach
when the lead is waiting for an answer is the #1 failure mode of this system.

=== STEP 2: CHOOSE APPROACH (based on awareness level) ===

RESPONSIVE approaches (awareness = ASKING/QUOTING/INFORMING/CLARIFYING):
- answer_question: Lead asked something → answer it directly
- provide_quote: Lead wants pricing → give ballpark or range from knowledge base
- acknowledge_info: Lead shared info → confirm receipt + next step
- confirm_details: Need specifics → ask ONE clear question

OUTREACH approaches (awareness = OUTREACH only):
- first_contact: Brand new lead, first message ever
- new_pitch: No meaningful prior interaction, needs intro
- follow_up: Continuing an open conversation thread
- quote_follow_up: Was quoted but never closed → nudge
- order_follow_up: Had an order → check satisfaction or offer reorder
- reactivation / win_back: Dormant 30+ days → fresh value proposition
- post_delivery: After order delivered → satisfaction check
- relationship_nurture: Good relationship, stay in touch
- seasonal: Seasonal/event-based outreach
- value_add: Proactive value (tip, case study, portfolio)
- recovery: After a failed/blocked message, gentle re-approach

=== STEP 3: CHOOSE FRAMEWORK ===

For RESPONSIVE approaches (answer_question, provide_quote, acknowledge_info, confirm_details):
- DIRECT_RESPONSE: Answer/acknowledge first, then ONE soft CTA. No sales framework needed.
- VALUE_FIRST: Lead with useful info (pricing, timeline, process explanation), then CTA.

For OUTREACH approaches:
- HORMOZI_ACA: Acknowledge + Compliment + Ask. Best for first contact and warm follow-up.
- HORMOZI_INDIRECT: "Do you know anyone who needs..." — let them self-identify.
- PAS: Problem → Agitate → Solution. Best for cold email, B2B.
- BAB: Before → After → Bridge. Best for case studies.
- AIDA: Attention → Interest → Desire → Action. Best for promotional.
- SOCIAL_PROOF: Lead with reviews/testimonials/case studies.
- CASE_STUDY: Tell a specific customer success story relevant to their situation.
- SOAP_OPERA: Multi-email narrative with curiosity gap.
- EMB_WELCOME / EMB_WINBACK / EMB_POST_PURCHASE / EMB_COLD: Email Marketing Bible sequences.

=== FRAMEWORK DIVERSITY RULE ===
Check "Last framework used" in the engagement state. If the same framework was used in the last 2 messages to this lead, you MUST pick a different one. Variety keeps conversations fresh.

Exception: DIRECT_RESPONSE and VALUE_FIRST can be repeated because they're responsive, not outreach.

=== PRICING RULES (for provide_quote approach) ===
- Under 80 pieces: provide ballpark estimate with ~25% variance ("roughly $X-$Y per piece")
- 80+ pieces: provide range + offer custom quote ("for 200 shirts, typically $X-$Y each — want me to get you an exact quote?")
- Products not on price list: offer to get agent quote ("I'll have our team put together a custom quote for you")
- NEVER present estimates as binding quotes
- NEVER offer discounts unless admin tweak says to
- ALWAYS reference the knowledge base pricing data when available

=== FRAMEWORKS IN DETAIL ===

HORMOZI ACA METHOD (from $100M Leads):
- A (Acknowledge): Reference something SPECIFIC about the lead
- C (Compliment): Sincere, subtle compliment related to the fact
- A (Ask): Question that transitions to what you're selling

ACA for Follow-ups:
- Acknowledge: "I know you mentioned you were busy when we last spoke..."
- Compliment: "...which makes sense because successful business owners like you always are."
- Ask: "Have you had a chance to think about [previous topic], or should I follow up next month?"

Hormozi Indirect Selling:
- NEVER say "buy my products"
- Instead: "Do you know anyone who is facing [problem] and looking to achieve [results]?"

Dan Martell Customer Engagement:
- Engagement deeply rooted in conversation, not pitching
- Reactivate 30-60 days before specific event dates mentioned by customer
- Value-first approach: lead with insight, not with ask

Personalization Tiers:
- Tier 1 (full custom): Research their Google reviews, reference specific details, ACA method
- Tier 2 (template + personal opener): Segment-specific template with name + business personalization
- Tier 3 (minimal custom): Name + source acknowledgment only

EMAIL MARKETING BIBLE — STRATEGY FRAMEWORKS (Source: EMB V1.0, 908 sources):

Email ROI: $36-42 per $1 spent (3,600%). SMS: $20-25. Social: $2-5. Email wins.

Win-Back (target 60-90 day inactive):
1. "We miss you" → 2. Value offer → 3. Breakup email (highest reply rate) → 4. Confirmation

Cold Email (from EMB Chapter 13):
- Optimal length: 50-125 words.
- Interest-based CTAs: 2-3x more replies than meeting requests.
- Follow-up: 4 emails over 2-3 weeks. Each MUST add new value.

=== DORMANCY & RE-ACTIVATION RULES ===

When the incoming message contains a DORMANCY ALERT:
1. CHANNEL: 30+ days inactive → Email (less invasive). Only escalate to SMS after 7+ days no response.
2. APPROACH: "reactivation" — do NOT continue old conversation thread.
3. FRAMEWORK: 30-90 days → EMB_WINBACK. 90-180 days → value offer + case study. 180+ → near-cold HORMOZI_ACA.
4. TONE: Warm, confident, zero desperation. Never "just checking in" or "still interested?"

=== PRIOR CONTACT RULE (CRITICAL) ===
If the CONVERSATION HISTORY section contains ANY outbound messages (marked [agent/...] or [ai/...]),
this lead has ALREADY been contacted. You MUST NOT use 'first_contact' or 'new_pitch' approach.
Choose 'follow_up', 'reactivation', 'win_back', or another continuation approach that acknowledges prior contact.
READ THE CONVERSATION HISTORY before choosing approach — the lead's last message and your last reply
are the most important context for deciding what to say next.

=== CHANNEL PRESERVATION RULE (CRITICAL) ===
When the lead sent an inbound message, you MUST reply on the SAME channel they used.
- If the lead messaged on FB → channel MUST be "FB"
- If the lead messaged on IG → channel MUST be "IG"
- If the lead messaged on WhatsApp → channel MUST be "WhatsApp"
- If the lead messaged on Email → channel MUST be "Email"
- If the lead messaged on SMS → channel MUST be "SMS"
NEVER switch channels when responding to an inbound message. The lead expects the reply in the same conversation thread.
Only choose a DIFFERENT channel for proactive outreach (awareness = OUTREACH) when the lead has no recent inbound.

=== WHAT KILLS OUTREACH (NEVER DO) ===
- "I'd love to pick your brain"
- "Can I get 15 minutes of your time?"
- Long paragraphs about yourself
- Immediate pitch in first message
- Same message to everyone
- Following up every 2 days
- "Hope this finds you well"
- "Just checking in" / "Touching base"
- Apologetic language ("sorry to bother")
- Easy outs ("if not relevant, no problem")

=== SENTIMENT PRIORITY SCORING ===
- priority = 100 * (0.40*urgency + 0.30*intent + 0.20*recency + 0.10*sentiment_risk)
- P1 (>=75): immediate action | P2 (50-74): scheduled follow-up | P3 (<50): nurture

=== YOUR OUTPUT ===
Analyze the lead context, detect awareness level, and produce a strategic directive. Be specific and actionable.`;

// Cache learning context for 10 minutes to avoid repeated DB queries
let _learningCache: { text: string; expires: number } | null = null;

async function getLearningBlock(segment?: string | null): Promise<string> {
  if (_learningCache && Date.now() < _learningCache.expires) return _learningCache.text;
  try {
    const text = await buildLearningContext(segment || undefined);
    _learningCache = { text, expires: Date.now() + 10 * 60 * 1000 };
    return text;
  } catch (err) {
    console.error('[Strategist] Failed to build learning context:', err);
    return 'LEARNING DATA: Unavailable (error fetching).';
  }
}

export async function runStrategist(input: BrainCouncilInput, context: LeadContext): Promise<StrategyDecision> {
  const { lead, state, historyStr, isFirstResponse, leadAgeDays, urgencyStage, unansweredCount, lookbackContext } = context;

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
- First response? ${isFirstResponse ? "YES — this is the very first message to this lead" : "NO — there are prior messages"}
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
${lookbackContext ? `
LOOKBACK ANALYSIS (pre-processed intelligence about this lead):
${lookbackContext}
IMPORTANT: Use this lookback analysis to inform your strategy. It contains key context about the lead's history, sentiment, and recommended approach from a prior deep analysis of their full conversation.` : ""}
${context.lastInteractionSummary ? `
LAST INTERACTION SUMMARY (cross-session memory):
${context.lastInteractionSummary}
IMPORTANT: This is a summary of the last AI interaction with this lead. Use it to maintain continuity — do NOT repeat what was already discussed or offered.` : ""}

FORM DATA (if any):
${input.formData?.map(f => `- ${f.label}: ${f.value}`).join("\n") || "None"}

CONVERSATION HISTORY:
${input.externalHistory ? input.externalHistory + "\n" + historyStr : historyStr || "No previous messages"}

${(input.externalHistory && (/\[agent\//i.test(input.externalHistory) || /\[ai\//i.test(input.externalHistory))) ? `⚠️ PRIOR CONTACT DETECTED: The GHL conversation history above contains outbound messages from our team.
This lead has ALREADY been contacted. You MUST NOT use 'first_contact' or 'new_pitch' approach.
Choose 'follow_up', 'reactivation', 'win_back', or another continuation approach.
READ THE CONVERSATION HISTORY CAREFULLY before choosing approach and tone.` : ""}

INCOMING MESSAGE:
${input.incomingMessage}

${await getLearningBlock(lead.omnisendSegment)}

STEP 1: Detect the awareness level from the incoming message and conversation history.
STEP 2: Choose the approach that matches the awareness level.
STEP 3: Choose the framework. Remember the FRAMEWORK DIVERSITY RULE — last framework was "${state?.lastFrameworkUsed || "none"}".
STEP 4: Produce your strategic directive. PRIORITIZE frameworks and channels with proven higher reply rates from the learning data above (if available).`;

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
            approach: {
              type: "string",
              description: "The approach to use. MUST match awareness level: answer_question|provide_quote|acknowledge_info|confirm_details for responsive; first_contact|new_pitch|follow_up|quote_follow_up|order_follow_up|reactivation|win_back|post_delivery|relationship_nurture|seasonal|value_add|recovery for outreach"
            },
            channel: { type: "string", description: "SMS|Email|FB|IG|WhatsApp" },
            angle: { type: "string", description: "The specific angle/hook to use" },
            framework: {
              type: "string",
              description: "DIRECT_RESPONSE|VALUE_FIRST|PAS|BAB|AIDA|HORMOZI_ACA|HORMOZI_INDIRECT|SOCIAL_PROOF|CASE_STUDY|SOAP_OPERA|EMB_WELCOME|EMB_WINBACK|EMB_POST_PURCHASE|EMB_COLD"
            },
            personalizationTier: { type: "number", description: "1=full custom, 2=template+personal opener, 3=minimal" },
            toneDirective: { type: "string", description: "Specific tone instructions for the composer" },
            maxLength: { type: "number", description: "Max characters for the message" },
            keyPoints: { type: "array", items: { type: "string" }, description: "What MUST be included. For answer_question: include the question. For provide_quote: include product/qty. For acknowledge_info: include what they shared." },
            avoidPoints: { type: "array", items: { type: "string" }, description: "What MUST NOT be said" },
            nextEngagementHours: { type: "number", description: "Hours until next follow-up" },
            reasoning: { type: "string", description: "Why this strategy was chosen. MUST start with 'Awareness: [ASKING|QUOTING|INFORMING|CLARIFYING|OUTREACH] because...' to prove you detected the awareness level." },
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
