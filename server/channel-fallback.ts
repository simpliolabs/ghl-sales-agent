/**
 * CHANNEL FALLBACK ENGINE — Channel-specific DNC handling
 * 
 * When a lead opts out on one channel (e.g., "Stop" on SMS), this module:
 * 1. Blocks ONLY that specific channel (sets dndSms=1, NOT humanTakeover=1)
 * 2. Finds the next available channel in priority order
 * 3. Escalates the lead to that channel
 * 4. Only moves to Not Qualified when ALL channels are exhausted
 * 
 * Channel priority: Email → FB → IG → WhatsApp (24h window) → SMS
 * 
 * Legal basis:
 * - "Stop" on SMS (TCPA) = revokes SMS consent only
 * - "Unsubscribe" on Email (CAN-SPAM) = revokes email consent only
 * - Each channel has independent opt-out under US law
 */

import { updateLeadFields } from "./db";
import { addNote } from "./ghl";

// Channel priority order for fallback (highest priority first)
const CHANNEL_PRIORITY = ["Email", "FB", "IG", "Live_Chat", "WhatsApp", "SMS"] as const;
type Channel = typeof CHANNEL_PRIORITY[number];

// Map channel names to DND column names
const CHANNEL_TO_DND_FIELD: Record<string, string> = {
  "SMS": "dndSms",
  "Email": "dndEmail",
  "FB": "dndFb",
  "Live_Chat": "dndFb", // Live Chat shares DND with FB in GHL
  "WhatsApp": "dndWhatsapp",
  "IG": "dndFb", // IG uses same DND as FB in GHL
};

// Map channel names to what the lead needs for that channel to work
const CHANNEL_REQUIREMENTS: Record<string, (lead: any) => boolean> = {
  "Email": (lead) => !!(lead.email && lead.email.trim() !== "" && !lead.dndEmail),
  "FB": (lead) => !lead.dndFb, // FB doesn't require email/phone, just no DND
  "Live_Chat": (lead) => !lead.dndFb, // Live Chat shares DND with FB — but only works if visitor is active
  "IG": (lead) => !lead.dndFb, // IG shares DND with FB
  "WhatsApp": (lead) => !!(lead.phone && lead.phone.trim() !== "" && !lead.dndWhatsapp),
  "SMS": (lead) => !!(lead.phone && lead.phone.trim() !== "" && !lead.dndSms),
};

export interface ChannelFallbackResult {
  action: "escalated" | "not_qualified";
  blockedChannel: string;
  nextChannel: string | null;
  allChannelsExhausted: boolean;
}

/**
 * Detect which channel a DNC keyword was sent on.
 * Uses the inbound message channel or defaults to SMS.
 */
export function detectDncChannel(inboundChannel: string | null | undefined): string {
  if (!inboundChannel) return "SMS";
  const normalized = String(inboundChannel).toUpperCase().trim();
  if (normalized.includes("EMAIL")) return "Email";
  if (normalized.includes("LIVE_CHAT") || normalized.includes("LIVECHAT")) return "Live_Chat";
  if (normalized.includes("FB") || normalized.includes("FACEBOOK") || normalized.includes("MESSENGER")) return "FB";
  if (normalized.includes("IG") || normalized.includes("INSTAGRAM")) return "IG";
  if (normalized.includes("WHATSAPP")) return "WhatsApp";
  return "SMS";
}

/**
 * Find the next available channel for a lead, excluding the blocked channel.
 * Returns null if no channels are available.
 */
export function findNextChannel(lead: any, blockedChannel: string): string | null {
  for (const ch of CHANNEL_PRIORITY) {
    if (ch === blockedChannel) continue; // Skip the blocked channel
    const checker = CHANNEL_REQUIREMENTS[ch];
    if (checker && checker(lead)) return ch;
  }
  return null;
}

/**
 * Check if ALL channels are exhausted for a lead.
 */
export function allChannelsExhausted(lead: any): boolean {
  for (const ch of CHANNEL_PRIORITY) {
    const checker = CHANNEL_REQUIREMENTS[ch];
    if (checker && checker(lead)) return false;
  }
  return true;
}

/**
 * Handle a channel-specific DNC opt-out.
 * 
 * 1. Blocks the specific channel the DNC was received on
 * 2. Finds the next available channel
 * 3. Escalates to that channel OR moves to Not Qualified if none available
 * 
 * Returns the action taken so callers can log/notify appropriately.
 */
export async function handleChannelDnc(
  leadId: number,
  lead: any,
  dncChannel: string,
  ghlContactId?: string | null,
): Promise<ChannelFallbackResult> {
  // Step 1: Block the specific channel
  const dndField = CHANNEL_TO_DND_FIELD[dncChannel] || "dndSms";
  const blockUpdate: Record<string, any> = { [dndField]: 1 };
  await updateLeadFields(leadId, blockUpdate);
  console.log(`[ChannelFallback] Lead ${leadId}: blocked ${dncChannel} (set ${dndField}=1)`);

  // Step 2: Refresh lead state with the new DND flag for channel checking
  const updatedLead = { ...lead, [dndField]: 1 };

  // Step 3: Find next available channel
  const nextChannel = findNextChannel(updatedLead, dncChannel);

  if (nextChannel) {
    // Escalate to the next channel
    const nextFollowUp = new Date(Date.now() + 24 * 60 * 60 * 1000); // Tomorrow
    await updateLeadFields(leadId, {
      humanTakeover: 0, // Clear takeover — AI can use the new channel
      preferredChannel: nextChannel,
      lastOutboundChannel: nextChannel,
      nextFollowUpAt: nextFollowUp,
      cadencePosition: 0, // Reset cadence for new channel
    });

    // Add GHL note
    if (ghlContactId) {
      try {
        await addNote(ghlContactId, 
          `🤖 Channel DNC: Lead opted out of ${dncChannel}.\n` +
          `Escalating to ${nextChannel} outreach.\n` +
          `Next follow-up: ${nextFollowUp.toISOString()}`
        );
      } catch { /* best effort */ }
    }

    console.log(`[ChannelFallback] Lead ${leadId}: escalated from ${dncChannel} → ${nextChannel}`);
    return {
      action: "escalated",
      blockedChannel: dncChannel,
      nextChannel,
      allChannelsExhausted: false,
    };
  } else {
    // No channels available — this is a true Not Qualified
    // Don't set humanTakeover here — let the caller handle pipeline disposition
    console.log(`[ChannelFallback] Lead ${leadId}: ALL channels exhausted after ${dncChannel} DNC`);

    if (ghlContactId) {
      try {
        await addNote(ghlContactId,
          `🤖 All Channels Exhausted: Lead opted out of ${dncChannel}.\n` +
          `No remaining viable channels. Moving to Not Qualified.`
        );
      } catch { /* best effort */ }
    }

    return {
      action: "not_qualified",
      blockedChannel: dncChannel,
      nextChannel: null,
      allChannelsExhausted: true,
    };
  }
}
