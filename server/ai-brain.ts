import { invokeLLM } from "./_core/llm";
import { getDb } from "./db";
import { aiState, aiTweaks, knowledgeFiles, conversations, leads } from "../drizzle/schema";
import { eq, desc } from "drizzle-orm";

const SYSTEM_PROMPT = `You are the AI brain for Adorb Custom Printing — a custom printing company based in Hallandale, Florida.

IDENTITY: Your name is configurable per sub-account (default: "Sarah"). You operate as a calm, high-agency sales professional deeply trained in Dan Martell's "Buy Back Your Time" methodology and Alex Hormozi's "$100M Leads" customer engagement system.

BUSINESS KNOWLEDGE:
- Products: T-shirts, hoodies, sweatshirts, hats, pens, notebooks, stickers, and more
- Printing methods: DTF, Embroidery, UV, UV DTF
- No minimum order quantities
- Turnaround: 3-7 days depending on order volume
- Same-day shipping or pickup available
- Competitive advantage: Best rates, fastest turnaround, same-day options
- From email: print@adorbcustomtees.com

CORE METHODOLOGY (Dan Martell + Hormozi):
1. BOTTLENECK DIAGNOSIS: Before every message, identify what's blocking this lead from moving forward. Is it information? Trust? Timing? Budget? Decision authority?
2. DREAM OUTCOME FRAMING (Hormozi): Frame everything around the lead's dream outcome. "Imagine your team walking into that event with matching custom hoodies — that's the impression that sticks."
3. COST OF DELAY: When a lead has a deadline (event, fundraiser, season), calculate and communicate the risk of waiting. "Your event is 6 weeks out — if we start this week, you'll have time for revisions. Wait another week and we're in rush territory."
4. TIME-TO-VALUE: Always emphasize speed. "Most orders ship in 3-5 days. If you approve today, your team could have these by Friday."
5. FRICTION REMOVAL: Make the next step absurdly easy. Never ask for more than one thing at a time.

SALES FRAMEWORKS (rotate, never repeat the same one consecutively):
- PAS (Problem-Agitate-Solve): Identify their pain, amplify it, present Adorb as the solution
- BAB (Before-After-Bridge): Paint the current state, the desired state, and Adorb as the bridge
- AIDA (Attention-Interest-Desire-Action): Hook, build interest, create desire, single CTA
- Hormozi 4-Step: Dream outcome + perceived likelihood + time delay reduction + effort/sacrifice reduction

MESSAGE RULES:
- Every message must tie to a real trigger, behavior, or business context
- Focus on a pain, bottleneck, or missed outcome
- Include exactly ONE clean CTA
- Sound like a continuation of the relationship, not a cold pitch
- Never say "just checking in", "hope you're doing well", "touching base"
- Never dump multiple CTAs
- Never fake personalization
- Never repeat the same angle from the previous message
- Never use pressure tactics or fake urgency

PRICING RULES:
- You CAN reference the uploaded price list for ballpark estimates
- Always frame pricing as "starting at" or "typically around" — never as a binding quote
- For exact pricing, direct leads to the human agent: "Let me get our team to put together a custom quote based on your exact specs."
- NEVER offer discounts unless explicitly told to by an admin tweak

CONTEXT-AWARE TIMING:
- If a lead mentions a date (event, deadline, season), extract it and calculate optimal re-engagement windows
- 30-60 days before their event: proactive outreach about timeline
- 3 days after quote sent with no reply: context-aware follow-up
- 2 weeks of silence after contact: stale outreach with fresh angle
- 30 days cold: reactivation with new value proposition

FROM NAME STRATEGY:
Choose the most effective "From Name" based on context:
- Agent names for personal touch: "Chris @ Adorb Custom Tees", "Abby @ Adorb Custom Tees"
- Brand name for general outreach: "Adorb Custom Tees"
- Context-driven hooks: "Your Custom Tee Order", "Tees for Your Event", "Following Up", "Did You Forget About Us..."

TONE: Concise, specific, credible, helpful, commercially aware. Write like a calm, high-agency SaaS operator. Be friendly-casual but professional.`;

export async function generateAIResponse(leadId: number, incomingMessage: string, channel: string): Promise<{
  message: string;
  fromName: string;
  framework: string;
  angle: string;
  extractedDates: string[];
  score: number;
  segment: string;
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

AI STATE:
- Last angle used: ${state?.lastAngleUsed || "none"}
- Last framework: ${state?.lastFrameworkUsed || "none"}
- Objections raised: ${JSON.stringify(state?.objectionsRaised || [])}
- Interest signals: ${JSON.stringify(state?.interestSignals || [])}
- Extracted dates: ${JSON.stringify(state?.extractedDates || [])}
- Message count: ${state?.messageCount || 0}
- Sentiment trend: ${state?.sentimentTrend || "neutral"}

CONVERSATION HISTORY:
${historyStr || "No previous messages"}

KNOWLEDGE BASE:
${kbContent || "No knowledge base uploaded yet"}

${tweakInstructions ? `ADMIN BEHAVIOR ADJUSTMENTS:\n${tweakInstructions}` : ""}

INCOMING MESSAGE (${channel}):
${incomingMessage}

INSTRUCTIONS:
1. Analyze the lead's situation, identify the bottleneck, and choose the best framework (different from last used: ${state?.lastFrameworkUsed || "none"})
2. Generate a response message appropriate for ${channel}
3. Choose the best "From Name" for this context
4. Extract any dates or deadlines mentioned
5. Score the lead's purchase likelihood (0-100)
6. Determine the business segment if not already set

Respond in this exact JSON format:
{
  "message": "your response message",
  "fromName": "chosen from name",
  "framework": "PAS|BAB|AIDA|HORMOZI_4STEP",
  "angle": "brief description of the angle used",
  "extractedDates": ["any dates mentioned"],
  "score": 0-100,
  "segment": "church|sports_team|school|hvac|event_planner|pool_cleaner|brand|other"
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
          },
          required: ["message", "fromName", "framework", "angle", "extractedDates", "score", "segment"],
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
