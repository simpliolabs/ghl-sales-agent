/**
 * BRAIN COUNCIL ORCHESTRATOR — Runs all 4 brains in sequence with accountability
 * 
 * This is the ONLY entry point for AI message generation.
 * It replaces the monolithic brain-council.ts with clean module imports.
 * 
 * Flow: Context → Strategist → Researcher → Composer → QC → (Recompose?) → Send/Block
 */

import { addBrainCouncilAudit } from "./db";
import { buildLeadContext } from "./brain-context";
import { runStrategist } from "./strategist";
import { runResearcher, emptyResearch } from "./researcher";
import { runComposer } from "./composer";
import {
  runQC,
  detectViolations,
  buildSafeFallback,
  checkCircuitBreaker,
  updateCircuitBreaker,
  notifyOwnerOfViolation,
} from "./qc";
import type {
  BrainCouncilInput,
  BrainCouncilOutput,
} from "./brain-types";

// Re-export types so callers only need one import
export type { BrainCouncilInput, BrainCouncilOutput } from "./brain-types";

/**
 * Main entry point — runs the full Brain Council pipeline.
 * Called by webhooks (follow-up messages) and auto-correction.
 * NOT called for first-contact (which uses locked template).
 */
export async function runBrainCouncil(input: BrainCouncilInput): Promise<BrainCouncilOutput> {
  console.log(`[BrainCouncil] Starting for lead ${input.leadId} on ${input.channel}`);

  // --- CIRCUIT BREAKER CHECK ---
  const circuitBreaker = await checkCircuitBreaker(input.leadId);
  if (circuitBreaker.tripped) {
    console.log(`[BrainCouncil] CIRCUIT BREAKER TRIPPED for lead ${input.leadId} (${circuitBreaker.consecutiveFailures} consecutive failures). AI paused.`);
    const context = await buildLeadContext(input.leadId);
    const fallbackMsg = buildSafeFallback(context, input);

    await notifyOwnerOfViolation(
      input.leadId,
      context.lead.name || `Lead #${input.leadId}`,
      "safety_violation",
      `Circuit breaker tripped: ${circuitBreaker.consecutiveFailures} consecutive QC failures`,
      "(no message composed — circuit breaker active)",
      0,
      circuitBreaker.consecutiveFailures
    );

    await addBrainCouncilAudit({
      leadId: input.leadId,
      leadName: context.lead.name || undefined,
      channel: input.channel,
      incomingMessage: input.incomingMessage?.substring(0, 2000),
      blocked: 1,
      blockReason: `Circuit breaker: ${circuitBreaker.consecutiveFailures} consecutive failures`,
      violationCategory: "safety_violation",
      ownerNotified: 1,
      fallbackUsed: 1,
      fallbackMessage: fallbackMsg,
      messageSent: 0,
    });

    return {
      message: fallbackMsg,
      fromName: context.lead.assignedAgent || "Abby Bouwer",
      framework: "SAFE_FALLBACK",
      angle: "circuit_breaker",
      extractedDates: [],
      score: 0,
      segment: context.lead.omnisendSegment || "other",
      nextEngagementHours: 168, // 1 week — wait for human review
      qcScore: 0,
      strategyReasoning: "Circuit breaker tripped — AI paused for this lead",
      researchSummary: "",
      blocked: true,
      blockReason: `Circuit breaker: ${circuitBreaker.consecutiveFailures} consecutive failures`,
      violationCategory: "safety_violation",
      fallbackUsed: true,
      fallbackMessage: fallbackMsg,
    };
  }

  // Build shared context once
  const context = await buildLeadContext(input.leadId);
  console.log(`[BrainCouncil] Context built: ${context.convHistory.length} messages, age ${context.leadAgeDays}d, ${context.urgencyStage}`);

  // BRAIN 1: STRATEGIST
  console.log(`[BrainCouncil] Running Strategist...`);
  const strategy = await runStrategist(input, context);
  console.log(`[BrainCouncil] Strategy: ${strategy.approach}/${strategy.framework}/${strategy.angle} (tier ${strategy.personalizationTier})`);

  // BRAIN 2: RESEARCHER (skip for first contact — uses locked template)
  console.log(`[BrainCouncil] Running Researcher...`);
  const research = context.isFirstResponse
    ? emptyResearch()
    : await runResearcher(input, context, strategy);
  console.log(`[BrainCouncil] Research: ${research.summary.substring(0, 100)}...`);

  // BRAIN 3: COMPOSER
  console.log(`[BrainCouncil] Running Composer...`);
  let composed = await runComposer(input, context, strategy, research);
  console.log(`[BrainCouncil] Composed: "${composed.message.substring(0, 80)}..." (${composed.message.length} chars)`);

  // BRAIN 4: QC REVIEWER
  console.log(`[BrainCouncil] Running QC Reviewer...`);
  let qc = await runQC(input, context, strategy, composed);
  console.log(`[BrainCouncil] QC: score=${qc.score}, approved=${qc.approved}, issues=${qc.issues.length}`);

  // --- VIOLATION DETECTION ---
  let violation = detectViolations(composed, qc, strategy, context, input, research);
  let recomposeQcScore = qc.score;
  let wasRecomposed = false;

  // If QC rejected OR violation detected, try ONE recompose
  if ((!qc.approved && qc.score < 50) || violation.category) {
    console.log(`[BrainCouncil] ${violation.category ? `VIOLATION: ${violation.category} — ${violation.reason}` : `QC REJECTED (score ${qc.score})`}. Recomposing...`);
    wasRecomposed = true;
    const recomposeInput = { ...input };
    const feedback = [
      qc.issues.length > 0 ? `QC Issues: ${qc.issues.join("; ")}` : "",
      qc.suggestions.length > 0 ? `QC Suggestions: ${qc.suggestions.join("; ")}` : "",
      violation.category ? `VIOLATION DETECTED (${violation.category}): ${violation.reason}. You MUST fix this.` : "",
    ].filter(Boolean).join("\n");

    recomposeInput.incomingMessage = `${input.incomingMessage}\n\n[QC FEEDBACK — YOUR PREVIOUS MESSAGE HAD ISSUES]\n${feedback}\nFix ALL issues in your rewrite. Reference the lead's ACTUAL form data.`;

    composed = await runComposer(recomposeInput, context, strategy, research);
    const qc2 = await runQC(recomposeInput, context, strategy, composed);
    recomposeQcScore = qc2.score;
    console.log(`[BrainCouncil] Recompose QC: score=${qc2.score}, approved=${qc2.approved}`);

    // Re-check violations on recomposed message
    violation = detectViolations(composed, qc2, strategy, context, input, research);

    if (qc2.revisedMessage) {
      composed.message = qc2.revisedMessage;
    }
    qc = qc2;
  } else if (qc.revisedMessage) {
    composed.message = qc.revisedMessage;
    console.log(`[BrainCouncil] Using QC-revised message`);
  }

  // --- HARD BLOCK DECISION ---
  const shouldBlock = (wasRecomposed && qc.score < 50) || (wasRecomposed && violation.category !== null);
  const fallbackMsg = shouldBlock ? buildSafeFallback(context, input) : undefined;

  if (shouldBlock) {
    console.log(`[BrainCouncil] BLOCKED — ${violation.category || "low_qc_score"}: ${violation.reason || `QC score ${qc.score} after recompose`}`);

    await updateCircuitBreaker(input.leadId, true);
    const updatedBreaker = await checkCircuitBreaker(input.leadId);

    const notified = await notifyOwnerOfViolation(
      input.leadId,
      context.lead.name || `Lead #${input.leadId}`,
      violation.category || "missing_framework",
      violation.reason || `QC score ${qc.score} after recompose`,
      composed.message,
      qc.score,
      updatedBreaker.consecutiveFailures
    );

    await addBrainCouncilAudit({
      leadId: input.leadId,
      leadName: context.lead.name || undefined,
      channel: input.channel,
      incomingMessage: input.incomingMessage?.substring(0, 2000),
      strategyApproach: strategy.approach,
      strategyFramework: strategy.framework,
      strategyReasoning: strategy.reasoning?.substring(0, 2000),
      strategyTier: String(strategy.personalizationTier),
      researchSummary: research.summary?.substring(0, 2000),
      composedMessage: composed.message,
      composerFromName: composed.fromName,
      qcScore: qc.score,
      qcApproved: 0,
      qcIssues: qc.issues.length > 0 ? JSON.stringify(qc.issues) : undefined,
      qcFeedback: qc.suggestions.length > 0 ? JSON.stringify(qc.suggestions) : undefined,
      wasRecomposed: 1,
      recomposeScore: recomposeQcScore,
      finalMessage: fallbackMsg,
      messageSent: 0,
      blocked: 1,
      blockReason: violation.reason || `QC score ${qc.score} after recompose`,
      violationCategory: violation.category || "missing_framework",
      ownerNotified: notified ? 1 : 0,
      fallbackUsed: 1,
      fallbackMessage: fallbackMsg,
    });

    return {
      message: fallbackMsg!,
      fromName: context.lead.assignedAgent || composed.fromName,
      subject: composed.subject || undefined,
      framework: "SAFE_FALLBACK",
      angle: strategy.angle,
      extractedDates: [],
      score: 0,
      segment: context.lead.omnisendSegment || "other",
      nextEngagementHours: strategy.nextEngagementHours,
      qcScore: qc.score,
      strategyReasoning: strategy.reasoning,
      researchSummary: research.summary,
      blocked: true,
      blockReason: violation.reason || `QC score ${qc.score} after recompose`,
      violationCategory: violation.category || "missing_framework",
      fallbackUsed: true,
      fallbackMessage: fallbackMsg,
    };
  }

  // --- MESSAGE APPROVED — reset circuit breaker ---
  await updateCircuitBreaker(input.leadId, false);

  // Score the lead using the sentiment-priority-scorer formula
  const urgencyScore = context.urgencyStage.includes("first") ? 1.0 :
    context.urgencyStage.includes("warm") ? 0.8 :
    context.urgencyStage.includes("cooling") ? 0.6 :
    context.urgencyStage.includes("cold") ? 0.4 :
    context.urgencyStage.includes("stale") ? 0.3 : 0.2;

  const intentScore = (context.lead.opportunityScore || 50) / 100;
  const recencyDays = context.leadAgeDays;
  const recencyScore = recencyDays <= 1 ? 1.0 : recencyDays <= 7 ? 0.7 : recencyDays <= 30 ? 0.4 : 0.1;
  const sentimentRisk = context.state?.sentimentTrend === "negative" ? 0.5 : 0;

  const priorityScore = Math.round(100 * (0.40 * urgencyScore + 0.30 * intentScore + 0.20 * recencyScore + 0.10 * sentimentRisk));

  const segment = context.lead.omnisendSegment || "other";

  // Extract dates from the composed message and incoming message
  const datePattern = /\b(\d{1,2}\/\d{1,2}\/\d{2,4}|\w+ \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?|(?:next|this) (?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/gi;
  const allText = input.incomingMessage + " " + composed.message;
  const extractedDates = Array.from(allText.matchAll(datePattern)).map(m => m[0]);

  // --- AUDIT LOG ---
  try {
    await addBrainCouncilAudit({
      leadId: input.leadId,
      leadName: context.lead.name || undefined,
      channel: input.channel,
      incomingMessage: input.incomingMessage?.substring(0, 2000),
      strategyApproach: strategy.approach,
      strategyFramework: strategy.framework,
      strategyReasoning: strategy.reasoning?.substring(0, 2000),
      strategyTier: String(strategy.personalizationTier),
      researchSummary: research.summary?.substring(0, 2000),
      composedMessage: composed.message,
      composerFromName: composed.fromName,
      qcScore: qc.score,
      qcApproved: qc.approved ? 1 : 0,
      qcIssues: qc.issues.length > 0 ? JSON.stringify(qc.issues) : undefined,
      qcFeedback: qc.suggestions.length > 0 ? JSON.stringify(qc.suggestions) : undefined,
      wasRecomposed: wasRecomposed ? 1 : 0,
      recomposeScore: wasRecomposed ? recomposeQcScore : undefined,
      finalMessage: composed.message,
      messageSent: 1,
      blocked: 0,
      violationCategory: undefined,
      ownerNotified: 0,
      fallbackUsed: 0,
    });
  } catch (auditErr) {
    console.error('[BrainCouncil] Audit log error (non-fatal):', auditErr);
  }

  return {
    message: composed.message,
    fromName: composed.fromName,
    subject: composed.subject || undefined,
    framework: strategy.framework,
    angle: strategy.angle,
    extractedDates,
    score: priorityScore,
    segment,
    nextEngagementHours: strategy.nextEngagementHours,
    qcScore: qc.score,
    strategyReasoning: strategy.reasoning,
    researchSummary: research.summary,
    blocked: false,
    fallbackUsed: false,
  };
}
