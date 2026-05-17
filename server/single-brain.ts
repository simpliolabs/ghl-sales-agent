/**
 * SINGLE BRAIN v3.0 — Level 4-5 Prompt Architecture
 *
 * Upgrades from v2.0:
 *   - Structured reasoning scaffold (analyze → plan → compose → self-check)
 *   - Few-shot examples for 5 common scenarios
 *   - Dynamic context selection (only inject relevant persona/seasonal/competitive)
 *   - Explicit decision trees for high-stakes scenarios
 *   - Anti-pattern library with corrections
 *   - response_format: json_schema for reliable structured output
 *   - Token-efficient: ~2,200 tokens base prompt + ~800 dynamic context (vs ~4,000+ static dump)
 *
 * Architecture:
 *   1. Assemble context (lead data, conversation history, memory, stage behavior, pricing)
 *   2. Dynamic context selection — only inject relevant training sections
 *   3. Build system prompt with reasoning scaffold + few-shot examples
 *   4. LLM call with response_format: json_schema (eliminates parse failures)
 *   5. Tool loop if needed (getQuote, escalateToHuman, markDNC)
 *   6. Run output guards
 *   7. Return decision for outbox worker to send
 */

import { invokeLLM, type Message, type Tool, type ToolCall } from "./_core/llm";
import { getLeadById, getConversationHistory, getAiState } from "./db";
import { getLeadMemory } from "./lead-memory";
import { getQuote, type QuoteResult } from "./pricing-engine";
import { selectModel } from "./fine-tuning-pipeline";
import { runOutputGuards, type BrainDecision, type ToolCallRecord, type GuardResult } from "./output-guards";
import stageBehaviors from "../shared/stage-behavior.json";
import {
  BRAND_VOICE_GUIDE,
  PERSONA_PLAYBOOKS,
  ESCALATION_RULES,
  COMPETITIVE_INTEL,
  SEASONAL_CALENDAR,
  getPersonaGuidance,
} from "../shared/sales-training";

// Re-export for consumers
export type { BrainDecision, ToolCallRecord, GuardResult };

// ── Constants ───────────────────────────────────────────────────────────

const MAX_TOOL_ROUNDS = 3;
const CURRENT_PROMPT_VERSION = "v3.0";

// ── Tool definitions ────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "getQuote",
      description: "Look up exact pricing for a product. MUST be called before mentioning any $ amount. Returns exact price for Gildan 3000 t-shirts, or a range for other products.",
      parameters: {
        type: "object",
        properties: {
          qty: { type: "number", description: "Number of items" },
          sides: { type: "number", description: "1 for front-only, 2 for front+back" },
          product: {
            type: "string",
            description: "Product key. Default: tshirt_gildan_3000. Options: hoodie, polo_embroidered, hat_embroidered, mug_uv, tote_bag, sticker_decal, business_cards_flyers, pens_promo",
            default: "tshirt_gildan_3000",
          },
          rush: { type: "boolean", description: "Rush order (20% surcharge)", default: false },
        },
        required: ["qty", "sides"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escalateToHuman",
      description: "Route this lead to a human agent. Use when: customer asks for a person, complaint, order >$5000, custom product not on list, 2+ negative messages, legal/liability question.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Why this needs a human" },
        },
        required: ["reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "markDNC",
      description: "Mark this lead as Do Not Contact. Use when lead says stop, unsubscribe, remove me, etc.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "What the lead said" },
        },
        required: ["reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bookAppointment",
      description: "Reserve an internal calendar slot for the sales agent to attempt a cold outbound call to this lead. The lead has NOT agreed to a call and must not be told one was scheduled. This is an internal flag for the agent's call queue, not a mutually-agreed meeting. Use when: the conversation indicates the lead has buying intent (quote requested, quantity discussed, decision-maker confirmed) and a phone conversation would help close. Do NOT use when: lead has only given basic info or is still in early discovery. After calling this tool, continue the conversation naturally — ask qualifying questions, provide information, move toward a quote. Do NOT mention the appointment, the call, the calendar, or the time slot in your message.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Appointment title (e.g. 'T-shirt order consultation'). Defaults to 'Consultation: {business name}'." },
          notes: { type: "string", description: "Notes for the agent about what the lead wants to discuss" },
          preferredAgent: { type: "string", description: "Agent name if lead requested a specific person. Options: 'Abby Bouwer', 'Chris McHendry'" },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
];

// ── JSON Schema for response_format ────────────────────────────────────

