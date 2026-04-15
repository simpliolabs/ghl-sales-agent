/**
 * EVENT-DRIVEN TRIGGERS — Module 5A (YaoApp Six-Phase Model)
 *
 * Instead of waiting for the next scheduled follow-up, the system reacts to
 * behavioral signals in real-time:
 *
 * TRIGGER 1: Email Opened but No Reply (48h)
 *   Lead opened our email but didn't respond within 48 hours.
 *   → Reschedule follow-up to NOW (or next business hour) with a "warm re-engage" hint.
 *
 * TRIGGER 2: Email Link Clicked (4h)
 *   Lead clicked a link in our email — high intent signal.
 *   → Reschedule follow-up to 4 hours from click with a "hot follow-up" hint.
 *
 * TRIGGER 3: Quote Sent but No Response (48h)
 *   Lead reached "Quote Sent" stage but hasn't replied in 48 hours.
 *   → Reschedule follow-up to NOW with a "quote follow-up" hint.
 *
 * TRIGGER 4: Engaged then Went Silent (72h)
 *   Lead had 2+ back-and-forth exchanges then went silent for 72 hours.
 *   → Reschedule follow-up to NOW with a "re-engage after conversation" hint.
 *
 * This cron runs every 30 minutes and scans for leads matching each trigger.
 * It does NOT send messages directly — it reschedules the nextFollowUpAt so the
 * existing follow-up-trigger.ts picks them up on its next cycle.
 *
 * The trigger type is stored in a new `lastEventTrigger` field so the Strategist
 * can use it as context (e.g., "this lead opened your email 2 days ago but didn't reply").
 */

import { getDb } from "./db";
import { leads } from "../drizzle/schema";
import { eq, and, sql, isNull, isNotNull } from "drizzle-orm";
import { updateLeadFields } from "./db";

// --- TRIGGER TYPES ---
export type EventTriggerType =
  | "email_opened_no_reply"
  | "email_link_clicked"
  | "quote_sent_no_response"
  | "engaged_then_silent";

interface TriggerResult {
  trigger: EventTriggerType;
  leadId: number;
  leadName: string | null;
  previousNextFollowUp: Date | null;
  newNextFollowUp: Date;
}

// --- MAIN PROCESSOR ---
export async function processEventDrivenTriggers(): Promise<{
  triggered: number;
  skipped: number;
  errors: number;
  details: TriggerResult[];
}> {
  const results: TriggerResult[] = [];
  let skipped = 0;
  let errors = 0;

  try {
    const t1 = await processEmailOpenedNoReply();
    results.push(...t1.results);
    skipped += t1.skipped;
    errors += t1.errors;
  } catch (err) {
    console.error("[EventTrigger] Error in email_opened_no_reply:", err);
    errors++;
  }

  try {
    const t2 = await processEmailLinkClicked();
    results.push(...t2.results);
    skipped += t2.skipped;
    errors += t2.errors;
  } catch (err) {
    console.error("[EventTrigger] Error in email_link_clicked:", err);
    errors++;
  }

  try {
    const t3 = await processQuoteSentNoResponse();
    results.push(...t3.results);
    skipped += t3.skipped;
    errors += t3.errors;
  } catch (err) {
    console.error("[EventTrigger] Error in quote_sent_no_response:", err);
    errors++;
  }

  try {
    const t4 = await processEngagedThenSilent();
    results.push(...t4.results);
    skipped += t4.skipped;
    errors += t4.errors;
  } catch (err) {
    console.error("[EventTrigger] Error in engaged_then_silent:", err);
    errors++;
  }

  return { triggered: results.length, skipped, errors, details: results };
}

