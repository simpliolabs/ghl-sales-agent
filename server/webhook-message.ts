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
  upsertLead, getLeadByGhlContactId, updateLeadFields, addConversation, upsertAiState, getAiState, getLastEmailThreadId, getLastEmailThreadInfo,
  getConversationHistory, getRecentAiOutboundCount, addBrainCouncilAudit, getBrainCouncilAuditForLead,
} from "./db";
import { shouldHandoffToAgent, generateContactNotes, estimateOrderValue, classifySegment } from "./ai-brain";
import { researchLead } from "./lead-researcher";
import { pushContactToOmnisend } from "./omnisend";
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
  formatEmailHtml,
  buildContextSubject,
} from "./webhook-helpers";
import { processInboundState, type ConversationState } from "./conversation-state";
import { dispatchStateActions, buildDispatchContext } from "./action-dispatcher";

export async function handleMessageWebhook(payload: Record<string, unknown>, res: Response) {
  const contactId = payload.contactId as string;
  // Safely coerce body to string — GHL sometimes sends objects/arrays for FB form data
  const rawBody = payload.body ?? payload.message ?? "";
  const messageBody = typeof rawBody === "string" ? rawBody : (typeof rawBody === "object" ? JSON.stringify(rawBody) : String(rawBody));
  // Channel detection: check multiple GHL payload fields for the message type.
  // GHL sends messageType (string), messageTypeId (number), or nests it in message.type (workflow webhooks).
  const rawChannel = (
    payload.messageType ||
    payload.messageTypeId ||
    (typeof payload.message === 'object' && payload.message !== null ? (payload.message as any).type : undefined) ||
    payload.type ||
    "SMS"
  ) as string;
  let channel = normalizeChannel(rawChannel);
  const direction = (payload.direction || "inbound") as string;

  // --- ATTACHMENT DETECTION ---
  // GHL sends attachments with empty/null body. Detect and treat as logo/design file received.
  // Instead of pausing, pass the attachment context to the Brain Council so it can respond intelligently.
  const attachmentUrls = Array.isArray(payload.attachments)
    ? (payload.attachments as string[]).filter(Boolean)
    : [];
  const hasAttachment = attachmentUrls.length > 0 ||
    (typeof payload.body === 'string' && payload.body.trim() === '' && payload.messageType === 'TYPE_ATTACHMENT');
  if (!contactId) { res.status(400).json({ error: "Missing contactId" }); return; }
  // Build the effective message body: use text if present, otherwise synthesize from attachment
  let effectiveMessageBody = messageBody;
  if (hasAttachment && !messageBody) {
    // Lead sent a file with no text
    // Check if a human agent has taken over — if so, stay out of it and let the agent handle it
    const attachLead = await getLeadByGhlContactId(contactId);
    const agentActive = attachLead?.humanTakeover === 1 && attachLead?.lastAgentActivityAt &&
      (Date.now() - new Date(attachLead.lastAgentActivityAt).getTime()) < 24 * 60 * 60 * 1000; // 24hr window (was 2hr)
    if (agentActive) {
      // Human agent is active — log the attachment and stay silent
      if (attachLead) {
        await addConversation({ leadId: attachLead.id, channel, direction: 'inbound', messageBody: '[Attachment received — agent handling]', senderType: 'lead' });
      }
      console.log(`[Webhook/Attachment] Human agent active for ${attachLead?.id} — AI staying silent`);
      res.json({ success: true, action: 'attachment_agent_active' });
      return;
    }
    // AI is in control — treat attachment as logo/design submission and route to Brain Council
    const attachmentDesc = attachmentUrls.length > 0
      ? `[Lead sent a logo/design file: ${attachmentUrls.join(', ')}]`
      : '[Lead sent a logo/design file]';
    effectiveMessageBody = attachmentDesc;
    console.log(`[Webhook/Attachment] AI in control — routing attachment to Brain Council: ${attachmentDesc}`);
  }
  if (!effectiveMessageBody) { res.status(400).json({ error: "Missing data" }); return; }

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

  // --- POST-ENRICHMENT SEGMENT CLASSIFICATION ---
  // If businessName is now available but segment is still NULL, run classification.
  // This catches leads where Contact Created webhook arrived without businessName
  // and the message webhook later enriched it (e.g. lead #690005).
  if (lead!.businessName && !lead!.omnisendSegment) {
    try {
      const segment = await classifySegment(lead!.businessName, lead!.website || undefined);
      const segmentUpdates: Record<string, unknown> = { omnisendSegment: segment };
      try {
        const research = await researchLead({
          name: lead!.name || undefined,
          businessName: lead!.businessName || undefined,
          source: lead!.source || undefined,
          website: lead!.website || undefined,
          segment,
          email: lead!.email || undefined,
        });
        segmentUpdates.researchData = research;
      } catch (resErr) {
        console.error(`[Webhook/Msg] Research failed for lead ${lead!.id}:`, resErr);
      }
      await updateLeadFields(lead!.id, segmentUpdates);
      console.log(`[Webhook/Msg] Post-enrichment segment classification for lead ${lead!.id}: ${segment}`);

      // Push to Omnisend if email available
      if (lead!.email) {
        const nameParts = (lead!.name || "").split(" ");
        await pushContactToOmnisend({
          email: lead!.email,
          firstName: nameParts[0],
          lastName: nameParts.slice(1).join(" "),
          phone: lead!.phone || undefined,
          tags: [segment],
        }).catch(err => console.error(`[Webhook/Msg] Omnisend push failed:`, err));
      }
    } catch (segErr) {
      console.error(`[Webhook/Msg] Segment classification failed for lead ${lead!.id}:`, segErr);
    }
  }

  // --- FB FORM DATA CHANNEL CORRECTION ---
  // If the message body looks like FB lead form data but channel resolved to SMS,
  // correct the channel to FB and update the lead's preferredChannel.
  let correctedChannel = channel;
  if (direction === "inbound" && channel === "SMS") {
    const lower = effectiveMessageBody.toLowerCase();
    const looksLikeFbForm = (lower.includes("full name:") || lower.includes("company name:")) &&
      (lower.includes("phone number:") || lower.includes("email:"));
    if (looksLikeFbForm) {
      correctedChannel = "FB";
      const formUpdates: Record<string, unknown> = { preferredChannel: "FB" };
      // Extract business name from "Company name: ..." field if not already set
      if (!lead!.businessName) {
        const companyMatch = effectiveMessageBody.match(/Company\s*name\s*:\s*(.+)/i);
        if (companyMatch) {
          formUpdates.businessName = companyMatch[1].trim();
          lead = { ...lead!, businessName: companyMatch[1].trim() } as typeof lead;
          console.log(`[Webhook/Msg] Extracted businessName from FB form: "${companyMatch[1].trim()}"`);
        }
      }
      // Extract product type if present
      const productMatch = effectiveMessageBody.match(/(?:What type of products|product[s]?)\s*(?:are you interested in)?\s*[?:]\s*(.+)/i);
      if (productMatch) {
        formUpdates.productType = productMatch[1].trim();
        console.log(`[Webhook/Msg] Extracted productType from FB form: "${productMatch[1].trim()}"`);
      }
      // Extract timeline if present
      const timelineMatch = effectiveMessageBody.match(/How soon do you need your order\s*[?:]\s*(.+)/i);
      if (timelineMatch) {
        formUpdates.eventDate = timelineMatch[1].trim();
        console.log(`[Webhook/Msg] Extracted timeline from FB form: "${timelineMatch[1].trim()}"`);
      }
      await updateLeadFields(lead!.id, formUpdates);
      console.log(`[Webhook/Msg] Corrected channel from SMS → FB for lead ${lead!.id} (FB form data detected in message body)`);
    }
  }
  // CRITICAL: Propagate correctedChannel back to `channel` so ALL downstream logic
  // (Brain Council, QC, send channel) uses the corrected value, not the raw webhook value.
  channel = correctedChannel;

  // Store the message
  await addConversation({
    leadId: lead!.id, channel: correctedChannel,
    direction: direction === "outbound" ? "outbound" : "inbound",
    messageBody: effectiveMessageBody, senderType: direction === "outbound" ? "human" : "lead",
    ghlMessageId: payload.messageId as string,
  });

  await updateLeadFields(lead!.id, { lastMessageAt: new Date() });

  // --- PHASE A: CONVERSATION STATE MACHINE (observation mode) ---
  // Classifies intent and computes state transition for every inbound message.
  // State is persisted to DB but does NOT yet drive routing decisions.
  if (direction === "inbound") {
    try {
      const currentConvState = (lead!.convState || "new_lead") as ConversationState;
      const lastMsgAt = lead!.lastMessageAt ? new Date(lead!.lastMessageAt).getTime() : Date.now();
      const daysSinceLastResponse = (Date.now() - lastMsgAt) / (1000 * 60 * 60 * 24);
      const allChannelsBlocked = !!(lead!.dndSms && lead!.dndEmail && lead!.dndFb && lead!.dndWhatsapp && lead!.dndGmb);
      const quickHistory = (await getConversationHistory(lead!.id, 15))
        .reverse()
        .map((c: any) => `[${c.senderType}/${c.channel}] ${c.messageBody}`)
        .join("\n");

      const stateResult = await processInboundState({
        leadId: lead!.id,
        message: effectiveMessageBody,
        conversationHistory: quickHistory,
        currentState: currentConvState,
        pipelineStage: lead!.pipelineStage || undefined,
        humanTakeover: lead!.humanTakeover === 1,
        daysSinceLastResponse,
        allChannelsBlocked,
        existingIntentHistory: (lead!.intentHistory as any) || [],
      });

      if (stateResult.changed) {
        console.log(`[Webhook/ConvState] Lead ${lead!.id} (${lead!.name || "Unknown"}): ${stateResult.previousState} → ${stateResult.newState} | intent=${stateResult.intent.intent} (${stateResult.intent.confidence}%)`);

        // --- PHASE B: ACTION DISPATCHER ---
        // Translate state transitions into GHL actions (tasks, pipeline moves, notes)
        try {
          const dispatchCtx = buildDispatchContext(lead!, channel);
          const dispatchResult = await dispatchStateActions(stateResult, dispatchCtx);
          if (dispatchResult.actionsExecuted.length > 0) {
            console.log(`[Webhook/Dispatch] Lead ${lead!.id}: ${dispatchResult.actionsExecuted.join(", ")}`);
          }
          if (dispatchResult.errors.length > 0) {
            console.warn(`[Webhook/Dispatch] Lead ${lead!.id}: Errors: ${dispatchResult.errors.join(", ")}`);
          }
        } catch (dispatchErr) {
          // Non-fatal — dispatch errors must never block message processing
          console.error(`[Webhook/Dispatch] Error for lead ${lead!.id} (non-fatal):`, dispatchErr);
        }
      }
    } catch (stateErr) {
      // Non-fatal — state machine errors must never block message processing
      console.error(`[Webhook/ConvState] Error for lead ${lead!.id} (non-fatal):`, stateErr);
    }
  }

  // --- SELF-LEARNING: Attribute this reply to the AI message that caused it ---
  if (direction === "inbound") {
    try {
      const attribution = await attributeReply({
        leadId: lead!.id,
        replyMessage: effectiveMessageBody,
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
  if (direction === "inbound" && detectConfusion(effectiveMessageBody)) {
    console.log(`[Webhook] Confusion detected from lead ${lead!.id}: "${effectiveMessageBody.substring(0, 100)}"`);
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
      leadId: lead!.id, contactId, channel, confusionMessage: effectiveMessageBody, formData: corrFormData,
    });
    if (corrected) console.log(`[Webhook] Auto-correction sent for lead ${lead!.id}`);
  }

  // If outbound, determine if it's a real human agent message or a system/AI message
  if (direction === "outbound") {
    const outBody = effectiveMessageBody.toLowerCase().trim();
    
    // --- SYSTEM MESSAGE DETECTION ---
    // GHL fires outbound webhooks for appointment confirmations, task notifications,
    // and our own AI messages. These should NOT set humanTakeover.
    const OUTBOUND_SYSTEM_PATTERNS = [
      // Appointment/booking notifications
      "appointment", "booking confirmed", "booking cancelled", "new appointment created",
      // Task notifications
      "task created", "task completed", "task assigned",
      // Opportunity lifecycle
      "opportunity created", "opportunity moved", "created in stage", "moved to stage",
      // Workflow/automation
      "workflow", "automation", "triggered by",
      // Our system-generated notes
      "\ud83e\udd16", "[auto]", "[system]", "[ai]",
      // Pipeline
      "pipeline", "stage changed", "status changed",
      // Forms
      "form submitted", "form response",
    ];
    const isSystemOutbound = OUTBOUND_SYSTEM_PATTERNS.some(p => outBody.includes(p));
    
    // Check if this outbound message matches a recent AI message we sent
    const recentConvs = await getConversationHistory(lead!.id, 10);
    const isKnownAiMessage = recentConvs.some((c: any) =>
      c.senderType === "ai" && c.messageBody &&
      c.messageBody.toLowerCase().trim() === outBody
    );
    
    if (isSystemOutbound || isKnownAiMessage) {
      console.log(`[Webhook] Outbound message for lead ${lead!.id} is ${isSystemOutbound ? "system-generated" : "known AI message"} — NOT setting humanTakeover`);
      res.json({ success: true, action: isSystemOutbound ? "system_message_ignored" : "ai_message_echo" });
      return;
    }
    
    // Real human agent message — set humanTakeover
    await updateLeadFields(lead!.id, { humanTakeover: 1, lastAgentActivityAt: new Date() });
    console.log(`[Webhook] Real human outbound for lead ${lead!.id}: "${effectiveMessageBody.substring(0, 80)}" — humanTakeover=1`);
    res.json({ success: true, action: "human_message_logged" });
    return;
  }

  // --- SMART HANDOFF LOGIC ---
  let lastAgentHoursAgo: number | null = null;
  if (lead!.lastAgentActivityAt) {
    const agentTime = new Date(lead!.lastAgentActivityAt).getTime();
    lastAgentHoursAgo = (Date.now() - agentTime) / (1000 * 60 * 60);
  }

  const convHistory = await getConversationHistory(lead!.id, 50);
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

        // FIX: Detect human agent outbound messages from GHL history (bypasses webhook gap)
        // GHL does NOT fire outbound webhooks for messages sent via the GHL UI.
        // We must detect them here and set humanTakeover proactively.
        const AGENT_TAKEOVER_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
        const recentAgentMsg = ghlHistory
          .filter(m => m.direction === "outbound" && m.body?.trim() && m.dateAdded)
          .filter(m => {
            const msgAge = Date.now() - new Date(m.dateAdded).getTime();
            return msgAge < AGENT_TAKEOVER_WINDOW_MS;
          })
          // Exclude messages that are clearly AI-generated or GHL system messages
          .filter(m => {
            const body = (m.body || "").toLowerCase().trim();
            // GHL system messages — comprehensive list to prevent false positives
            const SYSTEM_PATTERNS = [
              // Opportunity lifecycle
              "opportunity created", "opportunity moved", "opportunity updated",
              "opportunity deleted", "created in stage", "moved to stage",
              // Workflow & automation
              "workflow", "automation", "triggered by", "action executed",
              // Tasks
              "task created", "task completed", "task assigned", "task updated",
              // Appointments
              "appointment", "booking confirmed", "booking cancelled",
              // Forms & submissions
              "form submitted", "form response", "survey submitted",
              // Tags & lists
              "tag added", "tag removed", "added to list", "removed from list",
              // Notes & pipeline
              "note added", "pipeline", "stage changed", "status changed",
              // Payments & invoices
              "payment received", "invoice sent", "invoice paid",
              // Contact lifecycle
              "contact created", "contact updated", "contact merged",
              // Facebook lead form data (structured form fields)
              "company name:", "full name:", "phone number:", "what type of products",
              "what do you need bulk printing", "how soon do you need",
              // GHL internal
              "view opportunity", "bulk printing pipeline",
            ];
            const isSystemMsg = SYSTEM_PATTERNS.some(p => body.includes(p)) ||
              body.length < 10 || // Too short to be a real agent message (raised from 5)
              body.length > 500 || // System dumps / form data are usually long
              (m as any).messageType === "TYPE_ACTIVITY" ||
              (m as any).contentType === "activity" ||
              (m as any).type === 0 || // GHL type 0 = system/activity
              (m as any).type === "0" ||
              // FB form data pattern: multiple "label: value" lines
              (body.split("\n").filter((l: string) => l.includes(":")).length >= 3);
            if (isSystemMsg) return false;
            // If message body matches a recent AI outbound in our DB, it's AI — not a human agent
            const isKnownAiMsg = convHistory.some((c: any) =>
              c.senderType === "ai" && c.messageBody?.toLowerCase().trim() === body
            );
            return !isKnownAiMsg;
          })
          .sort((a, b) => new Date(b.dateAdded).getTime() - new Date(a.dateAdded).getTime())[0];

        if (recentAgentMsg && !lead!.humanTakeover) {
          const agentMsgTime = new Date(recentAgentMsg.dateAdded);
          console.log(`[Webhook] 🕵️ GHL history scan detected human agent message at ${agentMsgTime.toISOString()} — setting humanTakeover=1 for lead ${lead!.id}`);
          await updateLeadFields(lead!.id, { humanTakeover: 1, lastAgentActivityAt: agentMsgTime });
          lead = { ...lead!, humanTakeover: 1, lastAgentActivityAt: agentMsgTime };
          lastAgentHoursAgo = (Date.now() - agentMsgTime.getTime()) / (1000 * 60 * 60);
        }

        // ============================================================
        // NOT-INTERESTED DETECTION in GHL history
        // Agent notes like "Business Name - not interested" should permanently
        // retire the lead from automated outreach, regardless of age.
        // ============================================================
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
        const notInterestedMsg = ghlHistory
          .filter(m => m.direction === "outbound" && m.body?.trim())
          .find(m => NOT_INTERESTED_PATTERNS.some(p => p.test(m.body || "")));
        if (notInterestedMsg && !lead!.humanTakeover) {
          console.log(`[Webhook] \u{1F6D1} NOT-INTERESTED detected in GHL history for lead ${lead!.id}: "${String(notInterestedMsg.body).substring(0, 80)}". Setting humanTakeover=1.`);
          await updateLeadFields(lead!.id, { humanTakeover: 1 });
          lead = { ...lead!, humanTakeover: 1 };
          // Abort processing — do not send any message to this lead
          res.json({ success: true, action: "not_interested_detected" });
          return;
        }

        // Surface order/payment status as a CONTEXT ALERT
        const ORDER_STATUS_KEYWORDS = ["paid", "invoice", "deposit", "payment", "proof", "approved", "mockup", "design", "order confirmed", "receipt"];
        const paymentMessages = ghlHistory.filter(m => {
          const body = (m.body || "").toLowerCase();
          return ORDER_STATUS_KEYWORDS.some(kw => body.includes(kw));
        });
        let orderContextAlert = "";
        if (paymentMessages.length > 0) {
          const latestPayment = paymentMessages[paymentMessages.length - 1];
          orderContextAlert = `\n⚠️ ORDER STATUS ALERT: This conversation contains payment/order messages. Latest: "${latestPayment.body.substring(0, 150)}" (${new Date(latestPayment.dateAdded).toLocaleDateString()})\n`;
        }

        const ghlHistoryStr = ghlHistory.filter(m => m.body && m.body.trim())
          .map(m => `[${m.direction === "outbound" ? "agent" : "lead"}/${String(m.type || "msg")}] ${m.body}`).join("\n");
        if (ghlHistoryStr) historyStr = `--- Full GHL conversation history (${ghlHistory.length} messages) ---\n${ghlHistoryStr}\n${orderContextAlert}--- Recent local messages ---\n${historyStr}`;
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
          body: `${lead!.name || "Lead"} replied: "${effectiveMessageBody.substring(0, 200)}"\n\nReason AI is not responding: ${handoffDecision.reason}`,
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

  // --- TCPA QUIET HOURS GATE (inbound SMS response) ---
  const { isSmsQuietHours, nextSmsWindowStart } = await import("./scheduling-engine");
  if (isSmsQuietHours() && channel === "SMS" && !lead!.email) {
    // SMS-only lead during quiet hours — defer, don't respond
    console.log(`[Webhook] ⚠️ TCPA quiet hours — deferring SMS response for lead ${lead!.id}`);
    await updateLeadFields(lead!.id, { nextFollowUpAt: nextSmsWindowStart() });
    res.json({ success: true, action: "tcpa_deferred", leadId: lead!.id });
    return;
  }

  // --- AI RESPONSE via BRAIN COUNCIL ---
  // ALL send/no-send decisions (offline, lock, humanTakeover, dedup) are made INSIDE runBrainCouncil.
  let aiResponse;
  try {
    aiResponse = await runBrainCouncil({ leadId: lead!.id, incomingMessage: effectiveMessageBody, channel, externalHistory: historyStr });
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
        incomingMessage: effectiveMessageBody?.substring(0, 2000),
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
            content: `Brain Council failed for ${lead!.name || "Lead #" + lead!.id} (${effectiveMessageBody?.substring(0, 100)}). Error: ${String((brainErr as any)?.message || brainErr).substring(0, 200)}. Lead auto-scheduled for retry at ${retryAt.toLocaleString()}. Credits will auto-replenish on your Manus billing cycle.`,
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
    const fallbackChannel = normalizeChannel(aiResponse.channel || channel);
    const fallbackSubject = aiResponse.subject || buildContextSubject({ name: lead!.name, businessName: lead!.businessName }, aiResponse.fromName);
    const fallbackOpts: Parameters<typeof sendMessage>[1] = fallbackChannel === "Email"
      ? { type: "Email", subject: fallbackSubject, html: formatEmailHtml(aiResponse.fallbackMessage), fromName: aiResponse.fromName }
      : { type: fallbackChannel as "SMS" | "WhatsApp" | "FB" | "IG", message: aiResponse.fallbackMessage };
    const sendResult = await sendMessageWithRetry(resolvedContactId, fallbackOpts, { email: lead!.email, phone: lead!.phone, id: lead!.id });
    if (sendResult.success) {
      await addConversation({ leadId: lead!.id, channel: fallbackChannel, direction: "outbound", messageBody: `[FALLBACK] ${aiResponse.fallbackMessage}`, senderType: "ai", senderName: aiResponse.fromName });
    } else {
      console.error(`[Webhook/Msg] Fallback send FAILED for lead ${lead!.id}: ${sendResult.error} — conversation NOT stored`);
    }
    res.json({ success: true, action: sendResult.success ? "blocked_fallback_sent" : "blocked_fallback_failed", violation: aiResponse.violationCategory, blockReason: aiResponse.blockReason });
    return;
  }

  // --- PRE-FLIGHT ABORT: Brain decided not to send (offline, locked, already responded, humanTakeover) ---
  if (aiResponse.blocked) {
    console.log(`[Webhook] Brain ABORTED for lead ${lead!.id}: ${aiResponse.blockReason}`);
    res.json({ success: true, action: "brain_aborted", reason: aiResponse.blockReason });
    return;
  }

  // Check if AI wants to hand off
  const aiHandoff = await shouldHandoffToAgent(historyStr + `\n[lead/${channel}] ${effectiveMessageBody}`, null);
  if (aiHandoff.handoff) {
    const leadInfo = `${lead!.name || "Unknown"} - ${lead!.businessName || "Unknown"} - ${lead!.email || "N/A"}`;
    const [notes, valueEstimate] = await Promise.all([
      generateContactNotes(leadInfo, historyStr + `\n[lead/${channel}] ${effectiveMessageBody}`),
      estimateOrderValue(historyStr + `\n[lead/${channel}] ${effectiveMessageBody}`, leadInfo),
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
    // Use Brain Council's channel for handoff too
    const handoffChannel = normalizeChannel(aiResponse.channel || channel);
    {
      const handoffSubject = aiResponse.subject || buildContextSubject({ name: lead!.name, businessName: lead!.businessName }, aiResponse.fromName);
      const handoffOpts: Parameters<typeof sendMessage>[1] = handoffChannel === "Email"
        ? { type: "Email", subject: handoffSubject, html: formatEmailHtml(aiResponse.message), fromName: aiResponse.fromName }
        : { type: handoffChannel as "SMS" | "WhatsApp" | "FB" | "IG", message: aiResponse.message };
      const sendResult = await sendMessageWithRetry(resolvedContactId, handoffOpts, { email: lead!.email, phone: lead!.phone, id: lead!.id });
      if (sendResult.resolvedContactId !== resolvedContactId) resolvedContactId = sendResult.resolvedContactId;
      if (sendResult.success) {
        await addConversation({ leadId: lead!.id, channel: handoffChannel, direction: "outbound", messageBody: aiResponse.message, senderType: "ai", senderName: aiResponse.fromName });
      } else {
        console.error(`[Webhook/Msg] Handoff send FAILED for lead ${lead!.id}: ${sendResult.error} — conversation NOT stored`);
      }
    }
    res.json({ success: true, action: "ai_responded_and_handed_off" });
    return;
  }

  // --- TCPA POST-DECISION GATE: Block SMS if quiet hours (Brain Council may have chosen SMS) ---
  if (isSmsQuietHours() && normalizeChannel(aiResponse.channel || channel) === "SMS") {
    if (lead!.email) {
      // Switch to email
      console.log(`[Webhook] TCPA gate: switching Brain Council SMS to Email for lead ${lead!.id}`);
      aiResponse = { ...aiResponse, channel: "Email" };
    } else {
      // Defer
      console.log(`[Webhook] TCPA gate: deferring SMS for lead ${lead!.id}`);
      await updateLeadFields(lead!.id, { nextFollowUpAt: nextSmsWindowStart() });
      res.json({ success: true, action: "tcpa_deferred", leadId: lead!.id });
      return;
    }
  }

  // --- NORMAL AI RESPONSE ---
  // Use Brain Council's channel recommendation if available, otherwise fall back to inbound channel.
  // This prevents FB→SMS mismatch when normalizeChannel can't detect the inbound type.
  const sendChannel = normalizeChannel(aiResponse.channel || channel);
  if (sendChannel !== channel) {
    console.log(`[Webhook/Msg] Channel adjusted for lead ${lead!.id}: inbound=${channel} → send=${sendChannel} (Brain Council recommended: ${aiResponse.channel})`);
  }
  let normalSendResult: { success: boolean; resolvedContactId: string; emailMessageId?: string; error?: string };
  {
    // Email threading: look up prior email thread ID and subject for reply threading
    let emailThreadId: string | null = null;
    let priorEmailSubject: string | null = null;
    if (sendChannel === "Email") {
      const threadInfo = await getLastEmailThreadInfo(lead!.id);
      emailThreadId = threadInfo?.threadId || null;
      priorEmailSubject = threadInfo?.subject || null;
      if (emailThreadId) console.log(`[Webhook/Msg] Threading email reply for lead ${lead!.id} (threadId: ${emailThreadId}, priorSubject: ${priorEmailSubject})`);
    }
    let normalSubject = aiResponse.subject || buildContextSubject({ name: lead!.name, businessName: lead!.businessName }, aiResponse.fromName);
    if (emailThreadId && priorEmailSubject) {
      normalSubject = priorEmailSubject.startsWith("Re:") ? priorEmailSubject : `Re: ${priorEmailSubject}`;
    }
    const normalOpts: Parameters<typeof sendMessage>[1] = sendChannel === "Email"
      ? { type: "Email", subject: normalSubject, html: formatEmailHtml(aiResponse.message), fromName: aiResponse.fromName, ...(emailThreadId ? { threadId: emailThreadId, replyMessageId: emailThreadId } : {}) }
      : { type: sendChannel as "SMS" | "WhatsApp" | "FB" | "IG", message: aiResponse.message };
    normalSendResult = await sendMessageWithRetry(resolvedContactId, normalOpts, { email: lead!.email, phone: lead!.phone, id: lead!.id });
    if (normalSendResult.resolvedContactId !== resolvedContactId) resolvedContactId = normalSendResult.resolvedContactId;
    if (!normalSendResult.success) console.error(`[Webhook/Msg] Normal send failed for lead ${lead!.id}: ${normalSendResult.error}`);
  }

  if (normalSendResult.success) {
    await addConversation({ leadId: lead!.id, channel: sendChannel, direction: "outbound", messageBody: aiResponse.message, senderType: "ai", senderName: aiResponse.fromName, emailMessageId: normalSendResult.emailMessageId || undefined });
  } else {
    console.error(`[Webhook/Msg] Normal send FAILED for lead ${lead!.id}: ${normalSendResult.error} — conversation NOT stored`);
  }
  // Increment messageCount so cadence backoff works correctly
  const currentAiStateForCount = await getAiState(lead!.id);
  const newMsgCount = ((currentAiStateForCount as any)?.messageCount || 0) + 1;
  await upsertAiState(lead!.id, { lastAngleUsed: aiResponse.angle, lastFrameworkUsed: aiResponse.framework, extractedDates: aiResponse.extractedDates as unknown as undefined, messageCount: newMsgCount });
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

  // Clear admin override fields after the override has been consumed
  if (lead!.overrideBy) {
    await updateLeadFields(lead!.id, { overrideBy: null, overrideAt: null, overrideReason: null } as any);
    console.log(`[Webhook] Cleared consumed admin override for lead ${lead!.id}`);
  }
  // Calculate next follow-up
  const scheduleResult = await calculateNextFollowUp({ leadId: lead!.id, aiSuggestedHours: aiResponse.nextEngagementHours, triggerEvent: "ai_response" });
  await updateLeadFields(lead!.id, { nextFollowUpAt: scheduleResult.nextFollowUpAt, cadencePosition: scheduleResult.cadencePosition, preferredChannel: scheduleResult.channel, lastOutboundChannel: sendChannel });
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
