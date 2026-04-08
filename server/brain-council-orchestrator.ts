/**
 * BRAIN COUNCIL ORCHESTRATOR — The SINGLE decision-maker for AI messaging
 * 
 * This is the ONLY entry point for AI message generation.
 * ALL send/no-send decisions are made HERE, not in callers.
 * 
 * PRE-FLIGHT CHECKS (before any LLM call):
 *  1. Is AI offline? → abort
 *  2. DB-level send cooldown: was an AI message sent/attempted for this lead in the last 90 seconds? → abort
 *  3. Can we acquire the DB lock for this lead? → abort if locked (another run in progress)
 *  4. Is humanTakeover active for this lead? → abort
 *  4.5. DNC keyword detection: scan last 5 inbound messages for opt-out keywords → auto-flag humanTakeover=1 and abort
 *  5. Did we already respond to this lead's last inbound message? → abort (conversations check)
 * 
 * Only after ALL pre-flight checks pass does the 4-brain pipeline run:
 *  Context → Strategist → Researcher → Composer → QC → (Recompose?) → Return
 * 
 * IMPORTANT: Before returning an approved message, the orchestrator sets
 * `lastAiSendAttemptAt = NOW()` in the DB. This is a DB-level cooldown that
 * survives server restarts and prevents ALL concurrent senders from firing.
 * 
 * Callers are DUMB DISPATCHERS — they just say "this lead needs attention"
 * and the Brain decides everything.
 */

import { addBrainCouncilAudit, acquireDbBrainCouncilLock, releaseDbBrainCouncilLock, isAiOffline, getDb, isChannelDnd, getBlockedChannels, upsertAiState } from "./db";
import { checkDnc } from "./scheduling-engine";
import { handleChannelDnc, detectDncChannel } from "./channel-fallback";
import { conversations, leads, brainCouncilAudit, aiState } from "../drizzle/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { buildLeadContext, invalidateLeadCache } from "./brain-context";
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

// DB-level send cooldown: minimum seconds between AI messages to the same lead
const SEND_COOLDOWN_SECONDS = 90;

// DB lock TTL: how long a Brain Council run can hold the lock before it's considered stale
// Set to 5 minutes to cover worst-case 4-LLM-call pipeline duration
const BRAIN_COUNCIL_LOCK_TTL_SECONDS = 300;

/**
 * Pre-flight abort result — returned when the Brain decides NOT to compose.
 * The `aborted` flag tells callers "I decided not to send, don't retry."
 */
function abortResult(reason: string, leadId: number): BrainCouncilOutput {
  console.log(`[BrainCouncil] ✋ ABORT for lead ${leadId}: ${reason}`);
  return {
    message: "",
    fromName: "",
    framework: "ABORT",
    angle: "none",
    channel: "SMS",
    extractedDates: [],
    score: 0,
    segment: "other",
    nextEngagementHours: 24,
    qcScore: 0,
    strategyReasoning: reason,
    researchSummary: "",
    blocked: true,
    blockReason: reason,
    fallbackUsed: false,
  };
}

/**
 * Main entry point — runs the full Brain Council pipeline.
 * Called by webhooks (follow-up messages), fast scanner, follow-up trigger, and self-review.
 * Called for ALL message types including first-contact (previously used locked template, now uses full pipeline).
 * 
 * ALL callers should treat a `blocked: true` return as "do not send."
 */
