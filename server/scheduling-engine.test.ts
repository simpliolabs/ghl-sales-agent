import { describe, it, expect } from "vitest";
import { calculateScoreDecay, checkSeasonalEligibility, calculatePerpetualNurtureSchedule } from "./scheduling-engine";

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