// ============================================================
// TRIGGER 1: Email Opened but No Reply (48h)
// ============================================================
async function processEmailOpenedNoReply(): Promise<{ results: TriggerResult[]; skipped: number; errors: number }> {
  const db = await getDb();
  if (!db) return { results: [], skipped: 0, errors: 0 };

  const results: TriggerResult[] = [];
  let skipped = 0, errors = 0;

  // Find leads where:
  // - lastEmailOpenAt is within the last 7 days (recent engagement)
  // - lastEmailOpenAt is at least 48h ago (gave them time to reply)
  // - lastMessageAt < lastEmailOpenAt (they haven't replied since opening)
  // - humanTakeover = 0 (not in human handoff)
  // - nextFollowUpAt is in the future (hasn't been rescheduled yet)
  // - pipelineStage not terminal
  // - lastEventTrigger != 'email_opened_no_reply' (prevent re-triggering)
  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const now = new Date();

  const candidates = await db.select({
    id: leads.id,
    name: leads.name,
    lastEmailOpenAt: leads.lastEmailOpenAt,
    lastMessageAt: leads.lastMessageAt,
    nextFollowUpAt: leads.nextFollowUpAt,
    lastEventTrigger: leads.lastEventTrigger,
  }).from(leads).where(and(
    sql`${leads.lastEmailOpenAt} IS NOT NULL`,
    sql`${leads.lastEmailOpenAt} >= ${sevenDaysAgo}`,
    sql`${leads.lastEmailOpenAt} <= ${fortyEightHoursAgo}`,
    sql`COALESCE(${leads.lastMessageAt}, '2000-01-01') < ${leads.lastEmailOpenAt}`,
    eq(leads.humanTakeover, 0),
    sql`${leads.nextFollowUpAt} > NOW()`,
    sql`COALESCE(${leads.pipelineStage}, 'new_lead') NOT IN ('not_qualified', 'lost')`,
    sql`COALESCE(${leads.lastEventTrigger}, '') != 'email_opened_no_reply'`,
  )).limit(10);

  for (const lead of candidates) {
    try {
      const newFollowUp = new Date(Math.max(now.getTime(), Date.now()));
      await updateLeadFields(lead.id, {
        nextFollowUpAt: newFollowUp,
        lastEventTrigger: "email_opened_no_reply" as any,
        lastEventTriggerAt: now as any,
      });
      results.push({
        trigger: "email_opened_no_reply",
        leadId: lead.id,
        leadName: lead.name,
        previousNextFollowUp: lead.nextFollowUpAt,
        newNextFollowUp: newFollowUp,
      });
      console.log(`[EventTrigger] 📧 email_opened_no_reply: Lead ${lead.id} (${lead.name}) — opened email ${Math.round((Date.now() - new Date(lead.lastEmailOpenAt!).getTime()) / 3600000)}h ago, rescheduled to NOW`);
    } catch (err) {
      console.error(`[EventTrigger] Error processing lead ${lead.id} for email_opened_no_reply:`, err);
      errors++;
    }
  }

  return { results, skipped, errors };
}

// ============================================================
// TRIGGER 2: Email Link Clicked (4h)
// ============================================================
async function processEmailLinkClicked(): Promise<{ results: TriggerResult[]; skipped: number; errors: number }> {
  const db = await getDb();
  if (!db) return { results: [], skipped: 0, errors: 0 };

  const results: TriggerResult[] = [];
  let skipped = 0, errors = 0;

  // Find leads where:
  // - lastEmailClickAt is within the last 24h (recent hot signal)
  // - lastEmailClickAt is at least 4h ago (give them time to convert)
  // - lastMessageAt < lastEmailClickAt (they haven't replied since clicking)
  // - humanTakeover = 0
  // - nextFollowUpAt is more than 4h from now (would otherwise wait too long)
  // - lastEventTrigger != 'email_link_clicked' (prevent re-triggering)
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const fourHoursFromNow = new Date(Date.now() + 4 * 60 * 60 * 1000);
  const now = new Date();

  const candidates = await db.select({
    id: leads.id,
    name: leads.name,
    lastEmailClickAt: leads.lastEmailClickAt,
    lastMessageAt: leads.lastMessageAt,
    nextFollowUpAt: leads.nextFollowUpAt,
    lastEventTrigger: leads.lastEventTrigger,
  }).from(leads).where(and(
    sql`${leads.lastEmailClickAt} IS NOT NULL`,
    sql`${leads.lastEmailClickAt} >= ${twentyFourHoursAgo}`,
    sql`${leads.lastEmailClickAt} <= ${fourHoursAgo}`,
    sql`COALESCE(${leads.lastMessageAt}, '2000-01-01') < ${leads.lastEmailClickAt}`,
    eq(leads.humanTakeover, 0),
    sql`${leads.nextFollowUpAt} > ${fourHoursFromNow}`,
    sql`COALESCE(${leads.pipelineStage}, 'new_lead') NOT IN ('not_qualified', 'lost')`,
    sql`COALESCE(${leads.lastEventTrigger}, '') != 'email_link_clicked'`,
  )).limit(10);

  for (const lead of candidates) {
    try {
      const newFollowUp = new Date(Math.max(now.getTime(), Date.now()));
      await updateLeadFields(lead.id, {
        nextFollowUpAt: newFollowUp,
        lastEventTrigger: "email_link_clicked" as any,
        lastEventTriggerAt: now as any,
      });
      results.push({
        trigger: "email_link_clicked",
        leadId: lead.id,
        leadName: lead.name,
        previousNextFollowUp: lead.nextFollowUpAt,
        newNextFollowUp: newFollowUp,
      });
      console.log(`[EventTrigger] 🔗 email_link_clicked: Lead ${lead.id} (${lead.name}) — clicked link ${Math.round((Date.now() - new Date(lead.lastEmailClickAt!).getTime()) / 3600000)}h ago, rescheduled to NOW`);
    } catch (err) {
      console.error(`[EventTrigger] Error processing lead ${lead.id} for email_link_clicked:`, err);
      errors++;
    }
  }

  return { results, skipped, errors };
}

