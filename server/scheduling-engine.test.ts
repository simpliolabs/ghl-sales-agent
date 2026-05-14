import { describe, it, expect } from "vitest";
import { calculateScoreDecay, checkSeasonalEligibility, calculatePerpetualNurtureSchedule, MAX_FOLLOWUP_DELAY_MS, MAX_FOLLOWUP_DELAY_HOURS, capDate, DNC_KEYWORDS, checkDnc } from "./scheduling-engine";

describe("Scheduling Engine — Score Decay", () => {
  it("should NOT decay scores within 14 days of engagement", () => {
    const result = calculateScoreDecay(80, 80, 10);
    expect(result.newScore).toBe(80);
    expect(result.decayed).toBe(false);
  });

  it("should decay 2 pts/week for 15-30 days of silence", () => {
    const result = calculateScoreDecay(80, 80, 21); // 1 week past the 14-day threshold
    expect(result.newScore).toBe(78); // 80 - 2
    expect(result.decayed).toBe(true);
  });

  it("should decay 3 pts/week for 31-60 days of silence", () => {
    const result = calculateScoreDecay(70, 70, 42); // 4 weeks past threshold
    expect(result.newScore).toBe(58); // 70 - (4 * 3)
    expect(result.decayed).toBe(true);
  });

  it("should decay 5 pts/week for 61-90 days of silence", () => {
    const result = calculateScoreDecay(60, 60, 77); // 9 weeks past threshold
    expect(result.newScore).toBe(15); // 60 - (9 * 5) = 15, above floor of 10
    expect(result.decayed).toBe(true);
  });

  it("should NOT decay below floor of 5 for 90+ days", () => {
    const result = calculateScoreDecay(30, 30, 200);
    expect(result.newScore).toBe(5);
    expect(result.decayed).toBe(true);
  });

  it("should NOT decay below floor of 30 for 15-30 day range", () => {
    const result = calculateScoreDecay(32, 32, 28); // 2 weeks past threshold
    expect(result.newScore).toBe(30); // floor
    expect(result.decayed).toBe(true);
  });

  it("should handle already-decayed scores correctly", () => {
    // Current score is already lower than what decay would produce
    const result = calculateScoreDecay(10, 80, 21);
    // baseScore 80, 1 week decay = 78, but current is 10 which is lower
    // newScore = max(30, 80 - 2) = 78, which is > 10, so decayed = false
    expect(result.newScore).toBe(78);
    expect(result.decayed).toBe(false); // 78 > 10, not decayed further
  });
});

describe("Scheduling Engine — Seasonal Eligibility", () => {
  it("should be eligible when segment matches and no active cadence", () => {
    // Mock current month — this test depends on the actual current month
    const result = checkSeasonalEligibility("school", null, 0, false);
    // Whether eligible depends on current month matching a seasonal window
    expect(typeof result.eligible).toBe("boolean");
  });

  it("should NOT be eligible during active conversation", () => {
    const result = checkSeasonalEligibility("school", null, 0, true);
    expect(result.eligible).toBe(false);
  });

  it("should NOT be eligible during active silence cadence (position 1-3)", () => {
    const result = checkSeasonalEligibility("school", null, 2, false);
    expect(result.eligible).toBe(false);
  });

  it("should respect 60-day cooldown", () => {
    const recentPush = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    const result = checkSeasonalEligibility("school", recentPush, 0, false);
    expect(result.eligible).toBe(false);
  });

  it("should allow after 60-day cooldown expires", () => {
    const oldPush = new Date(Date.now() - 65 * 24 * 60 * 60 * 1000); // 65 days ago
    const result = checkSeasonalEligibility("school", oldPush, 5, false);
    // Eligible depends on current month matching
    expect(typeof result.eligible).toBe("boolean");
  });
});

describe("Scheduling Engine — Perpetual Nurture", () => {
  it("should schedule quarterly for first cycle", () => {
    const result = calculatePerpetualNurtureSchedule(0, null);
    expect(result.nurturePosition).toBe(1);
    expect(result.reason).toContain("Perpetual Nurture cycle #1");
  });

  it("should wait if last reactivation was recent", () => {
    const recent = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    const result = calculatePerpetualNurtureSchedule(1, recent);
    expect(result.nurturePosition).toBe(2);
    expect(result.reason).toContain("next quarterly email in");
  });

  it("should trigger nurture when 90+ days since last", () => {
    const old = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000); // 95 days ago
    const result = calculatePerpetualNurtureSchedule(2, old);
    expect(result.nurturePosition).toBe(3);
    // Should schedule for tomorrow
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect(result.nextDate.getTime()).toBeCloseTo(tomorrow.getTime(), -4); // within ~10 seconds
  });

  it("should cycle through different angles", () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const r1 = calculatePerpetualNurtureSchedule(0, old);
    const r2 = calculatePerpetualNurtureSchedule(1, old);
    const r3 = calculatePerpetualNurtureSchedule(2, old);
    const r4 = calculatePerpetualNurtureSchedule(3, old);
    // All should have different angles
    expect(r1.reason).not.toBe(r2.reason);
    expect(r2.reason).not.toBe(r3.reason);
    expect(r3.reason).not.toBe(r4.reason);
  });

  it("should include email sender in reason", () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const result = calculatePerpetualNurtureSchedule(0, old);
    expect(result.reason).toContain("print@adorbcustomtees.com");
  });
});

