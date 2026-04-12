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

import { addBrainCouncilAudit, acquireDbBrainCouncilLock, releaseDbBrainCouncilLock, isAiOffline, getDb, isChannelDnd, getBlockedChannels, upsertAiState, getRecentOutreachFrameworks } from "./db";
import { checkDnc } from "./scheduling-engine";
import { handleChannelDnc, detectDncChannel } from "./channel-fallback";
import { conversations, leads, brainCouncilAudit, aiState } from "../drizzle/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { buildLeadContext, invalidateLeadCache } from "./brain-context";
import { runStrategist } from "./strategist";
import { runResearcher, emptyResearch } from "./researcher";
import { runComposer } from "./composer";
import { runCloser } from "./closer";
import { runObjectionHandler } from "./objection-handler";
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
  QCVerdict,
  ViolationCategory,
} from "./brain-types";
import { assignVariant } from "./ab-testing";
import { normalizePersona, getPersonaLearningContext } from "./persona-learning";
import { recordViolationLearning, recordReformulationSuccess } from "./learning-loop";
import { computeCadence, normalizeStageName } from "./cadence-engine";
import { recordError, addKnownFix } from "./error-memory";

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
  console.log(`[SalesManager] ✋ ABORT for lead ${leadId}: ${reason}`);
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
// Backward-compatible alias
export const runBrainCouncil = runSalesManager;