const DECISION_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "brain_decision",
    strict: true,
    schema: {
      type: "object",
      properties: {
        reasoning: {
          type: "object",
          description: "Your internal reasoning process (not sent to lead)",
          properties: {
            intent_analysis: { type: "string", description: "What is the lead's current intent/need?" },
            stage_check: { type: "string", description: "Is my planned action aligned with the current stage objective?" },
            approach_selection: { type: "string", description: "Which approach/angle am I using and why?" },
            self_check: { type: "string", description: "Does my message violate any hard constraints? Is it different from my last message?" },
          },
          required: ["intent_analysis", "stage_check", "approach_selection", "self_check"],
          additionalProperties: false,
        },
        message: { type: ["string", "null"], description: "The message to send (or null if no message needed)" },
        channel: { type: "string", enum: ["SMS", "Email", "FB", "IG", "WA"], description: "Channel to send on" },
        nextFollowUpHours: { type: "number", description: "Hours until next follow-up (0 = no follow-up)" },
        pipelineAction: { type: ["string", "null"], enum: ["advance", "mark_won", "mark_lost", "dnc", null], description: "Pipeline stage change" },
        routeToHuman: { type: "boolean", description: "Whether to hand off to human agent" },
        routeReason: { type: ["string", "null"], description: "Why routing to human (null if not routing)" },
        confidence: { type: "number", description: "0-100 confidence in this decision" },
      },
      required: ["reasoning", "message", "channel", "nextFollowUpHours", "pipelineAction", "routeToHuman", "routeReason", "confidence"],
      additionalProperties: false,
    },
  },
};

// ── Dynamic context selection ──────────────────────────────────────────

interface ContextSelectionResult {
  personaGuidance: string;
  seasonalContext: string;
  competitiveContext: string;
  escalationRules: string;
}

function selectDynamicContext(lead: any, context: LeadContext): ContextSelectionResult {
  // Only inject persona guidance for the MATCHED segment (not all 8)
  const personaGuidance = getPersonaGuidance(context.segment) || getPersonaGuidance("small_business");

  // Only inject seasonal context if it's relevant to the current month
  const currentMonth = new Date().toLocaleString("en-US", { month: "long" }).toUpperCase();
  const seasonalLines = SEASONAL_CALENDAR.split("\n").filter(
    (line) => line.includes(currentMonth) || line.includes("PROACTIVE OUTREACH")
  );
  const seasonalContext = seasonalLines.length > 0
    ? `Current month: ${currentMonth}\n${seasonalLines.join("\n")}`
    : `Current month: ${currentMonth}`;

  // Only inject competitive intel if lead mentioned a competitor or is price-shopping
  const historyLower = (context.historyStr || "").toLowerCase();
  const mentionsCompetitor = historyLower.includes("vistaprint") ||
    historyLower.includes("customink") ||
    historyLower.includes("custom ink") ||
    historyLower.includes("cheaper") ||
    historyLower.includes("competitor") ||
    historyLower.includes("other shop") ||
    historyLower.includes("found it for less");
  const competitiveContext = mentionsCompetitor ? COMPETITIVE_INTEL : "";

  // Always include escalation rules (compact) — they're safety-critical
  const escalationRules = ESCALATION_RULES;

  return { personaGuidance, seasonalContext, competitiveContext, escalationRules };
}

// ── Few-shot examples ──────────────────────────────────────────────────

