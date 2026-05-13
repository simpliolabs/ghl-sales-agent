/**
 * FB WINDOW MANAGER (Decision 3B)
 * 
 * Facebook/Instagram Messaging Policy requires that businesses respond
 * within 24 hours of the last customer-initiated message. After 24 hours,
 * the messaging window closes and the business cannot send messages.
 * 
 * This module provides a helper to check if the FB/IG messaging window
 * is still open for a given lead, based on the last inbound message
 * timestamp in the conversations table.
 * 
 * If the window is closed, the caller should fall back to SMS.
 */

import { getDb } from "./db";
import { conversations } from "../drizzle/schema";
import { eq, and, desc, sql } from "drizzle-orm";

const FB_WINDOW_HOURS = 24;

export interface FbWindowResult {
  isOpen: boolean;
  lastInboundAt: number | null; // Unix timestamp ms
  hoursRemaining: number | null; // hours until window closes (null if closed)
  fallbackChannel: string; // recommended channel if window is closed
}

/**
 * Check if the Facebook/Instagram messaging window is open for a lead.
 * The window is open if the lead sent an inbound message on FB/IG within the last 24 hours.
 */
export async function isFbWindowOpen(leadId: number): Promise<FbWindowResult> {
  const db = await getDb();
  if (!db) {
    return { isOpen: false, lastInboundAt: null, hoursRemaining: null, fallbackChannel: "SMS" };
  }

  try {
    // Find the most recent inbound FB/IG message from this lead
    const [lastInbound] = await db.select({
      timestamp: conversations.timestamp,
    })
      .from(conversations)
      .where(and(
        eq(conversations.leadId, leadId),
        eq(conversations.direction, "inbound"),
        sql`LOWER(${conversations.channel}) IN ('fb', 'facebook', 'ig', 'instagram')`,
      ))
      .orderBy(desc(conversations.timestamp))
      .limit(1);

    if (!lastInbound || !lastInbound.timestamp) {
      // No inbound FB/IG message ever — window is closed
      return { isOpen: false, lastInboundAt: null, hoursRemaining: null, fallbackChannel: "SMS" };
    }

    const lastInboundMs = typeof lastInbound.timestamp === 'number'
      ? lastInbound.timestamp
      : new Date(lastInbound.timestamp).getTime();

    const nowMs = Date.now();
    const elapsedHours = (nowMs - lastInboundMs) / (1000 * 60 * 60);
    const hoursRemaining = FB_WINDOW_HOURS - elapsedHours;

    if (hoursRemaining > 0) {
      return {
        isOpen: true,
        lastInboundAt: lastInboundMs,
        hoursRemaining: Math.round(hoursRemaining * 10) / 10,
        fallbackChannel: "SMS",
      };
    } else {
      return {
        isOpen: false,
        lastInboundAt: lastInboundMs,
        hoursRemaining: null,
        fallbackChannel: "SMS",
      };
    }
  } catch (err) {
    console.error("[FBWindow] Error checking FB window for lead", leadId, err);
    // On error, assume window is closed (safer to fall back to SMS)
    return { isOpen: false, lastInboundAt: null, hoursRemaining: null, fallbackChannel: "SMS" };
  }
}

/**
 * Check if a channel is a Facebook/Instagram channel.
 */
export function isFbChannel(channel: string): boolean {
  const ch = (channel || "").toLowerCase();
  return ch === "fb" || ch === "facebook" || ch === "ig" || ch === "instagram";
}
