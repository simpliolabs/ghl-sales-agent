/**
 * SALES BRAIN: CLOSER — Specialized Composer for committed leads
 *
 * When the Conversation State Machine classifies a lead as "committed",
 * this module replaces the generic Composer with a closing-optimized
 * message generator.
 *
 * Design principles:
 *   - NEVER re-pitch or sell to a committed lead
 *   - CONFIRM what they agreed to (echo back details)
 *   - SET NEXT STEPS clearly (proof timeline, payment, delivery)
 *   - WARM & PROFESSIONAL tone — like a friend confirming lunch plans
 *   - Uses Hormozi's "confirmation close" pattern: Confirm → Clarify → Commit to timeline
 *
 * Returns the same ComposedMessage type so QC still works identically downstream.
 */

import { invokeLLM } from "./_core/llm";
import { BRAND, getSignatureBlock } from "../shared/brand-assets";
import type { BrainCouncilInput, StrategyDecision, ResearchResult, ComposedMessage, LeadContext } from "./brain-types";
import { getCloserStageBlock } from "./stage-playbook";
import { getCompactTrainingCorpus } from "../shared/sales-training";

// ─── Closing Frameworks ────────────────────────────────────────────────────

/**
 * HORMOZI CONFIRMATION CLOSE (from $100M Leads):
 * The deal is already done. Your job is to make the customer feel GREAT about their decision
 * and remove any remaining friction.
 *
 * Structure:
 *   1. CONFIRM: Echo back exactly what they agreed to (quantities, design, timeline)
 *   2. CLARIFY: Ask about any missing details needed to proceed (sizes, colors, deadline)
 *   3. COMMIT: State the next concrete step with a timeline ("I'll have the mockup to you by Thursday")
 *
 * Anti-patterns:
 *   - "Are you sure?" / "Just to confirm you want to proceed?" → undermines their decision
 *   - Listing additional products/services → feels like upselling
 *   - Urgency language ("limited time", "act now") → they already said yes
 *   - Apologetic tone → projects uncertainty
 */

const CLOSER_PROMPT = `You are the CLOSER brain for Adorb Custom Tees' AI outreach system.

This customer has ALREADY COMMITTED. They said "yes", "sounds good", "let's do it", "thank you" after discussing their order, or otherwise signaled they want to proceed. Your job is NOT to sell — it's to confirm, clarify, and move the order forward.

=== ADORB BRAND VOICE ===
- Warm and personal, never corporate
- Short sentences, conversational tone
- Confident and organized — you're handling their order
- Like texting a friend who's helping you get custom shirts made

=== ADORB FACTS (use naturally when relevant) ===
- ${BRAND.reviewStars} stars, ${BRAND.reviewCount} verified Google reviews
- Same-day turnaround available
- No minimum orders
- Phone: ${BRAND.phone}
- Email: ${BRAND.email}
- Website: ${BRAND.website}

=== CONFIRMATION CLOSE FRAMEWORK ===

Your message MUST follow this 3-part structure:

1. CONFIRM (1-2 sentences):
   Echo back what they agreed to. Be SPECIFIC — use exact quantities, products, colors, sizes from the conversation.
   "Got it — 50 custom tees in navy with your logo on the front."
   "Perfect — 200 polos for the company retreat, embroidered with your logo."
   If details are vague, confirm what you DO know: "Sounds great — you're looking at custom tees for your church event."

2. CLARIFY (0-1 sentences, only if needed):
   If any critical detail is missing (size breakdown, exact color, deadline, design file), ask ONE specific question.
   "Do you have a size breakdown, or should we go with a standard mix?"
   "What's your deadline for these?"
   If all details are present, SKIP this step entirely.

3. COMMIT (1 sentence):
   State the next concrete step with a timeline.
   "I'll have our designer start on the mockup — you'll see a proof within 24 hours."
   "Our team will put together a detailed quote and send it over today."
   "I'll get this to our production team right away."

=== MESSAGE RULES ===
- SMS: 2-4 sentences max, plain text, no signature
- Live_Chat: 1-3 sentences, immediate and concise
- Email: Short punchy lines with line breaks. Include signature block.
- NEVER re-pitch, upsell, or list additional services
- NEVER use urgency language ("limited time", "act now", "don't miss out")
- NEVER ask "are you sure?" or "just to confirm you want to proceed?"
- NEVER apologize or sound uncertain
- DO echo back their specific details to show you heard them
- DO sound organized and in control of the process
- DO make them feel great about their decision

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
- NEVER invent quantities, sizes, colors, prices, or dates
- If uncertain about a detail, ask rather than assume
- NEVER make commitments about specific timelines unless they're in the knowledge base
- Say "our team will" instead of "I will" for actions requiring human involvement

Write the closing message now. Follow the Confirmation Close Framework precisely.`;

