/**
 * crons.ts — v1.9 Phase 1.C/D Cleanup Crons
 *
 * Five crons that maintain the health of the v1.9 outbox/compose pipeline:
 *
 *   3.1  cleanupOrphanedClaims          — 60s  — reclaim outbox rows with no live worker
 *   3.2  cleanupExpiredLeadActiveCompose — 60s  — delete expired lead_active_compose rows
 *   3.3  reconcileOrphanedSentMessages   — 60s  — GHL best-effort reconciliation for pending rows
 *   3.4  sentMessagesRetention           — 24h  — delete sent_messages rows older than 30 days
 *   3.5  victimRemediationSkeleton       — 24h  — SKELETON: scan for dissatisfaction signals, log only
 *
 * Registration: called from server/_core/index.ts via startCleanupCrons()
 */

import { getDb } from "./db";
import { sweepExpiredLeadComposeLocks } from "./lead-active-compose";
import { getPendingReconciliation, markReconciled } from "./sent-messages";
import { sql } from "drizzle-orm";

export const ORPHAN_CLAIM_EXPIRY_MS = 120_000;
export const SENT_MESSAGES_RETENTION_DAYS = 30;

export interface CleanupOrphanedClaimsResult {
  reclaimed: number;
  errors: number;
}

export async function cleanupOrphanedClaims(): Promise<CleanupOrphanedClaimsResult> {
  const db = await getDb();
  if (!db) return { reclaimed: 0, errors: 1 };
  const expiry = new Date(Date.now() - ORPHAN_CLAIM_EXPIRY_MS);
  try {
    const result = await db.execute(sql`
      UPDATE outbox
      SET outbox_status = 'pending',
          claimedBy = NULL,
          claimedAt = NULL
      WHERE outbox_status = 'claimed'
        AND claimedAt < ${expiry}
    `);
    const reclaimed = (result as any)?.[0]?.affectedRows ?? 0;
    if (reclaimed > 0) {
      console.log(`[CleanupCron/OrphanedClaims] Reclaimed ${reclaimed} orphaned outbox row(s)`);
    }
    return { reclaimed, errors: 0 };
  } catch (err) {
    console.error("[CleanupCron/OrphanedClaims] Error:", err);
    return { reclaimed: 0, errors: 1 };
  }
}

export interface CleanupExpiredLeadActiveComposeResult {
  deleted: number;
  errors: number;
}

export async function cleanupExpiredLeadActiveCompose(): Promise<CleanupExpiredLeadActiveComposeResult> {
  try {
    const deleted = await sweepExpiredLeadComposeLocks();
    if (deleted > 0) {
      console.log(`[CleanupCron/LeadActiveCompose] Swept ${deleted} expired compose lock(s)`);
    }
    return { deleted, errors: 0 };
  } catch (err) {
    console.error("[CleanupCron/LeadActiveCompose] Error:", err);
    return { deleted: 0, errors: 1 };
  }
}

export interface ReconcileOrphanedSentMessagesResult {
  checked: number;
  confirmed: number;
  unknown: number;
  errors: number;
}

export async function reconcileOrphanedSentMessages(): Promise<ReconcileOrphanedSentMessagesResult> {
  let checked = 0;
  let confirmed = 0;
  let unknown = 0;
  let errors = 0;
  try {
    const pending = await getPendingReconciliation(50);
    checked = pending.length;
    if (checked === 0) return { checked, confirmed, unknown, errors };
    for (const row of pending) {
      try {
        const status: "confirmed" | "unknown" = "unknown";
        await markReconciled(row.id, status);
        unknown++;
        console.warn(
          `[CleanupCron/ReconcileSentMessages] OPERATOR-REVIEW: sent_messages row ${row.id} ` +
          `(lead=${row.leadId} channel=${row.channel} ghlMessageId=${row.ghlMessageId ?? 'none'} ` +
          `sentAt=${row.sentAt?.toISOString?.() ?? 'unknown'}) marked unknown — GHL lookup not available`
        );
      } catch (rowErr) {
        errors++;
        console.error(`[CleanupCron/ReconcileSentMessages] Error processing row ${row.id}:`, rowErr);
      }
    }
  } catch (err) {
    errors++;
    console.error("[CleanupCron/ReconcileSentMessages] Fatal error:", err);
  }
  if (checked > 0) {
    console.log(`[CleanupCron/ReconcileSentMessages] Checked=${checked} confirmed=${confirmed} unknown=${unknown} errors=${errors}`);
  }
  return { checked, confirmed, unknown, errors };
}

