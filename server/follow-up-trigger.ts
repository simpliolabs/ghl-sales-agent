/**
 * FOLLOW-UP TRIGGER — Cron module that engages overdue leads via Brain Council
 * 
 * Runs every 10 minutes. Finds leads where nextFollowUpAt <= NOW() and
 * humanTakeover = 0, then triggers the Brain Council for each one.
 * 
 * Safeguards:
 * - Max 10 leads per cycle (avoid rate-limiting GHL)
 * - Skips leads with no assigned agent
 * - Skips leads contacted in the last 5 minutes (dedup)
 * - Respects global rate limits
 * - LLM exhaustion detection: on credit/rate-limit errors, reschedules lead
 *   with exponential backoff and stops the cycle (no point trying more leads)
 * - Logs every engagement attempt
 */

import { getLeadsDueForFollowUp, getConversationHistory, updateLeadFields, addConversation, upsertAiState, getRecentAiOutboundCount, addBrainCouncilAudit, getBrainCouncilAuditForLead } from "./db";
import { runBrainCouncil } from "./brain-council-orchestrator";
import { acquireDbBrainCouncilLock, releaseDbBrainCouncilLock, isAiOffline } from "./db";
import { calculateNextFollowUp, checkRateLimits, capDate } from "./scheduling-engine";
import { sendMessage, addNote, fetchGhlConversationHistory, getContact } from "./ghl";
import { sendMessageWithRetry, normalizeChannel, extractFormData, isLlmExhausted, LLM_RETRY_DELAY_MS } from "./webhook-helpers";
import { shouldHandoffToAgent, estimateOrderValue, generateContactNotes } from "./ai-brain";
import { notifyOwner } from "./_core/notification";

const MAX_PER_CYCLE = 10;
const MIN_MINUTES_BETWEEN_AI = 5;

/** Track consecutive LLM exhaustion events across cycles to avoid spamming notifications */
let consecutiveLlmExhaustionCycles = 0;
/** Global lock to prevent concurrent follow-up trigger runs (e.g. on server restart) */
let triggerRunning = false;
let triggerRunStartedAt = 0;
const TRIGGER_LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max per run

