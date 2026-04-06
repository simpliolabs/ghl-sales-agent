/**
 * WEBHOOK MESSAGE HANDLER — Handles inbound/outbound messages from GHL
 * 
 * Responsibilities:
 * - Store messages in conversation history
 * - GHL contact ID resolution + enrichment
 * - Auto-correction for confused leads
 * - Smart handoff logic (human takeover detection)
 * - Dedup guard + cadence backoff
 * - AI response via Brain Council (Strategist → Researcher → Composer → QC)
 * - LLM failure retry queue (auto-reschedule on credit exhaustion)
 * - Post-send validation + scheduling
 */

import { Response } from "express";
import {
  upsertLead, getLeadByGhlContactId, updateLeadFields, addConversation, upsertAiState,
  getConversationHistory, getRecentAiOutboundCount, addBrainCouncilAudit, getBrainCouncilAuditForLead,
} from "./db";
import { shouldHandoffToAgent, generateContactNotes, estimateOrderValue } from "./ai-brain";
import { runBrainCouncil } from "./brain-council-orchestrator";
import { calculateNextFollowUp, checkRateLimits } from "./scheduling-engine";
import { sendMessage, updateContactCustomField, createTask, addNote, fetchGhlConversationHistory, getContact, updateContactAssignment, AGENT_GHL_USER_IDS } from "./ghl";
import { detectConfusion, handleConfusionReply, postSendValidation } from "./auto-correction";
import { attributeReply } from "./outcome-engine";
import { notifyOwner } from "./_core/notification";
import {
  resolveGhlContactId,
  extractContactData,
  sendMessageWithRetry,
  normalizeChannel,
  extractFormData,
  isLlmExhausted,
  LLM_RETRY_DELAY_MS,
  MAX_LLM_RETRIES,
} from "./webhook-helpers";

