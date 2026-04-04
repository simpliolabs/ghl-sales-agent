import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Get lead #1449
const [leads] = await conn.execute("SELECT * FROM leads WHERE id = 1449");
console.log("=== LEAD #1449 ===");
console.log(JSON.stringify(leads[0], null, 2));

// Get conversation history
const [convs] = await conn.execute(
  "SELECT id, channel, direction, messageBody, senderType, senderName, ghlMessageId, timestamp FROM conversations WHERE leadId = 1449 ORDER BY timestamp ASC"
);
console.log("\n=== CONVERSATION HISTORY ===");
console.log(`Total messages: ${convs.length}`);
convs.forEach((c, i) => {
  console.log(`\n--- Message ${i + 1} ---`);
  console.log(`Time: ${c.timestamp}`);
  console.log(`Direction: ${c.direction} | Sender: ${c.senderType} (${c.senderName || "N/A"}) | Channel: ${c.channel}`);
  console.log(`Body: ${(c.messageBody || "").substring(0, 200)}`);
});

// Get AI state
const [aiState] = await conn.execute("SELECT * FROM ai_state WHERE leadId = 1449");
console.log("\n=== AI STATE ===");
console.log(JSON.stringify(aiState[0] || "No AI state", null, 2));

// Get pipeline events
const [events] = await conn.execute("SELECT * FROM pipeline_events WHERE leadId = 1449 ORDER BY timestamp ASC");
console.log("\n=== PIPELINE EVENTS ===");
events.forEach(e => console.log(`${e.timestamp}: ${e.fromStage} → ${e.toStage} (${e.triggeredBy})`));

await conn.end();
