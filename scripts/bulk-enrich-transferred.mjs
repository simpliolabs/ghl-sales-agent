/**
 * ONE-TIME SCRIPT: Bulk Enrich + Classify + Omnisend Sync
 * --------------------------------------------------------
 * Processes all 1,554 transferred contacts in parallel batches of 20.
 * For each contact:
 *   1. Pull full GHL data: conversation history, resolved custom fields, notes, tags
 *   2. Classify into segment via LLM (Church/Sports/School/Trades/Event/Brand/Nonprofit/Other)
 *   3. Update DB with enriched researchData + omnisendSegment
 *   4. Sync to Omnisend with correct segment tag
 *
 * Run: node scripts/bulk-enrich-transferred.mjs
 * Safe to re-run — skips contacts already classified (not "other")
 */

import mysql from "mysql2/promise";
import axios from "axios";

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const OMNISEND_API_KEY = process.env.OMNISEND_API_KEY;
const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

const CONCURRENCY = 20;   // parallel contacts
const GHL_DELAY_MS = 120; // 120ms between GHL calls per contact = ~8 req/s per contact slot
const BATCH_REPORT_EVERY = 50;

const ghl = axios.create({
  baseURL: "https://services.leadconnectorhq.com",
  headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: "2021-07-28", "Content-Type": "application/json" },
  timeout: 15000,
});

const omnisend = axios.create({
  baseURL: "https://api.omnisend.com/v3",
  headers: { "X-API-KEY": OMNISEND_API_KEY, "Content-Type": "application/json" },
  timeout: 10000,
});

let customFieldMap = {};
async function loadCustomFieldMap() {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const { data } = await ghl.get(`/locations/${GHL_LOCATION_ID}/customFields`);
      for (const f of (data.customFields || [])) customFieldMap[f.id] = f.name;
      console.log(`[Init] Loaded ${Object.keys(customFieldMap).length} custom field definitions`);
      return;
    } catch (e) {
      const is429 = e.response?.status === 429;
      console.error(`[Init] Custom fields attempt ${attempt} failed: ${e.message}`);
      if (attempt < 5) await new Promise(r => setTimeout(r, is429 ? 5000 * attempt : 2000));
    }
  }
  console.error("[Init] Custom fields permanently failed — field IDs will not be resolved");
}

async function getContact(contactId) {
  try { const { data } = await ghl.get(`/contacts/${contactId}`); return data.contact; }
  catch { return null; }
}

async function getConversationHistory(contactId) {
  try {
    const { data: cd } = await ghl.get(`/conversations/search`, { params: { locationId: GHL_LOCATION_ID, contactId } });
    const convs = cd.conversations || [];
    const allMsgs = [];
    for (const conv of convs) {
      try {
        const { data: md } = await ghl.get(`/conversations/${conv.id}/messages`);
        const msgs = Array.isArray(md) ? md : (md?.messages || []);
        for (const m of msgs) allMsgs.push({
          direction: m.direction || "unknown",
          body: (m.body || m.message || "").substring(0, 600),
          dateAdded: m.dateAdded || "",
        });
      } catch { /* skip */ }
    }
    allMsgs.sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
    return allMsgs;
  } catch { return []; }
}

async function getNotes(contactId) {
  try {
    const { data } = await ghl.get(`/contacts/${contactId}/notes`);
    return (data.notes || []).map(n => ({ body: (n.body || "").substring(0, 400), dateAdded: n.dateAdded }));
  } catch { return []; }
}

function resolveCustomFields(rawFields) {
  if (!rawFields || typeof rawFields !== "object") return {};
  const out = {};
  for (const [id, value] of Object.entries(rawFields)) {
    if (value === null || value === undefined || value === "") continue;
    out[customFieldMap[id] || id] = value;
  }
  return out;
}

const SEGMENTS = ["Church", "Sports", "School", "Trades", "Event", "Brand", "Nonprofit", "Other"];

