/**
 * WEBHOOK HELPERS — Shared utilities, constants, and types for all webhook handlers
 */

import { getContact, searchContacts, sendMessage, updateContactCustomField } from "./ghl";
import { updateLeadFields } from "./db";

// --- GHL SEND ERROR CLASSIFICATION ---
// Classifies GHL API error responses into actionable categories so callers
// can take the right corrective action instead of just logging and moving on.
export type GhlSendErrorType =
  | "missing_phone"       // Contact has no phone number — cannot send SMS/WhatsApp
  | "missing_email"       // Contact has no email — cannot send Email
  | "invalid_email"       // Email address exists but is malformed/rejected
  | "carrier_block"       // Carrier or GHL filtered/blocked the SMS delivery
  | "contact_not_found"   // Contact ID not found in GHL
  | "dnd"                 // Contact is DND / opted out
  | "transient"           // Temporary error (rate limit, timeout) — safe to retry
  | "unknown";            // Unclassified error

export interface GhlSendError {
  type: GhlSendErrorType;
  message: string;
  status?: number;
  raw?: unknown;
}

export function classifyGhlSendError(err: unknown): GhlSendError {
  const status = (err as any)?.response?.status as number | undefined;
  const errData = (err as any)?.response?.data;
  const errMsg = (JSON.stringify(errData || {}) + " " + String((err as any)?.message || "")).toLowerCase();

  // DND / opt-out
  if ((err as any)?.isDndRejection ||
      errMsg.includes("dnd") || errMsg.includes("do not disturb") ||
      errMsg.includes("unsubscribed") || errMsg.includes("opted out") ||
      errMsg.includes("stop") || status === 403) {
    return { type: "dnd", message: "Contact is DND/opted-out", status, raw: errData };
  }

  // Missing phone
  if (errMsg.includes("missing phone") || errMsg.includes("no phone") ||
      errMsg.includes("phone number is required") || errMsg.includes("contact has no phone")) {
    return { type: "missing_phone", message: "Contact has no phone number", status, raw: errData };
  }

  // Missing email
  if (errMsg.includes("no email") || errMsg.includes("contact has no email") ||
      errMsg.includes("email is required") || errMsg.includes("missing email")) {
    return { type: "missing_email", message: "Contact has no email address", status, raw: errData };
  }

  // Invalid email
  if (errMsg.includes("invalid email") || errMsg.includes("invalid e-mail") ||
      errMsg.includes("unable to send e-mail") || errMsg.includes("email.*invalid") ||
      errMsg.includes("invalid_email")) {
    return { type: "invalid_email", message: "Contact email address is invalid", status, raw: errData };
  }

  // Contact not found
  if (status === 400 || status === 404) {
    return { type: "contact_not_found", message: "Contact not found in GHL", status, raw: errData };
  }

  // Carrier block / undeliverable (422 often means GHL validation failure)
  if (status === 422 || errMsg.includes("carrier") || errMsg.includes("undeliverable") ||
      errMsg.includes("landline") || errMsg.includes("not a mobile") ||
      errMsg.includes("invalid number") || errMsg.includes("number is not valid")) {
    return { type: "carrier_block", message: "SMS carrier block or invalid number", status, raw: errData };
  }

  // Transient errors
  if (status === 429 || status === 503 || status === 502 || status === 504 ||
      errMsg.includes("rate limit") || errMsg.includes("timeout") || errMsg.includes("econnreset")) {
    return { type: "transient", message: "Transient GHL error — safe to retry", status, raw: errData };
  }

  return { type: "unknown", message: String((err as any)?.message || err), status, raw: errData };
}

// --- TEAM ROSTER ---
export const SALES_AGENTS = ["Abby Bouwer", "Chris McHendry"];
export const DESIGNER = "César Vásquez";
export const PRODUCTION_MANAGER = "Cindy Muchnick";

// --- PIPELINE STAGES ---
export const STAGES = {
  NEW_LEAD: "New Lead",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  QUOTE_SENT: "Quote Sent",
  PAID_PROOF_NEEDED: "Paid - Proof Needed",
  PROOF_SENT: "Proof Sent",
  APPROVED: "Approved + Deposit",
  IN_PRODUCTION: "In Production",
  READY: "Ready",
  DELIVERED: "Delivered",
} as const;

