/**
 * coalesce.ts — v1.9 Phase 1.B
 *
 * Recent-send coalesce guard.
 *
 * Prevents the outbox from sending a message to a lead when a very recent
 * send already occurred (e.g. two outbox rows for the same lead both claim
 * within the same second, or a webhook-message.ts direct send raced the
 * outbox worker).
 *
 * Contract:
 *   checkRecentSendCoalesce(leadId, source) → { skip: boolean; reason?: string }
 *
 * Rules (per spec §5.6):
 *   - If source is 'inbound' or 'reactivation': bypass coalesce (always allow)
 *   - Otherwise: if a sent_messages row exists for this lead in the last COALESCE_WINDOW_MS,
 *     return { skip: true, reason }
 *   - Fail open: if DB is unavailable, return { skip: false }
 */

import { getDb } from "./db";
import { sentMessages } from "../drizzle/schema";
import { and, eq, gte, desc } from "drizzle-orm";

/** Window within which a recent send causes coalesce skip (60 seconds). */
export const COALESCE_WINDOW_MS = 60_000;

/** Sources that bypass the coalesce guard entirely. */
const COALESCE_BYPASS_SOURCES = new Set(["inbound", "reactivation"]);

export interface CoalesceResult {
  skip: boolean;
  reason?: string;
  lastSentAt?: Date;
}

/**
 * Check whether a recent send to this lead should cause the current outbox row
 * to be coalesced (skipped).
 *
 * @param leadId  - The lead to check
 * @param source  - The outbox source value (e.g. 'follow_up', 'fast_scan', 'inbound')
 * @returns CoalesceResult
 */
export async function checkRecentSendCoalesce(
  leadId: number,
  source: string,
): Promise<CoalesceResult> {
  // Bypass: inbound and reactivation always proceed regardless of recent sends
  if (COALESCE_BYPASS_SOURCES.has(source)) {
    return { skip: false };
  }

  const db = await getDb();
  if (!db) {
    // Fail open — don't block the send if DB is unavailable
    return { skip: false };
  }

  try {
    const windowStart = new Date(Date.now() - COALESCE_WINDOW_MS);

    const [recent] = await db
      .select({
        id: sentMessages.id,
        sentAt: sentMessages.sentAt,
        channel: sentMessages.channel,
        idemKey: sentMessages.idemKey,
      })
      .from(sentMessages)
      .where(and(
        eq(sentMessages.leadId, leadId),
        gte(sentMessages.sentAt, windowStart),
      ))
      .orderBy(desc(sentMessages.sentAt))
      .limit(1);

    if (!recent) {
      return { skip: false };
    }

    const ageMs = Date.now() - new Date(recent.sentAt).getTime();
    const ageSec = Math.round(ageMs / 1000);

    return {
      skip: true,
      reason: `Coalesce: lead ${leadId} already sent via ${recent.channel} ${ageSec}s ago (idemKey=${recent.idemKey}) — skipping source=${source}`,
      lastSentAt: new Date(recent.sentAt),
    };
  } catch (err) {
    console.error(`[Coalesce] checkRecentSendCoalesce failed for lead ${leadId}:`, err);
    return { skip: false }; // Fail open
  }
}
