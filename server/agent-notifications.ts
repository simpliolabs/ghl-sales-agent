/**
 * AGENT NOTIFICATIONS — Centralized two-phase appointment/task/note model
 *
 * This module is the SINGLE source of truth for creating and updating
 * agent notifications (appointments, tasks, internal notes) in GHL.
 *
 * TWO PHASES:
 *   Phase 1 — "Heads-Up" (on first contact):
 *     Creates ONE appointment (next biz hour, 10 min) + ONE task + ONE internal note.
 *     Saves the GHL appointment ID and task ID to the leads table.
 *
 *   Phase 2 — "Escalate" (on handoff / committed):
 *     UPDATES the existing appointment + task to reflect the new status
 *     (e.g., "needs live quote"). Adds a NEW note (notes are append-only).
 *     Does NOT create duplicates.
 *
 * NO OTHER FILE should create appointments or tasks. All creation/update
 * flows go through this module.
 */

import { updateLeadFields, getConversationHistory } from "./db";
import {
  createTask,
  updateTask,
  createAppointment,
  updateAppointment,
  addNote,
  getNextBusinessHoursSlot,
  toETOffsetString,
  AGENT_CALENDAR_IDS,
  AGENT_GHL_USER_IDS,
} from "./ghl";
import { SALES_AGENTS } from "./webhook-helpers";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentNotificationContext {
  leadId: number;
  ghlContactId: string;
  leadName: string | null;
  businessName: string | null;
  email: string | null;
  phone: string | null;
  assignedAgent: string | null;
  pipelineValue: number | null;
  channel: string;
  /** Current pipeline stage — used to block appointment creation for lost/disqualified leads */
  pipelineStage?: string | null;
  /** Existing GHL appointment ID (null if none created yet) */
  existingAppointmentId: string | null;
  /** Existing GHL task ID (null if none created yet) */
  existingTaskId: string | null;
}

export interface NotificationResult {
  actions: string[];
  errors: string[];
  appointmentId: string | null;
  taskId: string | null;
}

// Stages where we must NEVER create new appointments or tasks.
// GHL may send mixed-case values (e.g. "Lost"), so always compare lowercase.
const LOST_STAGES = new Set(["not_qualified", "lost", "dnc", "competitor_won"]);