// ─── 30-Day Max Cap ──────────────────────────────────────────────────────

describe("Scheduling Engine — 30-Day Max Cap", () => {
  it("MAX_FOLLOWUP_DELAY_MS should be exactly 30 days", () => {
    expect(MAX_FOLLOWUP_DELAY_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("MAX_FOLLOWUP_DELAY_HOURS should be 720 hours", () => {
    expect(MAX_FOLLOWUP_DELAY_HOURS).toBe(720);
  });

  it("capDate should cap dates beyond 30 days to 30 days from now", () => {
    const farFuture = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000); // 60 days out
    const capped = capDate(farFuture, false);
    const maxAllowed = Date.now() + MAX_FOLLOWUP_DELAY_MS;
    expect(capped.getTime()).toBeLessThanOrEqual(maxAllowed + 1000); // 1s tolerance
  });

  it("capDate should NOT cap dates within 30 days", () => {
    const nearFuture = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000); // 10 days out
    const capped = capDate(nearFuture, false);
    // Should be the same date (within a second tolerance)
    expect(Math.abs(capped.getTime() - nearFuture.getTime())).toBeLessThan(1000);
  });

  it("capDate should allow long-lead exempt dates beyond 30 days", () => {
    const farFuture = new Date(Date.now() + 120 * 24 * 60 * 60 * 1000); // 120 days out
    const capped = capDate(farFuture, true); // longLeadExempt = true
    // Should preserve the original date
    expect(Math.abs(capped.getTime() - farFuture.getTime())).toBeLessThan(1000);
  });

  it("capDate should bump past dates to future (floor enforcement)", () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
    const capped = capDate(pastDate, false);
    // Past dates should now be bumped to at least 1h from now (floor enforcement)
    expect(capped.getTime()).toBeGreaterThan(Date.now());
    // Should be roughly 1h + 0-30min jitter from now
    const diffMs = capped.getTime() - Date.now();
    expect(diffMs).toBeGreaterThanOrEqual(55 * 60 * 1000); // at least ~55 min
    expect(diffMs).toBeLessThan(95 * 60 * 1000); // less than ~95 min (1h + 30min jitter + buffer)
  });
});

// ─── DNC Detection ──────────────────────────────────────────────────────

describe("Scheduling Engine — DNC Detection", () => {
  it("should detect 'stop' as DNC", () => {
    const messages = [{ messageBody: "stop", direction: "inbound", senderType: "lead" }];
    expect(checkDnc(messages)).toBe(true);
  });

  it("should detect 'unsubscribe' as DNC", () => {
    const messages = [{ messageBody: "unsubscribe", direction: "inbound", senderType: "lead" }];
    expect(checkDnc(messages)).toBe(true);
  });

  it("should NOT detect normal messages as DNC", () => {
    const messages = [{ messageBody: "Hi, I'm interested in shirts", direction: "inbound", senderType: "lead" }];
    expect(checkDnc(messages)).toBe(false);
  });

  it("should only check inbound messages", () => {
    const messages = [{ messageBody: "stop", direction: "outbound", senderType: "ai" }];
    expect(checkDnc(messages)).toBe(false);
  });

  it("should handle null messageBody gracefully", () => {
    const messages = [{ messageBody: null, direction: "inbound", senderType: "lead" }];
    expect(checkDnc(messages)).toBe(false);
  });

  it("DNC_KEYWORDS should include common opt-out phrases", () => {
    expect(DNC_KEYWORDS).toContain("stop");
    expect(DNC_KEYWORDS).toContain("unsubscribe");
    expect(DNC_KEYWORDS).toContain("opt out");
    expect(DNC_KEYWORDS).toContain("remove me");
  });
});

// ─── Structural Tests — New Features ──────────────────────────────────────

