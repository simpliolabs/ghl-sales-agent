/**
 * CONTEXT-AWARE SCHEDULING ENGINE
 * 
 * Replaces stage-based scheduling with a 5-level signal hierarchy:
 * 1. Customer-Stated Timeline (highest priority)
 * 2. AI-Suggested Engagement Hours
 * 3. Reply Recency Cadence (graduated silence cadence)
 * 4. Lead Age + Score Baseline (no conversation history)
 * 5. Pipeline Stage Events (supplementary, one-time overrides)
 * 
 * Also handles: business hours, holiday blackouts, DNC detection,
 * rate limiting, score decay, seasonal campaigns, perpetual nurture.
 */

import { getDb } from "./db";
import { leads, conversations, aiState } from "../drizzle/schema";
import { eq, desc, and, sql, gte, lte, isNull } from "drizzle-orm";
import { getIcpTier } from "./outcome-engine";

// ============================================================
// TYPES
// ============================================================

export interface SchedulingInput {
  leadId: number;
  aiSuggestedHours?: number;
  triggerEvent: "ai_response" | "stage_change" | "scheduled_recalc" | "new_lead" | "bulk_backfill" | "inbound_message";
  stageTransition?: string; // e.g., "Delivered", "Quote Sent"
}

export interface SchedulingResult {
  nextFollowUpAt: Date;
  reason: string;
  priority: number; // 1-5
  channel: string;
  cadencePosition: number;
  isDnc: boolean; // true if lead should NOT be contacted
}

// ============================================================
// CONSTANTS
// ============================================================

const US_HOLIDAYS_2026 = [
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Day
  "2026-02-16", // Presidents' Day
  "2026-05-25", // Memorial Day
  "2026-07-04", // July 4th (Saturday)
  "2026-07-03", // July 4th observed (Friday)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-11-27", // Day after Thanksgiving
  "2026-12-25", // Christmas
];

export const DNC_KEYWORDS = [
  "stop", "unsubscribe", "remove me", "opt out", "opt-out",
  "do not contact", "don't contact", "leave me alone",
  "take me off", "no more messages", "stop texting",
  "stop messaging", "remove my number", "cancel",
];

// ============================================================
// MAX FOLLOW-UP DELAY CAP
// Hard limit: no lead can be scheduled more than 30 days out
// EXCEPTION: Customer-stated timeline (P1) — driven by real event dates
// ============================================================
export const MAX_FOLLOWUP_DELAY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
export const MAX_FOLLOWUP_DELAY_HOURS = 30 * 24; // 720 hours

const STAGE_OVERRIDE_HOURS: Record<string, number> = {
  "Quote Sent": 72,          // +3 days
  "Paid - Proof Needed": 24, // +24 hours
  "Proof Sent": 48,          // +48 hours
  "Approved + Deposit": 24,  // +24 hours
  "Ready": 4,                // +4 hours
  "Delivered": 72,           // +3 days (review request)
  "Not Qualified": 720,      // +30 days (reactivation attempt)
};

// Seasonal campaign windows
interface SeasonalWindow {
  name: string;
  startMonth: number; // 1-12
  endMonth: number;
  segments: string[];
  angle: string;
}

const SEASONAL_WINDOWS: SeasonalWindow[] = [
  { name: "Back-to-School", startMonth: 7, endMonth: 8, segments: ["school", "sports_team", "School", "Sports Team"], angle: "Getting your team ready for the new year?" },
  { name: "Holiday Season", startMonth: 10, endMonth: 11, segments: ["church", "nonprofit", "brand", "Church/Ministry", "Nonprofit", "Brand/Business"], angle: "Holiday events coming up — matching gear makes it special" },
  { name: "Spring Events", startMonth: 3, endMonth: 4, segments: ["event_planner", "church", "Event Planner", "Church/Ministry"], angle: "Spring fundraisers, Easter events — we've got you covered" },
  { name: "Summer Rush", startMonth: 5, endMonth: 6, segments: ["sports_team", "school", "brand", "Sports Team", "School", "Brand/Business"], angle: "Summer camps, tournaments, team gear — same-day turnaround" },
  { name: "Year-End", startMonth: 12, endMonth: 12, segments: ["all"], angle: "New year, fresh brand — start with custom gear" },
];

// ============================================================
// BUSINESS HOURS LOGIC
// ============================================================

function toET(date: Date): Date {
  // Convert UTC to Eastern Time (ET = UTC-5, EDT = UTC-4)
  // Simple approach: use Intl to get the offset
  const etStr = date.toLocaleString("en-US", { timeZone: "America/New_York" });
  return new Date(etStr);
}

function isBusinessHours(date: Date, channel: string): boolean {
  const et = toET(date);
  const day = et.getDay(); // 0=Sun, 6=Sat
  const hour = et.getHours();

  if (channel.toLowerCase() === "email") {
    // Email: respect optimal send windows (6-10 AM, 1-3 PM ET)
    return !isEmailOutsideOptimalWindow(date);
  }

  // SMS/Phone: Mon-Fri 9am-5pm ET only (staff hours)
  if (day === 0 || day === 6) return false; // No weekends
  return hour >= 9 && hour < 17; // 9 AM - 5 PM ET
}

function isHoliday(date: Date): boolean {
  const dateStr = date.toISOString().split("T")[0];
  return US_HOLIDAYS_2026.includes(dateStr);
}

/**
 * TCPA Quiet Hours — SMS MUST NOT be sent before 9 AM or after 9 PM Eastern.
 * Returns true if it's currently inside the quiet window (i.e., SMS is NOT allowed).
 */
export function isSmsQuietHours(date: Date = new Date()): boolean {
  const et = toET(date);
  const hour = et.getHours();
  return hour < 9 || hour >= 21;
}

/**
 * Returns the next 9 AM ET as a Date if currently in quiet hours.
 */
export function nextSmsWindowStart(date: Date = new Date()): Date {
  const et = toET(date);
  const hour = et.getHours();
  if (hour >= 21) {
    et.setDate(et.getDate() + 1);
  }
  et.setHours(9, 0, 0, 0);
  // Return as-is — toET already gives us ET-local Date
  return et;
}

/**
 * Returns true if the current time is OUTSIDE optimal email send windows.
 * Optimal windows (ET): 6:00 AM – 10:00 AM and 1:00 PM – 3:00 PM
 * Based on Email Marketing Bible: highest open rates in morning (6-10 AM) and early afternoon (1-3 PM)
 */