function isLostStage(stage: string | null | undefined): boolean {
  return !!stage && LOST_STAGES.has(stage.toLowerCase());
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function buildConversationSummary(leadId: number, leadName: string | null): Promise<string> {
  try {
    const history = await getConversationHistory(leadId, 20);
    if (history.length === 0) return "";
    const recent = history.slice(0, 10).reverse();
    return recent.map((m: any) => {
      const who = m.direction === "inbound" ? (leadName || "Customer") : "AI (Abby)";
      const time = m.timestamp
        ? new Date(m.timestamp).toLocaleString("en-US", {
            timeZone: "America/New_York",
            month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
          })
        : "";
      return `[${time}] ${who}: ${(m.messageBody || "").slice(0, 200)}`;
    }).join("\n");
  } catch {
    return "";
  }
}

// ─── Phase 1: Heads-Up (First Contact) ─────────────────────────────────────

/**
 * Called when a new contact first engages. Creates:
 * - ONE 10-min appointment at the next business-hours slot
 * - ONE task for the assigned agent
 * - ONE internal note
 * Saves the IDs to the leads table.
 *
 * IDEMPOTENT: If appointment/task already exist, skips creation.
 * GUARD: Never creates appointments for lost/disqualified leads.
 */
export async function createHeadsUpNotification(
  ctx: AgentNotificationContext,
  reason: string = "New inquiry received",
): Promise<NotificationResult> {
  const actions: string[] = [];
  const errors: string[] = [];
  const leadLabel = ctx.leadName || ctx.businessName || `Lead #${ctx.leadId}`;
  const agent = ctx.assignedAgent || SALES_AGENTS[0];
  let appointmentId = ctx.existingAppointmentId;
  let taskId = ctx.existingTaskId;

  // Skip if both already exist (idempotent)
  if (appointmentId && taskId) {
    console.log(`[AgentNotify] Lead ${ctx.leadId}: Heads-up already exists (appt=${appointmentId}, task=${taskId}) — skipping`);
    return { actions: ["Heads-up already exists — skipped"], errors: [], appointmentId, taskId };
  }

  // GUARD: Never create appointments for lost/disqualified leads.
  // This prevents spurious appointments when a lost lead sends a final reply
  // (e.g., "All done", "Thanks") after being marked Lost/Not Qualified.
  if (isLostStage(ctx.pipelineStage)) {
    console.log(`[AgentNotify] Lead ${ctx.leadId}: Skipping heads-up — lead is in lost/disqualified stage (${ctx.pipelineStage})`);
    return { actions: [`Skipped — lead is ${ctx.pipelineStage}`], errors: [], appointmentId: null, taskId: null };
  }

  const conversationSummary = await buildConversationSummary(ctx.leadId, ctx.leadName);

  // 1. Create appointment (10-min slot at next business hours)
  if (!appointmentId) {
    try {
      const slot = getNextBusinessHoursSlot(new Date(), agent);
      const calendarId = AGENT_CALENDAR_IDS[agent] || AGENT_CALENDAR_IDS["Abby Bouwer"];
      const userId = AGENT_GHL_USER_IDS[agent];
      const endTime = new Date(slot.start.getTime() + 10 * 60 * 1000); // 10-min appointment

      const result = await createAppointment({
        calendarId,
        contactId: ctx.ghlContactId,
        title: `📋 New inquiry: ${leadLabel}`,
        description: [
          `New contact inquiry — heads-up for agent.`,
          ``,
          `Contact: ${ctx.leadName || "N/A"}`,
          `Business: ${ctx.businessName || "N/A"}`,
          `Phone: ${ctx.phone || "N/A"} | Email: ${ctx.email || "N/A"}`,
          `Channel: ${ctx.channel}`,
          `Reason: ${reason}`,
          ...(conversationSummary ? [``, `--- Conversation ---`, conversationSummary] : []),
        ].join("\n"),
        startTime: toETOffsetString(slot.start),
        endTime: toETOffsetString(endTime),
        assignedUserId: userId,
      });

      appointmentId = result?.id || result?.event?.id || null;
      if (appointmentId) {
        actions.push(`Created heads-up appointment for ${agent} at ${toETOffsetString(slot.start)}`);
        console.log(`[AgentNotify] Lead ${ctx.leadId}: Created appointment ${appointmentId}`);
      } else {
        // GHL may return the ID in different shapes — log for debugging
        console.warn(`[AgentNotify] Lead ${ctx.leadId}: Appointment created but no ID returned`, JSON.stringify(result)?.slice(0, 300));
        actions.push(`Created heads-up appointment for ${agent} (no ID captured)`);
      }
    } catch (err: any) {
      errors.push(`Failed to create appointment: ${err?.message}`);
      console.error(`[AgentNotify] Lead ${ctx.leadId}: Failed to create appointment:`, err);
    }
  }

  // 2. Create task
  if (!taskId) {
    try {
      const slot = getNextBusinessHoursSlot(new Date(), agent);
      const result = await createTask(ctx.ghlContactId, {
        title: `📋 New inquiry: ${leadLabel}`,
        body: [
          `New contact inquiry — review and be ready to engage.`,
          ``,
          `Contact: ${ctx.leadName || "N/A"}`,
          `Business: ${ctx.businessName || "N/A"}`,
          `Phone: ${ctx.phone || "N/A"} | Email: ${ctx.email || "N/A"}`,
          `Channel: ${ctx.channel}`,
          `Estimated Value: $${ctx.pipelineValue || "TBD"}`,
          ``,
          `The AI is handling initial engagement. This task is a heads-up.`,
          `If the customer needs a live quote, this task will be updated.`,
          ...(conversationSummary ? [``, `--- Conversation ---`, conversationSummary] : []),
        ].join("\n"),
        dueDate: toETOffsetString(slot.start),
        assignedTo: agent,
      });

      taskId = result?.task?.id || result?.id || null;
      if (taskId) {
        actions.push(`Created heads-up task for ${agent}`);
        console.log(`[AgentNotify] Lead ${ctx.leadId}: Created task ${taskId}`);
      } else {
        console.warn(`[AgentNotify] Lead ${ctx.leadId}: Task created but no ID returned`, JSON.stringify(result)?.slice(0, 300));
        actions.push(`Created heads-up task for ${agent} (no ID captured)`);
      }
    } catch (err: any) {
      errors.push(`Failed to create task: ${err?.message}`);
      console.error(`[AgentNotify] Lead ${ctx.leadId}: Failed to create task:`, err);
    }
  }

  // 3. Add internal note
  try {
    await addNote(ctx.ghlContactId,
      [
        `🤖 AI: New inquiry received`,
        `Contact: ${leadLabel}${ctx.businessName ? ` (${ctx.businessName})` : ""}`,
        `Channel: ${ctx.channel}`,
        `Reason: ${reason}`,
        ``,
        `A 10-min appointment and task have been created for ${agent}.`,
        `AI is handling initial engagement.`,
      ].join("\n")
    );
    actions.push("Added heads-up note to GHL");
  } catch { /* best effort */ }

  // 4. Save IDs to leads table
  try {
    const updates: Record<string, any> = {};
    if (appointmentId) updates.appointmentId = appointmentId;
    if (taskId) updates.ghlTaskId = taskId;
    if (Object.keys(updates).length > 0) {
      await updateLeadFields(ctx.leadId, updates);
    }
  } catch (err: any) {
    errors.push(`Failed to save notification IDs: ${err?.message}`);
  }

  return { actions, errors, appointmentId, taskId };
}

// ─── Phase 2: Escalate (Handoff / Committed) ──────────────────────────────

/**
 * Called when the lead status escalates (committed, human_active).
 * UPDATES the existing appointment + task to reflect the new status.
 * Adds a NEW note (notes are append-only in GHL).
 *
 * If no existing appointment/task, creates them (fallback).
 * GUARD: Never creates/updates appointments for lost/disqualified leads.
 */
export async function escalateNotification(
  ctx: AgentNotificationContext,
  escalationType: "committed" | "human_handoff",
  reason: string,
  intent?: { intent: string; confidence: number; reasoning: string },
): Promise<NotificationResult> {
  const actions: string[] = [];
  const errors: string[] = [];
  const leadLabel = ctx.leadName || ctx.businessName || `Lead #${ctx.leadId}`;
  const agent = ctx.assignedAgent || SALES_AGENTS[0];
  let appointmentId = ctx.existingAppointmentId;
  let taskId = ctx.existingTaskId;

  // GUARD: Never escalate appointments for lost/disqualified leads.
  if (isLostStage(ctx.pipelineStage)) {
    console.log(`[AgentNotify] Lead ${ctx.leadId}: Skipping escalation — lead is in lost/disqualified stage (${ctx.pipelineStage})`);
    return { actions: [`Skipped escalation — lead is ${ctx.pipelineStage}`], errors: [], appointmentId: null, taskId: null };
  }

  const conversationSummary = await buildConversationSummary(ctx.leadId, ctx.leadName);

  const isCommitted = escalationType === "committed";
  const titleEmoji = isCommitted ? "🔥" : "📞";
  const titleAction = isCommitted ? "Close deal" : "Handoff — Live quote needed";
  const statusLabel = isCommitted ? "COMMITTED — Ready to close" : "HANDOFF — Needs live agent";

  // ── Update or create appointment ──
  if (appointmentId) {
    // UPDATE existing appointment
    try {
      const slot = getNextBusinessHoursSlot(new Date(), agent);
      const endTime = new Date(slot.start.getTime() + 10 * 60 * 1000);
      await updateAppointment(appointmentId, {
        title: `${titleEmoji} ${titleAction}: ${leadLabel}`,
        description: [
          `STATUS: ${statusLabel}`,
          ``,
          `Contact: ${ctx.leadName || "N/A"}`,
          `Business: ${ctx.businessName || "N/A"}`,
          `Phone: ${ctx.phone || "N/A"} | Email: ${ctx.email || "N/A"}`,
          `Estimated Value: $${ctx.pipelineValue || "TBD"}`,
          `Reason: ${reason}`,
          ...(intent ? [`Intent: ${intent.intent} (${intent.confidence}%) — ${intent.reasoning}`] : []),
          ``,
          `The AI has ${isCommitted ? "identified commitment" : "stepped back"}.`,
          `Please review the conversation and ${isCommitted ? "close the deal" : "take over"}.`,
          ...(conversationSummary ? [``, `--- Conversation ---`, conversationSummary] : []),
        ].join("\n"),
        startTime: toETOffsetString(slot.start),
        endTime: toETOffsetString(endTime),
      });
      actions.push(`Updated appointment to: ${titleAction}`);
      console.log(`[AgentNotify] Lead ${ctx.leadId}: Updated appointment ${appointmentId} → ${titleAction}`);
    } catch (err: any) {
      errors.push(`Failed to update appointment: ${err?.message}`);
    }
  } else {
    // FALLBACK: Create new appointment if none exists
    try {
      const slot = getNextBusinessHoursSlot(new Date(), agent);
      const calendarId = AGENT_CALENDAR_IDS[agent] || AGENT_CALENDAR_IDS["Abby Bouwer"];
      const userId = AGENT_GHL_USER_IDS[agent];
      const endTime = new Date(slot.start.getTime() + 10 * 60 * 1000);
      const result = await createAppointment({
        calendarId,
        contactId: ctx.ghlContactId,
        title: `${titleEmoji} ${titleAction}: ${leadLabel}`,
        description: [
          `STATUS: ${statusLabel}`,
          `Reason: ${reason}`,
          ...(conversationSummary ? [``, `--- Conversation ---`, conversationSummary] : []),
        ].join("\n"),
        startTime: toETOffsetString(slot.start),
        endTime: toETOffsetString(endTime),
        assignedUserId: userId,
      });
      appointmentId = result?.id || result?.event?.id || null;
      actions.push(`Created escalation appointment for ${agent} (no prior appointment existed)`);
    } catch (err: any) {
      errors.push(`Failed to create escalation appointment: ${err?.message}`);
    }
  }

  // ── Update or create task ──
  if (taskId) {
    // UPDATE existing task
    try {
      await updateTask(ctx.ghlContactId, taskId, {
        title: `${titleEmoji} ${titleAction}: ${leadLabel}`,
        body: [
          `STATUS: ${statusLabel}`,
          ``,
          `Contact: ${ctx.leadName || "N/A"}`,
          `Business: ${ctx.businessName || "N/A"}`,
          `Phone: ${ctx.phone || "N/A"} | Email: ${ctx.email || "N/A"}`,
          `Estimated Value: $${ctx.pipelineValue || "TBD"}`,
          `Reason: ${reason}`,
          ...(intent ? [`Intent: ${intent.intent} (${intent.confidence}%) — ${intent.reasoning}`] : []),
          ``,
          isCommitted
            ? `Customer has expressed commitment. Review conversation and close the deal.\nOnce paid, move pipeline to "Paid - Proof Needed" (triggers design team).`
            : `AI has stepped back. Please review the conversation and take over.\nAfter your interaction, AI will auto-resume if no agent activity for 2 hours.`,
          ...(conversationSummary ? [``, `--- Conversation ---`, conversationSummary] : []),
        ].join("\n"),
      });
      actions.push(`Updated task to: ${titleAction}`);
      console.log(`[AgentNotify] Lead ${ctx.leadId}: Updated task ${taskId} → ${titleAction}`);
    } catch (err: any) {
      errors.push(`Failed to update task: ${err?.message}`);
    }
  } else {
    // FALLBACK: Create new task if none exists
    try {
      const slot = getNextBusinessHoursSlot(new Date(), agent);
      const result = await createTask(ctx.ghlContactId, {
        title: `${titleEmoji} ${titleAction}: ${leadLabel}`,
        body: [
          `STATUS: ${statusLabel}`,
          `Reason: ${reason}`,
          ...(conversationSummary ? [``, `--- Conversation ---`, conversationSummary] : []),
        ].join("\n"),
        dueDate: toETOffsetString(slot.start),
        assignedTo: agent,
      });
      taskId = result?.task?.id || result?.id || null;
      actions.push(`Created escalation task for ${agent} (no prior task existed)`);
    } catch (err: any) {
      errors.push(`Failed to create escalation task: ${err?.message}`);
    }
  }

  // ── Add escalation note ──
  try {
    await addNote(ctx.ghlContactId,
      [
        `${titleEmoji} AI: ${titleAction}`,
        `STATUS: ${statusLabel}`,
        ``,
        `Contact: ${leadLabel}${ctx.businessName ? ` (${ctx.businessName})` : ""}`,
        `Reason: ${reason}`,
        ...(intent ? [`Intent: ${intent.intent} (${intent.confidence}%) — ${intent.reasoning}`] : []),
        ``,
        isCommitted
          ? `Customer has expressed commitment. Review and close the deal.`
          : `AI has stepped back. Please take over the conversation.`,
      ].join("\n")
    );
    actions.push("Added escalation note to GHL");
  } catch { /* best effort */ }

  // ── Save updated IDs ──
  try {
    const updates: Record<string, any> = {};
    if (appointmentId) updates.appointmentId = appointmentId;
    if (taskId) updates.ghlTaskId = taskId;
    if (Object.keys(updates).length > 0) {
      await updateLeadFields(ctx.leadId, updates);
    }
  } catch (err: any) {
    errors.push(`Failed to save escalation IDs: ${err?.message}`);
  }

  return { actions, errors, appointmentId, taskId };
}
