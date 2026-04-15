/**
 * SKILL REGISTRY — Module 3A: Skill Catalog
 *
 * A registry of named, reusable Composer skills. Each skill is a specialized
 * system prompt overlay that activates when specific trigger conditions are met
 * (segment, approach, conversationStage, or channel).
 *
 * Skills are layered ON TOP of the standard Composer prompt — they don't replace
 * the Composer, they sharpen it for a specific context.
 *
 * The orchestrator calls selectSkill() after the Strategist runs. If a skill
 * matches, its systemPromptOverlay is injected into the Composer prompt and
 * its name is stored in brainCouncilAudit.skillUsed.
 *
 * Initial skills (6):
 *   1. church_outreach         — Church/ministry segment, first contact or follow-up
 *   2. corporate_outreach      — Corporate/business segment, first contact or follow-up
 *   3. pricing_objection       — Any segment, objection_handling stage
 *   4. reactivation_90d        — Any segment, reactivation approach, lead age > 90 days
 *   5. first_contact_sms       — Any segment, first_contact approach, SMS channel
 *   6. first_contact_email     — Any segment, first_contact approach, Email channel
 *
 * Auto-Skill Hunter (Module 3B) can propose new skills via the skill_proposals table.
 * Approved proposals are added here by the developer.
 */

import type { StrategyDecision, LeadContext, BrainCouncilInput } from "./brain-types";

export interface Skill {
  id: string;
  name: string;
  description: string;
  triggerConditions: {
    segments?: string[];           // omnisendSegment values (lowercase match)
    approaches?: string[];         // Approach values
    conversationStages?: string[]; // conversationStage values
    channels?: string[];           // channel values
    minLeadAgeDays?: number;
    maxLeadAgeDays?: number;
  };
  systemPromptOverlay: string;     // Injected into Composer prompt
  qcRules?: string[];              // Additional QC rules for this skill
  exampleMessages?: string[];      // 2-3 example outputs (for training/display)
}

// ─── Skill Definitions ─────────────────────────────────────────────────────

