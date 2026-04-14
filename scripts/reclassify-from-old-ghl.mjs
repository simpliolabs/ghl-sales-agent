/**
 * One-time reclassification script using the OLD GHL account API
 * Pulls full custom fields, notes, and conversation history from old GHL
 * for all transferred contacts, then classifies and syncs to Omnisend.
 *
 * Old GHL location: aWJyvzTN1mCxBzkgSFYK
 * Old GHL API key: pit-8183d251-af16-419b-981d-c834f4ae2813
 */

import axios from "axios";
import mysql from "mysql2/promise";

const OLD_GHL_KEY = "pit-8183d251-af16-419b-981d-c834f4ae2813";
const OLD_LOCATION_ID = "aWJyvzTN1mCxBzkgSFYK";
const DATABASE_URL = process.env.DATABASE_URL;
const OMNISEND_API_KEY = process.env.OMNISEND_API_KEY;
const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY;

const oldGhl = axios.create({
  baseURL: "https://services.leadconnectorhq.com",
  headers: { Authorization: "Bearer " + OLD_GHL_KEY, Version: "2021-07-28" },
  timeout: 15000,
});

const omnisend = axios.create({
  baseURL: "https://api.omnisend.com/v3",
  headers: { "X-API-KEY": OMNISEND_API_KEY, "Content-Type": "application/json" },
  timeout: 15000,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Custom field map from old GHL ──────────────────────────────────────────
let oldCfMap = {};

async function loadOldCustomFieldMap() {
  try {
    const { data } = await oldGhl.get(`/locations/${OLD_LOCATION_ID}/customFields`);
    for (const f of data.customFields || []) oldCfMap[f.id] = f.name;
    console.log(`Loaded ${Object.keys(oldCfMap).length} old custom field definitions`);
  } catch (e) {
    console.error("Failed to load old custom fields:", e.response?.status, e.message);
  }
}

function resolveOldCustomFields(rawFields) {
  if (!Array.isArray(rawFields)) return {};
  const out = {};
  for (const f of rawFields) {
    if (f.value === null || f.value === undefined || f.value === "" || (Array.isArray(f.value) && f.value.length === 0)) continue;
    const name = oldCfMap[f.id] || f.id;
    out[name] = f.value;
  }
  return out;
}

// ── Segment classification ─────────────────────────────────────────────────
const SEGMENTS = ["Church", "Sports", "School", "Trades", "Event", "Brand", "Nonprofit", "Other"];

// The key field in old GHL: "What do you want to set up an online store for?"
const STORE_FOR_MAP = {
  "sports team": "Sports",
  "sport": "Sports",
  "team": "Sports",
  "coach": "Sports",
  "league": "Sports",
  "church": "Church",
  "ministry": "Church",
  "faith": "Church",
  "religious": "Church",
  "school": "School",
  "university": "School",
  "college": "School",
  "student": "School",
  "nonprofit": "Nonprofit",
  "non-profit": "Nonprofit",
  "charity": "Nonprofit",
  "foundation": "Nonprofit",
  "501c": "Nonprofit",
  "event": "Event",
  "concert": "Event",
  "festival": "Event",
  "reunion": "Event",
  "wedding": "Event",
  "party": "Event",
  "gala": "Event",
  "contractor": "Trades",
  "construction": "Trades",
  "trade": "Trades",
  "plumb": "Trades",
  "electric": "Trades",
  "hvac": "Trades",
  "business": "Brand",
  "company": "Brand",
  "brand": "Brand",
  "corporate": "Brand",
  "startup": "Brand",
  "merch": "Brand",
  "staff": "Brand",
  "employee": "Brand",
};

function classifyFromFields(resolvedFields, tags, name, businessName) {
  // 1. Check "What do you want to set up an online store for?" field directly
  const storeFor = resolvedFields["What do you want to set up an online store for?"] || "";
  if (storeFor) {
    const lower = storeFor.toLowerCase();
    for (const [keyword, segment] of Object.entries(STORE_FOR_MAP)) {
      if (lower.includes(keyword)) return segment;
    }
  }

  // 2. Check other fields: Project Business Name, Notes, Order Categories
  const projectName = resolvedFields["Project Name"] || "";
  const businessNameField = resolvedFields["Project Business Name"] || resolvedFields["Business Name"] || businessName || "";
  const notes = resolvedFields["Notes"] || resolvedFields["Other Notes"] || resolvedFields["Other Notes:"] || "";
  const orderCategories = Array.isArray(resolvedFields["Order Categories"])
    ? resolvedFields["Order Categories"].join(" ")
    : (resolvedFields["Order Categories"] || "");

  const corpus = [projectName, businessNameField, notes, orderCategories, name || "", (tags || []).join(" ")]
    .join(" ")
    .toLowerCase();

  if (/\bchurch\b|\bpastor\b|\bministry\b|\bworship\b|\bfaith\b|\bchristian\b|\bcatholic\b|\bbaptist\b|\bchapel\b|\bcongregation\b|\bpriest\b|\bbishop\b|\bdeacon\b|\bsunday school\b|\bpentecostal\b|\btemple\b|\bsynagogue\b|\bmosque\b/.test(corpus)) return "Church";
  if (/\bschool\b|\buniversity\b|\bcollege\b|\bstudent\b|\bteacher\b|\bprincipal\b|\bclassroom\b|\bgrade\b|\bgraduat\b|\bprom\b|\bpta\b|\bbooster\b|\bacademy\b|\belementary\b|\bmiddle school\b|\bhigh school\b|\bcheerleader\b/.test(corpus)) return "School";
  if (/\bsports\b|\bteam\b|\bcoach\b|\bleague\b|\btournament\b|\bathletic\b|\bfootball\b|\bbasketball\b|\bbaseball\b|\bsoccer\b|\btrack\b|\bswim\b|\bgym\b|\bfitness\b|\byouth league\b|\beagles\b|\blions\b|\btigers\b|\bbears\b|\bwolves\b|\bwarriors\b|\bknights\b|\bfalcons\b|\bhawks\b|\bbulls\b|\brockets\b|\bstars\b|\bchargers\b|\bjaguars\b|\bpanthers\b|\bravens\b|\bsharks\b|\bgators\b|\bvipers\b|\bspartans\b|\btrojans\b|\bpatriots\b|\bbroncos\b|\bcowboys\b|\bsoftball\b|\bvolleyball\b|\bwrestl\b|\blacrosse\b|\bhockey\b|\bmartial arts\b/.test(corpus)) return "Sports";
  if (/\bnonprofit\b|\bnon-profit\b|\bcharity\b|\bfoundation\b|\bngo\b|\bvolunteer\b|\b501c\b|\bhumanitarian\b/.test(corpus)) return "Nonprofit";
  if (/\bevent\b|\bconcert\b|\bfestival\b|\breunion\b|\bwedding\b|\bbachelorette\b|\bbirthday\b|\bparty\b|\bgala\b|\bconference\b|\bexpo\b|\bprom\b|\bgraduation\b|\bholiday party\b|\bfamily reunion\b/.test(corpus)) return "Event";
  if (/\bconstruct\b|\bcontract\b|\bplumb\b|\belectric\b|\bhvac\b|\bcarpent\b|\blandscap\b|\bpaint\b|\broofer\b|\bweld\b|\bmechanic\b|\bautomot\b|\btrade\b|\bremodel\b|\bhandyman\b|\bflooring\b|\bconcrete\b|\bmasonry\b/.test(corpus)) return "Trades";
  if (/\bproduction\b|\bstudio\b|\bentertain\b|\bbrand\b|\bcompany\b|\bcorporat\b|\bbusiness\b|\bmarketing\b|\bstartup\b|\bmerch\b|\buniform\b|\bstaff\b|\bemployee\b|\bllc\b|\binc\b|\bcorp\b|\bgroup\b|\bservices\b|\bsolutions\b/.test(corpus)) return "Brand";

  return null; // Need LLM
}

async function classifyWithLLM(resolvedFields, name, businessName, tags) {
  const lines = [`Name: ${name || "unknown"}`];
  if (businessName) lines.push(`Business: ${businessName}`);
  if (tags?.length) lines.push(`Tags: ${tags.join(", ")}`);
  const fieldLines = Object.entries(resolvedFields)
    .filter(([, v]) => v && !["Project SOP Link", "Upload Artwork", "Upload Your Design Here", "Please Upload Your Design Here", "Design File"].includes(String(v)))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("\n");
  if (fieldLines) lines.push("Fields:\n" + fieldLines);

  try {
    const resp = await axios.post(
      `${FORGE_API_URL.replace(/\/$/, "")}/v1/chat/completions`,
      {
        model: "gpt-4.1-nano",
        messages: [{
          role: "user",
          content: `Classify this custom t-shirt/apparel lead into ONE segment:\n- Church: religious organizations, ministries, pastors, faith groups\n- Sports: sports teams, leagues, coaches, athletic clubs, youth sports\n- School: schools, universities, student groups, PTAs, band, cheerleaders\n- Trades: contractors, construction, trade workers, mechanics\n- Event: one-time events (concerts, reunions, weddings, parties, galas)\n- Brand: businesses, companies, corporate, startups wanting branded merch\n- Nonprofit: charities, foundations, community orgs, 501c\n- Other: unclear or individual consumer\n\n${lines.join("\n")}\n\nReply with ONLY the segment name.`,
        }],
        max_tokens: 8,
        temperature: 0,
      },
      { headers: { Authorization: `Bearer ${FORGE_API_KEY}`, "Content-Type": "application/json" }, timeout: 12000 }
    );
    const raw = resp.data.choices?.[0]?.message?.content?.trim() || "Other";
    return SEGMENTS.find((s) => raw.toLowerCase().includes(s.toLowerCase())) || "Other";
  } catch {
    return "Other";
  }
}

// ── Omnisend sync ──────────────────────────────────────────────────────────
async function syncToOmnisend(lead, segment, resolvedFields) {
  if (!lead.email) return false;
  const tags = ["transferred_contact", `segment:${segment.toLowerCase()}`];

  // Add meaningful tags from custom fields
  const storeFor = resolvedFields["What do you want to set up an online store for?"];
  if (storeFor) tags.push(`store_for:${storeFor.toLowerCase().replace(/\s+/g, "_").substring(0, 50)}`);
  const qty = resolvedFields["Item Quantity"] || resolvedFields["How Many Shirts Are You Looking To Get Printed?"] || resolvedFields["How Many Shirts?"];
  if (qty) tags.push(`qty:${qty}`);

  const nameParts = (lead.name || "").trim().split(/\s+/);
  const payload = {
    identifiers: [{ type: "email", id: lead.email, channels: { email: { status: "subscribed" } } }],
    firstName: nameParts[0] || "",
    lastName: nameParts.slice(1).join(" ") || "",
    tags,
  };
  if (lead.phone) payload.identifiers.push({ type: "phone", id: lead.phone, channels: { sms: { status: "subscribed" } } });

  try {
    await omnisend.post("/contacts", payload);
    return true;
  } catch (err) {
    if (err.response?.status === 409) {
      try {
        await omnisend.patch(`/contacts/${encodeURIComponent(lead.email)}`, { tags });
        return true;
      } catch { return false; }
    }
    return false;
  }
}

// ── CSV lookup map (old GHL contact ID → row data) ─────────────────────────
import { createReadStream } from "fs";
import { createInterface } from "readline";

function parseCsvLine(line) {
  const result = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') { inQuote = true; }
      else if (ch === ',') { result.push(cur); cur = ""; }
      else { cur += ch; }
    }
  }
  result.push(cur);
  return result;
}

