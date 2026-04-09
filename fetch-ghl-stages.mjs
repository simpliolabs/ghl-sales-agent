import axios from "axios";
import dotenv from "dotenv";
import { readFileSync } from "fs";

// Load env from .env file
dotenv.config();

const GHL_BASE = "https://services.leadconnectorhq.com";
const API_KEY = process.env.GHL_API_KEY;
const LOCATION_ID = process.env.GHL_LOCATION_ID;

if (!API_KEY || !LOCATION_ID) {
  console.error("Missing GHL_API_KEY or GHL_LOCATION_ID");
  process.exit(1);
}

const client = axios.create({
  baseURL: GHL_BASE,
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    Version: "2021-04-15",
    "Content-Type": "application/json",
  },
});

async function main() {
  console.log("Fetching GHL pipelines...\n");
  const { data } = await client.get("/opportunities/pipelines", {
    params: { locationId: LOCATION_ID },
  });

  const pipelines = data.pipelines || [];
  console.log(`Found ${pipelines.length} pipelines:\n`);

  for (const pipeline of pipelines) {
    console.log(`═══════════════════════════════════════════════════`);
    console.log(`Pipeline: ${pipeline.name}`);
    console.log(`ID: ${pipeline.id}`);
    console.log(`Stages:`);
    for (const stage of (pipeline.stages || [])) {
      console.log(`  - "${stage.name}" → ${stage.id}`);
    }
    console.log();
  }
}

main().catch(err => {
  console.error("Error:", err.response?.data || err.message);
  process.exit(1);
});