export function isEmailOutsideOptimalWindow(date: Date = new Date()): boolean {
  const et = toET(date);
  const h = et.getHours();
  const m = et.getMinutes();
  const minuteOfDay = h * 60 + m;
  const inMorning = minuteOfDay >= 360 && minuteOfDay < 600;   // 6:00 AM – 10:00 AM
  const inAfternoon = minuteOfDay >= 780 && minuteOfDay < 900; // 1:00 PM – 3:00 PM
  return !inMorning && !inAfternoon;
}

/**
 * Returns the next optimal email send window start time.
 * Before 6 AM → today 6 AM | 10 AM–1 PM → today 1 PM | After 3 PM → tomorrow 6 AM
 */
export function nextEmailWindowStart(date: Date = new Date()): Date {
  const et = toET(date);
  const h = et.getHours();
  const m = et.getMinutes();
  const minuteOfDay = h * 60 + m;
  const result = new Date(et);
  result.setSeconds(0, 0);
  if (minuteOfDay < 360) {
    result.setHours(6, 0, 0, 0);  // Before 6 AM → today 6 AM
  } else if (minuteOfDay >= 600 && minuteOfDay < 780) {
    result.setHours(13, 0, 0, 0); // 10 AM–1 PM → today 1 PM
  } else {
    result.setDate(result.getDate() + 1);
    result.setHours(6, 0, 0, 0);  // After 3 PM → tomorrow 6 AM
  }
  return result;
}

function pushToNextBusinessHour(date: Date, channel: string): Date {
  const result = new Date(date);
  let attempts = 0;

  while ((!isBusinessHours(result, channel) || isHoliday(result)) && attempts < 168) {
    result.setHours(result.getHours() + 1);
    attempts++;
  }

  // If we couldn't find a valid time in a week, just use the original
  if (attempts >= 168) return date;

  // For non-email, snap to business hour start if we landed before 9 AM on a weekday
  if (channel.toLowerCase() !== "email") {
    const et = toET(result);
    const day = et.getDay();
    const hour = et.getHours();

    if (day >= 1 && day <= 5 && hour < 9) {
      result.setHours(result.getHours() + (9 - hour));
    }
    // No Saturday handling — weekends are excluded from business hours
  }

  return result;
}

// ============================================================
// DNC DETECTION
// ============================================================

export function checkDnc(messages: Array<{ messageBody: string | null; direction: string; senderType: string }>): boolean {
  // Check the last 5 inbound messages for DNC keywords
  const inbound = messages.filter(m => m.direction === "inbound").slice(0, 5);
  for (const msg of inbound) {
    if (!msg.messageBody) continue;
    const lower = msg.messageBody.toLowerCase().trim();
    if (DNC_KEYWORDS.some(kw => lower === kw || lower.startsWith(kw + " ") || lower.endsWith(" " + kw))) {
      return true;
    }
  }
  return false;
}

// ============================================================
// CHANNEL SELECTION
// ============================================================

function selectChannel(
  cadencePosition: number,
  originalChannel: string | null,
  preferredChannel: string | null,
  hasPhone: boolean,
  hasEmail: boolean,
): string {
  // Priority 1: Use preferred channel if set
  const primary = preferredChannel || originalChannel || "SMS";

  // Decision 3A: Email has 0.5% reply rate vs SMS 17.4% and FB 41.2%.
  // Channel priority: FB (if window open) > SMS > Email (last resort only).
  // Email is ONLY used when no phone AND no social channel available.
  if (cadencePosition <= 2) {
    // First contact + follow-up 1-2: use primary channel
    // But if primary resolved to Email and we have phone, prefer SMS
    if (primary.toLowerCase() === "email" && hasPhone) {
      return "SMS";
    }
    return primary;
  } else if (cadencePosition === 3) {
    // Follow-up 3: try different channel (FB→SMS, SMS→FB if available)
    if (primary.toLowerCase().includes("fb") || primary.toLowerCase().includes("facebook")) {
      return hasPhone ? "SMS" : primary; // FB→SMS, never FB→Email
    }
    if (primary.toLowerCase() === "sms") {
      // SMS→FB would be ideal but we can't check FB window here.
      // Stay on SMS (proven 17.4% reply) rather than dropping to Email (0.5%)
      return "SMS";
    }
    return hasPhone ? "SMS" : primary;
  } else if (cadencePosition <= 5) {
    // Follow-up 4-5: SMS preferred (was Email — but Email has 0.5% reply)
    return hasPhone ? "SMS" : hasEmail ? "Email" : primary;
  } else {
    // Reactivation (6+): SMS preferred, Email only as absolute last resort
    return hasPhone ? "SMS" : hasEmail ? "Email" : primary;
  }
}

// ============================================================
// PRIORITY 1: Customer-Stated Timeline
// ============================================================

