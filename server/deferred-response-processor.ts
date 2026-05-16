/**
 * DEFERRED RESPONSE PROCESSOR — Agent-First Delay
 *
 * During business hours (Mon-Fri 9am-5pm EST), brand new leads get a 15-minute
 * delay before the AI responds. This gives the human agent a window to reach out first.
 *
 * The Brain Council still runs immediately (appointment + task are created right away),
 * but the composed message is stored in `deferred_responses` instead of being sent.
 *
 * This cron job runs every 2 minutes and processes pending deferred responses:
 *   1. Check if the agent has responded in the meantime (humanTakeover=1 or new outbound in GHL)
 *   2. If agent responded → cancel the deferred response
 *   3. If no agent response → send the AI message
 */

import { getPendingDeferredResponses, updateDeferredResponseStatus, getLeadById, updateLeadFields, addConversation, getConversationHistory } from "./db";
import { sendMessage, fetchGhlConversationHistory } from "./ghl";
import { sendMessageWithRetry, formatEmailHtml, normalizeChannel, buildContextSubject } from "./webhook-helpers";
import { calculateNextFollowUp } from "./scheduling-engine";
import { upsertAiState, getAiState } from "./db";
import { enqueueOutbox, makeIdemKey } from "./outbox-worker";

export async function processDeferredResponses(): Promise<{ sent: number; cancelled: number; errors: number }> {
  const pending = await getPendingDeferredResponses();
  if (pending.length === 0) return { sent: 0, cancelled: 0, errors: 0 };

  let sent = 0, cancelled = 0, errors = 0;

  for (const deferred of pending) {
    try {
      const lead = await getLeadById(deferred.leadId);
      if (!lead) {
        await updateDeferredResponseStatus(deferred.id, "cancelled", "lead_not_found");
        cancelled++;
        continue;
      }

      // --- CHECK 1: Did the human agent respond? ---
      if (lead.humanTakeover === 1) {
        await updateDeferredResponseStatus(deferred.id, "cancelled", "agent_responded_humanTakeover");
        console.log(`[DeferredResponse] Cancelled for lead ${lead.id} (${lead.name || "Unknown"}) — agent has taken over`);
        cancelled++;
        continue;
      }

      // --- CHECK 2: Check GHL history for agent outbound since deferral ---
      try {
        const ghlHistory = await fetchGhlConversationHistory(deferred.ghlContactId);
        const deferralTime = new Date(deferred.createdAt).getTime();
        const agentMsgAfterDeferral = ghlHistory.find(m => {
          if (m.direction !== "outbound") return false;
          const msgTime = new Date(m.dateAdded).getTime();
          if (msgTime <= deferralTime) return false;
          // Filter out system messages
          const body = (m.body || "").toLowerCase();
          const SYSTEM_PATTERNS = [
            "appointment", "booking", "task created", "task completed",
            "opportunity", "workflow", "automation", "pipeline",
            "form submitted", "stage changed", "status changed",
            "\ud83e\udd16", "[auto]", "[system]", "[ai]",
          ];
          return !SYSTEM_PATTERNS.some(p => body.includes(p));
        });

        if (agentMsgAfterDeferral) {
          await updateDeferredResponseStatus(deferred.id, "cancelled", "agent_responded_ghl_history");
          await updateLeadFields(lead.id, { humanTakeover: 1, lastAgentActivityAt: new Date(agentMsgAfterDeferral.dateAdded) });
          console.log(`[DeferredResponse] Cancelled for lead ${lead.id} (${lead.name || "Unknown"}) — agent sent message at ${agentMsgAfterDeferral.dateAdded}`);
          cancelled++;
          continue;
        }
      } catch (ghlErr) {
        // GHL fetch failed — proceed with sending (better to respond than to leave lead hanging)
        console.warn(`[DeferredResponse] GHL history check failed for lead ${lead.id} (non-fatal):`, ghlErr);
      }

      // --- CHECK 3: Check our own DB for agent outbound since deferral ---
      const recentConvs = await getConversationHistory(lead.id, 10);
      const deferralTime = new Date(deferred.createdAt).getTime();
      const agentConvAfterDeferral = recentConvs.find((c: any) =>
        c.direction === "outbound" &&
        c.senderType === "human" &&
        new Date(c.timestamp).getTime() > deferralTime
      );
      if (agentConvAfterDeferral) {
        await updateDeferredResponseStatus(deferred.id, "cancelled", "agent_responded_local_db");
        console.log(`[DeferredResponse] Cancelled for lead ${lead.id} (${lead.name || "Unknown"}) — agent message found in local DB`);
        cancelled++;
        continue;
      }

      // --- PHASE 1: ENQUEUE INTO OUTBOX (replaces direct send) ---
      // The deferred response already has a pre-composed message from Brain Council.
      // We enqueue it as a "deferred" source with the pre-composed payload so the
      // outbox worker can send it directly without re-running Brain Council.
      const sendChannel = normalizeChannel(deferred.channel);
      const idemKey = makeIdemKey(lead.id, `deferred:${deferred.id}`);
      const { enqueued } = await enqueueOutbox({
        leadId: lead.id,
        idemKey,
        source: "deferred",
        scheduledAt: new Date(),
        payload: {
          trigger: "deferred",
          channelHint: sendChannel,
          // Pre-composed message — outbox worker sends directly, no Brain Council needed
          draftMessage: deferred.messageBody,
          fromName: deferred.fromName || lead.assignedAgent || "Adorb Custom Tees",
          emailSubject: deferred.emailSubject || null,
          emailHtml: deferred.emailHtml || null,
          brainCouncilOutput: deferred.brainCouncilOutput || null,
          isInboundReply: true,
          ghlContactId: deferred.ghlContactId,
        },
      });

      if (enqueued) {
        await updateDeferredResponseStatus(deferred.id, "sent");
        console.log(`[DeferredResponse] ✅ Enqueued deferred response for lead ${lead.id} (${lead.name || "Unknown"}) via outbox`);
        sent++;
      } else {
        // Already pending in outbox — mark deferred as sent to avoid re-processing
        await updateDeferredResponseStatus(deferred.id, "sent");
        console.log(`[DeferredResponse] Deduped deferred response for lead ${lead.id} — already in outbox`);
        sent++;
      }
    } catch (err) {
      console.error(`[DeferredResponse] Error processing deferred #${deferred.id}:`, err);
      errors++;
    }
  }

  return { sent, cancelled, errors };
}