// --- GHL CONTACT ID RESOLUTION ---
export async function resolveGhlContactId(
  webhookContactId: string,
  fallbackEmail?: string | null,
  fallbackPhone?: string | null
): Promise<{ resolvedId: string; contact: Record<string, unknown> } | null> {
  try {
    const contact = await getContact(webhookContactId);
    if (contact) return { resolvedId: webhookContactId, contact };
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status !== 400 && status !== 404) {
      console.error(`[GHL Resolve] Unexpected error for ${webhookContactId}:`, err);
    } else {
      console.log(`[GHL Resolve] Contact ${webhookContactId} not found (${status}), trying search...`);
    }
  }

  if (fallbackEmail) {
    try {
      const results = await searchContacts(fallbackEmail, 1);
      if (results.length > 0) {
        console.log(`[GHL Resolve] Found contact by email ${fallbackEmail}: ${results[0].id}`);
        return { resolvedId: results[0].id, contact: results[0] };
      }
    } catch (err) { console.error(`[GHL Resolve] Email search failed:`, err); }
  }

  if (fallbackPhone) {
    try {
      const results = await searchContacts(fallbackPhone, 1);
      if (results.length > 0) {
        console.log(`[GHL Resolve] Found contact by phone ${fallbackPhone}: ${results[0].id}`);
        return { resolvedId: results[0].id, contact: results[0] };
      }
    } catch (err) { console.error(`[GHL Resolve] Phone search failed:`, err); }
  }

  console.log(`[GHL Resolve] Could not resolve contact for webhook ID ${webhookContactId}`);
  return null;
}

// --- GHL API FALLBACK ENRICHMENT ---
export function extractContactData(ghlContact: Record<string, unknown>): Record<string, unknown> {
  const enriched: Record<string, unknown> = {};
  const ghlName = (ghlContact.name as string) || (ghlContact.firstName ? `${ghlContact.firstName} ${ghlContact.lastName || ""}`.trim() : null);
  if (ghlName) enriched.name = ghlName;
  if (ghlContact.email) enriched.email = ghlContact.email;
  if (ghlContact.phone) enriched.phone = ghlContact.phone;
  if (ghlContact.companyName) enriched.businessName = ghlContact.companyName;
  if (ghlContact.website) enriched.website = ghlContact.website;
  if (ghlContact.source) enriched.source = ghlContact.source;
  return enriched;
}