const FEW_SHOT_EXAMPLES = `
═══ EXAMPLES (study these patterns) ═══

EXAMPLE 1: First contact via SMS (new_lead stage)
Lead: John Smith, owns "Smith's Auto Repair", new_lead, SMS, no prior conversation
✅ GOOD:
{
  "reasoning": {
    "intent_analysis": "No inbound message — this is a scheduled first contact for a new lead.",
    "stage_check": "new_lead stage: goal is to get a first response. Do NOT pitch pricing.",
    "approach_selection": "Using cold outreach format with name typo pattern. Referencing their auto repair business.",
    "self_check": "Two messages separated by ---. First has casual typo hook, second corrects and delivers value prop. No pricing mentioned. Under 3 sentences each."
  },
  "message": "Hey Jhon! Saw Smith's Auto Repair might need some custom gear for the team — we're a local shop right here in Hallandale Beach.\\n---\\n*John — sorry about that! We do custom printing with no minimums and same-day turnaround. What kind of project are you thinking about?",
  "channel": "SMS",
  "nextFollowUpHours": 24,
  "pipelineAction": null,
  "routeToHuman": false,
  "routeReason": null,
  "confidence": 85
}
❌ BAD (what NOT to do):
"Hi John! Thanks for your interest in Adorb Custom Tees. We offer a wide range of custom printing services including t-shirts, hoodies, hats, and more. Our prices start at just $5.50 per shirt for orders of 200+. Would you like a quote?"
WHY BAD: Generic, no personality, pitches pricing on first contact, wall of text, no hook.

EXAMPLE 2: Lead asks about pricing (exploring stage)
Lead asked: "How much for 25 shirts with a logo on the front?"
✅ GOOD: Call getQuote(qty=25, sides=1) FIRST, then:
{
  "reasoning": {
    "intent_analysis": "Lead gave exact quantity (25) and sides (1 = front only). They want a price.",
    "stage_check": "exploring stage but they gave exact specs — I can quote now using getQuote.",
    "approach_selection": "Direct pricing from tool result. Confident delivery, no hedging.",
    "self_check": "I called getQuote first. I'm using the exact number from the tool. Not saying 'approximately'."
  },
  "message": "25 shirts, front only — here's your exact quote:\\n\\n• Gildan 3000 (S–XL): $297.50 total ($11.90/shirt)\\n• 2XL sizes: add $2.50 each | 3XL+: add $3.50 each\\n\\nExcludes tax and shipping. Want me to lock this in?",
  "channel": "SMS",
  "nextFollowUpHours": 48,
  "pipelineAction": "advance",
  "routeToHuman": false,
  "routeReason": null,
  "confidence": 95
}
❌ BAD: "Pricing depends on a few factors. Can you tell me more about what you're looking for?"
WHY BAD: Lead already gave exact specs. Asking more questions when you can answer is frustrating.

EXAMPLE 3: Lead says "stop" or "remove me" (any stage)
Lead sent: "Please stop texting me"
✅ GOOD: Call markDNC(reason="Lead said 'Please stop texting me'"), then:
{
  "reasoning": {
    "intent_analysis": "Lead explicitly requested to stop receiving messages. This is a DNC request.",
    "stage_check": "DNC overrides all stage logic. Must mark immediately.",
    "approach_selection": "Call markDNC tool. No message to send.",
    "self_check": "Not sending any message. Not trying to convince them to stay. Just marking DNC."
  },
  "message": null,
  "channel": "SMS",
  "nextFollowUpHours": 0,
  "pipelineAction": "dnc",
  "routeToHuman": false,
  "routeReason": null,
  "confidence": 100
}
❌ BAD: "I'm sorry to hear that! Before you go, can I offer you a discount?"
WHY BAD: Violates DNC hard constraint. NEVER try to retain a lead who said stop.

EXAMPLE 4: Follow-up after no response (contacted stage, 3 days since last message)
Lead: Mary Johnson, church admin, contacted stage, 3 messages sent, 0 replies
✅ GOOD:
{
  "reasoning": {
    "intent_analysis": "No new inbound. 3 messages sent with 0 replies over 3 days. Need a different angle.",
    "stage_check": "contacted stage: goal is to get a response. Must use a NEW angle — not repeat prior messages.",
    "approach_selection": "Last messages were about pricing. Switching to social proof angle — reference church orders we've done.",
    "self_check": "Different angle from last 3 messages. Short (2 sentences). Not pressuring. Not saying 'just following up'."
  },
  "message": "Hey Mary! Quick thought — we just finished 150 tees for a church retreat in Pompano and they turned out amazing. If you want, I can send you a pic of how they came out. No pressure either way!",
  "channel": "SMS",
  "nextFollowUpHours": 168,
  "pipelineAction": null,
  "routeToHuman": false,
  "routeReason": null,
  "confidence": 70
}
❌ BAD: "Hi Mary, just following up on my previous message. Did you get a chance to look at our pricing?"
WHY BAD: "Just following up" is banned. Repeats the pricing angle. Gives no new reason to respond.

EXAMPLE 5: Lead is frustrated/negative (any stage)
Lead sent: "This is the third time you've texted me. I already told you I'm not interested right now."
✅ GOOD:
{
  "reasoning": {
    "intent_analysis": "Lead is frustrated about frequency. Said 'not interested right now' — not a hard DNC but needs space.",
    "stage_check": "Frustration overrides stage logic. Must de-escalate immediately.",
    "approach_selection": "Apologize sincerely, acknowledge their frustration, offer clear exit, leave door open.",
    "self_check": "Not pitching. Not asking questions. Not being defensive. Giving them control."
  },
  "message": "You're right, and I apologize for the extra messages. I'll back off — if you ever need custom printing down the road, just text back and I'll be here. Have a great week!",
  "channel": "SMS",
  "nextFollowUpHours": 0,
  "pipelineAction": "mark_lost",
  "routeToHuman": false,
  "routeReason": null,
  "confidence": 90
}
❌ BAD: "I understand! But before I go, did you know we offer same-day turnaround? Many customers who were initially hesitant ended up loving our service!"
WHY BAD: Ignores their frustration. Pitches after they said not interested. Condescending.
`;

// ── Decision trees for high-stakes scenarios ───────────────────────────

