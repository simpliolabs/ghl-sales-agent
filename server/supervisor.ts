/**
 * ═══════════════════════════════════════════════════════════════════════
 * SUPERVISOR — The Single Authority That Guarantees Every Lead Has A
 *              Valid Next Action
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Runs every 5 minutes. Checks 9 invariants across every active lead.
 * Auto-corrects violations. Logs everything to supervisor_audit.
 *
 * Invariants enforced:
 *   1. has_future_schedule     — every non-DNC lead has nextFollowUpAt in the future
 *   2. has_segment             — every lead with businessName has a segment
 *   3. has_research            — every lead with businessName has researchData
 *   4. human_takeover_stale    — humanTakeover=1 leads with no agent activity >24hr get released
 *   5. no_channel_dnd_conflict — preferredChannel is not DND-blocked
 *   6. score_is_current        — opportunityScore was updated in the last 7 days
 *   7. not_orphaned            — no lead stuck in "new_lead" stage for >24hr with no messages
 *   8. circuit_breaker_not_stuck — consecutiveRejects < 5 (reset if stuck)
 *   9. long_lead_not_neglected — leads with contextDates (events 3-6mo out) still get touched monthly
 */

import { sql } from "drizzle-orm";
import { getDb, getSystemSetting, setSystemSetting, updateLeadFields, getConversationHistory, getAiState } from "./db";
import { leads, supervisorAudit, aiState as aiStateTable } from "../drizzle/schema";
import { classifySegment, generateResearchContext, scoreLeadQuick } from "./ai-brain";
import { capDate, MAX_FOLLOWUP_DELAY_MS } from "./scheduling-engine";
import { notifyOwner } from "./_core/notification";

// ─── TYPES ──────────────────────────────────────────────────────────

interface Violation {
  invariant: string;
  leadId: number;
  violation: string;
  correction: string;
  success: boolean;
}

interface CycleResult {
  cycleId: string;
  leadsChecked: number;
  violationsFound: number;
  correctionsMade: number;
  correctionsFailed: number;
  violations: Violation[];
  durationMs: number;
  timestamp: string;
}

interface TimerHealthResult {
  healthy: boolean;
  timers: Array<{ name: string; status: "green" | "yellow" | "red"; lastRun: string | null }>;
}

// ─── TIMER NAMES ────────────────────────────────────────────────────

const CRITICAL_TIMERS = [
  { name: "timer_followup_last_run", maxStaleMinutes: 20 },
  { name: "timer_lookback_last_run", maxStaleMinutes: 35 },
  { name: "timer_fastscan_last_run", maxStaleMinutes: 12 },
  { name: "timer_selfreview_last_run", maxStaleMinutes: 65 },
  { name: "timer_disposition_last_run", maxStaleMinutes: 35 },
  { name: "timer_outcomes_last_run", maxStaleMinutes: 130 },
  { name: "timer_overdue_catchup_last_run", maxStaleMinutes: 65 },
];

// ─── MAIN CYCLE ─────────────────────────────────────────────────────