// --- SEND MESSAGE WITH RETRY ---
export async function sendMessageWithRetry(
  contactId: string,
  opts: Parameters<typeof sendMessage>[1],
  lead: { email?: string | null; phone?: string | null; id: number }
): Promise<{ success: boolean; resolvedContactId: string; error?: string; errorType?: GhlSendErrorType; correctionTaken?: string; emailMessageId?: string }> {
  try {
    const result = await sendMessage(contactId, opts);
    // ── CHECK FOR BLOCKED SENDS ──────────────────────────────────────────
    // ghl.sendMessage returns { blocked: true, reason: string } when pre-flight
    // gates (AI_OFFLINE, COOLDOWN, HUMAN_AGENT_ACTIVE) block the message.
    // These are resolved promises, NOT thrown errors — so we must check explicitly.
    if ((result as any)?.blocked) {
      const reason = (result as any).reason || "UNKNOWN_GATE";
      console.warn(`[SendRetry] Send BLOCKED by gate — reason=${reason} channel=${opts.type} lead=${lead.id} contact=${contactId}`);
      return { success: false, resolvedContactId: contactId, error: `Send blocked: ${reason}`, errorType: "unknown" as GhlSendErrorType, correctionTaken: `blocked_by_${reason.toLowerCase()}` };
    }
    return { success: true, resolvedContactId: contactId, emailMessageId: (result as any)?.emailMessageId };
  } catch (err: unknown) {
    const classified = classifyGhlSendError(err);
    const channel = opts.type;

    console.warn(`[SendRetry] GHL send failed — type=${classified.type} channel=${channel} lead=${lead.id}: ${classified.message}`);

    // ── CONTACT NOT FOUND: resolve real GHL ID and retry ──────────────────────
    if (classified.type === "contact_not_found") {
      console.log(`[SendRetry] Contact ${contactId} not found, resolving real ID...`);
      const resolved = await resolveGhlContactId(contactId, lead.email, lead.phone);
      if (resolved && resolved.resolvedId !== contactId) {
        await updateLeadFields(lead.id, { ghlContactId: resolved.resolvedId });
        console.log(`[SendRetry] Resolved to ${resolved.resolvedId}, retrying send...`);
        try {
          await sendMessage(resolved.resolvedId, opts);
          return { success: true, resolvedContactId: resolved.resolvedId, correctionTaken: "resolved_contact_id" };
        } catch (retryErr: unknown) {
          const retryClassified = classifyGhlSendError(retryErr);
          console.error(`[SendRetry] Retry also failed (${retryClassified.type}):`, retryClassified.message);
          return { success: false, resolvedContactId: resolved.resolvedId, error: retryClassified.message, errorType: retryClassified.type };
        }
      }
      return { success: false, resolvedContactId: contactId, error: classified.message, errorType: classified.type };
    }

    // ── MISSING PHONE: attempt email fallback if available ────────────────────
    if (classified.type === "missing_phone") {
      if (lead.email) {
        console.log(`[SendRetry] Missing phone for lead ${lead.id} — attempting Email fallback`);
        try {
          const fbSubject = (opts as any)._contextSubject || "Adorb Custom Tees";
          await sendMessage(contactId, { type: "Email", subject: fbSubject, html: opts.message || "", message: opts.message });
          return { success: true, resolvedContactId: contactId, correctionTaken: "fallback_to_email" };
        } catch (fbErr: unknown) {
          const fbClassified = classifyGhlSendError(fbErr);
          console.error(`[SendRetry] Email fallback also failed (${fbClassified.type}):`, fbClassified.message);
          // Mark lead as no-contact-info if email also fails
          try { await updateLeadFields(lead.id, { lastAgentNote: `[AUTO] No valid phone or email — cannot reach via any channel` }); } catch { /* best effort */ }
          return { success: false, resolvedContactId: contactId, error: fbClassified.message, errorType: fbClassified.type, correctionTaken: "fallback_to_email_failed" };
        }
      }
      // No email either — mark as unreachable, reschedule far out
      console.warn(`[SendRetry] Lead ${lead.id} has no phone AND no email — marking unreachable`);
      try { await updateLeadFields(lead.id, { lastAgentNote: `[AUTO] No phone or email on file — cannot reach via any channel. Rescheduled 30 days.` }); } catch { /* best effort */ }
      return { success: false, resolvedContactId: contactId, error: "No phone or email available", errorType: "missing_phone", correctionTaken: "marked_unreachable" };
    }

    // ── MISSING / INVALID EMAIL: attempt SMS fallback if available ─────────────
    if (classified.type === "missing_email" || classified.type === "invalid_email") {
      const label = classified.type === "invalid_email" ? "invalid email" : "missing email";
      if (lead.phone) {
        console.log(`[SendRetry] ${label} for lead ${lead.id} — attempting SMS fallback`);
        try {
          await sendMessage(contactId, { type: "SMS", message: opts.message || "" });
          return { success: true, resolvedContactId: contactId, correctionTaken: "fallback_to_sms" };
        } catch (fbErr: unknown) {
          const fbClassified = classifyGhlSendError(fbErr);
          console.error(`[SendRetry] SMS fallback also failed (${fbClassified.type}):`, fbClassified.message);
          return { success: false, resolvedContactId: contactId, error: fbClassified.message, errorType: fbClassified.type, correctionTaken: "fallback_to_sms_failed" };
        }
      }
      // No phone either
      console.warn(`[SendRetry] Lead ${lead.id} has ${label} AND no phone — marking unreachable`);
      try { await updateLeadFields(lead.id, { lastAgentNote: `[AUTO] ${label} and no phone on file — cannot reach. Rescheduled 30 days.` }); } catch { /* best effort */ }
      return { success: false, resolvedContactId: contactId, error: `${label} and no phone fallback`, errorType: classified.type, correctionTaken: "marked_unreachable" };
    }

    // ── CARRIER BLOCK / 422: flag dndSms, attempt email fallback ──────────────
    if (classified.type === "carrier_block") {
      console.warn(`[SendRetry] Carrier block for lead ${lead.id} — flagging dndSms, attempting Email fallback`);
      try { await updateLeadFields(lead.id, { dndSms: 1 as any }); } catch { /* best effort */ }
      if (lead.email) {
        try {
          const cbSubject = (opts as any)._contextSubject || "Adorb Custom Tees";
          await sendMessage(contactId, { type: "Email", subject: cbSubject, html: opts.message || "", message: opts.message });
          return { success: true, resolvedContactId: contactId, correctionTaken: "carrier_block_fallback_to_email" };
        } catch (fbErr: unknown) {
          const fbClassified = classifyGhlSendError(fbErr);
          console.error(`[SendRetry] Email fallback after carrier block also failed:`, fbClassified.message);
          return { success: false, resolvedContactId: contactId, error: fbClassified.message, errorType: fbClassified.type, correctionTaken: "carrier_block_all_channels_failed" };
        }
      }
      return { success: false, resolvedContactId: contactId, error: "Carrier block — SMS flagged DND, no email fallback", errorType: "carrier_block", correctionTaken: "carrier_block_dnd_flagged" };
    }

    // ── DND: already handled in ghl.ts (throws isDndRejection) — surface cleanly
    if (classified.type === "dnd") {
      console.warn(`[SendRetry] DND rejection for lead ${lead.id} on ${channel}`);
      return { success: false, resolvedContactId: contactId, error: "DND rejection", errorType: "dnd" };
    }

    // ── TRANSIENT / UNKNOWN: surface error for caller to decide ───────────────
    return { success: false, resolvedContactId: contactId, error: classified.message, errorType: classified.type };
  }
}

