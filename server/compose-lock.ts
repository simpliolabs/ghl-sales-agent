/**
 * Foundation D — Compose Lock
 *
 * Per-lead, per-inbound-event mutex that prevents multi-fire:
 * multiple outbound AI messages sent to the same lead within minutes
 * because concurrent webhook deliveries trigger more than one enqueue path.
 *
 * Usage:
 *   const acquired = await acquireComposeLock(leadId, inboundMessage, "fast_scan");
 *   if (!acquired) return; // another path already enqueued for this inbound
 */

import crypto from "crypto";
import { getDb } from "./db";
import { sql } from "drizzle-orm";

const LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes
const BUCKET_MS  =  5 * 60 * 1000;  // 5-minute bucket (matches makeIdemKey)

/**
 * Generate the event key for a given lead + inbound message.
 * Same lead + same message content within the same 5-min window = same key.
 * Different message content (lead replied again) = different key.
 *
 * Known limitation: webhooks arriving on either side of a 5-min bucket boundary
 * (e.g. 13:59:59 and 14:00:01) get different keys and both acquire locks.
 * This is a very-low-likelihood edge case; see Foundation D spec Section 9 for mitigation path.
 */
export function makeEventKey(leadId: number, inboundMessage: string): string {
  const bucket = Math.floor(Date.now() / BUCKET_MS);
  return crypto
    .createHash("sha256")
    .update(`compose:${leadId}:${inboundMessage.substring(0, 100)}:${bucket}`)
    .digest("hex")
    .slice(0, 64);
}

/**
 * Attempt to acquire a compose lock for a lead + inbound event.
 *
 * Returns true  → lock acquired; this path should proceed with enqueue.
 * Returns false → another path already holds the lock; skip this enqueue.
 *
 * Fail-open: returns true if the DB is unavailable so sends are never blocked
 * by infrastructure failures.
 *
 * Uses INSERT IGNORE + affectedRows for atomic acquisition — no SELECT-then-INSERT
 * race condition, no follow-up SELECT needed (Mod 1 from PO review).
 */
export async function acquireComposeLock(
  leadId: number,
  inboundMessage: string,
  source: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) return true; // Fail open — if DB is down, don't block sends

  const eventKey = makeEventKey(leadId, inboundMessage);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

  // Purge expired locks first (best-effort, non-blocking)
  try {
    await db.execute(sql`DELETE FROM compose_locks WHERE expiresAt < ${now} LIMIT 100`);
  } catch { /* non-fatal */ }

  try {
    // INSERT IGNORE: silently skips if the UNIQUE(leadId, eventKey) constraint fires.
    // affectedRows = 1 → we inserted → we own the lock.
    // affectedRows = 0 → duplicate key was ignored → another path holds the lock.
    const result = await db.execute(sql`
      INSERT IGNORE INTO compose_locks (leadId, eventKey, source, lockedAt, expiresAt)
      VALUES (${leadId}, ${eventKey}, ${source}, ${now}, ${expiresAt})
    `);
    // Drizzle wraps the MySQL result as [resultObj, fields] — affectedRows is at index 0.
    const affectedRows = (result as any)[0]?.affectedRows ?? (result as any).affectedRows ?? (result as any).rowsAffected ?? 0;
    const acquired = affectedRows > 0;

    if (!acquired) {
      console.log(`[ComposeLock] Lead ${leadId}: lock already held, skipping '${source}' enqueue`);
    }
    return acquired;
  } catch (err) {
    console.error(`[ComposeLock] Error acquiring lock for lead ${leadId}:`, err);
    return true; // Fail open
  }
}