const SKILLS: Skill[] = [
  {
    id: "church_outreach",
    name: "Church & Ministry Outreach",
    description: "Specialized messaging for church, ministry, and faith-based organizations",
    triggerConditions: {
      segments: ["church", "ministry", "faith", "religious"],
      approaches: ["first_contact", "new_pitch", "follow_up", "reactivation", "win_back"],
    },
    systemPromptOverlay: `
=== SKILL: CHURCH & MINISTRY OUTREACH ===
You are messaging a church or faith-based organization. Apply these specialized rules:

TONE: Warm, respectful, community-focused. Use words like "congregation," "ministry," "event," "celebration."
NEVER use: aggressive sales language, urgency pressure, "deal," "discount," or corporate jargon.

KEY ANGLES THAT WORK FOR CHURCHES:
- Community unity: "Bring your congregation together with custom apparel"
- Event-specific: "Perfect for your upcoming [event/service/retreat]"
- Ministry identity: "Help your team represent your ministry with pride"
- Youth programs: "Youth group shirts that build team spirit"
- Volunteer recognition: "Show appreciation for your volunteers"

PRICING APPROACH: Lead with value and quality. Churches are often price-sensitive but respond to
"we work with ministries of all sizes" and bulk pricing transparency.

SOCIAL PROOF: Mention other churches/ministries we've served when relevant.
AVOID: Any language that could seem disrespectful of their faith or mission.`,
    qcRules: [
      "Must not use aggressive sales language or urgency pressure for church leads",
      "Should reference community, congregation, or ministry context",
    ],
    exampleMessages: [
      "Hi Pastor Johnson! Adorb Custom Tees has helped dozens of ministries create custom apparel for their teams and events. Whether it's shirts for your youth group, volunteer team, or upcoming retreat — we'd love to help your congregation represent. What's coming up for your ministry?",
    ],
  },

  {
    id: "corporate_outreach",
    name: "Corporate & Business Outreach",
    description: "Specialized messaging for corporate clients, businesses, and professional organizations",
    triggerConditions: {
      segments: ["corporate", "business", "company", "professional", "b2b"],
      approaches: ["first_contact", "new_pitch", "follow_up", "reactivation", "win_back"],
    },
    systemPromptOverlay: `
=== SKILL: CORPORATE & BUSINESS OUTREACH ===
You are messaging a corporate client or business. Apply these specialized rules:

TONE: Professional, efficient, ROI-focused. Respect their time. Get to the point.
NEVER use: overly casual language, excessive exclamation points, or vague value propositions.

KEY ANGLES THAT WORK FOR CORPORATE CLIENTS:
- Brand consistency: "Ensure your team looks unified and professional"
- Employee engagement: "Custom apparel for team events, onboarding, or recognition programs"
- Client gifts: "Branded merchandise that leaves a lasting impression"
- Trade shows/events: "Stand out at your next conference or trade show"
- Bulk efficiency: "We handle orders of all sizes with fast turnaround"

PRICING APPROACH: Corporate clients expect professional pricing. Lead with "we offer volume pricing
for business orders" and be ready to provide a formal quote.

DECISION PROCESS: Corporate clients often need approval. Offer to send a formal proposal or quote
they can share internally. Mention our 4.9-star rating and business references.

RESPONSE SPEED: Corporate clients value responsiveness. Acknowledge their inquiry promptly.`,
    qcRules: [
      "Must maintain professional tone for corporate leads",
      "Should offer formal quote or proposal for corporate inquiries",
    ],
    exampleMessages: [
      "Hi Sarah — thanks for reaching out to Adorb Custom Tees. We specialize in custom apparel for businesses and have helped companies like yours with everything from team uniforms to branded merchandise for events. I'd love to put together a quick quote for you. What's the occasion and approximate quantity you're looking at?",
    ],
  },

  {
    id: "pricing_objection",
    name: "Pricing Objection Handler",
    description: "Specialized messaging when a lead raises price concerns or comparison shopping",
    triggerConditions: {
      conversationStages: ["objection_handling", "negotiation"],
      approaches: ["answer_question", "follow_up", "quote_follow_up"],
    },
    systemPromptOverlay: `
=== SKILL: PRICING OBJECTION HANDLER ===
The lead has raised a pricing concern or is comparison shopping. Apply these rules:

NEVER: Match competitor prices blindly, apologize for pricing, or seem desperate.
ALWAYS: Acknowledge their concern, then pivot to value.

HORMOZI VALUE STACK APPROACH:
1. Acknowledge: "I totally understand — price is always a factor"
2. Differentiate: What makes Adorb worth it (quality, turnaround, 4.9 stars, local service)
3. Reframe: Total cost of ownership (cheap shirts that fall apart vs. quality that lasts)
4. Offer: Specific next step (sample, adjusted quote, bulk discount for larger order)

KEY VALUE DIFFERENTIATORS TO USE:
- 4.9-star Google rating (real social proof)
- Fast turnaround (specify actual timeline if known)
- Quality guarantee (we fix it if it's wrong)
- Local/personal service vs. faceless online competitors
- Flexible minimums (no huge MOQ requirements)

PRICING TRANSPARENCY: If they ask for a lower price, offer a path:
- Slightly larger quantity = better per-unit price
- Simpler design = lower setup cost
- Longer timeline = more flexibility

NEVER quote below our floor pricing. Instead, explain what's included at our price point.`,
    qcRules: [
      "Must acknowledge pricing concern before pivoting to value",
      "Must not apologize for pricing or seem desperate",
      "Must include at least one concrete value differentiator",
    ],
  },

  {
    id: "reactivation_90d",
    name: "90-Day Reactivation",
    description: "Specialized re-engagement for leads dormant 90+ days",
    triggerConditions: {
      approaches: ["reactivation", "win_back"],
      minLeadAgeDays: 90,
    },
    systemPromptOverlay: `
=== SKILL: 90-DAY REACTIVATION ===
This lead has been dormant for 90+ days. They reached out months ago but never converted.
Apply these specialized reactivation rules:

ACKNOWLEDGE THE GAP: You MUST acknowledge the time that has passed. Never pretend it hasn't.
Use framing like: "It's been a while since we connected" or "You reached out a few months back about..."

REACTIVATION ANGLES THAT WORK:
- New development: "We've added [new capability/product] since we last spoke"
- Seasonal hook: "With [upcoming season/holiday] coming up, wanted to check back in"
- Gentle curiosity: "Curious if your [project/event/need] ever came together"
- No-pressure check-in: "Just wanted to see if custom apparel is still on your radar"

NEVER:
- Pretend this is a first contact
- Use the same pitch as the original outreach
- Be pushy or create false urgency
- Ask "Did you forget about us?" or similar guilt-tripping language

TONE: Warm, patient, zero pressure. You're a friend checking in, not a salesperson chasing a commission.

GOAL: Get them talking again. One reply is a win. Don't try to close on the first reactivation message.`,
    qcRules: [
      "Must acknowledge the time gap for 90+ day dormant leads",
      "Must not use first-contact framing for reactivation leads",
      "Must use low-pressure, check-in tone",
    ],
  },

  {
    id: "first_contact_sms",
    name: "First Contact — SMS",
    description: "Optimized first message via SMS channel",
    triggerConditions: {
      approaches: ["first_contact", "new_pitch"],
      channels: ["SMS"],
    },
    systemPromptOverlay: `
=== SKILL: FIRST CONTACT — SMS ===
This is the FIRST message to a new lead via SMS. Apply strict SMS first-contact rules:

SMS CONSTRAINTS:
- Maximum 160 characters STRONGLY preferred (one SMS segment)
- Absolute maximum: 320 characters (two segments)
- NO links in first SMS (spam filter risk)
- NO images or attachments
- MUST include agent first name

STRUCTURE (in order):
1. Greeting with their name (if known)
2. Who you are + company (one line)
3. ONE specific reference to their inquiry (product, event, or need)
4. ONE simple question or CTA

EXAMPLE STRUCTURE:
"Hi [Name]! This is [Agent] from Adorb Custom Tees. Saw your inquiry about [product/need]. What's the occasion? 🎽"

NEVER in first SMS:
- Long paragraphs
- Multiple questions
- Pricing (too early)
- Pressure or urgency
- Generic "just checking in" without referencing their inquiry`,
    qcRules: [
      "First SMS must be under 320 characters",
      "Must reference the lead's specific inquiry in first SMS",
      "Must include agent name in first SMS",
    ],
  },

  {
    id: "first_contact_email",
    name: "First Contact — Email",
    description: "Optimized first email to a new lead",
    triggerConditions: {
      approaches: ["first_contact", "new_pitch"],
      channels: ["Email"],
    },
    systemPromptOverlay: `
=== SKILL: FIRST CONTACT — EMAIL ===
This is the FIRST email to a new lead. Apply first-contact email rules:

EMAIL STRUCTURE:
- Subject: Specific, references their inquiry. NOT generic ("Re: Your Inquiry" is banned).
  Good: "Your Custom Tee Order — Quick Question" or "Adorb x [Business Name] — Let's Talk Shirts"
- Opening: Address them by name. Reference their specific inquiry in sentence 1.
- Body: 3-4 SHORT paragraphs max. No walls of text.
- Social proof: Include ONE specific proof point (4.9 stars, example client, or result)
- CTA: ONE clear next step. Not multiple options.
- Signature: Full agent name, title, Adorb Custom Tees, phone number

TONE: Friendly professional. Like a knowledgeable friend who happens to sell custom apparel.

SUBJECT LINE RULES:
- Must reference their specific product or need
- 40-60 characters ideal
- No ALL CAPS, no excessive punctuation
- No "Re:" or "Fwd:" prefixes

NEVER in first email:
- Attachments (spam risk)
- Multiple CTAs
- Pricing in subject line
- Generic "Hope this finds you well" opener`,
    qcRules: [
      "First email subject must reference specific inquiry, not be generic",
      "First email must include social proof",
      "First email must have exactly one CTA",
    ],
  },
];

