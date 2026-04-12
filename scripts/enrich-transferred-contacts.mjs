/**
 * Enrich Transferred Contacts — Full Pipeline
 * 
 * Starts from portal leads with source "ghl_import" or "r" (transferred contacts).
 * For each lead:
 * 1. Pull full contact details + custom fields from Adorb GHL
 * 2. Pull opportunity status + value from Adorb GHL
 * 3. Tag as "transferred_contact" in source field
 * 4. Store custom fields, attribution, signup source in researchData
 * 5. Classify segment if missing (via LLM)
 * 6. Push to Omnisend if email exists
 * 7. Schedule for re-engagement activation timeline (staggered M-F 9-5 ET)
 * 8. Clear lookback marker so Researcher brain auto-runs on next cycle
 * 
 * Usage: node scripts/enrich-transferred-contacts.mjs [--dry-run] [--limit N] [--source ghl_import|r|both]
 */
import mysql from "mysql2/promise";
import axios from "axios";

// --- Config ---
const ADORB_API_KEY = process.env.GHL_API_KEY;
const ADORB_LOCATION_ID = process.env.GHL_LOCATION_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const OMNISEND_API_KEY = process.env.OMNISEND_API_KEY;
const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY;

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT_ARG = process.argv.indexOf("--limit");
const LIMIT = LIMIT_ARG !== -1 ? parseInt(process.argv[LIMIT_ARG + 1], 10) : 0;
const SOURCE_ARG = process.argv.indexOf("--source");
const SOURCE_FILTER = SOURCE_ARG !== -1 ? process.argv[SOURCE_ARG + 1] : "both";

if (!ADORB_API_KEY) { console.error("Missing GHL_API_KEY"); process.exit(1); }
if (!DATABASE_URL) { console.error("Missing DATABASE_URL"); process.exit(1); }

// --- API Clients ---
const ghlClient = axios.create({
  baseURL: "https://services.leadconnectorhq.com",
  headers: { Authorization: `Bearer ${ADORB_API_KEY}`, Version: "2021-07-28", "Content-Type": "application/json" },
});

const omnisendClient = OMNISEND_API_KEY ? axios.create({
  baseURL: "https://api.omnisend.com/v3",
  headers: { "X-API-KEY": OMNISEND_API_KEY, "Content-Type": "application/json" },
}) : null;

// --- Helpers ---
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractCustomFields(contact) {
  const fields = {};
  if (Array.isArray(contact?.customFields)) {
    for (const cf of contact.customFields) {
      const key = cf.id || cf.key || cf.field_key || "";
      const val = cf.value || cf.field_value || "";
      if (key && val) fields[key] = val;
    }
  }
  return fields;
}

function extractAttribution(contact) {
  const attr = contact?.attributionSource || contact?.lastAttributionSource || {};
  return {
    sessionSource: attr.sessionSource || null,
    medium: attr.medium || null,
    mediumId: attr.mediumId || null,
    createdBy: contact?.createdBy?.source || null,
    createdByChannel: contact?.createdBy?.channel || null,
    createdBySourceId: contact?.createdBy?.sourceId || null,
  };
}

// Business hours staggering: M-F 9am-5pm ET
function getStaggeredActivationSlot(index) {
  const now = new Date();
  const etOffset = -4; // EDT
  const etNow = new Date(now.getTime() + etOffset * 60 * 60 * 1000);
  
  // Each lead gets a 15-minute slot, max 32 per day (9am-5pm = 8h = 32 slots)
  const slotsPerDay = 32;
  const dayOffset = Math.floor(index / slotsPerDay);
  const slotInDay = index % slotsPerDay;
  
  const activationDate = new Date(etNow);
  activationDate.setHours(9, 0, 0, 0);
  activationDate.setDate(activationDate.getDate() + 1); // Start tomorrow
  
  // Skip weekends
  let daysAdded = 0;
  while (daysAdded < dayOffset) {
    activationDate.setDate(activationDate.getDate() + 1);
    const dow = activationDate.getDay();
    if (dow !== 0 && dow !== 6) daysAdded++;
  }
  while (activationDate.getDay() === 0 || activationDate.getDay() === 6) {
    activationDate.setDate(activationDate.getDate() + 1);
  }
  
  // Add slot offset (15 min per slot + small jitter)
  const minuteOffset = slotInDay * 15 + Math.floor(Math.random() * 10);
  activationDate.setMinutes(minuteOffset);
  
  // Convert back to UTC
  return new Date(activationDate.getTime() - etOffset * 60 * 60 * 1000);
}