// Rule-based pre-classifier using name, business, tags, notes, and conversation signals
// Returns a segment string or null if uncertain (falls through to LLM)
function ruleBasedClassify(c) {
  const corpus = [
    c.name || "",
    c.businessName || "",
    (c.tags || []).join(" "),
    (c.notes || []).map(n => n.body).join(" "),
    (c.conversationHistory || []).map(m => m.body).join(" "),
    Object.entries(c.customFields || {}).map(([k,v]) => `${k} ${v}`).join(" "),
  ].join(" ").toLowerCase();

  if (/\bchurch\b|\bpastor\b|\bministry\b|\bworship\b|\bfaith\b|\bchristian\b|\bcatholic\b|\bbaptist\b|\bchapel\b|\bcongregation\b|\bpriest\b|\bbishop\b|\bdeacon\b|\bsunday school\b|\bpentecostal\b|\bchurch of\b|\btemple\b|\bsynagogue\b|\bmosque\b/.test(corpus)) return "Church";
  if (/\bschool\b|\buniversity\b|\bcollege\b|\bstudent\b|\bteacher\b|\bprincipal\b|\bclassroom\b|\bgrade\b|\bgraduat\b|\bprom\b|\bfundraiser\b|\bpta\b|\bbooster\b|\bacademy\b|\belementary\b|\bmiddle school\b|\bhigh school\b|\bcheerleader\b|\bband\b/.test(corpus)) return "School";
  if (/\bsports\b|\bteam\b|\bcoach\b|\bleague\b|\btournament\b|\bathletic\b|\bfootball\b|\bbasketball\b|\bbaseball\b|\bsoccer\b|\btrack\b|\bswim\b|\bgym\b|\bfitness\b|\byouth league\b|\beagles\b|\blions\b|\btigers\b|\bbears\b|\bwolves\b|\bwarriors\b|\bknights\b|\bfalcons\b|\bhawks\b|\bbulls\b|\brockets\b|\bstars\b|\bchargers\b|\bjaguars\b|\bpanthers\b|\bravens\b|\bsharks\b|\bgators\b|\bvipers\b|\bspartans\b|\btrojans\b|\bpatriots\b|\bbroncos\b|\bcowboys\b|\byouth sports\b|\bsoftball\b|\bvolleyball\b|\bwrestl\b|\blacrosse\b|\bhockey\b|\bmartial arts\b/.test(corpus)) return "Sports";
  if (/\bnonprofit\b|\bnon-profit\b|\bcharity\b|\bfoundation\b|\bngo\b|\bvolunteer\b|\bcommunity org\b|\b501c\b|\bhumanitarian\b/.test(corpus)) return "Nonprofit";
  if (/\bevent\b|\bconcert\b|\bfestival\b|\breunion\b|\bwedding\b|\bbachelorette\b|\bbirthday\b|\bparty\b|\bgala\b|\bconference\b|\bexpo\b|\bprom\b|\bgraduation\b|\bholiday party\b|\bfamily reunion\b/.test(corpus)) return "Event";
  if (/\bconstruct\b|\bcontract\b|\bplumb\b|\belectric\b|\bhvac\b|\bcarpent\b|\blandscap\b|\bpaint\b|\broofer\b|\bweld\b|\bmechanic\b|\bautomot\b|\btrade\b|\bremodel\b|\bhandyman\b|\bflooring\b|\bconcrete\b|\bmasonry\b/.test(corpus)) return "Trades";
  if (/\bproduction\b|\bproductions\b|\bstudio\b|\bentertain\b|\bbrand\b|\bcompany\b|\bcorporat\b|\bbusiness\b|\bmarketing\b|\bstartup\b|\bmerch\b|\buniform\b|\bstaff\b|\bemployee\b|\bllc\b|\binc\b|\bcorp\b|\bgroup\b|\bassociat\b|\borganization\b|\bservices\b|\bsolutions\b/.test(corpus)) return "Brand";
  return null; // uncertain — use LLM
}

