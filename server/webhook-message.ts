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
  findExistingLeadByIdentity,
} from "./db";
import { shouldHandoffToAgent, generateContactNotes, estimateOrderValue, classifySegment } from "./ai-brain";
import { researchLead } from "./lead-researcher";
import { pushContactToOmnisend } from "./omnisend";
import { runBrainCouncil } from "./brain-adapter";
import { calculateNextFollowUp, checkRateLimits } from "./scheduling-engine";
import { sendMessage, updateContactCustomField, addNote, fetchGhlConversationHistory, getContact, updateContactAssignment, AGENT_GHL_USER_IDS } from "./ghl";
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
import { shouldDeferResponse, getDeferredSendAt } from "./deferred-response-processor";
import { insertDeferredResponse, hasPendingDeferredResponse } from "./db";

/**
 * Foundation C.1: Coerce a GHL payload body field to a meaningful string.
 * Returns empty string for null/undefined/empty-object/empty-array inputs
 * so they don't poison the conversations table as literal "{}" rows.
 */
export function coerceWebhookBody(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    const stringified = JSON.stringify(raw);
    return (stringified === "{}" || stringified === "[]" || stringified === "null") ? "" : stringified;
  }
  return String(raw);
}

/**
 * Foundation C.2: Classify the content of an inbound webhook message.
 * Real customer messages → brain processes them.
 * System/promo/auto-generated content → stored for audit but excluded from brain context.
 */
export type InboundContentKind =
  | "real_message"        // Genuine customer message — brain processes normally
  | "channel_promo"       // WhatsApp channel share, group invite, etc.
  | "form_data"           // FB lead form submission
  | "link_only"           // Message body is just a URL with no real text
  | "sticker_or_reaction" // Empty/whitespace body with only attachment
  | "auto_generated";     // System-generated content from the messaging platform