// ============================================================
// TRIGGER 3: Quote Sent but No Response (48h)
// ============================================================
async function processQuoteSentNoResponse(): Promise<{ results: TriggerResult[]; skipped: number; errors: number }> {
  const db = await getDb();
  if (!db) return { results: [], skipped: 0, errors: 0 };

  const results: TriggerResult[] = [];
  let skipped = 0, errors = 0;

  // Find leads where:
  // - pipelineStage = 'Quote Sent' or 'quote_sent'
  // - lastOutboundAt (or lastMessageAt) is at least 48h ago
  // - humanTakeover = 0
  // - nextFollowUpAt is in the future (not already overdue)
  // - lastEventTrigger != 'quote_sent_no_response'
  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const now = new Date();

  const candidates = await db.select({
    id: leads.id,
    name: leads.name,
    pipelineStage: leads.pipelineStage,
    lastMessageAt: leads.lastMessageAt,
    nextFollowUpAt: leads.nextFollowUpAt,
    lastEventTrigger: leads.lastEventTrigger,
  }).from(leads).where(and(
    sql`COALESCE(${leads.pipelineStage}, '') IN ('Quote Sent', 'quote_sent')`,
    sql`COALESCE(${leads.lastMessageAt}, '2000-01-01') <= ${fortyEightHoursAgo}`,
    eq(leads.humanTakeover, 0),
    sql`${leads.nextFollowUpAt} > NOW()`,
    sql`COALESCE(${leads.lastEventTrigger}, '') != 'quote_sent_no_response'`,
  )).limit(10);

  for (const lead of candidates) {
    try {
      const newFollowUp = new Date(Math.max(now.getTime(), Date.now()));
      await updateLeadFields(lead.id, {
        nextFollowUpAt: newFollowUp,
        lastEventTrigger: "quote_sent_no_response" as any,
        lastEventTriggerAt: now as any,
      });
      results.push({
        trigger: "quote_sent_no_response",
        leadId: lead.id,
        leadName: lead.name,
        previousNextFollowUp: lead.nextFollowUpAt,
        newNextFollowUp: newFollowUp,
      });
      console.log(`[EventTrigger] 📋 quote_sent_no_response: Lead ${lead.id} (${lead.name}) — quote sent, no reply in 48h, rescheduled to NOW`);
    } catch (err) {
      console.error(`[EventTrigger] Error processing lead ${lead.id} for quote_sent_no_response:`, err);
      errors++;
    }
  }

  return { results, skipped, errors };
}

