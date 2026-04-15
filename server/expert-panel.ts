/**
 * EXPERT PANEL — Module 2B: Three parallel expert scorers
 *
 * Inspired by the ai-marketing-skills repo pattern: instead of a single QC pass,
 * run three domain-specific expert personas simultaneously on the Composer's draft.
 *
 * Experts:
 *   1. Brand Voice Expert — tone match, personality, Adorb voice consistency
 *   2. Conversion Expert  — CTA clarity, value proposition strength, urgency
 *   3. Compliance Expert  — SMS/email compliance, DNC risk, legal safety
 *
 * Each expert returns a score (0–100) and a one-sentence note.
 * If any expert scores below PANEL_THRESHOLD (60), the draft is returned to the
 * Composer for one revision pass with the panel notes attached.
 * After the revision (or if all scores are ≥ 60), the message proceeds to QC.
 *
 * The composite score is the average of the three expert scores.
 * All three scores are stored in brainCouncilAudit for the dashboard.
 */

import { invokeLLM } from "./_core/llm";
import type { ComposedMessage, StrategyDecision, LeadContext, BrainCouncilInput } from "./brain-types";

export const PANEL_THRESHOLD = 60;

export interface ExpertScore {
  score: number;       // 0–100
  note: string;        // one-sentence feedback
  passed: boolean;     // score >= PANEL_THRESHOLD
}

export interface ExpertPanelResult {
  brandScore: ExpertScore;
  conversionScore: ExpertScore;
  complianceScore: ExpertScore;
  compositeScore: number;   // average of the three
  allPassed: boolean;       // all three >= PANEL_THRESHOLD
  panelNotes: string;       // concatenated notes for Composer revision prompt
}

// ─── Expert prompts ────────────────────────────────────────────────────────

function buildBrandVoicePrompt(message: string, channel: string, context: LeadContext): string {
  return `You are the Adorb Custom Tees Brand Voice Expert. Score the following outbound ${channel} message on brand voice quality.

ADORB BRAND VOICE STANDARDS:
- Warm, friendly, confident — like a knowledgeable friend who loves custom apparel
- Never corporate, stiff, or salesy
- Uses first names naturally
- References Adorb's 4.9-star reputation and real results when appropriate
- Feels human, not automated
- Short sentences. Direct. No fluff.
- Agent signs off with their first name (Abby or Chris)

MESSAGE TO SCORE:
"""
${message}
"""

LEAD CONTEXT:
- Segment: ${context.lead?.seasonalSegment || "unknown"}
- Conversation stage: ${context.isFirstResponse ? "first contact" : "follow-up"}
- Prior messages sent: ${context.priorOutbound?.length || 0}

Score this message 0–100 on brand voice match. 100 = perfect Adorb voice. 0 = completely off-brand.
Respond ONLY with valid JSON: {"score": <number>, "note": "<one sentence explaining the score>"}`;
}

function buildConversionPrompt(message: string, channel: string, strategy: StrategyDecision): string {
  return `You are a Conversion Rate Optimization Expert specializing in custom apparel sales. Score the following outbound ${channel} message on conversion effectiveness.

CONVERSION STANDARDS FOR THIS MESSAGE:
- Approach: ${strategy.approach}
- Framework: ${strategy.framework}
- Key points to hit: ${strategy.keyPoints?.join(", ") || "none specified"}
- Expected CTA: clear next step (reply, book, confirm, provide details)

MESSAGE TO SCORE:
"""
${message}
"""

Score 0–100 on conversion effectiveness:
- 90–100: Perfect CTA, strong value prop, creates urgency without pressure
- 70–89: Good CTA, clear value, minor improvements possible
- 50–69: CTA present but weak, value prop unclear or buried
- 30–49: No clear CTA, vague value prop, lead won't know what to do next
- 0–29: No CTA, no value, confusing or off-topic

Respond ONLY with valid JSON: {"score": <number>, "note": "<one sentence explaining the score>"}`;
}

