import axios from "axios";
import { ENV } from "./_core/env";
import { isAiOffline, getLeadByGhlContactId, updateLeadFields, getConversationHistory } from "./db";
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

// ============================================================
// GLOBAL BURST LIMITER — API Storm Prevention
// Prevents multiple simultaneous callers (follow-up timer, fast scanner,
// self-review, webhooks) from flooding GHL with concurrent API calls.
// Max 10 sends per 60-second rolling window across ALL contacts.
// ============================================================
const BURST_WINDOW_MS = 60_000; // 60-second rolling window
const BURST_MAX_SENDS = 10;     // max sends per window
const globalSendTimestamps: number[] = []; // epoch ms of each recent send

function checkGlobalBurstLimit(): boolean {
  const now = Date.now();
  const cutoff = now - BURST_WINDOW_MS;
  // Remove timestamps outside the window
  while (globalSendTimestamps.length > 0 && globalSendTimestamps[0] < cutoff) {
    globalSendTimestamps.shift();
  }
  if (globalSendTimestamps.length >= BURST_MAX_SENDS) {
    const oldest = globalSendTimestamps[0];
    const resetInMs = BURST_WINDOW_MS - (now - oldest);
    console.log(`[SEND-GATE] ⚡ GLOBAL BURST LIMIT hit (${globalSendTimestamps.length}/${BURST_MAX_SENDS} in last 60s) — resets in ${Math.ceil(resetInMs / 1000)}s`);
    return false;
  }
  globalSendTimestamps.push(now);
  return true;
}

/**
 * Check if a send to this contact is allowed (not within cooldown).
 * If allowed, atomically marks the timestamp so no other concurrent caller can pass.
 * Returns true if send is allowed, false if blocked by cooldown.
 */
