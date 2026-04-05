/**
 * BRAIN 1: STRATEGIST — Decides approach, channel, timing, angle, personalization tier
 */

import { invokeLLM } from "./_core/llm";
import type { BrainCouncilInput, StrategyDecision, LeadContext } from "./brain-types";
import { buildLearningContext } from "./outcome-engine";

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

=== DORMANCY & RE-ACTIVATION RULES ===

When the incoming message contains a DORMANCY ALERT, you MUST follow these rules:

1. CHANNEL: For dormant leads (30+ days inactive), ALWAYS recommend Email as the channel.
   - SMS after months of silence feels invasive and unprofessional.
   - Email allows richer content, portfolio links, and feels less intrusive.
   - Only escalate to SMS after the re-activation email gets no response (7+ days).

2. APPROACH: Set approach to "reactivation" — NEVER "follow_up".
   - Do NOT continue the old conversation thread.
   - Do NOT reference specific past quotes, invoices, or orders unless you're certain they're still relevant.
   - DO reference their business by name and what you could do for them NOW.

3. FRAMEWORK: Use Win-Back sequence from the Email Marketing Bible:
   - 30-90 days dormant: "We miss you" + fresh value proposition
   - 90-180 days dormant: Value offer + new portfolio/case study
   - 180+ days dormant: Treat as near-cold — Hormozi ACA method, reference their business, offer fresh value

4. TONE: Warm, confident, zero desperation. Never say "just checking in" or "still interested?"
   - Good: "Hey [name], I was looking at [their business] and had an idea for [specific value]..."
   - Bad: "Hey! Do you still need a quote?"

5. EMAIL CONTENT for re-activation:
   - Subject line: Curiosity-driven, NOT generic ("I had an idea for [Business Name]" not "Following up")
   - Body: 50-125 words max. Lead with value/insight about THEIR business. End with soft CTA.
   - Include: portfolio link or recent case study if available
   - Personal sender name (agent name), not brand name

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

${await getLearningBlock(lead.omnisendSegment)}

Produce your strategic directive now. PRIORITIZE frameworks and channels with proven higher reply rates from the learning data above (if available).`;

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
