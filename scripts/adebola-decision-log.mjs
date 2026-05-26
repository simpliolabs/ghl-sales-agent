import mysql from "../node_modules/mysql2/promise/index.js";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Step 1: Get all decision_log rows for Adebola in the May 18 13:50-13:55 window
const [rows] = await conn.query(`
  SELECT id,
    DATE_FORMAT(createdAt, '%H:%i:%s') as ts,
    decisionType,
    triggerSource,
    outputGuardResult,
    blockReason,
    SUBSTRING(promptContext, 1, 500) as promptContextSnippet
  FROM decision_log
  WHERE leadId = 4860035
    AND createdAt BETWEEN '2026-05-18 13:50:00' AND '2026-05-18 13:56:00'
  ORDER BY createdAt
`);

console.log("=== Adebola decision_log May 18 13:50-13:56 ===");
if (rows.length === 0) {
  console.log("No rows found in this window");
} else {
  for (const r of rows) {
    console.log(`id=${r.id} | ts=${r.ts} | decisionType=${r.decisionType} | triggerSource=${r.triggerSource} | guard=${r.outputGuardResult} | blockReason=${r.blockReason}`);
    if (r.promptContextSnippet) {
      console.log(`  promptContext snippet: ${r.promptContextSnippet.substring(0, 200)}`);
    }
  }
}

// Step 2: Also check outbox rows for Adebola in the same window to see source field
const [outboxRows] = await conn.query(`
  SELECT id,
    DATE_FORMAT(createdAt, '%H:%i:%s') as ts,
    source,
    outbox_status,
    idemKey,
    err
  FROM outbox
  WHERE leadId = 4860035
    AND createdAt BETWEEN '2026-05-18 13:50:00' AND '2026-05-18 13:56:00'
  ORDER BY createdAt
`);

console.log("\n=== Adebola outbox rows May 18 13:50-13:56 ===");
if (outboxRows.length === 0) {
  console.log("No outbox rows in this window");
} else {
  for (const r of outboxRows) {
    console.log(`id=${r.id} | ts=${r.ts} | source=${r.source} | status=${r.outbox_status} | idemKey=${r.idemKey} | err=${r.err}`);
  }
}

// Step 3: Check conversations for Adebola in the same window
const [convRows] = await conn.query(`
  SELECT id,
    DATE_FORMAT(createdAt, '%H:%i:%s') as ts,
    direction,
    senderType,
    ghlMessageId,
    SUBSTRING(body, 1, 150) as bodySnippet
  FROM conversations
  WHERE leadId = 4860035
    AND createdAt BETWEEN '2026-05-18 13:50:00' AND '2026-05-18 13:56:00'
  ORDER BY createdAt
`);

console.log("\n=== Adebola conversations May 18 13:50-13:56 ===");
if (convRows.length === 0) {
  console.log("No conversation rows in this window");
} else {
  for (const r of convRows) {
    console.log(`id=${r.id} | ts=${r.ts} | dir=${r.direction} | sender=${r.senderType} | ghlMsgId=${r.ghlMessageId} | body: ${r.bodySnippet}`);
  }
}

await conn.end();