export async function processOverdueFollowUps(): Promise<{ processed: number; sent: number; skipped: number; errors: number; llmExhausted: boolean }> {
  const stats = { processed: 0, sent: 0, skipped: 0, errors: 0, llmExhausted: false };

  // Global lock: prevent concurrent runs (e.g. multiple server restarts in quick succession)
  if (triggerRunning) {
    const elapsed = Date.now() - triggerRunStartedAt;
    if (elapsed < TRIGGER_LOCK_TIMEOUT_MS) {
      console.log(`[FollowUp] Skipping — trigger already running (started ${Math.round(elapsed / 1000)}s ago)`);
      return stats;
    }
    console.log(`[FollowUp] Previous trigger run timed out after ${Math.round(elapsed / 1000)}s — forcing unlock`);
  }
  triggerRunning = true;
  triggerRunStartedAt = Date.now();

  try {
    // Global rate limit check first
    const rateCheck = await checkRateLimits();
    if (!rateCheck.allowed) {
      console.log(`[FollowUp] Global rate limit hit: ${rateCheck.reason}`);
      return stats;
    }

    const dueLeads = await getLeadsDueForFollowUp();
    if (dueLeads.length === 0) return stats;

    console.log(`[FollowUp] Found ${dueLeads.length} overdue leads, processing up to ${MAX_PER_CYCLE}`);

    // Sort by priority: higher score first, then oldest nextFollowUpAt
    const sorted = dueLeads.sort((a, b) => {
      const scoreA = (a as any).opportunityScore || 0;
      const scoreB = (b as any).opportunityScore || 0;
      if (scoreB !== scoreA) return scoreB - scoreA;
      const dateA = new Date((a as any).nextFollowUpAt || 0).getTime();
      const dateB = new Date((b as any).nextFollowUpAt || 0).getTime();
      return dateA - dateB;
    });

    const batch = sorted.slice(0, MAX_PER_CYCLE);

    for (const lead of batch) {
      stats.processed++;
      const leadId = (lead as any).id;
      const ghlContactId = (lead as any).ghlContactId;
      const assignedAgent = (lead as any).assignedAgent;
      const leadName = (lead as any).name || "Unknown";

      try {
        // Skip leads without agent
        if (!assignedAgent) {
          console.log(`[FollowUp] Skipping lead ${leadId} — no assigned agent`);
          stats.skipped++;
          // Reschedule for later
          const reschedule = await calculateNextFollowUp({ leadId, triggerEvent: "scheduled_recalc" });
          await updateLeadFields(leadId, { nextFollowUpAt: reschedule.nextFollowUpAt });
          continue;
        }

        // Skip if no GHL contact ID
        if (!ghlContactId) {
          console.log(`[FollowUp] Skipping lead ${leadId} — no GHL contact ID`);
          stats.skipped++;
          const reschedule = await calculateNextFollowUp({ leadId, triggerEvent: "scheduled_recalc" });
          await updateLeadFields(leadId, { nextFollowUpAt: reschedule.nextFollowUpAt });
          continue;
        }

        // Dedup: skip if AI sent a message in the last 10 minutes (covers concurrent trigger runs)
        const recentAiCount = await getRecentAiOutboundCount(leadId, 10);
        if (recentAiCount > 0) {
          console.log(`[FollowUp] Skipping lead ${leadId} — AI sent ${recentAiCount} msg(s) in last 10 min`);
          stats.skipped++;
          continue;
        }

        // Re-check rate limits before each send
        const perLeadRate = await checkRateLimits();
        if (!perLeadRate.allowed) {
          console.log(`[FollowUp] Rate limit hit mid-cycle: ${perLeadRate.reason}`);
          break;
        }

        // Build conversation context
        const convHistory = await getConversationHistory(leadId, 20);
        let historyStr = convHistory.map((c: any) =>
          `[${c.senderType === "ai" ? "ai" : c.direction === "inbound" ? "lead" : "agent"}/${c.channel}] ${c.messageBody}`
        ).join("\n");

        // For aged contacts, fetch GHL history
        const createdAt = (lead as any).createdAt;
        const leadAgeDays = createdAt ? (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24) : 999;
        if (leadAgeDays >= 3 && convHistory.length < 3) {
          try {
            const ghlHistory = await fetchGhlConversationHistory(ghlContactId);
            if (ghlHistory && ghlHistory.length > 0) {
              const ghlHistoryStr = ghlHistory.filter((m: any) => m.body && m.body.trim())
                .map((m: any) => `[${m.direction === "outbound" ? "agent" : "lead"}/${String(m.type || "msg")}] ${m.body}`).join("\n");
              if (ghlHistoryStr) historyStr = `--- Full GHL conversation history ---\n${ghlHistoryStr}\n--- Recent local messages ---\n${historyStr}`;
            }
          } catch (err) {
            console.error(`[FollowUp] Failed to fetch GHL history for lead ${leadId}:`, err);
          }
        }

        // --- DORMANCY DETECTION (context only — Brain Council decides channel) ---
        const lastActivityAt = convHistory.length > 0 ? new Date(convHistory[0].timestamp).getTime() : (createdAt ? new Date(createdAt).getTime() : 0);
        const daysSinceLastActivity = lastActivityAt ? (Date.now() - lastActivityAt) / (1000 * 60 * 60 * 24) : 999;
        const isDormant = daysSinceLastActivity >= 30;
        const dormancyTier = daysSinceLastActivity >= 180 ? "deep" : daysSinceLastActivity >= 90 ? "long" : daysSinceLastActivity >= 30 ? "moderate" : "active";

        // Pass a hint channel to Brain Council — it will decide the actual channel autonomously
        const hintChannel = normalizeChannel((lead as any).preferredChannel || (lead as any).lastOutboundChannel || "SMS");
        if (isDormant) {
          console.log(`[FollowUp] Lead ${leadId} dormant ${Math.round(daysSinceLastActivity)}d (${dormancyTier}) — Brain Council will decide channel`);
        }

        // Check handoff status
        const handoffDecision = await shouldHandoffToAgent(historyStr, null);
        if (handoffDecision.handoff && !handoffDecision.resumeAI) {
          console.log(`[FollowUp] Lead ${leadId} needs human handoff: ${handoffDecision.reason}`);
          await updateLeadFields(leadId, { humanTakeover: 1 });
          stats.skipped++;
          continue;
        }

        // --- CADENCE BACKOFF CHECK ---
        const recentConvs = convHistory.slice().reverse();
        let consecutiveUnanswered = 0;
        for (let i = recentConvs.length - 1; i >= 0; i--) {
          if (recentConvs[i].direction === "outbound" && recentConvs[i].senderType === "ai") consecutiveUnanswered++;
          else if (recentConvs[i].direction === "inbound") break;
        }
        if (consecutiveUnanswered >= 2) {
          const minGapMinutes = consecutiveUnanswered >= 4 ? 1440 : consecutiveUnanswered >= 3 ? 240 : 60;
          const lastAiOutbound = recentConvs.filter((c: any) => c.direction === "outbound" && c.senderType === "ai").pop();
          if (lastAiOutbound) {
            const lastSentAt = new Date(lastAiOutbound.timestamp).getTime();
            const minutesSinceLastSend = (Date.now() - lastSentAt) / (1000 * 60);
            if (minutesSinceLastSend < minGapMinutes) {
              console.log(`[FollowUp] Cadence backoff for lead ${leadId} — ${consecutiveUnanswered} unanswered, need ${minGapMinutes}min gap`);
              const backoffFollowUp = new Date(Date.now() + (minGapMinutes - minutesSinceLastSend) * 60 * 1000);
              await updateLeadFields(leadId, { nextFollowUpAt: backoffFollowUp });
              stats.skipped++;
              continue;
            }
          }
        }

        // --- BUILD DORMANCY-AWARE TRIGGER CONTEXT ---
        let triggerContext = `[FOLLOW-UP TRIGGER] Lead is overdue for engagement.`;
        triggerContext += ` Last contact: ${convHistory.length > 0 ? new Date(convHistory[0].timestamp).toLocaleString() : "never"}.`;
        triggerContext += ` Consecutive unanswered: ${consecutiveUnanswered}.`;
        triggerContext += ` Lead has email: ${(lead as any).email ? "yes" : "no"}. Lead has phone: ${(lead as any).phone ? "yes" : "no"}.`;

        if (isDormant) {
          triggerContext += `\n\n⚠️ DORMANCY ALERT: This lead has been inactive for ${Math.round(daysSinceLastActivity)} days (${dormancyTier} dormancy).`;
          triggerContext += ` DO NOT continue the old conversation as if no time has passed.`;
          triggerContext += ` This is a RE-ACTIVATION — craft a warm, fresh re-introduction.`;
          if (dormancyTier === "deep") {
            triggerContext += ` This lead has been silent 6+ months — treat as a brand new relationship. Reference their business, not past conversations.`;
          } else if (dormancyTier === "long") {
            triggerContext += ` This lead has been silent 3-6 months — acknowledge the gap naturally, offer fresh value.`;
          } else {
            triggerContext += ` This lead has been silent 1-3 months — gentle check-in with new value proposition.`;
          }
        }

        // --- RUN BRAIN COUNCIL (with LLM exhaustion detection) ---
        let aiResponse;
        // DB-level lock + offline check
        if (await isAiOffline()) {
          console.log(`[FollowUp] AI is OFFLINE — skipping Brain Council for lead ${lead.id}`);
          stats.skipped++;
          continue;
        }
        const ftLockAcquired = await acquireDbBrainCouncilLock(lead.id);
        if (!ftLockAcquired) {
          console.log(`[FollowUp] Brain Council already running for lead ${lead.id} — skipping (DB lock held)`);
          stats.skipped++;
          continue;
        }
        try {
          aiResponse = await runBrainCouncil({
            leadId,
            incomingMessage: triggerContext,
            channel: hintChannel, // hint only — Strategist overrides this
            externalHistory: historyStr,
          });
        } catch (brainErr) {
          await releaseDbBrainCouncilLock(lead.id);
          if (isLlmExhausted(brainErr)) {
            // LLM credits exhausted — reschedule this lead and STOP the entire cycle
            // (no point trying more leads if the LLM is down)
            const retryAt = new Date(Date.now() + LLM_RETRY_DELAY_MS);
            console.error(`[FollowUp] ⚠️ LLM EXHAUSTED for lead ${leadId} (${leadName}). Rescheduling to ${retryAt.toISOString()} and stopping cycle.`);

            await updateLeadFields(leadId, { nextFollowUpAt: retryAt });

            // Log in audit trail
            await addBrainCouncilAudit({
              leadId,
              leadName,
              channel: hintChannel,
              incomingMessage: triggerContext.substring(0, 2000),
              blocked: 1,
              blockReason: `LLM credits exhausted — auto-retry scheduled for ${retryAt.toISOString()}`,
              violationCategory: "llm_exhausted",
              messageSent: 0,
              ownerNotified: consecutiveLlmExhaustionCycles === 0 ? 1 : 0,
            });

            // Reschedule ALL remaining leads in this batch so they don't pile up
            for (const remainingLead of batch.slice(batch.indexOf(lead) + 1)) {
              const rLeadId = (remainingLead as any).id;
              // Stagger retries: each lead gets an extra 1-minute offset to avoid thundering herd
              const staggeredRetry = new Date(retryAt.getTime() + (batch.indexOf(remainingLead) * 60 * 1000));
              try {
                await updateLeadFields(rLeadId, { nextFollowUpAt: staggeredRetry });
              } catch { /* best effort */ }
            }

            // Notify owner (only on first exhaustion cycle, then every 6th = ~1 hour)
            consecutiveLlmExhaustionCycles++;
            if (consecutiveLlmExhaustionCycles === 1 || consecutiveLlmExhaustionCycles % 6 === 0) {
              try {
                await notifyOwner({
                  title: `⚠️ LLM Credits Exhausted — Follow-ups Paused`,
                  content: `Brain Council failed for ${leadName} (Lead #${leadId}). Error: ${String((brainErr as any)?.message || brainErr).substring(0, 200)}. All ${batch.length} overdue leads rescheduled for retry at ${retryAt.toLocaleString()}. This is exhaustion cycle #${consecutiveLlmExhaustionCycles}. Credits will auto-replenish on your Manus billing cycle.`,
                });
              } catch { /* best effort */ }
            }

            stats.errors++;
            stats.llmExhausted = true;
            break; // Stop the entire cycle
          }

          // Non-LLM error — handle normally
          throw brainErr;
        } finally {
          // Always release the DB lock (success path or non-LLM error)
          await releaseDbBrainCouncilLock(lead.id);
        }

        // Reset exhaustion counter on successful Brain Council call
        consecutiveLlmExhaustionCycles = 0;

        // Use the Brain Council's channel decision, not our hint
        const channel = normalizeChannel(aiResponse.channel || hintChannel);

        console.log(`[FollowUp] Brain Council for lead ${leadId}: QC=${aiResponse.qcScore}, blocked=${aiResponse.blocked}, framework=${aiResponse.framework}, channel=${channel} (hint was ${hintChannel})`);

        // Handle blocked messages
        if (aiResponse.blocked) {
          console.log(`[FollowUp] ⚠️ BLOCKED follow-up for lead ${leadId}: ${aiResponse.blockReason}`);
          if (aiResponse.fallbackUsed && aiResponse.fallbackMessage) {
            const fallbackOpts: Parameters<typeof sendMessage>[1] = channel === "Email"
              ? { type: "Email", subject: "Adorb Custom Tees", html: aiResponse.fallbackMessage, fromName: aiResponse.fromName }
              : { type: channel as "SMS" | "WhatsApp" | "FB" | "IG", message: aiResponse.fallbackMessage };
            const sendResult = await sendMessageWithRetry(ghlContactId, fallbackOpts, { email: (lead as any).email, phone: (lead as any).phone, id: leadId });
            if (sendResult.success) {
              await addConversation({ leadId, channel, direction: "outbound", messageBody: `[FALLBACK] ${aiResponse.fallbackMessage}`, senderType: "ai", senderName: aiResponse.fromName });
              stats.sent++;
            } else {
              stats.errors++;
            }
          } else {
            stats.skipped++;
          }
          const reschedule = await calculateNextFollowUp({ leadId, triggerEvent: "ai_response" });
          await updateLeadFields(leadId, { nextFollowUpAt: reschedule.nextFollowUpAt });
          continue;
        }

        // --- SEND MESSAGE ---
        const msgOpts: Parameters<typeof sendMessage>[1] = channel === "Email"
          ? { type: "Email", subject: aiResponse.subject || `${aiResponse.fromName} from Adorb`, html: aiResponse.message, fromName: aiResponse.fromName }
          : { type: channel as "SMS" | "WhatsApp" | "FB" | "IG", message: aiResponse.message };
        const sendResult = await sendMessageWithRetry(ghlContactId, msgOpts, { email: (lead as any).email, phone: (lead as any).phone, id: leadId });

        if (sendResult.success) {
          await addConversation({ leadId, channel, direction: "outbound", messageBody: aiResponse.message, senderType: "ai", senderName: aiResponse.fromName });
          await upsertAiState(leadId, { lastAngleUsed: aiResponse.angle, lastFrameworkUsed: aiResponse.framework, extractedDates: aiResponse.extractedDates as unknown as undefined, messageCount: undefined });
          await updateLeadFields(leadId, { opportunityScore: aiResponse.score, omnisendSegment: aiResponse.segment, lastMessageAt: new Date() });

          // Estimate order value
          try {
            const fullConv = historyStr + `\n[ai/${channel}] ${aiResponse.message}`;
            const leadInfo = `${leadName} - ${(lead as any).businessName || "Unknown"} - Stage: ${(lead as any).pipelineStage}`;
            const valueEstimate = await estimateOrderValue(fullConv, leadInfo);
            if (valueEstimate.estimatedValue > 0) {
              await updateLeadFields(leadId, { pipelineValue: valueEstimate.estimatedValue });
            }
          } catch { /* best effort */ }

          stats.sent++;
          console.log(`[FollowUp] ✅ Sent follow-up to lead ${leadId} (${leadName}) via ${channel}`);
        } else {
          console.error(`[FollowUp] ❌ Failed to send to lead ${leadId}: ${sendResult.error}`);
          stats.errors++;
        }

        // Schedule next follow-up
        const scheduleResult = await calculateNextFollowUp({ leadId, aiSuggestedHours: aiResponse.nextEngagementHours, triggerEvent: "ai_response" });
        await updateLeadFields(leadId, { nextFollowUpAt: capDate(scheduleResult.nextFollowUpAt), cadencePosition: scheduleResult.cadencePosition, preferredChannel: scheduleResult.channel, lastOutboundChannel: channel });
        console.log(`[FollowUp] Next for lead ${leadId}: ${scheduleResult.reason}`);

        // Small delay between sends to avoid GHL rate limits
        await new Promise(r => setTimeout(r, 2000));

      } catch (err) {
        console.error(`[FollowUp] Error processing lead ${leadId}:`, err);
        stats.errors++;
        // Reschedule failed lead for 1 hour later
        try {
          await updateLeadFields(leadId, { nextFollowUpAt: new Date(Date.now() + 60 * 60 * 1000) });
        } catch { /* best effort */ }
      }
    }

     console.log(`[FollowUp] Cycle complete: ${stats.processed} processed, ${stats.sent} sent, ${stats.skipped} skipped, ${stats.errors} errors${stats.llmExhausted ? " (LLM EXHAUSTED — cycle stopped early)" : ""}`);
  } catch (err) {
    console.error("[FollowUp] Fatal error in follow-up trigger:", err);
  } finally {
    triggerRunning = false;
  }
  return stats;
}
