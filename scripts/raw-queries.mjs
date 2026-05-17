import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// QUERY 1: prompt_versions — abTrafficPercent
console.log("\n=== QUERY 1: prompt_versions ===");
const [q1] = await conn.query(
  "SELECT id, version, abTrafficPercent, isActive, createdAt FROM prompt_versions ORDER BY createdAt DESC LIMIT 10"
);
console.log(JSON.stringify(q1, null, 2));

// QUERY 2: decision_log columns
console.log("\n=== decision_log schema ===");
const [dlCols] = await conn.query("DESCRIBE decision_log");
console.log(JSON.stringify(dlCols.map(c => c.Field), null, 2));

// QUERY 3: Last 20 decision_log rows
console.log("\n=== QUERY 2: Last 20 decision_log rows ===");
const [q2] = await conn.query(
  "SELECT * FROM decision_log ORDER BY createdAt DESC LIMIT 20"
);
console.log(JSON.stringify(q2, null, 2));

// QUERY 4: Find Bill Noke
console.log("\n=== QUERY 3: Bill Noke lead ===");
const [billRows] = await conn.query(
  "SELECT id, name, ghlContactId, preferredChannel FROM leads WHERE name LIKE '%Noke%' LIMIT 5"
);
console.log(JSON.stringify(billRows, null, 2));

if (billRows.length > 0) {
  const leadId = billRows[0].id;

  console.log(`\n=== QUERY 4: outbox rows for leadId=${leadId} ===`);
  const [q4] = await conn.query(
    "SELECT * FROM outbox WHERE leadId = ? ORDER BY createdAt DESC LIMIT 20",
    [leadId]
  );
  console.log(JSON.stringify(q4, null, 2));

  console.log(`\n=== QUERY 5: decision_log for leadId=${leadId} ===`);
  const [q5] = await conn.query(
    "SELECT * FROM decision_log WHERE leadId = ? ORDER BY createdAt DESC LIMIT 20",
    [leadId]
  );
  console.log(JSON.stringify(q5, null, 2));
} else {
  // Try searching by conversation content
  console.log("\nBill Noke not found by name. Searching conversations...");
  const [convRows] = await conn.query(
    "SELECT DISTINCT leadId FROM conversations WHERE messageBody LIKE '%River of God%' OR messageBody LIKE '%Cr recovery%' LIMIT 5"
  );
  console.log(JSON.stringify(convRows, null, 2));
}

await conn.end();