async function invokeLLM(messages, responseFormat) {
  if (!FORGE_API_URL || !FORGE_API_KEY) return null;
  try {
    const { data } = await axios.post(`${FORGE_API_URL}/chat/completions`, {
      messages,
      ...(responseFormat ? { response_format: responseFormat } : {}),
    }, {
      headers: { Authorization: `Bearer ${FORGE_API_KEY}`, "Content-Type": "application/json" },
      timeout: 30000,
    });
    return data?.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error("[LLM] Error:", err.response?.status || err.message);
    return null;
  }
}

async function classifySegment(businessName, website) {
  const content = await invokeLLM([
    { role: "system", content: "Classify this business into one segment for a custom printing company. Return JSON with 'segment' field. Options: church, sports_team, school, hvac, event_planner, pool_cleaner, brand, nonprofit, other" },
    { role: "user", content: `Business: ${businessName}, Website: ${website || "N/A"}` },
  ], {
    type: "json_schema",
    json_schema: {
      name: "segment",
      strict: true,
      schema: { type: "object", properties: { segment: { type: "string" } }, required: ["segment"], additionalProperties: false },
    },
  });
  if (content) {
    try { return JSON.parse(content).segment || "other"; } catch { return "other"; }
  }
  return "other";
}

async function pushToOmnisend(contact) {
  if (!omnisendClient || !contact.email) return false;
  try {
    const payload = {
      identifiers: [{ type: "email", id: contact.email, channels: { email: { status: "subscribed" } } }],
      firstName: contact.firstName || "",
      lastName: contact.lastName || "",
      tags: contact.tags || ["transferred_contact"],
    };
    if (contact.phone) {
      payload.identifiers.push({ type: "phone", id: contact.phone, channels: { sms: { status: "subscribed" } } });
    }
    await omnisendClient.post("/contacts", payload);
    return true;
  } catch (err) {
    if (err.response?.status === 409) {
      try {
        await omnisendClient.patch(`/contacts/${encodeURIComponent(contact.email)}`, { tags: contact.tags || ["transferred_contact"] });
        return true;
      } catch { return false; }
    }
    console.error(`[Omnisend] Error for ${contact.email}:`, err.response?.status);
    return false;
  }
}

async function getGhlContact(contactId) {
  try {
    const { data } = await ghlClient.get(`/contacts/${contactId}`);
    return data.contact;
  } catch (err) {
    if (err.response?.status === 429) { await sleep(10000); return getGhlContact(contactId); }
    return null;
  }
}

async function getGhlOpportunities(contactId) {
  try {
    const { data } = await ghlClient.get("/opportunities/search", {
      params: { location_id: ADORB_LOCATION_ID, contact_id: contactId },
    });
    return data.opportunities || [];
  } catch (err) {
    if (err.response?.status === 429) { await sleep(10000); return getGhlOpportunities(contactId); }
    return [];
  }
}

