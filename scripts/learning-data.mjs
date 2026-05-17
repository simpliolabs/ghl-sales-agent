import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

console.log("\n=== QUERY 1: learnings WHERE promotedToPrompt = 1 ORDER BY positiveOutcomes DESC ===");
const [q1] = await conn.query(
  "SELECT * FROM learnings WHERE promotedToPrompt = 1 ORDER BY positiveOutcomes DESC LIMIT 15"
);
console.log(JSON.stringify(q1, null, 2));

console.log("\n=== QUERY 2: segment_weights ORDER BY wins DESC ===");
const [q2] = await conn.query(
  "SELECT * FROM segment_weights ORDER BY wins DESC LIMIT 19"
);
console.log(JSON.stringify(q2, null, 2));

await conn.end();
