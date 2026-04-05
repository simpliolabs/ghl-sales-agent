import { runLookback } from './server/lookback-engine.ts';

const startTime = Date.now();
const maxLeads = parseInt(process.env.LOOKBACK_MAX || '50', 10);
const delayMs = parseInt(process.env.LOOKBACK_DELAY || '3000', 10);
const skipResearch = process.env.LOOKBACK_SKIP_RESEARCH === '1';

console.log(`[${new Date().toISOString()}] Starting rate-limited lookback (max=${maxLeads}, delay=${delayMs}ms, skipResearch=${skipResearch})...`);

try {
  const result = await runLookback({
    maxLeads,
    delayBetweenMs: delayMs,
    onlyUnprocessed: true,
    skipResearch,
  });
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n[${new Date().toISOString()}] LOOKBACK COMPLETE in ${elapsed}s`);
  console.log(JSON.stringify({
    total: result.total,
    processed: result.processed,
    engage: result.engage,
    skip: result.skip,
    caution: result.caution,
    humanNeeded: result.humanNeeded,
    researchFetched: result.researchFetched,
    errors: result.errors,
    rateLimitHits: result.rateLimitHits,
  }, null, 2));

  // Summary by approach
  const byApproach = {};
  const byChannel = {};
  const byStatus = {};
  for (const r of result.results) {
    byApproach[r.recommendedApproach] = (byApproach[r.recommendedApproach] || 0) + 1;
    byChannel[r.recommendedChannel] = (byChannel[r.recommendedChannel] || 0) + 1;
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  }
  console.log('\nBy approach:', JSON.stringify(byApproach));
  console.log('By channel:', JSON.stringify(byChannel));
  console.log('By status:', JSON.stringify(byStatus));

  // Show skipped/human_needed leads
  const flagged = result.results.filter(r => r.status === 'skip' || r.status === 'human_needed');
  if (flagged.length > 0) {
    console.log(`\nFlagged leads (${flagged.length}):`);
    for (const r of flagged) {
      console.log(`  Lead ${r.leadId} (${r.leadName}): ${r.status} | ${r.skipReason || r.keyContext}`);
    }
  }
} catch (e) {
  console.error('Lookback failed:', e);
}
process.exit(0);
