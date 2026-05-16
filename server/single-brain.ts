/**
 * SINGLE BRAIN — Replaces the 7-brain pipeline with one smart LLM call.
 *
 * Architecture:
 *   1. Assemble context (lead data, conversation history, memory, stage behavior, pricing)
 *   2. Build system prompt with hard constraints + soft guidance
 *   3. Two-step LLM loop: Call 1 = reasoning + optional tool use, Call 2 = finalize message
 *   4. Parse structured output (BrainDecision)
 *   5. Run output guards
 *   6. Return decision for outbox worker to send
 *
 * Connected to:
 *   - outbox-worker.ts → calls runSingleBrain() for each outbox row
 *   - pricing-engine.ts → getQuote tool implementation
 *   - output-guards.ts → post-brain safety checks
 *   - fine-tuning-pipeline.ts → selectModel() for A/B model selection
 */

import { invokeLLM, type Message, type Tool, type ToolCall } from "./_core/llm";
import { getLeadById, getConversationHistory, getAiState } from "./db";
import { getLeadMemory } from "./lead-memory";
import { getQuote, type QuoteResult } from "./pricing-engine";
import { selectModel } from "./fine-tuning-pipeline";
import { runOutputGuards, type BrainDecision, type ToolCallRecord, type GuardResult } from "./output-guards";
import stageBehaviors from "../shared/stage-behavior.json";
import { BRAND_VOICE_GUIDE, PERSONA_PLAYBOOKS, ESCALATION_RULES, COMPETITIVE_INTEL, SEASONAL_CALENDAR } from "../shared/sales-training";

// Re-export for consumers
export type { BrainDecision, ToolCallRecord, GuardResult };

// ── Constants ───────────────────────────────────────────────────────────

const MAX_TOOL_ROUNDS = 3;
const CURRENT_PROMPT_VERSION = "v2.0";

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
          sides: { type: "number", enum: [1, 2], description: "1 for front-only, 2 for front+back" },
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
];

// ── System prompt builder ───────────────────────────────────────────────