const DECISION_TREES = `
═══ DECISION TREES (follow these exactly) ═══

TREE 1: BREAKUP MESSAGE ELIGIBILITY
├── Has it been 7+ days since last AI message? 
│   ├── NO → Do NOT send breakup. Send normal follow-up with new angle.
│   └── YES → Have 4+ messages gone unanswered?
│       ├── NO → Do NOT send breakup. Send normal follow-up with new angle.
│       └── YES → Send breakup message. Set nextFollowUpHours: 0. Set pipelineAction: "mark_lost".

TREE 2: PRICING RESPONSE
├── Did the lead ask about pricing?
│   ├── NO → Do not mention pricing.
│   └── YES → Did they give an exact quantity?
│       ├── YES → Call getQuote with their exact specs. Quote the EXACT total.
│       └── NO → Ask for quantity FIRST. Do NOT give any price or range.

TREE 3: CHANNEL SELECTION
├── Is this a reply to an inbound message?
│   └── YES → Use the SAME channel the lead messaged on.
├── Is this a follow-up (no new inbound)?
│   └── Use lead's preferredChannel.
├── Is the 24h FB/IG messaging window expired (last inbound > 24h)?
│   └── YES → Fall back to SMS or Email.

TREE 4: ESCALATION CHECK
├── Did lead ask for a person/manager/human? → escalateToHuman
├── Is the order > $5,000? → escalateToHuman
├── Is this a complaint or quality issue? → escalateToHuman
├── Did lead send 2+ negative messages in a row? → escalateToHuman
├── Is this a product we don't offer? → escalateToHuman
├── Is this a legal/liability question? → escalateToHuman
└── None of the above → Handle with AI

TREE 5: INBOUND MESSAGE RESPONSE
├── Did the lead ask a direct question?
│   └── YES → Answer their question FIRST, then (optionally) advance your agenda.
├── Did the lead express interest?
│   └── YES → Match their energy. Move to next stage action.
├── Did the lead say "stop/unsubscribe/remove me"?
│   └── YES → Call markDNC. Send NO message.
├── Did the lead say "wrong number" or seem confused?
│   └── YES → Apologize, clarify you're from Adorb Custom Tees, ask if they want to continue.
`;

// ── System prompt builder ───────────────────────────────────────────────

function buildSystemPrompt(lead: any, context: LeadContext, dynamicCtx: ContextSelectionResult): string {
  const stage = (lead.pipelineStage || "new_lead") as keyof typeof stageBehaviors;
  const behavior = stageBehaviors[stage] || stageBehaviors["new_lead"];

  return `You are the AI sales assistant for Adorb Custom Tees, a local print shop in Hallandale Beach, FL.
You text/email leads to help them order custom printed products.

═══ HARD CONSTRAINTS (violating ANY of these = system failure) ═══
1. NEVER mention internal systems, Brain Council, JSON, outbox, or any technical infrastructure.
2. NEVER invent prices. MUST call getQuote tool first. If getQuote returns callForQuote=true, say "I'll have our team put together a custom quote for that."
3. NEVER quote a price without calling getQuote first — even if you "know" the price.
4. NEVER send more than 1 message per turn (system handles splitting).
5. NEVER contact a lead who said "stop/unsubscribe/remove me" — call markDNC instead.
6. NEVER promise delivery dates. Say "typically X days" not "guaranteed by."
7. NEVER badmouth competitors. Say "I can't speak to their work, but here's what we offer..."
8. NEVER repeat the same angle as your previous message. Check conversation history.
9. BREAKUP messages: ONLY after 7+ days silence AND 4+ unanswered. Never before.
10. If lead is confused/wrong number: apologize, clarify you're from Adorb Custom Tees.
11. NEVER say "just following up" or "checking in" — always lead with NEW value.
12. NEVER send a message that doesn't give the lead a reason to respond.
13. APPOINTMENT HANDLING: When you call bookAppointment, the system reserves an internal slot for the sales agent to attempt an outbound call. The lead has NOT agreed to a call. Never tell the lead you scheduled a call, booked a meeting, sent a calendar invite, or that someone will call them at a specific time. After bookAppointment succeeds, your next message should continue the sales conversation naturally — ask a qualifying question, provide a quote, or move toward close. The appointment is invisible to the lead.

═══ COLD OUTREACH FORMAT (first contact via SMS) ═══
When this is FIRST CONTACT via SMS (no prior conversation):
- Write TWO short messages separated by \\n---\\n
- Message 1: Casual hook with a slight misspelling of their name (e.g., "Micheal" → "Michael"). 1-2 sentences. Reference their business/event if known.
- Message 2: Correct the name ("*Michael — sorry!") then value prop in 1-2 sentences.
- For corporate leads: use casual nickname instead of typo (e.g., "Mike" instead of "Michael").

═══ REASONING PROCESS (follow this EVERY time) ═══
Before composing your message, you MUST complete these 4 steps in the "reasoning" field:
1. INTENT ANALYSIS: What does the lead need/want right now? What did they last say?
2. STAGE CHECK: What is my stage objective? Does my planned action align?
3. APPROACH SELECTION: What angle/hook am I using? Is it DIFFERENT from my last message?
4. SELF-CHECK: Does my draft violate any hard constraint? Would I respond to this message?

═══ BRAND VOICE ═══
${BRAND_VOICE_GUIDE}

═══ CURRENT STAGE: ${String(stage).toUpperCase()} ═══
Objective: ${behavior.objective}
${behavior.signals_to_ask_for.length > 0 ? `Ask about: ${behavior.signals_to_ask_for.join(", ")}` : ""}
${behavior.avoid.length > 0 ? `Avoid: ${behavior.avoid.join(", ")}` : ""}

═══ LEAD CONTEXT ═══
Name: ${lead.name || "Unknown"}
Business: ${lead.businessName || "Unknown"}
Email: ${lead.email || "None"}
Phone: ${lead.phone || "None"}
Active Channel (from last conversation): ${context.activeChannel}
Preferred Channel (may be stale): ${lead.preferredChannel || "SMS"}
Pipeline Stage: ${lead.pipelineStage || "new_lead"}
Segment: ${context.segment || "general"}
Score: ${lead.opportunityScore || 0}/100

═══ MEMORY ═══
${context.memory || "No prior memory."}

═══ CONVERSATION HISTORY (most recent first) ═══
${context.historyStr || "No prior conversation."}

═══ AI STATE ═══
Messages sent: ${context.messageCount || 0}
Last angle used: ${context.lastAngleUsed || "none"}
Unanswered questions: ${context.unansweredQuestions || "none"}
Sentiment trend: ${context.sentimentTrend || "neutral"}

═══ MATCHED PERSONA ═══
${dynamicCtx.personaGuidance}

═══ SEASONAL CONTEXT ═══
${dynamicCtx.seasonalContext}

${dynamicCtx.competitiveContext ? `═══ COMPETITIVE INTELLIGENCE (lead mentioned a competitor) ═══\n${dynamicCtx.competitiveContext}` : ""}
${context.topApproaches ? `═══ ADAPTIVE LEARNING (data-driven from past outcomes) ═══\n${context.topApproaches}` : ""}

═══ ESCALATION RULES ═══
${dynamicCtx.escalationRules}

${DECISION_TREES}

${FEW_SHOT_EXAMPLES}

═══ CHANNEL RULES ═══
- SMS: 1-3 sentences max. Like a text from a friend.
- Email: Short punchy lines. Each thought = its own line. Include signature.
- Facebook/Instagram: Casual, emoji-light. Match platform energy.
- If preferred channel is FB/IG and 24h window expired (last inbound > 24h), fall back to SMS or Email.

═══ YOUR TASK ═══
Follow the reasoning process above. Use tools if needed (getQuote for pricing, escalateToHuman for complaints, markDNC for opt-outs). Return your decision as structured JSON.`;
}

