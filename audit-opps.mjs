import axios from "axios";
import mysql from "mysql2/promise";

const GHL_BASE = "https://services.leadconnectorhq.com";
const locationId = process.env.GHL_LOCATION_ID;
const apiKey = process.env.GHL_API_KEY;
const dbUrl = process.env.DATABASE_URL;

console.log("Location ID:", locationId ? locationId.substring(0,8)+"..." : "MISSING");
console.log("API Key:", apiKey ? "SET" : "MISSING");

const client = axios.create({
  baseURL: GHL_BASE,
  headers: {
    Authorization: `Bearer ${apiKey}`,
    Version: "2021-04-15",
    "Content-Type": "application/json",
  },
});

// Test Bulk Printing Pipeline sample
const bulkPipelineId = "OpojlMx3cTa0ts0e2pMc";
try {
  const { data } = await client.get("/opportunities/search", {
    params: { locationId, pipelineId: bulkPipelineId, limit: 2 },
  });
  console.log("\n=== Bulk Printing Pipeline Sample ===");
  console.log("Total:", data.meta?.total);
  const sample = data.opportunities?.[0];
  if (sample) {
    console.log("Keys:", Object.keys(sample).join(", "));
    console.log("contact.id:", sample.contact?.id);
    console.log("contact.name:", sample.contact?.name);
    console.log("pipelineStageId:", sample.pipelineStageId);
    console.log("pipelineId:", sample.pipelineId);
    console.log("status:", sample.status);
    console.log("monetaryValue:", sample.monetaryValue);
    console.log("assignedTo:", sample.assignedTo);
    console.log("name:", sample.name);
  }
} catch(e) {
  console.error("Bulk pipeline error:", e.response?.data || e.message);
}

// Count all pipelines
const pipelines = [
  { id: "OpojlMx3cTa0ts0e2pMc", name: "Bulk Printing Pipeline" },
  { id: "5YIrCvKmzb27yXHP3fBF", name: "100 T-shirt Inquiry" },
  { id: "FgRa75sGUcw5lh0kPAwH", name: "100 T-shirt Printing" },
  { id: "sOJmH5op75E4HgXpTonU", name: "Follow Up Pipeline" },
  { id: "DywhWMjMSu4VpCez1QPd", name: "Marketing Pipeline" },
  { id: "xyRhqslao3CnMQHJxLoy", name: "New pipeline" },
];
console.log("\n=== OPPORTUNITY COUNTS BY PIPELINE ===");
let grandTotal = 0;
for (const p of pipelines) {
  try {
    const { data } = await client.get("/opportunities/search", {
      params: { locationId, pipelineId: p.id, limit: 1 },
    });
    const total = data.meta?.total ?? "?";
    grandTotal += (typeof total === "number" ? total : 0);
    console.log(`  ${p.name}: ${total}`);
  } catch(e) {
    console.log(`  ${p.name}: ERROR - ${e.response?.data?.message || e.message}`);
  }
}
console.log(`  GRAND TOTAL: ${grandTotal}`);

// Check local DB
console.log("\n=== LOCAL DB ===");
const conn = await mysql.createConnection(dbUrl);
const [rows] = await conn.query("SELECT COUNT(*) as cnt FROM leads");
console.log("Local leads count:", rows[0].cnt);
const [stageRows] = await conn.query("SELECT pipelineStage, COUNT(*) as cnt FROM leads GROUP BY pipelineStage ORDER BY cnt DESC");
console.log("By stage:");
for (const r of stageRows) console.log(`  ${r.pipelineStage || 'null'}: ${r.cnt}`);

// Check columns in DB
const [cols] = await conn.query("SHOW COLUMNS FROM leads");
console.log("\n=== LEADS TABLE COLUMNS ===");
for (const c of cols) console.log(`  ${c.Field} (${c.Type})`);

await conn.end();
