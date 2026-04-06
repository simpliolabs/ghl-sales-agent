/**
 * sync-opportunities.mjs
 * Pulls all GHL opportunities and syncs them into the local leads table.
 * Uses batch DB operations for speed.
 */
import axios from "axios";
import mysql from "mysql2/promise";
import { ENV } from "./server/_core/env.ts";

const GHL_BASE = "https://services.leadconnectorhq.com";
const locationId = ENV.ghlLocationId;
const apiKey = ENV.ghlApiKey;
const dbUrl = ENV.databaseUrl;

const client = axios.create({
  baseURL: GHL_BASE,
  headers: { Authorization: `Bearer ${apiKey}`, Version: "2021-04-15", "Content-Type": "application/json" },
  timeout: 15000,
});

// Stage ID → normalized stage name
const STAGE_MAP = {
  "69534612-6905-413a-a3b9-3c3de2365a6a": "new_lead",
  "6dbcb373-9832-4c45-a5e6-176f92685f67": "contacted",
  "dee13ae5-1db8-45aa-9f4a-33a6b271cb94": "qualified",
  "d5ed2202-ffcc-4706-8cdc-5d7afba05ffd": "quote_sent",
  "32f1463d-1f48-4bef-8cd9-f1ff797d7907": "paid_proof_needed",
  "15207cd9-625c-4e69-bfe2-5abcad656f06": "proof_sent",
  "a285af5e-3e5f-4b25-925a-baa0fe98c9e7": "approved",
  "8922982e-eb03-47fa-96e2-200c1fa0a3a7": "in_production",
  "076697f1-a054-4f82-a795-f0f38a4a56f7": "ready",
  "117d9332-7654-42bc-92de-829ae3be6337": "delivered",
  "6f1ca442-4a6b-490f-bf49-95a5870f7f86": "not_qualified",
  "a54400ac-e9df-44e2-8872-45ccccf9a442": "new_lead",
  "6501f3bf-b2a9-4c0f-935f-fc8441f6deb0": "contacted",
  "45c2fc05-fe5f-4427-9523-f0f8ae000a39": "qualified",
  "ea2093b5-3d71-4b00-aa3f-bcfda3d43012": "quote_sent",
  "01d5adc5-1ec5-4c9d-bee9-ca992b598cd5": "quote_sent",
  "1ff090fe-8f51-45ea-898e-53f8fe94836e": "paid_proof_needed",
  "83137df0-bfc3-4b71-96aa-3ee3d0ba4eee": "proof_sent",
  "7c74ae56-5803-4df6-9a03-042467c5a350": "approved",
  "2bd9c631-6914-413c-b228-bc2125ae35bd": "in_production",
  "58b73824-41a3-45f1-bef5-6cb67303cecd": "delivered",
  "6ca358e4-db09-4818-9896-ab21bad0c0e7": "not_qualified",
  "305eab1c-7e93-4fbc-b65b-0d3ae733c170": "new_lead",
  "c77cc672-e9df-4d9f-a4d9-518eda6979bf": "contacted",
  "5b1f61ce-7722-483e-81ba-7b2b65e5c0fe": "quote_sent",
  "084cafc6-e09b-4e09-87b5-467aa2993395": "delivered",
  "6f959956-f049-4847-b60a-37e568ce5877": "new_lead",
  "50ebf4df-0b37-4621-b9d8-1184ab8fbcef": "contacted",
  "bbdbf48c-245d-452e-a00d-9c88260dff0c": "contacted",
  "16b113e2-c766-453f-9b21-808f1254130e": "quote_sent",
  "799debb9-4d5b-48b6-857a-8f8d1363c2c6": "quote_sent",
  "42979115-da6e-4ed5-8475-1c35d29cea7e": "paid_proof_needed",
  "757ad143-8f4b-4b7e-bceb-23b9cc9fb46e": "delivered",
};

const PIPELINES = [
  { id: "OpojlMx3cTa0ts0e2pMc", name: "Bulk Printing Pipeline" },
  { id: "5YIrCvKmzb27yXHP3fBF", name: "100 T-shirt Inquiry" },
  { id: "FgRa75sGUcw5lh0kPAwH", name: "100 T-shirt Printing" },
  { id: "xyRhqslao3CnMQHJxLoy", name: "New pipeline" },
];

