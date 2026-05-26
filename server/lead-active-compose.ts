/**
 * lead-active-compose.ts — v1.9 Phase 1.B
 *
 * Per-lead compose lock with heartbeat.
 * Prevents concurrent compose runs for the same lead across all entry points
 * (outbox-worker, webhook-message, fast-scan, etc.).
 *
 * Contract:
 *   - acquireLeadComposeLock(leadId, heldBy, ttlMs) → true if acquired, false if already held
 *   - heartbeatLeadComposeLock(leadId, heldBy) → extends expiresAt by TTL_MS
 *   - releaseLeadComposeLock(leadId, heldBy) → deletes the row (only if heldBy matches)
 *   - sweepExpiredLeadComposeLocks() → deletes all rows where expiresAt < NOW()
 */

import { getDb } from "./db";
import { leadActiveCompose } from "../drizzle/schema";
import { eq, and, lt, sql } from "drizzle-orm";

/** Default TTL for a compose lock — 90 seconds.
 *  Must be longer than the worst-case LLM call (120s cap) minus heartbeat interval.
 *  Heartbeat fires every 30s, so 90s gives 3 missed heartbeats before expiry. */
export const LEAD_COMPOSE_LOCK_TTL_MS = 90_000;

/**
 * Attempt to acquire the per-lead compose lock.
 *
 * Uses INSERT IGNORE semantics via Drizzle's onDuplicateKeyUpdate with a
 * conditional: only update if the existing row is expired.
 *
 * Returns true if the lock was acquired (row inserted or expired row replaced).
 * Returns false if a live lock is held by another worker.
 */
export async function acquireLeadComposeLock(
  leadId: number,
  heldBy: string,
  ttlMs: number = LEAD_COMPOSE_LOCK_TTL_MS,
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  try {
    // INSERT ... ON DUPLICATE KEY UPDATE — only update if the existing row is expired.
    // If a live lock exists (expiresAt > NOW()), the UPDATE is a no-op (sets heldBy to itself).
    // We detect acquisition by checking if the row's heldBy matches ours after the upsert.
    await db.insert(leadActiveCompose).values({
      leadId,
      heldBy,
      acquiredAt: now,
      expiresAt,
      heartbeatAt: now,
    }).onDuplicateKeyUpdate({
      set: {
        heldBy: sql`IF(expiresAt < NOW(), ${heldBy}, heldBy)`,
        acquiredAt: sql`IF(expiresAt < NOW(), ${now.toISOString().slice(0, 19).replace("T", " ")}, acquiredAt)`,
        expiresAt: sql`IF(expiresAt < NOW(), ${expiresAt.toISOString().slice(0, 19).replace("T", " ")}, expiresAt)`,
        heartbeatAt: sql`IF(expiresAt < NOW(), ${now.toISOString().slice(0, 19).replace("T", " ")}, heartbeatAt)`,
      },
    });

    // Verify we actually hold the lock
    const [row] = await db
      .select({ heldBy: leadActiveCompose.heldBy, expiresAt: leadActiveCompose.expiresAt })
      .from(leadActiveCompose)
      .where(eq(leadActiveCompose.leadId, leadId))
      .limit(1);

    if (!row) return false;
    const isOurs = row.heldBy === heldBy && new Date(row.expiresAt).getTime() > Date.now();
    return isOurs;
  } catch (err) {
    console.error(`[LeadComposeLock] acquireLeadComposeLock failed for lead ${leadId}:`, err);
    return false;
  }
}

/**
 * Extend the expiry of an existing compose lock.
 * Only extends if the row still belongs to heldBy.
 * Returns true if the heartbeat was applied.
 */
export async function heartbeatLeadComposeLock(
  leadId: number,
  heldBy: string,
  ttlMs: number = LEAD_COMPOSE_LOCK_TTL_MS,
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  const now = new Date();
  const newExpiry = new Date(now.getTime() + ttlMs);

  try {
    const result = await db
      .update(leadActiveCompose)
      .set({
        expiresAt: newExpiry,
        heartbeatAt: now,
      })
      .where(and(
        eq(leadActiveCompose.leadId, leadId),
        eq(leadActiveCompose.heldBy, heldBy),
      ));

    return (result[0] as any)?.affectedRows > 0;
  } catch (err) {
    console.error(`[LeadComposeLock] heartbeatLeadComposeLock failed for lead ${leadId}:`, err);
    return false;
  }
}

/**
 * Release the compose lock for a lead.
 * Only deletes if the row belongs to heldBy (prevents foreign release).
 * Returns true if the lock was released.
 */
export async function releaseLeadComposeLock(
  leadId: number,
  heldBy: string,
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  try {
    const result = await db
      .delete(leadActiveCompose)
      .where(and(
        eq(leadActiveCompose.leadId, leadId),
        eq(leadActiveCompose.heldBy, heldBy),
      ));

    return (result[0] as any)?.affectedRows > 0;
  } catch (err) {
    console.error(`[LeadComposeLock] releaseLeadComposeLock failed for lead ${leadId}:`, err);
    return false;
  }
}

/**
 * Sweep all expired compose locks.
 * Called by the outbox-worker sweep cycle to prevent stale rows from blocking.
 * Returns the number of rows deleted.
 */
export async function sweepExpiredLeadComposeLocks(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  try {
    const result = await db
      .delete(leadActiveCompose)
      .where(lt(leadActiveCompose.expiresAt, new Date()));

    return (result[0] as any)?.affectedRows ?? 0;
  } catch (err) {
    console.error(`[LeadComposeLock] sweepExpiredLeadComposeLocks failed:`, err);
    return 0;
  }
}

/**
 * Check if a lead currently has an active (non-expired) compose lock.
 * Returns the heldBy value if locked, null if free.
 */
export async function getLeadComposeLockHolder(leadId: number): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const [row] = await db
      .select({ heldBy: leadActiveCompose.heldBy, expiresAt: leadActiveCompose.expiresAt })
      .from(leadActiveCompose)
      .where(eq(leadActiveCompose.leadId, leadId))
      .limit(1);

    if (!row) return null;
    if (new Date(row.expiresAt).getTime() <= Date.now()) return null;
    return row.heldBy;
  } catch (err) {
    console.error(`[LeadComposeLock] getLeadComposeLockHolder failed for lead ${leadId}:`, err);
    return null;
  }
}