async function loadCsvMap() {
  const map = {}; // oldGhlId → { firstName, lastName, email, phone, businessName, tags }
  const rl = createInterface({ input: createReadStream("/home/ubuntu/upload/Export_Contacts_undefined_Apr_2026_3_11_PM.csv") });
  let header = null;
  for await (const line of rl) {
    const cols = parseCsvLine(line);
    if (!header) { header = cols; continue; }
    const row = {};
    header.forEach((h, i) => (row[h] = (cols[i] || "").trim()));
    if (row["Contact Id"]) map[row["Contact Id"]] = row;
  }
  console.log(`Loaded ${Object.keys(map).length} contacts from CSV`);
  return map;
}

// ── Main ───────────────────────────────────────────────────────────────────
const CONCURRENCY = 15;

async function processContact(lead, csvMap, conn) {
  try {
    // Try to find the old GHL contact ID
    // The transferred contacts have ghlContactId pointing to the NEW account
    // We need to match by phone or email to find the old GHL record
    const csvRow = Object.values(csvMap).find((row) => {
      if (lead.email && row["Email"] && lead.email.toLowerCase() === row["Email"].toLowerCase()) return true;
      if (lead.phone && row["Phone"]) {
        const clean = (p) => p.replace(/\D/g, "").slice(-10);
        if (clean(lead.phone) === clean(row["Phone"])) return true;
      }
      return false;
    });

    const oldContactId = csvRow?.["Contact Id"] || null;

    // Pull full data from old GHL API
    let oldContact = null;
    let resolvedFields = {};
    let oldNotes = [];
    let oldTags = [];
    let oldBusinessName = null;

    if (oldContactId) {
      try {
        const { data } = await oldGhl.get(`/contacts/${oldContactId}`);
        oldContact = data.contact;
        resolvedFields = resolveOldCustomFields(oldContact?.customFields || []);
        const rawTags = oldContact?.tags || [];
        oldTags = Array.isArray(rawTags) ? rawTags : (typeof rawTags === "string" ? rawTags.split(",").map(t => t.trim()).filter(Boolean) : []);
        oldBusinessName = oldContact?.companyName || null;
      } catch (e) {
        if (e.response?.status === 429) await sleep(3000);
      }

      // Fetch notes from old GHL
      try {
        const { data } = await oldGhl.get(`/contacts/${oldContactId}/notes`);
        oldNotes = (data.notes || []).map((n) => ({ body: (n.body || "").substring(0, 400), dateAdded: n.dateAdded }));
      } catch { /* ignore */ }
    }

    // Classify
    const name = lead.name || `${csvRow?.["First Name"] || ""} ${csvRow?.["Last Name"] || ""}`.trim();
    const businessName = oldBusinessName || csvRow?.["Business Name"] || null;
    const csvTags = csvRow?.["Tags"] ? csvRow["Tags"].split(",").map((t) => t.trim()).filter(Boolean) : [];
    const rawOldTags = Array.isArray(oldTags) ? oldTags : (typeof oldTags === "string" ? oldTags.split(",").map(t => t.trim()).filter(Boolean) : []);
    const allTags = [...new Set([...rawOldTags, ...csvTags])];

    let segment = classifyFromFields(resolvedFields, allTags, name, businessName);
    if (!segment) {
      // Check if there's enough signal for LLM
      const hasSignal = Object.keys(resolvedFields).length > 0 || businessName || allTags.length > 0;
      segment = hasSignal ? await classifyWithLLM(resolvedFields, name, businessName, allTags) : "Other";
    }

    // Update DB with enriched data from old GHL
    const existingRd = lead.researchData || {};
    const updatedRd = {
      ...existingRd,
      transferredContact: {
        ...(existingRd.transferredContact || {}),
        resolvedCustomFields: resolvedFields,
        oldGhlCustomFields: oldContact?.customFields || [],
        oldGhlTags: allTags,
        oldGhlCompanyName: oldBusinessName,
        oldGhlContactId: oldContactId,
        oldGhlNotes: oldNotes,
      },
      classifiedSegment: segment,
      enrichedFromOldGhl: true,
      enrichedAt: new Date().toISOString(),
    };

    await conn.execute(
      `UPDATE leads SET omnisendSegment = ?, researchData = ?, businessName = COALESCE(NULLIF(businessName,''), ?) WHERE id = ?`,
      [segment.toLowerCase(), JSON.stringify(updatedRd), businessName || null, lead.id]
    );

    const synced = await syncToOmnisend({ email: lead.email, phone: lead.phone, name }, segment, resolvedFields);

    return { status: "ok", segment, fields: Object.keys(resolvedFields).length, notes: oldNotes.length, omnisend: synced, oldId: oldContactId };
  } catch (err) {
    if (process.env.VERBOSE) console.error(`  ERROR [${lead.id}] ${lead.name}: ${err.message}`);
    return { status: "error", reason: err.message };
  }
}