function checkCustomerTimeline(
  extractedDates: unknown,
  contextDates: unknown,
): { date: Date; reason: string } | null {
  const allDates: Date[] = [];

  // Parse extracted dates from AI state
  const parseDateArray = (raw: unknown) => {
    if (!raw) return;
    const arr = Array.isArray(raw) ? raw : [];
    for (const d of arr) {
      if (typeof d === "string") {
        const parsed = new Date(d);
        if (!isNaN(parsed.getTime()) && parsed.getTime() > Date.now()) {
          allDates.push(parsed);
        }
      }
    }
  };

  parseDateArray(extractedDates);
  parseDateArray(contextDates);

  if (allDates.length === 0) return null;

  // Use the earliest future date
  allDates.sort((a, b) => a.getTime() - b.getTime());
  const targetDate = allDates[0];
  const daysUntil = Math.floor((targetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

  let followUpDate: Date;
  let reason: string;

  if (daysUntil > 90) {
    followUpDate = new Date(targetDate.getTime() - 60 * 24 * 60 * 60 * 1000);
    reason = `Customer event ${targetDate.toLocaleDateString()} is ${daysUntil} days away — scheduling 60 days before`;
  } else if (daysUntil > 60) {
    followUpDate = new Date(targetDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    reason = `Customer event ${targetDate.toLocaleDateString()} is ${daysUntil} days away — scheduling 30 days before`;
  } else if (daysUntil > 30) {
    followUpDate = new Date(targetDate.getTime() - 14 * 24 * 60 * 60 * 1000);
    reason = `Customer event ${targetDate.toLocaleDateString()} approaching — scheduling 14 days before for specifics`;
  } else if (daysUntil > 14) {
    followUpDate = new Date(targetDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    reason = `Customer event ${targetDate.toLocaleDateString()} in ${daysUntil} days — creating urgency, 7 days before`;
  } else if (daysUntil > 7) {
    followUpDate = new Date(targetDate.getTime() - 3 * 24 * 60 * 60 * 1000);
    reason = `Customer event ${targetDate.toLocaleDateString()} in ${daysUntil} days — final push, 3 days before`;
  } else {
    followUpDate = new Date(targetDate.getTime() - 1 * 24 * 60 * 60 * 1000);
    reason = `Customer event ${targetDate.toLocaleDateString()} in ${daysUntil} days — emergency angle, 1 day before`;
  }

  // Don't schedule in the past
  if (followUpDate.getTime() < Date.now()) {
    followUpDate = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours from now
    reason += " (adjusted: event is imminent)";
  }

  return { date: followUpDate, reason };
}

// ============================================================
// PRIORITY 3: Reply Recency Cadence
// ============================================================

function calculateSilenceCadence(
  daysSinceLastOutbound: number,
  consecutiveUnanswered: number,
  score?: number,
): { delayHours: number; cadencePosition: number; reason: string } {
  // Score-based multiplier: high-score leads get faster follow-ups
  const scoreMultiplier = (score && score >= 70) ? 0.7 : (score && score >= 40) ? 0.85 : 1.0;
  // After 5 consecutive unanswered: cap at 30-day pause (was 90 days — now capped)
  if (consecutiveUnanswered >= 5) {
    return {
      delayHours: Math.min(MAX_FOLLOWUP_DELAY_HOURS, 90 * 24), // Capped to 30 days
      cadencePosition: 6,
      reason: `5 consecutive unanswered outreach — ${MAX_FOLLOWUP_DELAY_HOURS / 24}-day pause before reactivation (capped)`,
    };
  }

  if (daysSinceLastOutbound <= 1) {
    return { delayHours: Math.round(24 * scoreMultiplier), cadencePosition: 1, reason: `Last outreach <1 day ago, no reply — soft follow-up in ${Math.round(24 * scoreMultiplier)}h (score: ${score || 'n/a'})` };
  } else if (daysSinceLastOutbound <= 3) {
    return { delayHours: Math.round(48 * scoreMultiplier), cadencePosition: 2, reason: `Last outreach 2-3 days ago, no reply — new angle in ${Math.round(48 * scoreMultiplier)}h (score: ${score || 'n/a'})` };
  } else if (daysSinceLastOutbound <= 7) {
    return { delayHours: Math.round(72 * scoreMultiplier), cadencePosition: 3, reason: `Last outreach 4-7 days ago, no reply — try different channel in ${Math.round(72 * scoreMultiplier)}h (score: ${score || 'n/a'})` };
  } else if (daysSinceLastOutbound <= 14) {
    return { delayHours: Math.round(168 * scoreMultiplier), cadencePosition: 4, reason: `Last outreach 8-14 days ago, no reply — value email in ${Math.round(168 * scoreMultiplier / 24)}d (score: ${score || 'n/a'})` };
  } else if (daysSinceLastOutbound <= 30) {
    return { delayHours: Math.round(336 * scoreMultiplier), cadencePosition: 4, reason: `Last outreach 15-30 days ago, no reply — fresh SMS angle in ${Math.round(336 * scoreMultiplier / 24)}d (score: ${score || 'n/a'})` };
  } else if (daysSinceLastOutbound <= 60) {
    return { delayHours: Math.round(720 * scoreMultiplier), cadencePosition: 5, reason: `Last outreach 30-60 days ago — reactivation email in ${Math.round(720 * scoreMultiplier / 24)}d (score: ${score || 'n/a'})` };
  } else if (daysSinceLastOutbound <= 90) {
    return { delayHours: Math.round(720 * scoreMultiplier), cadencePosition: 5, reason: `Last outreach 60-90 days ago — SMS 3 days after reactivation email (score: ${score || 'n/a'})` };
  } else {
    return { delayHours: Math.min(MAX_FOLLOWUP_DELAY_HOURS, 1440), cadencePosition: 5, reason: `Last outreach 90+ days ago — gentle re-introduction email in ${Math.min(MAX_FOLLOWUP_DELAY_HOURS, 1440) / 24} days (capped)` };
  }
}

// ============================================================
// PRIORITY 4: Lead Age + Score Baseline
// ============================================================

function calculateAgeScoreBaseline(
  leadAgeHours: number,
  score: number,
): { delayHours: number; reason: string } {
  const tier = score >= 70 ? "high" : score >= 40 ? "mid" : "low";

  if (leadAgeHours < 1) {
    const delay = tier === "high" ? 0.08 : tier === "mid" ? 0.25 : 0.5; // 5min, 15min, 30min
    return { delayHours: delay, reason: `New lead (<1h old), score ${score} (${tier}) — fast initial contact` };
  } else if (leadAgeHours < 24) {
    const delay = tier === "high" ? 0.5 : tier === "mid" ? 1 : 2;
    return { delayHours: delay, reason: `Lead ${Math.round(leadAgeHours)}h old, score ${score} (${tier}) — same-day contact` };
  } else if (leadAgeHours < 168) { // 7 days
    const delay = tier === "high" ? 1 : tier === "mid" ? 4 : 8;
    return { delayHours: delay, reason: `Lead ${Math.round(leadAgeHours / 24)}d old, score ${score} (${tier}) — prompt outreach` };
  } else if (leadAgeHours < 720) { // 30 days
    const delay = tier === "high" ? 4 : tier === "mid" ? 12 : 24;
    return { delayHours: delay, reason: `Lead ${Math.round(leadAgeHours / 24)}d old, score ${score} (${tier}) — scheduled outreach` };
  } else if (leadAgeHours < 2160) { // 90 days
    const delay = tier === "high" ? 24 : tier === "mid" ? 48 : 72;
    return { delayHours: delay, reason: `Lead ${Math.round(leadAgeHours / 24)}d old, score ${score} (${tier}) — measured outreach` };
  } else {
    const delay = tier === "high" ? 48 : tier === "mid" ? 72 : 168;
    return { delayHours: delay, reason: `Lead ${Math.round(leadAgeHours / 24)}d old, score ${score} (${tier}) — low-priority outreach` };
  }
}

// ============================================================
// SCORE DECAY
// ============================================================

export function calculateScoreDecay(
  currentScore: number,
  baseScore: number,
  daysSinceLastEngagement: number,
): { newScore: number; decayed: boolean } {
  if (daysSinceLastEngagement <= 14) {
    return { newScore: currentScore, decayed: false };
  }

  let decayPerWeek: number;
  let floor: number;

  if (daysSinceLastEngagement <= 30) {
    decayPerWeek = 2;
    floor = 30;
  } else if (daysSinceLastEngagement <= 60) {
    decayPerWeek = 3;
    floor = 20;
  } else if (daysSinceLastEngagement <= 90) {
    decayPerWeek = 5;
    floor = 10;
  } else {
    decayPerWeek = 5;
    floor = 5;
  }

  const weeksInactive = Math.floor((daysSinceLastEngagement - 14) / 7);
  const totalDecay = weeksInactive * decayPerWeek;
  const newScore = Math.max(floor, baseScore - totalDecay);

  return { newScore, decayed: newScore < currentScore };
}

// ============================================================
// SEASONAL CAMPAIGN CHECK
// ============================================================

export function checkSeasonalEligibility(
  segment: string | null,
  lastSeasonalPushAt: Date | null,
  cadencePosition: number,
  hasActiveConversation: boolean,
): { eligible: boolean; window?: SeasonalWindow } {
  if (hasActiveConversation) return { eligible: false }; // Don't interrupt active conversations
  if (cadencePosition > 0 && cadencePosition < 4) return { eligible: false }; // In active silence cadence

  // Check 60-day cooldown
  if (lastSeasonalPushAt) {
    const daysSincePush = (Date.now() - lastSeasonalPushAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSincePush < 60) return { eligible: false };
  }

  const currentMonth = new Date().getMonth() + 1; // 1-12

  for (const window of SEASONAL_WINDOWS) {
    const inWindow = window.startMonth <= window.endMonth
      ? currentMonth >= window.startMonth && currentMonth <= window.endMonth
      : currentMonth >= window.startMonth || currentMonth <= window.endMonth;

    if (!inWindow) continue;

    // Check segment match
    if (window.segments.includes("all")) return { eligible: true, window };
    if (segment && window.segments.some(s => s.toLowerCase() === segment.toLowerCase())) {
      return { eligible: true, window };
    }
  }

  return { eligible: false };
}

// ============================================================
// MAIN ENGINE: calculateNextFollowUp
// ============================================================

export async function calculateNextFollowUp(input: SchedulingInput): Promise<SchedulingResult> {
  const db = await getDb();
  if (!db) {
    return {
      nextFollowUpAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
      reason: "Database unavailable — default 4h follow-up",
      priority: 4,
      channel: "SMS",
      cadencePosition: 0,
      isDnc: false,
    };
  }

  // Load lead data
  const leadRows = await db.select().from(leads).where(eq(leads.id, input.leadId)).limit(1);
  const lead = leadRows[0];
  if (!lead) {
    return {
      nextFollowUpAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
      reason: "Lead not found — default 4h follow-up",
      priority: 4,
      channel: "SMS",
      cadencePosition: 0,
      isDnc: false,
    };
  }

  // --- ADMIN OVERRIDE PROTECTION ---
  // If an admin manually rescheduled this lead recently, respect the override.
  // The override is "consumed" after the scheduled time passes and the follow-up fires.
  // A fresh override (within 5 min) that hasn't been executed yet should NOT be overwritten.
  if (lead.overrideBy && lead.overrideAt && lead.nextFollowUpAt) {
    const overrideAgeMs = Date.now() - new Date(lead.overrideAt).getTime();
    const overrideTarget = new Date(lead.nextFollowUpAt).getTime();
    const overrideStillPending = overrideTarget > Date.now(); // override time hasn't passed yet
    // If the override was set recently OR the override target is still in the future, respect it
    if (overrideAgeMs < 5 * 60 * 1000 || overrideStillPending) {
      return {
        nextFollowUpAt: new Date(overrideTarget),
        reason: `[Admin Override] Manually scheduled by ${lead.overrideBy}: "${lead.overrideReason || 'no reason'}" — respecting override`,
        priority: 10,
        channel: lead.preferredChannel || "SMS",
        cadencePosition: lead.cadencePosition || 0,
        isDnc: false,
      };
    }
  }

  // Load conversation history
  const convHistory = await db.select().from(conversations)
    .where(eq(conversations.leadId, input.leadId))
    .orderBy(desc(conversations.timestamp))
    .limit(50);

  // Load AI state
  const stateRows = await db.select().from(aiState).where(eq(aiState.leadId, input.leadId)).limit(1);
  const state = stateRows[0];

  // ---- DNC CHECK ----
  const isDnc = checkDnc(convHistory);
  if (isDnc) {
    return {
      nextFollowUpAt: capDate(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), true), // Far future, exempt from 30-day cap (DNC — not contacted)
      reason: "Lead opted out — DNC flag active, no outreach scheduled",
      priority: 0,
      channel: "none",
      cadencePosition: -1,
      isDnc: true,
    };
  }

  // ---- HUMAN TAKEOVER CHECK ----
  if (lead.humanTakeover === 1) {
    // Check if agent was active in last 24h
    if (lead.lastAgentActivityAt) {
      const hoursSinceAgent = (Date.now() - new Date(lead.lastAgentActivityAt).getTime()) / (1000 * 60 * 60);
      if (hoursSinceAgent < 24) {
        return {
          nextFollowUpAt: new Date(new Date(lead.lastAgentActivityAt).getTime() + 24 * 60 * 60 * 1000),
          reason: `Human takeover active — agent active ${Math.round(hoursSinceAgent)}h ago, AI resumes after 24h`,
          priority: 0,
          channel: "none",
          cadencePosition: lead.cadencePosition || 0,
          isDnc: false,
        };
      }
    }
    // Agent inactive for 24h+, AI can resume
  }

  // Calculate key metrics
  const lastOutbound = convHistory.find(c => c.direction === "outbound");
  const lastInbound = convHistory.find(c => c.direction === "inbound");
  const hasConversation = convHistory.length > 0;

  const lastOutboundAt = lastOutbound?.timestamp ? new Date(lastOutbound.timestamp).getTime() : 0;
  const lastInboundAt = lastInbound?.timestamp ? new Date(lastInbound.timestamp).getTime() : 0;
  const daysSinceLastOutbound = lastOutboundAt ? (Date.now() - lastOutboundAt) / (1000 * 60 * 60 * 24) : 999;
  const daysSinceLastInbound = lastInboundAt ? (Date.now() - lastInboundAt) / (1000 * 60 * 60 * 24) : 999;

  // Count consecutive unanswered outbound
  let consecutiveUnanswered = 0;
  for (const c of convHistory) { // already sorted desc
    if (c.direction === "outbound") consecutiveUnanswered++;
    else break;
  }

  const hasActiveConversation = daysSinceLastInbound <= 7;
  const leadCreatedAt = lead.createdAt ? new Date(lead.createdAt).getTime() : Date.now();
  const leadAgeHours = (Date.now() - leadCreatedAt) / (1000 * 60 * 60);
  const score = lead.opportunityScore || 50;

  // Determine channel
  const channel = selectChannel(
    lead.cadencePosition || 0,
    lead.source || null,
    lead.preferredChannel || null,
    !!lead.phone,
    !!lead.email,
  );

  // ============================================================
  // PRIORITY 1: Customer-Stated Timeline
  // ============================================================
  const timeline = checkCustomerTimeline(
    state?.extractedDates,
    lead.contextDates,
  );

  if (timeline) {
    const adjustedDate = pushToNextBusinessHour(timeline.date, channel);
    // P1 is the ONLY path exempt from the 30-day cap — it's driven by real customer event dates
    // The capDate call in follow-up-trigger.ts should use allowLongLead=true for P1 results
    return {
      nextFollowUpAt: adjustedDate,
      reason: `[P1 Customer Timeline] ${timeline.reason}`,
      priority: 1,
      channel,
      cadencePosition: lead.cadencePosition || 0,
      isDnc: false,
    };
  }

  // ============================================================
  // PRIORITY 2: AI-Suggested Engagement Hours
  // ============================================================
  if (input.aiSuggestedHours && input.aiSuggestedHours > 0 && hasActiveConversation) {
    const followUpDate = new Date(Date.now() + input.aiSuggestedHours * 60 * 60 * 1000);
    const adjustedDate = pushToNextBusinessHour(followUpDate, channel);
    return {
      nextFollowUpAt: adjustedDate,
      reason: `[P2 AI Suggested] AI brain recommends ${input.aiSuggestedHours}h follow-up based on conversation context`,
      priority: 2,
      channel,
      cadencePosition: 0, // Active conversation
      isDnc: false,
    };
  }

  // ============================================================
  // PRIORITY 5: Pipeline Stage Events (check before P3/P4 since it's event-driven)
  // ============================================================
  if (input.triggerEvent === "stage_change" && input.stageTransition) {
    const overrideHours = STAGE_OVERRIDE_HOURS[input.stageTransition];
    if (overrideHours) {
      const followUpDate = new Date(Date.now() + overrideHours * 60 * 60 * 1000);
      const adjustedDate = pushToNextBusinessHour(followUpDate, channel);
      return {
        nextFollowUpAt: adjustedDate,
        reason: `[P5 Stage Event] Stage changed to "${input.stageTransition}" — follow-up in ${overrideHours}h`,
        priority: 5,
        channel,
        cadencePosition: lead.cadencePosition || 0,
        isDnc: false,
      };
    }
  }

  // ============================================================
  // PRIORITY 3: Reply Recency Cadence (has conversation, no active reply)
  // ============================================================
   if (hasConversation && !hasActiveConversation) {
    let cadence = calculateSilenceCadence(daysSinceLastOutbound, consecutiveUnanswered, score);
    // ============================================================
    // STALE LEAD CAP (ground-up rule — applies to ALL leads)
    // If a lead has been silent for 90+ days AND the cadence would
    // schedule them 30+ more days out, that compounds the neglect.
    // Cap the delay to 7 days and use reactivation cadence (position 5).
    // This prevents dormant leads from being pushed further and further
    // into the future every time the scheduler runs.
    // ============================================================
    if (daysSinceLastOutbound >= 90 && cadence.delayHours >= 30 * 24) {
      cadence = {
        delayHours: 7 * 24, // 7 days — reactivation window
        cadencePosition: 5,
        reason: `Lead silent ${Math.round(daysSinceLastOutbound)}d — stale-lead cap applied (was ${Math.round(cadence.delayHours / 24)}d delay) → reactivation in 7 days`,
      };
    }
    // ============================================================
    // MODULE 2A: ICP CADENCE MULTIPLIER
    // Apply multiplier based on lead source/segment conversion rate.
    // high (>=20% conv) → ×0.7 (30% faster), low (<10%) → ×1.3 (30% slower)
    // P1 (customer timeline) and P2 (AI suggested) are exempt.
    // ============================================================
    const icpTier = await getIcpTier(lead.source, lead.seasonalSegment);
    const icpMultiplier = icpTier === "high" ? 0.7 : icpTier === "low" ? 1.3 : 1.0;
    const icpAdjustedHours = Math.round(cadence.delayHours * icpMultiplier);
    const icpNote = icpTier !== "unknown" && icpTier !== "medium"
      ? ` [ICP:${icpTier.toUpperCase()} ×${icpMultiplier}]`
      : "";
    const followUpDate = new Date(Date.now() + icpAdjustedHours * 60 * 60 * 1000);
    const adjustedDate = pushToNextBusinessHour(followUpDate, selectChannel(
      cadence.cadencePosition,
      lead.source || null,
      lead.preferredChannel || null,
      !!lead.phone,
      !!lead.email,
    ));
    return {
      nextFollowUpAt: adjustedDate,
      reason: `[P3 Silence Cadence] ${cadence.reason}${icpNote}`,
      priority: 3,
      channel: selectChannel(cadence.cadencePosition, lead.source || null, lead.preferredChannel || null, !!lead.phone, !!lead.email),
      cadencePosition: cadence.cadencePosition,
      isDnc: false,
    };
  }

  // ============================================================
  // PRIORITY 4: Lead Age + Score Baseline (no conversation)
  // ============================================================
  if (!hasConversation || input.triggerEvent === "new_lead" || input.triggerEvent === "bulk_backfill") {
    const baseline = calculateAgeScoreBaseline(leadAgeHours, score);
    // MODULE 2A: ICP multiplier also applies to P4 (new leads with no conversation)
    const icpTierP4 = await getIcpTier(lead.source, lead.seasonalSegment);
    const icpMultiplierP4 = icpTierP4 === "high" ? 0.7 : icpTierP4 === "low" ? 1.3 : 1.0;
    const icpAdjustedHoursP4 = Math.round(baseline.delayHours * icpMultiplierP4);
    const icpNoteP4 = icpTierP4 !== "unknown" && icpTierP4 !== "medium"
      ? ` [ICP:${icpTierP4.toUpperCase()} ×${icpMultiplierP4}]`
      : "";
    const followUpDate = new Date(Date.now() + icpAdjustedHoursP4 * 60 * 60 * 1000);
    const adjustedDate = pushToNextBusinessHour(followUpDate, channel);

    return {
      nextFollowUpAt: adjustedDate,
      reason: `[P4 Age+Score] ${baseline.reason}${icpNoteP4}`,
      priority: 4,
      channel,
      cadencePosition: 0,
      isDnc: false,
    };
  }

  // ============================================================
  // FALLBACK: Active conversation, no AI suggestion
  // ============================================================
  // Base delay by score, but ESCALATE based on consecutive unanswered messages.
  // This prevents spamming leads who haven't replied despite being in the active conversation window.
  let fallbackHours: number;
  if (consecutiveUnanswered >= 3) {
    // 3+ unanswered: treat like silence cadence — minimum 48h between messages
    fallbackHours = Math.max(48, 24 * consecutiveUnanswered);
  } else if (consecutiveUnanswered >= 2) {
    // 2 unanswered: slow down significantly — 24h minimum
    fallbackHours = 24;
  } else if (consecutiveUnanswered >= 1) {
    // 1 unanswered: moderate delay — 12h minimum
    fallbackHours = score >= 70 ? 12 : score >= 40 ? 16 : 24;
  } else {
    // Active back-and-forth conversation — quick follow-up OK
    fallbackHours = score >= 70 ? 2 : score >= 40 ? 4 : 8;
  }
  const followUpDate = new Date(Date.now() + fallbackHours * 60 * 60 * 1000);
  const adjustedDate = pushToNextBusinessHour(followUpDate, channel);

  return {
    nextFollowUpAt: adjustedDate,
    reason: `[Fallback] Active conversation, score ${score}, ${consecutiveUnanswered} unanswered — follow-up in ${fallbackHours}h`,
    priority: 2,
    channel,
    cadencePosition: Math.min(consecutiveUnanswered, 5),
    isDnc: false,
  };
}

// Cap any date to prevent MySQL TIMESTAMP overflow (max 2038-01-19)
const MAX_SAFE_DATE = new Date('2029-12-31T23:59:59Z');

/**
 * Cap a date to the safe MySQL range.
 * Also enforces the 30-day max follow-up delay unless explicitly exempted.
 * @param d - The date to cap
 * @param allowLongLead - If true, skip the 30-day cap (for customer-stated timelines)
 */
export function capDate(d: Date, allowLongLead = false): Date {
  // FLOOR: Never allow a date in the past — bump to now + 1h with jitter
  const now = Date.now();
  if (d.getTime() <= now) {
    const jitterMs = Math.floor(Math.random() * 30 * 60 * 1000); // 0-30 min jitter
    const bumped = new Date(now + 60 * 60 * 1000 + jitterMs); // 1h + jitter
    console.log(`[SchedulingEngine] \u26a0\ufe0f Past-date floor applied: ${d.toISOString()} \u2192 ${bumped.toISOString()}`);
    d = bumped;
  }
  // 30-day max cap (unless this is a customer-stated timeline / long-lead sequence)
  if (!allowLongLead) {
    const maxDate = new Date(now + MAX_FOLLOWUP_DELAY_MS);
    if (d > maxDate) {
      console.log(`[SchedulingEngine] \u26a0\ufe0f 30-day cap applied: ${d.toISOString()} \u2192 ${maxDate.toISOString()}`);
      d = maxDate;
    }
  }
  // MySQL TIMESTAMP overflow protection
  return d > MAX_SAFE_DATE ? MAX_SAFE_DATE : d;
}

// ============================================================
// RATE LIMITING
// ============================================================

export async function checkRateLimits(): Promise<{ allowed: boolean; reason?: string }> {
  const db = await getDb();
  if (!db) return { allowed: true };

  // Check hourly cap (50/hour)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const [hourly] = await db.select({ count: sql<number>`count(*)` }).from(conversations)
    .where(and(
      eq(conversations.senderType, "ai"),
      eq(conversations.direction, "outbound"),
      gte(conversations.timestamp, oneHourAgo),
    ));

  if (hourly.count >= 50) {
    return { allowed: false, reason: `Hourly cap reached (${hourly.count}/50)` };
  }

  // Check daily cap (200/day)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const [daily] = await db.select({ count: sql<number>`count(*)` }).from(conversations)
    .where(and(
      eq(conversations.senderType, "ai"),
      eq(conversations.direction, "outbound"),
      gte(conversations.timestamp, todayStart),
    ));

  if (daily.count >= 200) {
    return { allowed: false, reason: `Daily cap reached (${daily.count}/200)` };
  }

  return { allowed: true };
}

// ============================================================
// PER-LEAD RATE LIMIT (1 outreach per 24h per lead)
// ============================================================

export async function checkLeadRateLimit(leadId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return true;

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [result] = await db.select({ count: sql<number>`count(*)` }).from(conversations)
    .where(and(
      eq(conversations.leadId, leadId),
      eq(conversations.senderType, "ai"),
      eq(conversations.direction, "outbound"),
      gte(conversations.timestamp, oneDayAgo),
    ));

  return result.count === 0; // true if allowed (no outreach in last 24h)
}

// ============================================================
// BULK RECALCULATION (for cron job)
// ============================================================

export async function recalculateStaleSchedules(): Promise<{ updated: number; decayed: number; seasonal: number }> {
  const db = await getDb();
  if (!db) return { updated: 0, decayed: 0, seasonal: 0 };

  let updated = 0;
  let decayed = 0;
  let seasonal = 0;

  // Find leads needing recalculation:
  // 1. nextFollowUpAt is in the past
  // 2. nextFollowUpAt is null
  // 3. Leads in silence cadence for 30+ days without recalc
  const staleLeads = await db.select().from(leads).where(
    sql`(${leads.nextFollowUpAt} IS NULL OR ${leads.nextFollowUpAt} < NOW()) AND ${leads.humanTakeover} = 0`
  ).limit(500); // Process in batches

  for (const lead of staleLeads) {
    try {
      const result = await calculateNextFollowUp({
        leadId: lead.id,
        triggerEvent: "scheduled_recalc",
      });

      if (!result.isDnc) {
        // Apply 30-day cap (P1 customer timeline is exempt)
        const isLongLead = result.priority === 1;
        let scheduledDate = capDate(result.nextFollowUpAt, isLongLead);
        // ─── DAILY CAP ENFORCEMENT AT SCHEDULING LEVEL ───────────────────────────
        // If a proactive AI message was sent today (same calendar day in ET),
        // never schedule the next follow-up earlier than tomorrow.
        // This prevents the scheduling engine from immediately re-queuing a lead
        // that was just messaged, which would bypass the orchestrator's daily cap.
        if (lead.lastAiSendAttemptAt) {
          const lastSend = new Date(lead.lastAiSendAttemptAt);
          const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
          const lastSendET = new Date(lastSend.toLocaleString('en-US', { timeZone: 'America/New_York' }));
          const sentToday =
            nowET.getFullYear() === lastSendET.getFullYear() &&
            nowET.getMonth() === lastSendET.getMonth() &&
            nowET.getDate() === lastSendET.getDate();
          if (sentToday) {
            // Enforce minimum: next follow-up is at least lastAiSendAttemptAt + 24h
            const minNextFollowUp = new Date(lastSend.getTime() + 24 * 60 * 60 * 1000);
            if (scheduledDate < minNextFollowUp) {
              console.log(`[SchedulingEngine] ⏰ Daily cap: lead ${lead.id} was sent a message today — advancing nextFollowUpAt from ${scheduledDate.toISOString()} to ${minNextFollowUp.toISOString()}`);
              scheduledDate = minNextFollowUp;
            }
          }
        }
        // ─────────────────────────────────────────────────────────────────────────
        await db.update(leads).set({
          nextFollowUpAt: scheduledDate,
          cadencePosition: result.cadencePosition,
          preferredChannel: result.channel,
        }).where(eq(leads.id, lead.id));
        updated++;
      }

      // Score decay check
      const lastEngagement = lead.lastMessageAt ? new Date(lead.lastMessageAt).getTime() : new Date(lead.createdAt).getTime();
      const daysSinceEngagement = (Date.now() - lastEngagement) / (1000 * 60 * 60 * 24);
      const decay = calculateScoreDecay(
        lead.opportunityScore || 50,
        lead.baseScore || lead.opportunityScore || 50,
        daysSinceEngagement,
      );

      if (decay.decayed) {
        await db.update(leads).set({
          opportunityScore: decay.newScore,
          lastScoreDecayAt: new Date(),
        }).where(eq(leads.id, lead.id));
        decayed++;
      }

      // Seasonal campaign check
      const seasonalCheck = checkSeasonalEligibility(
        lead.omnisendSegment,
        lead.lastSeasonalPushAt,
        lead.cadencePosition || 0,
        false, // Will be determined by conversation check
      );

      if (seasonalCheck.eligible && seasonalCheck.window) {
        // Mark for seasonal push — actual sending happens in the outreach executor
        await db.update(leads).set({
          seasonalSegment: seasonalCheck.window.name,
        }).where(eq(leads.id, lead.id));
        seasonal++;
      }
    } catch (err) {
      console.error(`[SchedulingEngine] Error recalculating lead ${lead.id}:`, err);
    }
  }

  console.log(`[SchedulingEngine] Recalculation complete: ${updated} updated, ${decayed} decayed, ${seasonal} seasonal`);
  return { updated, decayed, seasonal };
}

// ============================================================
// PERPETUAL NURTURE CHECK
// ============================================================

export function calculatePerpetualNurtureSchedule(
  reactivationCount: number,
  lastReactivationAt: Date | null,
): { nextDate: Date; reason: string; nurturePosition: number } {
  const cycleNumber = reactivationCount + 1;
  const daysSinceLast = lastReactivationAt
    ? (Date.now() - lastReactivationAt.getTime()) / (1000 * 60 * 60 * 24)
    : 999;

  // Quarterly cycle: every 90 days (but capped to 30-day max scheduling window)
  if (daysSinceLast < 85) {
    // Not yet time for next nurture — but cap the scheduled date to 30 days max
    const rawNextDate = new Date((lastReactivationAt?.getTime() || Date.now()) + 90 * 24 * 60 * 60 * 1000);
    const maxDate = new Date(Date.now() + MAX_FOLLOWUP_DELAY_MS);
    const nextDate = rawNextDate > maxDate ? maxDate : rawNextDate;
    return {
      nextDate,
      reason: `Perpetual Nurture cycle #${cycleNumber} — next quarterly email in ${Math.round(Math.min(90 - daysSinceLast, 30))} days`,
      nurturePosition: cycleNumber,
    };
  }

  // Time for next nurture email
  const nextDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // Tomorrow
  const angles = [
    "Industry insight and case study",
    "New value prop: new product line or capability",
    "Social proof: similar businesses ordering",
    "ROI-focused content with real data",
  ];
  const angleIndex = (cycleNumber - 1) % angles.length;

  return {
    nextDate,
    reason: `Perpetual Nurture cycle #${cycleNumber} — ${angles[angleIndex]} (email from print@adorbcustomtees.com)`,
    nurturePosition: cycleNumber,
  };
}

// ============================================================
// SCHEDULE COMPRESSION — One-time migration
// Redistributes leads scheduled beyond 30 days into the next
// 7-14 days with proper staggering (50-100/day).
// ============================================================

interface CompressOptions {
  maxPerDay: number;   // Max leads to reschedule per day (default: 75)
  spreadDays: number;  // Days to spread across (default: 10)
  dryRun: boolean;     // If true, only report what would change
}

interface CompressResult {
  totalFound: number;
  totalRescheduled: number;
  dryRun: boolean;
  distribution: Array<{ date: string; count: number }>;
  errors: number;
}

export async function compressSchedule(options: CompressOptions): Promise<CompressResult> {
  const { maxPerDay, spreadDays, dryRun } = options;
  const result: CompressResult = {
    totalFound: 0,
    totalRescheduled: 0,
    dryRun,
    distribution: [],
    errors: 0,
  };

  const db = await getDb();
  if (!db) return result;

  try {
    // Find all leads scheduled beyond 30 days from now
    const maxDate = new Date(Date.now() + MAX_FOLLOWUP_DELAY_MS);
    const beyondLeads = await db.select({
      id: leads.id,
      name: leads.name,
      nextFollowUpAt: leads.nextFollowUpAt,
      opportunityScore: leads.opportunityScore,
      pipelineStage: leads.pipelineStage,
      humanTakeover: leads.humanTakeover,
      cadencePosition: leads.cadencePosition,
    })
      .from(leads)
      .where(and(
        sql`${leads.nextFollowUpAt} > ${maxDate}`,
        eq(leads.humanTakeover, 0),
        sql`${leads.pipelineStage} != 'not_qualified'`,
      ))
      .orderBy(sql`${leads.opportunityScore} DESC, ${leads.nextFollowUpAt} ASC`);

    result.totalFound = beyondLeads.length;
    if (beyondLeads.length === 0) {
      console.log(`[CompressSchedule] No leads found beyond 30-day window`);
      return result;
    }

    console.log(`[CompressSchedule] Found ${beyondLeads.length} leads beyond 30-day window (dryRun: ${dryRun})`);

    // Build the distribution: spread leads across the next spreadDays days
    // Start 7 days from now (give immediate queue time to clear)
    const startOffset = 7 * 24 * 60 * 60 * 1000; // 7 days
    const dayMs = 24 * 60 * 60 * 1000;
    const distributionMap = new Map<string, number>();

    let dayIndex = 0;
    let countToday = 0;

    for (const lead of beyondLeads) {
      // Calculate the target date for this lead
      const targetDate = new Date(Date.now() + startOffset + dayIndex * dayMs);
      // Randomize within the day (business hours: 9 AM - 5 PM ET)
      const hourOffset = 9 + Math.random() * 8; // 9-17
      const minuteOffset = Math.random() * 60;
      targetDate.setHours(Math.floor(hourOffset), Math.floor(minuteOffset), 0, 0);

      // Push to next business hour
      const finalDate = pushToNextBusinessHour(targetDate, "SMS");
      const dateKey = finalDate.toISOString().split("T")[0];
      distributionMap.set(dateKey, (distributionMap.get(dateKey) || 0) + 1);

      if (!dryRun) {
        try {
          await db.update(leads).set({
            nextFollowUpAt: finalDate,
          }).where(eq(leads.id, lead.id));
          result.totalRescheduled++;
        } catch (err) {
          console.error(`[CompressSchedule] Error rescheduling lead ${lead.id}:`, err);
          result.errors++;
        }
      } else {
        result.totalRescheduled++;
      }

      countToday++;
      if (countToday >= maxPerDay) {
        countToday = 0;
        dayIndex++;
        if (dayIndex >= spreadDays) dayIndex = 0; // Wrap around if more leads than slots
      }
    }

    // Build distribution summary
    result.distribution = Array.from(distributionMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    console.log(`[CompressSchedule] ${dryRun ? "DRY RUN" : "EXECUTED"}: ${result.totalRescheduled} leads redistributed across ${result.distribution.length} days`);
    for (const { date, count } of result.distribution) {
      console.log(`  ${date}: ${count} leads`);
    }

  } catch (err) {
    console.error("[CompressSchedule] Fatal error:", err);
    result.errors++;
  }

  return result;
}


// ============================================================
// BACKFILL UNCLASSIFIED SEGMENTS
// ============================================================
// Finds leads with businessName but no omnisendSegment and runs
// classification + research. Catches leads where the Contact Created
// webhook arrived without businessName and enrichment happened later.
// ============================================================

export async function backfillUnclassifiedSegments(maxLeads: number = 50): Promise<{
  processed: number;
  classified: number;
  errors: number;
}> {
  const result = { processed: 0, classified: 0, errors: 0 };

  try {
    const db = await getDb();
    if (!db) return result;

    // Find leads with businessName but no segment
    const unclassified = await db
      .select({
        id: leads.id,
        name: leads.name,
        businessName: leads.businessName,
        website: leads.website,
        source: leads.source,
        email: leads.email,
      })
      .from(leads)
      .where(and(
        sql`${leads.businessName} IS NOT NULL AND ${leads.businessName} != ''`,
        sql`(${leads.omnisendSegment} IS NULL OR ${leads.omnisendSegment} = '')`,
        sql`${leads.pipelineStage} != 'not_qualified'`,
      ))
      .limit(maxLeads);

    console.log(`[BackfillSegment] Found ${unclassified.length} leads with businessName but no segment`);

    for (const lead of unclassified) {
      try {
        const { classifySegment } = await import("./ai-brain");
        const { researchLead } = await import("./lead-researcher");
        const { pushContactToOmnisend } = await import("./omnisend");
        const { updateLeadFields } = await import("./db");

        const segment = await classifySegment(lead.businessName!, lead.website || undefined);
        const updates: Record<string, unknown> = { omnisendSegment: segment };

        try {
          const research = await researchLead({
            name: lead.name || undefined,
            businessName: lead.businessName || undefined,
            source: lead.source || undefined,
            website: lead.website || undefined,
            segment,
            email: lead.email || undefined,
          });
          updates.researchData = research;
        } catch {
          // Research is best-effort
        }

        await updateLeadFields(lead.id, updates);
        result.classified++;

        // Push to Omnisend
        if (lead.email) {
          const nameParts = (lead.name || "").split(" ");
          await pushContactToOmnisend({
            email: lead.email,
            firstName: nameParts[0],
            lastName: nameParts.slice(1).join(" "),
            phone: undefined,
            tags: [segment],
          }).catch(() => {});
        }

        console.log(`[BackfillSegment] Lead ${lead.id} (${lead.businessName}) → ${segment}`);
      } catch (err) {
        console.error(`[BackfillSegment] Error classifying lead ${lead.id}:`, err);
        result.errors++;
      }
      result.processed++;
    }
  } catch (err) {
    console.error("[BackfillSegment] Fatal error:", err);
    result.errors++;
  }

  return result;
}
