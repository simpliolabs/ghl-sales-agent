/**
 * sent-messages.ts — v1.9 Phase 1.B
 *
 * Idempotency guard and GHL reconciliation helpers for the sent_messages table.
 *
 * Contract:
 *   - recordSentMessage(row)       → INSERT IGNORE; returns true if new, false if duplicate
 *   - isSentMessageDuplicate(...)  → SELECT check before sending
 *   - updateGhlMessageId(...)      → patch ghlMessageId after GHL confirms delivery
 *   - markReconciled(...)          → update reconciliationStatus after cron reconciliation
 *   - getPendingReconciliation(limit) → rows with null reconciliationStatus
 */

import { getDb } from "./db";
import { sentMessages } from "../drizzle/schema";
import { and, eq, isNull, asc } from "drizzle-orm";

export interface RecordSentMessageInput {
  leadId: number;
  idemKey: string;
  channel: string;
  ghlMessageId?: string | null;
}

/**
 * Record a sent message in the idempotency table.
 * Uses INSERT IGNORE semantics — if the (leadId, idemKey, channel) row already
 * exists, the insert is silently dropped and false is returned.
 *
 * Returns true if the row was newly inserted (first send).
 * Returns false if a duplicate was detected (row already existed).
 */
export async function recordSentMessage(input: RecordSentMessageInput): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    console.error("[SentMessages] DB unavailable — cannot record sent message");
    return true; // fail open: don't block the send
  }

  try {
    const result = await db.insert(sentMessages).ignore().values({
      leadId: input.leadId,
      idemKey: input.idemKey,
      channel: input.channel,
      ghlMessageId: input.ghlMessageId ?? null,
      sentAt: new Date(),
    });

    const affectedRows = (result[0] as any)?.affectedRows ?? 0;
    return affectedRows > 0;
  } catch (err) {
    console.error(`[SentMessages] recordSentMessage failed for lead ${input.leadId} idemKey ${input.idemKey}:`, err);
    return true; // fail open
  }
}

/**
 * Check whether a message with this (leadId, idemKey, channel) has already been sent.
 * Returns true if a duplicate exists (block the send).
 * Returns false if no duplicate (allow the send).
 */
export async function isSentMessageDuplicate(
  leadId: number,
  idemKey: string,
  channel: string,
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false; // fail open

  try {
    const [row] = await db
      .select({ id: sentMessages.id })
      .from(sentMessages)
      .where(and(
        eq(sentMessages.leadId, leadId),
        eq(sentMessages.idemKey, idemKey),
        eq(sentMessages.channel, channel),
      ))
      .limit(1);

    return !!row;
  } catch (err) {
    console.error(`[SentMessages] isSentMessageDuplicate check failed for lead ${leadId}:`, err);
    return false; // fail open
  }
}

/**
 * Patch the ghlMessageId on an existing sent_messages row after GHL confirms delivery.
 * Called by apply-compose-outcome after a successful send.
 */
export async function updateGhlMessageId(
  leadId: number,
  idemKey: string,
  channel: string,
  ghlMessageId: string,
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  try {
    await db
      .update(sentMessages)
      .set({ ghlMessageId })
      .where(and(
        eq(sentMessages.leadId, leadId),
        eq(sentMessages.idemKey, idemKey),
        eq(sentMessages.channel, channel),
      ));
  } catch (err) {
    console.error(`[SentMessages] updateGhlMessageId failed for lead ${leadId} idemKey ${idemKey}:`, err);
  }
}

/**
 * Mark a sent_messages row as reconciled after the cron verifies it in GHL.
 * reconciliationStatus values: 'confirmed' | 'missing' | 'duplicate_detected'
 */
export async function markReconciled(
  id: number,
  reconciliationStatus: string,
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  try {
    await db
      .update(sentMessages)
      .set({
        reconciliationStatus,
        reconciledAt: new Date(),
      })
      .where(eq(sentMessages.id, id));
  } catch (err) {
    console.error(`[SentMessages] markReconciled failed for id ${id}:`, err);
  }
}

/**
 * Check whether a sent message is confirmed (reconciliationStatus = 'confirmed').
 * Returns false for rows with reconciliationStatus = 'pending' or null — pending
 * rows are not yet verified and must not be treated as confirmed sent.
 *
 * Reconciliation cron: when a row with reconciliationStatus='pending' is found,
 * write a placeholder conversation entry if no conversations row exists yet,
 * then mark the row as 'confirmed' or 'missing'.
 */
export async function checkSentIdempotency(
  leadId: number,
  idemKey: string,
  channel: string,
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false; // fail open
  try {
    const [row] = await db
      .select({ id: sentMessages.id, reconciliationStatus: sentMessages.reconciliationStatus })
      .from(sentMessages)
      .where(and(
        eq(sentMessages.leadId, leadId),
        eq(sentMessages.idemKey, idemKey),
        eq(sentMessages.channel, channel),
      ))
      .limit(1);
    if (!row) return false;
    // A row with reconciliationStatus='pending' is not yet confirmed — do not treat as sent
    if (row.reconciliationStatus === "pending" || row.reconciliationStatus === null) return false;
    return true;
  } catch (err) {
    console.error(`[SentMessages] checkSentIdempotency failed for lead ${leadId}:`, err);
    return false; // fail open
  }
}

/**
 * Fetch rows that have not yet been reconciled (reconciliationStatus IS NULL).
 * Used by the GHL reconciliation cron.
 */
export async function getPendingReconciliation(limit = 100): Promise<typeof sentMessages.$inferSelect[]> {
  const db = await getDb();
  if (!db) return [];

  try {
    return await db
      .select()
      .from(sentMessages)
      .where(isNull(sentMessages.reconciliationStatus))
      .orderBy(asc(sentMessages.sentAt))
      .limit(limit);
  } catch (err) {
    console.error("[SentMessages] getPendingReconciliation failed:", err);
    return [];
  }
}