// --- EVENT TYPE DETECTION ---
export type WebhookEventType = "contact" | "message" | "pipeline" | "task" | "appointment" | "note" | "email_event" | "contact_dnd" | "opportunity" | "unknown";

export function detectEventType(payload: Record<string, unknown>): WebhookEventType {
  // --- Workflow-name-based detection (highest priority — explicit intent from GHL workflow app) ---
  // These payloads arrive from installed GHL workflow apps and carry a workflow.name field
  const workflowName = (
    (payload.workflow as Record<string, unknown>)?.name ||
    payload.workflowName ||
    payload.workflow_name ||
    ""
  ) as string;
  const wn = workflowName.toLowerCase();
  if (wn) {
    // Agent outbound message (manual send from GHL UI)
    if (wn.includes("outbound message manual") || wn.includes("agent outbound") || wn.includes("outbound manual")) return "message";
    // Outbound workflow message (sent by automation — still route as message so we can detect source)
    if (wn.includes("outbound message workflow") || wn.includes("outbound workflow")) return "message";
    // Email engagement events
    if (wn.includes("email event") || wn.includes("email open") || wn.includes("email click") ||
        wn.includes("email bounce") || wn.includes("email unsubscribe")) return "email_event";
    // Appointment events
    if (wn.includes("appointment") || wn.includes("booking")) return "appointment";
    // DND / opt-out events
    if (wn.includes("dnd") || wn.includes("opt out") || wn.includes("do not disturb")) return "contact_dnd";
    // Note events
    if (wn.includes("note") || wn.includes("agent note")) return "note";
    // Opportunity events
    if (wn.includes("opportunity") || wn.includes("deal")) return "opportunity";
    // Contact events
    if (wn.includes("contact create") || wn.includes("new contact") || wn.includes("new lead")) return "contact";
    // Pipeline events
    if (wn.includes("pipeline") || wn.includes("stage change") || wn.includes("stage moved")) return "pipeline";
  }

  // --- Appointment events (GHL API v2 + workflow) ---
  if (payload.type === "AppointmentCreate" || payload.type === "AppointmentUpdate" || payload.type === "AppointmentDelete"
    || payload.event === "appointment.scheduled" || payload.event === "appointment.rescheduled"
    || payload.event === "appointment.cancelled" || payload.event === "appointment.noshow"
    || payload.event === "appointment.completed" || payload.appointmentStatus) return "appointment";
  // --- Note events (GHL API v2 + workflow) ---
  if (payload.type === "NoteCreate" || payload.type === "NoteUpdate" || payload.event === "note.create"
    || payload.event === "note.update" || payload.event === "note.delete"
    || (payload.noteBody && payload.contactId)) return "note";
  // --- Email engagement events (GHL API v2) ---
  if (payload.event === "email.opened" || payload.event === "email.clicked"
    || payload.event === "email.bounced" || payload.event === "email.complained"
    || payload.event === "email.unsubscribed" || payload.type === "EmailStats"
    || (payload.emailEvent && typeof payload.emailEvent === "string")) return "email_event";
  // --- Contact DND changes (GHL API v2 + workflow) ---
  if (payload.type === "ContactDndUpdate" || payload.event === "contact.dnd.update"
    || (payload.dndSettings && payload.contactId)) return "contact_dnd";
  // --- Opportunity (non-pipeline) updates ---
  if (payload.event === "opportunity.monetary_value.update" || payload.event === "opportunity.status.update"
    || payload.event === "opportunity.create" || payload.event === "opportunity.delete"
    || payload.type === "OpportunityCreate" || payload.type === "OpportunityUpdate"
    || payload.type === "OpportunityMonetaryValueUpdate" || payload.type === "OpportunityStatusUpdate") return "opportunity";
  // --- Existing event types ---
  if (payload.type === "ContactCreate" || payload.type === "ContactUpdate" || payload.event === "contact.create") return "contact";
  if (payload.type === "InboundMessage" || payload.type === "OutboundMessage" || payload.event === "message.received" || payload.messageType) return "message";
  if (payload.type === "PipelineStageChanged" || payload.event === "opportunity.stageUpdate" || payload.currentStage || payload.toStage) return "pipeline";
  if (payload.type === "TaskCompleted" || payload.event === "task.completed" || (payload.taskId && payload.status === "completed")) return "task";
  if (payload.body && payload.contactId && (payload.direction || payload.messageId)) return "message";
  // GHL workflow payloads: message nested in payload.message.body, contact ID in contact_id
  const msg = payload.message as Record<string, unknown> | undefined;
  if (msg && typeof msg === "object" && msg.body && (payload.contact_id || payload.contactId)) return "message";
  // GHL workflow pipeline payloads: pipeline info in top-level fields
  if (payload.pipleline_stage || payload.pipeline_stage || payload.pipeline_id) return "pipeline";
  if (payload.pipelineId || payload.stageName) return "pipeline";
  return "unknown";
}

