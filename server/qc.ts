/**
 * BRAIN 4: QC REVIEWER — Quality control, violation detection, circuit breaker, safe fallback
 */

import { invokeLLM } from "./_core/llm";
import { notifyOwner } from "./_core/notification";
import { addBrainCouncilAudit } from "./db";
import { aiState } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import type {
  BrainCouncilInput,
  StrategyDecision,
  ResearchResult,
  ComposedMessage,
  QCVerdict,
  LeadContext,
  ViolationCategory,
} from "./brain-types";
import { BRAND } from "../shared/brand-assets";

// ============================================================
// QC REVIEWER
// ============================================================

const QC_PROMPT = `You are the QC REVIEWER brain for Adorb Custom Tees' AI outreach system.

You are the LAST LINE OF DEFENSE before a message goes to a real customer. Your job is to catch problems the other brains missed.

=== QUALITY CHECKLIST (score each 0-10, total = quality score) ===

1. REPETITION CHECK (0-10):
   - Does the message start the same way as any prior outbound?
   - Does it repeat questions already asked?
   - Does it repeat information already shared?
   - Score 0 if it starts with the exact same greeting as a prior message.

2. ACKNOWLEDGMENT CHECK (0-10):
   - If the lead said something, does the message acknowledge it?
   - If form data exists, does the message reference what they told us?
   - Score 0 if lead asked a question that goes unanswered.

3. TONE CHECK (0-10):
   - No apologetic language ("sorry to bother", "no worries if not")
   - No easy outs ("if not relevant, no problem")
   - No corporate speak ("I'd love to pick your brain", "hope this finds you well")
   - No desperation ("just checking in", "touching base")
   - Sounds like a real person texting, not a bot.

4. LENGTH CHECK (0-10):
   - SMS: 1-3 sentences. Score 0 if more than 4 sentences.
   - Email: 3-5 sentences. Score 0 if more than 7 sentences.
   - No walls of text. No bullet point dumps.

5. CTA CHECK (0-10):
   - Exactly ONE clear call to action.
   - Score 0 if no CTA or multiple CTAs.

6. ACCURACY CHECK (0-10):
   - No made-up facts about the lead
   - No wrong names or business names
   - Pricing in line with knowledge base (if mentioned)

7. STRATEGY COMPLIANCE (0-10):
   - Does the message follow the strategy directive?
   - Does it use the assigned framework STRUCTURE (not just mention it)?
   - If framework = HORMOZI_ACA + first_contact: Does the message have all 3 parts? (1) Acknowledge something SPECIFIC about the lead, (2) Genuine compliment, (3) One low-friction question. Score 0 if it's a generic "how can I help" or "what can we do for you" response.
   - If form data exists: Does the message reference what the lead already told us? Score 0 if it asks questions the form already answered.
   - Does it stay within the max length?

8. BRAND VOICE (0-10):
   - Sounds like Adorb — warm, direct, confident
   - Uses the right from name
   - Appropriate for the channel

9. FORWARD MOMENTUM (0-10):
   - Does the message move the conversation forward?
   - Does it give the lead a reason to respond?

10. SAFETY CHECK (0-10):
    - No promises we can't keep
    - No binding pricing commitments
    - No inappropriate content
    - No sensitive information leaked

11. EMAIL-SPECIFIC CHECK (0-10, only for email channel):
    (Source: Email Marketing Bible V1.0, 908 sources)
    - Subject line under 25 chars? Personalised? First-person CTA?
    - Body length 50-125 words for cold email, 3-5 sentences for follow-up?
    - Single CTA placed early? Interest-based CTA, not meeting request?
    - No "Hope this finds you well", "Just following up", "Touching base"?
    - Each follow-up adds NEW value vs prior emails?
    - Personal sender name used (not brand name)?
    - Complaint-safe: nothing that could trigger spam complaints?
    - For win-back: follows EMB sequence (miss you → value → breakup)?

12. EMAIL FORMATTING CHECK (0-10, only for email channel — CRITICAL):
    - Does the email use SHORT PUNCHY LINES with blank lines between them? Score 0 if it's one long paragraph.
    - Each thought on its own line? Max ~15 words per line? Score 0 if any line exceeds 25 words.
    - Does it have a SIGNATURE BLOCK? Score 0 if missing. Must include:
      * Agent name + "${BRAND.printingBrand}"
      * Phone number ${BRAND.phone}
      * Email ${BRAND.email}
      * Website ${BRAND.website}
      * Google reviews line (${BRAND.reviewStars} Stars · ${BRAND.reviewCount} Verified Reviews)
    - Does it include a reviews link (${BRAND.websiteReviews})? Score 0 if missing from email signature.
    - Hormozi/Martell style: reads like a text message, not a business letter. Score 0 if it reads like a formal email.
    - NO walls of text. NO run-on sentences. NO compound sentences joined by semicolons.

13. QUESTION-ANSWER CHECK (0-10) — SUBSTANCE:
    - Did the lead ask a DIRECT QUESTION in their last message?
    - If yes: does this response ANSWER that question? Not deflect, not redirect, not ask another question — ANSWER it.
    - Score 0 if a direct question goes unanswered.
    - Score 0 if the response says "let me check" or "I'll get back to you" when the answer is available in the knowledge base.
    - Score 5 if the answer is partial but acknowledges the question.
    - Score 10 if the question is fully answered with specific information.
    - If no question was asked, score 8 (neutral).

14. INFORMATION-ACKNOWLEDGMENT CHECK (0-10) — SUBSTANCE:
    - Did the lead provide SPECIFIC information in their last message? (quantity, product type, timeline, budget, event date, design details)
    - If yes: does this response ACKNOWLEDGE that information without re-asking for it?
    - Score 0 if the message asks for information the lead ALREADY provided.
    - Score 0 if the lead said "I need 50 t-shirts for a church event" and the response asks "What kind of products are you interested in?"
    - Score 5 if the information is partially acknowledged.
    - Score 10 if all provided information is referenced and built upon.
    - If no specific information was provided, score 8 (neutral).

15. GATE 2 — EXTERNAL MESSAGE SAFETY (0-10):
    - Does the message contain ANY internal system language, JSON structures, debug text, or system prompt fragments? Score 0 if yes.
    - Does the message contain phrases like "Brain Council", "QC score", "framework", "approach", "pipeline", "orchestrator", or "violation"? Score 0 if yes.
    - If channel is Email: is there a subject line? Score 0 if missing.
    - Does key information (the reason the lead should care) appear in the first 2 lines? Score 3 if buried.
    - Are there any unresolved placeholder tokens like {name}, {{variable}}, [PLACEHOLDER], or similar template syntax? Score 0 if yes.
    - Does the message reference internal concepts the customer wouldn't understand? Score 0 if yes.

16. FACTUAL VERIFICATION (0-10):
    - For any SPECIFIC factual claim in the message (pricing, product details, URLs, review ratings, turnaround times, minimum quantities):
      * Can it be traced to the knowledge base provided in the context?
      * If a claim cannot be verified against the knowledge base, flag it.
    - Score 10 if all claims are verifiable or no specific claims are made.
    - Score -5 per unverified factual claim (minimum score 0).
    - Common unverifiable claims to watch for: made-up prices, invented turnaround times, fake review counts, URLs not in the knowledge base.
    - Note: general statements like "we have great reviews" are fine; specific claims like "$8 per shirt" or "3-day turnaround" must be in the KB.

=== VERDICT ===
- Score >= 75: APPROVED — send as-is
- Score 50-74: APPROVED WITH EDITS — fix the issues and send your revised version. For emails, you MUST add the signature block if missing.
- Score < 50: REJECTED — do not send, explain why

IMPORTANT: The total quality score is now out of 160 for non-email (16 checks × 10) or 180 for email (18 checks × 10). Normalize to 0-100 scale before reporting.

If you approve with edits, provide the revised message in revisedMessage.
For emails: if the message is missing the signature block or is formatted as one long paragraph, you MUST fix it in revisedMessage even if the content is otherwise good.`;

