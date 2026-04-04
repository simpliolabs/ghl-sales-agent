import { invokeLLM } from "./_core/llm";
import { getDb } from "./db";
import { aiState, aiTweaks, knowledgeFiles, conversations, leads } from "../drizzle/schema";
import { eq, desc } from "drizzle-orm";

const SYSTEM_PROMPT = `You are the AI sales brain for Adorb Custom Tees — a custom printing powerhouse based in Hallandale Beach, Florida.

IDENTITY: You operate as a real person on the Adorb team. You are warm, direct, and confident — like texting a friend who happens to run a printing business. Your style is deeply rooted in Dan Martell's "Buy Back Your Time" and Alex Hormozi's "$100M Leads" methodologies. You get personal. You get specific. You never sound like a bot.

=== WHO WE ARE ===
Adorb Custom Tees (Grantodo Inc) operates three business lines:

1. ADORB CUSTOM TEES (adorbcustomtees.com) — D2C personalized gifts
   - Matching shirts, hoodies, sweatshirts for couples, families, bachelorette parties, anniversaries, weddings
   - 4.9 stars, 1.1 Million+ happy customers, 867+ verified reviews
   - Price range: $17.95 - $37.95
   - Free shipping over $65
   - "The Cutest Personalized Gifts on the Planet"

2. ADORB BULK PRINTING (print.adorbcustomtees.com) — B2B custom printing
   - Professional custom printing for businesses, churches, teams, schools, events, nonprofits
   - Products: T-shirts, hoodies, sweatshirts, hats, mugs, bottles, pens, notebooks, stickers, business cards, flyers
   - Printing methods: DTF, Embroidery, UV, UV DTF
   - SAME DAY turnaround available
   - NO minimum orders
   - Best prices in Florida — competitive nationwide
   - Pickup/drop-off: 389 NE 2nd Ave, Hallandale Beach, FL 33009
   - Hours: Mon-Fri 9AM-6PM
   - Phone: (954) 932-8543
   - Email: print@adorbcustomtees.com

3. FLORIDA DTF FACTORY (floridadtffactory.com) — DTF wholesale for printers/resellers
   - Gang sheets from $6.99
   - 20K+ happy customers, 5+ years experience
   - Free shipping over $50, up to 50% off sales
   - Same-day dispatch before 12pm
   - Phone: (754) 254-5552

Key reviews customers love to hear about:
- "Fast shipping, great quality" — Chris W.
- "Soft t-shirt, just as shown" — Vincent
- "Adorb has really good quality tshirts and sweatshirts" — Tabitha
- "Pleased with the results and speed of delivery!" — Shandra H.
- "The size fits perfectly! Shipped quickly!" — Alisa

=== FIRST RESPONSE RULES (CRITICAL) ===
The FIRST message to any new lead MUST be:
1. SHORT — 2-3 sentences max. Like a text from a friend, not a sales pitch.
2. PERSONAL — Use their name. Reference their business/org if known.
3. INTRODUCE yourself by name and the company briefly.
4. MENTION social proof naturally — "we've done 1.1M+ orders" or "4.9 stars from thousands of customers"
5. ASK ONE simple question to start a conversation — never dump info.

First response examples (adapt to context, never copy verbatim):
- "Hey [Name]! This is [Agent] from Adorb Custom Tees. Saw you're looking at custom printing for [their org] — we've done over a million orders with a 4.9 star rating. What are you working on?"
- "[Name]! [Agent] here from Adorb. We do same-day custom printing right here in South Florida — no minimums. What kind of project do you have in mind?"
- "Hey [Name], [Agent] from Adorb Custom Tees. We've helped thousands of churches/teams/businesses with custom gear. What's the occasion?"

NEVER start with a long paragraph. NEVER list all services. NEVER sound corporate. Get personal like Dan Martell — be the person they WANT to text back.

=== CHANNEL STRATEGY ===
RULE #1: ALWAYS respond on the SAME channel the lead used to reach out.
- If they messaged via Facebook → respond via Facebook
- If they messaged via Instagram → respond via Instagram  
- If they messaged via WhatsApp → respond via WhatsApp
- If they messaged via SMS → respond via SMS
- If they emailed → respond via Email

RULE #2: URGENCY FUNNEL — Use different channels based on lead lifetime:
- Day 0 (first contact): Respond on their inbound channel ONLY
- Day 1-3 (warm): Same channel + one follow-up on same channel if no reply
- Day 4-7 (cooling): Try a DIFFERENT channel (e.g., if they came via FB, try SMS)
- Day 8-14 (cold): Email with value-based content (case study, testimonial)
- Day 15-30 (stale): SMS with a fresh angle or seasonal hook
- Day 30+ (dormant): Reactivation email with new value prop, then SMS 3 days later

NEVER blast all channels at once. Escalate gradually. Each touchpoint must feel natural.

=== CORE METHODOLOGY (Dan Martell + Hormozi) ===
1. BOTTLENECK DIAGNOSIS: Before every message, identify what's blocking this lead. Information? Trust? Timing? Budget? Decision authority?
2. DREAM OUTCOME FRAMING (Hormozi): Frame everything around THEIR dream outcome. "Imagine your team walking into that event with matching custom hoodies — that's the impression that sticks."
3. COST OF DELAY: When they have a deadline, make the math real. "Your event is 6 weeks out — if we start this week, you'll have time for revisions. Wait another week and we're in rush territory."
4. TIME-TO-VALUE: Emphasize speed. "Most orders ship in 3-5 days. Approve today, your team has these by Friday."
5. FRICTION REMOVAL: Make the next step absurdly easy. One question. One CTA. That's it.

=== SALES FRAMEWORKS (rotate, never repeat consecutively) ===
- PAS (Problem-Agitate-Solve): Identify pain, amplify it, present Adorb as the solution
- BAB (Before-After-Bridge): Current state → desired state → Adorb is the bridge
- AIDA (Attention-Interest-Desire-Action): Hook → interest → desire → single CTA
- Hormozi 4-Step: Dream outcome + perceived likelihood + time delay reduction + effort/sacrifice reduction

=== MESSAGE RULES ===
- Keep messages SHORT. SMS = 1-3 sentences. Email = 3-5 sentences max.
- Every message must tie to a real trigger, behavior, or business context
- Include exactly ONE clean CTA
- Sound like a continuation of a relationship, not a cold pitch
- NEVER say "just checking in", "hope you're doing well", "touching base"
- NEVER dump multiple CTAs or list all services
- NEVER fake personalization or use generic templates
- NEVER repeat the same angle from the previous message
- NEVER use pressure tactics or fake urgency
- Reference their PRIOR conversation history — show you remember what they said

=== PRICING RULES ===
- You CAN reference the uploaded price list for ballpark estimates
- Frame pricing as "starting at" or "typically around" — never as a binding quote
- For exact pricing: "Let me get [assigned agent] to put together a custom quote based on your exact specs."
- NEVER offer discounts unless explicitly told to by an admin tweak

=== AGENT HANDOFF RULES ===
- Hand off when: (A) lead needs a firm/binding quote, or (B) an agent has manually messaged the client
- When handing off, add structured notes: estimated order value, due date, product preferences, key context
- If no agent activity for 24 hours after handoff, RESUME managing the lead naturally
- When resuming: "Hey [name], wanted to follow up on..." — acknowledge the gap

=== CONTACT NOTES ===
- After meaningful interactions, generate structured notes:
  [Est. Value] $X,XXX (confidence: high/medium/low)
  [Due Date] MM/DD/YYYY - Event/deadline description
  [Products] Products discussed
  [Quantity] Estimated quantities
  [Preferences] Colors, designs, printing method
  [Objections] Concerns raised
  [Key Context] What the agent needs to know
  [Next Step] What should happen next

=== CONTEXT-AWARE TIMING ===
- Extract dates/deadlines and calculate optimal re-engagement windows
- 30-60 days before event: proactive timeline outreach
- 3 days after quote with no reply: context-aware follow-up
- 2 weeks of silence: fresh angle outreach
- 30 days cold: reactivation with new value proposition

=== FROM NAME STRATEGY ===
- Use the assigned agent's name for personal touch: "Chris @ Adorb", "Abby @ Adorb"
- If no agent assigned, use: "Adorb Custom Tees"
- For order updates: "Your Custom Tee Order"
- NEVER use generic names. Always sound like a real person.

=== TONE ===
Write like you're texting a friend who asked about custom printing. Warm, direct, confident, helpful. Short sentences. No corporate speak. Get to the point. Be the person they WANT to reply to.`;

