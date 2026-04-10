/**
 * LAYER 3: INTENT CLASSIFIER — Fast LLM classification of inbound message intent
 *
 * Classifies every inbound message into one of the defined intents.
 * Output feeds into the Conversation State Machine (conversation-state.ts).
 *
 * Phase A: Observation mode — classifies and stores, but does NOT change routing behavior.
 */

import { invokeLLM } from "./_core/llm";

// ─── Intent Taxonomy ────────────────────────────────────────────────────────

export type MessageIntent =
  | "design_request"       // Lead provides design details, logo, colors, quantities
  | "price_inquiry"        // Lead asks about pricing, quotes, costs
  | "confirmation"         // Lead confirms details ("yes", "that's right", "sounds good")
  | "thank_you_close"      // Lead says "thank you" after a confirmation exchange (deal signal)
  | "objection"            // Lead raises price/timing/competitor/quality concern
  | "dnc"                  // Lead says "stop", "unsubscribe", "remove me"
  | "question"             // Lead asks a general question (turnaround, process, etc.)
  | "complaint"            // Lead expresses dissatisfaction with service/product
  | "referral"             // Lead refers someone else or asks about referral
  | "reorder"              // Lead wants to place another order
  | "general_chat"         // Casual conversation, greetings, small talk
  | "attachment_only"      // Lead sent a file/image with no text
  | "soft_decline"        // Lead politely declines ("not right now", "maybe later", "not interested")
  | "unclear";             // Cannot determine intent from message

export interface IntentResult {
  intent: MessageIntent;
  confidence: number;       // 0-100
  reasoning: string;        // 1-sentence explanation
  closingSignal: boolean;   // true if this message indicates deal progression
  timestamp: number;        // Date.now() when classified
}

// ─── Classifier ─────────────────────────────────────────────────────────────

const CLASSIFIER_PROMPT = `You are an intent classifier for Adorb Custom Tees, a custom t-shirt printing business.

Classify the customer's latest message into ONE intent. Use the conversation history for context.

=== INTENT DEFINITIONS ===
- design_request: Customer provides design details (logo, colors, sizes, quantities, event name, artwork)
- price_inquiry: Customer asks about pricing, quotes, costs, or "how much"
- confirmation: Customer confirms details ("yes", "that's right", "sounds good", "perfect", "correct")
- thank_you_close: Customer says "thank you" or "thanks" AFTER a confirmation exchange — this is a CLOSING SIGNAL meaning the customer considers the deal agreed upon. Only classify as thank_you_close if the prior exchange involved confirming order details.
- objection: Customer raises a concern about price ("too expensive"), timing ("too slow"), competitors ("found cheaper"), or quality
- dnc: Customer explicitly asks to stop receiving messages ("stop", "unsubscribe", "remove me", "do not contact")
- question: Customer asks about process, turnaround time, materials, shipping, or other general questions
- complaint: Customer expresses dissatisfaction ("unhappy", "wrong order", "never received", "terrible")
- referral: Customer mentions referring someone or asks about referral programs
- reorder: Customer wants to place another order ("need more", "reorder", "same as last time")
- general_chat: Casual greetings, small talk, or messages that don't fit other categories
- attachment_only: Message is about a file/image attachment with no other clear intent
- soft_decline: Customer politely declines without opting out ("not right now", "maybe later", "not interested at this time", "we went with someone else", "not looking for this"). This is NOT a DNC — they may be open to future contact but are saying no to the current offer.
- unclear: Cannot determine intent — message is too short, ambiguous, or garbled

=== CLOSING SIGNAL RULES ===
A closingSignal is TRUE when:
1. Customer says "thank you" / "thanks" AFTER confirming design details or order specifics
2. Customer says "sounds good" / "perfect" / "let's do it" in response to a quote or confirmation
3. Customer provides payment info or asks "how do I pay"
4. Customer says "yes" to a direct close question ("Ready to get started?")

A closingSignal is FALSE for:
1. Generic "thank you" at the start of a conversation (politeness, not closing)
2. "Thank you" after receiving information (they're still exploring)
3. Confirmations that are just acknowledging receipt ("got it", "ok") without committing

=== IMPORTANT ===
- Read the FULL conversation history to understand context
- A "thank you" early in the conversation is general_chat, not thank_you_close
- A "thank you" after design details were confirmed IS thank_you_close
- When in doubt between confirmation and thank_you_close, check if order details were discussed`;

