import 'dotenv/config';
import mysql from 'mysql2/promise';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("No DATABASE_URL"); process.exit(1); }

const conn = await mysql.createConnection(DATABASE_URL);

// Find Garvey Mclean
const [leads] = await conn.execute(
  "SELECT * FROM leads WHERE name LIKE '%Garvey%' OR name LIKE '%Mclean%' OR name LIKE '%McLean%'"
);
console.log("=== GARVEY MCLEAN LEAD RECORD ===");
for (const l of leads) {
  console.log(JSON.stringify(l, null, 2));
}

if (leads.length > 0) {
  const leadId = leads[0].id;
  
  // Get all conversations for this lead
  const [convos] = await conn.execute(
    "SELECT * FROM conversations WHERE leadId = ? ORDER BY timestamp ASC",
    [leadId]
  );
  console.log(`\n=== CONVERSATIONS (${convos.length} messages) ===`);
  for (const c of convos) {
    console.log(`[${c.timestamp}] ${c.senderType}/${c.direction}/${c.channel}: ${(c.messageBody || '').substring(0, 120)}`);
  }

  // Get AI state
  const [aiState] = await conn.execute(
    "SELECT * FROM ai_state WHERE leadId = ?",
    [leadId]
  );
  console.log("\n=== AI STATE ===");
  for (const a of aiState) {
    console.log(JSON.stringify(a, null, 2));
  }
}

// Also check lead #1620
console.log("\n\n=== LEAD #1620 ===");
const [lead1620] = await conn.execute("SELECT * FROM leads WHERE id = 1620");
for (const l of lead1620) {
  console.log(JSON.stringify(l, null, 2));
}

if (lead1620.length > 0) {
  const [convos1620] = await conn.execute(
    "SELECT * FROM conversations WHERE leadId = 1620 ORDER BY timestamp ASC"
  );
  console.log(`\n=== LEAD #1620 CONVERSATIONS (${convos1620.length} messages) ===`);
  for (const c of convos1620) {
    console.log(`[${c.timestamp}] ${c.senderType}/${c.direction}/${c.channel}: ${(c.messageBody || '').substring(0, 200)}`);
  }
  
  const [aiState1620] = await conn.execute(
    "SELECT * FROM ai_state WHERE leadId = 1620"
  );
  console.log("\n=== LEAD #1620 AI STATE ===");
  for (const a of aiState1620) {
    console.log(JSON.stringify(a, null, 2));
  }
}

await conn.end();