// =====================================================================
// MAIN
// =====================================================================
async function main() {
  console.log("=== Transferred Contact Enrichment + Activation ===");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`Limit: ${LIMIT || "none"}`);
  console.log(`Source filter: ${SOURCE_FILTER}\n`);

  const conn = await mysql.createConnection(DATABASE_URL);

  // Step 1: Get all transferred leads from our portal
  let sourceClause;
  if (SOURCE_FILTER === "ghl_import") sourceClause = 'source = "ghl_import"';
  else if (SOURCE_FILTER === "r") sourceClause = 'source = "r"';
  else sourceClause = 'source IN ("ghl_import", "r")';

  const limitClause = LIMIT > 0 ? `LIMIT ${LIMIT}` : "";
  const [portalLeads] = await conn.execute(
    `SELECT id, ghlContactId, name, email, phone, businessName, website, source, 
            omnisendSegment, researchData, ghlOpportunityId, pipelineStage, 
            nextFollowUpAt, humanTakeover, opportunityStatus, pipelineValue
     FROM leads WHERE ${sourceClause} ORDER BY id ASC ${limitClause}`
  );

  console.log(`[Step 1] Found ${portalLeads.length} transferred leads in portal\n`);

  const stats = {
    total: portalLeads.length,
    enriched: 0,
    alreadyDone: 0,
    ghlFetched: 0,
    oppsFetched: 0,
    segmented: 0,
    omnisendPushed: 0,
    activated: 0,
    noGhlId: 0,
    errors: 0,
  };

  let activationIndex = 0;

  for (let i = 0; i < portalLeads.length; i++) {
    const lead = portalLeads[i];
    const name = lead.name || `Lead #${lead.id}`;
    const pct = ((i + 1) / portalLeads.length * 100).toFixed(1);

    try {
      // Skip if already enriched as transferred_contact
      if (lead.source === "transferred_contact") {
        stats.alreadyDone++;
        continue;
      }

      if (!lead.ghlContactId) {
        stats.noGhlId++;
        if (i % 50 === 0) console.log(`[${pct}%] ${name} — no GHL contact ID, skipping`);
        continue;
      }

      if (DRY_RUN) {
        console.log(`[${pct}%] [DRY] ${name} (lead #${lead.id}) — would enrich`);
        stats.enriched++;
        continue;
      }

      // --- PULL FROM ADORB GHL ---

      // A. Get full contact details + custom fields
      const ghlContact = await getGhlContact(lead.ghlContactId);
      if (ghlContact) stats.ghlFetched++;
      await sleep(300);

      // B. Get opportunities
      const opportunities = await getGhlOpportunities(lead.ghlContactId);
      stats.oppsFetched += opportunities.length;
      await sleep(300);

      // C. Extract data
      const customFields = ghlContact ? extractCustomFields(ghlContact) : {};
      const attribution = ghlContact ? extractAttribution(ghlContact) : {};
      const tags = ghlContact?.tags || [];

      // D. Build opportunity summary
      const oppSummary = opportunities.map(opp => ({
        id: opp.id,
        name: opp.name,
        status: opp.status, // open, won, lost, abandoned
        monetaryValue: opp.monetaryValue || 0,
        pipelineId: opp.pipelineId,
        pipelineStageId: opp.pipelineStageId,
        createdAt: opp.createdAt,
        lastStatusChangeAt: opp.lastStatusChangeAt,
        lastStageChangeAt: opp.lastStageChangeAt,
      }));

      // E. Build enriched researchData
      let existingResearch = {};
      try { existingResearch = lead.researchData ? (typeof lead.researchData === "string" ? JSON.parse(lead.researchData) : lead.researchData) : {}; } catch {}

      const enrichedResearch = {
        ...existingResearch,
        transferredContact: {
          taggedAt: new Date().toISOString(),
          originalSource: lead.source,
          ghlTags: tags,
          ghlCustomFields: customFields,
          attribution,
          opportunities: oppSummary,
          ghlDateAdded: ghlContact?.dateAdded || null,
          ghlCountry: ghlContact?.country || null,
          ghlCompanyName: ghlContact?.companyName || null,
        },
      };

      // F. Determine best opportunity status for the lead
      let bestOppStatus = lead.opportunityStatus;
      let bestOppId = lead.ghlOpportunityId;
      let bestPipelineValue = lead.pipelineValue || 0;
      if (opportunities.length > 0) {
        // Pick the most recent or highest-value opportunity
        const sorted = [...opportunities].sort((a, b) => (b.monetaryValue || 0) - (a.monetaryValue || 0));
        const best = sorted[0];
        bestOppStatus = best.status;
        bestOppId = best.id;
        bestPipelineValue = best.monetaryValue || bestPipelineValue;
      }

      // G. Classify segment if missing
      let segment = lead.omnisendSegment;
      if (!segment) {
        const biz = lead.businessName || ghlContact?.companyName;
        if (biz) {
          segment = await classifySegment(biz, lead.website || ghlContact?.website);
          stats.segmented++;
          await sleep(1000); // LLM rate limit
        } else {
          segment = "other";
        }
      }

      // H. Schedule for activation timeline (staggered)
      // Only reschedule if lead is not already active or human-taken-over
      let activationSlot = lead.nextFollowUpAt;
      if (!lead.humanTakeover && (!lead.nextFollowUpAt || new Date(lead.nextFollowUpAt) < new Date())) {
        activationSlot = getStaggeredActivationSlot(activationIndex);
        activationIndex++;
        stats.activated++;
      }

      // I. Update lead in DB
      await conn.execute(
        `UPDATE leads SET 
          source = 'transferred_contact',
          researchData = ?,
          omnisendSegment = COALESCE(omnisendSegment, ?),
          ghlOpportunityId = COALESCE(ghlOpportunityId, ?),
          opportunityStatus = COALESCE(?, opportunityStatus),
          pipelineValue = GREATEST(COALESCE(pipelineValue, 0), ?),
          nextFollowUpAt = ?,
          cadencePosition = 0,
          reactivationCount = COALESCE(reactivationCount, 0) + 1,
          lastReactivationAt = NOW(),
          lastResearchSummary = NULL,
          lastStrategyReasoning = ?,
          updatedAt = NOW()
        WHERE id = ?`,
        [
          JSON.stringify(enrichedResearch),
          segment,
          bestOppId,
          bestOppStatus,
          bestPipelineValue,
          activationSlot,
          `[TRANSFERRED] Original source: ${lead.source}. Tags: ${tags.join(", ")}. Opps: ${oppSummary.map(o => `${o.status}/$${o.monetaryValue}`).join(", ") || "none"}`,
          lead.id,
        ]
      );

      // J. Push to Omnisend if email exists
      if (lead.email) {
        const nameParts = (lead.name || "").split(" ");
        const pushed = await pushToOmnisend({
          email: lead.email,
          firstName: nameParts[0],
          lastName: nameParts.slice(1).join(" "),
          phone: lead.phone,
          tags: [segment || "transferred_contact", "transferred_contact"],
        });
        if (pushed) stats.omnisendPushed++;
        await sleep(200);
      }

      stats.enriched++;

      // Progress log
      if (i % 25 === 0 || i === portalLeads.length - 1) {
        console.log(`[${pct}%] ✓ ${name} (#${lead.id}) | segment: ${segment} | opps: ${opportunities.length} (${bestOppStatus || "none"}) | val: $${bestPipelineValue} | omnisend: ${lead.email ? "yes" : "no"} | activation: ${activationSlot ? new Date(activationSlot).toISOString().split("T")[0] : "kept"}`);
      }

    } catch (err) {
      stats.errors++;
      console.error(`[${pct}%] ✗ ${name} (#${lead.id}) — error:`, err.message);
    }

    // Rate limiting: pause every 10 leads
    if (i % 10 === 0 && i > 0) await sleep(500);
  }

  // Summary
  console.log("\n=== ENRICHMENT SUMMARY ===");
  console.log(`Total leads processed:      ${stats.total}`);
  console.log(`Enriched & tagged:          ${stats.enriched}`);
  console.log(`Already done:               ${stats.alreadyDone}`);
  console.log(`GHL contacts fetched:       ${stats.ghlFetched}`);
  console.log(`Opportunities found:        ${stats.oppsFetched}`);
  console.log(`Segments classified:        ${stats.segmented}`);
  console.log(`Omnisend pushed:            ${stats.omnisendPushed}`);
  console.log(`Activation scheduled:       ${stats.activated}`);
  console.log(`No GHL contact ID:          ${stats.noGhlId}`);
  console.log(`Errors:                     ${stats.errors}`);
  if (DRY_RUN) console.log("\n(DRY RUN — no data was written)");

  console.log("\n[NOTE] Lookback engine will auto-research these leads on next cycle (lastResearchSummary cleared).");
  console.log("[NOTE] Follow-up trigger will auto-engage at scheduled activation slots.");

  await conn.end();
  console.log("\nDone.");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
