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
import { PRICING_MATRIX, ESCALATION_RULES } from "../shared/sales-training";

// ============================================================
// QC REVIEWER
// ============================================================

/** Normalize channel strings for comparison (case-insensitive, alias-aware) */
function normalizeChannelForQC(ch: string): string {
  const lower = ch.toLowerCase().trim();
  if (lower === "fb" || lower === "facebook" || lower === "messenger") return "fb";
  if (lower === "ig" || lower === "instagram") return "ig";
  if (lower === "sms" || lower === "text") return "sms";
  if (lower === "email") return "email";
  if (lower === "whatsapp") return "whatsapp";
  if (lower === "live_chat" || lower === "livechat") return "live_chat";
  return lower;
}

const QC_PROMPT = `You are the QC REVIEWER brain for Adorb Custom Tees' AI outreach system.

You are the LAST LINE OF DEFENSE before a message goes to a real customer. Your job is to catch problems the other brains missed.

=== HARD CONSTRAINTS — AUTO-REJECT RULES (check these FIRST, before scoring) ===

If ANY of these are true, set approved=false immediately. Do not score the rest.

1. REPEATED QUESTION: The message asks for information already asked in a prior outbound.
   Check the conversation history — if we already asked about quantity, print type, sizes,
   colors, timeline, or budget, and this message asks again (even rephrased), REJECT.
   Set violationCategory="repeated_question".

2. COLD INTRO TO WARM LEAD: The message reads like a first contact ("Hi, I'm X from Adorb!")
   but the conversation history shows prior outbound messages exist.
   Set violationCategory="cold_intro_warm_lead".

3. HALLUCINATED FACT: The message states a specific fact (price, quantity, color, date, order
   status) that does NOT appear in the conversation history, form data, or knowledge base.
   Set violationCategory="hallucinated_fact".

4. WRONG NAME OR BUSINESS: The message uses a name or business name that doesn't match
   the lead's actual name or business.
   Set violationCategory="wrong_business".

5. INTERNAL SYSTEM LEAK: The message contains any internal language ("Brain Council",
   "QC score", "framework", "pipeline", "orchestrator", JSON, debug text).
   Set violationCategory="system_leak".

6. PREMATURE BREAKUP: The message contains "close your file", "should I stop",
   "not interested anymore" language but the lead is less than 7 days old OR has
   fewer than 4 unanswered outbound messages.
   Set violationCategory="premature_breakup".

If none of the auto-reject rules trigger, proceed to the quality checklist below.

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
    - CONTEXT-GROUNDING: Does the subject line reference the lead's specific product, business, event, or conversation topic? Score 0 if the subject is generic ("Quick update", "Checking in", "Following up") when specific lead context is available.
    - OPENER GROUNDING: Does the first sentence reference something specific to THIS lead (product type, business name, event, quantity, last conversation topic)? Score 0 if the opener is generic ("your design", "your project", "your order") when more specific context is available.

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

17. POST-CUSTOMER ESCALATION CHECK (0-10, only when pipeline stage = Delivered or approach = post_delivery/reactivation/value_add/relationship_nurture):
    - Does the message contain a SPECIFIC product suggestion (e.g., "matching embroidered hats", "UV-printed mugs", "custom hoodies")? Score 0 if no specific product is mentioned.
    - Does it reference the customer's ORIGINAL order specifically (product type, event, business name)? Score 0 if it uses generic "your order" or "your project".
    - Is the CTA specific and actionable (e.g., "Want me to mock up a hat design?")? Score 0 if it ends with passive "let me know if you need anything".
    - Does it give the customer a REASON to act NOW (seasonal hook, new product, repeat customer benefit)? Score 3 if no urgency or reason.
    - Score 0 if the message is purely passive ("we're here for you", "let me know", "reach out anytime").
    - BANNED phrases: "let me know if you need anything", "we're always here", "whenever you're ready", "don't hesitate to reach out", "here for your next group event".

=== VERDICT ===
- Score >= 75: APPROVED — send as-is
- Score 50-74: APPROVED WITH EDITS — fix the issues and send your revised version. For emails, you MUST add the signature block if missing.
- Score < 50: REJECTED — do not send, explain why

IMPORTANT: The total quality score is now out of 170 for non-email (17 checks × 10) or 190 for email (19 checks × 10). Normalize to 0-100 scale before reporting.

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

=== PRICING MATRIX (verify pricing claims against this) ===
${PRICING_MATRIX}

=== ESCALATION RULES (verify escalation decisions) ===
${ESCALATION_RULES}

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
            violationCategory: { type: "string", description: "If auto-rejected, the violation category from the HARD CONSTRAINTS. Empty string if approved or rejected by score only." },
          },
          required: ["approved", "score", "issues", "suggestions", "revisedMessage", "violationCategory"],
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

  // 5. MISSING FRAMEWORK — HORMOZI_ACA requires Acknowledge + Compliment + Ask
  // Acknowledgment = referencing something SPECIFIC about the lead (not just their name)
  if (strategy.framework === "HORMOZI_ACA" && qc.score < 60) {
    // Build a rich set of acknowledgment tokens from all available context
    const ackTokens: string[] = [];

    // a) Form data values (product type, event name, purpose, etc.)
    for (const f of (input.formData || [])) {
      const fv = f.value.toLowerCase();
      if (fv.length > 2) {
        ackTokens.push(fv);
        fv.split(/\s+/).filter((w: string) => w.length > 2).forEach((w: string) => ackTokens.push(w));
      }
    }

    // b) Business name
    if (businessName && businessName.length > 2) {
      ackTokens.push(businessName);
      businessName.split(/\s+/).filter((w: string) => w.length > 2).forEach((w: string) => ackTokens.push(w));
    }

    // c) Product keywords from conversation history (inbound + outbound)
    const recentMsgs = context.convHistory.slice(-6);
    for (const m of recentMsgs) {
      const body = (m.messageBody || "").toLowerCase();
      const productMentions = body.match(/\b(tee|tees|shirt|shirts|t-shirt|hoodie|hoodies|polo|polos|hat|hats|cap|caps|tote|totes|bag|bags|jacket|jackets|tank|tanks|sweatshirt|embroidery|embroidered|print|printing|custom|jersey|jerseys|uniform|uniforms|banner|banners|sticker|stickers|mug|mugs|pen|pens|notebook|notebooks)\b/g);
      if (productMentions) ackTokens.push(...productMentions);
      // Event/purpose keywords
      const eventMentions = body.match(/\b(reunion|wedding|birthday|party|fundraiser|conference|church|school|team|league|tournament|festival|concert|graduation|anniversary|memorial|charity|gala|banquet|retreat|camp|corporate|company|business|brand|startup|launch|opening|promotion|ministry|nonprofit|event)\b/g);
      if (eventMentions) ackTokens.push(...eventMentions);
    }

    // d) Lead name (counts as acknowledgment when combined with other context, but alone is weak)
    const hasNameMention = leadName.length > 2 && msg.includes(leadName);

    // Check: does the message reference any of the context tokens?
    const hasContextAck = ackTokens.some(token => token.length > 2 && msg.includes(token));
    // Name alone is a weak acknowledgment — only valid if we have NO other context available
    const hasAcknowledge = hasContextAck || (hasNameMention && ackTokens.length === 0);
    const hasQuestion = msg.includes("?");
    if (!hasAcknowledge || !hasQuestion) {
      const missingParts: string[] = [];
      if (!hasAcknowledge) missingParts.push("acknowledgment (must reference lead's business, product, event, or conversation topic)");
      if (!hasQuestion) missingParts.push("question (Ask step)");
      return { category: "missing_framework", reason: `HORMOZI_ACA requires Acknowledge+Compliment+Ask but message is missing: ${missingParts.join("; ")}. Available context: ${ackTokens.slice(0, 5).join(", ") || "none"}` };
    }
  }

  // 6. SAFETY
  const safetyPatterns = ["guarantee", "money back", "100% free", "no cost ever", "unlimited"];
  if (safetyPatterns.some(p => msg.includes(p))) {
    return { category: "safety_violation", reason: `Message contains potentially unsafe promise: ${safetyPatterns.find(p => msg.includes(p))}` };
  }

  // 7a. REPEATED OPENER — composed message starts with EXACTLY the same words as a prior outbound
  // IMPORTANT: "Hey [Name]" is a VALID personalized greeting, NOT a repeated opener.
  // Only flag when the EXACT first 3+ words match a prior message (e.g., "Hey Larry! It's" === "Hey Larry! It's").
  // Greeting someone by name is personalization, not repetition.
  if (context.priorOutbound && context.priorOutbound.length > 0) {
    const composedWords = composed.message.trim().split(/\s+/).map(w => w.toLowerCase());
    // Check first 4 words for exact match (more specific = fewer false positives)
    const composedOpener4 = composedWords.slice(0, 4).join(" ");
    // Also check first 3 words as fallback for short openers
    const composedOpener3 = composedWords.slice(0, 3).join(" ");
    
    for (const prior of context.priorOutbound) {
      const priorWords = (prior.messageBody || "").trim().split(/\s+/).map((w: string) => w.toLowerCase());
      const priorOpener4 = priorWords.slice(0, 4).join(" ");
      const priorOpener3 = priorWords.slice(0, 3).join(" ");
      
      // Exact 4-word opener match — high confidence duplicate
      if (priorOpener4.length > 8 && composedOpener4 === priorOpener4) {
        return { category: "repeated_opener" as ViolationCategory, reason: `Message starts with "${composedOpener4}" which exactly matches a prior outbound opener. Use a different opening.` };
      }
      // Exact 3-word opener match — but ONLY if it's more than just a greeting + name
      // "Hey Larry!" (greeting+name) is NOT a repeat. "Hey Larry! It's" (greeting+name+content) IS.
      // So we require the 3-word opener to NOT be just a greeting pattern
      const isJustGreeting = /^(hey|hi|hello|yo)\s+\S+[!.,]?$/i.test(composedOpener3);
      if (!isJustGreeting && priorOpener3.length > 5 && composedOpener3 === priorOpener3) {
        return { category: "repeated_opener" as ViolationCategory, reason: `Message starts with "${composedOpener3}" which matches a prior outbound opener. Use a different opening.` };
      }
    }
  }

  // 7b. REPEATED QUESTION/ASK — detect when composed message asks for the SAME INFORMATION as prior outbound
  // Uses semantic keyword buckets instead of word-overlap to catch rephrased questions.
  // IMPORTANT: If the lead's inbound message is about the same topic (e.g., they asked a pricing
  // clarification), the AI SHOULD talk about that topic — so we exempt buckets that the inbound
  // message also matches. This prevents false positives where the lead asks "$10-28 canvas or not?"
  // and the AI's answer about pricing/quantity gets blocked as a "repeated question".
  if (context.priorOutbound && context.priorOutbound.length > 0) {
    // Define information-request buckets: if a message contains keywords from a bucket, it's "asking for" that info
    const INFO_BUCKETS: Array<{ name: string; keywords: string[] }> = [
      { name: "quantity", keywords: ["quantity", "how many", "number of", "count", "total", "pieces"] },
      { name: "print_sides", keywords: ["print side", "1 or 2", "one or two", "1-sided", "2-sided", "single side", "double side", "front and back", "front only"] },
      { name: "design", keywords: ["design", "artwork", "logo", "graphic", "layout"] },
      { name: "color", keywords: ["color", "colour", "shade", "navy", "black", "white"] },
      { name: "size", keywords: ["size", "sizing", "small", "medium", "large", "xl", "2xl", "3xl"] },
      { name: "timeline", keywords: ["when do you need", "deadline", "by when", "rush", "turnaround", "how soon"] },
      { name: "budget", keywords: ["budget", "price range", "spending", "afford"] },
      { name: "contact_info", keywords: ["email", "phone", "number", "reach you", "best way to contact"] },
      { name: "event_type", keywords: ["what kind of event", "what type of event", "what event", "planning this for", "occasion", "what are these for"] },
      { name: "purpose", keywords: ["what are you looking for", "what do you need", "interested in", "looking for"] },
    ];
    const matchBuckets = (text: string): Set<string> => {
      const lower = text.toLowerCase();
      const matched = new Set<string>();
      for (const bucket of INFO_BUCKETS) {
        if (bucket.keywords.some(kw => lower.includes(kw))) matched.add(bucket.name);
      }
      return matched;
    };
    const composedBuckets = matchBuckets(composed.message);
    // INBOUND EXEMPTION: When the lead has sent an inbound message, the AI is in RESPONSE mode.
    // The repeated_question bucket check was designed to catch PROACTIVE re-asking of questions
    // the AI already asked. But when the lead is actively engaged and asking questions, the AI
    // SHOULD discuss the same topics — that's what a conversation is.
    //
    // Example: AI asked about pricing/quantity, lead replies "$10-28 canvas or not?" — the AI's
    // response about pricing/quantity is correct, not a repeated question.
    //
    // The QC LLM prompt (checks 1, 13, 14) still catches actual repetition issues like
    // re-asking a question the lead already answered.
    const hasInboundMessage = !!(input.incomingMessage && input.incomingMessage.trim().length > 0);
    if (composedBuckets.size > 0 && !hasInboundMessage) {
      // PROACTIVE outreach only: check for repeated info requests
      const priorAiMessages = context.priorOutbound.filter((p: any) => !p.senderType || p.senderType === "ai");
      for (const prior of priorAiMessages) {
        const priorBuckets = matchBuckets(prior.messageBody || "");
        const overlap = Array.from(composedBuckets).filter(b => priorBuckets.has(b));
        if (overlap.length >= 1) {
          return { category: "repeated_question" as ViolationCategory, reason: `Message asks for the same information (${overlap.join(", ")}) that overlaps with prior outbound question: "${String(prior.messageBody).substring(0, 80)}..."` };
        }
      }
    }
    // Fallback: extract questions (sentences ending with ?) and check word overlap
    // Same inbound exemption: only check during proactive outreach.
    if (!hasInboundMessage) {
      const extractQuestions = (text: string): string[] => {
        return text.split(/[.!?]+/).filter(s => {
          const trimmed = s.trim();
          return /\?$/.test(trimmed) || /^(what|how|when|where|which|can you|do you|are you|would you)/i.test(trimmed);
        }).map(s => s.trim().toLowerCase());
      };
      const composedQuestions = extractQuestions(composed.message);
      if (composedQuestions.length > 0) {
        const priorAiMsgs = context.priorOutbound.filter((p: any) => !p.senderType || p.senderType === "ai");
        for (const prior of priorAiMsgs) {
          const priorQuestions = extractQuestions(prior.messageBody || "");
          for (const cq of composedQuestions) {
            for (const pq of priorQuestions) {
              const stopWords = new Set(["the", "a", "an", "is", "are", "do", "you", "your", "we", "our", "for", "to", "in", "of", "and", "or", "this", "that", "it", "i", "me", "my"]);
              const getWords = (s: string) => s.split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
              const cWords = getWords(cq);
              const pWords = new Set(getWords(pq));
              if (cWords.length >= 2 && pWords.size >= 2) {
                const matchCount = cWords.filter(w => pWords.has(w)).length;
                const overlapRatio = matchCount / Math.min(cWords.length, pWords.size);
                if (overlapRatio >= 0.5) {
                  return { category: "repeated_question" as ViolationCategory, reason: `Question "${cq.substring(0, 60)}" overlaps with prior outbound question: "${pq.substring(0, 60)}"` };
                }
              }
            }
          }
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

  // 9. CHANNEL MISMATCH — Reply should stay on same channel as inbound message
  // If the lead sent an inbound message on a specific channel, the reply SHOULD go back on that channel.
  // However, channel detection from GHL webhooks is unreliable (e.g., FB lead forms arrive as type 11
  // which may be misidentified). So we only flag a hard violation when we're confident the mismatch
  // is real — i.e., the Strategist chose a channel that ALSO doesn't match the lead's preferredChannel.
  if (input.channel && strategy.channel && input.channel !== strategy.channel) {
    const isResponding = ["answer_question", "provide_quote", "acknowledge_info", "confirm_details"].includes(strategy.approach);
    if (isResponding) {
      // If the Strategist's channel matches the lead's preferred channel, trust the Strategist.
      // This handles cases where the inbound channel was misdetected (e.g., FB form → SMS)
      // but the Strategist correctly picked FB based on lead.preferredChannel.
      const leadPreferred = context.lead?.preferredChannel;
      if (leadPreferred && normalizeChannelForQC(strategy.channel) === normalizeChannelForQC(leadPreferred)) {
        // Strategist matches lead preference — likely a webhook channel detection issue, not a real mismatch.
        // Log it but don't block.
        console.log(`[QC] Channel mismatch detected (input=${input.channel} vs strategy=${strategy.channel}) but strategy matches lead.preferredChannel=${leadPreferred} — allowing.`);
      } else {
        return { category: "channel_mismatch", reason: `Lead messaged on ${input.channel} but strategy chose ${strategy.channel}. Replies MUST stay on the same channel as the inbound message. The lead expects the reply in their ${input.channel} conversation.` };
      }
    }
  }
  // Also flag SMS for highly dormant leads (should use Email for re-engagement)
  if (strategy.channel === "SMS" && context.leadAgeDays > 60) {
    return { category: "channel_mismatch", reason: `Strategy chose SMS for a lead dormant ${context.leadAgeDays} days (>60). Per dormancy rules, Email should be used for re-engagement of highly dormant leads.` };
  }

  // 10. CONTEXT-FREE EMAIL SUBJECT — email subject line doesn't reference any lead-specific context
  if (strategy.channel === "Email" && composed.subject) {
    const subjectLower = composed.subject.toLowerCase();
    // Gather available lead context tokens
    const contextTokens: string[] = [];
    // Product type from form data
    const productField = (input.formData || []).find(f =>
      /product|interested|looking for|item/i.test(f.label)
    );
    if (productField) {
      const pv = productField.value.toLowerCase();
      contextTokens.push(pv);
      if (pv.includes("t-shirt") || pv.includes("tee")) contextTokens.push("tee", "tees", "shirt", "shirts", "t-shirt");
      if (pv.includes("hoodie") || pv.includes("hoody")) contextTokens.push("hoodie", "hoodies");
      if (pv.includes("polo")) contextTokens.push("polo", "polos");
      if (pv.includes("hat") || pv.includes("cap")) contextTokens.push("hat", "hats", "cap", "caps");
      if (pv.includes("tote") || pv.includes("bag")) contextTokens.push("tote", "totes", "bag", "bags");
      if (pv.includes("jacket")) contextTokens.push("jacket", "jackets");
      if (pv.includes("tank")) contextTokens.push("tank", "tanks");
      if (pv.includes("sweatshirt")) contextTokens.push("sweatshirt", "sweatshirts");
    }
    // ALL form data values (not just product/purpose — captures event names, company names, etc.)
    for (const f of (input.formData || [])) {
      const fv = f.value.toLowerCase();
      if (fv.length > 2) {
        contextTokens.push(fv);
        // Also add individual words from multi-word values (e.g., "Hughes Reunion" → ["hughes", "reunion"])
        fv.split(/\s+/).filter((w: string) => w.length > 2).forEach((w: string) => contextTokens.push(w));
      }
    }
    // Business name
    if (businessName && businessName.length > 2) {
      contextTokens.push(businessName);
      businessName.split(/\s+/).filter((w: string) => w.length > 2).forEach((w: string) => contextTokens.push(w));
    }
    // Lead name tokens are tracked separately — name alone is personalization, not context.
    // The subject matching ONLY checks contextTokens (product, business, event).
    // Name tokens are used as an additional signal but don't count on their own.
    const nameTokens: string[] = [];
    const leadName = (context.lead.name || "").toLowerCase();
    if (leadName.length > 2) {
      leadName.split(/\s+/).filter((w: string) => w.length > 2).forEach((w: string) => nameTokens.push(w));
    }
    // Conversation topic keywords from last few messages — products AND events/purposes
    const lastInbound = context.convHistory.filter((c: any) => c.direction === "inbound").slice(-3);
    for (const msg of lastInbound) {
      const body = (msg.messageBody || "").toLowerCase();
      const productMentions = body.match(/\b(tee|tees|shirt|shirts|t-shirt|hoodie|hoodies|polo|polos|hat|hats|cap|caps|tote|totes|bag|bags|jacket|jackets|tank|tanks|sweatshirt|embroidery|embroidered|print|printing|custom)\b/g);
      if (productMentions) contextTokens.push(...productMentions);
      // Also extract event/purpose keywords from conversation
      const eventMentions = body.match(/\b(reunion|wedding|birthday|party|fundraiser|conference|church|school|team|league|tournament|festival|concert|graduation|anniversary|memorial|charity|gala|banquet|retreat|camp|corporate|company|business|brand|startup|launch|opening|promotion)\b/g);
      if (eventMentions) contextTokens.push(...eventMentions);
    }
    // Also check outbound messages for context (AI may have mentioned specific topics)
    const lastOutbound = context.convHistory.filter((c: any) => c.direction === "outbound").slice(-2);
    for (const msg of lastOutbound) {
      const body = (msg.messageBody || "").toLowerCase();
      const eventMentions = body.match(/\b(reunion|wedding|birthday|party|fundraiser|conference|church|school|team|league|tournament|festival|concert|graduation|anniversary|memorial|charity|gala|banquet|retreat|camp|corporate|company|business|brand|startup|launch|opening|promotion)\b/g);
      if (eventMentions) contextTokens.push(...eventMentions);
    }

    // Only enforce if we have REAL context tokens (product, business, event — not just the lead's name)
    if (contextTokens.length > 0) {
      const hasContextInSubject = contextTokens.some(token => {
        if (token.length <= 2) return false;
        return subjectLower.includes(token);
      });
      // Also check if a non-first-name part of the lead name appears (e.g., last name = business/family context)
      // But first name alone ("Hey John") doesn't count as context
      const namePartsInSubject = nameTokens.filter(t => t.length > 2 && subjectLower.includes(t));
      const firstNameLower = leadName.split(/\s+/)[0];
      const hasNonFirstNameMatch = namePartsInSubject.some(t => t !== firstNameLower);
      const hasRealContext = hasContextInSubject || hasNonFirstNameMatch;
      if (!hasRealContext) {
        // Also check for banned generic patterns
        const BANNED_SUBJECTS = [
          "quick update", "checking in", "following up", "quick question",
          "just a thought", "touching base", "hey ", "hi ",
          "a little something", "still here", "thinking of you",
          "just wanted to", "circling back"
        ];
        const isGeneric = BANNED_SUBJECTS.some(b => subjectLower.includes(b)) ||
          subjectLower.length < 5 ||
          !subjectLower.match(/[a-z]{3,}/);
        // Flag if subject is generic AND we have specific context available
        if (isGeneric || !hasRealContext) {
          return {
            category: "context_free_subject" as ViolationCategory,
            reason: `Email subject "${composed.subject}" does not reference any lead-specific context. Available context: ${contextTokens.slice(0, 5).join(", ")}. Subject must mention the lead's product, business, event, or conversation topic.`
          };
        }
      }
    }
  }

  // 11. PASSIVE REACTIVATION — delivered/past customer messages must have specific product hooks, not passive "let me know"
  const isDeliveredStage = (context.lead.pipelineStage || "").toLowerCase().includes("delivered");
  const isReactivationApproach = ["post_delivery", "relationship_nurture", "value_add", "seasonal", "reactivation", "win_back"].includes(strategy.approach);
  if (isDeliveredStage || isReactivationApproach) {
    // Check for banned passive phrases
    const PASSIVE_PHRASES = [
      "let me know if you need anything",
      "let me know if you need",
      "we're always here",
      "we are always here",
      "we're here for you",
      "we are here for you",
      "whenever you're ready",
      "whenever you are ready",
      "don't hesitate to reach out",
      "do not hesitate to reach out",
      "feel free to reach out",
      "reach out anytime",
      "here if you need us",
      "here for your next",
      "here whenever you need",
      "always here to help",
      "just let us know",
      "just let me know",
    ];
    const passiveMatch = PASSIVE_PHRASES.find(p => msg.includes(p));
    if (passiveMatch) {
      return {
        category: "passive_reactivation" as ViolationCategory,
        reason: `Message to delivered/past customer contains passive language: "${passiveMatch}". Post-customer messages MUST include a SPECIFIC product suggestion, seasonal hook, or concrete offer — not passive availability. Example fix: "Since you loved those custom tees, have you thought about matching embroidered hats? I can mock one up with your logo."`
      };
    }
    // Also check if the message ends with a generic "if you need anything" pattern
    const lastSentence = composed.message.split(/[.!]/).filter(Boolean).pop()?.trim().toLowerCase() || "";
    if (/if you (need|want) (anything|something|any)/.test(lastSentence) && !/specific|hat|hoodie|polo|mug|tote|jacket|tank|sticker|card|pen|embroidered|printed/.test(lastSentence)) {
      return {
        category: "passive_reactivation" as ViolationCategory,
        reason: `Message to delivered/past customer ends with generic "if you need anything" without a specific product suggestion. The CTA must suggest a CONCRETE product or action.`
      };
    }
  }

  // 12. UNFULFILLABLE COMMITMENT — AI makes a promise only a human agent can fulfill
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

  return { tripped: consecutiveRejects >= 5, consecutiveFailures: consecutiveRejects };
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
