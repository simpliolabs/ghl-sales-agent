import axios from "axios";
import { ENV } from "./_core/env";
import { isAiOffline } from "./db";
import { BRAND } from "../shared/brand-assets";

const BRAND_EMAIL = BRAND.email;

const GHL_BASE = "https://services.leadconnectorhq.com";

const ghlClient = axios.create({
  baseURL: GHL_BASE,
  headers: {
    Authorization: `Bearer ${ENV.ghlApiKey}`,
    Version: "2021-04-15",
    "Content-Type": "application/json",
  },
});

// ============================================================
// SEND GATE — The nuclear option for duplicate message prevention
// ============================================================
// This is the SINGLE chokepoint where ALL outbound messages pass through.
// No matter how many callers (webhook, fast scanner, follow-up trigger,
// self-review) fire simultaneously, only ONE message per contact per
// COOLDOWN_SECONDS will actually be sent to GHL.
// ============================================================

const COOLDOWN_SECONDS = 60; // Block duplicate sends within 60 seconds
const lastSendTimestamps = new Map<string, number>(); // contactId -> epoch ms

// Cleanup old entries every 5 minutes to prevent memory leak
setInterval(() => {
  const cutoff = Date.now() - COOLDOWN_SECONDS * 1000 * 2;
  const keysToDelete: string[] = [];
  lastSendTimestamps.forEach((ts, key) => {
    if (ts < cutoff) keysToDelete.push(key);
  });
  keysToDelete.forEach(k => lastSendTimestamps.delete(k));
}, 5 * 60 * 1000);

/**
 * Check if a send to this contact is allowed (not within cooldown).
 * If allowed, atomically marks the timestamp so no other concurrent caller can pass.
 * Returns true if send is allowed, false if blocked by cooldown.
 */
function acquireSendGate(contactId: string): boolean {
  const now = Date.now();
  const lastSend = lastSendTimestamps.get(contactId);
  if (lastSend && (now - lastSend) < COOLDOWN_SECONDS * 1000) {
    const secondsAgo = Math.round((now - lastSend) / 1000);
    console.log(`[SEND-GATE] ❌ BLOCKED send to ${contactId} — last send was ${secondsAgo}s ago (cooldown: ${COOLDOWN_SECONDS}s)`);
    return false;
  }
  // Atomically set the timestamp — JavaScript is single-threaded so this is safe
  lastSendTimestamps.set(contactId, now);
  return true;
}

// --- Contacts ---
export async function getContact(contactId: string) {
  const { data } = await ghlClient.get(`/contacts/${contactId}`);
  return data.contact;
}

export async function searchContacts(query: string, limit = 20) {
  const { data } = await ghlClient.get("/contacts/", {
    params: { locationId: ENV.ghlLocationId, query, limit },
  });
  return data.contacts || [];
}

export async function getContacts(limit = 100, startAfterId?: string) {
  const params: Record<string, unknown> = { locationId: ENV.ghlLocationId, limit };
  if (startAfterId) params.startAfterId = startAfterId;
  const { data } = await ghlClient.get("/contacts/", { params });
  return data;
}

export async function updateContactCustomField(contactId: string, customFields: Array<{ id: string; field_value: string }>) {
  const { data } = await ghlClient.put(`/contacts/${contactId}`, {
    customFields,
  });
  return data;
}

