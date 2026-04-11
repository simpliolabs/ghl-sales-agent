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
 * - DELAYED first-contact via Brain Council (45s wait for GHL to index, then full 4-brain pipeline)
 */

import { Response } from "express";
import { upsertLead, updateLeadFields, getLeadById, getRecentAiOutboundCount, addConversation, upsertAiState, addAgentAssignment, getAgentWorkload, getConversationHistory, syncGhlDnd } from "./db";
import { classifySegment } from "./ai-brain";
import { researchLead } from "./lead-researcher";
import { calculateNextFollowUp, checkRateLimits, checkLeadRateLimit, checkDnc } from "./scheduling-engine";
import { handleChannelDnc, detectDncChannel } from "./channel-fallback";
import { getContact, fetchGhlConversationHistory, updateOpportunityStage, createTask, createAppointment, addNote, AGENT_CALENDAR_IDS, AGENT_GHL_USER_IDS, getNextBusinessHoursSlot } from "./ghl";
import { pushContactToOmnisend } from "./omnisend";
import {
  SALES_AGENTS,
  STAGES,
  resolveGhlContactId,
  extractContactData,
  sendMessageWithRetry,
  extractFormData,
  parseFormDataFromMessageBody,
  formatEmailHtml,
  buildSendOpts,
  buildContextSubject,
} from "./webhook-helpers";
import { handleStageAutomation } from "./webhook-pipeline";
import { runBrainCouncil } from "./brain-council-orchestrator";
import { notifyOwner } from "./_core/notification";

/** Delay before sending first-contact template (ms). Gives GHL time to index conversation data. */
let FIRST_CONTACT_DELAY_MS = 45_000; // 45 seconds

/** In-memory lock to prevent duplicate first-contact sends from concurrent webhooks */
const firstContactLocks = new Map<number, number>();

function acquireFirstContactLock(leadId: number): boolean {
  const now = Date.now();
  const existing = firstContactLocks.get(leadId);
  if (existing && now - existing < 120_000) return false; // 2-minute lock window
  firstContactLocks.set(leadId, now);
  return true;
}

function releaseFirstContactLock(leadId: number) {
  firstContactLocks.delete(leadId);
}

