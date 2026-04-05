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
      * Agent name + "Adorb Custom Printing"
      * Phone number (954) 932-8543
      * Email print@adorbcustomtees.com
      * Website adorbcustomtees.com
      * Google reviews line (4.9 Stars · 867+ Verified Reviews)
    - Does it include a Google reviews link? Score 0 if missing from signature.
    - Hormozi/Martell style: reads like a text message, not a business letter. Score 0 if it reads like a formal email.
    - NO walls of text. NO run-on sentences. NO compound sentences joined by semicolons.

=== VERDICT ===
- Score >= 70: APPROVED — send as-is
- Score 50-69: APPROVED WITH EDITS — fix the issues and send your revised version. For emails, you MUST add the signature block if missing.
- Score < 50: REJECTED — do not send, explain why

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
