import mysql from "mysql2/promise";
import axios from "axios";
const GHL_API_KEY = process.env.GHL_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

const conn = await mysql.createConnection(DATABASE_URL);

// Show a sample of what attribution data looks like in researchData
const [sample] = await conn.execute(
  "SELECT ghlContactId, name, researchData FROM leads WHERE source='transferred_contact' AND ghlContactId IS NOT NULL LIMIT 5"
);

for (const row of sample) {
  let rd = {};
  try { rd = typeof row.researchData === "string" ? JSON.parse(row.researchData) : (row.researchData || {}); } catch {}
  const tc = rd.transferredContact || {};
  console.log(`\n=== ${row.name} (${row.ghlContactId}) ===`);
  console.log("attribution:", JSON.stringify(tc.attribution, null, 2));
  console.log("originalSource:", tc.originalSource);
  console.log("ghlTags:", tc.ghlTags);
  console.log("ghlCustomFields keys:", Object.keys(tc.ghlCustomFields || {}));
}

// Test the GHL contact API to see all available fields including attributionSource
const contactId = sample[0].ghlContactId;
console.log("\n\n=== GHL API test for:", sample[0].name, "===");

try {
  const r = await axios.get(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: "2021-07-28" },
    timeout: 10000
  });
  const c = r.data.contact;
  console.log("All contact keys:", Object.keys(c).join(", "));
  console.log("attributionSource:", JSON.stringify(c.attributionSource, null, 2));
  console.log("source:", c.source);
  console.log("tags:", c.tags);
  console.log("customFields count:", (c.customFields || []).length);
  if ((c.customFields || []).length > 0) {
    console.log("customFields sample:", JSON.stringify(c.customFields.slice(0, 3), null, 2));
  }
} catch (e) {
  console.log("Contact API error:", e.response?.status, JSON.stringify(e.response?.data));
}

// Test activity endpoint
console.log("\n=== Testing activity endpoint ===");
try {
  const r = await axios.get(`https://services.leadconnectorhq.com/contacts/${contactId}/activity`, {
    headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: "2021-07-28" },
    timeout: 10000
  });
  console.log("Activity status:", r.status);
  console.log("Activity data:", JSON.stringify(r.data, null, 2).substring(0, 1000));
} catch (e) {
  console.log("Activity endpoint:", e.response?.status, JSON.stringify(e.response?.data));
}

await conn.end();