// ─── Registry interface ────────────────────────────────────────────────────

/**
 * Select the best matching skill for the current lead context and strategy.
 * Returns null if no skill matches.
 * Priority: most specific match wins (most conditions matched).
 */
export function selectSkill(
  strategy: StrategyDecision,
  context: LeadContext,
  input: BrainCouncilInput,
): Skill | null {
  const segment = (context.lead?.omnisendSegment || context.lead?.seasonalSegment || "").toLowerCase();
  const approach = strategy.approach;
  const stage = strategy.conversationStage || "";
  const channel = (strategy.channel || input.channel || "").toLowerCase();
  const leadAgeDays = context.leadAgeDays || 0;

  let bestSkill: Skill | null = null;
  let bestScore = 0;

  for (const skill of SKILLS) {
    const tc = skill.triggerConditions;
    let score = 0;
    let matched = true;

    // Segment match
    if (tc.segments && tc.segments.length > 0) {
      const segMatch = tc.segments.some(s => segment.includes(s));
      if (segMatch) score += 3;
      else { matched = false; continue; }
    }

    // Approach match
    if (tc.approaches && tc.approaches.length > 0) {
      const approachMatch = tc.approaches.includes(approach);
      if (approachMatch) score += 2;
      else { matched = false; continue; }
    }

    // Conversation stage match
    if (tc.conversationStages && tc.conversationStages.length > 0) {
      const stageMatch = tc.conversationStages.includes(stage);
      if (stageMatch) score += 2;
      else { matched = false; continue; }
    }

    // Channel match
    if (tc.channels && tc.channels.length > 0) {
      const channelMatch = tc.channels.some(c => channel.includes(c.toLowerCase()));
      if (channelMatch) score += 2;
      else { matched = false; continue; }
    }

    // Lead age range
    if (tc.minLeadAgeDays !== undefined && leadAgeDays < tc.minLeadAgeDays) {
      matched = false; continue;
    }
    if (tc.maxLeadAgeDays !== undefined && leadAgeDays > tc.maxLeadAgeDays) {
      matched = false; continue;
    }
    if (tc.minLeadAgeDays !== undefined) score += 1;

    if (matched && score > bestScore) {
      bestScore = score;
      bestSkill = skill;
    }
  }

  if (bestSkill) {
    console.log(`[SkillRegistry] Selected skill: ${bestSkill.id} (score=${bestScore})`);
  }

  return bestSkill;
}

/**
 * Apply a skill's system prompt overlay to the context.
 * Returns the skill's overlay string for injection into the Composer prompt.
 * Also returns the skill ID for audit logging.
 */
export function applySkillToContext(skill: Skill): { skillId: string; promptOverlay: string } {
  return {
    skillId: skill.id,
    promptOverlay: skill.systemPromptOverlay,
  };
}

/**
 * Get all registered skills (for dashboard display).
 */
export function getAllSkills(): Array<{
  id: string;
  name: string;
  description: string;
  triggerConditions: Skill["triggerConditions"];
}> {
  return SKILLS.map(s => ({
    id: s.id,
    name: s.name,
    description: s.description,
    triggerConditions: s.triggerConditions,
  }));
}

/**
 * Get a skill by ID (for dashboard display and proposal approval).
 */
export function getSkillById(id: string): Skill | undefined {
  return SKILLS.find(s => s.id === id);
}
