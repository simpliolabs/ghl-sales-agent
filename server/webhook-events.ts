/**
 * WEBHOOK EVENT HANDLERS — Handles new GHL event types:
 * - Appointments (created, updated, cancelled, no-show, completed)
 * - Notes (agent notes → context for Brain Council)
 * - Email engagement (opened, clicked, bounced, complained, unsubscribed)
 * - Contact DND changes (per-channel DND sync)
 * - Opportunity updates (monetary value, status changes)
 *
 * All handlers follow the same pattern:
 * 1. Extract contactId from payload
 * 2. Find or skip lead in our DB
 * 3. Update relevant columns
 * 4. Log the event
 */

import { Response } from "express";
import { getDb, updateLeadFields, syncGhlDnd } from "./db";
import { leads, brainCouncilAudit, messageOutcomes } from "../drizzle/schema";
import { eq, sql, desc, and, gte, isNull } from "drizzle-orm";

// ============================================================
// APPOINTMENT HANDLER
// ============================================================
export async function handleAppointmentWebhook(payload: Record<string, unknown>, res: Response): Promise<void> {
  const contactId = (payload.contactId || payload.contact_id || "") as string;
  const event = (payload.event || payload.type || "") as string;

  if (!contactId) {
    console.log("[Webhook/Appointment] No contactId, skipping");
    res.json({ success: true, action: "appointment_no_contact" });
    return;
  }

  const db = await getDb();
  if (!db) { res.json({ success: true, action: "appointment_no_db" }); return; }

  // Find lead by GHL contact ID
  const [lead] = await db.select({ id: leads.id, name: leads.name })
    .from(leads).where(eq(leads.ghlContactId, contactId)).limit(1);

  if (!lead) {
    console.log(`[Webhook/Appointment] No lead found for contact ${contactId}`);
    res.json({ success: true, action: "appointment_lead_not_found" });
    return;
  }

  // Extract appointment data
  const appointmentId = (payload.appointmentId || payload.id || payload.calendarAppointmentId || "") as string;
  const startTime = (payload.startTime || payload.selectedTimezone || payload.appointmentStartTime || "") as string;
  const status = extractAppointmentStatus(event, payload);
  const notes = (payload.notes || payload.appointmentNotes || "") as string;

  const updates: Record<string, unknown> = {};

  if (status === "cancelled") {
    // Clear appointment data on cancellation
    updates.nextAppointmentAt = null;
    updates.appointmentStatus = "cancelled";
    console.log(`[Webhook/Appointment] Lead ${lead.id} (${lead.name}): appointment cancelled`);
  } else {
    if (startTime) {
      const parsedDate = new Date(startTime);
      if (!isNaN(parsedDate.getTime())) updates.nextAppointmentAt = parsedDate;
    }
    if (status) updates.appointmentStatus = status;
    if (appointmentId) updates.appointmentId = appointmentId;
    console.log(`[Webhook/Appointment] Lead ${lead.id} (${lead.name}): appointment ${status || "updated"} at ${startTime || "unknown time"}`);
  }

  if (Object.keys(updates).length > 0) {
    await updateLeadFields(lead.id, updates as any);
  }

  res.json({ success: true, action: "appointment_processed", leadId: lead.id, status });
}

function extractAppointmentStatus(event: string, payload: Record<string, unknown>): string {
  const e = event.toLowerCase();
  if (e.includes("cancel") || e.includes("delete")) return "cancelled";
  if (e.includes("noshow") || e.includes("no_show") || e.includes("no-show")) return "no_show";
  if (e.includes("completed") || e.includes("showed")) return "showed";
  if (e.includes("confirmed")) return "confirmed";
  if (e.includes("scheduled") || e.includes("create") || e.includes("rescheduled")) return "scheduled";
  // Fallback to payload field
  const s = (payload.appointmentStatus || payload.status || "") as string;
  if (s) return s.toLowerCase().replace(/\s+/g, "_");
  return "scheduled";
}