// --- NORMALIZE GHL WORKFLOW PAYLOAD ---
// GHL workflow webhooks use a different format than direct API webhooks.
// This normalizer converts workflow payloads to the standard format our handlers expect.
export function normalizeWorkflowPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...payload };

  // Normalize contact_id → contactId
  if (!normalized.contactId && normalized.contact_id) {
    normalized.contactId = normalized.contact_id;
  }

  // Normalize nested message.body → top-level body
  const msg = normalized.message as Record<string, unknown> | undefined;
  if (msg && typeof msg === "object" && msg.body && !normalized.body) {
    normalized.body = msg.body;
    // Detect direction from message type or workflow name
    if (!normalized.direction) {
      const wn2 = (
        (normalized.workflow as Record<string, unknown>)?.name ||
        normalized.workflowName ||
        normalized.workflow_name ||
        ""
      ) as string;
      if (wn2.toLowerCase().includes("outbound")) {
        normalized.direction = "outbound";
      } else {
        normalized.direction = "inbound";
      }
    }
  }

  // Normalize outbound message payloads that don't have nested message.body
  // (some GHL workflow apps send the body at top level with a direction field)
  if (!normalized.direction) {
    const wn3 = (
      (normalized.workflow as Record<string, unknown>)?.name ||
      normalized.workflowName ||
      normalized.workflow_name ||
      ""
    ) as string;
    if (wn3.toLowerCase().includes("outbound")) {
      normalized.direction = "outbound";
    }
  }

  // Normalize email event payloads from workflow apps
  // GHL email event workflow payloads may carry event type in different fields
  if (!normalized.emailEvent && normalized.email_event) {
    normalized.emailEvent = normalized.email_event;
  }
  if (!normalized.emailEvent && normalized.event_type) {
    normalized.emailEvent = normalized.event_type;
  }

  // Normalize workflow-based pipeline payloads
  if (!normalized.pipelineStage && normalized.pipleline_stage) {
    normalized.toStage = normalized.pipleline_stage;
  }
  if (!normalized.pipelineStage && normalized.pipeline_stage) {
    normalized.toStage = normalized.pipeline_stage;
  }
  if (!normalized.pipelineId && normalized.pipeline_id) {
    normalized.pipelineId = normalized.pipeline_id;
  }

  // Normalize name fields
  if (!normalized.name && normalized.full_name) {
    normalized.name = normalized.full_name;
  }
  if (!normalized.firstName && normalized.first_name) {
    normalized.firstName = normalized.first_name;
  }
  if (!normalized.lastName && normalized.last_name) {
    normalized.lastName = normalized.last_name;
  }
  if (!normalized.companyName && normalized.company_name) {
    normalized.companyName = normalized.company_name;
  }

  return normalized;
}

