/**
 * WEBHOOK CONTACT HANDLER — Handles new contact creation from GHL
 * 
 * Responsibilities:
 * - Upsert lead from GHL contact data
 * - Resolve real GHL contact ID (GHL sends wrong IDs sometimes)
 * - Enrich lead with GHL API data
 * - Classify segment + research lead
 * - Push to Omnisend
 * - Auto-assign sales agent
 * - DELAYED first-contact template (45s wait for GHL to index conversation data)
 */

import { Response } from "express";
import { upsertLead, updateLeadFields, getLeadById, getRecentAiOutboundCount, addConversation, upsertAiState, addBrainCouncilAudit, addAgentAssignment, getAgentWorkload } from "./db";
import { classifySegment } from "./ai-brain";
import { researchLead } from "./lead-researcher";
import { calculateNextFollowUp, checkRateLimits, checkLeadRateLimit } from "./scheduling-engine";
import { getContact, fetchGhlConversationHistory } from "./ghl";
import { pushContactToOmnisend } from "./omnisend";
import {
  SALES_AGENTS,
  STAGES,
  resolveGhlContactId,
  extractContactData,
  sendMessageWithRetry,
  extractFormData,
  parseFormDataFromMessageBody,
} from "./webhook-helpers";
import { handleStageAutomation } from "./webhook-pipeline";

/** Delay before sending first-contact template (ms). Gives GHL time to index conversation data. */
export const FIRST_CONTACT_DELAY_MS = 45_000; // 45 seconds

export async function handleContactWebhook(payload: Record<string, unknown>, res: Response) {
  const contactId = (payload.id || payload.contactId) as string;
  if (!contactId) { res.status(400).json({ error: "No contact ID" }); return; }

  let lead = await upsertLead({
    ghlContactId: contactId,
    name: payload.name as string || (payload.firstName ? `${payload.firstName || ""} ${payload.lastName || ""}`.trim() : undefined),
    email: payload.email as string,
    phone: payload.phone as string,
    businessName: (payload.companyName || payload.businessName) as string,
    website: payload.website as string,
    source: (payload.source || (payload.tags as string[])?.[0] || "ghl") as string,
  });

  // GHL CONTACT ID RESOLUTION
  let resolvedContactId = contactId;
  if (lead) {
    const resolved = await resolveGhlContactId(contactId, lead.email || (payload.email as string), lead.phone || (payload.phone as string));
    if (resolved) {
      resolvedContactId = resolved.resolvedId;
      if (resolvedContactId !== contactId) {
        console.log(`[Webhook] Contact ID resolved: ${contactId} → ${resolvedContactId}`);
        await updateLeadFields(lead.id, { ghlContactId: resolvedContactId });
      }
      const enriched = extractContactData(resolved.contact);
      const updates: Record<string, unknown> = {};
      if (!lead.name && enriched.name) updates.name = enriched.name;
      if (!lead.email && enriched.email) updates.email = enriched.email;
      if (!lead.phone && enriched.phone) updates.phone = enriched.phone;
      if (!lead.businessName && enriched.businessName) updates.businessName = enriched.businessName;
      if (!lead.website && enriched.website) updates.website = enriched.website;
      if (!lead.source && enriched.source) updates.source = enriched.source;
      if (Object.keys(updates).length > 0) {
        await updateLeadFields(lead.id, updates);
        console.log(`[Webhook] Enriched lead ${lead.id} with: ${Object.keys(updates).join(", ")}`);
        lead = { ...lead, ...updates } as typeof lead;
      }
    }
  }

  if (lead && lead.businessName) {
    const segment = await classifySegment(lead.businessName, lead.website || undefined);
    try {
      const research = await researchLead({
        name: lead.name || undefined,
        businessName: lead.businessName || undefined,
        source: lead.source || undefined,
        website: lead.website || undefined,
        segment,
        email: lead.email || undefined,
      });
      await updateLeadFields(lead.id, { omnisendSegment: segment, researchData: research });
    } catch (err) {
      console.error("[Webhook] Research failed for lead", lead.id, err);
      await updateLeadFields(lead.id, { omnisendSegment: segment });
    }

    if (lead.email) {
      const nameParts = (lead.name || "").split(" ");
      await pushContactToOmnisend({
        email: lead.email,
        firstName: nameParts[0],
        lastName: nameParts.slice(1).join(" "),
        phone: lead.phone || undefined,
        tags: [segment],
      });
    }
  }

  // Auto-assign sales agent and trigger New Lead automation
  if (lead) {
    await handleStageAutomation(STAGES.NEW_LEAD, {
      id: lead.id,
      ghlContactId: contactId,
      name: lead.name || null,
      businessName: lead.businessName || null,
      email: lead.email || null,
      assignedAgent: lead.assignedAgent || null,
      pipelineValue: null,
    });

    const initialSchedule = await calculateNextFollowUp({ leadId: lead.id, triggerEvent: "new_lead" });
    await updateLeadFields(lead.id, { nextFollowUpAt: initialSchedule.nextFollowUpAt, cadencePosition: initialSchedule.cadencePosition });

    // =================================================================
    // DELAYED FIRST-CONTACT SEQUENCE (45s wait → Hormozi ACA)
    // =================================================================
    // Respond to webhook immediately, then fire first-contact after delay.
    // The delay lets GHL fully index the conversation so channel detection
    // can read the actual inbound message type (FB, IG, WhatsApp, etc.)
    // instead of falling back to SMS.
    // =================================================================
    const leadId = lead.id;
    const leadSnapshot = { ...lead };
    const payloadSnapshot = { ...payload };
    const capturedResolvedContactId = resolvedContactId;

    console.log(`[Webhook] Scheduling delayed first-contact for lead ${leadId} in ${FIRST_CONTACT_DELAY_MS / 1000}s`);

    setTimeout(() => {
      sendDelayedFirstContact(leadId, leadSnapshot, payloadSnapshot, capturedResolvedContactId)
        .catch(err => console.error(`[Webhook] Delayed first-contact error for lead ${leadId}:`, err));
    }, FIRST_CONTACT_DELAY_MS);
  }

  res.json({ success: true });
}

