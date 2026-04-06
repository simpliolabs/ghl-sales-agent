import { createConnection } from "mysql2/promise";

const url = new URL(process.env.DATABASE_URL);
const conn = await createConnection({
  host: url.hostname,
  port: parseInt(url.port),
  user: url.username,
  password: url.password,
  database: url.pathname.slice(1),
  ssl: { rejectUnauthorized: false },
});

// Find Linda Harvey-Williams
const [leads] = await conn.execute(
  "SELECT id, name, ghlContactId, pipelineStage, lastMessageAt, nextFollowUpAt FROM leads WHERE name LIKE '%Linda%' AND name LIKE '%Harvey%' OR name LIKE '%Harvey%Williams%'"
);
console.log("=== LEAD RECORD ===");
console.table(leads);

if (leads.length > 0) {
  const leadId = leads[0].id;
  
  // Brain Council audit
  const [audit] = await conn.execute(
    "SELECT id, createdAt, strategyApproach, composedMessage, messageSent, violationCategory, blocked, blockReason FROM brain_council_audit WHERE leadId = ? ORDER BY createdAt DESC LIMIT 10",
    [leadId]
  );
  console.log("\n=== BRAIN COUNCIL AUDIT (last 10) ===");
  console.table(audit);

  // Conversations
  const [convs] = await conn.execute(
    "SELECT id, timestamp, direction, channel, messageBody, senderType FROM conversations WHERE leadId = ? ORDER BY timestamp DESC LIMIT 15",
    [leadId]
  );
  console.log("\n=== CONVERSATIONS (last 15) ===");
  console.table(convs);

  // Check webhook_log table
  const [wlCols] = await conn.execute("SHOW TABLES LIKE '%webhook%'");
  console.log("\n=== WEBHOOK TABLES ===");
  console.table(wlCols);
}

await conn.end();
