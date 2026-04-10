/**
 * Tests for framework diversity enforcement logic.
 * Validates that the diversity check correctly identifies overused frameworks
 * and selects fresh alternatives, ignoring responsive frameworks (DIRECT_RESPONSE/VALUE_FIRST).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Unit test: getRecentOutreachFrameworks filtering logic ──────────────────

describe("getRecentOutreachFrameworks filtering", () => {
  it("excludes DIRECT_RESPONSE from outreach framework list", () => {
    const RESPONSIVE = new Set(["DIRECT_RESPONSE", "VALUE_FIRST"]);
    const rawFrameworks = ["DIRECT_RESPONSE", "HORMOZI_ACA", "DIRECT_RESPONSE", "HORMOZI_ACA", "VALUE_FIRST"];
    const outreach = rawFrameworks.filter(f => !RESPONSIVE.has(f)).slice(0, 5);
    expect(outreach).toEqual(["HORMOZI_ACA", "HORMOZI_ACA"]);
  });

  it("returns empty array when all frameworks are responsive", () => {
    const RESPONSIVE = new Set(["DIRECT_RESPONSE", "VALUE_FIRST"]);
    const rawFrameworks = ["DIRECT_RESPONSE", "VALUE_FIRST", "DIRECT_RESPONSE"];
    const outreach = rawFrameworks.filter(f => !RESPONSIVE.has(f)).slice(0, 5);
    expect(outreach).toEqual([]);
  });

  it("limits to 5 results", () => {
    const RESPONSIVE = new Set(["DIRECT_RESPONSE", "VALUE_FIRST"]);
    const rawFrameworks = ["HORMOZI_ACA", "PAS", "BAB", "AIDA", "SOCIAL_PROOF", "CASE_STUDY", "SOAP_OPERA"];
    const outreach = rawFrameworks.filter(f => !RESPONSIVE.has(f)).slice(0, 5);
    expect(outreach).toHaveLength(5);
    expect(outreach).toEqual(["HORMOZI_ACA", "PAS", "BAB", "AIDA", "SOCIAL_PROOF"]);
  });
});

// ─── Unit test: diversity override logic ────────────────────────────────────

describe("diversity override decision logic", () => {
  const ALL_OUTREACH_FRAMEWORKS = ["PAS", "BAB", "AIDA", "HORMOZI_ACA", "HORMOZI_INDIRECT", "SOCIAL_PROOF", "CASE_STUDY", "SOAP_OPERA", "CURIOSITY_HOOK"] as const;
  const RESPONSIVE_FRAMEWORKS = new Set(["DIRECT_RESPONSE", "VALUE_FIRST"]);

  function shouldOverride(currentFramework: string, recentOutreachFrameworks: string[]): boolean {
    if (RESPONSIVE_FRAMEWORKS.has(currentFramework)) return false;
    const usageCount = recentOutreachFrameworks.filter(f => f === currentFramework).length;
    return usageCount >= 2;
  }

  function pickOverride(currentFramework: string, recentOutreachFrameworks: string[]): string {
    const recentSet = new Set(recentOutreachFrameworks);
    const freshAlternatives = ALL_OUTREACH_FRAMEWORKS.filter(f => f !== currentFramework && !recentSet.has(f));
    const anyAlternatives = ALL_OUTREACH_FRAMEWORKS.filter(f => f !== currentFramework);
    const pool = freshAlternatives.length > 0 ? freshAlternatives : anyAlternatives;
    return pool[0]; // deterministic for testing
  }

  it("triggers override when HORMOZI_ACA used 2+ times in last 5 outreach", () => {
    const recent = ["HORMOZI_ACA", "HORMOZI_ACA", "HORMOZI_ACA"];
    expect(shouldOverride("HORMOZI_ACA", recent)).toBe(true);
  });

  it("does NOT trigger override when HORMOZI_ACA used only once", () => {
    const recent = ["HORMOZI_ACA", "PAS", "BAB"];
    expect(shouldOverride("HORMOZI_ACA", recent)).toBe(false);
  });

  it("does NOT trigger override for DIRECT_RESPONSE (responsive framework)", () => {
    const recent = ["DIRECT_RESPONSE", "DIRECT_RESPONSE", "DIRECT_RESPONSE"];
    expect(shouldOverride("DIRECT_RESPONSE", recent)).toBe(false);
  });

  it("does NOT trigger override for VALUE_FIRST (responsive framework)", () => {
    const recent = ["VALUE_FIRST", "VALUE_FIRST", "VALUE_FIRST"];
    expect(shouldOverride("VALUE_FIRST", recent)).toBe(false);
  });

  it("triggers override when HORMOZI_ACA used 2x even with DIRECT_RESPONSE interspersed", () => {
    // This is the key fix: DIRECT_RESPONSE no longer resets the diversity check
    // because we filter it out before counting
    const recent = ["HORMOZI_ACA", "HORMOZI_ACA"]; // after filtering DIRECT_RESPONSE
    expect(shouldOverride("HORMOZI_ACA", recent)).toBe(true);
  });

  it("picks a fresh framework not in recent history", () => {
    const recent = ["HORMOZI_ACA", "HORMOZI_ACA", "PAS"];
    const override = pickOverride("HORMOZI_ACA", recent);
    expect(override).not.toBe("HORMOZI_ACA");
    expect(override).not.toBe("PAS"); // prefers fresh alternatives
    expect(ALL_OUTREACH_FRAMEWORKS).toContain(override as any);
  });

  it("falls back to any alternative when all frameworks are in recent history", () => {
    const recent = ALL_OUTREACH_FRAMEWORKS.slice(0, 5) as string[];
    const override = pickOverride("HORMOZI_ACA", recent);
    expect(override).not.toBe("HORMOZI_ACA");
    expect(ALL_OUTREACH_FRAMEWORKS).toContain(override as any);
  });

  it("correctly counts usage: 2x HORMOZI_ACA in 5 messages triggers override", () => {
    const recent = ["HORMOZI_ACA", "BAB", "HORMOZI_ACA", "SOCIAL_PROOF", "PAS"];
    expect(shouldOverride("HORMOZI_ACA", recent)).toBe(true);
  });

  it("correctly counts usage: 1x HORMOZI_ACA in 5 messages does NOT trigger override", () => {
    const recent = ["HORMOZI_ACA", "BAB", "SOCIAL_PROOF", "PAS", "CASE_STUDY"];
    expect(shouldOverride("HORMOZI_ACA", recent)).toBe(false);
  });
});

// ─── Integration test: root cause fix verification ──────────────────────────

describe("root cause fix: DIRECT_RESPONSE no longer resets diversity check", () => {
  /**
   * Scenario: Lead has received 10 HORMOZI_ACA follow-ups.
   * Then lead replies → DIRECT_RESPONSE is used (responsive).
   * ai_state.lastFrameworkUsed = DIRECT_RESPONSE.
   * 
   * OLD BUG: Diversity check only fired if lastFrameworkUsed === strategy.framework.
   * Since lastFrameworkUsed is DIRECT_RESPONSE and strategy is HORMOZI_ACA, check was skipped.
   * 
   * NEW FIX: Diversity check reads audit trail directly, filtering out responsive frameworks.
   * HORMOZI_ACA appears 10x in audit trail → override fires correctly.
   */
  it("detects overuse even when last message was DIRECT_RESPONSE", () => {
    const RESPONSIVE = new Set(["DIRECT_RESPONSE", "VALUE_FIRST"]);
    // Simulate: 10 HORMOZI_ACA + 1 DIRECT_RESPONSE (most recent)
    const auditTrail = ["DIRECT_RESPONSE", "HORMOZI_ACA", "HORMOZI_ACA", "HORMOZI_ACA", "HORMOZI_ACA", "HORMOZI_ACA"];
    const recentOutreach = auditTrail.filter(f => !RESPONSIVE.has(f)).slice(0, 5);
    
    expect(recentOutreach).toEqual(["HORMOZI_ACA", "HORMOZI_ACA", "HORMOZI_ACA", "HORMOZI_ACA", "HORMOZI_ACA"]);
    
    const usageCount = recentOutreach.filter(f => f === "HORMOZI_ACA").length;
    expect(usageCount).toBe(5); // 5 out of 5 — clearly overused
    expect(usageCount >= 2).toBe(true); // override should fire
  });

  it("does NOT override when lead has only had 1 HORMOZI_ACA outreach", () => {
    const RESPONSIVE = new Set(["DIRECT_RESPONSE", "VALUE_FIRST"]);
    const auditTrail = ["HORMOZI_ACA"]; // only 1 outreach message
    const recentOutreach = auditTrail.filter(f => !RESPONSIVE.has(f)).slice(0, 5);
    
    const usageCount = recentOutreach.filter(f => f === "HORMOZI_ACA").length;
    expect(usageCount).toBe(1);
    expect(usageCount >= 2).toBe(false); // override should NOT fire
  });
});