// --- FORM FIELD MAPPINGS (shared between extractors) ---
const FORM_FIELD_MAPPINGS: Record<string, string> = {
  "what_type_of_products_are_you_interested_in_": "Product Type",
  "what_do_you_need_bulk_printing_for_": "Purpose",
  "how_soon_do_you_need_your_order_": "Timeline",
  "company_name": "Company",
  "companyName": "Company",
  "full_name": "Full Name",
  "quantity": "Quantity",
  "7bBSRMZOMh7S8z57PmX9": "Timeline",
  "OUKhuVmDD7yg44tKAYAs": "Product Type",
  "skKuaUesHa1fLm9Cq75U": "Purpose",
  "7fL3fX0KnOUcm7BOvjdi": "Quantity",
  "GCGSXhfM0eHz6MZS6tyZ": "Order Categories",
  "XcZmRrIAuIgJq64VFjhq": "Print Style",
  "vRQQP78R7rDNaXjoEFt3": "Garment Type",
  "Uq2VcaIrV7U5m5LJQKO3": "Print Size",
  "hyHJeRQGmIGbaulYhoHQ": "Sizes and Amount",
};

/**
 * Maps human-readable form question text to our canonical labels.
 * Used to parse Facebook lead form submissions where GHL sends
 * the form data as a text block in the message body like:
 *   "What type of products are you interested in?: T-shirts"
 */
const FORM_QUESTION_MAPPINGS: Record<string, string> = {
  "what type of products are you interested in": "Product Type",
  "what do you need bulk printing for": "Purpose",
  "how soon do you need your order": "Timeline",
  "company name": "Company",
  "full name": "Full Name",
  "email": "Email",
  "phone number": "Phone",
  "quantity": "Quantity",
  "order categories": "Order Categories",
  "print style": "Print Style",
  "garment type": "Garment Type",
  "print size": "Print Size",
  "sizes and amount": "Sizes and Amount",
};

// --- FORM DATA EXTRACTION ---
export function extractFormData(payload: Record<string, unknown>): Array<{ label: string; value: string }> {
  const fields: Array<{ label: string; value: string }> = [];

  for (const [key, label] of Object.entries(FORM_FIELD_MAPPINGS)) {
    const val = payload[key];
    if (val && typeof val === "string" && val.trim()) {
      fields.push({ label, value: val.trim() });
    }
  }

  const customFields = (payload.customFields || payload.customField) as Record<string, unknown>[] | Record<string, unknown> | undefined;
  if (Array.isArray(customFields)) {
    for (const cf of customFields) {
      const key = (cf.id || cf.key || cf.field_key || "") as string;
      const val = (cf.value || cf.field_value || "") as string;
      if (key && val && typeof val === "string" && val.trim()) {
        const label = FORM_FIELD_MAPPINGS[key] || key.replace(/_/g, " ").replace(/\?/g, "");
        fields.push({ label, value: val.trim() });
      }
    }
  } else if (customFields && typeof customFields === "object") {
    for (const [key, val] of Object.entries(customFields)) {
      if (val && typeof val === "string" && val.trim()) {
        const label = FORM_FIELD_MAPPINGS[key] || key.replace(/_/g, " ").replace(/\?/g, "");
        fields.push({ label, value: val.trim() });
      }
    }
  }

  return fields;
}

/**
 * Parses form data from a Facebook lead form message body.
 * GHL sends Facebook form submissions as text blocks like:
 *   "Company name: Calvary Community Church\nHow soon do you need your order?: ASAP\n..."
 * This function extracts key-value pairs from that text.
 */
