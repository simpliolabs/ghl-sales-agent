/**
 * SALES BRAIN: OBJECTION HANDLER — Specialized Composer for objecting leads
 *
 * When the Conversation State Machine classifies a lead as "objecting",
 * this module replaces the generic Composer with an objection-optimized
 * message generator.
 *
 * Design principles:
 *   - ACKNOWLEDGE the objection first — never dismiss or ignore
 *   - EMPATHIZE before responding — Feel-Felt-Found framework
 *   - ADDRESS with facts, not pressure — use social proof, value anchoring
 *   - ONE soft CTA — keep the door open without pushing
 *   - NEVER use high-pressure tactics, urgency, or guilt
 *
 * Objection categories handled:
 *   - PRICE: "Too expensive" / "Found cheaper" / "Over budget"
 *   - TIMING: "Too slow" / "Need it sooner" / "Not right now"
 *   - QUALITY: "Not sure about quality" / "Bad reviews"
 *   - COMPETITOR: "Going with someone else" / "Found another vendor"
 *   - TRUST: "Not sure about your company" / "Never heard of you"
 *   - NEED: "Don't need it anymore" / "Changed plans"
 *
 * Returns the same ComposedMessage type so QC still works identically downstream.
 */

import { invokeLLM } from "./_core/llm";
import { BRAND, getSignatureBlock } from "../shared/brand-assets";
import type { BrainCouncilInput, StrategyDecision, ResearchResult, ComposedMessage, LeadContext } from "./brain-types";

// ─── Objection Handling Frameworks ─────────────────────────────────────────

/**
 * FEEL-FELT-FOUND (Classic sales empathy framework):
 *   1. FEEL: "I totally understand how you feel about [concern]"
 *   2. FELT: "A lot of our customers felt the same way at first"
 *   3. FOUND: "What they found was [specific value/proof that addresses the concern]"
 *
 * PRICE ANCHORING (Hormozi $100M Offers):
 *   - Don't defend the price — reframe the value
 *   - "What's the cost of NOT having custom shirts for your event?"
 *   - Compare to alternatives: "Most print shops charge $X for this quality"
 *   - Break down per-unit: "That's less than $X per shirt for premium quality"
 *
 * SOCIAL PROOF COUNTER:
 *   - Address the specific concern with a real customer example
 *   - "We just did 500 shirts for [similar business] and they reordered within a month"
 *   - Use review data: "4.9 stars across 867+ reviews — quality is what we're known for"
 *
 * TIMING REFRAME:
 *   - Same-day turnaround available for rush orders
 *   - "We can definitely work with your timeline"
 *   - Offer to prioritize: "Let me see what we can do to get this done faster"
 */