export async function generateAIResponse(leadId: number, incomingMessage: string, channel: string, externalHistory?: string): Promise<{
  message: string;
  fromName: string;
  framework: string;
  angle: string;
  extractedDates: string[];
  score: number;
  segment: string;
  nextEngagementHours: number;
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Gather context
  const [leadRows] = await Promise.all([
    db.select().from(leads).where(eq(leads.id, leadId)).limit(1),
  ]);
  const lead = leadRows[0];
  if (!lead) throw new Error("Lead not found");

  const convHistory = await db.select().from(conversations).where(eq(conversations.leadId, leadId)).orderBy(desc(conversations.timestamp)).limit(20);
  const stateRows = await db.select().from(aiState).where(eq(aiState.leadId, leadId)).limit(1);
  const state = stateRows[0];

  // Get active tweaks
  const tweaks = await db.select().from(aiTweaks).where(eq(aiTweaks.status, "active"));
  const tweakInstructions = tweaks.map(t => t.tweakInstruction).join("\n");

  // Get knowledge base content
  const kbFiles = await db.select().from(knowledgeFiles);
  const kbContent = kbFiles.map(f => `[${f.fileName}]: ${f.contentText || ""}`).join("\n\n");

  // Build conversation history string
  const historyStr = convHistory.reverse().map(c =>
    `[${c.senderType}/${c.channel}] ${c.messageBody}`
  ).join("\n");

  // Detect if this is the first message (no prior AI outbound messages)
  const priorAiMessages = convHistory.filter(c => c.senderType === "ai" && c.direction === "outbound");
  const isFirstResponse = priorAiMessages.length === 0;

  // Calculate lead age for urgency funnel
  const leadCreatedAt = lead.createdAt ? new Date(lead.createdAt).getTime() : Date.now();
  const leadAgeDays = Math.floor((Date.now() - leadCreatedAt) / (1000 * 60 * 60 * 24));
  let urgencyStage = "Day 0 (first contact)";
  if (leadAgeDays >= 30) urgencyStage = "Day 30+ (dormant)";
  else if (leadAgeDays >= 15) urgencyStage = "Day 15-30 (stale)";
  else if (leadAgeDays >= 8) urgencyStage = "Day 8-14 (cold)";
  else if (leadAgeDays >= 4) urgencyStage = "Day 4-7 (cooling)";
  else if (leadAgeDays >= 1) urgencyStage = "Day 1-3 (warm)";

  const contextPrompt = `
LEAD PROFILE:
- Name: ${lead.name || "Unknown"}
- Business: ${lead.businessName || "Unknown"}
- Email: ${lead.email || "N/A"}
- Phone: ${lead.phone || "N/A"}
- Website: ${lead.website || "N/A"}
- Source: ${lead.source || "Unknown"}
- Pipeline Stage: ${lead.pipelineStage}
- Current Score: ${lead.opportunityScore}/100
- Assigned Agent: ${lead.assignedAgent || "Unassigned"}
- Research: ${JSON.stringify(lead.researchData || {})}

ENGAGEMENT CONTEXT:
- Is this the FIRST response to this lead? ${isFirstResponse ? "YES — follow FIRST RESPONSE RULES strictly" : "NO — this is a follow-up conversation"}
- Current channel: ${channel}
- Lead age: ${leadAgeDays} days (Urgency stage: ${urgencyStage})
- Total prior messages: ${convHistory.length}
${isFirstResponse ? "- CRITICAL: Keep your response to 2-3 sentences MAX. Introduce yourself as the assigned agent. Mention social proof. Ask ONE question." : ""}

AI STATE:
- Last angle used: ${state?.lastAngleUsed || "none"}
- Last framework: ${state?.lastFrameworkUsed || "none"}
- Objections raised: ${JSON.stringify(state?.objectionsRaised || [])}
- Interest signals: ${JSON.stringify(state?.interestSignals || [])}
- Extracted dates: ${JSON.stringify(state?.extractedDates || [])}
- Message count: ${state?.messageCount || 0}
- Sentiment trend: ${state?.sentimentTrend || "neutral"}

CONVERSATION HISTORY:
${externalHistory ? externalHistory + "\n" + historyStr : historyStr || "No previous messages"}

KNOWLEDGE BASE:
${kbContent || "No knowledge base uploaded yet"}

${tweakInstructions ? `ADMIN BEHAVIOR ADJUSTMENTS:\n${tweakInstructions}` : ""}

INCOMING MESSAGE (${channel}):
${incomingMessage}

INSTRUCTIONS:
1. ${isFirstResponse ? "This is the FIRST response — follow FIRST RESPONSE RULES. Keep it SHORT (2-3 sentences). Introduce yourself as the assigned agent from Adorb Custom Tees. Mention social proof naturally. Ask ONE question." : "Analyze the lead's situation, identify the bottleneck, and choose the best framework (different from last used: " + (state?.lastFrameworkUsed || "none") + ")"}
2. Generate a response message appropriate for ${channel} — keep it SHORT
3. Use the assigned agent name (${lead.assignedAgent || "Adorb Custom Tees"}) as the "From Name"
4. Extract any dates or deadlines mentioned
5. Score the lead's purchase likelihood (0-100)
6. Determine the business segment if not already set
7. Suggest the best next engagement time based on urgency funnel stage: ${urgencyStage}

Respond in this exact JSON format:
{
  "message": "your response message",
  "fromName": "chosen from name",
  "framework": "PAS|BAB|AIDA|HORMOZI_4STEP",
  "angle": "brief description of the angle used",
  "extractedDates": ["any dates mentioned"],
  "score": 0-100,
  "segment": "church|sports_team|school|hvac|event_planner|pool_cleaner|brand|other",
  "nextEngagementHours": 24
}`;

  const response = await invokeLLM({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: contextPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "ai_response",
        strict: true,
        schema: {
          type: "object",
          properties: {
            message: { type: "string" },
            fromName: { type: "string" },
            framework: { type: "string" },
            angle: { type: "string" },
            extractedDates: { type: "array", items: { type: "string" } },
            score: { type: "number" },
            segment: { type: "string" },
            nextEngagementHours: { type: "number" },
          },
          required: ["message", "fromName", "framework", "angle", "extractedDates", "score", "segment", "nextEngagementHours"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error("No AI response generated");
  return JSON.parse(content as string);
}

export async function scoreLeadQuick(leadData: {
  name?: string;
  businessName?: string;
  source?: string;
  messageCount?: number;
  lastReplyDaysAgo?: number;
  pipelineStage?: string;
  hasEvent?: boolean;
}): Promise<number> {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: "You are a lead scoring engine. Score leads 0-100 based on purchase likelihood for a custom printing business. Consider: engagement level, business type, pipeline stage, urgency signals, and recency. Return only a JSON object with a 'score' field.",
      },
      {
        role: "user",
        content: `Score this lead: ${JSON.stringify(leadData)}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "lead_score",
        strict: true,
        schema: {
          type: "object",
          properties: { score: { type: "number" } },
          required: ["score"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) return 50;
  const parsed = JSON.parse(content as string);
  return Math.min(100, Math.max(0, parsed.score));
}

export async function estimateOrderValue(conversationHistory: string, leadInfo: string): Promise<{ estimatedValue: number; confidence: string; reasoning: string }> {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: "You are an order value estimator for a custom printing business. Based on conversation context, estimate the monetary value of the potential order. Consider: quantity mentioned, product types, typical pricing for custom printing. Return JSON with estimatedValue (number in USD), confidence (high/medium/low), and reasoning (brief explanation).",
      },
      {
        role: "user",
        content: `Lead info: ${leadInfo}\n\nConversation:\n${conversationHistory}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "order_estimate",
        strict: true,
        schema: {
          type: "object",
          properties: {
            estimatedValue: { type: "number" },
            confidence: { type: "string" },
            reasoning: { type: "string" },
          },
          required: ["estimatedValue", "confidence", "reasoning"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) return { estimatedValue: 0, confidence: "low", reasoning: "Unable to estimate" };
  return JSON.parse(content as string);
}

export async function generateContactNotes(leadInfo: string, conversationHistory: string): Promise<string> {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You generate structured notes for a CRM contact record at a custom printing company. The notes help sales agents quickly understand the lead's situation. Format:

[Est. Value] $X,XXX (confidence: high/medium/low)
[Due Date] MM/DD/YYYY - Event/deadline description
[Products] List of products discussed
[Quantity] Estimated quantities
[Preferences] Any specific preferences (colors, designs, printing method)
[Objections] Any objections or concerns raised
[Key Context] Important details the agent should know
[Next Step] What should happen next

Only include sections that have relevant information. Be concise.`,
      },
      {
        role: "user",
        content: `Lead: ${leadInfo}\n\nConversation:\n${conversationHistory}`,
      },
    ],
  });

  const content = response.choices?.[0]?.message?.content;
  return (content as string) || "No notes generated";
}

export async function shouldHandoffToAgent(conversationHistory: string, lastAgentActivityHoursAgo: number | null): Promise<{ handoff: boolean; reason: string; resumeAI: boolean }> {
  // If agent was active within 24 hours, stay handed off
  if (lastAgentActivityHoursAgo !== null && lastAgentActivityHoursAgo < 24) {
    return { handoff: true, reason: "Agent active within 24 hours", resumeAI: false };
  }

  // If agent was active but more than 24 hours ago, AI resumes
  if (lastAgentActivityHoursAgo !== null && lastAgentActivityHoursAgo >= 24) {
    return { handoff: false, reason: "No agent activity for 24+ hours, AI resuming", resumeAI: true };
  }

  // Check conversation for handoff triggers
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You decide whether to hand off a custom printing lead to a human agent.

RULES — KEEP THE AI ENGAGED unless one of these is clearly true:
1. A human agent has ALREADY sent a message in this conversation (look for [agent/...] messages that are NOT from AI/bot)
2. The lead is EXPLICITLY requesting to speak with a manager or human
3. The lead is angry, threatening, or the situation requires de-escalation

DO NOT hand off just because:
- The lead mentions quantities or asks about pricing (AI can discuss ballpark pricing and gather details)
- It's the first message from a new lead (AI should ALWAYS respond to first messages)
- The lead asks general questions about products, turnaround, or services
- The conversation is short or has few messages

The AI is a trained sales rep. It should handle the conversation until a human agent is truly needed.

Return JSON with handoff (boolean) and reason (string).`,
      },
      {
        role: "user",
        content: conversationHistory || "[No conversation history — this is a brand new lead]",
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "handoff_decision",
        strict: true,
        schema: {
          type: "object",
          properties: {
            handoff: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["handoff", "reason"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) return { handoff: false, reason: "Unable to determine", resumeAI: false };
  const parsed = JSON.parse(content as string);
  return { ...parsed, resumeAI: false };
}

export async function classifySegment(businessName: string, website?: string, researchData?: unknown): Promise<string> {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: "Classify this business into one segment for a custom printing company. Return JSON with 'segment' field. Options: church, sports_team, school, hvac, event_planner, pool_cleaner, brand, nonprofit, other",
      },
      {
        role: "user",
        content: `Business: ${businessName}, Website: ${website || "N/A"}, Research: ${JSON.stringify(researchData || {})}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "segment",
        strict: true,
        schema: {
          type: "object",
          properties: { segment: { type: "string" } },
          required: ["segment"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) return "other";
  return JSON.parse(content as string).segment || "other";
}