export function parseFormDataFromMessageBody(messageBody: string): Array<{ label: string; value: string }> {
  const fields: Array<{ label: string; value: string }> = [];
  if (!messageBody || typeof messageBody !== "string") return fields;

  const lines = messageBody.split("\n").filter(l => l.trim());
  for (const line of lines) {
    // Match "Question?: Answer" or "Question: Answer" patterns
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const rawQuestion = line.substring(0, colonIdx).replace(/\?$/, "").trim().toLowerCase();
    const rawAnswer = line.substring(colonIdx + 1).trim();
    if (!rawQuestion || !rawAnswer) continue;

    // Try to match against known question mappings
    let matchedLabel = "";
    for (const [question, label] of Object.entries(FORM_QUESTION_MAPPINGS)) {
      if (rawQuestion === question || rawQuestion.includes(question)) {
        matchedLabel = label;
        break;
      }
    }

    if (matchedLabel) {
      fields.push({ label: matchedLabel, value: rawAnswer });
    }
  }

  return fields;
}

// --- CHANNEL NORMALIZATION ---
export function normalizeChannel(raw: unknown): string {
  const lower = String(raw || "SMS").toLowerCase().trim();
  // GHL numeric message types:
  // 1=Call, 2=SMS, 3=Email, 4=FB, 5=IG, 6=WhatsApp, 7=GMB, 8=WebChat, 10=Voicemail, 11=FB Lead Form, 15=Live_Chat
  if (lower === "15") return "Live_Chat";
  if (lower === "11") return "FB"; // FB Lead Form submissions come as type 11
  if (lower === "4") return "FB";
  if (lower === "5") return "IG";
  if (lower === "6") return "WhatsApp";
  if (lower === "3") return "Email";
  if (lower === "2") return "SMS";
  if (lower === "7") return "SMS"; // GMB → treat as SMS for now
  if (lower === "8") return "Live_Chat"; // WebChat → Live_Chat
  if (lower === "1" || lower === "10") return "SMS"; // Call/Voicemail → SMS fallback
  // String-based types (GHL sends various formats)
  if (lower.includes("email")) return "Email";
  if (lower.includes("whatsapp")) return "WhatsApp";
  if (lower.includes("live_chat") || lower.includes("livechat") || lower.includes("live chat")) return "Live_Chat";
  if (lower.includes("fb") || lower.includes("facebook") || lower.includes("messenger")) return "FB";
  if (lower.includes("ig") || lower.includes("instagram")) return "IG";
  if (lower.includes("sms") || lower.includes("text")) return "SMS";
  // GHL sometimes sends generic types like "InboundMessage" or "Custom" — log and default
  if (lower !== "sms" && lower !== "" && !lower.includes("inbound") && !lower.includes("custom")) {
    console.warn(`[normalizeChannel] Unknown message type: "${String(raw)}" — defaulting to SMS. This may cause channel mismatch.`);
  }
  return "SMS";
}

// --- LLM EXHAUSTION DETECTION ---
/**
 * Detects if an error is an LLM credit/rate-limit exhaustion.
 * Matches the same patterns used by lookback-engine.ts.
 */
export function isLlmExhausted(err: unknown): boolean {
  const msg = String((err as any)?.message || err).toLowerCase();
  return msg.includes("429") || msg.includes("rate") || msg.includes("exhausted") || msg.includes("412") || msg.includes("quota") || msg.includes("usage");
}

/** Default retry delay for LLM exhaustion (15 minutes) */
export const LLM_RETRY_DELAY_MS = 15 * 60 * 1000;

/** Max consecutive LLM retries before pausing a lead (prevents infinite retry loops) */
export const MAX_LLM_RETRIES = 10;

// --- EMAIL HTML FORMATTING ---
/**
 * Converts a plain-text message into properly formatted HTML for email.
 * This is the SINGLE source of truth for email HTML formatting.
 * ALL email senders MUST use this function instead of raw `<p>${message}</p>`.
 *
 * Handles:
 * - Newlines → <br> tags
 * - Double newlines → paragraph breaks
 * - Preserves existing HTML if the message already contains tags
 */
/**
 * Ensures the plain-text message contains the Adorb email signature block.
 * If the signature separator (---) is missing, appends the full signature.
 */
export function ensureEmailSignature(message: string): string {
  if (!message) return message;
  // Check if signature already present (look for the --- separator + brand name)
  if (message.includes('---') && (message.includes('Adorb Custom Printing') || message.includes('adorbcustomtees.com'))) {
    return message;
  }
  // Append standard signature
  const sig = `\n\n---\nBest,\n{AGENT} | Adorb Custom Printing\n(954) 932-8543\nprint@adorbcustomtees.com\nadorbcustomtees.com\n\u2b50 4.9 Stars \u00b7 867+ Verified Reviews\nSee our reviews: https://adorbcustomtees.com/pages/reviews`;
  return message.trimEnd() + sig;
}