async function fetchAllOpportunities(pipelineId) {
  const all = [];
  let nextPageUrl = null;
  let page = 1;
  while (true) {
    let data;
    if (nextPageUrl) {
      // Use the full nextPageUrl directly
      const { data: d } = await client.get(nextPageUrl.replace('https://services.leadconnectorhq.com', ''));
      data = d;
    } else {
      const { data: d } = await client.get("/opportunities/search", {
        params: { location_id: locationId, pipeline_id: pipelineId, limit: 100 },
      });
      data = d;
    }
    const opps = data.opportunities || [];
    all.push(...opps);
    const total = data.meta?.total || 0;
    console.log(`  Page ${page}: fetched ${opps.length} (total so far: ${all.length}/${total})`);
    nextPageUrl = data.meta?.nextPageUrl || null;
    if (!nextPageUrl || opps.length === 0 || all.length >= total) break;
    page++;
  }
  return all;
}

const conn = await mysql.createConnection(dbUrl);

// Load all existing leads into a map (contactId → {id, pipelineStage})
console.log("Loading existing leads from DB...");
const [existing] = await conn.query("SELECT id, ghlContactId, pipelineStage FROM leads WHERE ghlContactId IS NOT NULL");
const existingMap = new Map();
for (const row of existing) existingMap.set(row.ghlContactId, row);
console.log(`Found ${existingMap.size} existing leads in DB`);

let totalProcessed = 0, totalUpdated = 0, totalCreated = 0, totalSkipped = 0;

for (const pipeline of PIPELINES) {
  console.log(`\nProcessing: ${pipeline.name}`);
  let opps;
  try {
    opps = await fetchAllOpportunities(pipeline.id);
  } catch (e) {
    console.error(`  Error: ${e.message}`);
    continue;
  }
  console.log(`  Total: ${opps.length}`);

  // Process in batches of 50
  for (let i = 0; i < opps.length; i += 50) {
    const batch = opps.slice(i, i + 50);
    const updatePromises = batch.map(async (opp) => {
      totalProcessed++;
      const contactId = opp.contact?.id;
      if (!contactId) { totalSkipped++; return; }

      const normalizedStage = STAGE_MAP[opp.pipelineStageId] || "new_lead";
      const monetaryValue = opp.monetaryValue ? Math.round(Number(opp.monetaryValue)) : 0;

      if (existingMap.has(contactId)) {
        await conn.query(
          `UPDATE leads SET ghlOpportunityId=?, ghlPipelineId=?, ghlStageId=?, opportunityStatus=?, opportunityName=?, pipelineStage=?, pipelineValue=?, updatedAt=NOW() WHERE ghlContactId=?`,
          [opp.id, pipeline.id, opp.pipelineStageId, opp.status || "open", opp.name || null, normalizedStage, monetaryValue, contactId]
        );
        totalUpdated++;
      } else {
        await conn.query(
          `INSERT INTO leads (ghlContactId, ghlOpportunityId, ghlPipelineId, ghlStageId, opportunityStatus, opportunityName, name, email, phone, pipelineStage, pipelineValue, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
          [contactId, opp.id, pipeline.id, opp.pipelineStageId, opp.status || "open", opp.name || null, opp.contact?.name || null, opp.contact?.email || null, opp.contact?.phone || null, normalizedStage, monetaryValue]
        );
        existingMap.set(contactId, { id: null, pipelineStage: normalizedStage });
        totalCreated++;
      }
    });
    await Promise.all(updatePromises);
    console.log(`  Processed ${Math.min(i + 50, opps.length)}/${opps.length}...`);
  }
}

await conn.end();

console.log(`\n=== SYNC COMPLETE ===`);
console.log(`Total processed: ${totalProcessed}`);
console.log(`Updated: ${totalUpdated}`);
console.log(`Created (new): ${totalCreated}`);
console.log(`Skipped (no contactId): ${totalSkipped}`);