/** For testing: override the delay. DO NOT use in production. */
export function _setFirstContactDelay(ms: number) { FIRST_CONTACT_DELAY_MS = ms; }
/** For testing: clear all first-contact locks. DO NOT use in production. */
export function _clearFirstContactLocks() { firstContactLocks.clear(); }

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

      // --- SYNC GHL DND STATUS ---
      // Extract per-channel DND from the GHL contact and persist to leads table.
      // This runs during enrichment so the Brain Council knows which channels are blocked.
      try {
        await syncGhlDnd(lead.id, resolved.contact);
      } catch (dndErr) {
        console.error(`[Webhook] DND sync failed for lead ${lead.id}:`, dndErr);
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
    // NOTE: Auto-task/appointment/notification creation has been moved
    // INSIDE sendDelayedFirstContact() to run AFTER the first-contact
    // message is sent. This prevents GHL bounce-back webhooks from
    // the task/appointment/note from triggering humanTakeover and
    // blocking the first-contact message.
    // =================================================================

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
      // Acquire lock to prevent duplicate sends from concurrent webhooks
      if (!acquireFirstContactLock(leadId)) {
        console.log(`[Webhook] First-contact lock held for lead ${leadId} — skipping duplicate`);
        return;
      }
      sendDelayedFirstContact(leadId, leadSnapshot, payloadSnapshot, capturedResolvedContactId)
        .catch(err => console.error(`[Webhook] Delayed first-contact error for lead ${leadId}:`, err))
        .finally(() => releaseFirstContactLock(leadId));
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

    // --- HUMAN TAKEOVER RE-CHECK ---
    // The message_handler may have set humanTakeover=1 during the 45s delay
    // due to GHL system messages ("Opportunity Created") being misclassified as agent messages.
    // If humanTakeover was set but there's no real agent activity (no lastAgentNote, no real outbound),
    // clear it so the first-contact can proceed.
    if (lead.humanTakeover === 1) {
      // Filter out system-generated notes — they should NOT count as real agent activity
      const SYSTEM_NOTE_PREFIXES = ["\u{1F916}", "[AUTO]", "[SYSTEM]", "[AI]"];
      const noteIsSystem = lead.lastAgentNote && SYSTEM_NOTE_PREFIXES.some(p => (lead.lastAgentNote as string).trimStart().startsWith(p));
      const hasRealAgentNote = lead.lastAgentNote && !noteIsSystem;
      const hasRealAgentActivity = hasRealAgentNote || 
        (lead.lastAgentActivityAt && lead.lastOutboundChannel);
      if (!hasRealAgentActivity) {
        console.log(`[Webhook] Clearing false-positive humanTakeover for lead ${leadId} (no real agent activity detected${noteIsSystem ? ", system note ignored" : ""})`);
        await updateLeadFields(leadId, { humanTakeover: 0 });
        (lead as any).humanTakeover = 0;
      } else {
        console.log(`[Webhook] humanTakeover=1 for lead ${leadId} — real agent activity detected, skipping first-contact`);
        return;
      }
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

    // --- DNC CHECK: Scan recent inbound messages before sending first contact ---
    try {
      const recentInbound = await getConversationHistory(leadId, 10);
      const inboundOnly = recentInbound.filter((c: any) => c.direction === "inbound");
      if (checkDnc(inboundOnly)) {
        // CHANNEL-SPECIFIC DNC: block only the channel the DNC was received on
        const dncChannel = detectDncChannel((lead as any).preferredChannel || (lead as any).lastOutboundChannel || "SMS");
        const result = await handleChannelDnc(leadId, lead, dncChannel, resolvedContactId);
        if (result.action === "not_qualified") {
          await updateLeadFields(leadId, { humanTakeover: 1, pipelineStage: "not_qualified" });
          try {
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
          console.log(`[Webhook] \u{1F6AB} DNC on ${dncChannel} — ALL channels exhausted for lead ${leadId} → Not Qualified`);
        } else {
          console.log(`[Webhook] \u{1F504} DNC on ${dncChannel} — escalated lead ${leadId} to ${result.nextChannel}`);
        }
        return;
      }
    } catch (dncErr) {
      console.error(`[Webhook] DNC check failed for lead ${leadId}:`, dncErr);
      // Fail CLOSED: skip first-contact rather than risk messaging an opted-out person
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

    // Layer 3: ALWAYS parse form data from Facebook message body in GHL conversation history
    // as ENRICHMENT — merge any fields not found in earlier layers.
    // Facebook lead forms send form data as a text block in the message body:
    //   "Company name: Calvary Community Church\nWhat type of products...?: T-shirts\n..."
    if (ghlHistory.length > 0) {
      const inboundMsgs = ghlHistory.filter(m => m.direction === "inbound");
      for (const msg of inboundMsgs) {
        const body = String(msg.body || "");
        if (body.includes(":")) {
          const parsed = parseFormDataFromMessageBody(body);
          if (parsed.length > 0) {
            // Merge: add fields from message body that weren't found in earlier layers
            const existingLabels = new Set(formFields.map(f => f.label));
            for (const field of parsed) {
              if (!existingLabels.has(field.label)) {
                formFields.push(field);
              }
            }
            console.log(`[Webhook] Enriched form data from FB message body for lead ${leadId}: ${parsed.map(f => `${f.label}=${f.value}`).join(", ")}`);
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

    let detectedChannel = "";
    // Track whether form data was extracted from a GHL conversation message body
    let formExtractedFromConversation = false;
    if (formFields.length > 0 && ghlHistory.length > 0) {
      // If we parsed form data from a GHL conversation message body, the lead
      // came from a Facebook/IG lead form — use that as the strongest signal
      const inboundMsgs = ghlHistory.filter(m => m.direction === "inbound");
      for (const msg of inboundMsgs) {
        const body = String(msg.body || "");
        if (body.includes(":") && parseFormDataFromMessageBody(body).length > 0) {
          formExtractedFromConversation = true;
          break;
        }
      }
    }

    // Layer 0 (STRONGEST): If form data was parsed from conversation message body,
    // the lead came from a Facebook/IG lead form. This is more reliable than GHL's
    // type field which may use unexpected values.
    if (formExtractedFromConversation) {
      detectedChannel = "FB";
      console.log(`[Webhook] Channel detection Layer 0 HIT for lead ${leadId}: form data found in conversation body → FB`);
    }

    // Layer 1: Check GHL conversation history for inbound message type
    if (!detectedChannel && ghlHistory.length > 0) {
      const lastInbound = [...ghlHistory].reverse().find(m => m.direction === "inbound");
      // Log raw type for diagnostics
      if (lastInbound) {
        console.log(`[Webhook] GHL raw inbound type for lead ${leadId}: "${lastInbound.type}" (typeof=${typeof lastInbound.type})`);
      }
      if (lastInbound) {
        const rawType = String(lastInbound.type || "").toLowerCase();
        // GHL uses numeric types: 2=SMS, 3=Email, 4=FB, 5=IG, 6=WhatsApp, etc.
        if (rawType === "4" || rawType.includes("fb") || rawType.includes("facebook") || rawType.includes("live_chat")) detectedChannel = "FB";
        else if (rawType === "5" || rawType.includes("ig") || rawType.includes("instagram")) detectedChannel = "IG";
        else if (rawType === "6" || rawType.includes("whatsapp")) detectedChannel = "WhatsApp";
        else if (rawType === "3" || rawType.includes("email")) detectedChannel = "Email";
        else if (rawType === "2" || rawType.includes("sms")) detectedChannel = "SMS";
        // Catch-all: if type contains "message" but nothing else matched, don't default to SMS
        // This prevents "InboundMessage" or other generic types from overriding later layers
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

    console.log(`[Webhook] First-contact via Brain Council for lead ${leadId}: channel=${channel}, formFields=${formFields.length}`);

    // --- BUILD BRAIN COUNCIL INPUT ---
    // Pass form data and GHL history so the Brain Council has full context.
    // The orchestrator's pre-flight checks (DNC, DND, cooldown, lock) provide
    // a second safety layer on top of the rate limit checks above.
    const formDataSummary = formFields.length > 0
      ? formFields.map(f => `${f.label}: ${f.value}`).join("\n")
      : "No form data available";

    // Build external history string from GHL conversation data
    const externalHistoryStr = ghlHistory.length > 0
      ? ghlHistory.map(m => `[${m.direction}] ${String(m.body || "").substring(0, 500)}`).join("\n")
      : "";

    const incomingMessage = `[FIRST CONTACT — NEW LEAD]\n` +
      `This is a brand new lead who just submitted a form or inquiry.\n` +
      `Lead name: ${lead.name || "Unknown"}\n` +
      `Business: ${lead.businessName || "Unknown"}\n` +
      `Source: ${lead.source || "Unknown"}\n` +
      `Form data:\n${formDataSummary}\n` +
      `\nThis is the FIRST message to this lead. Be warm, professional, and reference their specific form data. Do NOT ask questions they already answered in the form.`;

    const brainResult = await runBrainCouncil({
      leadId,
      incomingMessage,
      channel,
      externalHistory: externalHistoryStr,
      formData: formFields,
    });

    // --- HANDLE BRAIN COUNCIL RESULT ---
    if (brainResult.blocked) {
      console.log(`[Webhook] Brain Council BLOCKED first-contact for lead ${leadId}: ${brainResult.blockReason}`);
      // If Brain Council blocked but there's a fallback, send it
      if (brainResult.fallbackUsed && brainResult.fallbackMessage) {
        console.log(`[Webhook] Using fallback message for lead ${leadId}`);
        const fallbackSubject = brainResult.subject || buildContextSubject({ name: lead.name, businessName: lead.businessName, formData: formFields }, agentName);
        const fallbackOpts = buildSendOpts(channel, brainResult.fallbackMessage, lead, {
          subject: fallbackSubject,
          fromName: agentName,
        });
        if (fallbackOpts) {
          const fbResult = await sendMessageWithRetry(resolvedContactId, fallbackOpts, { email: lead.email, phone: lead.phone, id: lead.id });
          if (fbResult.success) {
            await addConversation({ leadId, channel, direction: "outbound", messageBody: brainResult.fallbackMessage, senderType: "ai", senderName: agentName });
          } else {
            console.error(`[Webhook] Fallback send FAILED for lead ${leadId}: ${fbResult.error}`);
          }
        }
      }
      return;
    }

    // Brain Council approved — send the composed message
    const composedMessage = brainResult.message;
    const fromName = brainResult.fromName || agentName;
    // CHANNEL PRIORITY FOR FIRST CONTACT: The detected webhook channel (FB/IG/WhatsApp)
    // takes priority over Brain Council's channel recommendation. The knowledge base rule
    // says "Always respond to contacts right away in the same manner they reached out."
    // Only allow Brain Council to override if the detected channel is generic SMS/Email.
    const isDetectedSocial = ["FB", "IG", "WhatsApp", "Live_Chat"].includes(channel);
    const brainChannel = isDetectedSocial ? channel : (brainResult.channel || channel);
    if (brainResult.channel && brainResult.channel !== brainChannel) {
      console.log(`[Webhook] First-contact channel: detected=${channel}, brain=${brainResult.channel}, using=${brainChannel} (${isDetectedSocial ? 'detected social channel enforced' : 'brain override allowed'})`);
    }

    const contextSubject = brainResult.subject || buildContextSubject({ name: lead.name, businessName: lead.businessName, formData: formFields }, fromName);
    const sendOpts = buildSendOpts(brainChannel, composedMessage, lead, {
      subject: contextSubject,
      fromName,
    });

    let messageSent = false;
    if (sendOpts) {
      const sendResult = await sendMessageWithRetry(resolvedContactId, sendOpts, { email: lead.email, phone: lead.phone, id: lead.id });
      if (sendResult.resolvedContactId !== resolvedContactId) resolvedContactId = sendResult.resolvedContactId;
      messageSent = sendResult.success;
      if (!messageSent) console.error(`[Webhook] Failed to send first-contact to lead ${leadId}: ${sendResult.error}`);
    }

    if (messageSent) {
      await addConversation({ leadId, channel: brainChannel, direction: "outbound", messageBody: composedMessage, senderType: "ai", senderName: fromName });
    } else {
      console.error(`[Webhook] First-contact message NOT stored in conversations — send failed for lead ${leadId}`);
    }

    // --- SCHEDULING & STAGE ADVANCEMENT ---
    const contactSchedule = await calculateNextFollowUp({ leadId, aiSuggestedHours: brainResult.nextEngagementHours || 4, triggerEvent: "ai_response" });
    // IMPORTANT: Preserve the detected channel as preferredChannel — don't let the scheduling
    // engine override it to SMS when the lead came from FB/IG/WhatsApp.
    const preservedChannel = channel; // the original detected channel from the multi-layer detection
    await updateLeadFields(leadId, {
      lastMessageAt: new Date(), nextFollowUpAt: contactSchedule.nextFollowUpAt,
      cadencePosition: contactSchedule.cadencePosition, preferredChannel: preservedChannel,
      lastOutboundChannel: brainChannel,
    });

    // Auto-advance GHL opportunity stage from "New Lead" to "Contacted"
    if (messageSent && lead.ghlOpportunityId && lead.ghlStageId) {
      const { NEW_LEAD_STAGE_IDS, CONTACTED_STAGE_IDS } = await import("../shared/ghl-stages");
      if (NEW_LEAD_STAGE_IDS.has(lead.ghlStageId)) {
        const contactedStageId = CONTACTED_STAGE_IDS[lead.ghlPipelineId || ""];
        if (contactedStageId) {
          try {
            await updateOpportunityStage(lead.ghlOpportunityId, contactedStageId);
            await updateLeadFields(leadId, { pipelineStage: "contacted", ghlStageId: contactedStageId });
            console.log(`[Webhook] Auto-advanced lead ${leadId} from new_lead \u2192 contacted in GHL (opp: ${lead.ghlOpportunityId})`);
          } catch (stageErr) {
            console.error(`[Webhook] Failed to auto-advance stage for lead ${leadId}:`, stageErr);
          }
        }
      }
    }

    await upsertAiState(leadId, {
      lastAngleUsed: brainResult.angle || "first_contact",
      lastFrameworkUsed: brainResult.framework || "DIRECT_RESPONSE",
      messageCount: 1,
    });

    console.log(`[Webhook] First-contact COMPLETE for lead ${leadId}: sent=${messageSent}, channel=${brainChannel}, framework=${brainResult.framework}`);
    console.log(`[Webhook] Brain Council composed: "${composedMessage.substring(0, 100)}..."`);
    console.log(`[Webhook] Strategy: ${brainResult.strategyReasoning?.substring(0, 200) || "N/A"}`);

    // =================================================================
    // AUTO-CREATE TASK + APPOINTMENT + NOTIFICATION (AFTER message sent)
    // Moved here from handleContactWebhook to prevent GHL bounce-back
    // webhooks from triggering humanTakeover before first-contact sends.
    // =================================================================
    try {
      const agentNameForTask = lead.assignedAgent || "Abby Bouwer";
      const leadLabel = lead.name || lead.businessName || `Lead #${lead.id}`;
      const agentGhlUserId = AGENT_GHL_USER_IDS[agentNameForTask];
      const agentCalendarId = AGENT_CALENDAR_IDS[agentNameForTask] || AGENT_CALENDAR_IDS["Abby Bouwer"];

      // 1. Compute next business hours slot (Mon-Fri 9am-5pm ET)
      const slot = getNextBusinessHoursSlot();
      const slotLabel = slot.start.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });

      // 2. Create GHL Task — "Call new contact"
      await createTask(resolvedContactId, {
        title: `\u260E Call New Contact: ${leadLabel}`,
        body: `New contact just entered the system. Call them during business hours.\n\nScheduled: ${slotLabel} ET\nBusiness: ${lead.businessName || "N/A"}\nPhone: ${lead.phone || "N/A"}\nEmail: ${lead.email || "N/A"}\nSource: ${lead.source || "N/A"}`,
        dueDate: slot.start.toISOString(),
        assignedTo: agentGhlUserId,
      });
      console.log(`[Webhook] Task created for lead ${leadId}: Call ${leadLabel} at ${slotLabel}`);

      // 3. Create GHL Appointment on agent's personal calendar
      const apptResult = await createAppointment({
        calendarId: agentCalendarId,
        contactId: resolvedContactId,
        title: `\u260E Call: ${leadLabel}`,
        description: `New contact call.\nBusiness: ${lead.businessName || "N/A"}\nPhone: ${lead.phone || "N/A"}\nEmail: ${lead.email || "N/A"}\nSource: ${lead.source || "N/A"}`,
        startTime: slot.start.toISOString(),
        endTime: slot.end.toISOString(),
        assignedUserId: agentGhlUserId,
        appointmentStatus: "confirmed",
      });
      if (apptResult) {
        console.log(`[Webhook] Appointment created for lead ${leadId} on ${agentNameForTask}'s calendar at ${slotLabel}`);
      }

      // 4. Add note to GHL contact (prefixed with robot emoji so bounce-back webhook is filtered)
      await addNote(resolvedContactId, `\ud83e\udd16 New contact auto-setup: Task + Appointment created for ${agentNameForTask} to call at ${slotLabel} ET.`);

      // 5. Internal notification to owner
      await notifyOwner({
        title: `\ud83d\udcde New Contact: ${leadLabel}`,
        content: `A new contact has entered the system.\n\n\u2022 Name: ${leadLabel}\n\u2022 Business: ${lead.businessName || "N/A"}\n\u2022 Phone: ${lead.phone || "N/A"}\n\u2022 Email: ${lead.email || "N/A"}\n\u2022 Source: ${lead.source || "N/A"}\n\u2022 Assigned to: ${agentNameForTask}\n\u2022 Call scheduled: ${slotLabel} ET\n\nTask and appointment have been created in GHL.\nFirst-contact message was ${messageSent ? "sent successfully" : "NOT sent"}.`,
      });
      console.log(`[Webhook] Owner notified about new contact ${leadId}`);
    } catch (autoErr) {
      console.error(`[Webhook] Auto-task/appointment/notification failed for lead ${leadId}:`, autoErr);
      // Non-fatal — first-contact message already sent
    }
  } catch (err) {
    console.error(`[Webhook] Delayed first-contact error for lead ${leadId}:`, err);
  }
}