async function classifySegment(c) {
  // Try rule-based first — saves LLM calls for obvious cases
  const ruleResult = ruleBasedClassify(c);
  if (ruleResult) return ruleResult;

  // Only call LLM if we have enough signal to classify
  const hasSignal = (
    (c.customFields && Object.keys(c.customFields).length > 0) ||
    (c.notes && c.notes.length > 0) ||
    (c.conversationHistory && c.conversationHistory.length > 0) ||
    c.businessName
  );
  if (!hasSignal) return "Other"; // No data → skip LLM, save credits

  const lines = [
    `Name: ${c.name || "unknown"}`,
    c.businessName ? `Business: ${c.businessName}` : null,
    c.tags?.length ? `Tags: ${c.tags.join(", ")}` : null,
  ].filter(Boolean);

  if (c.customFields && Object.keys(c.customFields).length > 0) {
    lines.push("Custom fields: " + Object.entries(c.customFields).map(([k,v]) => `${k}=${v}`).join(", "));
  }
  if (c.notes?.length) lines.push(`Notes: ${c.notes.map(n => n.body).join(" | ").substring(0, 300)}`);
  if (c.conversationHistory?.length) {
    lines.push("Conversation: " + c.conversationHistory.slice(0, 4).map(m => `[${m.direction}] ${m.body}`).join(" | ").substring(0, 400));
  }

  try {
    const resp = await axios.post(
      `${FORGE_API_URL.replace(/\/$/, "")}/v1/chat/completions`,
      {
        model: "gpt-4.1-nano",
        messages: [{
          role: "user",
          content: `Classify this custom t-shirt/apparel lead into ONE segment based on who they are or what they need:\n- Church: religious organizations, ministries, pastors\n- Sports: sports teams, leagues, coaches, athletic clubs\n- School: schools, universities, student groups, PTAs\n- Trades: contractors, construction, trade workers\n- Event: one-time events (concerts, reunions, weddings, parties)\n- Brand: businesses, companies, corporate, startups wanting branded merch\n- Nonprofit: charities, foundations, community orgs\n- Other: unclear or individual consumer\n\n${lines.join("\n")}\n\nReply with ONLY the segment name.`
        }],
        max_tokens: 8, temperature: 0,
      },
      { headers: { Authorization: `Bearer ${FORGE_API_KEY}`, "Content-Type": "application/json" }, timeout: 12000 }
    );
    const raw = resp.data.choices?.[0]?.message?.content?.trim() || "Other";
    return SEGMENTS.find(s => raw.toLowerCase().includes(s.toLowerCase())) || "Other";
  } catch { return "Other"; }
}