function acquireSendGate(contactId: string): boolean {
  const now = Date.now();
  // Global burst check first — prevents API storms from concurrent callers
  if (!checkGlobalBurstLimit()) return false;
  const lastSend = lastSendTimestamps.get(contactId);
  if (lastSend && (now - lastSend) < COOLDOWN_SECONDS * 1000) {
    const secondsAgo = Math.round((now - lastSend) / 1000);
    console.log(`[SEND-GATE] ❌ BLOCKED send to ${contactId} — last send was ${secondsAgo}s ago (cooldown: ${COOLDOWN_SECONDS}s)`);
    // Undo the burst counter increment since we're not actually sending
    globalSendTimestamps.pop();
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
  type: "SMS" | "Email" | "WhatsApp" | "FB" | "IG" | "Live_Chat";
  message?: string;
  subject?: string;
  html?: string;
  fromName?: string;
  threadId?: string;
  replyMessageId?: string;
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

  // ========== GATE 3: Human Agent Activity Check ==========
  // If a human agent recently sent a message (from GHL UI or any source),
  // the AI MUST NOT send. This is the UNIVERSAL safeguard — every single
  // outbound path flows through this function.
  // Two layers:
  //   (a) Check local DB humanTakeover flag + lastAgentActivityAt
  //   (b) Check GHL conversation history for recent non-AI outbound messages
  // ================================================================
  const AGENT_TAKEOVER_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours (was 2hr — upgraded per approved fix)
  try {
    const lead = await getLeadByGhlContactId(contactId);
    if (lead) {
      // Layer A: Local DB flag
      if (lead.humanTakeover === 1 && lead.lastAgentActivityAt) {
        const agentAge = Date.now() - new Date(lead.lastAgentActivityAt).getTime();
        if (agentAge < AGENT_TAKEOVER_WINDOW_MS) {
          const minutesAgo = Math.round(agentAge / 60000);
          console.log(`[SEND-GATE] \u274C BLOCKED send to ${contactId} — human agent active ${minutesAgo}min ago (within ${AGENT_TAKEOVER_WINDOW_MS / 60000}min window)`);
          // Undo burst counter since we're not sending
          globalSendTimestamps.pop();
          lastSendTimestamps.delete(contactId);
          return { blocked: true, reason: "HUMAN_AGENT_ACTIVE", messageId: null };
        }
      }

      // Layer B: GHL conversation history scan
      // Fetch recent GHL messages and check for non-AI outbound messages
      try {
        const ghlHistory = await fetchGhlConversationHistory(contactId);
        if (ghlHistory.length > 0) {
          const now = Date.now();
          // Get our known AI messages from local DB for comparison
          const localHistory = await getConversationHistory(lead.id, 30);
          const knownAiMessages = new Set(
            localHistory
              .filter((c: any) => c.senderType === "ai" && c.messageBody)
              .map((c: any) => c.messageBody.toLowerCase().trim())
          );

          // Find recent outbound GHL messages that are NOT from our AI
          const recentAgentMessages = ghlHistory.filter(m => {
            if (m.direction !== "outbound" || !m.body?.trim() || !m.dateAdded) return false;
            const msgAge = now - new Date(m.dateAdded).getTime();
            if (msgAge > AGENT_TAKEOVER_WINDOW_MS) return false;
            // Check if this message matches a known AI message
            const isKnownAi = knownAiMessages.has(m.body.toLowerCase().trim());
            return !isKnownAi;
          });

          if (recentAgentMessages.length > 0) {
            const latestAgent = recentAgentMessages.sort((a, b) =>
              new Date(b.dateAdded).getTime() - new Date(a.dateAdded).getTime()
            )[0];
            const agentMsgTime = new Date(latestAgent.dateAdded);
            const minutesAgo = Math.round((now - agentMsgTime.getTime()) / 60000);
            console.log(`[SEND-GATE] \u274C BLOCKED send to ${contactId} — GHL shows human agent message ${minutesAgo}min ago: "${latestAgent.body.substring(0, 80)}..."`);
            // Update DB so future checks are faster (skip GHL API call)
            await updateLeadFields(lead.id, { humanTakeover: 1, lastAgentActivityAt: agentMsgTime });
            // Undo burst counter since we're not sending
            globalSendTimestamps.pop();
            lastSendTimestamps.delete(contactId);
            return { blocked: true, reason: "HUMAN_AGENT_ACTIVE_GHL", messageId: null };
          }
        }
      } catch (ghlErr) {
        // GHL history fetch failed — log but don't block (fail OPEN for GHL API errors)
        console.error(`[SEND-GATE] GHL history check failed for ${contactId} (non-fatal):`, ghlErr);
      }
    }
  } catch (dbErr) {
    // DB check failed — log but don't block (fail OPEN for DB errors)
    console.error(`[SEND-GATE] Human agent check failed for ${contactId} (non-fatal):`, dbErr);
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
    // Email threading: pass threadId and replyMessageId to keep emails in the same thread
    if (opts.threadId) {
      payload.threadId = opts.threadId;
      payload.replyMessageId = opts.replyMessageId || opts.threadId;
      payload.emailReplyMode = "reply";
    }
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

// --- Calendar / Appointments ---

/** Map agent names → their GHL personal calendar IDs */
export const AGENT_CALENDAR_IDS: Record<string, string> = {
  "Abby Bouwer": "SUZZdOyEM310yqesJXQa",
  "Chris McHendry": "j9bpOBiyKL6hxyMnin6l",
};

/**
 * Compute the next available business-hours slot (Mon-Fri 9am-5pm ET).
 * If current time is within business hours, returns the next whole 10-min mark.
 * Otherwise returns 9:00 AM on the next business day.
 */
export function getNextBusinessHoursSlot(fromDate: Date = new Date()): { start: Date; end: Date } {
  // Work in ET (America/New_York)
  const etFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = etFormatter.formatToParts(fromDate);
  const get = (t: string) => parseInt(parts.find(p => p.type === t)?.value || "0", 10);
  let hour = get("hour");
  let minute = get("minute");
  let dayOfWeek = fromDate.getDay(); // 0=Sun

  // Clone the date in UTC and compute ET offset
  const d = new Date(fromDate);

  // Helper: advance to 9:00 AM ET on the next business day
  const advanceToNextBusinessDay = () => {
    do {
      d.setDate(d.getDate() + 1);
      dayOfWeek = d.getDay();
    } while (dayOfWeek === 0 || dayOfWeek === 6); // skip weekends
    // Set to 9:00 AM ET
    const etNow = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const offset = d.getTime() - etNow.getTime();
    const target = new Date(d);
    target.setHours(9, 0, 0, 0);
    const result = new Date(target.getTime() + offset);
    return result;
  };

  // Check if current time is within business hours
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isBusinessHours = isWeekday && hour >= 9 && hour < 17;

  let start: Date;
  if (isBusinessHours) {
    // Round up to next 10-min mark, at least 5 min from now
    const minFromNow = 5;
    const candidate = new Date(fromDate.getTime() + minFromNow * 60_000);
    const candidateParts = etFormatter.formatToParts(candidate);
    const cHour = parseInt(candidateParts.find(p => p.type === "hour")?.value || "0", 10);
    const cMin = parseInt(candidateParts.find(p => p.type === "minute")?.value || "0", 10);
    const roundedMin = Math.ceil(cMin / 10) * 10;
    if (cHour >= 17 || (cHour === 16 && roundedMin > 50)) {
      // Past end of day after rounding — go to next business day
      start = advanceToNextBusinessDay();
    } else {
      // Build the rounded time in ET
      const etNow = new Date(candidate.toLocaleString("en-US", { timeZone: "America/New_York" }));
      const offset = candidate.getTime() - etNow.getTime();
      const target = new Date(candidate);
      target.setHours(cHour, roundedMin >= 60 ? 0 : roundedMin, 0, 0);
      if (roundedMin >= 60) target.setHours(target.getHours() + 1);
      start = new Date(target.getTime() + offset);
    }
  } else {
    // Outside business hours — find next business day at 9 AM
    if (isWeekday && hour < 9) {
      // Same day, just set to 9 AM ET
      const etNow = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
      const offset = d.getTime() - etNow.getTime();
      const target = new Date(d);
      target.setHours(9, 0, 0, 0);
      start = new Date(target.getTime() + offset);
    } else {
      start = advanceToNextBusinessDay();
    }
  }

  const end = new Date(start.getTime() + 10 * 60_000); // 10-minute slot
  return { start, end };
}

/** Create a GHL calendar appointment */
export async function createAppointment(opts: {
  calendarId: string;
  contactId: string;
  title: string;
  description?: string;
  startTime: string; // ISO 8601
  endTime: string;   // ISO 8601
  assignedUserId?: string;
  appointmentStatus?: string;
}) {
  try {
    const { data } = await ghlClient.post(`/calendars/events/appointments`, {
      calendarId: opts.calendarId,
      locationId: ENV.ghlLocationId,
      contactId: opts.contactId,
      title: opts.title,
      description: opts.description || "",
      startTime: opts.startTime,
      endTime: opts.endTime,
      assignedUserId: opts.assignedUserId,
      appointmentStatus: opts.appointmentStatus || "confirmed",
      meetingLocationType: "phone",
      toNotify: true,
      ignoreFreeSlotValidation: true,
      ignoreDateRange: true,
    });
    console.log(`[GHL] Appointment created: ${opts.title} at ${opts.startTime}`);
    return data;
  } catch (err: any) {
    console.error(`[GHL] createAppointment failed:`, err?.response?.data || err?.message);
    return null;
  }
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