export async function runSalesManager(input: BrainCouncilInput): Promise<BrainCouncilOutput> {
  console.log(`[SalesManager] === START for lead ${input.leadId} on ${input.channel} ===`);

  // ================================================================
  // PRE-FLIGHT CHECK 1: Is AI offline?
  // ================================================================
  try {
    if (await isAiOffline()) {
      return abortResult("AI is OFFLINE — system paused by admin", input.leadId);
    }
  } catch (err) {
    console.error(`[SalesManager] isAiOffline check failed:`, err);
    // Fail CLOSED — if we can't check, don't send
    return abortResult("AI offline check failed — blocking as precaution", input.leadId);
  }

  // ================================================================
  // PRE-FLIGHT CHECK 2: DB-level send cooldown
  // Check if an AI message was sent/attempted for this lead recently.
  // This is the STRONGEST duplicate prevention — it's in the DB, survives
  // restarts, and is checked before the lock is even acquired.
  //
  // CRITICAL EXCEPTION: When isInboundReply=true or overrideReason is set,
  // we MUST respond to the lead even if we recently sent a message.
  // The cooldown is for preventing duplicate PROACTIVE outbound, not for
  // blocking responses to leads who are actively messaging us.
  // ================================================================
  const isRecoveryOrInbound = input.isInboundReply || !!input.overrideReason;
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
          if (isRecoveryOrInbound) {
            // For inbound replies: use a much shorter 15-second window to catch true duplicates
            if (secondsSinceLastSend < 15) {
              return abortResult(
                `DB send cooldown (inbound): last AI send was ${Math.round(secondsSinceLastSend)}s ago — true duplicate, skipping`,
                input.leadId
              );
            }
            console.log(`[SalesManager] Bypassing ${SEND_COOLDOWN_SECONDS}s cooldown for lead ${input.leadId} — isInboundReply=${input.isInboundReply}, overrideReason=${!!input.overrideReason}`);
          } else {
            return abortResult(
              `DB send cooldown: last AI send attempt was ${Math.round(secondsSinceLastSend)}s ago (cooldown: ${SEND_COOLDOWN_SECONDS}s)`,
              input.leadId
            );
          }
        }
      }
    }
  } catch (err) {
    console.error(`[SalesManager] DB send cooldown check failed:`, err);
    // Don't abort on check failure — proceed with other checks
  }

  // ================================================================
  // PRE-FLIGHT CHECK 2.5: Daily send cap — max 1 proactive outbound per lead per calendar day
  // Inbound replies and explicit overrides bypass this check.
  // This prevents the follow-up trigger + fast scanner from both firing
  // on the same lead on the same day (e.g. triple-send bug).
  // ================================================================
  if (!isRecoveryOrInbound) {
    try {
      const db = await getDb();
      if (db) {
        const [lead] = await db.select({ lastAiSendAttemptAt: leads.lastAiSendAttemptAt })
          .from(leads)
          .where(eq(leads.id, input.leadId))
          .limit(1);
        if (lead?.lastAiSendAttemptAt) {
          const lastSend = new Date(lead.lastAiSendAttemptAt);
          // Compare calendar dates in Eastern Time (where the business operates)
          const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
          const lastSendET = new Date(lastSend.toLocaleString('en-US', { timeZone: 'America/New_York' }));
          const sameCalendarDay =
            nowET.getFullYear() === lastSendET.getFullYear() &&
            nowET.getMonth() === lastSendET.getMonth() &&
            nowET.getDate() === lastSendET.getDate();
          if (sameCalendarDay) {
            const hoursSinceSend = (Date.now() - lastSend.getTime()) / (1000 * 60 * 60);
            console.log(`[SalesManager] ⛔ Daily cap: lead ${input.leadId} already received a proactive AI message today (${hoursSinceSend.toFixed(1)}h ago). Skipping.`);
            return abortResult(
              `Daily send cap: already sent 1 proactive message today (${lastSend.toISOString()})`,
              input.leadId
            );
          }
        }
      }
    } catch (err) {
      console.error(`[SalesManager] Daily cap check failed (non-fatal):`, err);
      // Don't abort on check failure — proceed
    }
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
    console.error(`[SalesManager] DB lock acquire failed:`, err);
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
      console.error(`[SalesManager] humanTakeover check failed:`, err);
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
                  const { getNqStageId } = await import("../shared/ghl-stages");
                  const nqStageId = getNqStageId(leadRow.ghlPipelineId);
                  if (nqStageId) await updateOpportunityStage(leadRow.ghlOpportunityId, nqStageId);
                }
              } catch { /* best effort GHL update */ }
              console.log(`[SalesManager] 🚫 DNC on ${dncChannel} — ALL channels exhausted for lead ${input.leadId} → Not Qualified`);
              return abortResult(`DNC on ${dncChannel} — all channels exhausted. Moved to Not Qualified.`, input.leadId);
            } else {
              // Escalated to another channel — abort this run, follow-up will use new channel
              console.log(`[SalesManager] 🔄 DNC on ${dncChannel} — escalated lead ${input.leadId} to ${result.nextChannel}`);
              return abortResult(`DNC on ${dncChannel} — escalated to ${result.nextChannel}. Will follow up on new channel.`, input.leadId);
            }
          } else {
            return abortResult("DNC keyword detected but lead not found in DB", input.leadId);
          }
        }
      }
    } catch (err) {
      console.error(`[SalesManager] DNC check failed:`, err);
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
      console.error(`[SalesManager] DND channel check failed:`, err);
      // Don't abort on check failure — other gates will catch at send time
    }

    // ================================================================
    // PRE-FLIGHT CHECK 5: Already responded to this lead's last inbound?
    // Check if there's an AI outbound message in the last 90 seconds for this lead.
    // This catches the case where the webhook handler already sent a response
    // and the fast scanner fires for the same inbound message.
    //
    // EXCEPTION: For inbound replies and recovery scans, we bypass this check
    // because the lead is actively engaged and deserves a response.
    // ================================================================
    if (!isRecoveryOrInbound) {
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
        console.error(`[SalesManager] recent-outbound check failed:`, err);
        // Don't abort on check failure — proceed with caution
      }
    } else {
      console.log(`[SalesManager] Bypassing already-responded check for lead ${input.leadId} — inbound reply or recovery scan`);
    }

    // ================================================================
    // ALL PRE-FLIGHT CHECKS PASSED — Run the 4-brain pipeline
    // ================================================================
    console.log(`[SalesManager] ✅ All pre-flight checks passed for lead ${input.leadId}. Running pipeline...`);

    // --- CIRCUIT BREAKER CHECK ---
    const circuitBreaker = await checkCircuitBreaker(input.leadId);
    if (circuitBreaker.tripped) {
      console.log(`[SalesManager] CIRCUIT BREAKER TRIPPED for lead ${input.leadId} (${circuitBreaker.consecutiveFailures} consecutive failures). Setting humanTakeover=1 to stop the loop.`);
      const context = await buildLeadContext(input.leadId);

      // ─── CORE FIX 1: Set humanTakeover=1 IMMEDIATELY ─────────────────────────
      // Without this, the fast scanner and follow-up trigger keep picking this
      // lead up every 2 minutes, firing a new circuit breaker notification each
      // time. humanTakeover=1 is the only reliable way to stop the loop.
      try {
        const { updateLeadFields } = await import("./db");
        await updateLeadFields(input.leadId, { humanTakeover: 1 });
        console.log(`[SalesManager] ✅ humanTakeover=1 set for lead ${input.leadId} — AI outreach paused until manual review`);
      } catch (htErr) {
        console.error(`[SalesManager] Failed to set humanTakeover (non-fatal):`, htErr);
      }

      // ─── CORE FIX 2: Notification dedup ──────────────────────────────────────
      // Only send ONE circuit breaker email per lead per 24 hours.
      // Check if we already notified the owner about this lead's circuit breaker today.
      let ownerNotified = 0;
      try {
        const db = await getDb();
        if (db) {
          const recentNotifResult = await db.execute(sql`
            SELECT COUNT(*) as cnt FROM brain_council_audit
            WHERE leadId = ${input.leadId}
              AND violationCategory = 'safety_violation'
              AND blockReason LIKE '%Circuit breaker%'
              AND ownerNotified = 1
              AND createdAt > DATE_SUB(NOW(), INTERVAL 24 HOUR)
          `);
          const notifCount = Number(((recentNotifResult as any[])[0] as any[])[0]?.cnt || 0);
          if (notifCount === 0) {
            await notifyOwnerOfViolation(
              input.leadId,
              context.lead.name || `Lead #${input.leadId}`,
              "safety_violation",
              `Circuit breaker tripped: ${circuitBreaker.consecutiveFailures} consecutive QC failures. humanTakeover set — AI paused until manual review.`,
              "(no message composed — circuit breaker active)",
              0,
              circuitBreaker.consecutiveFailures
            );
            ownerNotified = 1;
            console.log(`[SalesManager] 📧 Circuit breaker notification sent for lead ${input.leadId}`);
          } else {
            console.log(`[SalesManager] 🔕 Notification SUPPRESSED for lead ${input.leadId} — already notified ${notifCount}x today (dedup active)`);
          }
        }
      } catch (notifErr) {
        console.error(`[SalesManager] Notification dedup check failed (non-fatal):`, notifErr);
        // Best effort: try to notify anyway
        try {
          await notifyOwnerOfViolation(
            input.leadId,
            context.lead.name || `Lead #${input.leadId}`,
            "safety_violation",
            `Circuit breaker tripped: ${circuitBreaker.consecutiveFailures} consecutive QC failures.`,
            "(no message composed — circuit breaker active)",
            0,
            circuitBreaker.consecutiveFailures
          );
          ownerNotified = 1;
        } catch { /* ignore */ }
      }

      // ─── CORE FIX 3: NEVER send cold-intro fallback to warm leads ────────────
      // If the lead has ANY prior outbound conversation, suppress the fallback.
      // A cold-intro to someone mid-conversation is worse than silence.
      const hasConversationHistory = context.priorOutbound && context.priorOutbound.length > 0;
      if (hasConversationHistory) {
        console.log(`[SalesManager] 🚫 Fallback SUPPRESSED for lead ${input.leadId} — ${context.priorOutbound.length} prior outbound message(s) exist. Cold-intro to warm lead is prohibited.`);
        await addBrainCouncilAudit({
          leadId: input.leadId,
          leadName: context.lead.name || undefined,
          channel: input.channel,
          incomingMessage: input.incomingMessage?.substring(0, 2000),
          blocked: 1,
          blockReason: `Circuit breaker: ${circuitBreaker.consecutiveFailures} consecutive failures [Fallback suppressed — warm lead with ${context.priorOutbound.length} prior messages]`,
          violationCategory: "safety_violation",
          ownerNotified,
          fallbackUsed: 0,
          messageSent: 0,
        });
        return {
          message: "",
          fromName: context.lead.assignedAgent || "Abby Bouwer",
          framework: "CIRCUIT_BREAKER_PAUSED",
          angle: "circuit_breaker",
          channel: input.channel,
          extractedDates: [],
          score: 0,
          segment: context.lead.omnisendSegment || "other",
          nextEngagementHours: 168,
          qcScore: 0,
          strategyReasoning: "Circuit breaker tripped — AI paused, humanTakeover set, fallback suppressed (warm lead with prior conversation)",
          researchSummary: "",
          blocked: true,
          blockReason: `Circuit breaker: ${circuitBreaker.consecutiveFailures} consecutive failures`,
          violationCategory: "safety_violation",
          fallbackUsed: false,
        };
      }

      // Cold lead (no prior conversation) — safe to send the intro fallback once
      const fallbackMsg = buildSafeFallback(context, input);
      await addBrainCouncilAudit({
        leadId: input.leadId,
        leadName: context.lead.name || undefined,
        channel: input.channel,
        incomingMessage: input.incomingMessage?.substring(0, 2000),
        blocked: 1,
        blockReason: `Circuit breaker: ${circuitBreaker.consecutiveFailures} consecutive failures`,
        violationCategory: "safety_violation",
        ownerNotified,
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
    console.log(`[SalesManager] Context built: ${context.convHistory.length} messages, age ${context.leadAgeDays}d, ${context.urgencyStage}`);

    // ============================================================
    // HISTORY OVERRIDE: If externalHistory (GHL) contains prior outbound
    // messages, this is NOT a first contact — even if local DB has no AI rows.
    // This prevents the AI from re-initiating contact with leads it has
    // already spoken to via GHL UI or other channels.
    // ============================================================
    if (input.externalHistory && context.isFirstResponse) {
      const externalHasOutbound = /\[agent\//i.test(input.externalHistory) || /\[ai\//i.test(input.externalHistory);
      if (externalHasOutbound) {
        console.log(`[SalesManager] ⚠️ isFirstResponse overridden to FALSE — GHL history contains prior outbound messages for lead ${input.leadId}`);
        (context as any).isFirstResponse = false;
      }
    }

    // --- PHASE 4: PERSONA & A/B SETUP ---
    const persona = normalizePersona(context.lead.omnisendSegment);
    let experimentAssignment: { experimentId: string; variant: "A" | "B"; config: Record<string, string> } | null = null;
    try {
      experimentAssignment = await assignVariant(
        input.leadId,
        context.lead.omnisendSegment,
        input.channel,
        undefined, // approach not yet known
      );
      if (experimentAssignment) {
        console.log(`[SalesManager] A/B: lead ${input.leadId} → ${experimentAssignment.experimentId} variant ${experimentAssignment.variant}`);
      }
    } catch (err) {
      console.error(`[SalesManager] A/B assignment error (non-fatal):`, err);
    }

    // Inject persona-specific learning context for Strategist
    let personaLearningBlock = "";
    try {
      personaLearningBlock = await getPersonaLearningContext(persona);
    } catch (err) {
      console.error(`[SalesManager] Persona learning error (non-fatal):`, err);
    }
    if (personaLearningBlock) {
      (context as any)._personaLearningBlock = personaLearningBlock;
    }

    // BRAIN 1: STRATEGIST
    console.log(`[SalesManager] Running Strategist...`);
    const strategy = await runStrategist(input, context);
    console.log(`[SalesManager] Strategy: ${strategy.approach}/${strategy.framework}/${strategy.angle} (tier ${strategy.personalizationTier})`);

    // ============================================================
    // PROGRAMMATIC EMB_COLD / BREAKUP MINIMUM DAYS GATE
    // The LLM prompt says "7+ days" but LLMs can ignore soft instructions.
    // This is a hard programmatic override: if the lead is < 7 days old
    // and the strategist chose EMB_COLD or a breakup angle, override to
    // SOAP_OPERA (pattern interrupt) which is appropriate for early-stage.
    // ============================================================
    const BREAKUP_MIN_DAYS = 7;
    const isBreakupFramework = strategy.framework === 'EMB_COLD' || strategy.framework === 'EMB_WINBACK';
    const isBreakupAngle = (strategy.angle || '').toLowerCase().includes('breakup') || (strategy.angle || '').toLowerCase().includes('close_file') || (strategy.angle || '').toLowerCase().includes('give_up');
    if ((isBreakupFramework || isBreakupAngle) && context.leadAgeDays < BREAKUP_MIN_DAYS) {
      console.log(`[SalesManager] ⚠️ EMB_COLD gate: lead ${input.leadId} is only ${context.leadAgeDays}d old (min ${BREAKUP_MIN_DAYS}d for breakup). Overriding ${strategy.framework}/${strategy.angle} → SOAP_OPERA/pattern_interrupt.`);
      (strategy as any).framework = 'SOAP_OPERA';
      (strategy as any).angle = 'pattern_interrupt';
      (strategy as any).reasoning = `[EMB_COLD GATE: lead only ${context.leadAgeDays}d old, breakup requires ${BREAKUP_MIN_DAYS}d] ${strategy.reasoning}`;
    }
    // ============================================================
    // PROGRAMMATIC PRIOR-CONTACT GUARD
    // If GHL history shows prior outbound messages, NEVER allow
    // first_contact or new_pitch — even if the Strategist chose them.
    // This is a hard programmatic override, not an LLM suggestion.
    // ============================================================
    if (input.externalHistory) {
      const externalHasOutbound = /\[agent\//i.test(input.externalHistory) || /\[ai\//i.test(input.externalHistory);
      if (externalHasOutbound && (strategy.approach === 'first_contact' || strategy.approach === 'new_pitch')) {
        console.log(`[SalesManager] 🚨 APPROACH OVERRIDE: Strategist chose '${strategy.approach}' but GHL history shows prior contact. Overriding to 'follow_up'.`);
        (strategy as any).approach = 'follow_up';
        (strategy as any).reasoning = `[PRIOR CONTACT OVERRIDE: ${strategy.approach}\u2192follow_up] ${strategy.reasoning}`;
      }
    }

    // ============================================================
    // GRACEFUL EXIT GUARD — Block sending and retire the lead
    // If the Strategist determines the lead is declining/not interested,
    // do NOT send a goodbye message. Just silently retire the lead.
    // ============================================================
    if (strategy.approach === 'graceful_exit') {
      console.log(`[SalesManager] \u{1F6D1} GRACEFUL EXIT — blocking send for lead ${input.leadId}. Reason: ${strategy.reasoning}`);
      // Set humanTakeover to prevent future automated outreach
      const { updateLeadFields } = await import("./db");
      await updateLeadFields(input.leadId, { humanTakeover: 1 });
      // Log the audit with blocked status
      await addBrainCouncilAudit({
        leadId: input.leadId,
        leadName: context.lead?.name || "Unknown",
        channel: strategy.channel || input.channel,
        incomingMessage: typeof input.incomingMessage === "string" ? input.incomingMessage.substring(0, 2000) : "",
        strategyApproach: strategy.approach,
        strategyFramework: strategy.framework,
        strategyReasoning: `[${strategy.angle}] ${strategy.reasoning}`,
        blocked: 1,
        blockReason: `Graceful exit — lead is declining/not interested. AI outreach retired. Reason: ${strategy.reasoning}`,
        violationCategory: "graceful_exit_retired",
        messageSent: 0,
        ownerNotified: 0,
      });
      return {
        message: "",
        fromName: "System",
        framework: strategy.framework,
        angle: strategy.angle || "none",
        channel: strategy.channel || input.channel,
        extractedDates: [],
        score: 0,
        segment: "other",
        nextEngagementHours: 9999,
        qcScore: 0,
        strategyReasoning: strategy.reasoning,
        researchSummary: "",
        blocked: true,
        blockReason: `Graceful exit — lead retired from automated outreach`,
        fallbackUsed: false,
      };
    }

    // ============================================================
    // PHASE B: CONVERSATION STATE ROUTING
    // Override Strategist approach based on conversation state machine.
    // This ensures committed leads aren't re-pitched and objecting leads
    // get proper objection handling instead of generic follow-up.
    // ============================================================
    if (context.convState) {
      const convState = context.convState;
      if (convState === "committed" && strategy.approach !== "confirm_details" && strategy.approach !== "acknowledge_info") {
        console.log(`[SalesManager] 🎯 CONV STATE OVERRIDE: Lead is COMMITTED — overriding '${strategy.approach}' → 'confirm_details'`);
        (strategy as any).approach = "confirm_details";
        (strategy as any).framework = "DIRECT_RESPONSE";
        (strategy as any).angle = "Confirm order details and next steps — customer has already committed";
        (strategy as any).reasoning = `[COMMITTED STATE OVERRIDE] ${strategy.reasoning}`;
        (strategy as any).avoidPoints = [...(strategy.avoidPoints || []), "Do NOT re-pitch or sell", "Do NOT ask if they're interested", "Do NOT use urgency tactics"];
      } else if (convState === "objecting" && strategy.approach !== "answer_question") {
        console.log(`[SalesManager] 🎯 CONV STATE OVERRIDE: Lead is OBJECTING — overriding '${strategy.approach}' → 'answer_question'`);
        (strategy as any).approach = "answer_question";
        (strategy as any).framework = "DIRECT_RESPONSE";
        (strategy as any).angle = "Address the customer's specific concern directly and empathetically";
        (strategy as any).reasoning = `[OBJECTING STATE OVERRIDE] ${strategy.reasoning}`;
        (strategy as any).avoidPoints = [...(strategy.avoidPoints || []), "Do NOT ignore their concern", "Do NOT push harder", "Do NOT use high-pressure tactics"];
      } else if (convState === "fulfilled" && strategy.approach !== "post_delivery" && strategy.approach !== "relationship_nurture") {
        console.log(`[SalesManager] 🎯 CONV STATE OVERRIDE: Lead is FULFILLED — overriding '${strategy.approach}' → 'post_delivery'`);
        (strategy as any).approach = "post_delivery";
        (strategy as any).reasoning = `[FULFILLED STATE OVERRIDE] ${strategy.reasoning}`;
      }
    }

    // --- PHASE 4: A/B VARIANT OVERRIDE ---
    // If an experiment is active and its config overrides framework/approach, apply it
    if (experimentAssignment) {
      const cfg = experimentAssignment.config;
      if (cfg.framework && cfg.framework !== strategy.framework) {
        console.log(`[SalesManager] A/B override: framework ${strategy.framework} → ${cfg.framework} (experiment ${experimentAssignment.experimentId} variant ${experimentAssignment.variant})`);
        (strategy as any).framework = cfg.framework;
        (strategy as any).reasoning = `[A/B TEST: variant ${experimentAssignment.variant}] ${strategy.reasoning}`;
      }
      if (cfg.approach && cfg.approach !== strategy.approach) {
        console.log(`[SalesManager] A/B override: approach ${strategy.approach} → ${cfg.approach}`);
        (strategy as any).approach = cfg.approach;
      }
      if (cfg.toneDirective) {
        (strategy as any).toneDirective = cfg.toneDirective;
      }
      if (cfg.maxLength) {
        (strategy as any).maxLength = parseInt(cfg.maxLength);
      }
    }

    // --- PROGRAMMATIC FRAMEWORK DIVERSITY ENFORCEMENT ---
    // Checks the last 5 OUTREACH frameworks (ignoring DIRECT_RESPONSE/VALUE_FIRST which are
    // context-appropriate responsive frameworks). If the current framework was used 2+ times
    // in the last 5 outreach messages, override to a different framework.
    // FIX: Previously relied on lastFrameworkUsed from ai_state which gets reset by DIRECT_RESPONSE
    // responses — now reads directly from audit trail, filtering out responsive frameworks.
    const RESPONSIVE_FRAMEWORKS = new Set(["DIRECT_RESPONSE", "VALUE_FIRST"]);
    if (!RESPONSIVE_FRAMEWORKS.has(strategy.framework)) {
      try {
        const recentOutreachFrameworks = await getRecentOutreachFrameworks(input.leadId, 5);
        const usageCount = recentOutreachFrameworks.filter(f => f === strategy.framework).length;
        if (usageCount >= 2) {
          // Build a weighted pool: prefer frameworks NOT in recent history
          const ALL_OUTREACH_FRAMEWORKS = ["PAS", "BAB", "AIDA", "HORMOZI_ACA", "HORMOZI_INDIRECT", "SOCIAL_PROOF", "CASE_STUDY", "SOAP_OPERA", "CURIOSITY_HOOK"] as const;
          const recentSet = new Set(recentOutreachFrameworks);
          // Prefer frameworks not used recently
          const freshAlternatives = ALL_OUTREACH_FRAMEWORKS.filter(f => f !== strategy.framework && !recentSet.has(f));
          const anyAlternatives = ALL_OUTREACH_FRAMEWORKS.filter(f => f !== strategy.framework);
          const pool = freshAlternatives.length > 0 ? freshAlternatives : anyAlternatives;
          const override = pool[Math.floor(Math.random() * pool.length)];
          console.log(`[SalesManager] ⚠️ Framework diversity override: ${strategy.framework} used ${usageCount}x in last 5 outreach → switching to ${override} (recent: ${recentOutreachFrameworks.slice(0,5).join(',')})`);
          (strategy as any).framework = override;
          (strategy as any).reasoning = `[DIVERSITY OVERRIDE: ${strategy.framework}→${override} (used ${usageCount}/5)] ${strategy.reasoning}`;
        }
      } catch (diversityErr) {
        console.error('[SalesManager] Diversity check error (non-fatal):', diversityErr);
      }
    }

    // ============================================================
    // CADENCE ENGINE — Deterministic timing override
    // The Strategist suggests nextEngagementHours, but the Cadence Engine
    // has the final say. It clamps to the stage-appropriate range and
    // applies progressive backoff for unanswered leads.
    // ============================================================
    try {
      const cadenceInput = {
        pipelineStage: normalizeStageName(context.lead.pipelineStageName || context.lead.pipelineStage),
        lastAiSendAt: context.lead.lastAiSendAttemptAt ? new Date(context.lead.lastAiSendAttemptAt) : null,
        leadCreatedAt: new Date(context.lead.createdAt || Date.now()),
        unansweredCount: context.unansweredCount || 0,
        isInboundReply: !!input.isInboundReply,
        strategistSuggestedHours: strategy.nextEngagementHours,
      };
      const cadence = computeCadence(cadenceInput);
      if (cadence.wasOverridden) {
        console.log(`[SalesManager] ⏱️ Cadence Engine override: Strategist suggested ${strategy.nextEngagementHours}h → clamped to ${cadence.hoursUntilSend.toFixed(1)}h (${cadence.reason})`);
      }
      (strategy as any).nextEngagementHours = Math.max(Math.round(cadence.hoursUntilSend), 24);
      console.log(`[SalesManager] Cadence: nextEngagementHours=${strategy.nextEngagementHours}h, canSendNow=${cadence.canSendNow}, reason=${cadence.reason}`);
    } catch (cadenceErr) {
      console.error(`[SalesManager] Cadence Engine error (non-fatal):`, cadenceErr);
      // Fallback: ensure minimum 24h
      if (strategy.nextEngagementHours < 24) {
        (strategy as any).nextEngagementHours = 24;
      }
    }

    // BRAIN 2: RESEARCHER (skip for first contact — uses locked template)
    console.log(`[SalesManager] Running Researcher...`);
    const research = context.isFirstResponse
      ? emptyResearch()
      : await runResearcher(input, context, strategy);
    console.log(`[SalesManager] Research: ${research.summary.substring(0, 100)}...`);

    // BRAIN 3: COMPOSER (or specialized Sales Brain based on convState)
    let composed;
    const useCloser = context.convState === "committed";
    const useObjectionHandler = context.convState === "objecting";

    if (useCloser) {
      console.log(`[SalesManager] Running CLOSER (committed lead)...`);
      composed = await runCloser(input, context, strategy, research);
      console.log(`[SalesManager] Closer: "${composed.message.substring(0, 80)}..." (${composed.message.length} chars)`);
    } else if (useObjectionHandler) {
      console.log(`[SalesManager] Running OBJECTION HANDLER (objecting lead)...`);
      composed = await runObjectionHandler(input, context, strategy, research);
      console.log(`[SalesManager] ObjectionHandler: "${composed.message.substring(0, 80)}..." (${composed.message.length} chars)`);
    } else {
      console.log(`[SalesManager] Running Composer...`);
      composed = await runComposer(input, context, strategy, research);
      console.log(`[SalesManager] Composed: "${composed.message.substring(0, 80)}..." (${composed.message.length} chars)`);
    }

    // ============================================================
    // DETERMINISTIC VIOLATION CHECK — runs BEFORE LLM QC call
    // Hard rules are deterministic code. They don't need LLM confirmation.
    // If a hard rule fires, we skip the expensive LLM QC call entirely.
    // This saves ~2-4 seconds per blocked message and ensures hard rules
    // are never overridden by an LLM that "thinks" the message is fine.
    // ============================================================
    console.log(`[SalesManager] Running deterministic violation checks...`);
    // For the pre-LLM check, pass a dummy QC verdict (score 0, not approved)
    // since we haven't run the LLM yet. detectViolations uses qc.score only
    // for the HORMOZI_ACA missing_framework check, so we set it to 0 (< 60).
    const dummyQcForPreCheck: QCVerdict = { approved: false, score: 0, issues: [], suggestions: [], revisedMessage: "" };
    const preViolation = detectViolations(composed, dummyQcForPreCheck, strategy, context, input, research);

    let qc: QCVerdict;
    let violation: { category: ViolationCategory | null; reason: string };

    if (preViolation.category) {
      // Hard rule fired — skip LLM QC entirely
      console.log(`[SalesManager] ⚡ Deterministic violation detected: ${preViolation.category} — skipping LLM QC call`);
      qc = { approved: false, score: 0, issues: [preViolation.reason], suggestions: [], revisedMessage: "" };
      violation = preViolation;
    } else {
      // No hard rule violation — run LLM QC for quality scoring
      console.log(`[SalesManager] Running QC Reviewer (LLM)...`);
      qc = await runQC(input, context, strategy, composed);
      console.log(`[SalesManager] QC: score=${qc.score}, approved=${qc.approved}, issues=${qc.issues.length}`);
      // Re-run detectViolations with real QC score (some checks like HORMOZI_ACA use qc.score < 60)
      violation = detectViolations(composed, qc, strategy, context, input, research);
    }

    // Apply QC revised message if approved with minor edits and no violations
    if (!violation.category && qc.approved && qc.revisedMessage) {
      composed.message = qc.revisedMessage;
      console.log(`[SalesManager] Using QC-revised message`);
    }

    // Also check QC LLM's violationCategory if deterministic checks didn't catch anything
    const qcViolationCategory = (qc as any).violationCategory;
    const hasQcLlmViolation = qcViolationCategory && qcViolationCategory.length > 0 && !qc.approved;

    // --- BLOCK DECISION ---
    // Block if: (1) deterministic violation detected, OR (2) QC LLM rejected with violation, OR (3) QC score < 50
    const shouldBlock = violation.category !== null || hasQcLlmViolation || (!qc.approved && qc.score < 50);
    const effectiveViolationCategory = violation.category || (hasQcLlmViolation ? qcViolationCategory : null);
    const effectiveViolationReason = violation.reason || (hasQcLlmViolation ? `QC LLM violation: ${qcViolationCategory}` : `QC score ${qc.score}`);
    const fallbackMsg = shouldBlock ? buildSafeFallback(context, input) : undefined;

    if (shouldBlock) {
      // --- SELF-LEARNING: Record the violation that caused the block ---
      try {
        await recordViolationLearning({
          violationCategory: violation.category || "low_qc_score",
          violationReason: effectiveViolationReason,
          leadId: input.leadId,
          channel: input.channel,
          framework: strategy.framework,
          approach: strategy.approach,
          persona,
          qcScore: qc.score,
          reformulationAttempts: 0,
        });
        await recordError({
          errorType: "llm_hallucination",
          errorMessage: `QC block: ${violation.category || "low_qc_score"} — ${(violation.reason || "").substring(0, 200)}`,
          context: `lead:${input.leadId} channel:${input.channel} framework:${strategy.framework} persona:${persona}`,
          rootCause: violation.reason || `QC score ${qc.score}`,
          prevention: `Avoid ${violation.category || "low_qc_score"} patterns for ${persona} leads using ${strategy.framework}`,
        });
      } catch (learnErr) {
        console.error(`[SalesManager] Self-learning record error (non-fatal):`, learnErr);
      }

      // CONTEXT-AWARE FALLBACK: If lead already has prior outbound messages,
      // don't send a cold-intro fallback — it would confuse them.
      // Instead, just block silently and notify owner.
      if (context.priorOutbound && context.priorOutbound.length >= 2) {
        console.log(`[SalesManager] BLOCKED + SUPPRESSED fallback for lead ${input.leadId} — ${context.priorOutbound.length} prior outbound messages exist, cold-intro fallback would be confusing`);
        // Skip fallback, just notify and abort
        await updateCircuitBreaker(input.leadId, true);
        const updatedBreaker2 = await checkCircuitBreaker(input.leadId);
        await notifyOwnerOfViolation(
          input.leadId,
          context.lead.name || `Lead #${input.leadId}`,
          violation.category || "missing_framework",
          `${violation.reason || `QC score ${qc.score}`} [Fallback suppressed — lead has ${context.priorOutbound.length} prior messages]`,
          composed.message,
          qc.score,
          updatedBreaker2.consecutiveFailures
        );
        await addBrainCouncilAudit({
          leadId: input.leadId, leadName: context.lead.name || undefined, channel: input.channel,
          incomingMessage: input.incomingMessage?.substring(0, 2000),
          blocked: 1, blockReason: `${violation.reason} [Fallback suppressed]`,
          violationCategory: violation.category || "missing_framework",
          messageSent: 0, ownerNotified: 1, fallbackUsed: 0,
        });
        return {
          message: "", fromName: context.lead.assignedAgent || composed.fromName,
          framework: "BLOCKED_NO_FALLBACK", angle: strategy.angle, channel: strategy.channel,
          extractedDates: [], score: 0, segment: context.lead.omnisendSegment || "other",
          nextEngagementHours: strategy.nextEngagementHours, qcScore: qc.score,
          strategyReasoning: strategy.reasoning, researchSummary: research.summary,
          blocked: true, blockReason: `${violation.reason} [Fallback suppressed — ${context.priorOutbound.length} prior messages]`,
          violationCategory: violation.category || "missing_framework",
          fallbackUsed: false,
        };
      }

      console.log(`[SalesManager] BLOCKED — ${violation.category || "low_qc_score"}: ${violation.reason || `QC score ${qc.score} after recompose`}`);

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
        wasRecomposed: 0,
        recomposeScore: undefined,
        finalMessage: fallbackMsg,
        messageSent: 0,
        blocked: 1,
        blockReason: effectiveViolationReason,
        violationCategory: effectiveViolationCategory || "missing_framework",
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
        blockReason: effectiveViolationReason,
        violationCategory: effectiveViolationCategory || "missing_framework",
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
        console.log(`[SalesManager] 🔒 Set lastAiSendAttemptAt for lead ${input.leadId} — ${SEND_COOLDOWN_SECONDS}s cooldown active`);
      }
    } catch (err) {
      console.error(`[SalesManager] Failed to set lastAiSendAttemptAt (non-fatal):`, err);
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
        wasRecomposed: 0,
        recomposeScore: undefined,
        finalMessage: composed.message,
        messageSent: 1,
        blocked: 0,
        violationCategory: undefined,
        ownerNotified: 0,
        fallbackUsed: 0,
        // Phase 4: Self-Learning metadata
        experimentId: experimentAssignment?.experimentId,
        variant: experimentAssignment?.variant,
        persona,
      });
    } catch (auditErr) {
      console.error('[SalesManager] Audit log error (non-fatal):', auditErr);
    }

    // --- CACHE INVALIDATION: Ensure next Brain Council run sees the message we just approved ---
    invalidateLeadCache(input.leadId);

    // --- CROSS-SESSION MEMORY: Write 1-sentence interaction summary ---
    try {
      const summary = `[${strategy.approach}/${strategy.framework}] ${strategy.angle}. Sent via ${strategy.channel}. Key: ${composed.message.substring(0, 150).replace(/\n/g, ' ')}...`;
      await upsertAiState(input.leadId, { lastInteractionSummary: summary.substring(0, 500) });
    } catch (summaryErr) {
      console.error('[SalesManager] Interaction summary error (non-fatal):', summaryErr);
    }

    console.log(`[SalesManager] === COMPLETE for lead ${input.leadId}: approved, QC=${qc.score} ===`);

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
      // Phase 4: Self-Learning metadata
      experimentId: experimentAssignment?.experimentId,
      variant: experimentAssignment?.variant,
      persona,
    };
  } finally {
    // ALWAYS release the DB lock, no matter what happened
    if (lockAcquired) {
      await releaseDbBrainCouncilLock(input.leadId);
      console.log(`[SalesManager] 🔓 Lock released for lead ${input.leadId}`);
    }
  }
}