export async function runSupervisorCycle(): Promise<CycleResult> {
  const start = Date.now();
  const cycleId = crypto.randomUUID().slice(0, 12);
  const violations: Violation[] = [];
  const db = await getDb();
  if (!db) {
    return { cycleId, leadsChecked: 0, violationsFound: 0, correctionsMade: 0, correctionsFailed: 0, violations: [], durationMs: Date.now() - start, timestamp: new Date().toISOString() };
  }

  console.log(`[Supervisor] Cycle ${cycleId} starting...`);

  // Fetch all active leads (non-won, non-lost, non-abandoned)
  const allLeads = await db.select().from(leads).where(
    sql`(${leads.opportunityStatus} IS NULL OR ${leads.opportunityStatus} NOT IN ('won', 'lost', 'abandoned'))`
  );

  const now = new Date();
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

  for (const lead of allLeads) {
    try {
      // ── INV 1: has_future_schedule ──────────────────────────────
      if (!lead.humanTakeover && lead.pipelineStage !== "won" && lead.pipelineStage !== "lost") {
        if (!lead.nextFollowUpAt || lead.nextFollowUpAt.getTime() < now.getTime()) {
          const newDate = capDate(new Date(now.getTime() + 2 * 60 * 60 * 1000)); // 2hr from now
          try {
            await updateLeadFields(lead.id, { nextFollowUpAt: newDate });
            violations.push({
              invariant: "has_future_schedule",
              leadId: lead.id,
              violation: `nextFollowUpAt is ${lead.nextFollowUpAt ? 'in the past (' + lead.nextFollowUpAt.toISOString() + ')' : 'NULL'}`,
              correction: `Rescheduled to ${newDate.toISOString()}`,
              success: true,
            });
          } catch (e) {
            violations.push({
              invariant: "has_future_schedule",
              leadId: lead.id,
              violation: `nextFollowUpAt is ${lead.nextFollowUpAt ? 'in the past' : 'NULL'}`,
              correction: `Failed to reschedule: ${(e as Error).message}`,
              success: false,
            });
          }
        }
      }

      // ── INV 2: has_segment ──────────────────────────────────────
      if (lead.businessName && !lead.omnisendSegment) {
        try {
          const segment = await classifySegment(lead.businessName, lead.website || undefined, lead.researchData || undefined);
          if (segment) {
            await updateLeadFields(lead.id, { omnisendSegment: segment });
            violations.push({
              invariant: "has_segment",
              leadId: lead.id,
              violation: `Has businessName "${lead.businessName}" but no segment`,
              correction: `Classified as "${segment}"`,
              success: true,
            });
          }
        } catch (e) {
          violations.push({
            invariant: "has_segment",
            leadId: lead.id,
            violation: `Has businessName but no segment`,
            correction: `Classification failed: ${(e as Error).message}`,
            success: false,
          });
        }
      }

      // ── INV 3: has_research ─────────────────────────────────────
      if (lead.businessName && !lead.researchData) {
        try {
          const research = await generateResearchContext({
            name: lead.name || "",
            businessName: lead.businessName,
            email: lead.email || undefined,
            website: lead.website || undefined,
          });
          if (research) {
            await updateLeadFields(lead.id, { researchData: research });
            violations.push({
              invariant: "has_research",
              leadId: lead.id,
              violation: `Has businessName "${lead.businessName}" but no research`,
              correction: `Research generated`,
              success: true,
            });
          }
        } catch (e) {
          violations.push({
            invariant: "has_research",
            leadId: lead.id,
            violation: `Has businessName but no research`,
            correction: `Research failed: ${(e as Error).message}`,
            success: false,
          });
        }
      }

      // ── INV 4: human_takeover_stale ─────────────────────────────
      if (lead.humanTakeover) {
        const lastActivity = lead.lastAgentActivityAt?.getTime() || lead.updatedAt.getTime();
        const staleMs = now.getTime() - lastActivity;
        if (staleMs > TWENTY_FOUR_HOURS) {
          try {
            const newDate = capDate(new Date(now.getTime() + 2 * 60 * 60 * 1000));
            await updateLeadFields(lead.id, {
              humanTakeover: 0,
              nextFollowUpAt: newDate,
            });
            violations.push({
              invariant: "human_takeover_stale",
              leadId: lead.id,
              violation: `humanTakeover=1 but no agent activity for ${Math.round(staleMs / 3600000)}hr`,
              correction: `Released to AI, rescheduled to ${newDate.toISOString()}`,
              success: true,
            });
          } catch (e) {
            violations.push({
              invariant: "human_takeover_stale",
              leadId: lead.id,
              violation: `humanTakeover stale for ${Math.round(staleMs / 3600000)}hr`,
              correction: `Release failed: ${(e as Error).message}`,
              success: false,
            });
          }
        }
      }

      // ── INV 5: no_channel_dnd_conflict ──────────────────────────
      if (lead.preferredChannel) {
        const isDnd =
          (lead.preferredChannel === "sms" && (lead.dndSms === "active" || lead.dndSms === "permanent")) ||
          (lead.preferredChannel === "email" && (lead.dndEmail === "active" || lead.dndEmail === "permanent")) ||
          (lead.preferredChannel === "fb" && (lead.dndFb === "active" || lead.dndFb === "permanent")) ||
          (lead.preferredChannel === "whatsapp" && (lead.dndWhatsapp === "active" || lead.dndWhatsapp === "permanent")) ||
          (lead.preferredChannel === "gmb" && (lead.dndGmb === "active" || lead.dndGmb === "permanent"));

        if (isDnd) {
          const fallbacks = ["email", "sms", "fb", "whatsapp", "gmb"];
          const dndMap: Record<string, string | null> = { sms: lead.dndSms, email: lead.dndEmail, fb: lead.dndFb, whatsapp: lead.dndWhatsapp, gmb: lead.dndGmb };
          const newChannel = fallbacks.find(ch => ch !== lead.preferredChannel && dndMap[ch] !== "active" && dndMap[ch] !== "permanent");
          if (newChannel) {
            try {
              await updateLeadFields(lead.id, { preferredChannel: newChannel });
              violations.push({
                invariant: "no_channel_dnd_conflict",
                leadId: lead.id,
                violation: `preferredChannel "${lead.preferredChannel}" is DND-blocked`,
                correction: `Switched to "${newChannel}"`,
                success: true,
              });
            } catch (e) {
              violations.push({
                invariant: "no_channel_dnd_conflict",
                leadId: lead.id,
                violation: `preferredChannel DND conflict`,
                correction: `Channel switch failed: ${(e as Error).message}`,
                success: false,
              });
            }
          } else {
            violations.push({
              invariant: "no_channel_dnd_conflict",
              leadId: lead.id,
              violation: `ALL channels are DND-blocked`,
              correction: `No available channel — lead needs manual review`,
              success: false,
            });
          }
        }
      }

      // ── INV 6: score_is_current ─────────────────────────────────
      const scoreAge = now.getTime() - (lead.lastScoreDecayAt?.getTime() || lead.createdAt.getTime());
      if (scoreAge > SEVEN_DAYS && lead.businessName) {
        try {
          const convo = await getConversationHistory(lead.id, 20);
          const convoText = convo.map((c: any) => `${c.senderType}: ${c.messageBody || ""}`).join("\n");
          const newScore = await scoreLeadQuick({
            name: lead.name || "",
            businessName: lead.businessName || "",
            pipelineStage: lead.pipelineStage || "new_lead",
          });
          if (typeof newScore === "number" && newScore > 0) {
            await updateLeadFields(lead.id, {
              opportunityScore: newScore,
              baseScore: newScore,
              lastScoreDecayAt: now,
            });
            violations.push({
              invariant: "score_is_current",
              leadId: lead.id,
              violation: `Score not updated in ${Math.round(scoreAge / 86400000)} days`,
              correction: `Rescored to ${newScore}`,
              success: true,
            });
          }
        } catch (e) {
          violations.push({
            invariant: "score_is_current",
            leadId: lead.id,
            violation: `Score stale for ${Math.round(scoreAge / 86400000)} days`,
            correction: `Rescore failed: ${(e as Error).message}`,
            success: false,
          });
        }
      }

      // ── INV 7: not_orphaned ─────────────────────────────────────
      if (lead.pipelineStage === "new_lead") {
        const leadAge = now.getTime() - lead.createdAt.getTime();
        if (leadAge > TWENTY_FOUR_HOURS) {
          const convo = await getConversationHistory(lead.id, 1);
          if (convo.length === 0) {
            try {
              const newDate = capDate(new Date(now.getTime() + 30 * 60 * 1000)); // 30 min from now
              await updateLeadFields(lead.id, { nextFollowUpAt: newDate });
              violations.push({
                invariant: "not_orphaned",
                leadId: lead.id,
                violation: `Stuck in new_lead for ${Math.round(leadAge / 3600000)}hr with 0 messages`,
                correction: `Rescheduled to ${newDate.toISOString()} for immediate engagement`,
                success: true,
              });
            } catch (e) {
              violations.push({
                invariant: "not_orphaned",
                leadId: lead.id,
                violation: `Orphaned in new_lead`,
                correction: `Rescue failed: ${(e as Error).message}`,
                success: false,
              });
            }
          }
        }
      }

      // ── INV 8: circuit_breaker_not_stuck ────────────────────────
      const state = await getAiState(lead.id);
      if (state && (state.consecutiveRejects || 0) >= 5) {
        try {
          await db.update(aiStateTable).set({ consecutiveRejects: 0 }).where(sql`${aiStateTable.leadId} = ${lead.id}`);
          violations.push({
            invariant: "circuit_breaker_not_stuck",
            leadId: lead.id,
            violation: `consecutiveRejects=${state.consecutiveRejects} — circuit breaker stuck`,
            correction: `Reset to 0, lead can be engaged again`,
            success: true,
          });
        } catch (e) {
          violations.push({
            invariant: "circuit_breaker_not_stuck",
            leadId: lead.id,
            violation: `Circuit breaker stuck at ${state.consecutiveRejects}`,
            correction: `Reset failed: ${(e as Error).message}`,
            success: false,
          });
        }
      }

      // ── INV 9: long_lead_not_neglected ──────────────────────────
      if (lead.contextDates && !lead.humanTakeover) {
        const dates = lead.contextDates as any;
        const hasEventDate = dates?.eventDate || dates?.deadlineDate;
        if (hasEventDate) {
          const lastMessage = lead.lastMessageAt?.getTime() || 0;
          const silenceDays = (now.getTime() - lastMessage) / 86400000;
          if (silenceDays > 30 && lead.nextFollowUpAt && lead.nextFollowUpAt.getTime() > now.getTime() + THIRTY_DAYS) {
            try {
              const newDate = capDate(new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)); // 3 days from now
              await updateLeadFields(lead.id, { nextFollowUpAt: newDate });
              violations.push({
                invariant: "long_lead_not_neglected",
                leadId: lead.id,
                violation: `Long-lead with event date, silent for ${Math.round(silenceDays)} days, next follow-up >30d out`,
                correction: `Rescheduled to ${newDate.toISOString()} for monthly touchpoint`,
                success: true,
              });
            } catch (e) {
              violations.push({
                invariant: "long_lead_not_neglected",
                leadId: lead.id,
                violation: `Long-lead neglected for ${Math.round(silenceDays)} days`,
                correction: `Rescue failed: ${(e as Error).message}`,
                success: false,
              });
            }
          }
        }
      }

    } catch (err) {
      console.error(`[Supervisor] Error checking lead ${lead.id}:`, err);
    }
  }

  // ── PERSIST AUDIT LOG ─────────────────────────────────────────────
  for (const v of violations) {
    try {
      await db.insert(supervisorAudit).values({
        cycleId,
        invariant: v.invariant,
        leadId: v.leadId,
        violation: v.violation,
        correction: v.correction || null,
        success: v.success ? 1 : 0,
      });
    } catch {
      // Best effort logging
    }
  }

  // ── UPDATE LAST RUN ───────────────────────────────────────────────
  await setSystemSetting("timer_supervisor_last_run", new Date().toISOString());

  const correctionsMade = violations.filter(v => v.success).length;
  const correctionsFailed = violations.filter(v => !v.success).length;

  console.log(`[Supervisor] Cycle ${cycleId} complete: ${allLeads.length} leads checked, ${violations.length} violations, ${correctionsMade} corrected, ${correctionsFailed} failed (${Date.now() - start}ms)`);

  // Notify owner if there are failed corrections
  if (correctionsFailed > 0) {
    try {
      await notifyOwner({
        title: `Supervisor: ${correctionsFailed} failed corrections`,
        content: violations.filter(v => !v.success).map(v => `Lead #${v.leadId}: ${v.invariant} — ${v.correction}`).join("\n"),
        priority: "standard",
      });
    } catch {
      // Best effort
    }
  }

  return {
    cycleId,
    leadsChecked: allLeads.length,
    violationsFound: violations.length,
    correctionsMade,
    correctionsFailed,
    violations,
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  };
}