// --- Messages ---
export async function sendMessage(contactId: string, opts: {
  type: "SMS" | "Email" | "WhatsApp" | "FB" | "IG";
  message?: string;
  subject?: string;
  html?: string;
  fromName?: string;
}) {
  // ========== GATE 1: AI Offline check ==========
  // This is the LAST LINE OF DEFENSE. Even if all caller-level checks
  // failed, this will block the message from going out.
  try {
    if (await isAiOffline()) {
      console.log(`[SEND-GATE] ❌ BLOCKED send to ${contactId} — AI is OFFLINE`);
      return { blocked: true, reason: "AI_OFFLINE", messageId: null };
    }
  } catch (err) {
    // If we can't check, fail CLOSED — block the send
    console.error(`[SEND-GATE] isAiOffline check failed, blocking send as precaution:`, err);
    return { blocked: true, reason: "OFFLINE_CHECK_FAILED", messageId: null };
  }

  // ========== GATE 2: Per-contact cooldown ==========
  // Only ONE message per contact per 60 seconds. Period.
  if (!acquireSendGate(contactId)) {
    return { blocked: true, reason: "COOLDOWN", messageId: null };
  }

  // ========== SEND ==========
  const payload: Record<string, unknown> = {
    type: opts.type,
    contactId,
  };
  if (opts.type === "Email") {
    payload.subject = opts.subject || "";
    payload.html = opts.html || opts.message || "";
    payload.message = opts.message || "";
    payload.emailFrom = BRAND_EMAIL;
    if (opts.fromName) payload.emailFrom = `${opts.fromName} <${BRAND_EMAIL}>`;
  } else {
    payload.message = opts.message || "";
  }
  // GHL API requires conversationId OR contactId, and we use contactId
  // Log the outbound attempt for debugging
  console.log(`[GHL] Sending ${opts.type} to contact ${contactId}: ${(opts.message || "").substring(0, 80)}...`);
  try {
    const { data } = await ghlClient.post(`/conversations/messages`, payload);
    console.log(`[GHL] Message sent successfully: ${data.messageId || "no-id"}`);
    return data;
  } catch (err: any) {
    const errData = err?.response?.data;
    const errStatus = err?.response?.status;
    const errMsg = JSON.stringify(errData || {}).toLowerCase();
    console.error(`[GHL] sendMessage FAILED (${errStatus}):`, JSON.stringify(errData));
    console.error(`[GHL] Payload was:`, JSON.stringify(payload));

    // --- DND REJECTION DETECTION ---
    // If GHL rejects with a DND-related error, log it clearly.
    // The caller should handle flagging humanTakeover if needed.
    if (errMsg.includes('dnd') || errMsg.includes('do not disturb') ||
        errMsg.includes('unsubscribed') || errMsg.includes('opted out') ||
        errMsg.includes('stop') || errStatus === 403) {
      console.error(`[GHL] \u{1F6AB} DND REJECTION detected for contact ${contactId} on ${opts.type}: ${errMsg}`);
      // Don't release the gate — this is a permanent block, not a transient error
      const dndError = new Error(`GHL DND rejection: ${opts.type} blocked for contact ${contactId}`);
      (dndError as any).isDndRejection = true;
      (dndError as any).channel = opts.type;
      (dndError as any).contactId = contactId;
      throw dndError;
    }

    // On non-DND failure, release the gate so a retry can go through
    lastSendTimestamps.delete(contactId);
    throw err;
  }
}

export async function getConversationMessages(conversationId: string) {
  const { data } = await ghlClient.get(`/conversations/${conversationId}/messages`);
  return data.messages || [];
}

export async function getContactConversations(contactId: string) {
  const { data } = await ghlClient.get(`/conversations/search`, {
    params: { locationId: ENV.ghlLocationId, contactId },
  });
  return data.conversations || [];
}

// --- Fetch full conversation history from GHL ---
export async function fetchGhlConversationHistory(contactId: string): Promise<Array<{ direction: string; type: string; body: string; dateAdded: string }>> {
  try {
    const conversations = await getContactConversations(contactId);
    const allMessages: Array<{ direction: string; type: string; body: string; dateAdded: string }> = [];
    for (const conv of conversations) {
      try {
        const msgs = await getConversationMessages(conv.id);
        const messageList = Array.isArray(msgs) ? msgs : (msgs?.messages || []);
        for (const m of messageList) {
          allMessages.push({
            direction: m.direction || "unknown",
            type: m.type || "unknown",
            body: m.body || m.message || "",
            dateAdded: m.dateAdded || "",
          });
        }
      } catch { /* skip conversation if messages can't be fetched */ }
    }
    // Sort by date ascending
    allMessages.sort((a, b) => new Date(a.dateAdded).getTime() - new Date(b.dateAdded).getTime());
    return allMessages;
  } catch {
    return [];
  }
}

