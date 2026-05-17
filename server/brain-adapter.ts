/**
 * BRAIN ADAPTER — Bridge between the new Single Brain and the legacy BrainCouncilOutput interface.
 *
 * This module:
 * 1. Preserves ALL pre-flight safety checks from the orchestrator
 *    (AI offline, DB lock, humanTakeover, DNC, DND, cooldown, circuit breaker)
 * 2. Calls runSingleBrain() instead of the 4-brain pipeline
 * 3. Maps SingleBrainOutput → BrainCouncilOutput so all downstream code works unchanged
 * 4. Handles lastAiSendAttemptAt, audit logging, and memory updates
 *
 * Drop-in replacement: `import { runBrainCouncil } from "./brain-adapter"`
 */

import {
  addBrainCouncilAudit,
  acquireDbBrainCouncilLock,
  releaseDbBrainCouncilLock,
  isAiOffline,
  getDb,
  isChannelDnd,
  getBlockedChannels,
  upsertAiState,
  updateLeadFields,
  getLeadById,
} from "./db";
import { checkDnc } from "./scheduling-engine";
import { handleChannelDnc, detectDncChannel } from "./channel-fallback";
import { conversations, leads } from "../drizzle/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { invalidateLeadCache } from "./brain-context";
import { checkCircuitBreaker, notifyOwnerOfViolation } from "./qc";
import { isFbWindowOpen, isFbChannel } from "./fb-window-manager";
import { runSingleBrain, type SingleBrainInput, type SingleBrainOutput } from "./single-brain";
import { updateLeadMemoryAfterRun } from "./lead-memory";
import { notifyOwner } from "./_core/notification";
import type { BrainCouncilInput, BrainCouncilOutput } from "./brain-types";

// Re-export types so callers only need one import
export type { BrainCouncilInput, BrainCouncilOutput } from "./brain-types";

// DB-level send cooldown: minimum seconds between AI messages to the same lead
const SEND_COOLDOWN_SECONDS = 90;
// DB lock TTL
const BRAIN_COUNCIL_LOCK_TTL_SECONDS = 120;

/**
 * Pre-flight abort result — returned when the Brain decides NOT to compose.
 */
