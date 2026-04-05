/**
 * WEBHOOK HELPERS — Shared utilities, constants, and types for all webhook handlers
 */

import { getContact, searchContacts, sendMessage, updateContactCustomField } from "./ghl";
import { updateLeadFields } from "./db";

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
): Promise<{ success: boolean; resolvedContactId: string; error?: string }> {
  try {
    await sendMessage(contactId, opts);
    return { success: true, resolvedContactId: contactId };
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 400 || status === 404) {
      console.log(`[SendRetry] Contact ${contactId} not found, resolving real ID...`);
      const resolved = await resolveGhlContactId(contactId, lead.email, lead.phone);
      if (resolved && resolved.resolvedId !== contactId) {
        await updateLeadFields(lead.id, { ghlContactId: resolved.resolvedId });
        console.log(`[SendRetry] Resolved to ${resolved.resolvedId}, retrying send...`);
        try {
          await sendMessage(resolved.resolvedId, opts);
          return { success: true, resolvedContactId: resolved.resolvedId };
        } catch (retryErr: unknown) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.error(`[SendRetry] Retry also failed:`, retryMsg);
          return { success: false, resolvedContactId: resolved.resolvedId, error: retryMsg };
        }
      }
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, resolvedContactId: contactId, error: errMsg };
  }
}

// --- EVENT TYPE DETECTION ---
export function detectEventType(payload: Record<string, unknown>): "contact" | "message" | "pipeline" | "task" | "unknown" {
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
    // Map message.type to a direction hint (type 2 = SMS inbound in GHL)
    if (!normalized.direction) normalized.direction = "inbound";
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

// --- FORM DATA EXTRACTION ---
export function extractFormData(payload: Record<string, unknown>): Array<{ label: string; value: string }> {
  const fields: Array<{ label: string; value: string }> = [];

  const formFieldMappings: Record<string, string> = {
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

  for (const [key, label] of Object.entries(formFieldMappings)) {
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
        const label = formFieldMappings[key] || key.replace(/_/g, " ").replace(/\?/g, "");
        fields.push({ label, value: val.trim() });
      }
    }
  } else if (customFields && typeof customFields === "object") {
    for (const [key, val] of Object.entries(customFields)) {
      if (val && typeof val === "string" && val.trim()) {
        const label = formFieldMappings[key] || key.replace(/_/g, " ").replace(/\?/g, "");
        fields.push({ label, value: val.trim() });
      }
    }
  }

  return fields;
}

// --- CHANNEL NORMALIZATION ---
export function normalizeChannel(raw: unknown): string {
  const lower = String(raw || "SMS").toLowerCase().trim();
  // GHL numeric message types: 2=SMS, 3=Email, 4=FB, 5=IG, 6=WhatsApp, 15=Live_Chat(FB)
  if (lower === "4" || lower === "15") return "FB";
  if (lower === "5") return "IG";
  if (lower === "6") return "WhatsApp";
  if (lower === "3") return "Email";
  if (lower === "2") return "SMS";
  // String-based types
  if (lower.includes("email")) return "Email";
  if (lower.includes("whatsapp")) return "WhatsApp";
  if (lower.includes("fb") || lower.includes("facebook") || lower.includes("live_chat")) return "FB";
  if (lower.includes("ig") || lower.includes("instagram")) return "IG";
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

// --- SEND OPTIONS BUILDER ---
export function buildSendOpts(
  channel: string,
  message: string,
  lead: { email?: string | null; phone?: string | null },
  extra?: { subject?: string; fromName?: string; html?: string }
): Parameters<typeof sendMessage>[1] | undefined {
  if (channel === "Email" && lead.email) {
    return { type: "Email", subject: extra?.subject || "Adorb Custom Tees", html: extra?.html || `<p>${message}</p>`, fromName: extra?.fromName };
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
