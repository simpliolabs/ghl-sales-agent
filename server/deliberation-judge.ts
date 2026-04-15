/**
 * Module 4 — Multi-Agent Deliberation (CrewAI pattern)
 *
 * For high-value leads (pipelineValue >= $500 OR opportunityScore >= 85),
 * runs two independent Strategist passes at different temperatures, then
 * a Judge LLM picks the stronger strategy based on a structured rubric.
 *
 * This is NOT called for every lead — only for leads where the stakes are
 * high enough that a second opinion is worth the extra latency (~4-10s).
 */

import { invokeLLM } from "./_core/llm";
import { runStrategist } from "./strategist";
import type { BrainCouncilInput, LeadContext, StrategyDecision } from "./brain-types";

export interface DeliberationResult {
  strategy: StrategyDecision;
  deliberationUsed: boolean;
  deliberationNote: string;
}

/**
 * Determine if a lead qualifies for deliberation.
 */
export function shouldUseDeliberation(lead: {
  pipelineValue?: number | null;
  opportunityScore?: number | null;
}): boolean {
  const value = lead.pipelineValue ?? 0;
  const score = lead.opportunityScore ?? 0;
  return value >= 500 || score >= 85;
}

/**
 * Run two Strategist passes in parallel and let a Judge pick the winner.
 * Falls back to single-pass if the two strategies are identical.
 */
export async function runDeliberation(
  input: BrainCouncilInput,
  context: LeadContext,
): Promise<DeliberationResult> {
  // Run two Strategist passes in parallel with different temperature hints
  // We inject a temperature hint into the input so the Strategist prompt
  // can vary its creativity level.
  const [stratA, stratB] = await Promise.all([
    runStrategist({ ...input, _temperatureHint: "conservative" } as any, context),
    runStrategist({ ...input, _temperatureHint: "creative" } as any, context),
  ]);

  // If both strategies are identical (same framework + approach), skip deliberation
  if (stratA.framework === stratB.framework && stratA.approach === stratB.approach) {
    return {
      strategy: stratA,
      deliberationUsed: false,
      deliberationNote: `Both strategies agreed: ${stratA.framework}/${stratA.approach} — no deliberation needed`,
    };
  }

  // Judge prompt: structured rubric to pick the winning strategy
  const judgePrompt = `You are a Senior Sales Strategy Judge evaluating two competing outreach strategies for the same lead.

LEAD CONTEXT:
- Name: ${context.lead.name || "Unknown"}
- Pipeline Value: $${context.lead.pipelineValue || 0}
- Opportunity Score: ${context.lead.opportunityScore || 0}/100
- Stage: ${context.lead.pipelineStage || "unknown"}
- Days in funnel: ${context.leadAgeDays}
- Conversation history: ${context.historyStr ? context.historyStr.substring(0, 500) : "No prior conversation"}
- Last interaction: ${context.lastInteractionSummary || "None"}

STRATEGY A (Conservative):
- Framework: ${stratA.framework}
- Approach: ${stratA.approach}
- Channel: ${stratA.channel}
- Angle: ${stratA.angle}
- Reasoning: ${stratA.reasoning}

STRATEGY B (Creative):
- Framework: ${stratB.framework}
- Approach: ${stratB.approach}
- Channel: ${stratB.channel}
- Angle: ${stratB.angle}
- Reasoning: ${stratB.reasoning}

SCORING RUBRIC (score each strategy 0-10 on each dimension):
1. Relevance to lead context — does it directly address what we know about this lead?
2. Framework appropriateness — is this the right framework for this stage/situation?
3. Tone match — does the tone fit the lead's communication style and history?
4. DNC risk — how likely is this to trigger an opt-out or negative response?
5. Predicted reply probability — how likely is this to get a response?

Pick the WINNING strategy. Output JSON only:
{
  "winner": "A" or "B",
  "scoreA": { "relevance": 0-10, "framework": 0-10, "tone": 0-10, "dncRisk": 0-10, "replyProb": 0-10 },
  "scoreB": { "relevance": 0-10, "framework": 0-10, "tone": 0-10, "dncRisk": 0-10, "replyProb": 0-10 },
  "note": "one sentence explaining why the winner was chosen"
}`;

  let winner: "A" | "B" = "A";
  let deliberationNote = `Deliberation: Strategy A (${stratA.framework}/${stratA.approach}) vs B (${stratB.framework}/${stratB.approach})`;

  try {
    const judgeResponse = await invokeLLM({
      messages: [
        { role: "system", content: "You are a Senior Sales Strategy Judge. Output JSON only, no markdown." },
        { role: "user", content: judgePrompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "deliberation_result",
          strict: true,
          schema: {
            type: "object",
            properties: {
              winner: { type: "string", enum: ["A", "B"] },
              scoreA: {
                type: "object",
                properties: {
                  relevance: { type: "number" },
                  framework: { type: "number" },
                  tone: { type: "number" },
                  dncRisk: { type: "number" },
                  replyProb: { type: "number" },
                },
                required: ["relevance", "framework", "tone", "dncRisk", "replyProb"],
                additionalProperties: false,
              },
              scoreB: {
                type: "object",
                properties: {
                  relevance: { type: "number" },
                  framework: { type: "number" },
                  tone: { type: "number" },
                  dncRisk: { type: "number" },
                  replyProb: { type: "number" },
                },
                required: ["relevance", "framework", "tone", "dncRisk", "replyProb"],
                additionalProperties: false,
              },
              note: { type: "string" },
            },
            required: ["winner", "scoreA", "scoreB", "note"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = judgeResponse?.choices?.[0]?.message?.content;
    if (content) {
      const parsed = typeof content === "string" ? JSON.parse(content) : content;
      winner = parsed.winner === "B" ? "B" : "A";
      const winningStrat = winner === "A" ? stratA : stratB;
      const losingStrat = winner === "A" ? stratB : stratA;
      const winScore = winner === "A" ? parsed.scoreA : parsed.scoreB;
      const totalWin = (winScore.relevance + winScore.framework + winScore.tone + (10 - winScore.dncRisk) + winScore.replyProb);
      deliberationNote = `[Deliberation] ${winner} wins (${winningStrat.framework}/${winningStrat.approach}) over ${winner === "A" ? "B" : "A"} (${losingStrat.framework}/${losingStrat.approach}) — score ${totalWin}/50. ${parsed.note}`;
    }
  } catch (err) {
    // Judge failed — fall back to Strategy A (conservative)
    console.error("[Deliberation] Judge LLM failed, using Strategy A:", err);
    deliberationNote = `[Deliberation] Judge failed — defaulting to Strategy A (${stratA.framework}/${stratA.approach})`;
    winner = "A";
  }

  const winningStrategy = winner === "A" ? stratA : stratB;

  return {
    strategy: winningStrategy,
    deliberationUsed: true,
    deliberationNote,
  };
}