export async function handleMessageWebhook(payload: Record<string, unknown>, res: Response) {
  const contactId = payload.contactId as string;
  const messageBody = (payload.body || payload.message) as string;
  const rawChannel = (payload.messageType || payload.type || "SMS") as string;
  const channel = normalizeChannel(rawChannel);
  const direction = (payload.direction || "inbound") as string;

  // --- ATTACHMENT DETECTION ---
  // GHL sends attachments with empty/null body. Detect and treat as logo/file received.
  const hasAttachment = !!(payload.attachments && (payload.attachments as unknown[]).length > 0) ||
    (typeof payload.body === 'string' && payload.body.trim() === '' && payload.messageType === 'TYPE_ATTACHMENT') ||
    (!payload.body && !payload.message && payload.attachments);
  if (!contactId) { res.status(400).json({ error: "Missing contactId" }); return; }
  // If it's an attachment with no text body, log it and set humanTakeover pause
  if (hasAttachment && !messageBody) {
    let attachLead = await getLeadByGhlContactId(contactId);
    if (attachLead) {
      // Pause AI for 2 hours — lead sent a file (likely logo/design)
      const pauseUntil = new Date(Date.now() + 2 * 60 * 60 * 1000);
      await updateLeadFields(attachLead.id, { humanTakeover: 1, lastAgentActivityAt: pauseUntil });
      await addConversation({ leadId: attachLead.id, channel, direction: 'inbound', messageBody: '[Attachment received — logo/design file]', senderType: 'lead' });
      console.log(`[Webhook/Attachment] Lead ${attachLead.id} sent attachment — AI paused 2 hours`);
    }
    res.json({ success: true, action: 'attachment_received_ai_paused' });
    return;
  }
  if (!messageBody) { res.status(400).json({ error: "Missing data" }); return; }

  let lead = await getLeadByGhlContactId(contactId);
  if (!lead) {
    const newLead = await upsertLead({ ghlContactId: contactId, source: "ghl_message" });
    if (!newLead) { res.status(500).json({ error: "Failed to create lead" }); return; }
    lead = { ...newLead, id: newLead.id, humanTakeover: 0, lastAgentActivityAt: null, pipelineValue: null } as unknown as NonNullable<typeof lead>;
  }

  // GHL CONTACT ID RESOLUTION + ENRICHMENT
  let resolvedContactId = contactId;
  {
    const resolved = await resolveGhlContactId(contactId, lead!.email, lead!.phone);
    if (resolved) {
      resolvedContactId = resolved.resolvedId;
      if (resolvedContactId !== contactId) {
        console.log(`[Webhook/Msg] Contact ID resolved: ${contactId} → ${resolvedContactId}`);
        await updateLeadFields(lead!.id, { ghlContactId: resolvedContactId });
      }
      const enriched = extractContactData(resolved.contact);
      const updates: Record<string, unknown> = {};
      if (!lead!.name && enriched.name) updates.name = enriched.name;
      if (!lead!.email && enriched.email) updates.email = enriched.email;
      if (!lead!.phone && enriched.phone) updates.phone = enriched.phone;
      if (!lead!.businessName && enriched.businessName) updates.businessName = enriched.businessName;
      if (!lead!.source && enriched.source) updates.source = enriched.source;
      if (Object.keys(updates).length > 0) {
        await updateLeadFields(lead!.id, updates);
        console.log(`[Webhook/Msg] Enriched lead ${lead!.id} with: ${Object.keys(updates).join(", ")}`);
        lead = { ...lead!, ...updates } as typeof lead;
      }
    }
  }

  // Store the message
  await addConversation({
    leadId: lead!.id, channel,
    direction: direction === "outbound" ? "outbound" : "inbound",
    messageBody, senderType: direction === "outbound" ? "human" : "lead",
    ghlMessageId: payload.messageId as string,
  });

  await updateLeadFields(lead!.id, { lastMessageAt: new Date() });

  // --- SELF-LEARNING: Attribute this reply to the AI message that caused it ---
  if (direction === "inbound") {
    try {
      const attribution = await attributeReply({
        leadId: lead!.id,
        replyMessage: messageBody,
        replyTimestamp: new Date(),
        channel,
      });
      if (attribution) {
        console.log(`[Webhook/Learn] Reply attributed to audit #${attribution.auditId}: ${attribution.replyMinutes}min, sentiment=${attribution.sentiment}`);
      }
    } catch (err) {
      console.error('[Webhook/Learn] Attribution error (non-fatal):', err);
    }
  }

  // --- AUTO-CORRECTION: Detect confusion in inbound messages ---
  if (direction === "inbound" && detectConfusion(messageBody)) {
    console.log(`[Webhook] Confusion detected from lead ${lead!.id}: "${messageBody.substring(0, 100)}"`);
    let corrFormData: { productType?: string; purpose?: string; timeline?: string } | undefined;
    try {
      const ghlContact = await getContact(contactId);
      if (ghlContact?.customFields) {
        const corrFormFields = extractFormData({ customFields: ghlContact.customFields });
        corrFormData = {
          productType: corrFormFields.find(f => f.label === "Product Type")?.value,
          purpose: corrFormFields.find(f => f.label === "Purpose")?.value,
          timeline: corrFormFields.find(f => f.label === "Timeline")?.value,
        };
      }
    } catch { /* best effort */ }

    const corrected = await handleConfusionReply({
      leadId: lead!.id, contactId, channel, confusionMessage: messageBody, formData: corrFormData,
    });
    if (corrected) console.log(`[Webhook] Auto-correction sent for lead ${lead!.id}`);
  }

  // If outbound from a human agent, mark agent activity
  if (direction === "outbound") {
    await updateLeadFields(lead!.id, { humanTakeover: 1, lastAgentActivityAt: new Date() });
    res.json({ success: true, action: "human_message_logged" });
    return;
  }

  // --- SMART HANDOFF LOGIC ---
  let lastAgentHoursAgo: number | null = null;
  if (lead!.lastAgentActivityAt) {
    const agentTime = new Date(lead!.lastAgentActivityAt).getTime();
    lastAgentHoursAgo = (Date.now() - agentTime) / (1000 * 60 * 60);
  }

  const convHistory = await getConversationHistory(lead!.id, 20);
  let historyStr = convHistory.map((c: any) => `[${c.senderType}/${c.channel}] ${c.messageBody}`).join("\n");

  // MANDATORY CONTEXT: For contacts older than 3 days, ALWAYS pull GHL history
  const leadCreated = lead!.createdAt ? new Date(lead!.createdAt).getTime() : Date.now();
  const leadAgeDays = (Date.now() - leadCreated) / (1000 * 60 * 60 * 24);
  const needsGhlSync = leadAgeDays >= 3 || convHistory.length < 3;

  if (needsGhlSync) {
    try {
      const ghlHistory = await fetchGhlConversationHistory(contactId);
      if (ghlHistory.length > 0) {
        if (convHistory.length === 0) {
          for (const m of ghlHistory) {
            if (!m.body?.trim()) continue;
            const isFormData = m.body.toLowerCase().includes("full name:") && m.body.toLowerCase().includes("phone number:");
            if (isFormData) continue;
            await addConversation({
              leadId: lead!.id, channel: normalizeChannel(m.type || "SMS"),
              direction: m.direction === "outbound" ? "outbound" : "inbound",
              messageBody: m.body, senderType: m.direction === "outbound" ? "human" : "lead",
            });
          }
          console.log(`[Webhook] Synced ${ghlHistory.filter(m => m.body?.trim()).length} GHL messages for lead ${lead!.id} (${leadAgeDays.toFixed(0)} days old)`);
        }
        const ghlHistoryStr = ghlHistory.filter(m => m.body && m.body.trim())
          .map(m => `[${m.direction === "outbound" ? "agent" : "lead"}/${String(m.type || "msg")}] ${m.body}`).join("\n");
        if (ghlHistoryStr) historyStr = `--- Full GHL conversation history (${ghlHistory.length} messages) ---\n${ghlHistoryStr}\n--- Recent local messages ---\n${historyStr}`;
      } else if (leadAgeDays >= 3) {
        historyStr = `--- WARNING: No conversation history found in GHL for this ${leadAgeDays.toFixed(0)}-day-old contact ---\n${historyStr}`;
      }
    } catch (err) {
      console.error(`[Webhook] Failed to fetch GHL history for lead ${lead!.id}:`, err);
      if (leadAgeDays >= 3) historyStr = `--- WARNING: Could not fetch GHL history for this ${leadAgeDays.toFixed(0)}-day-old contact ---\n${historyStr}`;
    }
  }

  const handoffDecision = await shouldHandoffToAgent(historyStr, lastAgentHoursAgo);
  if (handoffDecision.handoff && !handoffDecision.resumeAI) {
    if (lead!.assignedAgent) {
      try {
        await createTask(contactId, {
          title: `💬 New message from ${lead!.name || "lead"} — you're managing this conversation`,
          body: `${lead!.name || "Lead"} replied: "${messageBody.substring(0, 200)}"\n\nReason AI is not responding: ${handoffDecision.reason}`,
          assignedTo: lead!.assignedAgent,
        });
      } catch { /* best effort */ }
    }
    res.json({ success: true, action: "handed_off_to_agent" });
    return;
  }
  if (handoffDecision.resumeAI) await updateLeadFields(lead!.id, { humanTakeover: 0 });
  if (lead!.humanTakeover && !handoffDecision.resumeAI) {
    res.json({ success: true, action: "human_takeover_active" });
    return;
  }

  // --- GLOBAL RATE LIMIT CHECK ---
  const msgRateCheck = await checkRateLimits();
  if (!msgRateCheck.allowed) {
    console.log(`[Webhook] Rate limit hit for lead ${lead!.id}: ${msgRateCheck.reason}`);
    const laterSchedule = await calculateNextFollowUp({ leadId: lead!.id, triggerEvent: "ai_response" });
    await updateLeadFields(lead!.id, { nextFollowUpAt: laterSchedule.nextFollowUpAt });
    res.json({ success: true, action: "rate_limited" });
    return;
  }

  // --- DEDUP GUARD ---
  const recentAiMsgCount = await getRecentAiOutboundCount(lead!.id, 5);
  if (recentAiMsgCount > 0) {
    console.log(`[Webhook] Skipping AI response for lead ${lead!.id} — ${recentAiMsgCount} AI message(s) sent in last 5 min`);
    res.json({ success: true, action: "dedup_cooldown" });
    return;
  }

  // --- CADENCE BACKOFF ---
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
        console.log(`[Webhook] Cadence backoff for lead ${lead!.id} — ${consecutiveUnanswered} unanswered msgs, need ${minGapMinutes}min gap, only ${Math.round(minutesSinceLastSend)}min elapsed`);
        const backoffFollowUp = new Date(Date.now() + (minGapMinutes - minutesSinceLastSend) * 60 * 1000);
        await updateLeadFields(lead!.id, { nextFollowUpAt: backoffFollowUp });
        res.json({ success: true, action: "cadence_backoff" });
        return;
      }
    }
  }

  // --- AI RESPONSE via BRAIN COUNCIL (with LLM failure retry queue) ---
  let aiResponse;
  try {
    aiResponse = await runBrainCouncil({ leadId: lead!.id, incomingMessage: messageBody, channel, externalHistory: historyStr });
  } catch (brainErr) {
    if (isLlmExhausted(brainErr)) {
      // LLM credits exhausted — schedule retry instead of dropping the lead
      const currentRetries = (lead!.cadencePosition || 0); // reuse cadencePosition as retry counter during LLM outage
      const retryDelay = Math.min(LLM_RETRY_DELAY_MS * Math.pow(1.5, Math.min(currentRetries, 5)), 4 * 60 * 60 * 1000); // 15min → 22min → 33min → ... max 4 hours
      const retryAt = new Date(Date.now() + retryDelay);

      console.error(`[Webhook] ⚠️ LLM EXHAUSTED for lead ${lead!.id} (${lead!.name || "Unknown"}). Retry #${currentRetries + 1} scheduled at ${retryAt.toISOString()}`);

      await updateLeadFields(lead!.id, { nextFollowUpAt: retryAt });

      // Log the failure in audit trail
      await addBrainCouncilAudit({
        leadId: lead!.id,
        leadName: lead!.name || undefined,
        channel,
        incomingMessage: messageBody?.substring(0, 2000),
        blocked: 1,
        blockReason: `LLM credits exhausted — auto-retry #${currentRetries + 1} scheduled for ${retryAt.toISOString()}`,
        violationCategory: "llm_exhausted",
        messageSent: 0,
        ownerNotified: 1,
      });

      // Notify owner on first failure or every 5th retry
      if (currentRetries === 0 || currentRetries % 5 === 0) {
        try {
          await notifyOwner({
            title: `⚠️ LLM Credits Exhausted — ${currentRetries === 0 ? "Leads Being Queued" : `${currentRetries} retries so far`}`,
            content: `Brain Council failed for ${lead!.name || "Lead #" + lead!.id} (${messageBody?.substring(0, 100)}). Error: ${String((brainErr as any)?.message || brainErr).substring(0, 200)}. Lead auto-scheduled for retry at ${retryAt.toLocaleString()}. Credits will auto-replenish on your Manus billing cycle.`,
          });
        } catch { /* best effort */ }
      }

      res.json({ success: true, action: "llm_exhausted_retry_queued", retryAt: retryAt.toISOString() });
      return;
    }

    // Non-LLM error — rethrow so the router's catch block handles it
    throw brainErr;
  }

  console.log(`[Webhook] Brain Council for lead ${lead!.id}: QC=${aiResponse.qcScore}, blocked=${aiResponse.blocked}, strategy=${aiResponse.strategyReasoning.substring(0, 80)}`);

  // --- ACCOUNTABILITY: Handle blocked messages ---
  if (aiResponse.blocked && aiResponse.fallbackUsed && aiResponse.fallbackMessage) {
    console.log(`[Webhook] ⚠️ BLOCKED message for lead ${lead!.id}: ${aiResponse.blockReason}. Sending fallback.`);
    const fallbackOpts: Parameters<typeof sendMessage>[1] = channel === "Email"
      ? { type: "Email", subject: "Adorb Custom Tees", html: aiResponse.fallbackMessage, fromName: aiResponse.fromName }
      : { type: channel as "SMS" | "WhatsApp" | "FB" | "IG", message: aiResponse.fallbackMessage };
    const sendResult = await sendMessageWithRetry(resolvedContactId, fallbackOpts, { email: lead!.email, phone: lead!.phone, id: lead!.id });
    if (!sendResult.success) console.error(`[Webhook/Msg] Fallback send failed for lead ${lead!.id}: ${sendResult.error}`);
    await addConversation({ leadId: lead!.id, channel, direction: "outbound", messageBody: `[FALLBACK] ${aiResponse.fallbackMessage}`, senderType: "ai", senderName: aiResponse.fromName });
    res.json({ success: true, action: "blocked_fallback_sent", violation: aiResponse.violationCategory, blockReason: aiResponse.blockReason });
    return;
  }

  // Check if AI wants to hand off
  const aiHandoff = await shouldHandoffToAgent(historyStr + `\n[lead/${channel}] ${messageBody}`, null);
  if (aiHandoff.handoff) {
    const leadInfo = `${lead!.name || "Unknown"} - ${lead!.businessName || "Unknown"} - ${lead!.email || "N/A"}`;
    const [notes, valueEstimate] = await Promise.all([
      generateContactNotes(leadInfo, historyStr + `\n[lead/${channel}] ${messageBody}`),
      estimateOrderValue(historyStr + `\n[lead/${channel}] ${messageBody}`, leadInfo),
    ]);
    try { await addNote(contactId, `🤖 AI Handoff Notes:\n${notes}`); } catch { /* best effort */ }
    if (valueEstimate.estimatedValue > 0 && payload.opportunityId) {
      try { const { updateOpportunityValue } = await import("./ghl"); await updateOpportunityValue(payload.opportunityId as string, valueEstimate.estimatedValue); } catch { /* best effort */ }
    }
    await updateLeadFields(lead!.id, { humanTakeover: 1, lastAgentActivityAt: new Date(), pipelineValue: valueEstimate.estimatedValue });
    if (lead!.assignedAgent) {
      // Assign agent in GHL contact record
      const ghlUserId = AGENT_GHL_USER_IDS[lead!.assignedAgent];
      if (ghlUserId) {
        updateContactAssignment(resolvedContactId, ghlUserId).catch(() => {});
      }
      try {
        await createTask(contactId, {
          title: `🔥 Quote needed: ${lead!.name || lead!.businessName || "Lead"} — Est. $${valueEstimate.estimatedValue}`,
          body: `Lead needs a firm quote. AI has handed off.\n\nReason: ${aiHandoff.reason}\n\n${notes}\n\nEstimated Value: $${valueEstimate.estimatedValue} (${valueEstimate.confidence} confidence)\n${valueEstimate.reasoning}`,
          assignedTo: lead!.assignedAgent,
        });
      } catch { /* best effort */ }
    }
    {
      const handoffOpts: Parameters<typeof sendMessage>[1] = channel === "Email"
        ? { type: "Email", subject: aiResponse.subject || `${aiResponse.fromName} from Adorb`, html: aiResponse.message, fromName: aiResponse.fromName }
        : { type: channel as "SMS" | "WhatsApp" | "FB" | "IG", message: aiResponse.message };
      const sendResult = await sendMessageWithRetry(resolvedContactId, handoffOpts, { email: lead!.email, phone: lead!.phone, id: lead!.id });
      if (sendResult.resolvedContactId !== resolvedContactId) resolvedContactId = sendResult.resolvedContactId;
      if (!sendResult.success) console.error(`[Webhook/Msg] Handoff send failed for lead ${lead!.id}: ${sendResult.error}`);
    }
    await addConversation({ leadId: lead!.id, channel, direction: "outbound", messageBody: aiResponse.message, senderType: "ai", senderName: aiResponse.fromName });
    res.json({ success: true, action: "ai_responded_and_handed_off" });
    return;
  }

  // --- NORMAL AI RESPONSE ---
  {
    const normalOpts: Parameters<typeof sendMessage>[1] = channel === "Email"
      ? { type: "Email", subject: aiResponse.subject || `${aiResponse.fromName} from Adorb`, html: aiResponse.message, fromName: aiResponse.fromName }
      : { type: channel as "SMS" | "WhatsApp" | "FB" | "IG", message: aiResponse.message };
    const sendResult = await sendMessageWithRetry(resolvedContactId, normalOpts, { email: lead!.email, phone: lead!.phone, id: lead!.id });
    if (sendResult.resolvedContactId !== resolvedContactId) resolvedContactId = sendResult.resolvedContactId;
    if (!sendResult.success) console.error(`[Webhook/Msg] Normal send failed for lead ${lead!.id}: ${sendResult.error}`);
  }

  await addConversation({ leadId: lead!.id, channel, direction: "outbound", messageBody: aiResponse.message, senderType: "ai", senderName: aiResponse.fromName });
  await upsertAiState(lead!.id, { lastAngleUsed: aiResponse.angle, lastFrameworkUsed: aiResponse.framework, extractedDates: aiResponse.extractedDates as unknown as undefined, messageCount: undefined });
  await updateLeadFields(lead!.id, { opportunityScore: aiResponse.score, omnisendSegment: aiResponse.segment });
  try { await updateContactCustomField(contactId, [{ id: "opportunity_score", field_value: String(aiResponse.score) }]); } catch { /* custom field may not exist yet */ }

  // Generate notes periodically
  const totalMsgs = convHistory.length;
  if (totalMsgs > 0 && totalMsgs % 5 === 0) {
    try {
      const leadInfo = `${lead!.name || "Unknown"} - ${lead!.businessName || "Unknown"}`;
      const notes = await generateContactNotes(leadInfo, historyStr);
      await addNote(contactId, `🤖 AI Summary (${new Date().toLocaleDateString()}):\n${notes}`);
    } catch { /* best effort */ }
  }

  // Estimate order value after EVERY AI response
  try {
    const fullConvForValue = historyStr + `\n[ai/${channel}] ${aiResponse.message}`;
    const leadInfo = `${lead!.name || "Unknown"} - ${lead!.businessName || "Unknown"} - Stage: ${lead!.pipelineStage}`;
    const valueEstimate = await estimateOrderValue(fullConvForValue, leadInfo);
    if (valueEstimate.estimatedValue > 0) {
      await updateLeadFields(lead!.id, { pipelineValue: valueEstimate.estimatedValue });
      if (payload.opportunityId) {
        try { const { updateOpportunityValue } = await import("./ghl"); await updateOpportunityValue(payload.opportunityId as string, valueEstimate.estimatedValue); } catch { /* best effort */ }
      }
    }
  } catch { /* best effort */ }

  // Calculate next follow-up
  const scheduleResult = await calculateNextFollowUp({ leadId: lead!.id, aiSuggestedHours: aiResponse.nextEngagementHours, triggerEvent: "ai_response" });
  await updateLeadFields(lead!.id, { nextFollowUpAt: scheduleResult.nextFollowUpAt, cadencePosition: scheduleResult.cadencePosition, preferredChannel: scheduleResult.channel, lastOutboundChannel: channel });
  console.log(`[Webhook] Scheduling engine for lead ${lead!.id}: ${scheduleResult.reason}`);

  // --- POST-SEND VALIDATION ---
  if (aiResponse.violationCategory) {
    try {
      const recentAudits = await getBrainCouncilAuditForLead(lead!.id, 1);
      if (recentAudits.length > 0) {
        let corrFormData: { productType?: string; purpose?: string; timeline?: string } | undefined;
        try {
          const ghlContact = await getContact(resolvedContactId);
          if (ghlContact?.customFields) {
            const corrFormFields = extractFormData({ customFields: ghlContact.customFields });
            corrFormData = {
              productType: corrFormFields.find(f => f.label === "Product Type")?.value,
              purpose: corrFormFields.find(f => f.label === "Purpose")?.value,
              timeline: corrFormFields.find(f => f.label === "Timeline")?.value,
            };
          }
        } catch { /* best effort */ }
        await postSendValidation({
          auditId: recentAudits[0].id, leadId: lead!.id, contactId: resolvedContactId, channel,
          sentMessage: aiResponse.message, violationCategory: aiResponse.violationCategory,
          qcScore: aiResponse.qcScore, formData: corrFormData,
        });
      }
    } catch (corrErr) { console.error('[Webhook] Post-send validation error (non-fatal):', corrErr); }
  }

  res.json({ success: true, action: "ai_responded" });
}
