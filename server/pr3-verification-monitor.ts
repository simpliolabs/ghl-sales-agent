/**
 * PR#3 Verification Monitor
 * 
 * Temporary in-process poller that captures the first qualifying evidence for:
 *   - Verification 5: Email HTML formatting (post-deploy email with proper HTML)
 *   - Verification 6: SMS split (brain message containing \n---\n that resulted in 2 sends)
 * 
 * Runs every 5 minutes. Self-disables once both verifications are captured.
 * Evidence is logged to console with [PR3-VERIFY] prefix for easy grep.
 * 
 * DELETE THIS FILE after both verifications are confirmed.
 */

import { getDb } from "./db";
import { decisionLog, outbox } from "../drizzle/schema";
import { sql, desc, and, gte, eq, like } from "drizzle-orm";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const POST_DEPLOY_CUTOFF = new Date("2026-05-17T17:16:00.000Z"); // PR#3 deploy time

let v5Captured = false;
let v6Captured = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

async function checkVerification5(): Promise<void> {
  if (v5Captured) return;

  const db = await getDb();
  if (!db) return;

  // Find the first post-deploy email send that went through the outbox
  const rows = await db
    .select({
      id: outbox.id,
      leadId: outbox.leadId,
      payload: outbox.payload,
      sentAt: outbox.sentAt,
    })
    .from(outbox)
    .where(
      and(
        eq(outbox.status, "sent"),
        gte(outbox.sentAt, POST_DEPLOY_CUTOFF),
        like(outbox.payload, "%Email%")
      )
    )
    .orderBy(outbox.sentAt)
    .limit(1);

  if (rows.length === 0) return;

  const row = rows[0];
  
  // Now find the corresponding decision_log entry to get brainReasoning (the actual message)
  const decisions = await db
    .select({
      id: decisionLog.id,
      leadId: decisionLog.leadId,
      channel: decisionLog.channel,
      brainReasoning: decisionLog.brainReasoning,
      outputGuardResult: decisionLog.outputGuardResult,
      createdAt: decisionLog.createdAt,
    })
    .from(decisionLog)
    .where(
      and(
        eq(decisionLog.leadId, row.leadId),
        eq(decisionLog.channel, "Email"),
        gte(decisionLog.createdAt, POST_DEPLOY_CUTOFF)
      )
    )
    .orderBy(desc(decisionLog.createdAt))
    .limit(1);

  v5Captured = true;
  console.log(`\n${"=".repeat(80)}`);
  console.log(`[PR3-VERIFY] ✅ VERIFICATION 5 CAPTURED — Email HTML Formatting`);
  console.log(`${"=".repeat(80)}`);
  console.log(`[PR3-VERIFY] Outbox row: ${row.id} | Lead: ${row.leadId} | Sent: ${row.sentAt}`);
  console.log(`[PR3-VERIFY] Payload (first 2000 chars):`);
  console.log(String(row.payload).slice(0, 2000));
  if (decisions.length > 0) {
    const d = decisions[0];
    console.log(`[PR3-VERIFY] Decision log: id=${d.id} | channel=${d.channel} | guard=${d.outputGuardResult}`);
    console.log(`[PR3-VERIFY] Brain message (first 1000 chars):`);
    console.log(String(d.brainReasoning || "").slice(0, 1000));
  }
  console.log(`${"=".repeat(80)}\n`);

  checkDone();
}

