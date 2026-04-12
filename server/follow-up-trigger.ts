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

import { getLeadsDueForFollowUp, getConversationHistory, updateLeadFields, addConversation, upsertAiState, getAiState, getRecentAiOutboundCount, addBrainCouncilAudit, getBrainCouncilAuditForLead, isAiOffline, getLastEmailThreadId, getLastEmailThreadInfo } from "./db";
import { runBrainCouncil } from "./brain-council-orchestrator";
import { calculateNextFollowUp, checkRateLimits, capDate, checkDnc } from "./scheduling-engine";
import { sendMessage, addNote, fetchGhlConversationHistory, getContact } from "./ghl";
import { sendMessageWithRetry, normalizeChannel, extractFormData, isLlmExhausted, LLM_RETRY_DELAY_MS, formatEmailHtml, buildContextSubject } from "./webhook-helpers";
import { shouldHandoffToAgent, estimateOrderValue, generateContactNotes } from "./ai-brain";
import { notifyOwner } from "./_core/notification";
import { handleChannelDnc, detectDncChannel } from "./channel-fallback";

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
    // AI offline check — skip entire cycle if AI is paused
    if (await isAiOffline()) {
      console.log(`[FollowUp] AI offline — skipping follow-up cycle`);
      return stats;
    }

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

        // DNC CHECK: Scan recent inbound messages BEFORE building context (saves LLM cost)
        try {
          const recentInbound = await getConversationHistory(leadId, 10);
          const inboundOnly = recentInbound.filter((c: any) => c.direction === "inbound");
          if (checkDnc(inboundOnly)) {
            // CHANNEL-SPECIFIC DNC: block only the channel the DNC was received on
            const dncChannel = detectDncChannel((lead as any).preferredChannel || (lead as any).lastOutboundChannel || "SMS");
            const result = await handleChannelDnc(leadId, lead, dncChannel, ghlContactId);
            if (result.action === "not_qualified") {
              // ALL channels exhausted — move to Not Qualified
              await updateLeadFields(leadId, { humanTakeover: 1, pipelineStage: "not_qualified" });
              try {
                const { updateOpportunityStage } = await import("./ghl");
                const leadData = lead as any;
                if (leadData.ghlOpportunityId && leadData.ghlPipelineId) {
                  const { getNqStageId } = await import("../shared/ghl-stages");
                  const nqStageId = getNqStageId(leadData.ghlPipelineId);
                  if (nqStageId) {
                    await updateOpportunityStage(leadData.ghlOpportunityId, nqStageId);
                    await updateLeadFields(leadId, { ghlStageId: nqStageId });
                  }
                }
              } catch { /* best effort GHL update */ }
              console.log(`[FollowUp] \u{1F6AB} DNC on ${dncChannel} — ALL channels exhausted for lead ${leadId} (${leadName}) → Not Qualified`);
            } else {
              console.log(`[FollowUp] \u{1F504} DNC on ${dncChannel} — escalated lead ${leadId} (${leadName}) to ${result.nextChannel}`);
            }
            stats.skipped++;
            continue;
          }
        } catch (dncErr) {
          console.error(`[FollowUp] DNC check failed for lead ${leadId}:`, dncErr);
          // Fail CLOSED: skip this lead rather than risk messaging an opted-out person
          stats.skipped++;
          continue;
        }

        // Build conversation context
        const convHistory = await getConversationHistory(leadId, 50);
        let historyStr = convHistory.map((c: any) =>
          `[${c.senderType === "ai" ? "ai" : c.direction === "inbound" ? "lead" : "agent"}/${c.channel}] ${c.messageBody}`
        ).join("\n");

        // ============================================================
        // ALWAYS fetch GHL history for proactive outreach.
        // This is the authoritative source of truth — it includes
        // messages sent from GHL UI, other automations, and prior
        // conversations that may not be in our local DB.
        // Removing the old conditional (leadAgeDays >= 3 && convHistory.length < 3)
        // which caused the AI to ignore existing conversations and
        // re-initiate contact with leads it had already spoken to.
        // ============================================================
        const createdAt = (lead as any).createdAt;
        const leadAgeDays = createdAt ? (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24) : 999;
        let ghlHistoryMessages: any[] = [];
        try {
          ghlHistoryMessages = await fetchGhlConversationHistory(ghlContactId);
          if (ghlHistoryMessages && ghlHistoryMessages.length > 0) {
            const ghlHistoryStr = ghlHistoryMessages.filter((m: any) => m.body && m.body.trim())
              .map((m: any) => `[${m.direction === "outbound" ? "agent" : "lead"}/${String(m.type || "msg")}] ${m.body}`).join("\n");
            if (ghlHistoryStr) historyStr = `--- Full GHL conversation history (authoritative) ---\n${ghlHistoryStr}\n--- Recent local messages ---\n${historyStr}`;
            console.log(`[FollowUp] GHL history fetched for lead ${leadId}: ${ghlHistoryMessages.length} messages`);
          }
        } catch (err) {
          console.error(`[FollowUp] Failed to fetch GHL history for lead ${leadId}:`, err);
          // Continue — local history is better than nothing
        }

        // --- NOT-INTERESTED DETECTION in GHL history ---
        const NOT_INTERESTED_PATTERNS = [
          /not\s*interested/i,
          /do\s*not\s*contact/i,
          /\bdnc\b/i,
          /\bdeclined\b/i,
          /no\s*longer\s*interested/i,
          /remove\s*(from|me)/i,
          /opted?\s*out/i,
          /\bunsubscribe\b/i,
          /stop\s*contact/i,
          /not\s*a\s*fit/i,
        ];
        if (ghlHistoryMessages.length > 0) {
          const notInterestedMsg = ghlHistoryMessages
            .filter((m: any) => m.direction === "outbound" && m.body?.trim())
            .find((m: any) => NOT_INTERESTED_PATTERNS.some(p => p.test(m.body || "")));
          if (notInterestedMsg) {
            console.log(`[FollowUp] \u{1F6D1} NOT-INTERESTED detected in GHL history for lead ${leadId}: "${String(notInterestedMsg.body).substring(0, 80)}". Setting humanTakeover=1 and skipping.`);
            await updateLeadFields(leadId, { humanTakeover: 1 });
            stats.skipped++;
            continue;
          }
        }

        // --- DORMANCY DETECTION (context only — Brain Council decides channel) ---
        const lastActivityAt = convHistory.length > 0 ? new Date(convHistory[0].timestamp).getTime() : (createdAt ? new Date(createdAt).getTime() : 0);
        const daysSinceLastActivity = lastActivityAt ? (Date.now() - lastActivityAt) / (1000 * 60 * 60 * 24) : 999;
        const isDormant = daysSinceLastActivity >= 30;
        const dormancyTier = daysSinceLastActivity >= 180 ? "deep" : daysSinceLastActivity >= 90 ? "long" : daysSinceLastActivity >= 30 ? "moderate" : "active";

        // Pass a hint channel to Brain Council — it will decide the actual channel autonomously
        // Channel Intelligence: check per-lead channel performance data first
        let hintChannel: string;
        try {
          const { getBestChannelForLead } = await import("./db");
          const bestChannel = await getBestChannelForLead(leadId);
          if (bestChannel) {
            hintChannel = normalizeChannel(bestChannel);
            console.log(`[FollowUp] Lead ${leadId}: Channel intelligence recommends ${hintChannel} (based on reply history)`);
          } else {
            hintChannel = normalizeChannel((lead as any).preferredChannel || (lead as any).lastOutboundChannel || "SMS");
          }
        } catch {
          hintChannel = normalizeChannel((lead as any).preferredChannel || (lead as any).lastOutboundChannel || "SMS");
        }
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

        // --- TCPA QUIET HOURS GATE (SMS only) ---
        const { isSmsQuietHours, nextSmsWindowStart, isEmailOutsideOptimalWindow, nextEmailWindowStart } = await import("./scheduling-engine");
        if (isSmsQuietHours() && hintChannel === "SMS") {
          // Check if lead has email — if so, Brain Council can switch to email
          if (!(lead as any).email) {
            // No email fallback — defer to next SMS window
            const nextWindow = nextSmsWindowStart();
            console.log(`[FollowUp] ⚠️ TCPA quiet hours — deferring SMS for lead ${leadId} to ${nextWindow.toISOString()}`);
            await updateLeadFields(leadId, { nextFollowUpAt: nextWindow });
            stats.skipped++;
            continue;
          }
          // Has email — let Brain Council proceed but hint Email
          console.log(`[FollowUp] TCPA quiet hours — switching hint to Email for lead ${leadId}`);
        }

        // --- EMAIL OPTIMAL WINDOW GATE (Email Marketing Bible) ---
        // Only send emails during 6-10 AM or 1-3 PM ET to maximize open rates
        if (hintChannel === "Email" && isEmailOutsideOptimalWindow()) {
          const nextWindow = nextEmailWindowStart();
          console.log(`[FollowUp] ⏰ Email outside optimal window — deferring email for lead ${leadId} to ${nextWindow.toISOString()}`);
          await updateLeadFields(leadId, { nextFollowUpAt: nextWindow });
          stats.skipped++;
          continue;
        }

        // --- RUN BRAIN COUNCIL (with LLM exhaustion detection) ---
        let aiResponse;
        // DB-level lock + offline check
        try {
          aiResponse = await runBrainCouncil({
            leadId,
            incomingMessage: triggerContext,
            channel: hintChannel, // hint only — Strategist overrides this
            externalHistory: historyStr,
          });
        } catch (brainErr) {
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
            const fbSubject = aiResponse.subject || buildContextSubject({ name: (lead as any).name, businessName: (lead as any).businessName }, aiResponse.fromName);
          const fallbackOpts: Parameters<typeof sendMessage>[1] = channel === "Email"
              ? { type: "Email", subject: fbSubject, html: formatEmailHtml(aiResponse.fallbackMessage), fromName: aiResponse.fromName }
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

        // --- EMAIL POST-DECISION OPTIMAL WINDOW GATE ---
        // Brain Council may have chosen Email despite the hint being SMS — enforce optimal window
        if (channel === "Email" && isEmailOutsideOptimalWindow()) {
          const nextEmailWindow = nextEmailWindowStart();
          console.log(`[FollowUp] ⏰ Email post-decision gate: Brain Council chose Email outside optimal window for lead ${leadId} — deferring to ${nextEmailWindow.toISOString()}`);
          await updateLeadFields(leadId, { nextFollowUpAt: nextEmailWindow });
          stats.skipped++;
          continue;
        }

        // --- TCPA POST-DECISION GATE: Block SMS if quiet hours (Brain Council may have chosen SMS despite hint) ---
        if (isSmsQuietHours() && channel === "SMS") {
          if ((lead as any).email) {
            console.log(`[FollowUp] TCPA gate: Brain Council chose SMS during quiet hours — switching to Email for lead ${leadId}`);
            // Rewrite as email — check for prior email thread
            const tcpaThreadId = await getLastEmailThreadId(leadId);
            const tcpaSubject = aiResponse.subject || buildContextSubject({ name: (lead as any).name, businessName: (lead as any).businessName }, aiResponse.fromName);
            const emailOpts: Parameters<typeof sendMessage>[1] = { type: "Email", subject: tcpaSubject, html: formatEmailHtml(aiResponse.message), fromName: aiResponse.fromName, ...(tcpaThreadId ? { threadId: tcpaThreadId, replyMessageId: tcpaThreadId } : {}) };
            const sendResult = await sendMessageWithRetry(ghlContactId, emailOpts, { email: (lead as any).email, phone: (lead as any).phone, id: leadId });
            if (sendResult.success) {
              await addConversation({ leadId, channel: "Email", direction: "outbound", messageBody: aiResponse.message, senderType: "ai", senderName: aiResponse.fromName });
              stats.sent++;
            } else { stats.errors++; }
            const scheduleResult2 = await calculateNextFollowUp({ leadId, aiSuggestedHours: aiResponse.nextEngagementHours, triggerEvent: "ai_response" });
            const isLongLead2 = scheduleResult2.priority === 1;
            await updateLeadFields(leadId, { nextFollowUpAt: capDate(scheduleResult2.nextFollowUpAt, isLongLead2), cadencePosition: scheduleResult2.cadencePosition, preferredChannel: scheduleResult2.channel, lastOutboundChannel: "Email" });
            continue;
          } else {
            // No email — defer
            const nextWindow = nextSmsWindowStart();
            console.log(`[FollowUp] TCPA gate: deferring SMS for lead ${leadId} to ${nextWindow.toISOString()}`);
            await updateLeadFields(leadId, { nextFollowUpAt: nextWindow });
            stats.skipped++;
            continue;
          }
        }

        // --- SEND MESSAGE ---
        // Email threading: look up prior email thread ID and subject for reply threading
        let emailThreadId: string | null = null;
        let priorEmailSubject: string | null = null;
        if (channel === "Email") {
          const threadInfo = await getLastEmailThreadInfo(leadId);
          emailThreadId = threadInfo?.threadId || null;
          priorEmailSubject = threadInfo?.subject || null;
          if (emailThreadId) console.log(`[FollowUp] Threading email reply for lead ${leadId} (threadId: ${emailThreadId}, priorSubject: ${priorEmailSubject})`);
        }
        // For threaded replies, use "Re: <prior subject>" to keep the thread visible in email clients
        let normalSubject = aiResponse.subject || buildContextSubject({ name: (lead as any).name, businessName: (lead as any).businessName }, aiResponse.fromName);
        if (emailThreadId && priorEmailSubject) {
          // Use the prior subject with Re: prefix (unless it already has one)
          normalSubject = priorEmailSubject.startsWith("Re:") ? priorEmailSubject : `Re: ${priorEmailSubject}`;
        }
        const msgOpts: Parameters<typeof sendMessage>[1] = channel === "Email"
          ? { type: "Email", subject: normalSubject, html: formatEmailHtml(aiResponse.message), fromName: aiResponse.fromName, ...(emailThreadId ? { threadId: emailThreadId, replyMessageId: emailThreadId } : {}) }
          : { type: channel as "SMS" | "WhatsApp" | "FB" | "IG", message: aiResponse.message };
        const sendResult = await sendMessageWithRetry(ghlContactId, msgOpts, { email: (lead as any).email, phone: (lead as any).phone, id: leadId });

        if (sendResult.success) {
          // Determine the actual channel used (may differ if fallback was triggered)
          const actualChannel = sendResult.correctionTaken?.includes("email") ? "Email"
            : sendResult.correctionTaken?.includes("sms") ? "SMS"
            : channel;
          await addConversation({ leadId, channel: actualChannel, direction: "outbound", messageBody: aiResponse.message, senderType: "ai", senderName: aiResponse.fromName, emailMessageId: sendResult.emailMessageId || undefined });
          // Increment messageCount so cadence backoff works correctly
          const currentAiState = await getAiState(leadId);
          const newMsgCount = ((currentAiState as any)?.messageCount || 0) + 1;
          await upsertAiState(leadId, { lastAngleUsed: aiResponse.angle, lastFrameworkUsed: aiResponse.framework, extractedDates: aiResponse.extractedDates as unknown as undefined, messageCount: newMsgCount });
          await updateLeadFields(leadId, { opportunityScore: aiResponse.score, omnisendSegment: aiResponse.segment, lastMessageAt: new Date(), lastOutboundChannel: actualChannel });
          if (sendResult.correctionTaken) {
            console.log(`[FollowUp] ✅ Sent follow-up to lead ${leadId} (${leadName}) via ${actualChannel} [correction: ${sendResult.correctionTaken}]`);
          } else {
            console.log(`[FollowUp] ✅ Sent follow-up to lead ${leadId} (${leadName}) via ${actualChannel}`);
          }

          // Track channel performance (sent side)
          try {
            const { upsertChannelPerformance } = await import("./db");
            await upsertChannelPerformance(leadId, actualChannel, { sent: true });
          } catch { /* best effort */ }

          // Estimate order value
          try {
            const fullConv = historyStr + `\n[ai/${actualChannel}] ${aiResponse.message}`;
            const leadInfo = `${leadName} - ${(lead as any).businessName || "Unknown"} - Stage: ${(lead as any).pipelineStage}`;
            const valueEstimate = await estimateOrderValue(fullConv, leadInfo);
            if (valueEstimate.estimatedValue > 0) {
              await updateLeadFields(leadId, { pipelineValue: valueEstimate.estimatedValue });
            }
          } catch { /* best effort */ }

          stats.sent++;
        } else {
          const errType = sendResult.errorType || "unknown";
          const correction = sendResult.correctionTaken || "none";
          console.error(`[FollowUp] ❌ Failed to send to lead ${leadId} (${leadName}): type=${errType} correction=${correction} error=${sendResult.error}`);

          // Corrective actions based on error type
          if (errType === "missing_phone" && correction === "marked_unreachable") {
            // No phone AND no email — reschedule 30 days out, don't waste cycles
            await updateLeadFields(leadId, { nextFollowUpAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
            console.warn(`[FollowUp] Lead ${leadId} marked unreachable (no phone/email) — rescheduled 30 days`);
            stats.skipped++;
            continue;
          }

          if ((errType === "missing_email" || errType === "invalid_email") && correction === "marked_unreachable") {
            // No email AND no phone — same treatment
            await updateLeadFields(leadId, { nextFollowUpAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
            console.warn(`[FollowUp] Lead ${leadId} marked unreachable (no email/phone) — rescheduled 30 days`);
            stats.skipped++;
            continue;
          }

          if (errType === "carrier_block" && correction === "carrier_block_dnd_flagged") {
            // SMS blocked, no email — reschedule 7 days and let disposition engine handle
            await updateLeadFields(leadId, { nextFollowUpAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) });
            console.warn(`[FollowUp] Lead ${leadId} carrier-blocked (SMS DND flagged, no email) — rescheduled 7 days`);
            stats.skipped++;
            continue;
          }

          if (errType === "dnd") {
            // DND already handled by channel-fallback — just reschedule normally
            console.warn(`[FollowUp] Lead ${leadId} DND rejection — channel-fallback will handle`);
            stats.skipped++;
            continue;
          }

          // Transient or unknown — reschedule 1 hour and count as error
          stats.errors++;
        }

        // Clear admin override fields after the override has been consumed (follow-up fired)
        if ((lead as any).overrideBy) {
          await updateLeadFields(leadId, { overrideBy: null, overrideAt: null, overrideReason: null } as any);
          console.log(`[FollowUp] Cleared consumed admin override for lead ${leadId}`);
        }

        // Schedule next follow-up
        const scheduleResult = await calculateNextFollowUp({ leadId, aiSuggestedHours: aiResponse.nextEngagementHours, triggerEvent: "ai_response" });
        // P1 (customer-stated timeline) is exempt from the 30-day cap
        const isLongLead = scheduleResult.priority === 1;
        await updateLeadFields(leadId, { nextFollowUpAt: capDate(scheduleResult.nextFollowUpAt, isLongLead), cadencePosition: scheduleResult.cadencePosition, preferredChannel: scheduleResult.channel, lastOutboundChannel: channel });
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

// ============================================================
// HOURLY OVERDUE CATCH-UP
// Runs every 60 minutes. Specifically targets leads whose
// nextFollowUpAt is significantly overdue (> 1 hour past).
// Processes batch of 20 to catch leads that fell through cracks.
// ============================================================

const OVERDUE_CATCHUP_BATCH = 20;
const OVERDUE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour — only catch leads overdue by more than this

/** Global lock for overdue catch-up */
let catchupRunning = false;
let catchupStartedAt = 0;
const CATCHUP_LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max

export async function processOverdueCatchUp(): Promise<{ processed: number; rescheduled: number; errors: number }> {
  const stats = { processed: 0, rescheduled: 0, errors: 0 };

  // Global lock
  if (catchupRunning) {
    const elapsed = Date.now() - catchupStartedAt;
    if (elapsed < CATCHUP_LOCK_TIMEOUT_MS) {
      console.log(`[OverdueCatchUp] Skipping — already running (${Math.round(elapsed / 1000)}s ago)`);
      return stats;
    }
    console.log(`[OverdueCatchUp] Previous run timed out after ${Math.round(elapsed / 1000)}s — forcing unlock`);
  }
  catchupRunning = true;
  catchupStartedAt = Date.now();

  try {
    // AI offline check
    if (await isAiOffline()) {
      console.log(`[OverdueCatchUp] AI offline — skipping`);
      return stats;
    }

    // Find leads that are significantly overdue (nextFollowUpAt < NOW() - 1 hour)
    // This avoids overlapping with the normal 10-minute trigger which handles recent overdues
    const { getDb } = await import("./db");
    const { leads } = await import("../drizzle/schema");
    const { and, sql, eq, lte } = await import("drizzle-orm");

    const db = await getDb();
    if (!db) return stats;

    const overdueThreshold = new Date(Date.now() - OVERDUE_THRESHOLD_MS);
    const overdueLeads = await db.select({
      id: leads.id,
      name: leads.name,
      ghlContactId: leads.ghlContactId,
      nextFollowUpAt: leads.nextFollowUpAt,
      opportunityScore: leads.opportunityScore,
      pipelineStage: leads.pipelineStage,
      humanTakeover: leads.humanTakeover,
      assignedAgent: leads.assignedAgent,
    })
      .from(leads)
      .where(and(
        lte(leads.nextFollowUpAt, overdueThreshold),
        eq(leads.humanTakeover, 0),
        sql`${leads.pipelineStage} != 'not_qualified'`,
        sql`${leads.assignedAgent} IS NOT NULL`,
        sql`${leads.ghlContactId} IS NOT NULL`,
      ))
      .orderBy(sql`${leads.nextFollowUpAt} ASC`) // Most overdue first
      .limit(OVERDUE_CATCHUP_BATCH);

    if (overdueLeads.length === 0) return stats;

    const oldestOverdue = overdueLeads[0].nextFollowUpAt
      ? Math.round((Date.now() - new Date(overdueLeads[0].nextFollowUpAt).getTime()) / (60 * 60 * 1000))
      : "unknown";
    console.log(`[OverdueCatchUp] Found ${overdueLeads.length} significantly overdue leads (oldest: ${oldestOverdue}h overdue)`);

    for (const lead of overdueLeads) {
      stats.processed++;
      try {
        // Recalculate schedule — this will either:
        // 1. Set a new future date if the lead should be contacted later
        // 2. Set a date in the near future so the normal 10-min trigger picks it up
        const result = await calculateNextFollowUp({
          leadId: lead.id,
          triggerEvent: "scheduled_recalc",
        });

        if (result.isDnc) {
          // DNC — push far out
          await updateLeadFields(lead.id, {
            nextFollowUpAt: capDate(result.nextFollowUpAt, true),
            cadencePosition: result.cadencePosition,
          });
          stats.rescheduled++;
          continue;
        }

        // If the recalculated date is STILL in the past, set it to NOW so the
        // normal follow-up trigger picks it up in the next 10-min cycle
        const newDate = result.nextFollowUpAt.getTime() < Date.now()
          ? new Date(Date.now() + Math.random() * 10 * 60 * 1000) // Random 0-10 min stagger
          : result.nextFollowUpAt;

        const isLongLead = result.priority === 1;
        await updateLeadFields(lead.id, {
          nextFollowUpAt: capDate(newDate, isLongLead),
          cadencePosition: result.cadencePosition,
          preferredChannel: result.channel,
        });
        stats.rescheduled++;

        const hoursOverdue = lead.nextFollowUpAt
          ? Math.round((Date.now() - new Date(lead.nextFollowUpAt).getTime()) / (60 * 60 * 1000))
          : 0;
        console.log(`[OverdueCatchUp] Lead ${lead.id} (${lead.name || "?"}) was ${hoursOverdue}h overdue → rescheduled: ${result.reason}`);
      } catch (err) {
        console.error(`[OverdueCatchUp] Error processing lead ${lead.id}:`, err);
        stats.errors++;
        // Best-effort: reschedule to 2 hours from now
        try {
          await updateLeadFields(lead.id, { nextFollowUpAt: new Date(Date.now() + 2 * 60 * 60 * 1000) });
        } catch { /* best effort */ }
      }
    }

    console.log(`[OverdueCatchUp] Complete: ${stats.processed} processed, ${stats.rescheduled} rescheduled, ${stats.errors} errors`);
  } catch (err) {
    console.error("[OverdueCatchUp] Fatal error:", err);
  } finally {
    catchupRunning = false;
  }
  return stats;
}