async function main() {
  console.log("=== Reclassify from Old GHL Account ===");
  console.log(`Started: ${new Date().toISOString()}\n`);

  const conn = await mysql.createConnection(DATABASE_URL);
  await loadOldCustomFieldMap();
  const csvMap = await loadCsvMap();
  await sleep(500);

  // Process ALL unenriched contacts: transferred_contact, source='r', source='Facebook' with null researchData
  const [leads] = await conn.execute(`
    SELECT id, name, email, phone, ghlContactId, researchData, source
    FROM leads
    WHERE (
      source = 'transferred_contact'
      OR (source = 'r' AND (researchData IS NULL OR CAST(researchData AS CHAR) = 'null' OR researchData = ''))
      OR (source = 'Facebook' AND (researchData IS NULL OR CAST(researchData AS CHAR) = 'null' OR researchData = ''))
      OR (source = 'ghl' AND (researchData IS NULL OR CAST(researchData AS CHAR) = 'null' OR researchData = ''))
      OR (source = 'fb' AND (researchData IS NULL OR CAST(researchData AS CHAR) = 'null' OR researchData = ''))
    )
    ORDER BY id ASC
  `);

  console.log(`Processing ${leads.length} contacts (transferred + unenriched r/Facebook/ghl/fb)\n`);

  let processed = 0, errors = 0, omnisendSynced = 0;
  const segmentCounts = {};

  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const batch = leads.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((lead) => processContact(lead, csvMap, conn)));

    for (const r of results) {
      processed++;
      if (r.status === "error") {
        errors++;
      } else {
        segmentCounts[r.segment] = (segmentCounts[r.segment] || 0) + 1;
        if (r.omnisend) omnisendSynced++;
      }
    }

    if (processed % 100 === 0 || processed === leads.length) {
      console.log(`Progress: ${processed}/${leads.length} | Errors: ${errors} | Omnisend: ${omnisendSynced}`);
      console.log("Segments so far:", JSON.stringify(segmentCounts));
    }

    // Rate limit: 15 concurrent, then short pause
    await sleep(400);
  }

  console.log("\n=== COMPLETE ===");
  console.log(`Total: ${processed} | Errors: ${errors} | Omnisend synced: ${omnisendSynced}`);
  console.log("Final segments:", JSON.stringify(segmentCounts, null, 2));
  await conn.end();
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
