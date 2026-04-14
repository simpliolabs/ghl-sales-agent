/**
 * HUMAN AGENT SLA TIMER — Notifies owner when human-owned leads go silent
 * 
 * Runs every 30 minutes. Checks all leads with humanTakeover=1 and alerts
 * the owner if no agent activity for 4+ business hours.
 * 
 * Business hours: Mon-Fri 9am-6pm ET (Eastern Time)
 * 
 * Escalation tiers:
 * - 4 hours silent → first alert (yellow)
 * - 8 hours silent → urgent alert (orange)
 * - 24 hours silent → handled by lead-disposition.ts (auto-release)
 */

import { getHumanTakeoverLeadsSilent, updateLeadFields } from "./db";
import { notifyOwner } from "./_core/notification";
import { recordError } from "./error-memory";

// Track which leads we've already alerted about (avoid spam)
const alertedLeads = new Map<number, { lastAlertAt: number; tier: "yellow" | "orange" }>();

// Clean up stale alert records every 24h
setInterval(() => {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  for (const [leadId, record] of Array.from(alertedLeads.entries())) {
    if (record.lastAlertAt < cutoff) alertedLeads.delete(leadId);
  }
}, 24 * 60 * 60 * 1000);

/**
 * Check if current time is within business hours (Mon-Fri 9am-6pm ET)
 */
function isBusinessHours(): boolean {
  const now = new Date();
  // Convert to ET (UTC-4 EDT or UTC-5 EST)
  const etOffset = isDST(now) ? -4 : -5;
  const etHour = (now.getUTCHours() + etOffset + 24) % 24;
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 6=Sat
  return dayOfWeek >= 1 && dayOfWeek <= 5 && etHour >= 9 && etHour < 18;
}

function isDST(date: Date): boolean {
  // US DST: second Sunday in March to first Sunday in November
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

  // Simple approximation: total hours * (business fraction of week)
  // 9 business hours/day * 5 days = 45 business hours per 168 total hours
  const totalHours = (now - sinceMs) / (1000 * 60 * 60);
  const businessFraction = 45 / 168;
  return Math.round(totalHours * businessFraction * 10) / 10;
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
    // Get leads silent for 4+ hours (raw hours, we'll calculate business hours)
    const silentLeads = await getHumanTakeoverLeadsSilent(2); // 2 raw hours = ~4 biz hours on weekdays

    const yellowAlerts: string[] = [];
    const orangeAlerts: string[] = [];

    for (const lead of silentLeads) {
      stats.checked++;
      const lastActivity = lead.lastAgentActivityAt || lead.lastMessageAt;
      if (!lastActivity) continue;

      const bizHours = businessHoursSince(new Date(lastActivity));
      const existing = alertedLeads.get(lead.id);

      if (bizHours >= 8 && (!existing || existing.tier === "yellow")) {
        // Upgrade to orange
        orangeAlerts.push(`• ${lead.name || `Lead #${lead.id}`} — ${bizHours}h silent (agent: ${lead.assignedAgent || "unassigned"})`);
        alertedLeads.set(lead.id, { lastAlertAt: Date.now(), tier: "orange" });
        stats.alerted++;
        // Tie into scheduling: set nextFollowUpAt so it shows in GHL leads next outreach
        try {
          const nextFollowUp = new Date(Date.now() + 30 * 60 * 1000); // 30 min from now
          await updateLeadFields(lead.id, {
            nextFollowUpAt: nextFollowUp,
            overrideReason: `SLA BREACH (8h): Human agent silent ${bizHours}h. Needs immediate attention.`,
            overrideBy: "sla-timer",
            overrideAt: new Date(),
          });
        } catch { /* best effort */ }
        // Record into error-memory for self-healing
        try {
          await recordError({
            errorType: "sla_breach",
            errorMessage: `Human agent SLA breach (8h) for lead ${lead.id} (${lead.name || "unknown"})`,
            context: `leadId=${lead.id} bizHours=${bizHours} agent=${lead.assignedAgent || "unassigned"} tier=orange`,
          });
        } catch { /* best effort */ }
      } else if (bizHours >= 4 && !existing) {
        // First yellow alert
        yellowAlerts.push(`• ${lead.name || `Lead #${lead.id}`} — ${bizHours}h silent (agent: ${lead.assignedAgent || "unassigned"})`);
        alertedLeads.set(lead.id, { lastAlertAt: Date.now(), tier: "yellow" });
        stats.alerted++;
        // Tie into scheduling: set nextFollowUpAt for visibility in GHL
        try {
          const nextFollowUp = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2h from now
          await updateLeadFields(lead.id, {
            nextFollowUpAt: nextFollowUp,
            overrideReason: `SLA WARNING (4h): Human agent silent ${bizHours}h. Follow-up needed.`,
            overrideBy: "sla-timer",
            overrideAt: new Date(),
          });
        } catch { /* best effort */ }
        // Record into error-memory for self-healing
        try {
          await recordError({
            errorType: "sla_breach",
            errorMessage: `Human agent SLA warning (4h) for lead ${lead.id} (${lead.name || "unknown"})`,
            context: `leadId=${lead.id} bizHours=${bizHours} agent=${lead.assignedAgent || "unassigned"} tier=yellow`,
          });
        } catch { /* best effort */ }
      }
    }

    // Send consolidated alerts
    if (orangeAlerts.length > 0) {
      await notifyOwner({
        title: `🔴 URGENT: ${orangeAlerts.length} lead(s) waiting 8+ business hours for human response`,
        content: `These leads have humanTakeover enabled but no agent activity for 8+ business hours:\n\n${orangeAlerts.join("\n")}\n\nAction needed: respond to these leads or release them back to AI.`,
        priority: "critical",
      });
    }

    if (yellowAlerts.length > 0) {
      await notifyOwner({
        title: `🟡 SLA Warning: ${yellowAlerts.length} lead(s) waiting 4+ business hours for human response`,
        content: `These leads have humanTakeover enabled but no agent activity for 4+ business hours:\n\n${yellowAlerts.join("\n")}\n\nPlease respond soon or release them back to AI.`,
        priority: "standard",
      });
    }

  } catch (err) {
    console.error("[SLA] Error in SLA check:", err);
  }

  return stats;
}