/**
 * Check if a lead qualifies for the agent-first delay.
 * Returns true if:
 *   1. It's business hours (Mon-Fri 9am-5pm EST)
 *   2. The lead is NOT already in humanTakeover mode
 *
 * This applies to ALL leads (new and existing) because the human agent
 * is online 100% of business hours and wants to personally respond first.
 */
export function shouldDeferResponse(lead: {
  createdAt?: Date | string | null;
  humanTakeover?: number | null;
}, conversationCount: number): boolean {
  // Don't defer if already in human takeover (agent already owns the thread)
  if (lead.humanTakeover === 1) return false;

  // AGENT-FIRST RULE: During business hours, ALWAYS defer for 15 minutes
  // regardless of whether the lead is new or existing. The human agent (Abby)
  // is online 100% of the work day and wants to craft personal responses to
  // ALL contacts — both new leads and existing customers.
  //
  // The conversationCount parameter is kept for API compatibility but no longer
  // gates the deferral. The only gates are:
  //   1. Not already in humanTakeover (agent owns it)
  //   2. Currently within business hours (Mon-Fri 9am-5pm EST)

  // Check business hours: Mon-Fri 9am-5pm EST
  const now = new Date();
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etStr);
  const day = et.getDay(); // 0=Sun, 6=Sat
  const hour = et.getHours();

  // Only defer during business hours (Mon-Fri 9am-5pm EST)
  if (day === 0 || day === 6) return false; // Weekends — send immediately
  if (hour < 9 || hour >= 17) return false; // Outside 9am-5pm — send immediately

  return true;
}

/**
 * Calculate the sendAt time for a deferred response (15 minutes from now).
 */
export function getDeferredSendAt(): Date {
  return new Date(Date.now() + 15 * 60 * 1000); // 15 minutes from now
}
