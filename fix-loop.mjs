import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Put Eva back in humanTakeover - her circuit breaker is legitimate
await conn.execute(`UPDATE leads SET humanTakeover = 1 WHERE id = 450001`);
console.log("Eva (450001) restored to humanTakeover=1");

// Find all leads that are in the same loop: humanTakeover=0 but have 3+ consecutive circuit breaker entries in last 2 hours
const [loopLeads] = await conn.execute(`
  SELECT l.id, l.name, COUNT(*) as cbCount
  FROM leads l
  JOIN brain_council_audit bca ON bca.leadId = l.id
  WHERE l.humanTakeover = 0
    AND bca.blocked = 1
    AND bca.violationCategory = 'safety_violation'
    AND bca.blockReason LIKE '%Circuit breaker%'
    AND bca.createdAt > DATE_SUB(NOW(), INTERVAL 2 HOUR)
  GROUP BY l.id, l.name
  HAVING cbCount >= 2
  ORDER BY cbCount DESC
`);
console.log("\nLeads stuck in circuit breaker loop (2+ CB fires in last 2h):");
for (const l of loopLeads) {
  console.log(`  Lead #${l.id} ${l.name}: ${l.cbCount} circuit breaker fires`);
}

// Also check how many total notifications were sent today
const [notifCount] = await conn.execute(`
  SELECT COUNT(*) as cnt FROM brain_council_audit
  WHERE blocked = 1
    AND createdAt > DATE_SUB(NOW(), INTERVAL 24 HOUR)
`);
console.log(`\nTotal blocked audit entries in last 24h: ${notifCount[0].cnt}`);

await conn.end();