export async function classifyIntent(
  message: string,
  conversationHistory: string,
  pipelineStage?: string,
): Promise<IntentResult> {
  const userInput = `CONVERSATION HISTORY:
${conversationHistory || "(no prior messages)"}

CURRENT PIPELINE STAGE: ${pipelineStage || "unknown"}

LATEST CUSTOMER MESSAGE:
"${message}"

Classify this message now.`;

  try {
    const response = await invokeLLM({
      messages: [
        { role: "system", content: CLASSIFIER_PROMPT },
        { role: "user", content: userInput },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "intent_classification",
          strict: true,
          schema: {
            type: "object",
            properties: {
              intent: {
                type: "string",
                enum: [
                  "design_request", "price_inquiry", "confirmation", "thank_you_close",
                  "objection", "dnc", "question", "complaint", "referral", "reorder",
                  "general_chat", "attachment_only", "soft_decline", "unclear",
                ],
                description: "The classified intent of the customer message",
              },
              confidence: {
                type: "integer",
                description: "Confidence level 0-100",
              },
              reasoning: {
                type: "string",
                description: "1-sentence explanation of why this intent was chosen",
              },
              closingSignal: {
                type: "boolean",
                description: "True if this message indicates deal progression toward closing",
              },
            },
            required: ["intent", "confidence", "reasoning", "closingSignal"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) return fallbackIntent(message);

    const parsed = JSON.parse(content as string);
    return {
      intent: parsed.intent as MessageIntent,
      confidence: Math.max(0, Math.min(100, parsed.confidence || 50)),
      reasoning: parsed.reasoning || "No reasoning provided",
      closingSignal: parsed.closingSignal === true,
      timestamp: Date.now(),
    };
  } catch (err) {
    console.error("[IntentClassifier] LLM error, using keyword fallback:", err);
    return fallbackIntent(message);
  }
}

// ─── Keyword Fallback (no LLM needed) ───────────────────────────────────────

const DNC_KEYWORDS = ["stop", "unsubscribe", "remove", "opt out", "do not contact", "cancel", "take me off"];
const CONFIRMATION_KEYWORDS = ["yes", "yeah", "yep", "correct", "that's right", "sounds good", "perfect", "let's do it", "go ahead"];
const PRICE_KEYWORDS = ["how much", "price", "cost", "quote", "pricing", "rate", "budget"];
const COMPLAINT_KEYWORDS = ["unhappy", "wrong", "terrible", "awful", "never received", "disappointed", "frustrated"];
const SOFT_DECLINE_KEYWORDS = ["not right now", "maybe later", "not interested", "no thanks", "no thank you", "not looking", "went with someone else", "found someone", "not at this time", "pass for now", "we're good", "all set", "already taken care of"];

export function fallbackIntent(message: string): IntentResult {
  const lower = message.toLowerCase().trim();

  if (DNC_KEYWORDS.some(kw => lower.includes(kw))) {
    return { intent: "dnc", confidence: 90, reasoning: "Keyword match: DNC phrase detected", closingSignal: false, timestamp: Date.now() };
  }
  if (COMPLAINT_KEYWORDS.some(kw => lower.includes(kw))) {
    return { intent: "complaint", confidence: 70, reasoning: "Keyword match: complaint phrase detected", closingSignal: false, timestamp: Date.now() };
  }
  if (SOFT_DECLINE_KEYWORDS.some(kw => lower.includes(kw))) {
    return { intent: "soft_decline", confidence: 75, reasoning: "Keyword match: soft decline phrase detected", closingSignal: false, timestamp: Date.now() };
  }
  if (PRICE_KEYWORDS.some(kw => lower.includes(kw))) {
    return { intent: "price_inquiry", confidence: 75, reasoning: "Keyword match: pricing phrase detected", closingSignal: false, timestamp: Date.now() };
  }
  if (lower.match(/^(thank|thanks|thx|ty)\b/i)) {
    return { intent: "general_chat", confidence: 50, reasoning: "Keyword fallback: 'thank you' without context defaults to general_chat", closingSignal: false, timestamp: Date.now() };
  }
  if (CONFIRMATION_KEYWORDS.some(kw => lower === kw || lower.startsWith(kw + " ") || lower.startsWith(kw + "!"))) {
    return { intent: "confirmation", confidence: 65, reasoning: "Keyword match: confirmation phrase detected", closingSignal: false, timestamp: Date.now() };
  }
  if (lower.includes("?")) {
    return { intent: "question", confidence: 55, reasoning: "Keyword fallback: message contains question mark", closingSignal: false, timestamp: Date.now() };
  }

  return { intent: "unclear", confidence: 30, reasoning: "Keyword fallback: no strong signal detected", closingSignal: false, timestamp: Date.now() };
}