async function syncToOmnisend(lead, segment) {
  if (!lead.email) return false;
  const tags = ["transferred_contact", `segment:${segment.toLowerCase()}`];
  const payload = {
    identifiers: [{ type: "email", id: lead.email, channels: { email: { status: "subscribed" } } }],
    firstName: lead.firstName || "",
    lastName: lead.lastName || "",
    tags,
  };
  if (lead.phone) payload.identifiers.push({ type: "phone", id: lead.phone, channels: { sms: { status: "subscribed" } } });
  try {
    await omnisend.post("/contacts", payload);
    return true;
  } catch (err) {
    if (err.response?.status === 409) {
      try { await omnisend.patch(`/contacts/${encodeURIComponent(lead.email)}`, { tags }); return true; } catch { return false; }
    }
    return false;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function processContact(lead, conn) {
  try {
    const contactId = lead.ghlContactId;
    if (!contactId) return { status: "skip", reason: "no ghlContactId" };

    let existingResearch = {};
    try { existingResearch = typeof lead.researchData === "string" ? JSON.parse(lead.researchData) : (lead.researchData || {}); } catch {}
    const blob = existingResearch.transferredContact || {};

    // Parallel GHL fetches — contact + history + notes simultaneously
    const [ghlContact, conversationHistory, notes] = await Promise.all([
      getContact(contactId),
      getConversationHistory(contactId),
      getNotes(contactId),
    ]);

    // Resolve custom fields
    const rawCF = ghlContact?.customFields
      ? Object.fromEntries((ghlContact.customFields || []).map(f => [f.id, f.value]))
      : blob.ghlCustomFields || {};
    const resolvedCF = resolveCustomFields(rawCF);

    const nameParts = (lead.name || "").trim().split(/\s+/);
    const enriched = {
      name: lead.name,
      firstName: nameParts[0] || "",
      lastName: nameParts.slice(1).join(" ") || "",
      businessName: ghlContact?.companyName || null,
      tags: ghlContact?.tags || blob.ghlTags || [],
      customFields: resolvedCF,
      notes,
      conversationHistory,
      attribution: blob.attribution || {},
      originalSource: blob.originalSource || ghlContact?.source || null,
    };

    const segment = await classifySegment(enriched);

    const updatedResearch = {
      ...existingResearch,
      transferredContact: {
        ...blob,
        ghlCustomFields: rawCF,
        resolvedCustomFields: resolvedCF,
        ghlTags: enriched.tags,
        ghlCompanyName: enriched.businessName,
      },
      ghlConversationHistory: conversationHistory.slice(0, 30),
      ghlNotes: notes,
      enrichedAt: new Date().toISOString(),
      classifiedSegment: segment,
    };

    await conn.execute(
      `UPDATE leads SET omnisendSegment = ?, researchData = ?, businessName = COALESCE(businessName, ?) WHERE id = ?`,
      [segment.toLowerCase(), JSON.stringify(updatedResearch), enriched.businessName || null, lead.id]
    );

    const synced = await syncToOmnisend(
      { email: lead.email, phone: lead.phone, firstName: enriched.firstName, lastName: enriched.lastName },
      segment
    );

    return {
      status: "ok", segment,
      history: conversationHistory.length,
      notes: notes.length,
      fields: Object.keys(resolvedCF).length,
      omnisend: synced,
    };
  } catch (err) {
    return { status: "error", reason: err.message };
  }
}

async function main() {
  console.log("=== Bulk Enrich + Classify + Omnisend Sync ===");
  console.log(`Started: ${new Date().toISOString()}\n`);

  const conn = await mysql.createConnection(DATABASE_URL);
  await loadCustomFieldMap();
  await sleep(500);

  const [leads] = await conn.execute(`
    SELECT id, name, email, phone, ghlContactId, researchData
    FROM leads
    WHERE source = 'transferred_contact'
      AND (omnisendSegment IS NULL OR omnisendSegment = 'other')
    ORDER BY id ASC
  `);

  console.log(`Found ${leads.length} unclassified transferred contacts\n`);

  let processed = 0, classified = 0, omnisendSynced = 0, errors = 0;
  const segmentCounts = {};

  // Process in chunks of CONCURRENCY
  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const chunk = leads.slice(i, i + CONCURRENCY);

    // Run all in parallel with small stagger to avoid thundering herd
    const results = await Promise.all(
      chunk.map((lead, idx) =>
        sleep(idx * GHL_DELAY_MS).then(() => processContact(lead, conn))
      )
    );

    for (let j = 0; j < chunk.length; j++) {
      const lead = chunk[j];
      const r = results[j];
      processed++;

      if (r.status === "ok") {
        classified++;
        if (r.omnisend) omnisendSynced++;
        segmentCounts[r.segment] = (segmentCounts[r.segment] || 0) + 1;
        console.log(`  [${lead.id}] ${lead.name} → ${r.segment} | hist:${r.history} notes:${r.notes} fields:${r.fields} omnisend:${r.omnisend ? "✓" : "no-email"}`);
      } else {
        errors++;
        console.log(`  [${lead.id}] ${lead.name} → ${r.status.toUpperCase()}: ${r.reason}`);
      }
    }

    if (processed % BATCH_REPORT_EVERY === 0 || i + CONCURRENCY >= leads.length) {
      const pct = Math.round((processed / leads.length) * 100);
      console.log(`\n--- Progress: ${processed}/${leads.length} (${pct}%) | classified:${classified} omnisend:${omnisendSynced} errors:${errors} ---`);
      console.log("Segments so far:", JSON.stringify(segmentCounts));
      console.log("");
    }
  }

  await conn.end();

  console.log("\n=== COMPLETE ===");
  console.log(`Total processed:    ${processed}`);
  console.log(`Classified:         ${classified}`);
  console.log(`Omnisend synced:    ${omnisendSynced}`);
  console.log(`Errors/skipped:     ${errors}`);
  console.log("Segment breakdown:", JSON.stringify(segmentCounts, null, 2));
  console.log(`Finished: ${new Date().toISOString()}`);
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
