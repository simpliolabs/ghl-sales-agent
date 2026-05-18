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
import { upsertLead, updateLeadFields, getLeadById, getLeadByGhlContactId, getRecentAiOutboundCount, addConversation, upsertAiState, addAgentAssignment, getAgentWorkload, getConversationHistory, syncGhlDnd, insertDeferredResponse, hasPendingDeferredResponse, findExistingLeadByIdentity } from "./db";
import { classifySegment } from "./ai-brain";
import { researchLead } from "./lead-researcher";
import { calculateNextFollowUp, checkRateLimits, checkLeadRateLimit, checkDnc } from "./scheduling-engine";
import { handleChannelDnc, detectDncChannel } from "./channel-fallback";
import { getContact, fetchGhlConversationHistory, updateOpportunityStage, addNote } from "./ghl";
import { createHeadsUpNotification } from "./agent-notifications";
import { pushContactToOmnisend } from "./omnisend";
import {
  SALES_AGENTS,
  STAGES,
  resolveGhlContactId,
  extractContactData,
  sendMessageWithRetry,
  extractFormData,
  parseFormDataFromMessageBody,
  extractContactFieldsFromFormData,
  formatEmailHtml,
  buildSendOpts,
  buildContextSubject,
} from "./webhook-helpers";
import { handleStageAutomation } from "./webhook-pipeline";
import { runBrainCouncil } from "./brain-adapter";
import { shouldDeferResponse, getDeferredSendAt } from "./deferred-response-processor";
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

/**
 * PR#3.11: Detect preliminary channel from webhook payload signals.
 * Lightweight version of the 8-layer detection in sendDelayedFirstContact,
 * using only payload-level signals available immediately (no GHL API call).
 * Returns null if no social channel detected — lets sendDelayedFirstContact's
 * full 8-layer detection handle SMS/Email with conversation history context.
 */
