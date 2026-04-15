/**
 * HUMAN AGENT SLA TIMER — Notifies the ASSIGNED AGENT (via GHL task) when
 * human-owned leads go silent. Owner email is intentionally NOT used.
 *
 * Runs every 30 minutes. Checks all leads with humanTakeover=1 and creates
 * a GHL task for the assigned agent if no agent activity for 4+ business hours.
 *
 * Dedup: DB-backed (lastSlaAlertAt column) — survives server restarts.
 * Minimum gap: 6 hours between alerts per lead.
 *
 * Business hours: Mon-Fri 9am-6pm ET (Eastern Time)
 *
 * Escalation tiers:
 * - 4 hours silent → first alert (yellow) — GHL task for assigned agent
 * - 8 hours silent → urgent alert (orange) — GHL task for assigned agent
 * - 24 hours silent → handled by lead-disposition.ts (auto-release)
 */

import { getHumanTakeoverLeadsSilent, updateLeadFields } from "./db";
import { createTask, AGENT_GHL_USER_IDS } from "./ghl";
import { recordError } from "./error-memory";

// Minimum hours between SLA alerts for the same lead (DB-backed)
const SLA_ALERT_DEDUP_HOURS = 6;

/**
 * Check if current time is within business hours (Mon-Fri 9am-6pm ET)
 */
function isBusinessHours(): boolean {
  const now = new Date();
  const etOffset = isDST(now) ? -4 : -5;
  const etHour = (now.getUTCHours() + etOffset + 24) % 24;
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 6=Sat
  return dayOfWeek >= 1 && dayOfWeek <= 5 && etHour >= 9 && etHour < 18;
}

function isDST(date: Date): boolean {
  const jan = new Date(date.getFullYear(), 0, 1);
  const jul = new Date(date.getFullYear(), 6, 1);
  return date.getTimezoneOffset() < Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
}

/**
 * Calculate business hours elapsed since a given timestamp.
 * Simplified: counts only hours within Mon-Fri 9am-6pm ET windows.
 */
function businessHoursSince(since: Date): number {
  const now = Date.now();
  const sinceMs = since.getTime();
  if (sinceMs >= now) return 0;
  // 9 business hours/day * 5 days = 45 business hours per 168 total hours
  const totalHours = (now - sinceMs) / (1000 * 60 * 60);
  const businessFraction = 45 / 168;
  return Math.round(totalHours * businessFraction * 10) / 10;
}

/**
 * Check if this lead was already alerted within the dedup window.
 * Uses the DB-backed lastSlaAlertAt field — survives restarts.
 */
function isWithinDedupWindow(lastSlaAlertAt: Date | null): boolean {
  if (!lastSlaAlertAt) return false;
  const hoursSinceLast = (Date.now() - new Date(lastSlaAlertAt).getTime()) / (1000 * 60 * 60);
  return hoursSinceLast < SLA_ALERT_DEDUP_HOURS;
}

/**
 * Create a GHL task for the assigned agent notifying them of the SLA breach.
 * Falls back to a console warning if GHL task creation fails.
 */
async function notifyAgentViGhlTask(lead: {
  id: number;
  name: string | null;
  ghlContactId: string | null;
  assignedAgent: string | null;
}, bizHours: number, tier: "yellow" | "orange"): Promise<void> {
  const agentName = lead.assignedAgent || "Unassigned";
  const leadName = lead.name || `Lead #${lead.id}`;
  const urgencyLabel = tier === "orange" ? "🔴 URGENT" : "🟡 ACTION NEEDED";
  const title = `${urgencyLabel}: ${leadName} waiting ${bizHours}h — needs your response`;
  const body = tier === "orange"
    ? `${leadName} has been waiting ${bizHours} business hours for a response from you. This lead is at risk of going cold. Please respond or release back to AI immediately.`
    : `${leadName} has been waiting ${bizHours} business hours for a response from you. Please follow up soon or release back to AI.`;

  if (!lead.ghlContactId) {
    console.warn(`[SLA] Cannot create GHL task for lead ${lead.id} — no ghlContactId`);
    return;
  }

  // Look up the GHL user ID for the assigned agent
  const assignedUserId = agentName ? AGENT_GHL_USER_IDS[agentName] : undefined;

  try {
    await createTask(lead.ghlContactId, {
      title,
      body,
      dueDate: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // due in 30 min
      assignedTo: assignedUserId,
    });
    console.log(`[SLA] GHL task created for agent ${agentName} — lead ${lead.id} (${leadName}) ${bizHours}h silent [${tier}]`);
  } catch (err: any) {
    console.error(`[SLA] Failed to create GHL task for lead ${lead.id}:`, err?.message || err);
  }
}

/**
 * Main SLA check — runs every 30 minutes
 */
export async function runSlaCheck(): Promise<{ checked: number; alerted: number }> {
  const stats = { checked: 0, alerted: 0 };

  // Only run during business hours
  if (!isBusinessHours()) {
    return stats;
  }

  try {
    // Get leads silent for 2+ raw hours (≈ 4 business hours on weekdays)
    const silentLeads = await getHumanTakeoverLeadsSilent(2);

    for (const lead of silentLeads) {
      stats.checked++;
      const lastActivity = lead.lastAgentActivityAt || lead.lastMessageAt;
      if (!lastActivity) continue;

      const bizHours = businessHoursSince(new Date(lastActivity));

      // DB-backed dedup — skip if we already alerted within the last 6 hours
      if (isWithinDedupWindow(lead.lastSlaAlertAt as Date | null)) {
        continue;
      }

      let tier: "yellow" | "orange" | null = null;

      if (bizHours >= 8) {
        tier = "orange";
      } else if (bizHours >= 4) {
        tier = "yellow";
      }

      if (!tier) continue;

      // Notify the assigned agent via GHL task (no owner email)
      await notifyAgentViGhlTask(lead, bizHours, tier);
      stats.alerted++;

      // Update DB dedup timestamp + scheduling fields
      try {
        const nextFollowUp = new Date(Date.now() + (tier === "orange" ? 30 : 120) * 60 * 1000);
        await updateLeadFields(lead.id, {
          lastSlaAlertAt: new Date(),
          nextFollowUpAt: nextFollowUp,
          overrideReason: `SLA ${tier === "orange" ? "BREACH (8h)" : "WARNING (4h)"}: Agent silent ${bizHours}h. GHL task created for ${lead.assignedAgent || "agent"}.`,
          overrideBy: "sla-timer",
          overrideAt: new Date(),
        });
      } catch { /* best effort */ }

      // Record into error-memory for self-healing
      try {
        await recordError({
          errorType: "sla_breach",
          errorMessage: `Human agent SLA ${tier} for lead ${lead.id} (${lead.name || "unknown"})`,
          context: `leadId=${lead.id} bizHours=${bizHours} agent=${lead.assignedAgent || "unassigned"} tier=${tier}`,
        });
      } catch { /* best effort */ }
    }

    if (stats.alerted > 0) {
      console.log(`[SLA/Timer] ${stats.checked} checked, ${stats.alerted} GHL tasks created for agents`);
    }

  } catch (err) {
    console.error("[SLA] Error in SLA check:", err);
  }

  return stats;
}