export function classifyInboundContent(
  body: string,
  channel: string,
  payload: Record<string, unknown>
): { kind: InboundContentKind; reason: string } {
  const trimmed = body.trim();
  const lower = trimmed.toLowerCase();

  // 1. Empty/whitespace + has attachment → sticker/reaction
  const hasAttachment = Array.isArray(payload.attachments) && (payload.attachments as string[]).length > 0;
  if (!trimmed && hasAttachment) {
    return { kind: "sticker_or_reaction", reason: "empty body with attachment" };
  }

  // 2. WhatsApp channel promo / group invite
  const WHATSAPP_PROMO_PATTERNS = [
    /follow the .{1,80} channel on whatsapp\s*:?\s*https:\/\/whatsapp\.com\/channel\//i,
    /join (my |our |the )?(group|channel)\s*:?\s*https:\/\/chat\.whatsapp\.com\//i,
    /https:\/\/whatsapp\.com\/channel\/[a-z0-9]+/i,
  ];
  if (channel === "WhatsApp" && WHATSAPP_PROMO_PATTERNS.some(p => p.test(trimmed))) {
    return { kind: "channel_promo", reason: "WhatsApp channel/group share detected" };
  }

  // 3. FB form data (existing pattern, formalized)
  const isFormData = (lower.includes("full name:") || lower.includes("company name:")) &&
    (lower.includes("phone number:") || lower.includes("email:") || lower.includes("what type of products"));
  if (isFormData) {
    return { kind: "form_data", reason: "FB lead form structured data" };
  }

  // 4. Link-only message (URL with no real text around it)
  const withoutUrls = trimmed.replace(/https?:\/\/\S+/g, "").trim();
  if (trimmed.match(/https?:\/\//) && withoutUrls.length < 5) {
    return { kind: "link_only", reason: "URL with no surrounding text" };
  }

  // 5. Generic auto-generated patterns (extensible)
  const AUTO_GENERATED_PATTERNS = [
    /^(joined|left) the (group|channel)$/i,
    /^.{1,30} (joined|left|added you)$/i,
    /^missed (call|video call)$/i,
    /^this message was deleted$/i,
  ];
  if (AUTO_GENERATED_PATTERNS.some(p => p.test(trimmed))) {
    return { kind: "auto_generated", reason: "platform-generated system message" };
  }

  // Default: real customer message
  return { kind: "real_message", reason: "passed all classifiers" };
}

export async function handleMessageWebhook(payload: Record<string, unknown>, res: Response) {
  // Foundation C.1.1: Synthetic verification short-circuit.
  // Payloads with contactId starting with "__synth__" bypass all real processing
  // (no lead creation, no conversation writes, no GHL calls).
  // They still exercise the coercion logic so synthetic tests can verify guard behavior.
  if (typeof payload.contactId === "string" && payload.contactId.startsWith("__synth__")) {
    const synthRaw = payload.body ?? payload.message ?? "";
    const synthBody = coerceWebhookBody(synthRaw);
    const synthChannel = (payload.messageType as string) || "SMS";
    console.log(`[Webhook/Msg] Synthetic test webhook for ${payload.contactId} — short-circuiting`);
    if (!synthBody.trim()) {
      res.json({ success: true, action: "empty_body_skipped", synthetic: true });
    } else {
      // Foundation C.2: also run classifier in synthetic path so Tests 6+7 can verify it
      const synthClass = classifyInboundContent(synthBody, synthChannel, payload);
      if (synthClass.kind !== "real_message") {
        res.json({ success: true, action: "non_real_message_skipped", contentKind: synthClass.kind, reason: synthClass.reason, synthetic: true });
      } else {
        res.json({ success: true, action: "synthetic_real_content_accepted", contentKind: "real_message", synthetic: true, bodyLength: synthBody.length });
      }
    }
    return;
  }

  const contactId = payload.contactId as string;
  // Foundation C.1: Safely coerce body to string — GHL sometimes sends objects/arrays.
  // coerceWebhookBody returns empty string for {}/{}/null so they don't poison conversations.
  const rawBody = payload.body ?? payload.message ?? "";
  const messageBody = coerceWebhookBody(rawBody);
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
  // Foundation C.1.1: Empty-body guard moved BEFORE any conversation-write branch.
  // Covers both inbound and outbound directions — previously this check was AFTER the
  // outbound addConversation write, allowing {} rows to be written for outbound webhooks.
  if (!effectiveMessageBody || !effectiveMessageBody.trim()) {
    // Empty body after coercion typically means GHL sent a metadata/activity webhook
    // (note, opportunity update, etc.) where meaningful content lives elsewhere.
    // Don't write a conversation row — silently acknowledge so GHL doesn't retry.
    console.warn(`[Webhook/Msg] Empty body for contact ${contactId} direction=${direction} (likely GHL metadata/activity webhook). Payload keys: ${Object.keys(payload).join(",")}`);
    res.json({ success: true, action: "empty_body_skipped" });
    return;
  }

  // Foundation C.2: Classify inbound content before lead resolution.
  // Non-real-message rows are still stored for audit but excluded from brain context.
  let contentClass: { kind: InboundContentKind; reason: string } = { kind: "real_message", reason: "default" };
  if (direction === "inbound") {
    contentClass = classifyInboundContent(effectiveMessageBody, channel, payload);
    if (contentClass.kind !== "real_message") {
      console.warn(`[Webhook/Msg] C.2: classified as '${contentClass.kind}' (${contentClass.reason}) for contact ${contactId} — storing for audit, skipping brain`);
    }
  }

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

  // --- FIX 12: DUPLICATE LEAD DEDUP ---
  // GHL sometimes sends different contact IDs for the same person (e.g., ContactCreate
  // fires with ID "A" and InboundMessage fires with ID "B" within 1 second).
  // After enrichment, check if there's already a lead with the same email or phone
  // but a different ghlContactId. If so, merge into the canonical (older) lead.
  try {
    const effectiveEmail = lead!.email;
    const effectivePhone = lead!.phone;
    const existingLead = await findExistingLeadByIdentity(
      effectiveEmail,
      effectivePhone,
      resolvedContactId,
    );
    if (existingLead) {
      console.log(`[Webhook/Msg] \u26A0\uFE0F DUPLICATE DETECTED: lead ${lead!.id} (ghl=${resolvedContactId}) matches existing lead ${existingLead.id} (ghl=${existingLead.ghlContactId}) by email/phone. Merging into canonical lead ${existingLead.id}.`);
      // Update the canonical lead with any new data from this webhook
      const mergeUpdates: Record<string, unknown> = {};
      const canonicalLead = await getLeadByGhlContactId(existingLead.ghlContactId!);
      if (canonicalLead) {
        if (!canonicalLead.name && lead!.name) mergeUpdates.name = lead!.name;
        if (!canonicalLead.email && lead!.email) mergeUpdates.email = lead!.email;
        if (!canonicalLead.phone && lead!.phone) mergeUpdates.phone = lead!.phone;
        if (!canonicalLead.businessName && lead!.businessName) mergeUpdates.businessName = lead!.businessName;
        if (Object.keys(mergeUpdates).length > 0) {
          await updateLeadFields(existingLead.id, mergeUpdates);
          console.log(`[Webhook/Msg] Merged fields into canonical lead ${existingLead.id}: ${Object.keys(mergeUpdates).join(", ")}`);
        }
        // Switch to the canonical lead for the rest of this webhook
        lead = { ...canonicalLead, ...mergeUpdates } as typeof lead;
        resolvedContactId = existingLead.ghlContactId!;
      }
    }
  } catch (dedupErr) {
    // Non-fatal — if dedup fails, continue with the current lead
    console.error(`[Webhook/Msg] Dedup check failed (non-fatal):`, dedupErr);
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

  // --- FB FORM DATA DETECTION ---
  // Detect if this inbound message is actually Facebook form data (not a real reply).
  // Form data contains structured fields like "Full name:", "Company name:", "Phone number:", "Email:".
  // This flag is used downstream to prevent treating form data as a genuine reply.
  const _lower = effectiveMessageBody.toLowerCase();
  const isFormDataMessage = direction === "inbound" && (
    (_lower.includes("full name:") || _lower.includes("company name:")) &&
    (_lower.includes("phone number:") || _lower.includes("email:") || _lower.includes("what type of products"))
  );

  // --- FB FORM DATA CHANNEL CORRECTION ---
  // If the message body looks like FB lead form data but channel resolved to SMS,
  // correct the channel to FB and update the lead's preferredChannel.
  let correctedChannel = channel;
  if (direction === "inbound" && channel === "SMS") {
    const lower = _lower;
    const looksLikeFbForm = isFormDataMessage;
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
      // Extract email if present and not already on lead
      if (!lead!.email) {
        const emailMatch = effectiveMessageBody.match(/Email\s*:\s*([\w.+-]+@[\w.-]+\.[a-zA-Z]{2,})/i);
        if (emailMatch) {
          formUpdates.email = emailMatch[1].trim();
          lead = { ...lead!, email: emailMatch[1].trim() } as typeof lead;
          console.log(`[Webhook/Msg] Extracted email from FB form: "${emailMatch[1].trim()}"`);
        }
      }
      // Extract phone if present and not already on lead
      if (!lead!.phone) {
        const phoneMatch = effectiveMessageBody.match(/Phone\s*(?:number)?\s*:\s*([\d()\s.+-]{7,})/i);
        if (phoneMatch) {
          formUpdates.phone = phoneMatch[1].trim();
          lead = { ...lead!, phone: phoneMatch[1].trim() } as typeof lead;
          console.log(`[Webhook/Msg] Extracted phone from FB form: "${phoneMatch[1].trim()}"`);
        }
      }
      // Extract full name if present and not already on lead
      if (!lead!.name) {
        const nameMatch = effectiveMessageBody.match(/Full\s*name\s*:\s*(.+)/i);
        if (nameMatch) {
          formUpdates.name = nameMatch[1].trim();
          lead = { ...lead!, name: nameMatch[1].trim() } as typeof lead;
          console.log(`[Webhook/Msg] Extracted name from FB form: "${nameMatch[1].trim()}"`);
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

  // Store the message — capture emailMessageId for threading
  // GHL may provide emailMessageId directly, or we use messageId as fallback for emails
  const inboundEmailMsgId = (payload.emailMessageId as string) || (channel === "Email" ? (payload.messageId as string) : undefined);
  if (direction === 'outbound') {
    // Real-time outbound webhook (rare — GHL doesn't usually fire these)
    await addConversation({
      leadId: lead!.id, channel: correctedChannel,
      direction: 'outbound', senderType: 'human',
      messageBody: effectiveMessageBody,
      ghlMessageId: (payload.messageId as string) ?? '',
      recorded_from: 'ghl_history_sync',
      observedAt: new Date(),
    });
  } else {
    await addConversation({
      leadId: lead!.id, channel: correctedChannel,
      direction: 'inbound', senderType: 'lead',
      messageBody: effectiveMessageBody,
      ghlMessageId: payload.messageId as string,
      emailMessageId: inboundEmailMsgId || undefined,
      contentKind: contentClass.kind, // Foundation C.2: persist classification for brain filter
    });
  }

  await updateLeadFields(lead!.id, { lastMessageAt: new Date() });

  // REMOVED (Fix 11): Migrated lead re-engagement detection — one-time migration is complete.

  // --- INBOUND REPLY: Create appointment/task if missing ---
  // If a lead sends an inbound message but has NO appointment or task yet,
  // create one immediately. This covers transferred contacts, leads where
  // first-contact notification failed, and any other gap.
  // GUARD: Never create appointments for lost/disqualified leads.
  // Note: GHL may send stage names with capital letters (e.g. "Lost"), so compare case-insensitively.
  const LOST_STAGES_MSG = new Set(["not_qualified", "lost", "dnc", "competitor_won"]);
  const isLostLead = lead?.pipelineStage ? LOST_STAGES_MSG.has(lead.pipelineStage.toLowerCase()) : false;
  if (direction === "inbound" && lead && lead.ghlContactId && (!lead.appointmentId || !lead.ghlTaskId) && !isLostLead) {
    try {
      const { createHeadsUpNotification } = await import("./agent-notifications");
      const notifCtx = {
        leadId: lead.id,
        ghlContactId: lead.ghlContactId!,
        leadName: lead.name,
        businessName: lead.businessName,
        email: lead.email,
        phone: lead.phone,
        assignedAgent: lead.assignedAgent,
        pipelineValue: lead.pipelineValue,
        channel,
        pipelineStage: lead.pipelineStage || null,
        existingAppointmentId: lead.appointmentId || null,
        existingTaskId: lead.ghlTaskId || null,
      };
      const notifResult = await createHeadsUpNotification(notifCtx, `Inbound reply: "${effectiveMessageBody.substring(0, 60)}"`);
      if (notifResult.actions.length > 0) {
        console.log(`[Webhook/Msg] \u2705 Created missing appointment/task for lead ${lead.id} on inbound reply: ${notifResult.actions.join(", ")}`);
      }
    } catch (notifErr) {
      console.error(`[Webhook/Msg] Failed to create appointment/task for lead ${lead.id} on inbound reply (non-fatal):`, notifErr);
    }
  }

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
      "details updated", "has been scheduled", "has been booked", "calendar event",
      "scheduled for", "confirmed for", "rescheduled", "consultation:",
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
      // GHL internal activity cards (non-message events that fire as outbound webhooks)
      "activity", "note added", "tag added", "tag removed",
    ];
    // Also detect GHL system-generated messages by checking if the webhook has no real userId
    // or if the message type indicates it's a system notification (not a typed human message)
    const messageType = String(payload.messageType || payload.type || "").toLowerCase();
    const isGhlSystemType = ["type_activity", "type_call", "type_note"].includes(messageType);
    const isSystemOutbound = OUTBOUND_SYSTEM_PATTERNS.some(p => outBody.includes(p)) || isGhlSystemType;
    
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
    
    // Real human agent message — save to conversations AND set humanTakeover
    // Extract agent name from payload if available (GHL sends userId/userName on outbound)
    const agentName = (payload.userName as string) || (payload.userId as string) || "Agent";
    await addConversation({
      leadId: lead!.id,
      channel: correctedChannel,
      direction: 'outbound',
      senderType: 'human',
      messageBody: effectiveMessageBody,
      senderName: agentName,
      ghlMessageId: (payload.messageId as string) ?? '',
      recorded_from: 'ghl_history_sync',
      observedAt: new Date(),
    });
    await updateLeadFields(lead!.id, { humanTakeover: 1, lastAgentActivityAt: new Date(), lastMessageAt: new Date() });
    console.log(`[Webhook] Real human outbound for lead ${lead!.id} by ${agentName}: "${effectiveMessageBody.substring(0, 80)}" — humanTakeover=1, saved to conversations`);
    res.json({ success: true, action: "human_message_logged" });
    return;
  }

  // --- SMART HANDOFF LOGIC ---
  // SAFETY NET: If humanTakeover=1 but there are NO actual human outbound messages
  // in our conversations table, this was likely a false positive from a GHL system message.
  // Auto-release the lead so the AI can respond.
  if (lead!.humanTakeover === 1 && lead!.pipelineStage !== "not_qualified") {
    const recentConvsCheck = await getConversationHistory(lead!.id, 20);
    const hasRealHumanOutbound = recentConvsCheck.some((c: any) =>
      c.direction === "outbound" && c.senderType === "human"
    );
    if (!hasRealHumanOutbound) {
      console.log(`[Webhook] SAFETY NET: Lead ${lead!.id} has humanTakeover=1 but NO human outbound messages found. Auto-releasing.`);
      await updateLeadFields(lead!.id, { humanTakeover: 0, lastAgentActivityAt: null });
      lead = { ...lead!, humanTakeover: 0, lastAgentActivityAt: null } as typeof lead;
    }
  }
  let lastAgentHoursAgo: number | null = null;
  if (lead!.lastAgentActivityAt) {
    const agentTime = new Date(lead!.lastAgentActivityAt).getTime();
    lastAgentHoursAgo = (Date.now() - agentTime) / (1000 * 60 * 60);
  }

  // Foundation C.2: Exclude non-real-message rows from brain context.
  // NULL contentKind = pre-migration rows, treated as real_message for backward compat.
  const convHistory = await getConversationHistory(lead!.id, 50, { excludeNonReal: true });
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
            // Foundation C.1: Coerce m.body using the same logic as the top-of-handler coercion.
            const histBody = coerceWebhookBody(m.body);
            if (!histBody.trim()) continue;
            const isFormData = histBody.toLowerCase().includes("full name:") && histBody.toLowerCase().includes("phone number:");
            if (isFormData) continue;
            if (m.direction === 'outbound') {
              await addConversation({
                leadId: lead!.id, channel: normalizeChannel(m.type || 'SMS'),
                direction: 'outbound', senderType: 'human',
                messageBody: histBody,
                ghlMessageId: (m as any).id ?? '',
                recorded_from: 'ghl_history_sync',
                observedAt: m.dateAdded ? new Date(m.dateAdded) : new Date(),
              });
            } else {
              await addConversation({
                leadId: lead!.id, channel: normalizeChannel(m.type || 'SMS'),
                direction: 'inbound', senderType: 'lead',
                messageBody: histBody,
              });
            }
          }
          console.log(`[Webhook] Synced ${ghlHistory.filter(m => coerceWebhookBody(m.body).trim()).length} GHL messages for lead ${lead!.id} (${leadAgeDays.toFixed(0)} days old)`);
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
              // Our own AI/system-generated notes (must not trigger false agent detection)
              "🤖 ai:", "📋 new inquiry", "📋 ai:", "📞 handoff", "📞 ai:",
              "🔥 ai:", "🔥 close deal", "ai state machine", "ai: new inquiry",
              "ai: human agent active", "heads-up for agent", "the ai is handling",
              "live quote needed", "ready to close", "needs live agent",
              "committed —", "handoff —",
            ];
            const isSystemMsg = SYSTEM_PATTERNS.some(p => body.includes(p)) ||
              body.length < 10 || // Too short to be a real agent message (raised from 5)
              body.length > 500 || // System dumps / form data are usually long
              (m as any).messageType === "TYPE_ACTIVITY" ||
              (m as any).contentType === "activity" ||
              // GHL numeric system/activity types: 0=system, 28=opportunity, 29=stagechange,
              // 30=task, 31=appointment, 32=note, 33=contact, 34+=other activities
              (typeof (m as any).type === 'number' && ((m as any).type === 0 || (m as any).type >= 28)) ||
              (typeof (m as any).type === 'string' && ["0","28","29","30","31","32","33","34","35","36","37","38","39","40","TYPE_ACTIVITY","TYPE_APPOINTMENT","TYPE_TASK","TYPE_NOTE"].includes((m as any).type)) ||
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
    // Add a note only — the heads-up appointment/task already exist from first contact.
    // No new tasks/appointments created here (two-phase model: agent-notifications.ts).
    try {
      await addNote(contactId,
        `🤖 AI: Human agent active — new message from ${lead!.name || "lead"}\n` +
        `Message: "${effectiveMessageBody.substring(0, 200)}"\n` +
        `Reason AI is not responding: ${handoffDecision.reason}`
      );
    } catch { /* best effort */ }
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
  // IMPORTANT: This guard prevents duplicate AI responses, but MUST NOT block responses
  // to genuine inbound messages. When a lead actively messages us, we MUST respond.
  // The dedup guard only applies when the SAME inbound message triggers multiple webhooks
  // (GHL sometimes fires duplicate webhooks for the same message).
  // CRITICAL: Form data messages are NOT genuine inbound replies — they are structured
  // Facebook form submissions that arrive as a separate webhook. If we already sent a
  // first-contact message, the form data should NOT trigger another Brain Council reply.
  const isGenuineInbound = direction === "inbound" && effectiveMessageBody && effectiveMessageBody.trim().length > 0 && !isFormDataMessage;
  const recentAiMsgCount = await getRecentAiOutboundCount(lead!.id, 5);
  if (recentAiMsgCount > 0 && !isGenuineInbound) {
    // Only skip for non-inbound triggers (e.g., system events, duplicate webhooks)
    console.log(`[Webhook] Skipping AI response for lead ${lead!.id} — ${recentAiMsgCount} AI message(s) sent in last 5 min (non-inbound trigger)`);
    res.json({ success: true, action: "dedup_cooldown" });
    return;
  }
  if (recentAiMsgCount > 0 && isGenuineInbound) {
    // For genuine inbound: use a shorter 60-second window to catch true duplicate webhooks
    // but allow responses to new messages from the lead
    const recentAiMsgCountShort = await getRecentAiOutboundCount(lead!.id, 1);
    if (recentAiMsgCountShort > 0) {
      console.log(`[Webhook] Dedup: AI responded to lead ${lead!.id} within last 60s — likely duplicate webhook, skipping`);
      res.json({ success: true, action: "dedup_cooldown" });
      return;
    }
    console.log(`[Webhook] Lead ${lead!.id} sent a new inbound message — bypassing 5-min dedup guard to respond`);
  }

  // --- CADENCE BACKOFF ---
  // CRITICAL FIX: Cadence backoff is for PROACTIVE follow-ups only.
  // When a lead REPLIES to us, we MUST respond regardless of how many unanswered
  // messages we've sent. The lead is actively engaged — backoff makes no sense.
  if (!isGenuineInbound) {
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
  } else {
    console.log(`[Webhook] Lead ${lead!.id} sent inbound message — bypassing cadence backoff to respond`);
  }

  // --- TCPA QUIET HOURS GATE (inbound SMS response) ---
  const { isTcpaQuietHoursForRecipient, nextTcpaWindowForRecipient } = await import("./area-code-timezone");
  const { isSmsQuietHours, nextSmsWindowStart } = await import("./scheduling-engine");
  if (isTcpaQuietHoursForRecipient(lead!.phone) && channel === "SMS" && !lead!.email) {
    // SMS-only lead during quiet hours in their timezone — defer, don't respond
    console.log(`[Webhook] ⚠️ TCPA quiet hours (recipient TZ) — deferring SMS response for lead ${lead!.id}`);
    await updateLeadFields(lead!.id, { nextFollowUpAt: nextTcpaWindowForRecipient(lead!.phone) });
    res.json({ success: true, action: "tcpa_deferred", leadId: lead!.id });
    return;
  }

  // --- FOUNDATION C.2: NON-REAL-MESSAGE SKIP GATE ---
  // If the inbound content is not a genuine customer message (promo, sticker, form data, etc.),
  // skip the brain entirely. The row is already stored for audit (with contentKind set).
  if (direction === "inbound" && contentClass.kind !== "real_message") {
    console.log(`[Webhook/C.2] Skipping brain for lead ${lead!.id} — contentKind='${contentClass.kind}' (${contentClass.reason})`);
    res.json({ success: true, action: "non_real_message_skipped", contentKind: contentClass.kind });
    return;
  }

  // --- AI RESPONSE via BRAIN COUNCIL ---
  // ALL send/no-send decisions (offline, lock, humanTakeover, dedup) are made INSIDE runBrainCouncil.
  let aiResponse: any;
  try {
    aiResponse = await runBrainCouncil({ leadId: lead!.id, incomingMessage: effectiveMessageBody, channel, externalHistory: historyStr, isInboundReply: !!isGenuineInbound });
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
            priority: "critical",
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
  // ARCHITECTURE FIX: When Brain Council blocks, NEVER send fallback.
  // If the AI couldn't compose a quality message, sending a generic one is worse.
  // The follow-up trigger will retry on the next scheduled cycle.
  if (aiResponse.blocked && aiResponse.fallbackUsed && aiResponse.fallbackMessage) {
    console.log(`[Webhook] 🚫 BLOCKED message for lead ${lead!.id}: ${aiResponse.blockReason}. Fallback SUPPRESSED — blocked messages never send fallbacks.`);
    res.json({ success: true, action: "blocked_fallback_suppressed", violation: aiResponse.violationCategory, blockReason: aiResponse.blockReason });
    return;
  }

  // --- PRE-FLIGHT ABORT: Brain decided not to send (offline, locked, already responded, humanTakeover) ---
  if (aiResponse.blocked) {
    console.log(`[Webhook] Brain ABORTED for lead ${lead!.id}: ${aiResponse.blockReason}`);

    // --- QUICK ACK for genuine inbound replies ---
    // When a lead actively messages us but the Brain Council can't compose a proper reply
    // (QC block, safety violation, etc.), send a brief acknowledgement so the lead isn't ignored.
    // Skip if humanTakeover is active (agent will handle) or if the block is a pre-flight abort
    // like "already responded" or "offline" (those are expected silences).
    const PRE_FLIGHT_SKIP_PATTERNS = ["already responded", "offline", "locked", "humanTakeover", "human_takeover", "circuit_breaker"];
    const isPreFlightAbort = PRE_FLIGHT_SKIP_PATTERNS.some(p => (aiResponse.blockReason || "").toLowerCase().includes(p));
    if (isGenuineInbound && !lead!.humanTakeover && !isPreFlightAbort) {
      try {
        // Generate a context-aware quick ack based on what the lead said
        const msgLower = effectiveMessageBody.toLowerCase();
        let quickAck = "Got it — thanks for reaching out! We'll get back to you shortly.";
        if (msgLower.includes("tomorrow") || msgLower.includes("later") || msgLower.includes("next week") || msgLower.includes("call me") || msgLower.includes("reach out")) {
          quickAck = "Got it — we'll follow up with you then! Talk soon.";
        } else if (msgLower.includes("not interested") || msgLower.includes("no thanks") || msgLower.includes("stop") || msgLower.includes("remove")) {
          // Don't ack DNC/stop messages — let the DNC handler deal with it
          quickAck = "";
        } else if (msgLower.includes("price") || msgLower.includes("quote") || msgLower.includes("cost") || msgLower.includes("how much")) {
          quickAck = "Great question! Let me put together some pricing info for you — I'll follow up shortly.";
        }

        if (quickAck) {
          const ackChannel = normalizeChannel(aiResponse.channel || channel);
          const ackOpts: Parameters<typeof sendMessage>[1] = ackChannel === "Email"
            ? { type: "Email", subject: `Re: Your inquiry`, html: formatEmailHtml(quickAck), fromName: aiResponse.fromName || lead!.assignedAgent || "Adorb Custom Tees" }
            : { type: ackChannel as "SMS" | "WhatsApp" | "FB" | "IG", message: quickAck };
          const ackResult = await sendMessageWithRetry(resolvedContactId, ackOpts, { email: lead!.email, phone: lead!.phone, id: lead!.id });
          if (ackResult.success) {
            if (ackResult.isPhantom) console.warn(`[Webhook/Msg] PR#3.12: Phantom quick-ack for lead ${lead!.id}`);
            await addConversation({ leadId: lead!.id, direction: 'outbound', senderType: 'ai', messageBody: `[QUICK-ACK] ${quickAck}`, senderName: aiResponse.fromName || lead!.assignedAgent || undefined, outcome: { kind: 'delivered', messageId: ackResult.ghlMessageId ?? '', channel: ackChannel as import('./send-types').Channel, deliveredAt: new Date(), resolvedContactId: ackResult.resolvedContactId, correctionTaken: ackResult.correctionTaken } });
            console.log(`[Webhook/Msg] \u2705 Quick-ack sent to lead ${lead!.id} after Brain Council block: "${quickAck}"`);
          } else {
            console.warn(`[Webhook/Msg] Quick-ack send FAILED for lead ${lead!.id}: ${ackResult.error}`);
          }
        }
      } catch (ackErr) {
        console.error(`[Webhook/Msg] Quick-ack error for lead ${lead!.id} (non-fatal):`, ackErr);
      }
    }

    res.json({ success: true, action: "brain_aborted", reason: aiResponse.blockReason });
    return;
  }

  // NOTE: Second shouldHandoffToAgent check was REMOVED (Apr 12, 2026).
  // Root cause: This redundant LLM call ran AFTER the Brain Council already composed a response,
  // and would override the Brain Council's decision by setting humanTakeover=1.
  // Example: John Dugger replied "Two sided and 20ish" — Brain Council composed a response,
  // but this second check decided to hand off, silencing the AI permanently.
  // Handoff decisions are now handled by:
  //   1. Pre-Brain-Council shouldHandoffToAgent (line ~508) — checks if agent is already active
  //   2. Conversation state machine (processInboundState) → action-dispatcher (handleCommitted)
  //   3. Brain Council's Strategist (which knows when to escalate)

  // --- TCPA POST-DECISION GATE: Block SMS if quiet hours in recipient's timezone ---
  // SKIP for inbound social channels: if the lead messaged on FB/IG/WhatsApp/Live_Chat,
  // we MUST reply on that channel regardless of TCPA (TCPA only applies to proactive SMS).
  const SOCIAL_REPLY_CHANNELS = ["FB", "IG", "WhatsApp", "Live_Chat"];
  const isInboundSocialReply = direction === "inbound" && SOCIAL_REPLY_CHANNELS.includes(channel);
  if (!isInboundSocialReply && isTcpaQuietHoursForRecipient(lead!.phone) && normalizeChannel(aiResponse.channel || channel) === "SMS") {
    if (lead!.email) {
      // Switch to email
      console.log(`[Webhook] TCPA gate (recipient TZ): switching Brain Council SMS to Email for lead ${lead!.id}`);
      aiResponse = { ...aiResponse, channel: "Email" };
    } else {
      // Defer
      console.log(`[Webhook] TCPA gate (recipient TZ): deferring SMS for lead ${lead!.id}`);
      await updateLeadFields(lead!.id, { nextFollowUpAt: nextTcpaWindowForRecipient(lead!.phone) });
      res.json({ success: true, action: "tcpa_deferred", leadId: lead!.id });
      return;
    }
  }

  // --- AGENT-FIRST DELAY: Defer response for brand new leads during business hours ---
  // During Mon-Fri 9am-5pm EST, brand new leads get a 15-minute window for the human agent
  // to reach out first. The Brain Council has already run (appointment + task created),
  // but the AI message is stored in deferred_responses instead of being sent immediately.
  if (shouldDeferResponse(lead!, convHistory.length)) {
    // Check if there's already a pending deferred response for this lead (prevent duplicates)
    const alreadyDeferred = await hasPendingDeferredResponse(lead!.id);
    if (!alreadyDeferred) {
      const sendAt = getDeferredSendAt();
      let deferChannel = normalizeChannel(aiResponse.channel || channel);
      const emailSubject = deferChannel === "Email"
        ? (aiResponse.subject || buildContextSubject({ name: lead!.name, businessName: lead!.businessName }, aiResponse.fromName))
        : undefined;
      const emailHtml = deferChannel === "Email" ? formatEmailHtml(aiResponse.message) : undefined;

      await insertDeferredResponse({
        leadId: lead!.id,
        ghlContactId: resolvedContactId,
        channel: deferChannel,
        messageBody: aiResponse.message,
        emailSubject,
        emailHtml,
        fromName: aiResponse.fromName || lead!.assignedAgent || undefined,
        sendAt,
        brainCouncilOutput: {
          score: aiResponse.score,
          segment: aiResponse.segment,
          angle: aiResponse.angle,
          framework: aiResponse.framework,
          nextEngagementHours: aiResponse.nextEngagementHours,
        },
      });

      console.log(`[Webhook/AgentFirst] ⏳ Deferred AI response for NEW lead ${lead!.id} (${lead!.name || "Unknown"}) — agent has 15min window until ${sendAt.toISOString()}`);
      res.json({ success: true, action: "agent_first_deferred", sendAt: sendAt.toISOString() });
      return;
    }
  }

  // --- NORMAL AI RESPONSE ---
  // HARD RULE: For inbound messages, ALWAYS reply on the same channel the customer used.
  // The Brain Council may recommend a different channel (e.g. Email when customer wrote on FB),
  // but we MUST reply where the customer is — otherwise they'll never see our response.
  // Brain Council channel recommendations only apply to outbound-initiated follow-ups.
  let sendChannel: string;
  if (direction === "inbound" && channel && channel !== "SMS") {
    // Customer wrote on FB/IG/Email/WhatsApp/Live_Chat — reply there, period.
    sendChannel = channel;
    if (aiResponse.channel && normalizeChannel(aiResponse.channel) !== channel) {
      console.log(`[Webhook/Msg] ⚠️ Brain Council recommended ${aiResponse.channel} but inbound was ${channel} — forcing reply on ${channel}`);
    }
  } else {
    // Outbound-initiated or SMS (which may be misdetected) — use Brain Council recommendation
    sendChannel = normalizeChannel(aiResponse.channel || channel);
  }
  // REMOVED (Fix 11): Migrated channel restriction was a one-time migration, now removed.
  if (sendChannel !== channel) {
    console.log(`[Webhook/Msg] Channel adjusted for lead ${lead!.id}: inbound=${channel} → send=${sendChannel} (Brain Council recommended: ${aiResponse.channel})`);
  }
  let normalSendResult: { success: boolean; resolvedContactId: string; emailMessageId?: string; error?: string; ghlMessageId?: string; isPhantom?: boolean; correctionTaken?: string };
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
    if (normalSendResult.isPhantom) console.warn(`[Webhook/Msg] PR#3.12: Phantom normal send for lead ${lead!.id}`);
    await addConversation({ leadId: lead!.id, direction: 'outbound', senderType: 'ai', messageBody: aiResponse.message, senderName: aiResponse.fromName, outcome: { kind: 'delivered', messageId: normalSendResult.ghlMessageId ?? '', channel: sendChannel as import('./send-types').Channel, deliveredAt: new Date(), resolvedContactId: normalSendResult.resolvedContactId, correctionTaken: normalSendResult.correctionTaken, emailMessageId: normalSendResult.emailMessageId } });
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