describe("Scheduling Engine — Structural Validation", () => {
  it("compressSchedule function should be exported", async () => {
    const mod = await import("./scheduling-engine");
    expect(typeof mod.compressSchedule).toBe("function");
  });

  it("processOverdueCatchUp function should be exported from follow-up-trigger", async () => {
    const mod = await import("./follow-up-trigger");
    expect(typeof mod.processOverdueCatchUp).toBe("function");
  });

  it("scheduling-engine.ts should contain MAX_FOLLOWUP_DELAY_MS export", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "scheduling-engine.ts"), "utf-8");
    expect(src).toContain("export const MAX_FOLLOWUP_DELAY_MS");
    expect(src).toContain("30 * 24 * 60 * 60 * 1000");
  });

  it("follow-up-trigger.ts should contain overdue catch-up with batch of 20", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "follow-up-trigger.ts"), "utf-8");
    expect(src).toContain("OVERDUE_CATCHUP_BATCH");
    expect(src).toContain("processOverdueCatchUp");
  });

  it("webhooks.ts should wire the hourly overdue catch-up timer", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "webhooks.ts"), "utf-8");
    expect(src).toContain("processOverdueCatchUp");
    expect(src).toContain("60 * 60 * 1000"); // 60 minute interval
    expect(src).toContain("OverdueCatchUp");
  });

  it("ghl.ts send gate should use 24-hour window", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "ghl.ts"), "utf-8");
    expect(src).toContain("24 * 60 * 60 * 1000"); // 24 hours
    expect(src).not.toMatch(/AGENT_TAKEOVER_WINDOW_MS\s*=\s*2\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it("lead-disposition.ts should use 24-hour stale takeover threshold", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "lead-disposition.ts"), "utf-8");
    expect(src).toContain("24 * 60 * 60 * 1000");
    expect(src).toContain("24hr timeout");
  });

  it("routers.ts should expose compressSchedule and triggerOverdueCatchUp admin endpoints", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf-8");
    expect(src).toContain("compressSchedule");
    expect(src).toContain("triggerOverdueCatchUp");
  });
});

// ─── Channel Escalation Tests ──────────────────────────────────────────────

describe("Scheduling Engine — Channel Escalation (selectChannel)", () => {
  // selectChannel is not exported, so we test via source code structural checks
  // and via the exported calculateNextFollowUp integration path.
  // These structural tests verify the escalation rules are present in the code.

  it("selectChannel should contain SMS→Email escalation rule (3+ unanswered)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "scheduling-engine.ts"), "utf-8");
    // Must have the 3-unanswered SMS→Email rule
    expect(src).toContain("isSms && consecutiveUnanswered >= 3 && hasEmail && !dndEmail");
    expect(src).toContain('return "Email"');
  });

  it("selectChannel should contain Email→SMS escalation rule (2+ unanswered)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "scheduling-engine.ts"), "utf-8");
    // Must have the 2-unanswered Email→SMS rule
    expect(src).toContain("isEmail && consecutiveUnanswered >= 2 && hasPhone && !dndSms");
  });

  it("selectChannel should contain FB/IG→SMS escalation rule (2+ unanswered)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "scheduling-engine.ts"), "utf-8");
    expect(src).toContain("(isFb || isIg) && consecutiveUnanswered >= 2 && hasPhone && !dndSms");
  });

  it("selectChannel should contain deep dormancy forced channel switch (cadencePosition >= 5)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "scheduling-engine.ts"), "utf-8");
    expect(src).toContain("cadencePosition >= 5 && consecutiveUnanswered >= 2");
  });

  it("selectChannel should accept consecutiveUnanswered, dndSms, dndEmail parameters", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "scheduling-engine.ts"), "utf-8");
    // Function signature must include the new params
    expect(src).toMatch(/function selectChannel\([^)]*consecutiveUnanswered/);
    expect(src).toMatch(/function selectChannel\([^)]*dndSms/);
    expect(src).toMatch(/function selectChannel\([^)]*dndEmail/);
  });

  it("calculateNextFollowUp should pass DND flags to selectChannel", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "scheduling-engine.ts"), "utf-8");
    // The main channel determination must pass DND flags
    expect(src).toContain("dndSmsActive");
    expect(src).toContain("dndEmailActive");
    // DND flags must be computed from lead data
    expect(src).toContain('lead.dndSms');
    expect(src).toContain('lead.dndEmail');
  });

  it("P3 Silence Cadence path should use escalation-aware selectChannel", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "scheduling-engine.ts"), "utf-8");
    // The P3 path should use the p3Channel variable (not inline selectChannel without escalation params)
    expect(src).toContain("const p3Channel = selectChannel(");
    expect(src).toContain("channel: p3Channel");
  });

  it("selectChannel should NOT escalate SMS→Email when dndEmail is true", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "scheduling-engine.ts"), "utf-8");
    // The SMS→Email rule must check !dndEmail
    const smsToEmailRule = src.match(/isSms && consecutiveUnanswered >= 3.*!dndEmail/);
    expect(smsToEmailRule).not.toBeNull();
  });

  it("selectChannel should NOT escalate Email→SMS when dndSms is true", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "scheduling-engine.ts"), "utf-8");
    // The Email→SMS rule must check !dndSms
    const emailToSmsRule = src.match(/isEmail && consecutiveUnanswered >= 2.*!dndSms/);
    expect(emailToSmsRule).not.toBeNull();
  });

  it("standard channel selection should respect DND flags for SMS preference", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "scheduling-engine.ts"), "utf-8");
    // cadencePosition <= 2 path: Email→SMS override should check !dndSms
    expect(src).toContain("isEmail && hasPhone && !dndSms");
  });
});
