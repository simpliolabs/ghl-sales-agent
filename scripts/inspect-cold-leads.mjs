import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

const [rows] = await conn.execute(`
  SELECT id, name,
    DATE_FORMAT(nextFollowUpAt, '%Y-%m-%d %H:%i:%s') as nextFollowUp,
    reactivationCount, cadencePosition, preferredChannel, pipelineStage,
    DATE_FORMAT(lastMessageAt, '%Y-%m-%d %H:%i:%s') as lastMessage
  FROM leads
  WHERE nextFollowUpAt BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 4 HOUR)
    AND humanTakeover = 0
    AND reactivationCount > 0
  ORDER BY nextFollowUpAt
`);

console.log(`Count: ${rows.length}`);
for (const r of rows) {
  console.log(`id=${r.id} | ${r.name || "(no name)"} | nextFollowUp=${r.nextFollowUp} | stage=${r.pipelineStage} | cadence=${r.cadencePosition} | reactivations=${r.reactivationCount} | channel=${r.preferredChannel} | lastMsg=${r.lastMessage || "null"}`);
}

await conn.end();