// ─── Closer Entry Point ────────────────────────────────────────────────────

export async function runCloser(
  input: BrainCouncilInput,
  context: LeadContext,
  strategy: StrategyDecision,
  research: ResearchResult,
): Promise<ComposedMessage> {
  const { lead, historyStr, kbContent, tweakInstructions } = context;

  const closerInput = `
=== STRATEGY DIRECTIVE ===
- Approach: ${strategy.approach} (COMMITTED lead — use Confirmation Close Framework)
- Channel: ${strategy.channel}
- Tone: ${strategy.toneDirective}
- Max Length: ${strategy.maxLength} characters
- MUST Include: ${strategy.keyPoints.join(", ")}
- MUST NOT Say: ${strategy.avoidPoints.join(", ")}

=== LEAD CONTEXT ===
- Name: ${lead.name || "Unknown"}
- Business: ${lead.businessName || "Unknown"}
- Email on file: ${lead.email || "none"}
- Phone on file: ${lead.phone || "none"}
- Assigned Agent: ${lead.assignedAgent || "Adorb Custom Tees"}
- Pipeline Stage: ${lead.pipelineStage}

${getCloserStageBlock(lead.pipelineStage)}

=== CONVERSATION HISTORY ===
${input.externalHistory ? input.externalHistory + "\n" + historyStr : historyStr || "No previous messages"}

=== FORM DATA ===
${input.formData?.map(f => `- ${f.label}: ${f.value}`).join("\n") || "None"}

=== KNOWLEDGE BASE ===
${kbContent || "No knowledge base uploaded"}

=== AI SALES TRAINING (pricing, competitive intel, escalation rules) ===
${getCompactTrainingCorpus()}

${tweakInstructions ? `=== ADMIN BEHAVIOR ADJUSTMENTS ===\n${tweakInstructions}` : ""}

=== INCOMING MESSAGE (the commitment signal) ===
${input.incomingMessage}

${context.lastInteractionSummary ? `=== LAST INTERACTION SUMMARY ===\n${context.lastInteractionSummary}\nContinue from where this left off.` : ""}

Write the closing confirmation message now. Remember: they ALREADY said yes. Confirm, clarify if needed, and commit to next steps.`;

  const response = await invokeLLM({
    messages: [
      { role: "system", content: CLOSER_PROMPT },
      { role: "user", content: closerInput },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "closer_message",
        strict: true,
        schema: {
          type: "object",
          properties: {
            message: { type: "string", description: "The closing confirmation message" },
            fromName: { type: "string", description: "The sender name (agent name or 'Adorb Custom Tees')" },
            subject: { type: "string", description: "Email subject line (empty string if not email). Keep under 25 chars, confirmation-oriented." },
            internalNotes: { type: "string", description: "Notes for the team: what was confirmed, what's missing, next action needed" },
          },
          required: ["message", "fromName", "subject", "internalNotes"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error("Closer brain produced no output");

  const result = JSON.parse(content as string) as ComposedMessage;
  console.log(`[Closer] Generated confirmation message for ${lead.name || "Unknown"}: "${result.message.substring(0, 80)}..."`);
  return result;
}