// ============================================================
// NOTE HANDLER
// ============================================================
export async function handleNoteWebhook(payload: Record<string, unknown>, res: Response): Promise<void> {
  const contactId = (payload.contactId || payload.contact_id || "") as string;
  const event = (payload.event || payload.type || "") as string;

  if (!contactId) {
    res.json({ success: true, action: "note_no_contact" });
    return;
  }

  // Skip delete events — we only care about new/updated notes
  if (event.includes("delete")) {
    res.json({ success: true, action: "note_delete_skipped" });
    return;
  }

  const db = await getDb();
  if (!db) { res.json({ success: true, action: "note_no_db" }); return; }

  const [lead] = await db.select({ id: leads.id, name: leads.name })
    .from(leads).where(eq(leads.ghlContactId, contactId)).limit(1);

  if (!lead) {
    res.json({ success: true, action: "note_lead_not_found" });
    return;
  }

  // Extract note content
  // Safely coerce to string — GHL sometimes sends objects for note payloads
  const rawNote = payload.noteBody ?? payload.body ?? payload.note ?? "";
  const noteBody = typeof rawNote === "string" ? rawNote : (typeof rawNote === "object" ? JSON.stringify(rawNote) : String(rawNote));
  if (!noteBody || noteBody.trim().length === 0) {
    res.json({ success: true, action: "note_empty" });
    return;
  }

  // --- SYSTEM-EVENT FILTER ---
  // Skip notes auto-generated by our own system (task/appointment setup, AI notes, etc.)
  // These bounce back from GHL as webhooks and should NOT be treated as human agent activity.
  const SYSTEM_NOTE_PREFIXES = [
    "\u{1F916}",  // 🤖 — AI/system auto-generated notes
    "[AUTO]",     // Auto-generated notes from disposition/helpers
    "[SYSTEM]",   // System-generated notes
    "[AI]",       // AI-generated notes
  ];
  const isSystemNote = SYSTEM_NOTE_PREFIXES.some(prefix => noteBody.trimStart().startsWith(prefix));

  if (isSystemNote) {
    console.log(`[Webhook/Note] Lead ${lead.id} (${lead.name}): system-generated note detected, skipping agent activity update`);
    // Still store the note content for context, but do NOT update lastAgentActivityAt
    await updateLeadFields(lead.id, {
      lastAgentNote: noteBody.substring(0, 2000),
      lastAgentNoteAt: new Date(),
    } as any);
    res.json({ success: true, action: "note_system_skipped", leadId: lead.id });
    return;
  }

  // Store the latest HUMAN agent note for Brain Council context
  await updateLeadFields(lead.id, {
    lastAgentNote: noteBody.substring(0, 2000), // cap at 2000 chars
    lastAgentNoteAt: new Date(),
    // A note from a HUMAN agent is an activity signal
    lastAgentActivityAt: new Date(),
  } as any);

  console.log(`[Webhook/Note] Lead ${lead.id} (${lead.name}): agent note saved (${noteBody.length} chars)`);
  res.json({ success: true, action: "note_saved", leadId: lead.id });
}

