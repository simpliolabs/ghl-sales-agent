import { ENV } from "./server/_core/env.ts";
import axios from "axios";

console.log("locationId:", ENV.ghlLocationId?.substring(0, 8));
console.log("apiKey:", ENV.ghlApiKey ? "SET" : "MISSING");

const client = axios.create({
  baseURL: "https://services.leadconnectorhq.com",
  headers: {
    Authorization: `Bearer ${ENV.ghlApiKey}`,
    Version: "2021-04-15",
    "Content-Type": "application/json",
  },
});

try {
  const { data } = await client.get("/opportunities/search", {
    params: { locationId: ENV.ghlLocationId, pipelineId: "OpojlMx3cTa0ts0e2pMc", limit: 2 },
  });
  console.log("Total:", data.meta?.total);
  console.log("First opp:", data.opportunities?.[0]?.id);
} catch (e) {
  console.error("Status:", e.response?.status);
  console.error("Data:", JSON.stringify(e.response?.data));
  console.error("locationId used:", ENV.ghlLocationId);
}