function buildSystemPrompt(lead: any, context: LeadContext): string {
  const stage = (lead.pipelineStage || "new_lead") as keyof typeof stageBehaviors;
  const behavior = stageBehaviors[stage] || stageBehaviors["new_lead"];

  const currentMonth = new Date().toLocaleString("en-US", { month: "long" });
  const currentDay = new Date().toLocaleString("en-US", { weekday: "long" });

  return `You are the AI sales assistant for Adorb Custom Tees, a local print shop in Hallandale Beach, FL.
You are texting/emailing leads to help them order custom printed products.

═══ HARD CONSTRAINTS (never violate) ═══
1. NEVER mention internal systems, Brain Council, JSON, outbox, or any technical infrastructure.
2. NEVER invent prices. If the lead asks about pricing, you MUST call the getQuote tool first. If getQuote returns callForQuote=true, say "I'll have our team put together a custom quote for that."
3. NEVER quote a price without calling getQuote first — even if you "know" the price from training data.
4. NEVER send more than 1 message per turn. The system handles message splitting.
5. NEVER contact a lead who said "stop", "unsubscribe", "remove me" — call markDNC instead.
6. NEVER promise delivery dates you can't guarantee. Say "typically X days" not "guaranteed by."
7. NEVER badmouth competitors. Say "I can't speak to their work, but here's what we offer..."
8. NEVER send a follow-up that repeats the same angle as the previous message. Check conversation history.
9. For BREAKUP messages: ONLY after 7+ days of silence AND 4+ unanswered messages. Never before.
10. If the lead is confused about who you are or says "wrong number": apologize, clarify you're from Adorb Custom Tees, and ask if they'd like to continue.

═══ COLD OUTREACH FORMAT (first contact via SMS) ═══
When this is a FIRST CONTACT via SMS (no prior conversation):
- Write TWO short messages separated by \\n---\\n
- Message 1: Casual hook with a slight misspelling of their name (e.g., "Micheal" instead of "Michael", "Jhon" instead of "John"). Keep it 1-2 sentences. Reference their business/event if known.
- Message 2: Correct the name spelling ("*Michael — sorry!") then deliver the value prop in 1-2 sentences.
- This mimics a human texting pattern and draws attention.
- For corporate leads, use a casual nickname instead of a typo (e.g., "Mike" instead of "Michael").
- Example: "Hey Micheal! Saw ${lead.businessName || "your business"} might need custom tees — we're a local shop in Hallandale Beach.\\n---\\n*Michael — sorry about that! We do custom printing with no minimums and same-day turnaround. What kind of project are you working on?"

═══ BRAND VOICE ═══
${BRAND_VOICE_GUIDE}

═══ CURRENT STAGE: ${stage.toUpperCase()} ═══
Objective: ${behavior.objective}
${behavior.signals_to_ask_for.length > 0 ? `Ask about: ${behavior.signals_to_ask_for.join(", ")}` : ""}
${behavior.avoid.length > 0 ? `Avoid: ${behavior.avoid.join(", ")}` : ""}

═══ LEAD CONTEXT ═══
Name: ${lead.name || "Unknown"}
Business: ${lead.businessName || "Unknown"}
Email: ${lead.email || "None"}
Phone: ${lead.phone || "None"}
Preferred Channel: ${lead.preferredChannel || "SMS"}
Pipeline Stage: ${lead.pipelineStage || "new_lead"}
Segment: ${context.segment || "general"}
Score: ${lead.opportunityScore || 0}/100

═══ MEMORY (what we know about this lead) ═══
${context.memory || "No prior memory."}

═══ CONVERSATION HISTORY (most recent first) ═══
${context.historyStr || "No prior conversation."}

═══ AI STATE ═══
Messages sent: ${context.messageCount || 0}
Last angle used: ${context.lastAngleUsed || "none"}
Unanswered questions: ${context.unansweredQuestions || "none"}
Sentiment trend: ${context.sentimentTrend || "neutral"}

${context.topApproaches ? `═══ WHAT'S WORKING FOR THIS SEGMENT ═══\n${context.topApproaches}` : ""}

═══ PERSONA PLAYBOOKS ═══
${PERSONA_PLAYBOOKS}

═══ ESCALATION RULES ═══
${ESCALATION_RULES}

═══ COMPETITIVE INTELLIGENCE ═══
${COMPETITIVE_INTEL}

═══ SEASONAL CONTEXT ═══
Current month: ${currentMonth} (${currentDay})
${SEASONAL_CALENDAR}

═══ CHANNEL RULES ═══
- SMS: 1-3 sentences max. Like a text from a friend.
- Email: Short punchy lines. Each thought = its own line. Include signature.
- Facebook/Instagram: Casual, emoji-light. Match platform energy.
- If the lead's preferred channel is FB/IG and the 24-hour messaging window has expired (last inbound > 24h ago), fall back to SMS or Email.

═══ YOUR TASK ═══
Based on the above context, decide what to do next for this lead.
You MUST respond with a JSON object matching this exact schema:
{
  "message": "The message to send (or null if no message needed)",
  "channel": "SMS" | "Email" | "FB" | "IG" | "WA",
  "nextFollowUpHours": <number>,
  "pipelineAction": "advance" | "mark_won" | "mark_lost" | "dnc" | null,
  "routeToHuman": false,
  "routeReason": null,
  "confidence": <0-100>
}`;
}

// ── Context assembly ────────────────────────────────────────────────────

interface LeadContext {
  segment: string;
  memory: string;
  historyStr: string;
  messageCount: number;
  lastAngleUsed: string | null;
  unansweredQuestions: string | null;
  sentimentTrend: string | null;
  topApproaches: string | null;
}

async function assembleContext(leadId: number): Promise<LeadContext> {
  const [history, memory, aiStateRow] = await Promise.all([
    getConversationHistory(leadId, 20),
    getLeadMemory(leadId),
    getAiState(leadId),
  ]);

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
    segment: "general", // Will be enriched by lead-utils.ts in Phase 3
    memory,
    historyStr,
    messageCount: aiStateRow?.messageCount || 0,
    lastAngleUsed: aiStateRow?.lastAngleUsed || null,
    unansweredQuestions: aiStateRow?.unansweredQuestions
      ? JSON.stringify(aiStateRow.unansweredQuestions)
      : null,
    sentimentTrend: aiStateRow?.sentimentTrend || null,
    topApproaches: null, // Will be enriched by segment_weights in Phase 5
  };
}

// ── Tool execution ──────────────────────────────────────────────────────

function executeTool(name: string, argsStr: string): any {
  const args = JSON.parse(argsStr);

  switch (name) {
    case "getQuote":
      return getQuote(args.qty, args.sides, args.product, args.rush);
    case "escalateToHuman":
      return { escalated: true, reason: args.reason };
    case "markDNC":
      return { marked: true, reason: args.reason };
    default:
      return { error: `Unknown tool: ${name}` };
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
    const guardResult = runOutputGuards(decision, lead || {}, []);
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

  // Step 2: Select model (base or fine-tuned via A/B)
  const { model, isFineTuned, jobId } = await selectModel();

  // Step 3: Build messages
  const systemPrompt = buildSystemPrompt(lead, context);
  const messages: Message[] = [
    { role: "system", content: systemPrompt },
  ];

  // Add the trigger context as user message
  if (input.inboundMessage) {
    messages.push({
      role: "user",
      content: `The lead just sent this message: "${input.inboundMessage}"\n\nRespond appropriately. Remember to use tools if needed (getQuote for pricing, escalateToHuman for complaints, markDNC for opt-outs).`,
    });
  } else {
    messages.push({
      role: "user",
      content: `Trigger: ${input.trigger}. The lead has not sent a new message. Based on the conversation history and current stage, decide what to do next. If a follow-up is appropriate, compose one. If not, return message: null.`,
    });
  }

  // Step 4: Two-step LLM loop (tool use → finalize)
  let toolRounds = 0;

  while (toolRounds < MAX_TOOL_ROUNDS) {
    const response = await invokeLLM({
      messages,
      tools: TOOLS,
      toolChoice: "auto",
      model,
    });
    llmCalls++;

    const choice = response.choices[0];
    if (!choice) throw new Error("No response from LLM");

    const assistantMsg = choice.message;

    // If no tool calls, we have the final response
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      // Parse the response as BrainDecision
      const content = typeof assistantMsg.content === "string"
        ? assistantMsg.content
        : (assistantMsg.content as any)?.[0]?.text || "";

      const decision = parseDecision(content, input, lead);
      decision.toolLog = toolLog;
      decision.promptVersion = CURRENT_PROMPT_VERSION;

      // Run output guards
      const guardResult = runOutputGuards(decision, lead, toolLog);

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
      const result = executeTool(toolCall.function.name, toolCall.function.arguments);
      toolLog.push({
        name: toolCall.function.name,
        args: toolCall.function.arguments,
        result,
      });

      messages.push({
        role: "tool",
        content: JSON.stringify(result),
        tool_call_id: toolCall.id,
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
        const guardResult = runOutputGuards(decision, lead, toolLog);
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
        const guardResult = runOutputGuards(decision, lead, toolLog);
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

  // If we exhausted tool rounds, do a final call without tools to get the message
  messages.push({
    role: "user",
    content: "Now compose your final response to the lead based on the tool results above. Return the JSON decision object.",
  });

  const finalResponse = await invokeLLM({
    messages,
    model,
  });
  llmCalls++;

  const finalContent = typeof finalResponse.choices[0]?.message?.content === "string"
    ? finalResponse.choices[0].message.content
    : (finalResponse.choices[0]?.message?.content as any)?.[0]?.text || "";

  const decision = parseDecision(finalContent, input, lead);
  decision.toolLog = toolLog;
  decision.promptVersion = CURRENT_PROMPT_VERSION;

  const guardResult = runOutputGuards(decision, lead, toolLog);

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

  // If no valid JSON, treat the entire content as the message
  return {
    message: content.trim() || null,
    channel: (input.channel as BrainDecision["channel"]) || (lead.preferredChannel as BrainDecision["channel"]) || "SMS",
    nextFollowUpHours: 24,
    pipelineAction: null,
    routeToHuman: false,
    routeReason: null,
    confidence: 30, // Low confidence since we couldn't parse structured output
  };
}
