import { getDb } from "./server/db.ts";
import { leads } from "./drizzle/schema.ts";
import { eq, and, sql, isNull, or, lte } from "drizzle-orm";

const db = await getDb();

// Count humanTakeover=1 leads by pipelineStage
const byStage = await db.select({
  stage: leads.pipelineStage,
  cnt: sql`COUNT(*)`,
}).from(leads).where(eq(leads.humanTakeover, 1)).groupBy(leads.pipelineStage);
console.log("humanTakeover=1 by stage:", JSON.stringify(byStage, null, 2));

// Count humanTakeover=1 + NOT not_qualified
const active = await db.select({
  cnt: sql`COUNT(*)`,
}).from(leads).where(and(
  eq(leads.humanTakeover, 1),
  sql`${leads.pipelineStage} != 'not_qualified'`,
));
console.log("humanTakeover=1 AND stage != not_qualified:", active[0].cnt);

// Check the 7-day filter
const withAge = await db.select({
  cnt: sql`COUNT(*)`,
}).from(leads).where(and(
  eq(leads.humanTakeover, 1),
  sql`${leads.pipelineStage} != 'not_qualified'`,
  sql`${leads.createdAt} < DATE_SUB(NOW(), INTERVAL 7 DAY)`,
));
console.log("+ older than 7 days:", withAge[0].cnt);

// Check lastAgentActivityAt distribution
const agentActivity = await db.select({
  nullCount: sql`SUM(CASE WHEN ${leads.lastAgentActivityAt} IS NULL THEN 1 ELSE 0 END)`,
  hasActivity: sql`SUM(CASE WHEN ${leads.lastAgentActivityAt} IS NOT NULL THEN 1 ELSE 0 END)`,
}).from(leads).where(and(
  eq(leads.humanTakeover, 1),
  sql`${leads.pipelineStage} != 'not_qualified'`,
));
console.log("Agent activity:", JSON.stringify(agentActivity[0], null, 2));

// Sample 5 leads that should be caught
const samples = await db.select({
  id: leads.id,
  name: leads.name,
  pipelineStage: leads.pipelineStage,
  humanTakeover: leads.humanTakeover,
  lastAgentActivityAt: leads.lastAgentActivityAt,
  email: leads.email,
  createdAt: leads.createdAt,
}).from(leads).where(and(
  eq(leads.humanTakeover, 1),
  sql`${leads.pipelineStage} != 'not_qualified'`,
)).limit(5);
console.log("Sample leads:", JSON.stringify(samples, null, 2));

process.exit(0);