export function formatEmailHtml(message: string): string {
  if (!message) return '';

  // If the message already contains HTML tags, return as-is
  if (/<[a-z][\s\S]*>/i.test(message)) return message;

  // 1. Sanitize against HTML injection — escape angle brackets in plain text
  let safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 2. Convert --- signature separator to <hr> (keep it on its own double-newline-separated block)
  safe = safe.replace(/\n---\n/g, '\n\n<hr style="border:none;border-top:1px solid #ddd;margin:16px 0">\n\n');
  safe = safe.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #ddd;margin:16px 0">');

  // 3. Convert URLs to clickable <a> links
  safe = safe.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" style="color:#2563eb;text-decoration:underline" target="_blank">$1</a>'
  );

  // 4. Split on double newlines for paragraphs, then convert single newlines to <br>
  const paragraphs = safe.split(/\n\n+/);
  const body = paragraphs
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .map(p => {
      // Don't wrap <hr> in <p>
      if (p.startsWith('<hr')) return p;
      return `<p style="margin:0 0 12px 0">${p.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');

  // 5. Wrap in styled container
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">${body}</div>`;
}

// --- CONTEXT-AWARE EMAIL SUBJECT BUILDER ---
// Builds a subject line from lead data instead of generic "Adorb Custom Tees".
// Priority: explicit subject > lead context > agent name fallback.
export function buildContextSubject(
  lead: { name?: string | null; businessName?: string | null; formData?: Array<{ label: string; value: string }> | null },
  fromName?: string
): string {
  const firstName = lead.name?.split(" ")[0] || "";
  const agentFirst = (fromName || "Abby").split(" ")[0];

  // Extract product type from form data if available
  let productType = "";
  if (lead.formData && Array.isArray(lead.formData)) {
    for (const f of lead.formData) {
      const label = f.label.toLowerCase();
      if (label.includes("product") || label.includes("interested in") || label.includes("type")) {
        productType = f.value;
        break;
      }
    }
  }

  // Build subject with available context
  if (lead.businessName && productType) {
    return `${lead.businessName} ${productType} — ${agentFirst} from Adorb`;
  }
  if (productType && firstName) {
    return `${firstName}, your ${productType} quote — ${agentFirst} from Adorb`;
  }
  if (lead.businessName) {
    return `${lead.businessName} order — ${agentFirst} from Adorb`;
  }
  if (productType) {
    return `Your ${productType} inquiry — ${agentFirst} from Adorb`;
  }
  if (firstName) {
    return `${firstName} — ${agentFirst} from Adorb`;
  }
  return `${agentFirst} from Adorb Custom Tees`;
}

// --- SEND OPTIONS BUILDER ---
export function buildSendOpts(
  channel: string,
  message: string,
  lead: { email?: string | null; phone?: string | null },
  extra?: { subject?: string; fromName?: string; html?: string; threadId?: string }
): Parameters<typeof sendMessage>[1] | undefined {
  if (channel === "Email" && lead.email) {
    // Ensure signature is present before converting to HTML
    const signedMessage = ensureEmailSignature(message);
    const fromName = extra?.fromName || "Adorb Custom Tees";
    // Replace {AGENT} placeholder in signature with actual sender name
    const finalMessage = signedMessage.replace('{AGENT}', fromName.split(' ')[0]);
    // Email threading: if we have a prior email thread ID, reply in the same thread
    const subject = extra?.threadId ? `Re: ${extra?.subject || "Adorb Custom Tees"}` : (extra?.subject || "Adorb Custom Tees");
    const opts: Parameters<typeof sendMessage>[1] = { type: "Email", subject, html: extra?.html || formatEmailHtml(finalMessage), fromName };
    if (extra?.threadId) {
      opts.threadId = extra.threadId;
      opts.replyMessageId = extra.threadId;
    }
    return opts;
  } else if (channel === "Live_Chat") {
    return { type: "Live_Chat", message };
  } else if (channel === "FB") {
    return { type: "FB", message };
  } else if (channel === "IG") {
    return { type: "IG", message };
  } else if (channel === "WhatsApp") {
    return { type: "WhatsApp", message };
  } else if (lead.phone) {
    return { type: "SMS", message };
  }
  return undefined;
}