export interface SentMessagesRetentionResult {
  deleted: number;
  errors: number;
}

export async function sentMessagesRetention(): Promise<SentMessagesRetentionResult> {
  const db = await getDb();
  if (!db) return { deleted: 0, errors: 1 };
  try {
    const result = await db.execute(sql`
      DELETE FROM sent_messages
      WHERE reconciledAt < DATE_SUB(NOW(), INTERVAL ${SENT_MESSAGES_RETENTION_DAYS} DAY)
    `);
    const deleted = (result as any)?.[0]?.affectedRows ?? 0;
    if (deleted > 0) {
      console.log(`[CleanupCron/SentMessagesRetention] Deleted ${deleted} sent_messages row(s) older than ${SENT_MESSAGES_RETENTION_DAYS} days`);
    }
    return { deleted, errors: 0 };
  } catch (err) {
    console.error("[CleanupCron/SentMessagesRetention] Error:", err);
    return { deleted: 0, errors: 1 };
  }
}

export interface VictimRemediationSkeletonResult {
  scanned: number;
  candidates: number;
  errors: number;
}

export async function victimRemediationSkeleton(): Promise<VictimRemediationSkeletonResult> {
  const db = await getDb();
  if (!db) return { scanned: 0, candidates: 0, errors: 1 };
  try {
    const result = await db.execute(sql`
      SELECT l.id, l.firstName, l.lastName, l.ghlContactId, l.dncStatus,
             l.lastMessageAt, l.consecutiveNullCount
      FROM leads l
      WHERE (
        l.dncStatus = 'opted_out'
        OR l.consecutiveNullCount >= 5
      )
      AND l.lastMessageAt > DATE_SUB(NOW(), INTERVAL 24 HOUR)
      LIMIT 100
    `);
    const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : [];
    const candidates = (rows as any[]).length;
    for (const row of rows as any[]) {
      console.warn(
        `[VictimRemediation/SKELETON] CANDIDATE: lead=${row.id} ` +
        `name="${row.firstName || ''} ${row.lastName || ''}" ` +
        `dncStatus=${row.dncStatus || 'none'} consecutiveNullCount=${row.consecutiveNullCount ?? 0} — Foundation B pending`
      );
    }
    if (candidates > 0) {
      console.log(`[VictimRemediation/SKELETON] Found ${candidates} candidate(s) for remediation`);
    }
    return { scanned: 100, candidates, errors: 0 };
  } catch (err) {
    console.error("[VictimRemediation/SKELETON] Error:", err);
    return { scanned: 0, candidates: 0, errors: 1 };
  }
}

export function startCleanupCrons(): void {
  const SIXTY_SECONDS = 60_000;
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

  setInterval(async () => {
    try { await cleanupOrphanedClaims(); } catch (err) { console.error("[CleanupCron/OrphanedClaims] Unhandled:", err); }
  }, SIXTY_SECONDS);
  console.log("[Cron] cleanupOrphanedClaims scheduled every 60s");

  setInterval(async () => {
    try { await cleanupExpiredLeadActiveCompose(); } catch (err) { console.error("[CleanupCron/LeadActiveCompose] Unhandled:", err); }
  }, SIXTY_SECONDS);
  console.log("[Cron] cleanupExpiredLeadActiveCompose scheduled every 60s");

  setInterval(async () => {
    try { await reconcileOrphanedSentMessages(); } catch (err) { console.error("[CleanupCron/ReconcileSentMessages] Unhandled:", err); }
  }, SIXTY_SECONDS);
  console.log("[Cron] reconcileOrphanedSentMessages scheduled every 60s");

  setInterval(async () => {
    try { await sentMessagesRetention(); } catch (err) { console.error("[CleanupCron/SentMessagesRetention] Unhandled:", err); }
  }, TWENTY_FOUR_HOURS);
  console.log("[Cron] sentMessagesRetention scheduled every 24h");

  setInterval(async () => {
    try { await victimRemediationSkeleton(); } catch (err) { console.error("[CleanupCron/VictimRemediation] Unhandled:", err); }
  }, TWENTY_FOUR_HOURS);
  console.log("[Cron] victimRemediationSkeleton (SKELETON) scheduled every 24h");
}