async function checkVerification6(): Promise<void> {
  if (v6Captured) return;

  const db = await getDb();
  if (!db) return;

  // Find decision_log entries post-deploy where brainReasoning contains \n---\n
  const decisions = await db
    .select({
      id: decisionLog.id,
      leadId: decisionLog.leadId,
      channel: decisionLog.channel,
      brainReasoning: decisionLog.brainReasoning,
      outputGuardResult: decisionLog.outputGuardResult,
      createdAt: decisionLog.createdAt,
      outboxId: decisionLog.outboxId,
    })
    .from(decisionLog)
    .where(
      and(
        gte(decisionLog.createdAt, POST_DEPLOY_CUTOFF),
        like(decisionLog.brainReasoning, "%\n---\n%"),
        sql`${decisionLog.channel} IN ('SMS', 'WhatsApp')`
      )
    )
    .orderBy(decisionLog.createdAt)
    .limit(1);

  if (decisions.length === 0) {
    // Alternative: check for any SMS outbox sent post-deploy where the brain message had ---
    const smsRows = await db
      .select({
        id: outbox.id,
        leadId: outbox.leadId,
        payload: outbox.payload,
        sentAt: outbox.sentAt,
      })
      .from(outbox)
      .where(
        and(
          eq(outbox.status, "sent"),
          gte(outbox.sentAt, POST_DEPLOY_CUTOFF),
          like(outbox.payload, "%SMS%")
        )
      )
      .orderBy(outbox.sentAt)
      .limit(5);

    // For each SMS sent, check if the corresponding decision had a split marker
    for (const smsRow of smsRows) {
      const relatedDecision = await db
        .select({
          id: decisionLog.id,
          brainReasoning: decisionLog.brainReasoning,
          outputGuardResult: decisionLog.outputGuardResult,
          createdAt: decisionLog.createdAt,
        })
        .from(decisionLog)
        .where(
          and(
            eq(decisionLog.outboxId, Number(smsRow.id)),
            like(decisionLog.outputGuardResult, "%pass%")
          )
        )
        .limit(1);

      if (relatedDecision.length > 0 && relatedDecision[0].brainReasoning?.includes("\n---\n")) {
        v6Captured = true;
        console.log(`\n${"=".repeat(80)}`);
        console.log(`[PR3-VERIFY] ✅ VERIFICATION 6 CAPTURED — SMS Split`);
        console.log(`${"=".repeat(80)}`);
        console.log(`[PR3-VERIFY] Outbox row: ${smsRow.id} | Lead: ${smsRow.leadId} | Sent: ${smsRow.sentAt}`);
        console.log(`[PR3-VERIFY] Decision: id=${relatedDecision[0].id} | guard=${relatedDecision[0].outputGuardResult}`);
        console.log(`[PR3-VERIFY] Brain message with separator:`);
        console.log(String(relatedDecision[0].brainReasoning || "").slice(0, 1500));
        console.log(`${"=".repeat(80)}\n`);
        checkDone();
        return;
      }
    }
    return;
  }

  const d = decisions[0];
  v6Captured = true;
  console.log(`\n${"=".repeat(80)}`);
  console.log(`[PR3-VERIFY] ✅ VERIFICATION 6 CAPTURED — SMS Split`);
  console.log(`${"=".repeat(80)}`);
  console.log(`[PR3-VERIFY] Decision: id=${d.id} | Lead: ${d.leadId} | Channel: ${d.channel}`);
  console.log(`[PR3-VERIFY] Outbox: ${d.outboxId} | Guard: ${d.outputGuardResult} | At: ${d.createdAt}`);
  console.log(`[PR3-VERIFY] Brain message with separator:`);
  console.log(String(d.brainReasoning || "").slice(0, 1500));
  console.log(`${"=".repeat(80)}\n`);

  checkDone();
}

function checkDone(): void {
  if (v5Captured && v6Captured) {
    console.log(`[PR3-VERIFY] 🎉 Both verifications captured. Monitor self-disabling.`);
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }
}

async function pollOnce(): Promise<void> {
  try {
    await checkVerification5();
    await checkVerification6();
    if (!v5Captured || !v6Captured) {
      const pending = [];
      if (!v5Captured) pending.push("V5:Email-HTML");
      if (!v6Captured) pending.push("V6:SMS-Split");
      console.log(`[PR3-VERIFY] Poll cycle — still waiting for: ${pending.join(", ")}`);
    }
  } catch (err) {
    console.error(`[PR3-VERIFY] Poll error:`, err);
  }
}

export function startPR3Monitor(): void {
  console.log(`[PR3-VERIFY] Monitor started — polling every ${POLL_INTERVAL_MS / 60000} min for post-deploy evidence`);
  console.log(`[PR3-VERIFY] Cutoff: ${POST_DEPLOY_CUTOFF.toISOString()} | Watching: V5 (Email HTML), V6 (SMS Split)`);
  
  // First poll after 30 seconds (let server stabilize)
  setTimeout(pollOnce, 30_000);
  
  // Then every 5 minutes
  intervalHandle = setInterval(pollOnce, POLL_INTERVAL_MS);
}