export function detectPreliminaryChannel(
  payload: Record<string, unknown>,
  lead: { source?: string | null; phone?: string | null; email?: string | null }
): "SMS" | "Email" | "WhatsApp" | "FB" | "IG" | null {
  // Layer A: Payload type fields (numeric or string)
  const payloadType = String(payload.messageType || payload.type || "").toLowerCase();
  if (payloadType === "18" || payloadType.includes("instagram") || payloadType.includes("ig")) return "IG";
  if (payloadType === "4" || payloadType === "15" || payloadType.includes("facebook") || payloadType.includes("fb")) return "FB";
  if (payloadType === "19" || payloadType === "6" || payloadType.includes("whatsapp")) return "WhatsApp";

  // Layer B: Payload source field
  const src = (payload.source as string || "").toLowerCase();
  if (src.includes("instagram") || src.includes("ig")) return "IG";
  if (src.includes("facebook") || src.includes("fb") || src.includes("lead_form")) return "FB";
  if (src.includes("whatsapp")) return "WhatsApp";

  // Layer C: Lead source field
  const leadSrc = (lead.source || "").toLowerCase();
  if (leadSrc.includes("instagram") || leadSrc.includes("ig")) return "IG";
  if (leadSrc.includes("facebook") || leadSrc.includes("fb")) return "FB";
  if (leadSrc.includes("whatsapp")) return "WhatsApp";

  // Layer D: Attribution source
  const contact = payload.contact as Record<string, any> | undefined;
  const attrMedium = String(contact?.attributionSource?.medium || contact?.lastAttributionSource?.medium || "").toLowerCase();
  if (attrMedium.includes("instagram") || attrMedium.includes("ig")) return "IG";
  if (attrMedium.includes("facebook") || attrMedium.includes("fb")) return "FB";

  // Don't guess SMS/Email here — let sendDelayedFirstContact's 8-layer detection
  // handle that with full conversation history context. Returning null means
  // "keep whatever preferredChannel was set during upsert."
  return null;
}

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

  // --- FIX 12: DUPLICATE LEAD DEDUP ---
  // GHL sometimes sends different contact IDs for the same person within seconds.
  // After enrichment, check if there's already a lead with the same email or phone
  // but a different ghlContactId. If so, merge into the canonical (older) lead.
  if (lead) {
    try {
      const existingLead = await findExistingLeadByIdentity(
        lead.email,
        lead.phone,
        resolvedContactId,
      );
      if (existingLead) {
        console.log(`[Webhook] \u26A0\uFE0F DUPLICATE DETECTED: lead ${lead.id} (ghl=${resolvedContactId}) matches existing lead ${existingLead.id} (ghl=${existingLead.ghlContactId}) by email/phone. Merging into canonical lead ${existingLead.id}.`);
        const canonicalLead = await getLeadByGhlContactId(existingLead.ghlContactId!);
        if (canonicalLead) {
          const mergeUpdates: Record<string, unknown> = {};
          if (!canonicalLead.name && lead.name) mergeUpdates.name = lead.name;
          if (!canonicalLead.email && lead.email) mergeUpdates.email = lead.email;
          if (!canonicalLead.phone && lead.phone) mergeUpdates.phone = lead.phone;
          if (!canonicalLead.businessName && lead.businessName) mergeUpdates.businessName = lead.businessName;
          if (!canonicalLead.website && lead.website) mergeUpdates.website = lead.website;
          if (Object.keys(mergeUpdates).length > 0) {
            await updateLeadFields(existingLead.id, mergeUpdates);
            console.log(`[Webhook] Merged fields into canonical lead ${existingLead.id}: ${Object.keys(mergeUpdates).join(", ")}`);
          }
          // Switch to the canonical lead for the rest of this webhook
          lead = { ...canonicalLead, ...mergeUpdates } as typeof lead;
          resolvedContactId = existingLead.ghlContactId!;
          console.log(`[Webhook] Switched to canonical lead ${existingLead.id} for remaining processing`);
        }
      }
    } catch (dedupErr) {
      console.error(`[Webhook] Dedup check failed (non-fatal):`, dedupErr);
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

    // PR#3.11: Set preliminary preferredChannel from webhook signals BEFORE the
    // delayed first-contact. If sendDelayedFirstContact crashes, the follow-up
    // trigger uses this channel as fallback rather than defaulting to SMS.
    const preliminaryChannel = detectPreliminaryChannel(payload, lead);
    if (preliminaryChannel && preliminaryChannel !== lead.preferredChannel) {
      await updateLeadFields(lead.id, { preferredChannel: preliminaryChannel });
      console.log(`[Webhook] PR#3.11: Set preliminary preferredChannel=${preliminaryChannel} for lead ${lead.id}`);
    }

    // =================================================================
    // PHASE 1: HEADS-UP NOTIFICATION (fires immediately, before AI message)
    // Creates ONE appointment (10-min, next biz hour) + ONE task + ONE note.
    // This runs BEFORE the delayed first-contact so the agent always gets
    // notified about new contacts, even if the AI message is blocked by
    // rate limits, DNC, Brain Council rejection, or send failure.
    //
    // NOTE: We previously deferred this to after the message send to avoid
    // GHL bounce-back webhooks triggering humanTakeover. That is now handled
    // by the GHL numeric type filtering fix (types 28-40 are system activity,
    // not human agent messages). The appointment/task/note creation uses
    // addNote() and createTask()/createAppointment() which produce system
    // activity types that are now correctly filtered.
    // =================================================================
    try {
      const leadLabel = lead.name || lead.businessName || `Lead #${lead.id}`;
      const headsUpResult = await createHeadsUpNotification(
        {
          leadId: lead.id,
          ghlContactId: resolvedContactId,
          leadName: lead.name || null,
          businessName: lead.businessName || null,
          email: lead.email || null,
          phone: lead.phone || null,
          assignedAgent: lead.assignedAgent || null,
          pipelineValue: lead.pipelineValue ?? null,
          channel: lead.source || "unknown",
          existingAppointmentId: lead.appointmentId || null,
          existingTaskId: lead.ghlTaskId || null,
        },
        `New inquiry via ${lead.source || "unknown"}`,
      );
      console.log(`[Webhook] Heads-up notification for lead ${lead.id}: ${headsUpResult.actions.join(", ")}`);
      if (headsUpResult.errors.length > 0) {
        console.warn(`[Webhook] Heads-up errors for lead ${lead.id}: ${headsUpResult.errors.join(", ")}`);
      }

      // Notify owner about the new contact
      await notifyOwner({
        title: `\u{1F4DE} New Contact: ${leadLabel}`,
        content: `A new contact has entered the system.\n\n\u2022 Name: ${leadLabel}\n\u2022 Business: ${lead.businessName || "N/A"}\n\u2022 Phone: ${lead.phone || "N/A"}\n\u2022 Email: ${lead.email || "N/A"}\n\u2022 Source: ${lead.source || "N/A"}\n\u2022 Assigned to: ${lead.assignedAgent || "Abby Bouwer"}\n\nHeads-up appointment + task created in GHL.\nAI will attempt first-contact in ${FIRST_CONTACT_DELAY_MS / 1000}s.`,
        priority: "standard",
      });
    } catch (autoErr) {
      console.error(`[Webhook] Heads-up notification failed for lead ${lead.id}:`, autoErr);
      // Non-fatal — continue to delayed first-contact
    }

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
        .catch(err => {
          const msg = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : "";
          console.error(`[Webhook] ❌ PR#3.11: Delayed first-contact FAILED for lead ${leadId}: ${msg}`);
          if (stack) console.error(`[Webhook] Stack:\n${stack}`);
        })
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
export async function sendDelayedFirstContact(
  leadId: number,
  leadSnapshot: Record<string, unknown>,
  payload: Record<string, unknown>,
  resolvedContactId: string,
) {
  try {
    console.log(`[Webhook] Delayed first-contact firing for lead ${leadId} (${FIRST_CONTACT_DELAY_MS / 1000}s after webhook)`);

    // Re-read lead from DB to get latest state (agent assignment, etc.)
    const leadOrNull = await getLeadById(leadId);
    if (!leadOrNull) {
      console.log(`[Webhook] Lead ${leadId} not found for delayed first-contact — skipping`);
      return;
    }
    let lead = leadOrNull;

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

    // --- FRESH GHL HISTORY CHECK (catches agent activity during the 45s delay) ---
    // The humanTakeover DB flag may not be set yet because GHL's outbound webhook
    // for the agent's reply hasn't been processed. Scan GHL conversation history
    // directly to detect any outbound messages sent during the delay window.
    try {
      const freshGhlHistory = await fetchGhlConversationHistory(resolvedContactId);
      if (freshGhlHistory.length > 0) {
        const DELAY_WINDOW_MS = FIRST_CONTACT_DELAY_MS + 30_000; // 45s delay + 30s buffer
        const now = Date.now();
        // Find any outbound messages sent within the delay window that aren't system messages
        const SYSTEM_PATTERNS_FC = [
          "opportunity created", "opportunity moved", "created in stage", "moved to stage",
          "workflow", "automation", "task created", "task completed",
          "appointment", "booking confirmed", "note added", "pipeline",
          "form submitted", "tag added", "tag removed",
        ];
        const recentAgentMsgs = freshGhlHistory.filter(m => {
          if (m.direction !== "outbound" || !m.body?.trim() || !m.dateAdded) return false;
          const msgAge = now - new Date(m.dateAdded).getTime();
          if (msgAge > DELAY_WINDOW_MS) return false;
          const body = m.body.toLowerCase().trim();
          if (body.length < 10) return false;
          if (SYSTEM_PATTERNS_FC.some(p => body.includes(p))) return false;
          // PR#3.10: Require userId to classify as human agent activity.
          // GHL workflows (e.g. "WAIT! You're not done yet..." promo template) produce
          // outbound messages WITHOUT userId — those are automation, not human agents.
          // Without this guard, workflow messages during the 45s delay window get
          // misclassified as agent takeover and block AI first-contact entirely.
          // This matches the userId requirement enforced in ghl.ts Layer B (PR#3.5).
          return Boolean(m.userId || (m as any).user?.id);
        });

        // PR#3.10: Diagnostic log for workflow messages that no longer trigger takeover
        const ignoredOutboundCount = freshGhlHistory.filter(m => 
          m.direction === "outbound" && 
          m.body?.trim() && 
          m.dateAdded &&
          (now - new Date(m.dateAdded).getTime()) <= DELAY_WINDOW_MS &&
          !m.userId && !(m as any).user?.id
        ).length;
        if (ignoredOutboundCount > 0 && recentAgentMsgs.length === 0) {
          console.log(`[Webhook] PR#3.10: Ignored ${ignoredOutboundCount} non-user GHL outbound message(s) during first-contact delay window for lead ${leadId} (likely workflow/automation)`);
        }

        if (recentAgentMsgs.length > 0) {
          const latestMsg = recentAgentMsgs.sort((a, b) =>
            new Date(b.dateAdded).getTime() - new Date(a.dateAdded).getTime()
          )[0];
          const minutesAgo = Math.round((now - new Date(latestMsg.dateAdded).getTime()) / 60000);
          console.log(`[Webhook] \u{1F6D1} AGENT DETECTED during delay for lead ${leadId}: outbound message ${minutesAgo}min ago (userId=${latestMsg.userId || 'none'}): "${latestMsg.body.substring(0, 80)}". Setting humanTakeover=1 and SKIPPING first-contact.`);
          await updateLeadFields(leadId, { humanTakeover: 1, lastAgentActivityAt: new Date(latestMsg.dateAdded) });
          return;
        }
      }
    } catch (ghlCheckErr) {
      // Non-fatal — if we can't check GHL history, proceed with other guards
      console.error(`[Webhook] GHL history re-check failed for lead ${leadId} (non-fatal):`, ghlCheckErr);
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
    let ghlHistory: any[] = [];
    try {
      ghlHistory = await fetchGhlConversationHistory(resolvedContactId);
    } catch (ghlErr) {
      console.error(`[Webhook] PR#3.11: GHL history fetch failed for lead ${leadId} (non-fatal, proceeding with empty history):`, ghlErr instanceof Error ? ghlErr.message : ghlErr);
      // Empty array allows channel detection to fall through to Layer 0B / Layer 7B
      // (form data + payload-based channel detection) instead of crashing
    }

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

    // --- PERSIST FORM CONTACT FIELDS TO LEAD ---
    // Extract email, phone, name, businessName from form data and update the lead record
    // BEFORE the Brain Council runs. This ensures the composer prompt sees "already on file"
    // instead of triggering the "ask for contact details" directive.
    if (formFields.length > 0) {
      const formContactFields = extractContactFieldsFromFormData(formFields);
      if (Object.keys(formContactFields).length > 0) {
        // Only update fields that are currently missing on the lead
        const missingUpdates: Record<string, string> = {};
        if (formContactFields.email && !lead.email) missingUpdates.email = formContactFields.email;
        if (formContactFields.phone && !lead.phone) missingUpdates.phone = formContactFields.phone;
        if (formContactFields.name && !lead.name) missingUpdates.name = formContactFields.name;
        if (formContactFields.businessName && !lead.businessName) missingUpdates.businessName = formContactFields.businessName;

        if (Object.keys(missingUpdates).length > 0) {
          await updateLeadFields(leadId, missingUpdates);
          lead = { ...lead, ...missingUpdates } as typeof lead;
          console.log(`[Webhook] ✅ Persisted form contact fields to lead ${leadId}: ${Object.entries(missingUpdates).map(([k, v]) => `${k}=${v}`).join(", ")}`);
        }
      }
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
    // the lead came from a Facebook/IG lead form. Check the GHL message type to
    // distinguish Instagram forms (type 18) from Facebook forms (type 4/15).
    if (formExtractedFromConversation) {
      // Check the actual GHL message type to distinguish IG vs FB forms
      const formMsg = ghlHistory.filter(m => m.direction === "inbound").find(m => {
        const body = String(m.body || "");
        return body.includes(":") && parseFormDataFromMessageBody(body).length > 0;
      });
      const formMsgType = String(formMsg?.type || formMsg?.messageType || "").toLowerCase();
      if (formMsgType === "18" || formMsgType.includes("instagram") || formMsgType.includes("type_instagram")) {
        detectedChannel = "IG";
        console.log(`[Webhook] Channel detection Layer 0 HIT for lead ${leadId}: form data in IG message (type=${formMsgType}) → IG`);
      } else {
        detectedChannel = "FB";
        console.log(`[Webhook] Channel detection Layer 0 HIT for lead ${leadId}: form data found in conversation body (type=${formMsgType}) → FB`);
      }
    }

    // Layer 0B (FALLBACK FOR EMPTY GHL HISTORY): If form data exists from webhook payload
    // or custom fields but GHL conversation history is empty (GHL hadn't indexed the FB
    // form message yet at the 45s mark), the lead almost certainly came from a Facebook
    // lead form. Form data with structured fields (Company name, Products, etc.) is the
    // hallmark of FB/IG lead forms — no other channel produces this format.
    if (!detectedChannel && formFields.length > 0 && ghlHistory.length === 0) {
      detectedChannel = "FB";
      console.log(`[Webhook] Channel detection Layer 0B HIT for lead ${leadId}: form data present but GHL history empty → FB (lead form before GHL indexed)`);
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
        // GHL uses BOTH old numeric types (2-6) AND new types (15-19):
        // Old: 2=SMS, 3=Email, 4=FB, 5=IG, 6=WhatsApp
        // New: 15=FB, 16=Email(?), 17=SMS(?), 18=Instagram, 19=WhatsApp
        // Also match messageType strings like TYPE_INSTAGRAM, TYPE_WHATSAPP
        const msgTypeStr = String(lastInbound.messageType || "").toLowerCase();
        if (rawType === "18" || rawType === "5" || rawType.includes("ig") || rawType.includes("instagram") || msgTypeStr.includes("instagram")) detectedChannel = "IG";
        else if (rawType === "19" || rawType === "6" || rawType.includes("whatsapp") || msgTypeStr.includes("whatsapp")) detectedChannel = "WhatsApp";
        else if (rawType === "4" || rawType === "15" || rawType.includes("fb") || rawType.includes("facebook") || rawType.includes("live_chat") || msgTypeStr.includes("facebook")) detectedChannel = "FB";
        else if (rawType === "3" || rawType.includes("email") || msgTypeStr.includes("email")) detectedChannel = "Email";
        else if (rawType === "2" || rawType.includes("sms") || msgTypeStr.includes("sms")) detectedChannel = "SMS";
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

    // Layer 7: Check contact.attributionSource.medium (GHL stores FB/IG lead form source here)
    if (!detectedChannel) {
      const contact = payload.contact as Record<string, any> | undefined;
      const attrMedium = String(contact?.attributionSource?.medium || contact?.lastAttributionSource?.medium || "").toLowerCase();
      const attrSession = String(contact?.attributionSource?.sessionSource || contact?.lastAttributionSource?.sessionSource || "").toLowerCase();
      if (attrMedium.includes("facebook") || attrMedium.includes("fb")) {
        detectedChannel = "FB";
        console.log(`[Webhook] Channel detection Layer 7 HIT for lead ${leadId}: attributionSource.medium=${attrMedium} → FB`);
      } else if (attrMedium.includes("instagram") || attrMedium.includes("ig")) {
        detectedChannel = "IG";
        console.log(`[Webhook] Channel detection Layer 7 HIT for lead ${leadId}: attributionSource.medium=${attrMedium} → IG`);
      } else if (attrSession.includes("social") && (attrMedium.includes("facebook") || attrMedium.includes("fb"))) {
        detectedChannel = "FB";
      }
    }

    // Layer 7B: If form data exists and we STILL haven't detected a channel,
    // the lead came from a form (FB/IG lead form) but all signal layers missed.
    // This is the last chance before the generic SMS/Email fallback.
    if (!detectedChannel && formFields.length > 0) {
      detectedChannel = "FB";
      console.log(`[Webhook] Channel detection Layer 7B HIT for lead ${leadId}: form data present, all other layers missed → FB (form = lead form)`);
    }

    // Layer 8: Default fallback — phone → SMS, email-only → Email
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
      // ARCHITECTURE FIX: When Brain Council blocks, NEVER send fallback.
      // If the AI couldn't compose a quality message, sending a generic one is worse.
      // The follow-up trigger will retry on the next scheduled cycle.
      if (brainResult.fallbackUsed && brainResult.fallbackMessage) {
        console.log(`[Webhook] 🚫 Fallback SUPPRESSED for lead ${leadId} — blocked messages never send fallbacks`);
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
    let brainChannel = isDetectedSocial ? channel : (brainResult.channel || channel);
    // REMOVED (Fix 11): Migrated channel restriction was a one-time migration, now removed.
    if (brainResult.channel && brainResult.channel !== brainChannel) {
      console.log(`[Webhook] First-contact channel: detected=${channel}, brain=${brainResult.channel}, using=${brainChannel} (${isDetectedSocial ? 'detected social channel enforced' : 'brain override allowed'})`);
    }

    // ================================================================
    // AGENT-FIRST DELAY (15 minutes during business hours)
    // During Mon-Fri 9am-5pm EST, new leads get a 15-minute window for
    // the human agent to reach out first. The Brain Council has already
    // run (appointment + task created), but the AI message is stored in
    // deferred_responses instead of being sent immediately.
    //
    // This is the SAME deferral logic used in webhook-message.ts but
    // applied to the contact webhook's first-contact path.
    // ================================================================
    if (shouldDeferResponse(lead, 0)) {
      // Check if there's already a pending deferred response for this lead
      const alreadyDeferred = await hasPendingDeferredResponse(leadId);
      if (!alreadyDeferred) {
        const sendAt = getDeferredSendAt();
        const emailSubject = brainChannel === "Email"
          ? (brainResult.subject || buildContextSubject({ name: lead.name, businessName: lead.businessName, formData: formFields }, fromName))
          : undefined;
        const emailHtml = brainChannel === "Email" ? formatEmailHtml(composedMessage) : undefined;

        await insertDeferredResponse({
          leadId,
          ghlContactId: resolvedContactId,
          channel: brainChannel,
          messageBody: composedMessage,
          emailSubject,
          emailHtml,
          fromName,
          sendAt,
          brainCouncilOutput: {
            score: brainResult.score,
            segment: brainResult.segment,
            angle: brainResult.angle,
            framework: brainResult.framework,
            nextEngagementHours: brainResult.nextEngagementHours,
          },
        });

        // Still update scheduling fields so the lead isn't "lost" in the system
        const preservedChannel = channel;
        await updateLeadFields(leadId, {
          preferredChannel: preservedChannel,
          lastOutboundChannel: brainChannel,
        });

        console.log(`[Webhook/AgentFirst] \u23F3 DEFERRED first-contact for NEW lead ${leadId} (${lead.name || "Unknown"}) \u2014 agent has 15min window until ${sendAt.toISOString()}. Channel=${brainChannel}`);

        // Still update AI state so follow-up trigger knows Brain Council already ran
        await upsertAiState(leadId, {
          lastAngleUsed: brainResult.angle || "first_contact",
          lastFrameworkUsed: brainResult.framework || "DIRECT_RESPONSE",
          messageCount: 0, // Not sent yet — will be incremented when deferred processor sends
        });

        return; // Exit — deferred processor will handle the actual send
      }
    }

    // --- IMMEDIATE SEND (outside business hours or deferral not applicable) ---
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

    // NOTE: Heads-up notification (appointment + task + note) now fires in
    // handleContactWebhook() BEFORE the delayed first-contact, so the agent
    // is always notified regardless of whether the AI message sends.
  } catch (err) {
    console.error(`[Webhook] Delayed first-contact error for lead ${leadId}:`, err);
  }
}
