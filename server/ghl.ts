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

          // ── Filter out GHL system/automation messages ──────────────────
          // These are NOT human agent messages — they're system-generated events
          // that appear as outbound in GHL conversation history.
          const SYSTEM_MESSAGE_PATTERNS = [
            /opportunity\s*(created|updated|moved|deleted|won|lost|abandoned)/i,
            /pipeline\s*(stage|moved|changed|updated)/i,
            /workflow\s*(triggered|started|completed|action)/i,
            /task\s*(created|assigned|completed|due)/i,
            /appointment\s*(booked|scheduled|confirmed|cancelled|rescheduled)/i,
            /tag\s*(added|removed)/i,
            /contact\s*(created|updated|merged)/i,
            /note\s*(added|created)/i,
            /form\s*submitted/i,
            /invoice\s*(sent|paid|overdue)/i,
            /payment\s*(received|failed)/i,
            /\bDND\b.*\b(enabled|disabled)\b/i,
            /^\s*$/, // empty messages
            // Our own AI/system-generated notes (must not trigger false agent detection)
            /🤖\s*ai:/i,
            /📋\s*(new inquiry|ai:)/i,
            /📞\s*(handoff|ai:)/i,
            /🔥\s*(ai:|close deal)/i,
            /ai state machine/i,
            /heads-up for agent/i,
            /the ai is handling/i,
            /live quote needed/i,
            /ready to close/i,
            /needs live agent/i,
            /committed\s*[—\-]/i,
            /handoff\s*[—\-]/i,
          ];
          const isSystemMessage = (body: string): boolean => {
            const trimmed = body.trim();
            if (!trimmed) return true;
            return SYSTEM_MESSAGE_PATTERNS.some(p => p.test(trimmed));
          };

          // Find recent outbound GHL messages that are NOT from our AI and NOT system messages
          const recentAgentMessages = ghlHistory.filter(m => {
            if (m.direction !== "outbound" || !m.body?.trim() || !m.dateAdded) return false;
            const msgAge = now - new Date(m.dateAdded).getTime();
            if (msgAge > AGENT_TAKEOVER_WINDOW_MS) return false;
            // Skip system/automation messages
            if (isSystemMessage(m.body)) return false;
            // Skip GHL system message types — both string names AND numeric IDs
            // GHL returns type as number (11=SMS/FB, 28=opportunity, 31=appointment, etc.)
            const systemTypeNames = ["TYPE_ACTIVITY", "TYPE_CALL_COMPLETED", "TYPE_CALL", "TYPE_NOTE", "TYPE_TASK", "TYPE_APPOINTMENT", "TYPE_WORKFLOW", "TYPE_SYSTEM"];
            // Numeric GHL message types that are system/activity (NOT customer messages):
            //   0 = system, 28 = TYPE_ACTIVITY_OPPORTUNITY, 29 = TYPE_ACTIVITY_STAGECHANGE,
            //   30 = TYPE_ACTIVITY_TASK, 31 = TYPE_ACTIVITY_APPOINTMENT,
            //   32 = TYPE_ACTIVITY_NOTE, 33 = TYPE_ACTIVITY_CONTACT,
            //   34+ = other system activities. Types 1-15 are messaging types (SMS, Email, FB, etc.)
            const SYSTEM_TYPE_IDS = new Set([0, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]);
            const typeStr = m.type != null ? String(m.type).toUpperCase() : "";
            const typeNum = m.type != null ? Number(m.type) : NaN;
            if (systemTypeNames.includes(typeStr)) return false;
            if (!isNaN(typeNum) && SYSTEM_TYPE_IDS.has(typeNum)) return false;
            // Check if this message matches a known AI message
            const isKnownAi = knownAiMessages.has(m.body.toLowerCase().trim());
            return !isKnownAi;
          });

          // ── Safety: Refine Layer B for brand new contacts ──────────────────
          // If we have zero local AI messages AND the GHL outbound messages have
          // a userId (meaning a human typed them), we MUST still block — a human
          // agent is actively managing this contact.
          // Only skip the block if the messages look like workflow/automation
          // (no userId) — those are safe to ignore.
          if (knownAiMessages.size === 0 && recentAgentMessages.length > 0) {
            const humanTypedMessages = recentAgentMessages.filter(
              (m: any) => m.userId || m.user?.id
            );
            if (humanTypedMessages.length > 0) {
              const latestHuman = humanTypedMessages.sort((a: any, b: any) =>
                new Date(b.dateAdded).getTime() - new Date(a.dateAdded).getTime()
              )[0];
              const minutesAgo = Math.round((now - new Date(latestHuman.dateAdded).getTime()) / 60000);
              console.log(`[SEND-GATE] BLOCKED send to ${contactId} — GHL shows human agent message (userId=${latestHuman.userId}) ${minutesAgo}min ago on a new contact with no local AI history: "${String(latestHuman.body || '').substring(0, 80)}"`);
              await updateLeadFields(lead.id, { humanTakeover: 1, lastAgentActivityAt: new Date(latestHuman.dateAdded) });
              globalSendTimestamps.pop();
              lastSendTimestamps.delete(contactId);
              return { blocked: true, reason: "HUMAN_AGENT_ACTIVE_NEW_CONTACT", messageId: null };
            }
            console.log(`[SEND-GATE] Skipping Layer B for ${contactId} — no local AI history and ${recentAgentMessages.length} GHL outbound message(s) have no userId (likely workflow/automation, not human)`);
            // Don't block — fall through to send
          } else

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
    // Normalize: GHL returns messageId but our threading code expects emailMessageId.
    // Attach it explicitly so downstream callers can use it for email threading.
    if (opts.type === "Email" && data.messageId && !data.emailMessageId) {
      data.emailMessageId = data.messageId;
    }
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
export async function fetchGhlConversationHistory(contactId: string): Promise<Array<{ direction: string; type: string; messageType?: string; body: string; dateAdded: string; userId?: string }>> {
  try {
    const conversations = await getContactConversations(contactId);
    const allMessages: Array<{ direction: string; type: string; messageType?: string; body: string; dateAdded: string; userId?: string }> = [];
    for (const conv of conversations) {
      try {
        const msgs = await getConversationMessages(conv.id);
        const messageList = Array.isArray(msgs) ? msgs : (msgs?.messages || []);
        for (const m of messageList) {
          allMessages.push({
            direction: m.direction || "unknown",
            type: m.type || "unknown",
            messageType: m.messageType || undefined,
            body: m.body || m.message || "",
            dateAdded: m.dateAdded || "",
            userId: m.userId || m.user?.id || undefined,
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

// --- Calendar / Appointments ---

/**
 * Format a Date as an ISO 8601 string with explicit America/New_York UTC offset.
 * e.g. "2026-04-15T09:00:00-04:00" (EDT) or "2026-01-15T09:00:00-05:00" (EST)
 * GHL requires explicit offsets so it displays the correct local time regardless
 * of the location's calendar timezone setting.
 */
export function toETOffsetString(date: Date): string {
  // Get the ET date/time components AND the timezone offset in one pass
  const etFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
    timeZoneName: "shortOffset", // e.g. "GMT-4" or "GMT-5"
  });
  const parts = etFmt.formatToParts(date);
  const get = (t: string) => parts.find(p => p.type === t)?.value || "00";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");
  // Parse the offset from "GMT-4" or "GMT-5" → "-04:00" or "-05:00"
  const tzName = get("timeZoneName"); // e.g. "GMT-4"
  const offsetMatch = tzName.match(/GMT([+-]\d+)/);
  let offsetStr = "-05:00"; // default EST
  if (offsetMatch) {
    const hours = parseInt(offsetMatch[1], 10);
    const sign = hours >= 0 ? "+" : "-";
    const absHours = String(Math.abs(hours)).padStart(2, "0");
    offsetStr = `${sign}${absHours}:00`;
  }
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offsetStr}`;
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
    dueDate: opts.dueDate || toETOffsetString(new Date()),
    completed: false,
    assignedTo: opts.assignedTo,
  });
  return data;
}

/** Map agent names → their GHL personal calendar IDs */
export const AGENT_CALENDAR_IDS: Record<string, string> = {
  "Abby Bouwer": "SUZZdOyEM310yqesJXQa",
  "Chris McHendry": "j9bpOBiyKL6hxyMnin6l",
};

/**
 * Per-agent slot pointer — tracks the last booked slot end time per agent.
 * This prevents clustering when multiple appointments are created in the same minute.
 * Key: agent name (or "default"), Value: last booked end time (epoch ms)
 */
const agentSlotPointers: Map<string, number> = new Map();

/**
 * Compute the next available business-hours slot (Mon-Fri 9am-5pm ET).
 * STATEFUL: tracks the last booked slot per agent to ensure sequential 10-min spacing.
 * Never returns a slot before 9:00 AM ET. Never stacks slots on top of each other.
 * @param fromDate - reference time (defaults to now)
 * @param agentKey - agent name for per-agent slot tracking (defaults to "default")
 */
export function getNextBusinessHoursSlot(
  fromDate: Date = new Date(),
  agentKey: string = "default",
): { start: Date; end: Date } {
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
  // Use ET-based day of week (not UTC) to handle midnight ET / early AM UTC edge cases
  const etDateStr = fromDate.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" });
  const etDayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let dayOfWeek = etDayMap[etDateStr] ?? fromDate.getDay();

  // Clone the date in UTC and compute ET offset
  const d = new Date(fromDate);

  // Helper: advance to 9:30 AM ET on the next business day
  const advanceToNextBusinessDay = () => {
    do {
      d.setDate(d.getDate() + 1);
      dayOfWeek = d.getDay();
    } while (dayOfWeek === 0 || dayOfWeek === 6); // skip weekends
    // Set to 9:30 AM ET (business opens at 9:30 AM)
    const etNow = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const offset = d.getTime() - etNow.getTime();
    const target = new Date(d);
    target.setHours(9, 30, 0, 0);
    const result = new Date(target.getTime() + offset);
    return result;
  };

  // Check if current time is within business hours (Mon-Fri 9:30 AM - 5:00 PM ET)
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isAfterOpen = hour > 9 || (hour === 9 && minute >= 30); // >= 9:30 AM
  const isBeforeClose = hour < 17; // < 5:00 PM
  const isBusinessHours = isWeekday && isAfterOpen && isBeforeClose;

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
    if (isWeekday && (hour < 9 || (hour === 9 && minute < 30))) {
      // Same day, just set to 9:30 AM ET (business opens at 9:30 AM)
      const etNow = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
      const offset = d.getTime() - etNow.getTime();
      const target = new Date(d);
      target.setHours(9, 30, 0, 0);
      start = new Date(target.getTime() + offset);
    } else {
      start = advanceToNextBusinessDay();
    }
  }

  // SLOT POINTER: If the agent already has a booked slot pointer that is AFTER
  // the computed start, advance start to the next 10-min mark after the pointer.
  // This prevents clustering when multiple appointments are created in rapid succession.
  const pointerMs = agentSlotPointers.get(agentKey) || 0;
  if (pointerMs > start.getTime()) {
    // Use the pointer as the new start (already aligned to 10-min boundary)
    start = new Date(pointerMs);
    // Ensure it's still within business hours (9am-5pm ET)
    const pParts = etFormatter.formatToParts(start);
    const pHour = parseInt(pParts.find(p => p.type === "hour")?.value || "0", 10);
    const pMin = parseInt(pParts.find(p => p.type === "minute")?.value || "0", 10);
    if (pHour >= 17 || (pHour < 9) || (pHour === 9 && pMin < 30)) {
      // Pointer is outside business hours — advance to next business day at 9:30 AM
      const dPtr = new Date(start);
      if (pHour >= 17) {
        // Past end of day — advance to next business day
        do { dPtr.setDate(dPtr.getDate() + 1); } while (dPtr.getDay() === 0 || dPtr.getDay() === 6);
      }
      // else: before 9:30 AM on a weekday — same day, just set to 9:30 AM
      const etPtr = new Date(dPtr.toLocaleString("en-US", { timeZone: "America/New_York" }));
      const offsetPtr = dPtr.getTime() - etPtr.getTime();
      const targetPtr = new Date(dPtr);
      targetPtr.setHours(9, 30, 0, 0);
      start = new Date(targetPtr.getTime() + offsetPtr);
    }
  }

  // SAFETY: Never book before 9:30 AM ET or after 5:00 PM ET (catches any edge case above)
  const safetyParts = etFormatter.formatToParts(start);
  const safetyHour = parseInt(safetyParts.find(p => p.type === "hour")?.value || "0", 10);
  const safetyMin = parseInt(safetyParts.find(p => p.type === "minute")?.value || "0", 10);
  if (safetyHour < 9 || (safetyHour === 9 && safetyMin < 30) || safetyHour >= 17) {
    console.warn(`[SlotQueue] ⚠️ Safety clamp: slot ${toETOffsetString(start)} is outside business hours — advancing to 9:30 AM`);
    const dSafe = new Date(start);
    if (safetyHour >= 17) {
      do { dSafe.setDate(dSafe.getDate() + 1); } while (dSafe.getDay() === 0 || dSafe.getDay() === 6);
    }
    const etSafe = new Date(dSafe.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const offsetSafe = dSafe.getTime() - etSafe.getTime();
    const targetSafe = new Date(dSafe);
    targetSafe.setHours(9, 30, 0, 0);
    start = new Date(targetSafe.getTime() + offsetSafe);
  }

  const end = new Date(start.getTime() + 10 * 60_000); // 10-minute slot

  // Advance the per-agent pointer to the end of this slot
  agentSlotPointers.set(agentKey, end.getTime());

  console.log(`[SlotQueue] Agent '${agentKey}' booked slot: ${toETOffsetString(start)} → ${toETOffsetString(end)}`);

  // Persist pointer to DB so it survives server restarts
  setImmediate(async () => {
    try {
      const { setSystemSetting } = await import("./db");
      const key = `slot_pointer_${agentKey.replace(/\s+/g, '_').toLowerCase()}`;
      await setSystemSetting(key, String(end.getTime()), 'slot_queue');
    } catch { /* best effort — in-memory pointer still works */ }
  });

  return { start, end };
}

/** Reset the per-agent slot pointer (for testing or manual override) */
export function resetAgentSlotPointer(agentKey: string = "default"): void {
  agentSlotPointers.delete(agentKey);
}

/**
 * Fetch existing GHL calendar events for a given calendar within a time window.
 * Used to warm the slot pointer on server startup so we don't double-book.
 */
export async function getCalendarEvents(
  calendarId: string,
  startTime: string, // ISO 8601
  endTime: string,   // ISO 8601
): Promise<Array<{ startTime: string; endTime: string; id: string }>> {
  try {
    const { data } = await ghlClient.get(`/calendars/events`, {
      params: { calendarId, locationId: ENV.ghlLocationId, startTime, endTime },
    });
    return (data?.events || []) as Array<{ startTime: string; endTime: string; id: string }>;
  } catch (err: any) {
    console.error(`[GHL] getCalendarEvents failed:`, err?.response?.data || err?.message);
    return [];
  }
}

/**
 * Warm the per-agent slot pointer on startup.
 * Strategy: load persisted pointers from DB first (survives restarts),
 * then try GHL calendar events as a secondary source.
 * DB is the source of truth since GHL events API may return empty.
 */
export async function warmSlotPointersFromCalendar(): Promise<void> {
  // 1. Load persisted pointers from DB (primary — survives restarts)
  try {
    const { getSystemSetting } = await import("./db");
    for (const agentName of Object.keys(AGENT_CALENDAR_IDS)) {
      const key = `slot_pointer_${agentName.replace(/\s+/g, '_').toLowerCase()}`;
      const stored = await getSystemSetting(key);
      if (stored) {
        const storedMs = parseInt(stored, 10);
        if (!isNaN(storedMs) && storedMs > Date.now()) {
          // Only restore if pointer is in the future (still relevant)
          agentSlotPointers.set(agentName, storedMs);
          console.log(`[SlotQueue] Restored pointer for '${agentName}' from DB: ${new Date(storedMs).toISOString()}`);
        }
      }
    }
  } catch (err: any) {
    console.error(`[SlotQueue] Failed to load pointers from DB:`, err?.message);
  }

  // 2. Try GHL calendar events as secondary source (may be empty)
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setHours(0, 0, 0, 0);
  const windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + 3);

  for (const [agentName, calendarId] of Object.entries(AGENT_CALENDAR_IDS)) {
    try {
      const events = await getCalendarEvents(
        calendarId,
        windowStart.toISOString(),
        windowEnd.toISOString(),
      );
      if (events.length === 0) continue;
      const latestEndMs = Math.max(
        ...events.map(e => new Date(e.endTime).getTime()),
      );
      const currentPointer = agentSlotPointers.get(agentName) || 0;
      if (latestEndMs > currentPointer) {
        agentSlotPointers.set(agentName, latestEndMs);
        console.log(`[SlotQueue] Warmed pointer for '${agentName}' from GHL: ${new Date(latestEndMs).toISOString()} (${events.length} events)`);
      }
    } catch (err: any) {
      console.error(`[SlotQueue] Failed to warm pointer for '${agentName}' from GHL:`, err?.message);
    }
  }
  console.log(`[SlotQueue] Slot pointers warmed from GHL calendar`);
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

/**
 * Create a new opportunity in GHL for a contact.
 * Returns the created opportunity's id, pipelineId, and stageId.
 */
export async function createOpportunity(opts: {
  contactId: string;
  name: string;
  pipelineId: string;
  stageId: string;
  monetaryValue?: number;
  assignedTo?: string;
}): Promise<{ id: string; pipelineId: string; pipelineStageId: string }> {
  const { data } = await ghlClient.post(`/opportunities/`, {
    pipelineId: opts.pipelineId,
    locationId: ENV.ghlLocationId,
    name: opts.name,
    pipelineStageId: opts.stageId,
    contactId: opts.contactId,
    status: "open",
    ...(opts.monetaryValue ? { monetaryValue: opts.monetaryValue } : {}),
    ...(opts.assignedTo ? { assignedTo: opts.assignedTo } : {}),
  });
  const opp = data.opportunity || data;
  return { id: opp.id, pipelineId: opp.pipelineId, pipelineStageId: opp.pipelineStageId || opts.stageId };
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

// --- Update existing GHL entities (for two-phase appointment/task model) ---

/** Update an existing GHL calendar appointment */
export async function updateAppointment(appointmentId: string, opts: {
  title?: string;
  description?: string;
  startTime?: string;
  endTime?: string;
  appointmentStatus?: string;
  assignedUserId?: string;
}) {
  try {
    const { data } = await ghlClient.put(`/calendars/events/appointments/${appointmentId}`, {
      ...opts,
    });
    console.log(`[GHL] Appointment updated: ${appointmentId} → ${opts.title || "(title unchanged)"}`);
    return data;
  } catch (err: any) {
    console.error(`[GHL] updateAppointment failed for ${appointmentId}:`, err?.response?.data || err?.message);
    return null;
  }
}

/** Update an existing GHL task */
export async function updateTask(contactId: string, taskId: string, opts: {
  title?: string;
  body?: string;
  dueDate?: string;
  assignedTo?: string;
  completed?: boolean;
}) {
  try {
    const { data } = await ghlClient.put(`/contacts/${contactId}/tasks/${taskId}`, {
      ...opts,
    });
    console.log(`[GHL] Task updated: ${taskId} → ${opts.title || "(title unchanged)"}`);
    return data;
  } catch (err: any) {
    console.error(`[GHL] updateTask failed for ${taskId}:`, err?.response?.data || err?.message);
    return null;
  }
}
