import { getDb } from "./server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  // Step 1: Confirm webhook_logs columns
  const cols = await db.execute(sql`SHOW COLUMNS FROM webhook_logs`);
  console.log("=== webhook_logs columns ===");
  console.log(JSON.stringify(cols[0], null, 2));

  // Step 2: Check if there's a raw payload column or separate raw table
  const rawTables = await db.execute(sql`
    SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME LIKE '%payload%' OR TABLE_NAME LIKE '%raw%' OR TABLE_NAME LIKE '%event%'
  `);
  console.log("\n=== Tables with payload/raw/event in name ===");
  console.log(JSON.stringify(rawTables[0], null, 2));

  // Step 3: Sample the payloadSummary from recent error rows
  const errorRows = await db.execute(sql`
    SELECT id, eventType, detectedType, payloadSummary, error, receivedAt
    FROM webhook_logs
    WHERE error LIKE '%substring%'
    ORDER BY receivedAt DESC
    LIMIT 10
  `);
  console.log("\n=== Recent substring error rows (payloadSummary) ===");
  console.log(JSON.stringify(errorRows[0], null, 2));

  // Step 4: Sample noteBody.trim error rows
  const noteErrorRows = await db.execute(sql`
    SELECT id, eventType, detectedType, payloadSummary, error, receivedAt
    FROM webhook_logs
    WHERE error LIKE '%trim%'
    ORDER BY receivedAt DESC
    LIMIT 5
  `);
  console.log("\n=== Recent noteBody.trim error rows ===");
  console.log(JSON.stringify(noteErrorRows[0], null, 2));

  // Step 5: Sample successful message rows to see what payloadSummary looks like when it works
  const successRows = await db.execute(sql`
    SELECT id, eventType, detectedType, payloadSummary, action, receivedAt
    FROM webhook_logs
    WHERE detectedType = 'message'
    AND error IS NULL
    AND payloadSummary IS NOT NULL
    ORDER BY receivedAt DESC
    LIMIT 5
  `);
  console.log("\n=== Successful message rows (payloadSummary for comparison) ===");
  console.log(JSON.stringify(successRows[0], null, 2));

  // Step 6: Sample successful note rows
  const successNoteRows = await db.execute(sql`
    SELECT id, eventType, detectedType, payloadSummary, action, receivedAt
    FROM webhook_logs
    WHERE detectedType = 'note'
    AND error IS NULL
    AND payloadSummary IS NOT NULL
    ORDER BY receivedAt DESC
    LIMIT 5
  `);
  console.log("\n=== Successful note rows (payloadSummary for comparison) ===");
  console.log(JSON.stringify(successNoteRows[0], null, 2));

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
