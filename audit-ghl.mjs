import { getOpportunities } from "./server/ghl.ts";

// Check Bulk Printing Pipeline opportunities (sample)
console.log("=== SAMPLE OPPORTUNITY FIELDS (Bulk Printing Pipeline) ===");
const bulkPipelineId = "OpojlMx3cTa0ts0e2pMc";
const opps = await getOpportunities(bulkPipelineId, 3);
const sample = (opps.opportunities || [])[0];
if (sample) {
  console.log("Keys:", Object.keys(sample).join(", "));
  console.log("Sample:", JSON.stringify(sample, null, 2));
} else {
  console.log("No opportunities found");
}

// Count totals
console.log("\n=== OPPORTUNITY COUNTS ===");
const pipelines = [
  { id: "OpojlMx3cTa0ts0e2pMc", name: "Bulk Printing Pipeline" },
  { id: "5YIrCvKmzb27yXHP3fBF", name: "100 T-shirt Inquiry" },
  { id: "FgRa75sGUcw5lh0kPAwH", name: "100 T-shirt Printing" },
  { id: "sOJmH5op75E4HgXpTonU", name: "Follow Up Pipeline" },
  { id: "DywhWMjMSu4VpCez1QPd", name: "Marketing Pipeline" },
  { id: "xyRhqslao3CnMQHJxLoy", name: "New pipeline" },
];
for (const p of pipelines) {
  try {
    const r = await getOpportunities(p.id, 1);
    console.log(`  ${p.name}: total=${r.meta?.total ?? "?"}`);
  } catch (e) {
    console.log(`  ${p.name}: ERROR - ${e.message}`);
  }
}
