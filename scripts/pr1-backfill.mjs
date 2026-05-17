/**
 * PR#1 Part C+D: Backfill dead-contact leads and run sweep query
 * Uses raw mysql2 with proper JS Date objects
 */
import mysql from "mysql2/promise";

const db = await mysql.createConnection(process.env.DATABASE_URL);

// Part C: Mark known dead-contact leads as not_qualified
console.log("=== Part C: Backfill dead-contact leads ===");
const farFuture = new Date("2099-01-01T00:00:00.000Z");
const [updateResult] = await db.query(
  "UPDATE leads SET pipelineStage = ?, nextFollowUpAt = ? WHERE id IN (3570002, 3000008)",
  ["not_qualified", farFuture]
);
console.log("Rows updated:", updateResult.affectedRows);

// Verify
const [rows] = await db.query(
  "SELECT id, name, pipelineStage, nextFollowUpAt FROM leads WHERE id IN (3570002, 3000008)"
);
console.log("Verification:", JSON.stringify(rows, null, 2));

// Part D: Sweep query — how many leads have 400 errors in decision_log
console.log("\n=== Part D: Sweep query ===");
const [sweepCount] = await db.query(
  `SELECT COUNT(DISTINCT leadId) as affected_leads
   FROM decision_log
   WHERE outputGuardResult LIKE 'error:%400%'
      OR outputGuardResult LIKE 'error:%Contact not found%'`
);
console.log("Leads with 400 errors in decision_log:", JSON.stringify(sweepCount, null, 2));

const [sweepSample] = await db.query(
  `SELECT dl.leadId, l.name, l.pipelineStage, dl.outputGuardResult, dl.createdAt
   FROM decision_log dl
   JOIN leads l ON l.id = dl.leadId
   WHERE dl.outputGuardResult LIKE 'error:%400%'
      OR dl.outputGuardResult LIKE 'error:%Contact not found%'
   ORDER BY dl.createdAt DESC
   LIMIT 10`
);
console.log("Sample rows:", JSON.stringify(sweepSample, null, 2));

await db.end();