// --- Tasks ---
export async function createTask(contactId: string, opts: {
  title: string;
  body?: string;
  dueDate?: string;
  assignedTo?: string;
}) {
  const { data } = await ghlClient.post(`/contacts/${contactId}/tasks`, {
    title: opts.title,
    body: opts.body || "",
    dueDate: opts.dueDate || new Date().toISOString(),
    completed: false,
    assignedTo: opts.assignedTo,
  });
  return data;
}

// --- Custom Fields ---
export async function getCustomFields() {
  const { data } = await ghlClient.get(`/locations/${ENV.ghlLocationId}/customFields`);
  return data.customFields || [];
}

// --- Opportunities / Pipeline ---
export async function getOpportunities(pipelineId: string, limit = 20, startAfterId?: string) {
  const params: Record<string, unknown> = { location_id: ENV.ghlLocationId, pipeline_id: pipelineId, limit };
  if (startAfterId) params.startAfterId = startAfterId;
  const { data } = await ghlClient.get("/opportunities/search", { params });
  return data;
}
export async function getOpportunitiesByContact(contactId: string) {
  try {
    const { data } = await ghlClient.get("/opportunities/search", {
      params: { location_id: ENV.ghlLocationId, contact_id: contactId, limit: 10 },
    });
    return (data.opportunities || []) as Array<{ id: string; pipelineId: string; pipelineStageId: string; name: string; status: string; monetaryValue?: number }>;
  } catch {
    return [];
  }
}

export async function updateOpportunityStage(opportunityId: string, stageId: string) {
  const { data } = await ghlClient.put(`/opportunities/${opportunityId}`, {
    stageId,
  });
  return data;
}

export async function updateOpportunityValue(opportunityId: string, monetaryValue: number) {
  const { data } = await ghlClient.put(`/opportunities/${opportunityId}`, {
    monetaryValue,
  });
  return data;
}

export async function getPipelines() {
  const { data } = await ghlClient.get("/opportunities/pipelines", {
    params: { locationId: ENV.ghlLocationId },
  });
  return data.pipelines || [];
}

// --- Users (Agents) ---
export async function getLocationUsers() {
  try {
    const { data } = await ghlClient.get(`/users/search`, {
      params: { companyId: ENV.ghlLocationId, locationId: ENV.ghlLocationId },
    });
    return data.users || [];
  } catch {
    return [];
  }
}

// --- Contact Assignment ---
// Maps agent display names to their GHL user IDs
export const AGENT_GHL_USER_IDS: Record<string, string> = {
  "Abby Bouwer": "reGz7il08jq8SUsY7m6H",
  "Chris McHendry": "MaGoC5SwkdJdYw5AK6vj",
  "Cindy Muchnick": "r8wBqdXjV0GneQxcW47R",
  "César Vásquez": "TGiY13S3TJFFL7Khth8D",
  "Glydel Lloren": "ob9AgYJkcLmgNWDUNQ5G",
};

export async function updateContactAssignment(contactId: string, assignedUserId: string) {
  try {
    const { data } = await ghlClient.put(`/contacts/${contactId}`, {
      assignedTo: assignedUserId,
    });
    console.log(`[GHL] Assigned contact ${contactId} to user ${assignedUserId}`);
    return data;
  } catch (err: any) {
    console.error(`[GHL] updateContactAssignment failed for ${contactId}:`, err?.response?.data || err?.message);
    return null;
  }
}

// --- Internal Notes ---
export async function addNote(contactId: string, body: string) {
  const { data } = await ghlClient.post(`/contacts/${contactId}/notes`, {
    body,
  });
  return data;
}

export async function getNotes(contactId: string) {
  const { data } = await ghlClient.get(`/contacts/${contactId}/notes`);
  return data.notes || [];
}