// ============================================================
// TRIGGER 4: Engaged then Went Silent (72h)
// ============================================================
async function processEngagedThenSilent(): Promise<{ results: TriggerResult[]; skipped: number; errors: number }> {
  const db = await getDb();
  if (!db) return { results: [], skipped: 0, errors: 0 };

  const results: TriggerResult[] = [];
  let skipped = 0, errors = 0;

  // Find leads where:
  // - They have had meaningful engagement (opportunityScore >= 40 indicates back-and-forth)
  // - lastMessageAt is 72h-14d ago (went silent after engagement, not ancient)
  // - humanTakeover = 0
  // - nextFollowUpAt is more than 24h from now (would otherwise wait too long)
  // - pipelineStage not terminal
  // - lastEventTrigger != 'engaged_then_silent'
  const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const twentyFourHoursFromNow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const now = new Date();

  const candidates = await db.select({
    id: leads.id,
    name: leads.name,
    opportunityScore: leads.opportunityScore,
    lastMessageAt: leads.lastMessageAt,
    nextFollowUpAt: leads.nextFollowUpAt,
    lastEventTrigger: leads.lastEventTrigger,
  }).from(leads).where(and(
    sql`COALESCE(${leads.opportunityScore}, 0) >= 40`,
    sql`${leads.lastMessageAt} IS NOT NULL`,
    sql`${leads.lastMessageAt} <= ${seventyTwoHoursAgo}`,
    sql`${leads.lastMessageAt} >= ${fourteenDaysAgo}`,
    eq(leads.humanTakeover, 0),
    sql`${leads.nextFollowUpAt} > ${twentyFourHoursFromNow}`,
    sql`COALESCE(${leads.pipelineStage}, 'new_lead') NOT IN ('not_qualified', 'lost')`,
    sql`COALESCE(${leads.lastEventTrigger}, '') != 'engaged_then_silent'`,
  )).limit(10);

  for (const lead of candidates) {
    try {
      const newFollowUp = new Date(Math.max(now.getTime(), Date.now()));
      await updateLeadFields(lead.id, {
        nextFollowUpAt: newFollowUp,
        lastEventTrigger: "engaged_then_silent" as any,
        lastEventTriggerAt: now as any,
      });
      results.push({
        trigger: "engaged_then_silent",
        leadId: lead.id,
        leadName: lead.name,
        previousNextFollowUp: lead.nextFollowUpAt,
        newNextFollowUp: newFollowUp,
      });
      console.log(`[EventTrigger] 🔕 engaged_then_silent: Lead ${lead.id} (${lead.name}) — score ${lead.opportunityScore}, silent ${Math.round((Date.now() - new Date(lead.lastMessageAt!).getTime()) / 3600000)}h, rescheduled to NOW`);
    } catch (err) {
      console.error(`[EventTrigger] Error processing lead ${lead.id} for engaged_then_silent:`, err);
      errors++;
    }
  }

  return { results, skipped, errors };
}

// ============================================================
// STRATEGIST CONTEXT INJECTION
// ============================================================
/**
 * Build a context string for the Strategist describing the event trigger
 * that caused this lead to be rescheduled. Returns empty string if no trigger.
 */
export function buildEventTriggerContext(lead: {
  lastEventTrigger?: string | null;
  lastEventTriggerAt?: Date | string | null;
  lastEmailOpenAt?: Date | string | null;
  lastEmailClickAt?: Date | string | null;
}): string {
  if (!lead.lastEventTrigger) return "";

  const triggerAge = lead.lastEventTriggerAt
    ? Math.round((Date.now() - new Date(lead.lastEventTriggerAt).getTime()) / 3600000)
    : null;

  switch (lead.lastEventTrigger) {
    case "email_opened_no_reply":
      return `⚡ EVENT TRIGGER: This lead OPENED your email ${triggerAge ? `${triggerAge}h ago` : "recently"} but did NOT reply. They are interested but hesitant. Use a warm, low-pressure follow-up that references the email content. Do NOT repeat the same email — add new value or ask a simple question.`;

    case "email_link_clicked":
      return `🔥 EVENT TRIGGER: This lead CLICKED A LINK in your email ${triggerAge ? `${triggerAge}h ago` : "recently"} — this is a HOT intent signal. They are actively researching. Follow up with specifics related to what they clicked. Be direct and offer to help with next steps.`;

    case "quote_sent_no_response":
      return `📋 EVENT TRIGGER: A quote was sent to this lead but they haven't responded in 48+ hours. They may have questions, concerns about price, or are comparing options. Follow up by addressing common objections (timeline, pricing flexibility, quality guarantees) without being pushy.`;

    case "engaged_then_silent":
      return `🔕 EVENT TRIGGER: This lead was actively engaged in conversation (score ${triggerAge ? `triggered ${triggerAge}h ago` : ""}) but went silent for 72+ hours. They may be busy, distracted, or lost interest. Use a brief, friendly check-in that references your last conversation topic. Keep it short — one question max.`;

    default:
      return "";
  }
}