function abortResult(reason: string, leadId: number): BrainCouncilOutput {
  console.log(`[BrainAdapter] ✋ ABORT for lead ${leadId}: ${reason}`);
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
 * Main entry point — drop-in replacement for runBrainCouncil.
 * Runs pre-flight checks, then calls Single Brain, then maps output.
 */
export const runBrainCouncil = runBrainAdapter;

export async function runBrainAdapter(input: BrainCouncilInput): Promise<BrainCouncilOutput> {
  console.log(`[BrainAdapter] === START for lead ${input.leadId} on ${input.channel} ===`);

  // ================================================================
  // PRE-FLIGHT CHECK 1: Is AI offline?
  // ================================================================
  try {
    if (await isAiOffline()) {
      return abortResult("AI is OFFLINE — system paused by admin", input.leadId);
    }
  } catch (err) {
    console.error(`[BrainAdapter] isAiOffline check failed:`, err);
    return abortResult("AI offline check failed — blocking as precaution", input.leadId);
  }

  // ================================================================
  // PRE-FLIGHT CHECK 2: DB-level send cooldown
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
            if (secondsSinceLastSend < 15) {
              return abortResult(
                `DB send cooldown (inbound): last AI send was ${Math.round(secondsSinceLastSend)}s ago — true duplicate, skipping`,
                input.leadId
              );
            }
            console.log(`[BrainAdapter] Bypassing ${SEND_COOLDOWN_SECONDS}s cooldown for lead ${input.leadId} — isInboundReply=${input.isInboundReply}`);
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
    console.error(`[BrainAdapter] DB send cooldown check failed:`, err);
  }

  // ================================================================
  // PRE-FLIGHT CHECK 2.5: Daily send cap (proactive only)
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
          const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
          const lastSendET = new Date(lastSend.toLocaleString('en-US', { timeZone: 'America/New_York' }));
          const sameCalendarDay =
            nowET.getFullYear() === lastSendET.getFullYear() &&
            nowET.getMonth() === lastSendET.getMonth() &&
            nowET.getDate() === lastSendET.getDate();
          if (sameCalendarDay) {
            return abortResult(
              `Daily send cap: already sent 1 proactive message today (${lastSend.toISOString()})`,
              input.leadId
            );
          }
        }
      }
    } catch (err) {
      console.error(`[BrainAdapter] Daily cap check failed:`, err);
    }
  }

  // ================================================================
  // PRE-FLIGHT CHECK 3: DB Lock
  // ================================================================
  let lockAcquired = false;
  try {
    lockAcquired = await acquireDbBrainCouncilLock(input.leadId);
    if (!lockAcquired) {
      return abortResult("Could not acquire DB lock — another run in progress", input.leadId);
    }
  } catch (err) {
    console.error(`[BrainAdapter] DB lock acquire failed:`, err);
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
      console.error(`[BrainAdapter] humanTakeover check failed:`, err);
    }

    // ================================================================
    // PRE-FLIGHT CHECK 4.5: DNC keyword detection
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
          const dncChannel = detectDncChannel(input.channel);
          const [leadRow] = await db2.select().from(leads).where(eq(leads.id, input.leadId)).limit(1);
          if (leadRow) {
            const result = await handleChannelDnc(input.leadId, leadRow, dncChannel, leadRow.ghlContactId);
            if (result.action === "not_qualified") {
              await db2.update(leads)
                .set({ humanTakeover: 1, pipelineStage: "not_qualified" } as any)
                .where(eq(leads.id, input.leadId));
              try {
                if (leadRow.ghlOpportunityId && leadRow.ghlPipelineId) {
                  const { updateOpportunityStage } = await import("./ghl");
                  const { getNqStageId } = await import("../shared/ghl-stages");
                  const nqStageId = getNqStageId(leadRow.ghlPipelineId);
                  if (nqStageId) await updateOpportunityStage(leadRow.ghlOpportunityId, nqStageId);
                }
              } catch { /* best effort GHL update */ }
              return abortResult(`DNC on ${dncChannel} — all channels exhausted. Moved to Not Qualified.`, input.leadId);
            } else {
              return abortResult(`DNC on ${dncChannel} — escalated to ${result.nextChannel}. Will follow up on new channel.`, input.leadId);
            }
          } else {
            return abortResult("DNC keyword detected but lead not found in DB", input.leadId);
          }
        }
      }
    } catch (err) {
      console.error(`[BrainAdapter] DNC check failed:`, err);
      return abortResult("DNC check failed — blocking as precaution", input.leadId);
    }

    // ================================================================
    // PRE-FLIGHT CHECK 4.7: Per-channel GHL DND check
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
      console.error(`[BrainAdapter] DND channel check failed:`, err);
    }

    // ================================================================
    // PRE-FLIGHT CHECK 5: Already responded (dedup)
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
        console.error(`[BrainAdapter] recent-outbound check failed:`, err);
      }
    }

    // ================================================================
    // PRE-FLIGHT CHECK 6: Circuit Breaker
    // ================================================================
    const circuitBreaker = await checkCircuitBreaker(input.leadId);
    if (circuitBreaker.tripped) {
      console.log(`[BrainAdapter] CIRCUIT BREAKER TRIPPED for lead ${input.leadId} (${circuitBreaker.consecutiveFailures} consecutive failures). Setting humanTakeover=1.`);
      try {
        await updateLeadFields(input.leadId, { humanTakeover: 1 });
      } catch (htErr) {
        console.error(`[BrainAdapter] Failed to set humanTakeover (non-fatal):`, htErr);
      }
      // Dedup notification (1 per 24h)
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
            const lead = await getLeadById(input.leadId);
            await notifyOwnerOfViolation(
              input.leadId,
              lead?.name || `Lead ${input.leadId}`,
              "safety_violation",
              `Circuit breaker tripped: ${circuitBreaker.consecutiveFailures} consecutive failures`,
              "",
              0,
              circuitBreaker.consecutiveFailures
            );
          }
        }
      } catch { /* best effort */ }

      await addBrainCouncilAudit({
        leadId: input.leadId,
        channel: input.channel,
        incomingMessage: input.incomingMessage?.substring(0, 2000),
        blocked: 1,
        blockReason: `Circuit breaker: ${circuitBreaker.consecutiveFailures} consecutive failures`,
        violationCategory: "safety_violation",
        messageSent: 0,
      });

      return abortResult(`Circuit breaker: ${circuitBreaker.consecutiveFailures} consecutive failures`, input.leadId);
    }

    // ================================================================
    // ALL PRE-FLIGHT CHECKS PASSED — Run Single Brain
    // ================================================================
    console.log(`[BrainAdapter] ✅ All pre-flight checks passed for lead ${input.leadId}. Running Single Brain...`);

    const singleBrainInput: SingleBrainInput = {
      leadId: input.leadId,
      trigger: input.isInboundReply ? "inbound_reply" : (input.overrideReason || "follow_up"),
      inboundMessage: input.incomingMessage || undefined,
      channel: input.channel,
    };

    const result = await runSingleBrain(singleBrainInput);

    // ================================================================
    // Handle blocked/route-to-human decisions
    // ================================================================
    if (result.decision.routeToHuman) {
      await updateLeadFields(input.leadId, { humanTakeover: 1 });
      await addBrainCouncilAudit({
        leadId: input.leadId,
        channel: input.channel,
        incomingMessage: input.incomingMessage?.substring(0, 2000),
        blocked: 1,
        blockReason: `Escalated to human: ${result.decision.routeReason}`,
        messageSent: 0,
      });
      return abortResult(`Escalated to human: ${result.decision.routeReason}`, input.leadId);
    }

    if (result.decision.pipelineAction === "dnc") {
      await addBrainCouncilAudit({
        leadId: input.leadId,
        channel: input.channel,
        incomingMessage: input.incomingMessage?.substring(0, 2000),
        blocked: 1,
        blockReason: "DNC — lead requested opt-out",
        messageSent: 0,
      });
      return abortResult("DNC — lead requested opt-out", input.leadId);
    }

    if (!result.decision.message) {
      await addBrainCouncilAudit({
        leadId: input.leadId,
        channel: input.channel,
        incomingMessage: input.incomingMessage?.substring(0, 2000),
        blocked: 1,
        blockReason: "Single brain decided not to send (null message)",
        messageSent: 0,
      });
      return abortResult("Single brain decided not to send (null message)", input.leadId);
    }

    // ================================================================
    // Output guard blocked the message
    // ================================================================
    if (!result.guardResult.passed) {
      await addBrainCouncilAudit({
        leadId: input.leadId,
        channel: input.channel,
        incomingMessage: input.incomingMessage?.substring(0, 2000),
        composedMessage: result.decision.message,
        blocked: 1,
        blockReason: `Output guard: ${result.guardResult.reason}`,
        violationCategory: "safety_violation",
        messageSent: 0,
      });
      return {
        ...abortResult(`Output guard blocked: ${result.guardResult.reason}`, input.leadId),
        violationCategory: "safety_violation",
      };
    }

    // ================================================================
    // FB 24hr window check — if channel is FB/IG and window closed, fall back to SMS
    // ================================================================
    let finalChannel = result.decision.channel;
    if (isFbChannel(finalChannel)) {
      try {
        const fbWindow = await isFbWindowOpen(input.leadId);
        if (!fbWindow.isOpen) {
          const lead = await getLeadById(input.leadId);
          if (lead?.phone) {
            console.log(`[BrainAdapter] ⚠️ FB WINDOW CLOSED for lead ${input.leadId}. Falling back to SMS.`);
            finalChannel = "SMS";
          } else {
            console.log(`[BrainAdapter] ⚠️ FB WINDOW CLOSED for lead ${input.leadId} but no phone. Keeping FB (may fail).`);
          }
        }
      } catch (fbErr) {
        console.error('[BrainAdapter] FB window check error (non-fatal):', fbErr);
      }
    }

    // ================================================================
    // Set lastAiSendAttemptAt BEFORE returning approved message
    // ================================================================
    try {
      const db = await getDb();
      if (db) {
        await db.update(leads)
          .set({ lastAiSendAttemptAt: new Date() })
          .where(eq(leads.id, input.leadId));
        console.log(`[BrainAdapter] 🔒 Set lastAiSendAttemptAt for lead ${input.leadId} — ${SEND_COOLDOWN_SECONDS}s cooldown active`);
      }
    } catch (err) {
      console.error(`[BrainAdapter] Failed to set lastAiSendAttemptAt (non-fatal):`, err);
    }

    // ================================================================
    // Audit log
    // ================================================================
    try {
      await addBrainCouncilAudit({
        leadId: input.leadId,
        channel: finalChannel,
        incomingMessage: input.incomingMessage?.substring(0, 2000),
        composedMessage: result.decision.message,
        finalMessage: result.decision.message,
        qcScore: result.decision.confidence,
        qcApproved: 1,
        messageSent: 1,
        blocked: 0,
        emailSubject: result.decision.subject || undefined,
        strategyReasoning: `[SingleBrain v3.0] ${result.model} | ${result.llmCalls} LLM calls | ${result.durationMs}ms`,
      });
    } catch (auditErr) {
      console.error('[BrainAdapter] Audit log error (non-fatal):', auditErr);
    }

    // ================================================================
    // Cache invalidation + memory update
    // ================================================================
    invalidateLeadCache(input.leadId);

    try {
      const summary = `[SingleBrain/${result.promptVersion}] Sent via ${finalChannel}. Key: ${result.decision.message.substring(0, 150).replace(/\n/g, ' ')}...`;
      await upsertAiState(input.leadId, { lastInteractionSummary: summary.substring(0, 500) });
    } catch { /* non-fatal */ }

    // Private memory update (non-blocking)
    const lead = await getLeadById(input.leadId);
    const leadName = lead?.name || lead?.email || `Lead ${input.leadId}`;
    updateLeadMemoryAfterRun(input.leadId, leadName, input.incomingMessage || "").catch(() => {});

    // ================================================================
    // Map SingleBrainOutput → BrainCouncilOutput
    // ================================================================
    console.log(`[BrainAdapter] === COMPLETE for lead ${input.leadId}: approved, confidence=${result.decision.confidence} ===`);

    return {
      message: result.decision.message,
      fromName: lead?.assignedAgent || "Abby Bouwer",
      subject: undefined, // Single brain doesn't generate email subjects yet — webhook-message.ts will use buildContextSubject
      framework: "SINGLE_BRAIN",
      angle: "single_brain",
      channel: finalChannel,
      extractedDates: [],
      score: lead?.opportunityScore || 50,
      segment: lead?.omnisendSegment || "other",
      nextEngagementHours: result.decision.nextFollowUpHours,
      qcScore: result.decision.confidence,
      strategyReasoning: `[SingleBrain v3.0] confidence=${result.decision.confidence}, model=${result.model}`,
      researchSummary: "",
      blocked: false,
      fallbackUsed: false,
    };

  } finally {
    // ALWAYS release the DB lock
    if (lockAcquired) {
      await releaseDbBrainCouncilLock(input.leadId);
      console.log(`[BrainAdapter] 🔓 Lock released for lead ${input.leadId}`);
    }
  }
}
