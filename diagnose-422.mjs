import { getDb } from "./server/db.ts";
import { leads } from "./drizzle/schema.ts";
import { eq, and, sql, inArray } from "drizzle-orm";

const db = await getDb();
const failingIds = [212, 232, 259, 264, 269, 273, 399, 400, 401, 404, 405, 407, 411, 412, 414, 415, 519, 522, 583, 686];

const rows = await db.select({
  id: leads.id,
  name: leads.name,
  ghlOpportunityId: leads.ghlOpportunityId,
  ghlPipelineId: leads.ghlPipelineId,
  pipelineStage: leads.pipelineStage,
  email: leads.email,
}).from(leads).where(inArray(leads.id, failingIds));

for (const r of rows) {
  console.log(`Lead ${r.id} (${r.name}): opp=${r.ghlOpportunityId || 'NULL'}, pipeline=${r.ghlPipelineId || 'NULL'}, stage=${r.pipelineStage}, email=${r.email || 'NONE'}`);
}

process.exit(0);