// ============================================================
// EMAIL EVENT HANDLER
// ============================================================
export async function handleEmailEventWebhook(payload: Record<string, unknown>, res: Response): Promise<void> {
  const contactId = (payload.contactId || payload.contact_id || "") as string;
  const event = (payload.event || payload.emailEvent || payload.type || "") as string;

  if (!contactId) {
    res.json({ success: true, action: "email_event_no_contact" });
    return;
  }

  const db = await getDb();
  if (!db) { res.json({ success: true, action: "email_event_no_db" }); return; }

  const [lead] = await db.select({
    id: leads.id, name: leads.name,
    emailOpens: leads.emailOpens, emailClicks: leads.emailClicks,
    emailBounces: leads.emailBounces,
  }).from(leads).where(eq(leads.ghlContactId, contactId)).limit(1);

  if (!lead) {
    res.json({ success: true, action: "email_event_lead_not_found" });
    return;
  }

  const e = event.toLowerCase();
  const now = new Date();

  if (e.includes("open")) {
    // Email opened — warm engagement signal
    await db.update(leads).set({
      emailOpens: sql`COALESCE(emailOpens, 0) + 1`,
      lastEmailOpenAt: now,
      lastMessageAt: now, // count as engagement
    }).where(eq(leads.id, lead.id));

    // --- Attribute email open to the most recent AI-sent email for this lead ---
    try {
      const openWindow = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // 7-day attribution window
      const [recentAudit] = await db.select({ id: brainCouncilAudit.id })
        .from(brainCouncilAudit)
        .where(and(
          eq(brainCouncilAudit.leadId, lead.id),
          eq(brainCouncilAudit.messageSent, 1),
          eq(brainCouncilAudit.channel, "Email"),
          gte(brainCouncilAudit.createdAt, openWindow),
        ))
        .orderBy(desc(brainCouncilAudit.createdAt))
        .limit(1);

      if (recentAudit) {
        // Find or create the outcome record for this audit entry
        const [existing] = await db.select({ id: messageOutcomes.id, emailOpened: messageOutcomes.emailOpened })
          .from(messageOutcomes)
          .where(eq(messageOutcomes.auditId, recentAudit.id))
          .limit(1);

        if (existing) {
          // Update existing outcome with email open data (only if not already marked)
          if (!existing.emailOpened) {
            await db.update(messageOutcomes)
              .set({ emailOpened: 1, emailOpenedAt: now })
              .where(eq(messageOutcomes.id, existing.id));
          }
        } else {
          // Create a minimal outcome record with the email open
          const [audit] = await db.select()
            .from(brainCouncilAudit)
            .where(eq(brainCouncilAudit.id, recentAudit.id))
            .limit(1);
          if (audit) {
            await db.insert(messageOutcomes).values({
              auditId: audit.id,
              leadId: lead.id,
              framework: audit.strategyFramework,
              angle: audit.strategyApproach,
              approach: audit.strategyApproach,
              channel: "Email",
              agentName: audit.composerFromName,
              emailSubject: (audit as any).emailSubject || undefined,
              emailOpened: 1,
              emailOpenedAt: now,
              gotReply: 0,
              experimentId: (audit as any).experimentId || undefined,
              variant: (audit as any).variant || undefined,
              persona: (audit as any).persona || undefined,
            });
          }
        }
        console.log(`[Webhook/Email] Lead ${lead.id}: email open attributed to audit #${recentAudit.id}`);
      }
    } catch (attrErr) {
      console.error('[Webhook/Email] Email open attribution error (non-fatal):', attrErr);
    }

    console.log(`[Webhook/Email] Lead ${lead.id} (${lead.name}): email opened (total: ${(lead.emailOpens || 0) + 1})`);

  } else if (e.includes("click")) {
    // Email link clicked — hot engagement signal
    await db.update(leads).set({
      emailClicks: sql`COALESCE(emailClicks, 0) + 1`,
      lastEmailClickAt: now,
      lastMessageAt: now,
    }).where(eq(leads.id, lead.id));
    console.log(`[Webhook/Email] Lead ${lead.id} (${lead.name}): email clicked (total: ${(lead.emailClicks || 0) + 1})`);

  } else if (e.includes("bounce")) {
    // Email bounced — channel dead signal
    await db.update(leads).set({
      emailBounces: sql`COALESCE(emailBounces, 0) + 1`,
      dndEmail: "bounced", // mark email as dead channel
      dndSyncedAt: now,
    }).where(eq(leads.id, lead.id));
    console.log(`[Webhook/Email] Lead ${lead.id} (${lead.name}): email BOUNCED — channel marked dead`);

  } else if (e.includes("complain")) {
    // Spam complaint — treat like DNC on email
    await db.update(leads).set({
      dndEmail: "complained",
      dndSyncedAt: now,
    }).where(eq(leads.id, lead.id));
    console.log(`[Webhook/Email] Lead ${lead.id} (${lead.name}): email SPAM COMPLAINT — channel blocked`);

  } else if (e.includes("unsubscrib")) {
    // Unsubscribed — DNC on email
    await db.update(leads).set({
      emailUnsubscribed: 1,
      dndEmail: "unsubscribed",
      dndSyncedAt: now,
    }).where(eq(leads.id, lead.id));
    console.log(`[Webhook/Email] Lead ${lead.id} (${lead.name}): email UNSUBSCRIBED — channel blocked`);
  }

  res.json({ success: true, action: `email_${e.split(".").pop() || "processed"}`, leadId: lead.id });
}

