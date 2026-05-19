/**
 * Cold reactivation leads query + Vanessa Davis check
 */
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// All leads with follow-up due in next 4 hours (not under human takeover)
const [leads] = await conn.execute(`
  SELECT id, name, ghlContactId,
    DATE_FORMAT(nextFollowUpAt, '%Y-%m-%d %H:%i:%s') as nextFollowUp,
    preferredChannel, pipelineStage, cadencePosition, reactivationCount,
    DATE_FORMAT(lastMessageAt, '%Y-%m-%d %H:%i:%s') as lastMessage
  FROM leads
  WHERE nextFollowUpAt BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 4 HOUR)
    AND humanTakeover = 0
  ORDER BY nextFollowUpAt
`);
console.log("=== LEADS WITH FOLLOW-UP IN NEXT 4H ===");
console.log("Count:", leads.length);
if (leads.length > 0) console.log(JSON.stringify(leads, null, 2));

// Vanessa Davis specifically
const [vanessa] = await conn.execute(`
  SELECT id, name,
    DATE_FORMAT(nextFollowUpAt, '%Y-%m-%d %H:%i:%s') as nextFollowUp,
    pipelineStage, cadencePosition, reactivationCount, humanTakeover,
    DATE_FORMAT(lastMessageAt, '%Y-%m-%d %H:%i:%s') as lastMessage
  FROM leads
  WHERE name LIKE '%Vanessa%Davis%'
`);
console.log("\n=== VANESSA DAVIS ===");
console.log(JSON.stringify(vanessa, null, 2));

await conn.end();
