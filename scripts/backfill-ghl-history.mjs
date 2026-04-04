/**
 * Bulk Backfill: Pull GHL conversation history for all leads with no local conversations.
 * This ensures every lead has context before the AI engages them.
 * 
 * Usage: node scripts/backfill-ghl-history.mjs [--dry-run] [--limit N]
 */
import mysql from "mysql2/promise";
import axios from "axios";

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_BASE = "https://services.leadconnectorhq.com";
const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT_ARG = process.argv.indexOf("--limit");
const LIMIT = LIMIT_ARG !== -1 ? parseInt(process.argv[LIMIT_ARG + 1], 10) : 0;

const ghlClient = axios.create({
  baseURL: GHL_BASE,
  headers: {
    Authorization: `Bearer ${GHL_API_KEY}`,
    Version: "2021-07-28",
  },
});

// Rate limiter: GHL allows ~100 req/min, we'll do 2 req/sec to be safe
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getContactConversations(contactId) {
  const res = await ghlClient.get(`/conversations/search`, {
    params: { contactId, locationId: GHL_LOCATION_ID },
  });
  return res.data?.conversations || [];
}

async function getConversationMessages(conversationId) {
  const res = await ghlClient.get(`/conversations/${conversationId}/messages`);
  return res.data?.messages || [];
}

async function fetchGhlHistory(contactId) {
  const conversations = await getContactConversations(contactId);
  const allMessages = [];
  for (const conv of conversations) {
    try {
      const msgs = await getConversationMessages(conv.id);
      const messageList = Array.isArray(msgs) ? msgs : (msgs?.messages || []);
      for (const m of messageList) {
        allMessages.push({
          direction: m.direction || "unknown",
          type: m.type || "unknown",
          body: m.body || m.message || "",
          dateAdded: m.dateAdded || "",
        });
      }
      await sleep(500); // Rate limit between conversation fetches
    } catch { /* skip */ }
  }
  allMessages.sort((a, b) => new Date(a.dateAdded).getTime() - new Date(b.dateAdded).getTime());
  return allMessages;
}

function normalizeChannel(raw) {
  const lower = String(raw || "").toLowerCase();
  if (lower.includes("email")) return "Email";
  if (lower.includes("whatsapp")) return "WhatsApp";
  if (lower.includes("fb") || lower.includes("facebook")) return "FB";
  if (lower.includes("ig") || lower.includes("instagram")) return "IG";
  return "SMS";
}

function isFormData(body) {
  const lower = String(body || "").toLowerCase();
  return (lower.includes("full name:") && lower.includes("phone number:")) ||
         (lower.includes("what type of products") && lower.includes("how soon"));
}

// --- MAIN ---
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Find all leads with ghlContactId but no local conversations
const [leads] = await conn.execute(`
  SELECT l.id, l.ghlContactId, l.name, l.pipelineStage, l.createdAt,
         DATEDIFF(NOW(), l.createdAt) as ageDays,
         (SELECT COUNT(*) FROM conversations c WHERE c.leadId = l.id) as localMsgCount
  FROM leads l
  WHERE l.ghlContactId IS NOT NULL
  HAVING localMsgCount = 0
  ORDER BY l.createdAt ASC
  ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ""}
`);

console.log(`Found ${leads.length} leads with no local conversation history`);
if (DRY_RUN) console.log("=== DRY RUN MODE — no data will be written ===");

let totalSynced = 0;
let leadsWithHistory = 0;
let leadsWithoutHistory = 0;
let errors = 0;

for (let i = 0; i < leads.length; i++) {
  const lead = leads[i];
  const pct = ((i + 1) / leads.length * 100).toFixed(1);
  
  try {
    const ghlHistory = await fetchGhlHistory(lead.ghlContactId);
    
    if (ghlHistory.length === 0) {
      leadsWithoutHistory++;
      if (i % 50 === 0) console.log(`[${pct}%] Lead ${lead.id} (${lead.name}) — no GHL history`);
      await sleep(500);
      continue;
    }

    // Filter and store messages
    let syncedCount = 0;
    for (const m of ghlHistory) {
      if (!m.body?.trim()) continue;
      if (isFormData(m.body)) continue;

      if (!DRY_RUN) {
        await conn.execute(
          `INSERT INTO conversations (leadId, channel, direction, messageBody, senderType, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            lead.id,
            normalizeChannel(m.type),
            m.direction === "outbound" ? "outbound" : "inbound",
            m.body,
            m.direction === "outbound" ? "human" : "lead",
            m.dateAdded ? new Date(m.dateAdded) : new Date(),
          ]
        );
      }
      syncedCount++;
    }

    totalSynced += syncedCount;
    leadsWithHistory++;
    console.log(`[${pct}%] Lead ${lead.id} (${lead.name}) — synced ${syncedCount} messages (${lead.ageDays} days old, stage: ${lead.pipelineStage})`);
    
    await sleep(500); // Rate limit between leads
  } catch (err) {
    errors++;
    console.error(`[${pct}%] Lead ${lead.id} (${lead.name}) — ERROR: ${err.message}`);
    await sleep(1000); // Extra delay on error
  }
}

console.log("\n=== BACKFILL COMPLETE ===");
console.log(`Total leads processed: ${leads.length}`);
console.log(`Leads with GHL history: ${leadsWithHistory}`);
console.log(`Leads without GHL history: ${leadsWithoutHistory}`);
console.log(`Total messages synced: ${totalSynced}`);
console.log(`Errors: ${errors}`);
if (DRY_RUN) console.log("(DRY RUN — no data was written)");

await conn.end();
