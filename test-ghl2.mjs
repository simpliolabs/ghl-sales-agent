import { ENV } from "./server/_core/env.ts";
import axios from "axios";

const client = axios.create({
  baseURL: "https://services.leadconnectorhq.com",
  headers: { Authorization: `Bearer ${ENV.ghlApiKey}`, Version: "2021-04-15" },
  timeout: 10000,
});

console.log("Fetching...");
const { data } = await client.get("/opportunities/search", {
  params: { location_id: ENV.ghlLocationId, pipeline_id: "OpojlMx3cTa0ts0e2pMc", limit: 2 },
});
console.log("Total:", data.meta?.total, "Opps:", data.opportunities?.length);
console.log("Done");