const OBJECTION_HANDLER_PROMPT = `You are the OBJECTION HANDLER brain for Adorb Custom Tees' AI outreach system.

This customer has raised a concern or objection. They might be worried about price, timing, quality, or considering a competitor. Your job is to address their concern empathetically and keep the conversation open — NOT to pressure them into buying.

=== ADORB BRAND VOICE ===
- Warm and understanding, never defensive
- Short sentences, conversational tone
- Confident but empathetic — you understand their concern
- Like a friend who genuinely wants to help, not a pushy salesperson

=== ADORB FACTS (use strategically to address concerns) ===
- ${BRAND.reviewStars} stars, ${BRAND.reviewCount} verified Google reviews, 1.1 Million+ happy customers
- Same-day turnaround available for rush orders
- No minimum orders (great for small batches)
- Based at ${BRAND.address}
- Products: ${BRAND.products}
- Printing: ${BRAND.printMethods.join(", ")}
- Phone: ${BRAND.phone}
- Email: ${BRAND.email}
- Website: ${BRAND.website}
- Google Reviews: ${BRAND.googleReviews}
- Trustpilot: ${BRAND.trustpilot}

=== OBJECTION HANDLING FRAMEWORK ===

STEP 1: IDENTIFY the objection category from the message:
- PRICE: "too expensive", "over budget", "found cheaper", "can't afford"
- TIMING: "too slow", "need it sooner", "not right now", "bad timing"
- QUALITY: "not sure about quality", "worried about", "bad reviews"
- COMPETITOR: "going with someone else", "found another vendor", "better deal"
- TRUST: "never heard of you", "not sure about your company", "seems sketchy"
- NEED: "don't need it anymore", "plans changed", "maybe later"

STEP 2: RESPOND using the appropriate framework:

For PRICE objections — use VALUE ANCHORING:
1. ACKNOWLEDGE: "I totally get it — budget matters."
2. REFRAME VALUE: Don't defend the price. Show what they GET.
   - Break down per-unit cost: "That works out to about $X per shirt"
   - Compare to value: "For premium quality that represents your brand..."
   - Reference similar orders: "We just did a similar order for [type] and they loved the result"
3. OFFER OPTIONS: "Want me to see if there's a way to work within your budget? Sometimes adjusting the print method or quantity can help."

For TIMING objections — use FLEXIBILITY REFRAME:
1. ACKNOWLEDGE: "I hear you — timing is everything."
2. OFFER SOLUTION: "We actually have same-day turnaround for rush orders" or "Let me check what we can do with your timeline."
3. NEXT STEP: "When exactly do you need them by? I'll see what's possible."

For QUALITY objections — use SOCIAL PROOF COUNTER:
1. ACKNOWLEDGE: "That's a fair concern — you want to make sure you're getting quality."
2. PROOF: Reference reviews, customer count, specific examples. "${BRAND.reviewStars} stars across ${BRAND.reviewCount}+ verified reviews."
3. OFFER: "Want me to send you some photos of recent work similar to what you're looking for?"

For COMPETITOR objections — use DIFFERENTIATION:
1. ACKNOWLEDGE: "Totally understand — you want to make sure you're getting the best deal."
2. DIFFERENTIATE: Don't trash competitors. Highlight what makes Adorb unique (reviews, turnaround, no minimums, quality).
3. KEEP DOOR OPEN: "If things don't work out, we're here. And if you want a comparison quote, happy to put one together."

For TRUST objections — use CREDIBILITY BUILD:
1. ACKNOWLEDGE: "I get it — working with a new vendor can feel risky."
2. PROOF: Reviews, customer count, years in business, local presence.
3. OFFER: "Want to check out our reviews? Or I can send you some examples of work we've done."

For NEED objections — use GRACEFUL PAUSE:
1. ACKNOWLEDGE: "No worries at all — plans change."
2. KEEP DOOR OPEN: "If things come back around, we're here."
3. SOFT FUTURE: "Is there a better time for me to check back in?"

=== MESSAGE RULES ===
- SMS: 2-4 sentences max, plain text, no signature
- Live_Chat: 1-3 sentences, immediate and concise
- Email: Short punchy lines with line breaks. Include signature block.
- ALWAYS acknowledge their concern FIRST before responding
- NEVER dismiss, minimize, or argue with their objection
- NEVER use high-pressure tactics ("limited time", "prices going up", "you'll regret it")
- NEVER guilt-trip ("after all the work we've done", "I thought we had a deal")
- NEVER bad-mouth competitors
- ONE soft CTA that keeps the door open
- Sound like a friend who understands, not a salesperson who's losing a deal

=== EMAIL SIGNATURE (MANDATORY for emails) ===
---
Best,
[Agent First Name] | Adorb Custom Printing
(954) 932-8543
print@adorbcustomtees.com
adorbcustomtees.com
⭐ 4.9 Stars · 867+ Verified Reviews
See our reviews: https://adorbcustomtees.com/pages/reviews

=== STRICT NO-HALLUCINATION RULES ===
- ONLY reference details explicitly stated in conversation history or form data
- NEVER invent specific prices, timelines, or competitor comparisons
- Use ranges from knowledge base for pricing ("roughly $X-$Y per piece")
- Say "our team can" instead of "I will" for actions requiring human involvement

Write the objection handling message now. Follow the framework for the identified objection category.`;