// ============================================================
// CONTACT DND HANDLER
// ============================================================
export async function handleContactDndWebhook(payload: Record<string, unknown>, res: Response): Promise<void> {
  const contactId = (payload.contactId || payload.contact_id || payload.id || "") as string;

  if (!contactId) {
    res.json({ success: true, action: "dnd_no_contact" });
    return;
  }

  const db = await getDb();
  if (!db) { res.json({ success: true, action: "dnd_no_db" }); return; }

  const [lead] = await db.select({ id: leads.id, name: leads.name })
    .from(leads).where(eq(leads.ghlContactId, contactId)).limit(1);

  if (!lead) {
    res.json({ success: true, action: "dnd_lead_not_found" });
    return;
  }

  // Use the existing syncGhlDnd function which handles all DND field extraction
  // The payload itself may contain dndSettings, or we need to fetch from GHL
  if (payload.dndSettings) {
    await syncGhlDnd(lead.id, payload as any);
    console.log(`[Webhook/DND] Lead ${lead.id} (${lead.name}): DND settings synced from webhook`);
  } else {
    // Fetch fresh DND from GHL API
    try {
      const { getContact } = await import("./ghl");
      const contact = await getContact(contactId);
      if (contact) {
        await syncGhlDnd(lead.id, contact);
        console.log(`[Webhook/DND] Lead ${lead.id} (${lead.name}): DND settings synced from GHL API`);
      }
    } catch (err) {
      console.error(`[Webhook/DND] Failed to sync DND for lead ${lead.id}:`, err);
    }
  }

  res.json({ success: true, action: "dnd_synced", leadId: lead.id });
}

// ============================================================
// OPPORTUNITY HANDLER
// ============================================================
export async function handleOpportunityWebhook(payload: Record<string, unknown>, res: Response): Promise<void> {
  const contactId = (payload.contactId || payload.contact_id || "") as string;
  const event = (payload.event || payload.type || "") as string;

  if (!contactId) {
    res.json({ success: true, action: "opportunity_no_contact" });
    return;
  }

  const db = await getDb();
  if (!db) { res.json({ success: true, action: "opportunity_no_db" }); return; }

  const [lead] = await db.select({ id: leads.id, name: leads.name, ghlOpportunityId: leads.ghlOpportunityId })
    .from(leads).where(eq(leads.ghlContactId, contactId)).limit(1);

  if (!lead) {
    res.json({ success: true, action: "opportunity_lead_not_found" });
    return;
  }

  const e = event.toLowerCase();
  const updates: Record<string, unknown> = {};

  // Monetary value update
  const monetaryValue = payload.monetaryValue ?? payload.monetary_value;
  if (monetaryValue !== undefined && monetaryValue !== null) {
    const numVal = typeof monetaryValue === "number" ? monetaryValue : parseFloat(String(monetaryValue));
    if (!isNaN(numVal)) {
      updates.pipelineValue = Math.round(numVal);
      updates.opportunityValue = String(Math.round(numVal));
    }
  }

  // Status update (won, lost, abandoned, open)
  const status = (payload.status || payload.opportunityStatus || "") as string;
  if (status) {
    updates.opportunityStatus = status.toLowerCase();
  }

  // Opportunity ID
  const oppId = (payload.opportunityId || payload.opportunity_id || payload.id || "") as string;
  if (oppId && !lead.ghlOpportunityId) {
    updates.ghlOpportunityId = oppId;
  }

  // Opportunity name
  const oppName = (payload.name || payload.opportunityName || "") as string;
  if (oppName) {
    updates.opportunityName = oppName;
  }

  if (Object.keys(updates).length > 0) {
    await updateLeadFields(lead.id, updates as any);
    console.log(`[Webhook/Opportunity] Lead ${lead.id} (${lead.name}): ${e} — updated: ${Object.keys(updates).join(", ")}`);
  }

  res.json({ success: true, action: "opportunity_processed", leadId: lead.id });
}