export async function runQC(
  input: BrainCouncilInput,
  context: LeadContext,
  strategy: StrategyDecision,
  composed: ComposedMessage
): Promise<QCVerdict> {
  const { historyStr } = context;

  const qcInput = `
=== MESSAGE TO REVIEW ===
Channel: ${strategy.channel}
From: ${composed.fromName}
${composed.subject ? `Subject: ${composed.subject}` : ""}
Message: ${composed.message}

=== STRATEGY DIRECTIVE ===
- Approach: ${strategy.approach}
- Framework: ${strategy.framework}
- Angle: ${strategy.angle}
- Max Length: ${strategy.maxLength} chars
- Must Include: ${strategy.keyPoints.join(", ")}
- Must Avoid: ${strategy.avoidPoints.join(", ")}

=== PRIOR CONVERSATION ===
${input.externalHistory ? input.externalHistory + "\n" + historyStr : historyStr || "No previous messages"}

=== FORM DATA ===
${input.formData?.map(f => `- ${f.label}: ${f.value}`).join("\n") || "None"}

=== KNOWLEDGE BASE (for factual verification) ===
${context.kbContent || "No knowledge base content available"}

=== INCOMING MESSAGE BEING RESPONDED TO ===
${input.incomingMessage}

=== FIRST CONTACT SPECIAL RULES ===
If the strategy says approach = first_contact:
- The message MUST be introductory and warm, like meeting someone for the first time.
- It MUST NOT sound like a customer service auto-reply.
- It MUST reference something specific about the lead (not just their name).
- If form data provided product/quantity/timeline, the message MUST acknowledge it.
- Score 0 on Strategy Compliance if the message is generic ("What can we help you with?", "How can I assist you?").
- Score 0 on Acknowledgment if form data exists but isn't referenced.

Review this message now. Be strict but fair.`;

  const response = await invokeLLM({
    messages: [
      { role: "system", content: QC_PROMPT },
      { role: "user", content: qcInput },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "qc_verdict",
        strict: true,
        schema: {
          type: "object",
          properties: {
            approved: { type: "boolean" },
            score: { type: "number", description: "Quality score 0-100" },
            issues: { type: "array", items: { type: "string" }, description: "Issues found" },
            suggestions: { type: "array", items: { type: "string" }, description: "Improvement suggestions" },
            revisedMessage: { type: "string", description: "Revised message if approved with edits, empty string if approved as-is or rejected" },
          },
          required: ["approved", "score", "issues", "suggestions", "revisedMessage"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) return { approved: true, score: 70, issues: [], suggestions: [], revisedMessage: "" };
  return JSON.parse(content as string);
}

// ============================================================
// VIOLATION DETECTION
// ============================================================

export function detectViolations(
  composed: ComposedMessage,
  qc: QCVerdict,
  strategy: StrategyDecision,
  context: LeadContext,
  input: BrainCouncilInput,
  research: ResearchResult
): { category: ViolationCategory | null; reason: string } {
  const msg = composed.message.toLowerCase();
  const leadName = (context.lead.name || "").toLowerCase();
  const businessName = (context.lead.businessName || "").toLowerCase();
  const formLabels = (input.formData || []).map(f => f.value.toLowerCase());

  // 1. WRONG BUSINESS
  if (research.companyInfo && businessName) {
    const researchBiz = research.companyInfo.toLowerCase();
    const formPurpose = input.formData?.find(f =>
      f.label.toLowerCase().includes("bulk printing") || f.label.toLowerCase().includes("purpose")
    )?.value.toLowerCase();
    if (formPurpose && !msg.includes(formPurpose) && researchBiz.length > 10) {
      return { category: "wrong_business", reason: `Message doesn't reference lead's stated purpose (${formPurpose}) but uses research data instead` };
    }
  }

  // 2. FORM DATA IGNORED
  if (input.formData && input.formData.length >= 2) {
    const formValuesMentioned = formLabels.filter(v => v.length > 2 && msg.includes(v));
    if (formValuesMentioned.length === 0) {
      return { category: "form_data_ignored", reason: `Message ignores all form data: ${input.formData.map(f => `${f.label}=${f.value}`).join(", ")}` };
    }
  }

  // 3. GENERIC OPENER
  const genericPatterns = [
    "what can we help you", "how can i help", "how can we assist",
    "what can i do for you", "what can we do for you", "how may i help",
    "what can we create for you", "what are you looking for"
  ];
  if (genericPatterns.some(p => msg.includes(p)) && context.isFirstResponse) {
    return { category: "generic_opener", reason: "First-contact message uses generic opener instead of referencing lead's specific request" };
  }

  // 4. IRRELEVANT RESEARCH
  if (research.summary && research.summary.length > 50) {
    const researchLower = research.summary.toLowerCase();
    if (formLabels.length > 0) {
      const anyFormMatch = formLabels.some(v => v.length > 3 && researchLower.includes(v));
      if (!anyFormMatch && researchLower.length > 100) {
        const researchUsedInMsg = researchLower.split(" ").filter(w => w.length > 5).some(w => msg.includes(w));
        if (researchUsedInMsg) {
          return { category: "irrelevant_research", reason: "Message uses research data that doesn't match any of the lead's form data" };
        }
      }
    }
  }

  // 5. MISSING FRAMEWORK
  if (strategy.framework === "HORMOZI_ACA" && qc.score < 60) {
    const hasAcknowledge = formLabels.some(v => v.length > 2 && msg.includes(v)) || msg.includes(leadName);
    const hasQuestion = msg.includes("?");
    if (!hasAcknowledge || !hasQuestion) {
      return { category: "missing_framework", reason: `HORMOZI_ACA requires Acknowledge+Compliment+Ask but message is missing ${!hasAcknowledge ? "acknowledgment" : "question"}` };
    }
  }

  // 6. SAFETY
  const safetyPatterns = ["guarantee", "money back", "100% free", "no cost ever", "unlimited"];
  if (safetyPatterns.some(p => msg.includes(p))) {
    return { category: "safety_violation", reason: `Message contains potentially unsafe promise: ${safetyPatterns.find(p => msg.includes(p))}` };
  }

  // 7. REPEATED QUESTION — composed message asks something already asked in prior outbound
  if (context.priorOutbound && context.priorOutbound.length > 0) {
    // Extract questions from composed message
    const composedQs = composed.message.match(/[^.!?]*\?/g) || [];
    // Extract questions from prior outbound messages
    const priorQuestions: string[] = [];
    for (const prior of context.priorOutbound) {
      const body = (prior.messageBody || "").toLowerCase();
      const qs = body.match(/[^.!?]*\?/g) || [];
      priorQuestions.push(...qs.map((q: string) => q.trim()));
    }
    // Check for overlap: if any composed question's core words match a prior question
    for (const cq of composedQs) {
      const cqWords = cq.toLowerCase().trim().split(/\s+/).filter(w => w.length > 3);
      if (cqWords.length < 2) continue; // skip very short questions
      for (const pq of priorQuestions) {
        const matchCount = cqWords.filter(w => pq.includes(w)).length;
        if (matchCount >= Math.ceil(cqWords.length * 0.6)) {
          return { category: "repeated_question", reason: `Composed message asks "${cq.trim()}" which overlaps with prior outbound question "${pq.trim()}"` };
        }
      }
    }
  }

  // 8. IGNORED REQUEST — lead asked for pricing/quote but response doesn't address it
  const incomingLower = (input.incomingMessage || "").toLowerCase();
  const pricingKeywords = ["price", "pricing", "quote", "cost", "how much", "rate", "estimate", "budget"];
  const leadAskedForPricing = pricingKeywords.some(k => incomingLower.includes(k));
  if (leadAskedForPricing) {
    const responseAddressesPricing = pricingKeywords.some(k => msg.includes(k)) ||
      /\$\d/.test(composed.message) || // contains dollar amount
      msg.includes("range") || msg.includes("depends on") || msg.includes("starting at") ||
      msg.includes("per shirt") || msg.includes("per piece") || msg.includes("per unit");
    if (!responseAddressesPricing) {
      return { category: "ignored_request", reason: `Lead asked about pricing/quote but response does not contain any pricing information or acknowledgment of the request` };
    }
  }

  // 9. CHANNEL MISMATCH — Reply must stay on same channel as inbound message
  // If the lead sent an inbound message on a specific channel, the reply MUST go back on that channel.
  // This prevents the critical FB→SMS mismatch bug where leads get disconnected replies.
  if (input.channel && strategy.channel && input.channel !== strategy.channel) {
    // Only flag if this is a response to an inbound message (not proactive outreach)
    const isResponding = ["answer_question", "provide_quote", "acknowledge_info", "confirm_details"].includes(strategy.approach);
    if (isResponding) {
      return { category: "channel_mismatch", reason: `Lead messaged on ${input.channel} but strategy chose ${strategy.channel}. Replies MUST stay on the same channel as the inbound message. The lead expects the reply in their ${input.channel} conversation.` };
    }
  }
  // Also flag SMS for highly dormant leads (should use Email for re-engagement)
  if (strategy.channel === "SMS" && context.leadAgeDays > 60) {
    return { category: "channel_mismatch", reason: `Strategy chose SMS for a lead dormant ${context.leadAgeDays} days (>60). Per dormancy rules, Email should be used for re-engagement of highly dormant leads.` };
  }

  // 10. UNFULFILLABLE COMMITMENT — AI makes a promise only a human agent can fulfill
  // e.g., "I'll send the invoice", "I'll call you", "I'll process your order"
  const UNFULFILLABLE_PATTERNS = [
    /i'?ll send (the |an |your |a )?invoice/i,
    /i'?ll send (the |an |your |a )?receipt/i,
    /i'?ll call you/i,
    /i'?ll give you a call/i,
    /i'?ll process (your |the )?order/i,
    /i'?ll ship (your |the )?order/i,
    /i'?ll email you (the |a )?quote/i,
    /i'?ll send (the |a )?mockup/i,
    /i'?ll send (the |a )?proof/i,
    /i'?ll send (the |a )?design/i,
    /sending (the |a )?invoice shortly/i,
    /send (the |a )?invoice (in|within|shortly)/i,
  ];
  const unfulfillableMatch = UNFULFILLABLE_PATTERNS.find(p => p.test(composed.message));
  if (unfulfillableMatch) {
    return { category: "safety_violation", reason: `Message contains an unfulfillable AI commitment: "${composed.message.match(unfulfillableMatch)?.[0]}". AI cannot send invoices, call leads, or process orders — only human agents can. Use "Our team will..." or "I'll have someone..." instead.` };
  }

  return { category: null, reason: "" };
}

// ============================================================
// SAFE FALLBACK TEMPLATE
// ============================================================

export function buildSafeFallback(
  context: LeadContext,
  input: BrainCouncilInput
): string {
  const name = context.lead.name?.split(" ")[0] || "there";
  const agentName = context.lead.assignedAgent || "Abby";

  const productField = input.formData?.find(f =>
    f.label.toLowerCase().includes("product") || f.label.toLowerCase().includes("interested")
  );
  const purposeField = input.formData?.find(f =>
    f.label.toLowerCase().includes("bulk printing") || f.label.toLowerCase().includes("purpose")
  );

  if (productField || purposeField) {
    const product = productField?.value?.toLowerCase() || "custom apparel";
    const purpose = purposeField?.value?.toLowerCase() || "your project";
    return `Hi ${name}, ${agentName} here from Adorb Custom Tees! Thanks for reaching out about ${product} for ${purpose}. We'd love to help — do you have a design ready or would you like our team to help?`;
  }

  return `Hi ${name}, ${agentName} here from Adorb Custom Tees! Thanks for reaching out. What kind of custom apparel project can we help you with?`;
}

// ============================================================
// CIRCUIT BREAKER
// ============================================================

export async function checkCircuitBreaker(leadId: number): Promise<{ tripped: boolean; consecutiveFailures: number }> {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) return { tripped: false, consecutiveFailures: 0 };

  const stateRows = await db.select().from(aiState).where(eq(aiState.leadId, leadId)).limit(1);
  const consecutiveRejects = stateRows[0]?.consecutiveRejects || 0;

  return { tripped: consecutiveRejects >= 3, consecutiveFailures: consecutiveRejects };
}

export async function updateCircuitBreaker(leadId: number, failed: boolean): Promise<void> {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) return;

  const stateRows = await db.select().from(aiState).where(eq(aiState.leadId, leadId)).limit(1);
  if (stateRows[0]) {
    const newCount = failed ? (stateRows[0].consecutiveRejects || 0) + 1 : 0;
    await db.update(aiState).set({ consecutiveRejects: newCount }).where(eq(aiState.leadId, leadId));
  }
}

// ============================================================
// OWNER NOTIFICATION
// ============================================================

export async function notifyOwnerOfViolation(
  leadId: number,
  leadName: string,
  violation: ViolationCategory,
  reason: string,
  composedMessage: string,
  qcScore: number,
  consecutiveFailures: number
): Promise<boolean> {
  const title = consecutiveFailures >= 3
    ? `CIRCUIT BREAKER: AI paused for ${leadName} (Lead #${leadId})`
    : `AI Message BLOCKED for ${leadName} (Lead #${leadId})`;

  const content = [
    `**Violation:** ${violation.replace(/_/g, " ").toUpperCase()}`,
    `**Reason:** ${reason}`,
    `**QC Score:** ${qcScore}/100`,
    `**Blocked Message:** "${composedMessage.substring(0, 200)}${composedMessage.length > 200 ? "..." : ""}"`,
    consecutiveFailures >= 3 ? `\n**AI has failed ${consecutiveFailures} times in a row for this lead. AI engagement is PAUSED until you review.**` : "",
    `\nA safe fallback message was sent instead. Review the Brain Council Audit Log for full details.`,
  ].filter(Boolean).join("\n");

  try {
    return await notifyOwner({ title, content });
  } catch (err) {
    console.error("[QC] Failed to notify owner:", err);
    return false;
  }
}