/**
 * Sends the locked first-contact template after a delay.
 * By the time this runs, GHL should have fully indexed the conversation data
 * so channel detection is accurate.
 */
async function sendDelayedFirstContact(
  leadId: number,
  leadSnapshot: Record<string, unknown>,
  payload: Record<string, unknown>,
  resolvedContactId: string,
) {
  try {
    console.log(`[Webhook] Delayed first-contact firing for lead ${leadId} (${FIRST_CONTACT_DELAY_MS / 1000}s after webhook)`);

    // Re-read lead from DB to get latest state (agent assignment, etc.)
    const lead = await getLeadById(leadId);
    if (!lead) {
      console.log(`[Webhook] Lead ${leadId} not found for delayed first-contact — skipping`);
      return;
    }

    // Rate limit checks
    const rateCheck = await checkRateLimits();
    if (!rateCheck.allowed) {
      console.log(`[Webhook] Rate limit hit for lead ${leadId}: ${rateCheck.reason}`);
      return;
    }

    const leadAllowed = await checkLeadRateLimit(leadId);
    if (!leadAllowed) {
      console.log(`[Webhook] Per-lead rate limit for lead ${leadId} — already contacted in last 24h`);
      return;
    }

    const recentAiCount = await getRecentAiOutboundCount(leadId, 15);
    if (recentAiCount > 0) {
      console.log(`[Webhook] Skipping first-contact for lead ${leadId} — ${recentAiCount} message(s) sent in last 15 min`);
      return;
    }

    // --- FETCH GHL CONVERSATION HISTORY (shared by form extraction + channel detection) ---
    const ghlHistory = await fetchGhlConversationHistory(resolvedContactId);

    // --- EXTRACT FORM DATA (3-layer) ---
    // Layer 1: Direct webhook payload fields
    let formFields = extractFormData(payload);

    // Layer 2: GHL contact custom fields (API call)
    if (formFields.length === 0) {
      try {
        const ghlContact = await getContact(resolvedContactId);
        if (ghlContact?.customFields) {
          formFields = extractFormData({ customFields: ghlContact.customFields });
        }
      } catch { /* best effort */ }
    }

    // Layer 3: Parse form data from Facebook message body in GHL conversation history
    // Facebook lead forms send form data as a text block in the message body:
    //   "Company name: Calvary Community Church\nWhat type of products...?: T-shirts\n..."
    if (formFields.length === 0 && ghlHistory.length > 0) {
      const inboundMsgs = ghlHistory.filter(m => m.direction === "inbound");
      for (const msg of inboundMsgs) {
        const body = String(msg.body || "");
        if (body.includes(":")) {
          const parsed = parseFormDataFromMessageBody(body);
          if (parsed.length > 0) {
            formFields = parsed;
            console.log(`[Webhook] Extracted ${parsed.length} form fields from FB message body for lead ${leadId}: ${parsed.map(f => `${f.label}=${f.value}`).join(", ")}`);
            break;
          }
        }
      }
    }

    console.log(`[Webhook] Form data for lead ${leadId}: ${formFields.length > 0 ? formFields.map(f => `${f.label}=${f.value}`).join(", ") : "NONE (will use generic template)"}`);
    // Also log the raw payload keys for debugging
    if (formFields.length === 0) {
      console.log(`[Webhook] Raw payload keys for lead ${leadId}: ${Object.keys(payload).join(", ")}`);
    }

    // --- DETECT CHANNEL (multi-layer) ---
    // Now that 45s have passed, GHL should have the conversation indexed
    // Layer 1: Check GHL conversation history for inbound message type
    let detectedChannel = "";
    if (ghlHistory.length > 0) {
      const lastInbound = [...ghlHistory].reverse().find(m => m.direction === "inbound");
      if (lastInbound) {
        const rawType = String(lastInbound.type || "").toLowerCase();
        // GHL uses numeric types: 2=SMS, 3=Email, 4=FB, 5=IG, 6=WhatsApp, etc.
        if (rawType === "4" || rawType.includes("fb") || rawType.includes("facebook") || rawType.includes("live_chat")) detectedChannel = "FB";
        else if (rawType === "5" || rawType.includes("ig") || rawType.includes("instagram")) detectedChannel = "IG";
        else if (rawType === "6" || rawType.includes("whatsapp")) detectedChannel = "WhatsApp";
        else if (rawType === "3" || rawType.includes("email")) detectedChannel = "Email";
        else if (rawType === "2" || rawType.includes("sms") || rawType.includes("message")) detectedChannel = "SMS";
      }
    }

    // Layer 2: Check the webhook payload itself for channel indicators
    if (!detectedChannel) {
      const payloadType = String(payload.messageType || payload.type || "").toLowerCase();
      if (payloadType === "4" || payloadType.includes("fb") || payloadType.includes("facebook")) detectedChannel = "FB";
      else if (payloadType === "5" || payloadType.includes("ig") || payloadType.includes("instagram")) detectedChannel = "IG";
      else if (payloadType === "6" || payloadType.includes("whatsapp")) detectedChannel = "WhatsApp";

      if (!detectedChannel) {
        const nestedMsg = payload.message as Record<string, unknown> | undefined;
        if (nestedMsg && typeof nestedMsg === "object") {
          const nestedType = String(nestedMsg.type || "").toLowerCase();
          if (nestedType === "4" || nestedType.includes("fb") || nestedType.includes("facebook")) detectedChannel = "FB";
          else if (nestedType === "5" || nestedType.includes("ig") || nestedType.includes("instagram")) detectedChannel = "IG";
          else if (nestedType === "6" || nestedType.includes("whatsapp")) detectedChannel = "WhatsApp";
        }
      }
    }

    // Layer 3: Check payload.source
    if (!detectedChannel) {
      const src = (payload.source as string || "").toLowerCase();
      if (src.includes("facebook") || src.includes("fb") || src.includes("lead_form")) detectedChannel = "FB";
      else if (src.includes("instagram") || src.includes("ig")) detectedChannel = "IG";
      else if (src.includes("whatsapp")) detectedChannel = "WhatsApp";
    }

    // Layer 4: Check the lead's source field (from DB, enriched by GHL API)
    if (!detectedChannel && lead.source) {
      const leadSrc = (lead.source as string).toLowerCase();
      if (leadSrc.includes("facebook") || leadSrc.includes("fb") || leadSrc.includes("lead_form")) detectedChannel = "FB";
      else if (leadSrc.includes("instagram") || leadSrc.includes("ig")) detectedChannel = "IG";
      else if (leadSrc.includes("whatsapp")) detectedChannel = "WhatsApp";
    }

    // Layer 5: Check workflow name for Facebook/IG indicators
    if (!detectedChannel) {
      const workflow = payload.workflow as Record<string, unknown> | undefined;
      const wfName = String(workflow?.name || "").toLowerCase();
      if (wfName.includes("facebook") || wfName.includes("fb")) detectedChannel = "FB";
      else if (wfName.includes("instagram") || wfName.includes("ig")) detectedChannel = "IG";
    }

    // Layer 6: Check tags for Facebook/IG indicators
    if (!detectedChannel) {
      const tags = (payload.tags as string[] || []);
      const tagStr = tags.join(" ").toLowerCase();
      if (tagStr.includes("facebook") || tagStr.includes("fb") || tagStr.includes("lead_form")) detectedChannel = "FB";
      else if (tagStr.includes("instagram") || tagStr.includes("ig")) detectedChannel = "IG";
    }

    // Layer 7: Default fallback — phone → SMS, email-only → Email
    if (!detectedChannel) {
      if (lead.email && !lead.phone) detectedChannel = "Email";
      else if (lead.phone) detectedChannel = "SMS";
      else if (lead.email) detectedChannel = "Email";
    }

    console.log(`[Webhook] Channel detection for lead ${leadId} (delayed): detected=${detectedChannel}, ghlHistory=${ghlHistory.length} msgs, source=${payload.source || lead.source || "none"}`);

    if (!detectedChannel || (!lead.phone && !lead.email)) {
      console.log(`[Webhook] Cannot send first-contact for lead ${leadId}: no channel or contact info`);
      return;
    }

    const channel = detectedChannel as "SMS" | "Email" | "WhatsApp" | "FB" | "IG";
    const agentName = lead.assignedAgent || SALES_AGENTS[0];
    const firstName = (lead.name || "").split(" ")[0] || "there";

    const productType = formFields.find(f => f.label === "Product Type")?.value || "custom gear";
    const purpose = formFields.find(f => f.label === "Purpose")?.value || "";
    const timeline = formFields.find(f => f.label === "Timeline")?.value || "";

    let msg1 = `Hi ${firstName}, ${agentName.split(" ")[0]} here! Adorb has a 4.9 star review helping`;
    if (purpose) { msg1 += ` ${purpose.toLowerCase()}`; } else { msg1 += ` businesses like yours`; }
    msg1 += ` with customized ${productType.toLowerCase()}`;
    if (timeline) { msg1 += ` ${timeline.toLowerCase()}`; }
    msg1 += `.`;
    // Add signature for SMS/FB/IG
    if (channel !== "Email") {
      msg1 += `\nThanks, ADORB CUSTOM PRINTING`;
    }

    const msg2 = `Do you have a design ready or would you like our team to help?`;

    console.log(`[Webhook] LOCKED first-contact for lead ${leadId} (${firstName}): agent=${agentName}, channel=${channel}`);
    console.log(`[Webhook] MSG1: ${msg1}`);
    console.log(`[Webhook] MSG2: ${msg2}`);

    // --- SEND MESSAGE 1 ---
    const buildSendOpts = (message: string): Parameters<typeof import("./ghl").sendMessage>[1] | undefined => {
      if (channel === "Email" && lead.email) {
        return { type: "Email", subject: `${agentName.split(" ")[0]} from Adorb Custom Tees`, html: `<p>${message}</p><p>${msg2}</p>`, fromName: agentName };
      } else if (channel === "FB") { return { type: "FB", message }; }
      else if (channel === "IG") { return { type: "IG", message }; }
      else if (channel === "WhatsApp") { return { type: "WhatsApp", message }; }
      else if (lead.phone) { return { type: "SMS", message }; }
      return undefined;
    };

    const sendOpts1 = buildSendOpts(msg1);
    let msg1Sent = false;
    let msg2Sent = false;

    if (sendOpts1) {
      const sendResult1 = await sendMessageWithRetry(resolvedContactId, sendOpts1, { email: lead.email, phone: lead.phone, id: lead.id });
      if (sendResult1.resolvedContactId !== resolvedContactId) resolvedContactId = sendResult1.resolvedContactId;
      msg1Sent = sendResult1.success;
      if (!msg1Sent) console.error(`[Webhook] Failed to send MSG1 to lead ${leadId}: ${sendResult1.error}`);
    }

    await addConversation({ leadId, channel, direction: "outbound", messageBody: msg1, senderType: "ai", senderName: agentName });

    if (channel !== "Email") {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const sendOpts2 = buildSendOpts(msg2);
      if (sendOpts2) {
        const sendResult2 = await sendMessageWithRetry(resolvedContactId, sendOpts2, { email: lead.email, phone: lead.phone, id: lead.id });
        msg2Sent = sendResult2.success;
        if (!msg2Sent) console.error(`[Webhook] Failed to send MSG2 to lead ${leadId}: ${sendResult2.error}`);
      }
      await addConversation({ leadId, channel, direction: "outbound", messageBody: msg2, senderType: "ai", senderName: agentName });
    }

    try {
      await addBrainCouncilAudit({
        leadId, leadName: lead.name || undefined, channel,
        incomingMessage: `[FIRST CONTACT] Form data: ${formFields.map(f => `${f.label}=${f.value}`).join(", ") || "none"}`,
        strategyApproach: "first_contact", strategyFramework: "HORMOZI_ACA",
        strategyReasoning: `LOCKED TEMPLATE — No Brain Council. Deterministic two-message welcome sequence. Delayed ${FIRST_CONTACT_DELAY_MS / 1000}s for accurate channel detection.`,
        strategyTier: "1", researchSummary: "SKIPPED — Research disabled for first contact.",
        composedMessage: msg1, composerFromName: agentName, qcScore: 100, qcApproved: 1,
        wasRecomposed: 0, finalMessage: channel === "Email" ? `${msg1}\n\n${msg2}` : `${msg1} | ${msg2}`,
        messageSent: (msg1Sent ? 1 : 0),
      });
    } catch (auditErr) { console.error('[Webhook] First-contact audit log error (non-fatal):', auditErr); }

    const contactSchedule = await calculateNextFollowUp({ leadId, aiSuggestedHours: 4, triggerEvent: "ai_response" });
    await updateLeadFields(leadId, {
      lastMessageAt: new Date(), nextFollowUpAt: contactSchedule.nextFollowUpAt,
      cadencePosition: contactSchedule.cadencePosition, preferredChannel: contactSchedule.channel,
      lastOutboundChannel: channel,
    });

    await upsertAiState(leadId, { lastAngleUsed: "LOCKED_FIRST_CONTACT", lastFrameworkUsed: "HORMOZI_ACA", messageCount: channel === "Email" ? 1 : 2 });

    console.log(`[Webhook] First-contact COMPLETE for lead ${leadId}: msg1=${msg1Sent}, msg2=${msg2Sent || channel === "Email"}, channel=${channel}`);
  } catch (err) {
    console.error(`[Webhook] Delayed first-contact error for lead ${leadId}:`, err);
  }
}