export async function runBrainCouncil(input: BrainCouncilInput): Promise<BrainCouncilOutput> {
  console.log(`[BrainCouncil] === START for lead ${input.leadId} on ${input.channel} ===`);

  // ================================================================
  // PRE-FLIGHT CHECK 1: Is AI offline?
  // ================================================================
  try {
    if (await isAiOffline()) {
      return abortResult("AI is OFFLINE — system paused by admin", input.leadId);
    }
  } catch (err) {
    console.error(`[BrainCouncil] isAiOffline check failed:`, err);
    // Fail CLOSED — if we can't check, don't send
    return abortResult("AI offline check failed — blocking as precaution", input.leadId);
  }

  // ================================================================
  // PRE-FLIGHT CHECK 2: DB-level send cooldown
  // Check if an AI message was sent/attempted for this lead recently.
  // This is the STRONGEST duplicate prevention — it's in the DB, survives
  // restarts, and is checked before the lock is even acquired.
  // ================================================================
  try {
    const db = await getDb();
    if (db) {
      const [lead] = await db.select({ lastAiSendAttemptAt: leads.lastAiSendAttemptAt })
        .from(leads)
        .where(eq(leads.id, input.leadId))
        .limit(1);
      if (lead?.lastAiSendAttemptAt) {
        const secondsSinceLastSend = (Date.now() - new Date(lead.lastAiSendAttemptAt).getTime()) / 1000;
        if (secondsSinceLastSend < SEND_COOLDOWN_SECONDS) {
          return abortResult(
            `DB send cooldown: last AI send attempt was ${Math.round(secondsSinceLastSend)}s ago (cooldown: ${SEND_COOLDOWN_SECONDS}s)`,
            input.leadId
          );
        }
      }
    }
  } catch (err) {
    console.error(`[BrainCouncil] DB send cooldown check failed:`, err);
    // Don't abort on check failure — proceed with other checks
  }

  // ================================================================
  // PRE-FLIGHT CHECK 3: Acquire DB lock (prevent concurrent runs)
  // Lock TTL is 5 minutes to cover worst-case pipeline duration.
  // ================================================================
  let lockAcquired = false;
  try {
    lockAcquired = await acquireDbBrainCouncilLock(input.leadId);
    if (!lockAcquired) {
      return abortResult("DB lock not acquired — another Brain Council run is in progress for this lead", input.leadId);
    }
  } catch (err) {
    console.error(`[BrainCouncil] DB lock acquire failed:`, err);
    // Fail CLOSED
    return abortResult("DB lock acquire failed — blocking as precaution", input.leadId);
  }

  // From here on, we MUST release the lock in a finally block
  try {
    // ================================================================
    // PRE-FLIGHT CHECK 4: Is humanTakeover active?
    // ================================================================
    try {
      const db = await getDb();
      if (db) {
        const [lead] = await db.select({ humanTakeover: leads.humanTakeover })
          .from(leads)
          .where(eq(leads.id, input.leadId))
          .limit(1);
        if (lead && lead.humanTakeover) {
          return abortResult("Human takeover is ACTIVE — AI will not send", input.leadId);
        }
      }
    } catch (err) {
      console.error(`[BrainCouncil] humanTakeover check failed:`, err);
      // Don't abort on check failure — proceed with caution
    }

    // ================================================================
    // PRE-FLIGHT CHECK 4.5: DNC keyword detection
    // Scan the lead's last 5 inbound messages for opt-out keywords.
    // If found, auto-flag humanTakeover=1 and abort.
    // This prevents messaging people who explicitly opted out.
    // ================================================================
    try {
      const db2 = await getDb();
      if (db2) {
        const recentInbound = await db2.select({
          messageBody: conversations.messageBody,
          direction: conversations.direction,
          senderType: conversations.senderType,
        })
          .from(conversations)
          .where(and(
            eq(conversations.leadId, input.leadId),
            eq(conversations.direction, "inbound")
          ))
          .orderBy(desc(conversations.timestamp))
          .limit(5);

        if (checkDnc(recentInbound)) {
          // CHANNEL-SPECIFIC DNC: block only the channel the DNC was received on
          const dncChannel = detectDncChannel(input.channel);
          const [leadRow] = await db2.select().from(leads).where(eq(leads.id, input.leadId)).limit(1);
          if (leadRow) {
            const result = await handleChannelDnc(input.leadId, leadRow, dncChannel, leadRow.ghlContactId);
            if (result.action === "not_qualified") {
              // ALL channels exhausted — move to Not Qualified
              await db2.update(leads)
                .set({ humanTakeover: 1, pipelineStage: "not_qualified" })
                .where(eq(leads.id, input.leadId));
              try {
                if (leadRow.ghlOpportunityId && leadRow.ghlPipelineId) {
                  const { updateOpportunityStage } = await import("./ghl");
                  const NQ_STAGES: Record<string, string> = {
                    "OpojlMx3cTa0ts0e2pMc": "6f1ca442-4a6b-490f-bf49-95a5870f7f86",
                    "5YIrCvKmzb27yXHP3fBF": "6ca358e4-db09-4818-9896-ab21bad0c0e7",
                  };
                  const nqStageId = NQ_STAGES[leadRow.ghlPipelineId];
                  if (nqStageId) await updateOpportunityStage(leadRow.ghlOpportunityId, nqStageId);
                }
              } catch { /* best effort GHL update */ }
              console.log(`[BrainCouncil] 🚫 DNC on ${dncChannel} — ALL channels exhausted for lead ${input.leadId} → Not Qualified`);
              return abortResult(`DNC on ${dncChannel} — all channels exhausted. Moved to Not Qualified.`, input.leadId);
            } else {
              // Escalated to another channel — abort this run, follow-up will use new channel
              console.log(`[BrainCouncil] 🔄 DNC on ${dncChannel} — escalated lead ${input.leadId} to ${result.nextChannel}`);
              return abortResult(`DNC on ${dncChannel} — escalated to ${result.nextChannel}. Will follow up on new channel.`, input.leadId);
            }
          } else {
            return abortResult("DNC keyword detected but lead not found in DB", input.leadId);
          }
        }
      }
    } catch (err) {
      console.error(`[BrainCouncil] DNC check failed:`, err);
      // Fail CLOSED for DNC — if we can't check, don't risk messaging an opted-out lead
      return abortResult("DNC check failed — blocking as precaution", input.leadId);
    }

    // ================================================================
    // PRE-FLIGHT CHECK 4.7: Per-channel GHL DND check
    // If the requested channel is DND-blocked in GHL, abort.
    // This prevents wasting 4 LLM calls composing a message that
    // GHL will reject at send time.
    // ================================================================
    try {
      if (await isChannelDnd(input.leadId, input.channel)) {
        const blockedChannels = await getBlockedChannels(input.leadId);
        return abortResult(
          `GHL DND: channel ${input.channel} is blocked for this lead. All blocked channels: ${blockedChannels.join(', ')}`,
          input.leadId
        );
      }
    } catch (err) {
      console.error(`[BrainCouncil] DND channel check failed:`, err);
      // Don't abort on check failure — other gates will catch at send time
    }

    // ================================================================
    // PRE-FLIGHT CHECK 5: Already responded to this lead's last inbound?
    // Check if there's an AI outbound message in the last 90 seconds for this lead.
    // This catches the case where the webhook handler already sent a response
    // and the fast scanner fires for the same inbound message.
    // ================================================================
    try {
      const db = await getDb();
      if (db) {
        const recentAiOutbound = await db.select({ id: conversations.id, timestamp: conversations.timestamp })
          .from(conversations)
          .where(
            and(
              eq(conversations.leadId, input.leadId),
              eq(conversations.senderType, "ai"),
              eq(conversations.direction, "outbound"),
              sql`${conversations.timestamp} > DATE_SUB(NOW(), INTERVAL ${SEND_COOLDOWN_SECONDS} SECOND)`
            )
          )
          .orderBy(desc(conversations.timestamp))
          .limit(1);

        if (recentAiOutbound.length > 0) {
          return abortResult(`Already responded to this lead within ${SEND_COOLDOWN_SECONDS} seconds (msg id: ${recentAiOutbound[0].id})`, input.leadId);
        }
      }
    } catch (err) {
      console.error(`[BrainCouncil] recent-outbound check failed:`, err);
      // Don't abort on check failure — proceed with caution
    }

    // ================================================================
    // ALL PRE-FLIGHT CHECKS PASSED — Run the 4-brain pipeline
    // ================================================================
    console.log(`[BrainCouncil] ✅ All pre-flight checks passed for lead ${input.leadId}. Running pipeline...`);

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
        channel: input.channel,
        extractedDates: [],
        score: 0,
        segment: context.lead.omnisendSegment || "other",
        nextEngagementHours: 168,
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

    // ============================================================
    // HISTORY OVERRIDE: If externalHistory (GHL) contains prior outbound
    // messages, this is NOT a first contact — even if local DB has no AI rows.
    // This prevents the AI from re-initiating contact with leads it has
    // already spoken to via GHL UI or other channels.
    // ============================================================
    if (input.externalHistory && context.isFirstResponse) {
      const externalHasOutbound = /\[agent\//i.test(input.externalHistory) || /\[ai\//i.test(input.externalHistory);
      if (externalHasOutbound) {
        console.log(`[BrainCouncil] ⚠️ isFirstResponse overridden to FALSE — GHL history contains prior outbound messages for lead ${input.leadId}`);
        (context as any).isFirstResponse = false;
      }
    }

    // BRAIN 1: STRATEGIST
    console.log(`[BrainCouncil] Running Strategist...`);
    const strategy = await runStrategist(input, context);
    console.log(`[BrainCouncil] Strategy: ${strategy.approach}/${strategy.framework}/${strategy.angle} (tier ${strategy.personalizationTier})`);

    // ============================================================
    // PROGRAMMATIC PRIOR-CONTACT GUARD
    // If GHL history shows prior outbound messages, NEVER allow
    // first_contact or new_pitch — even if the Strategist chose them.
    // This is a hard programmatic override, not an LLM suggestion.
    // ============================================================
    if (input.externalHistory) {
      const externalHasOutbound = /\[agent\//i.test(input.externalHistory) || /\[ai\//i.test(input.externalHistory);
      if (externalHasOutbound && (strategy.approach === 'first_contact' || strategy.approach === 'new_pitch')) {
        console.log(`[BrainCouncil] 🚨 APPROACH OVERRIDE: Strategist chose '${strategy.approach}' but GHL history shows prior contact. Overriding to 'follow_up'.`);
        (strategy as any).approach = 'follow_up';
        (strategy as any).reasoning = `[PRIOR CONTACT OVERRIDE: ${strategy.approach}\u2192follow_up] ${strategy.reasoning}`;
      }
    }

    // --- PROGRAMMATIC FRAMEWORK DIVERSITY ENFORCEMENT ---
    // If the Strategist picked the same outreach framework as the last 2 messages, override it.
    // Responsive frameworks (DIRECT_RESPONSE, VALUE_FIRST) are exempt — they're context-appropriate.
    const RESPONSIVE_FRAMEWORKS = new Set(["DIRECT_RESPONSE", "VALUE_FIRST"]);
    if (!RESPONSIVE_FRAMEWORKS.has(strategy.framework)) {
      const state = context.state;
      if (state?.lastFrameworkUsed && state.lastFrameworkUsed === strategy.framework) {
        // Count consecutive uses of this framework in recent audit trail
        const dbConn = await getDb();
        let recentAudits: { framework: string | null }[] = [];
        if (dbConn) {
          recentAudits = await dbConn.select({ framework: brainCouncilAudit.strategyFramework })
            .from(brainCouncilAudit)
            .where(eq(brainCouncilAudit.leadId, input.leadId))
            .orderBy(desc(brainCouncilAudit.createdAt))
            .limit(3);
        }
        const consecutiveSame = recentAudits.filter((a: { framework: string | null }) => a.framework === strategy.framework).length;
        if (consecutiveSame >= 2) {
          // Pick a different framework from the same category
          const OUTREACH_FRAMEWORKS = ["PAS", "BAB", "AIDA", "HORMOZI_ACA", "HORMOZI_INDIRECT", "SOCIAL_PROOF", "CASE_STUDY", "SOAP_OPERA"] as const;
          const alternatives = OUTREACH_FRAMEWORKS.filter(f => f !== strategy.framework);
          const override = alternatives[Math.floor(Math.random() * alternatives.length)];
          console.log(`[BrainCouncil] ⚠️ Framework diversity override: ${strategy.framework} used ${consecutiveSame}x consecutively → switching to ${override}`);
          (strategy as any).framework = override;
          (strategy as any).reasoning = `[DIVERSITY OVERRIDE: ${strategy.framework}→${override}] ${strategy.reasoning}`;
        }
      }
    }

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
        channel: strategy.channel,
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

    // ================================================================
    // CRITICAL: Set lastAiSendAttemptAt BEFORE returning the approved message.
    // This is the DB-level cooldown that prevents ALL concurrent senders
    // (webhook, fast scanner, follow-up trigger, self-review) from sending
    // another message to this lead within SEND_COOLDOWN_SECONDS.
    // ================================================================
    try {
      const db = await getDb();
      if (db) {
        await db.update(leads)
          .set({ lastAiSendAttemptAt: new Date() })
          .where(eq(leads.id, input.leadId));
        console.log(`[BrainCouncil] 🔒 Set lastAiSendAttemptAt for lead ${input.leadId} — ${SEND_COOLDOWN_SECONDS}s cooldown active`);
      }
    } catch (err) {
      console.error(`[BrainCouncil] Failed to set lastAiSendAttemptAt (non-fatal):`, err);
    }

    // Score the lead
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

    // Extract dates
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

    // --- CACHE INVALIDATION: Ensure next Brain Council run sees the message we just approved ---
    invalidateLeadCache(input.leadId);

    // --- CROSS-SESSION MEMORY: Write 1-sentence interaction summary ---
    try {
      const summary = `[${strategy.approach}/${strategy.framework}] ${strategy.angle}. Sent via ${strategy.channel}. Key: ${composed.message.substring(0, 150).replace(/\n/g, ' ')}...`;
      await upsertAiState(input.leadId, { lastInteractionSummary: summary.substring(0, 500) });
    } catch (summaryErr) {
      console.error('[BrainCouncil] Interaction summary error (non-fatal):', summaryErr);
    }

    console.log(`[BrainCouncil] === COMPLETE for lead ${input.leadId}: approved, QC=${qc.score} ===`);

    return {
      message: composed.message,
      fromName: composed.fromName,
      subject: composed.subject || undefined,
      framework: strategy.framework,
      angle: strategy.angle,
      channel: strategy.channel,
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
  } finally {
    // ALWAYS release the DB lock, no matter what happened
    if (lockAcquired) {
      await releaseDbBrainCouncilLock(input.leadId);
      console.log(`[BrainCouncil] 🔓 Lock released for lead ${input.leadId}`);
    }
  }
}
