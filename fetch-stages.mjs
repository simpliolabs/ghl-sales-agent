import { getPipelines } from "./server/ghl.ts";

const pipelines = await getPipelines();
for (const p of pipelines) {
  console.log(`Pipeline: ${p.id} — ${p.name}`);
  for (const s of (p.stages || [])) {
    console.log(`  Stage: ${s.id} — ${s.name}`);
  }
}