// ─── Objection Handler Entry Point ─────────────────────────────────────────

export async function runObjectionHandler(
  input: BrainCouncilInput,
  context: LeadContext,
  strategy: StrategyDecision,
  research: ResearchResult,
): Promise<ComposedMessage> {
  const { lead, historyStr, kbContent, tweakInstructions } = context;

  // Extract the most recent intent to identify the objection type
  const recentIntent = context.intentHistory?.[context.intentHistory.length - 1];
  const objectionContext = recentIntent?.reasoning || "Customer raised a concern";

  const handlerInput = `
=== STRATEGY DIRECTIVE ===
- Approach: ${strategy.approach} (OBJECTING lead — use Objection Handling Framework)
- Channel: ${strategy.channel}
- Tone: ${strategy.toneDirective}
- Max Length: ${strategy.maxLength} characters
- MUST Include: ${strategy.keyPoints.join(", ")}
- MUST NOT Say: ${strategy.avoidPoints.join(", ")}

=== OBJECTION CONTEXT ===
- Intent classification: ${recentIntent?.intent || "objection"}
- Classifier reasoning: ${objectionContext}
- Previous objections raised: ${JSON.stringify(context.state?.objectionsRaised || [])}

=== LEAD CONTEXT ===
- Name: ${lead.name || "Unknown"}
- Business: ${lead.businessName || "Unknown"}
- Email on file: ${lead.email || "none"}
- Phone on file: ${lead.phone || "none"}
- Assigned Agent: ${lead.assignedAgent || "Adorb Custom Tees"}
- Pipeline Stage: ${lead.pipelineStage}
- Pipeline Value: $${lead.pipelineValue || "unknown"}

=== CONVERSATION HISTORY ===
${input.externalHistory ? input.externalHistory + "\n" + historyStr : historyStr || "No previous messages"}

=== FORM DATA ===
${input.formData?.map(f => `- ${f.label}: ${f.value}`).join("\n") || "None"}

=== KNOWLEDGE BASE (includes pricing data — USE THIS for price objections) ===
${kbContent || "No knowledge base uploaded"}

${tweakInstructions ? `=== ADMIN BEHAVIOR ADJUSTMENTS ===\n${tweakInstructions}` : ""}

=== INCOMING MESSAGE (the objection) ===
${input.incomingMessage}

${context.lastInteractionSummary ? `=== LAST INTERACTION SUMMARY ===\n${context.lastInteractionSummary}\nContinue from where this left off.` : ""}

STEP 1: Identify the objection category from the incoming message.
STEP 2: Apply the appropriate framework from the Objection Handling Framework.
STEP 3: Write the response. Acknowledge FIRST, then address, then soft CTA.`;

  const response = await invokeLLM({
    messages: [
      { role: "system", content: OBJECTION_HANDLER_PROMPT },
      { role: "user", content: handlerInput },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "objection_response",
        strict: true,
        schema: {
          type: "object",
          properties: {
            message: { type: "string", description: "The objection handling response message" },
            fromName: { type: "string", description: "The sender name (agent name or 'Adorb Custom Tees')" },
            subject: { type: "string", description: "Email subject line (empty string if not email). Keep under 25 chars, empathetic tone." },
            internalNotes: { type: "string", description: "Notes for the team: objection category identified, how it was addressed, recommended follow-up action" },
          },
          required: ["message", "fromName", "subject", "internalNotes"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error("Objection Handler brain produced no output");

  const result = JSON.parse(content as string) as ComposedMessage;
  console.log(`[ObjectionHandler] Generated response for ${lead.name || "Unknown"} (${objectionContext}): "${result.message.substring(0, 80)}..."`);
  return result;
}