// ── Context assembly ────────────────────────────────────────────────────

interface LeadContext {
  segment: string;
  memory: string;
  historyStr: string;
  activeChannel: string;
  messageCount: number;
  lastAngleUsed: string | null;
  unansweredQuestions: string | null;
  sentimentTrend: string | null;
  topApproaches: string | null;
}

async function buildAdaptiveLearningContext(aiStateRow: any, lead: any): Promise<string | null> {
  try {
    const { getTopApproaches, getAvoidApproaches } = await import("./db");
    const segment = aiStateRow?.segment || "general";
    const channel = lead?.preferredChannel || "sms";
    const stage = lead?.pipelineStage || "new_lead";
    const [topApproaches, avoidApproaches] = await Promise.all([
      getTopApproaches(segment, channel, stage, 3),
      getAvoidApproaches(segment, channel, 3),
    ]);
    const parts: string[] = [];
    if (topApproaches.length > 0) {
      parts.push(`TOP APPROACHES for this segment/channel/stage (prefer these):\n${topApproaches.map((a: any) => `  \u2022 ${a.approach} (${a.winRate}% win rate, ${a.samples} samples)`).join("\n")}`);
    }
    if (avoidApproaches.length > 0) {
      parts.push(`AVOID these approaches (low performance):\n${avoidApproaches.map((a: any) => `  \u2022 ${a.approach} (${a.winRate}% win rate, ${a.samples} samples)`).join("\n")}`);
    }
    return parts.length > 0 ? parts.join("\n") : null;
  } catch (err) {
    // Non-fatal — proceed without adaptive data
    return null;
  }
}

async function assembleContext(leadId: number): Promise<LeadContext> {
  const [history, memory, aiStateRow, lead] = await Promise.all([
    getConversationHistory(leadId, 20),
    getLeadMemory(leadId),
    getAiState(leadId),
    getLeadById(leadId),
  ]);

  // Derive active channel from most recent inbound message in conversation history
  // (history is ordered newest-first from DB)
  const lastInbound = history.find((msg: any) => msg.direction === "inbound" && msg.channel);
  const activeChannel = lastInbound?.channel || lead?.preferredChannel || "SMS";

  // Format conversation history for the prompt
  const historyStr = history.length > 0
    ? history
        .reverse() // oldest first for reading order
        .map((msg: any) => {
          const dir = msg.direction === "inbound" ? "LEAD" : msg.senderType === "human" ? "AGENT" : "AI";
          const ch = msg.channel ? ` [${msg.channel}]` : "";
          const time = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : "";
          return `[${time}] ${dir}${ch}: ${msg.messageBody || "(no text)"}`;
        })
        .join("\n")
    : "No prior conversation.";

  return {
    segment: aiStateRow?.segment || "general",
    memory,
    historyStr,
    activeChannel,
    messageCount: aiStateRow?.messageCount || 0,
    lastAngleUsed: aiStateRow?.lastAngleUsed || null,
    unansweredQuestions: aiStateRow?.unansweredQuestions
      ? JSON.stringify(aiStateRow.unansweredQuestions)
      : null,
    sentimentTrend: aiStateRow?.sentimentTrend || null,
    topApproaches: await buildAdaptiveLearningContext(aiStateRow, lead),
  };
}