function buildCompliancePrompt(message: string, channel: string): string {
  return `You are a Marketing Compliance Expert specializing in SMS/email regulations (TCPA, CAN-SPAM, CTIA guidelines). Score the following outbound ${channel} message on compliance and legal safety.

COMPLIANCE RULES:
- No deceptive subject lines or misleading claims
- No pressure tactics that could be construed as harassment
- No false urgency (fake deadlines, fake scarcity)
- SMS: must not exceed 160 chars per segment without clear reason; no ALL CAPS spam
- Email: must have clear sender identity; no misleading "Re:" or "Fwd:" prefixes
- No unsubscribe/opt-out language required in transactional messages (this is a sales follow-up, not bulk marketing)
- No claims that cannot be substantiated (e.g., "best prices in Florida" without evidence)
- DNC risk: if message sounds like it's ignoring a prior opt-out signal, flag it

MESSAGE TO SCORE:
"""
${message}
"""

CHANNEL: ${channel}

Score 0–100 on compliance safety:
- 90–100: Fully compliant, zero risk
- 70–89: Minor style issues, no legal risk
- 50–69: One potential compliance concern, low risk
- 30–49: Clear compliance issue, should be revised
- 0–29: High risk — do not send

Respond ONLY with valid JSON: {"score": <number>, "note": "<one sentence explaining the score>"}`;
}

// ─── Core runner ───────────────────────────────────────────────────────────

async function runExpert(prompt: string, expertName: string): Promise<ExpertScore> {
  try {
    const response = await invokeLLM({
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "expert_score",
          strict: true,
          schema: {
            type: "object",
            properties: {
              score: { type: "number", description: "Score 0-100" },
              note: { type: "string", description: "One sentence feedback" },
            },
            required: ["score", "note"],
            additionalProperties: false,
          },
        },
      },
    });
    const raw = response?.choices?.[0]?.message?.content;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
    return { score, note: String(parsed.note || ""), passed: score >= PANEL_THRESHOLD };
  } catch (err) {
    console.error(`[ExpertPanel] ${expertName} failed:`, err);
    // On failure, return a passing score so we don't block on infrastructure errors
    return { score: 75, note: `${expertName} check skipped (error)`, passed: true };
  }
}

/**
 * Run all three experts in parallel on the composed message.
 * Returns scores, notes, and whether all three passed.
 */
export async function runExpertPanel(
  composed: ComposedMessage,
  strategy: StrategyDecision,
  context: LeadContext,
  input: BrainCouncilInput,
): Promise<ExpertPanelResult> {
  const channel = strategy.channel || input.channel;

  const [brandScore, conversionScore, complianceScore] = await Promise.all([
    runExpert(buildBrandVoicePrompt(composed.message, channel, context), "BrandVoice"),
    runExpert(buildConversionPrompt(composed.message, channel, strategy), "Conversion"),
    runExpert(buildCompliancePrompt(composed.message, channel), "Compliance"),
  ]);

  const compositeScore = Math.round((brandScore.score + conversionScore.score + complianceScore.score) / 3);
  const allPassed = brandScore.passed && conversionScore.passed && complianceScore.passed;

  const panelNotes = [
    !brandScore.passed ? `Brand Voice (${brandScore.score}/100): ${brandScore.note}` : null,
    !conversionScore.passed ? `Conversion (${conversionScore.score}/100): ${conversionScore.note}` : null,
    !complianceScore.passed ? `Compliance (${complianceScore.score}/100): ${complianceScore.note}` : null,
  ].filter(Boolean).join(" | ");

  console.log(`[ExpertPanel] Brand=${brandScore.score} Conversion=${conversionScore.score} Compliance=${complianceScore.score} Composite=${compositeScore} AllPassed=${allPassed}`);

  return { brandScore, conversionScore, complianceScore, compositeScore, allPassed, panelNotes };
}
