import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Breakdown by violation category
const [cats] = await conn.execute(`
  SELECT violationCategory, COUNT(*) as cnt, 
         GROUP_CONCAT(DISTINCT l.name ORDER BY l.name SEPARATOR ', ') as leads
  FROM brain_council_audit bca
  JOIN leads l ON l.id = bca.leadId
  WHERE bca.blocked = 1
    AND bca.createdAt > DATE_SUB(NOW(), INTERVAL 24 HOUR)
  GROUP BY violationCategory
  ORDER BY cnt DESC
`);
console.log("Blocked entries by category (last 24h):");
for (const c of cats) {
  console.log(`  ${c.violationCategory}: ${c.cnt} — ${c.leads?.substring(0, 100)}`);
}

// Check how many notifications were sent (owner notified)
const [notifs] = await conn.execute(`
  SELECT violationCategory, COUNT(*) as cnt
  FROM brain_council_audit bca
  WHERE bca.blocked = 1
    AND bca.createdAt > DATE_SUB(NOW(), INTERVAL 24 HOUR)
  GROUP BY violationCategory
`);

// Check the notification code to see how it decides when to notify
console.log("\nTotal blocks today:", notifs.reduce((s, n) => s + n.cnt, 0));

// Check if circuit breaker is the main source of notification spam
const [cbOnly] = await conn.execute(`
  SELECT l.id, l.name, COUNT(*) as cnt
  FROM brain_council_audit bca
  JOIN leads l ON l.id = bca.leadId
  WHERE bca.blocked = 1
    AND bca.violationCategory = 'safety_violation'
    AND bca.blockReason LIKE '%Circuit breaker%'
    AND bca.createdAt > DATE_SUB(NOW(), INTERVAL 24 HOUR)
  GROUP BY l.id, l.name
  ORDER BY cnt DESC
`);
console.log("\nCircuit breaker fires by lead (last 24h):");
for (const l of cbOnly) {
  console.log(`  Lead #${l.id} ${l.name}: ${l.cnt} fires`);
}

await conn.end();