// ── Tool execution ──────────────────────────────────────────────────────
import { insertQuote, updateLeadFields } from "./db";
import { createAppointment, getNextBusinessHoursSlot, getCalendarEvents, AGENT_CALENDAR_IDS, toETOffsetString } from "./ghl";

async function executeTool(name: string, argsStr: string, leadId: number): Promise<any> {
  const args = JSON.parse(argsStr);

  switch (name) {
    case "getQuote": {
      const result = getQuote(args.qty, args.sides, args.product, args.rush);
      // Persist quote to DB
      try {
        const toCents = (v: number | null) => v != null ? Math.round(v * 100) : null;
        await insertQuote({
          leadId,
          product: result.product,
          productName: result.productName,
          qty: result.qty,
          sides: result.sides,
          perUnit: toCents(result.perUnit),
          perUnitRangeLow: result.perUnitRange ? Math.round(result.perUnitRange[0] * 100) : null,
          perUnitRangeHigh: result.perUnitRange ? Math.round(result.perUnitRange[1] * 100) : null,
          subtotal: toCents(result.subtotal),
          rushFee: toCents(result.rushFee),
          setupFee: Math.round((result.setupFee || 0) * 100),
          total: toCents(result.total),
          rush: args.rush ? 1 : 0,
          status: result.callForQuote ? "call_for_quote" : "sent",
          breakdown: result.breakdown,
          callForQuote: result.callForQuote ? 1 : 0,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30-day validity
        });
      } catch (err) {
        console.error(`[SingleBrain] Failed to persist quote for lead ${leadId}:`, err);
      }
      return result;
    }
    case "escalateToHuman":
      return { escalated: true, reason: args.reason };
    case "markDNC":
      return { marked: true, reason: args.reason };
    case "bookAppointment": {
      return await executeBookAppointment(args, leadId);
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/**
 * Book an appointment on the GHL calendar for this lead.
 * Finds next available business-hours slot, creates the appointment,
 * and updates the lead's pipeline stage to 'appointment_scheduled'.
 */
async function executeBookAppointment(
  args: { title?: string; notes?: string; preferredAgent?: string },
  leadId: number,
): Promise<any> {
  try {
    const lead = await getLeadById(leadId);
    if (!lead || !lead.ghlContactId) {
      return { error: "Cannot book appointment: lead has no GHL contact ID" };
    }

    // Determine agent — prefer the lead's assigned agent, fallback to Abby
    const agent = args.preferredAgent || lead.assignedAgent || "Abby Bouwer";
    const calendarId = AGENT_CALENDAR_IDS[agent] || AGENT_CALENDAR_IDS["Abby Bouwer"];

    // Find next available slot with conflict checking
    let slot = getNextBusinessHoursSlot(new Date(), agent);
    let attempts = 0;
    while (attempts < 20) {
      const slotEndMs = slot.start.getTime() + 10 * 60 * 1000;
      const windowStart = new Date(slot.start.getTime() - 5 * 60 * 1000);
      const windowEnd = new Date(slotEndMs + 5 * 60 * 1000);
      try {
        const events = await getCalendarEvents(calendarId, windowStart.toISOString(), windowEnd.toISOString());
        if (!events || events.length === 0) break; // slot is free
        slot = getNextBusinessHoursSlot(new Date(slot.start.getTime() + 10 * 60 * 1000), agent);
      } catch {
        break; // Non-fatal — proceed with current slot
      }
      attempts++;
    }

    const endTime = new Date(slot.start.getTime() + 10 * 60 * 1000);
    const title = args.title || `Consultation: ${lead.businessName || lead.name || 'Customer'}`;

    const result = await createAppointment({
      calendarId,
      contactId: lead.ghlContactId,
      title,
      description: args.notes || `Appointment booked by AI assistant for ${lead.name || 'customer'}.`,
      startTime: toETOffsetString(slot.start),
      endTime: toETOffsetString(endTime),
    });

    const appointmentId = result?.id || result?.event?.id || null;

    // Update lead pipeline stage
    await updateLeadFields(leadId, { pipelineStage: "appointment_scheduled" });

    const humanReadableSlot = slot.start.toLocaleString("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }) + " ET";

    return {
      booked: true,
      reserved_internally: true,
      appointmentId,
      agent,
      _internal: {
        startTime: slot.start.toISOString(),
        endTime: endTime.toISOString(),
        humanReadableSlot,
      },
    };
  } catch (err: any) {
    console.error(`[SingleBrain] bookAppointment failed for lead ${leadId}:`, err);
    return { error: `Failed to book appointment: ${err?.message}` };
  }
}

// ── Main brain function ─────────────────────────────────────────────────

export interface SingleBrainInput {
  leadId: number;
  trigger: string;
  inboundMessage?: string;
  channel?: string;
  draftMessage?: string; // Pre-composed message (skip brain, just send)
}

export interface SingleBrainOutput {
  decision: BrainDecision;
  guardResult: GuardResult;
  toolLog: ToolCallRecord[];
  model: string;
  promptVersion: string;
  durationMs: number;
  llmCalls: number;
}

export async function runSingleBrain(input: SingleBrainInput): Promise<SingleBrainOutput> {
  const startTime = Date.now();
  let llmCalls = 0;
  const toolLog: ToolCallRecord[] = [];

  // If pre-composed message, skip the brain entirely
  if (input.draftMessage) {
    const decision: BrainDecision = {
      message: input.draftMessage,
      channel: (input.channel as BrainDecision["channel"]) || "SMS",
      nextFollowUpHours: 72,
      pipelineAction: null,
      routeToHuman: false,
      routeReason: null,
      confidence: 100,
    };
    const lead = await getLeadById(input.leadId);
    const guardResult = runOutputGuards(decision, lead || {}, input, []);
    return {
      decision: guardResult.correctedDecision || decision,
      guardResult,
      toolLog: [],
      model: "pre-composed",
      promptVersion: CURRENT_PROMPT_VERSION,
      durationMs: Date.now() - startTime,
      llmCalls: 0,
    };
  }

  // Step 1: Load lead and assemble context
  const lead = await getLeadById(input.leadId);
  if (!lead) {
    throw new Error(`Lead ${input.leadId} not found`);
  }

  const context = await assembleContext(input.leadId);

  // Step 2: Dynamic context selection
  const dynamicCtx = selectDynamicContext(lead, context);

  // Step 3: Select model (base or fine-tuned via A/B)
  const { model, isFineTuned, jobId } = await selectModel();

  // Step 4: Build messages with reasoning scaffold
  const systemPrompt = buildSystemPrompt(lead, context, dynamicCtx);
  const messages: Message[] = [
    { role: "system", content: systemPrompt },
  ];

  // Add the trigger context as user message
  if (input.inboundMessage) {
    const channelNote = input.channel ? ` on ${input.channel}` : "";
    messages.push({
      role: "user",
      content: `The lead just sent this message${channelNote}: "${input.inboundMessage}"\n\nYou MUST reply on the same channel they messaged on (${context.activeChannel}). Follow the reasoning process. Answer their question/need FIRST, then advance your agenda if appropriate. Use tools if needed (getQuote for pricing, escalateToHuman for complaints, markDNC for opt-outs).`,
    });
  } else {
    messages.push({
      role: "user",
      content: `Trigger: ${input.trigger}. The lead has not sent a new message. Follow the reasoning process. Based on conversation history and current stage, decide what to do next. If a follow-up is appropriate, compose one with a NEW angle. If not, return message: null.`,
    });
  }

  // Step 5: LLM loop with tool use
  let toolRounds = 0;

  while (toolRounds < MAX_TOOL_ROUNDS) {
    const response = await invokeLLM({
      messages,
      tools: TOOLS,
      toolChoice: "auto",
      model,
      response_format: toolRounds === 0 ? undefined : undefined, // Can't use response_format with tools
    });
    llmCalls++;

    if (!response || !response.choices) {
      console.error(`[SingleBrain] LLM returned no choices for lead ${input.leadId}. Response keys:`, Object.keys(response || {}), 'Full:', JSON.stringify(response).substring(0, 500));
      throw new Error(`LLM returned invalid response (no choices array) for lead ${input.leadId}`);
    }
    const choice = response.choices[0];
    if (!choice) throw new Error("No response from LLM — choices array is empty");

    const assistantMsg = choice.message;

    // If no tool calls, we have the final response
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      let content = typeof assistantMsg.content === "string"
        ? assistantMsg.content
        : (assistantMsg.content as any)?.[0]?.text || "";

      // If the response doesn't contain valid JSON, do a structured follow-up call
      const hasJson = /\{[\s\S]*"message"[\s\S]*\}/.test(content);
      if (!hasJson && content.length > 0) {
        console.log(`[SingleBrain] LLM returned unstructured text for lead ${input.leadId} — doing structured follow-up call`);
        // Add the unstructured response as assistant context, then ask for JSON
        messages.push({ role: "assistant", content });
        messages.push({ role: "user", content: "Now format your decision as the required JSON structure with fields: reasoning, message, channel, nextFollowUpHours, pipelineAction, routeToHuman, routeReason, confidence." });
        const structuredResponse = await invokeLLM({
          messages,
          model,
          response_format: DECISION_SCHEMA,
        });
        llmCalls++;
        if (structuredResponse?.choices?.[0]?.message?.content) {
          content = typeof structuredResponse.choices[0].message.content === "string"
            ? structuredResponse.choices[0].message.content
            : (structuredResponse.choices[0].message.content as any)?.[0]?.text || content;
        }
      }

      const decision = parseDecision(content, input, lead);
      decision.toolLog = toolLog;
      decision.promptVersion = CURRENT_PROMPT_VERSION;

      // Run output guards
      const guardResult = runOutputGuards(decision, lead, input, toolLog);

      return {
        decision: guardResult.correctedDecision || decision,
        guardResult,
        toolLog,
        model,
        promptVersion: CURRENT_PROMPT_VERSION,
        durationMs: Date.now() - startTime,
        llmCalls,
      };
    }

    // Process tool calls
    messages.push({ role: "assistant", content: assistantMsg.content || "", ...({ tool_calls: assistantMsg.tool_calls } as any) });

    for (const toolCall of assistantMsg.tool_calls) {
      const result = await executeTool(toolCall.function.name, toolCall.function.arguments, input.leadId);
      toolLog.push({
        name: toolCall.function.name,
        args: toolCall.function.arguments,
        result,
      });

      messages.push({
        role: "tool",
        content: JSON.stringify(result),
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
      });

      // Handle side-effect tools
      if (toolCall.function.name === "escalateToHuman") {
        const decision: BrainDecision = {
          message: null,
          channel: (input.channel as BrainDecision["channel"]) || "SMS",
          nextFollowUpHours: 0,
          pipelineAction: null,
          routeToHuman: true,
          routeReason: result.reason,
          confidence: 95,
          toolLog,
          promptVersion: CURRENT_PROMPT_VERSION,
        };
        const guardResult = runOutputGuards(decision, lead, input, toolLog);
        return {
          decision: guardResult.correctedDecision || decision,
          guardResult,
          toolLog,
          model,
          promptVersion: CURRENT_PROMPT_VERSION,
          durationMs: Date.now() - startTime,
          llmCalls,
        };
      }

      if (toolCall.function.name === "markDNC") {
        const decision: BrainDecision = {
          message: null,
          channel: (input.channel as BrainDecision["channel"]) || "SMS",
          nextFollowUpHours: 0,
          pipelineAction: "dnc",
          routeToHuman: false,
          routeReason: null,
          confidence: 100,
          toolLog,
          promptVersion: CURRENT_PROMPT_VERSION,
        };
        const guardResult = runOutputGuards(decision, lead, input, toolLog);
        return {
          decision: guardResult.correctedDecision || decision,
          guardResult,
          toolLog,
          model,
          promptVersion: CURRENT_PROMPT_VERSION,
          durationMs: Date.now() - startTime,
          llmCalls,
        };
      }
    }

    toolRounds++;
  }

  // If we exhausted tool rounds, do a final call with response_format for reliable JSON
  messages.push({
    role: "user",
    content: "Now compose your final response to the lead based on the tool results above. Follow the reasoning process and return your decision.",
  });

  const finalResponse = await invokeLLM({
    messages,
    model,
    response_format: DECISION_SCHEMA,
  });
  llmCalls++;

  const finalContent = typeof finalResponse.choices[0]?.message?.content === "string"
    ? finalResponse.choices[0].message.content
    : (finalResponse.choices[0]?.message?.content as any)?.[0]?.text || "";

  const decision = parseDecision(finalContent, input, lead);
  decision.toolLog = toolLog;
  decision.promptVersion = CURRENT_PROMPT_VERSION;

  const guardResult = runOutputGuards(decision, lead, input, toolLog);

  return {
    decision: guardResult.correctedDecision || decision,
    guardResult,
    toolLog,
    model,
    promptVersion: CURRENT_PROMPT_VERSION,
    durationMs: Date.now() - startTime,
    llmCalls,
  };
}

// ── Decision parser ─────────────────────────────────────────────────────

function parseDecision(content: string, input: SingleBrainInput, lead: any): BrainDecision {
  // Try to extract JSON from the response
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        message: parsed.message || null,
        channel: parsed.channel || (input.channel as BrainDecision["channel"]) || (lead.preferredChannel as BrainDecision["channel"]) || "SMS",
        nextFollowUpHours: typeof parsed.nextFollowUpHours === "number" ? parsed.nextFollowUpHours : 24,
        pipelineAction: parsed.pipelineAction || null,
        routeToHuman: parsed.routeToHuman === true,
        routeReason: parsed.routeReason || null,
        confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(100, parsed.confidence)) : 50,
      };
    } catch {
      // Fall through to text extraction
    }
  }

  // If no valid JSON, treat the entire content as the message (low confidence)
  return {
    message: content.trim() || null,
    channel: (input.channel as BrainDecision["channel"]) || (lead.preferredChannel as BrainDecision["channel"]) || "SMS",
    nextFollowUpHours: 24,
    pipelineAction: null,
    routeToHuman: false,
    routeReason: null,
    confidence: 30,
  };
}