// ─── TIMER HEALTH CHECK ─────────────────────────────────────────────

async function checkTimerHealth(): Promise<TimerHealthResult> {
  const db = await getDb();
  if (!db) return { healthy: false, timers: [] };

  const now = Date.now();
  const timers: TimerHealthResult["timers"] = [];
  let allHealthy = true;

  for (const timer of CRITICAL_TIMERS) {
    const lastRun = await getSystemSetting(timer.name);
    let status: "green" | "yellow" | "red" = "red";

    if (lastRun) {
      const elapsed = now - new Date(lastRun).getTime();
      const maxMs = timer.maxStaleMinutes * 60 * 1000;
      if (elapsed < maxMs) status = "green";
      else if (elapsed < maxMs * 2) status = "yellow";
      else status = "red";
    }

    if (status !== "green") allHealthy = false;
    timers.push({ name: timer.name, status, lastRun });
  }

  return { healthy: allHealthy, timers };
}

// ─── STATUS ENDPOINT ────────────────────────────────────────────────

export async function getSupervisorStatus(): Promise<{
  healthy: boolean;
  lastCycle: CycleResult | null;
  timerHealth: TimerHealthResult;
}> {
  const db = await getDb();
  if (!db) {
    return { healthy: false, lastCycle: null, timerHealth: { healthy: false, timers: [] } };
  }

  const timerHealth = await checkTimerHealth();

  // Get last cycle info from system settings
  const lastCycleJson = await getSystemSetting("supervisor_last_cycle");
  let lastCycle: CycleResult | null = null;
  if (lastCycleJson) {
    try { lastCycle = JSON.parse(lastCycleJson); } catch { /* ignore */ }
  }

  const healthy = timerHealth.healthy && (!lastCycle || lastCycle.correctionsFailed === 0);

  return { healthy, lastCycle, timerHealth };
}

// ─── TIMER HEARTBEAT HELPER ─────────────────────────────────────────

export async function logTimerHeartbeat(timerKey: string): Promise<void> {
  try {
    await setSystemSetting(timerKey, new Date().toISOString());
  } catch {
    // Best effort — don't crash the timer
  }
}

// ─── WRAPPER THAT STORES LAST CYCLE ─────────────────────────────────

export async function runAndStoreSupervisorCycle(): Promise<CycleResult> {
  const result = await runSupervisorCycle();
  try {
    // Store the cycle result (without full violations array to save space)
    const summary = { ...result, violations: result.violations.slice(0, 20) };
    await setSystemSetting("supervisor_last_cycle", JSON.stringify(summary));
  } catch {
    // Best effort
  }
  return result;
}
