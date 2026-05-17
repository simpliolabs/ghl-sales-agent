import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ================================================================
// STRUCTURAL TESTS — Verify the disposition engine exists and is wired correctly
// ================================================================

function readFile(name: string): string {
  return fs.readFileSync(path.join(__dirname, name), "utf-8");
}

describe("Lead Disposition Engine — Structural Tests", () => {
  it("lead-disposition.ts exports runDispositionSweep", () => {
    const src = readFile("lead-disposition.ts");
    expect(src).toContain("export async function runDispositionSweep");
  });

  it("lead-disposition.ts uses centralized ghl-stages for NQ stage IDs", () => {
    const src = readFile("lead-disposition.ts");
    // Must import from shared/ghl-stages instead of hardcoding IDs
    expect(src).toContain("ghl-stages");
    expect(src).toContain("getNqStageId");
  });

  it("lead-disposition.ts has moveToNotQualified function", () => {
    const src = readFile("lead-disposition.ts");
    expect(src).toContain("async function moveToNotQualified");
  });

  it("lead-disposition.ts has escalateToEmail function", () => {
    const src = readFile("lead-disposition.ts");
    expect(src).toContain("async function escalateToEmail");
  });

  it("lead-disposition.ts checks for DNC keywords using checkDnc", () => {
    const src = readFile("lead-disposition.ts");
    expect(src).toContain("checkDnc(");
  });

  it("lead-disposition.ts handles stale humanTakeover with NULL lastAgentActivityAt", () => {
    const src = readFile("lead-disposition.ts");
    expect(src).toContain("isNull(leads.lastAgentActivityAt)");
  });

  it("lead-disposition.ts notifies owner on significant dispositions", () => {
    const src = readFile("lead-disposition.ts");
    expect(src).toContain("notifyOwner");
  });

  it("lead-disposition.ts has MAX_PER_CYCLE limit", () => {
    const src = readFile("lead-disposition.ts");
    expect(src).toMatch(/MAX_PER_CYCLE\s*=\s*\d+/);
  });

  it("webhooks.ts imports and schedules the disposition sweep", () => {
    const src = readFile("webhooks.ts");
    expect(src).toContain('import { runDispositionSweep } from "./lead-disposition"');
    expect(src).toContain("runDispositionSweep()");
    expect(src).toContain("dispositionRunning");
  });

  it("webhooks.ts runs disposition sweep every 2 hours", () => {
    const src = readFile("webhooks.ts");
    expect(src).toContain("2 * 60 * 60 * 1000");
  });

  it("webhooks.ts runs initial disposition sweep 3 minutes after startup", () => {
    const src = readFile("webhooks.ts");
    expect(src).toContain("3 * 60 * 1000");
  });

  it("routers.ts exposes triggerDisposition admin endpoint", () => {
    const src = readFile("routers.ts");
    expect(src).toContain("triggerDisposition");
    expect(src).toContain("runDispositionSweep");
  });
});

describe("DNC → Not Qualified Pipeline — All Entry Points", () => {


  it("follow-up-trigger.ts moves DNC leads to not_qualified (not just humanTakeover)", () => {
    const src = readFile("follow-up-trigger.ts");
    // Must set pipelineStage to not_qualified when DNC detected
    expect(src).toContain('pipelineStage: "not_qualified"');
    // Must use centralized getNqStageId helper
    expect(src).toContain("getNqStageId");
  });

  it("webhook-contact.ts moves DNC leads to not_qualified (not just humanTakeover)", () => {
    const src = readFile("webhook-contact.ts");
    // Must set pipelineStage to not_qualified when DNC detected
    expect(src).toContain('pipelineStage: "not_qualified"');
    // Must use centralized getNqStageId helper
    expect(src).toContain("getNqStageId");
  });

  it("all DNC handlers use centralized ghl-stages instead of hardcoded IDs", () => {
    const files = ["follow-up-trigger.ts", "webhook-contact.ts", "lead-disposition.ts"];
    for (const file of files) {
      const src = readFile(file);
      // All files must import from shared/ghl-stages (either static or dynamic import)
      expect(src).toContain("ghl-stages");
    }
    // The centralized file must have the real NQ stage IDs
    const centralSrc = fs.readFileSync(path.join(__dirname, "../shared/ghl-stages.ts"), "utf-8");
    expect(centralSrc).toContain("6f1ca442-4a6b-490f-bf49-95a5870f7f86"); // Bulk Printing NQ
    expect(centralSrc).toContain("6ca358e4-db09-4818-9896-ab21bad0c0e7"); // T-shirt Inquiry NQ
  });
});

describe("Email Escalation Logic", () => {
  it("lead-disposition.ts escalates to email when SMS is blocked but email is available", () => {
    const src = readFile("lead-disposition.ts");
    expect(src).toContain("escalateToEmail");
    expect(src).toContain('preferredChannel: "EMAIL"');
  });

  it("lead-disposition.ts resets cadencePosition on email escalation", () => {
    const src = readFile("lead-disposition.ts");
    expect(src).toContain("cadencePosition: 0");
  });

  it("lead-disposition.ts schedules next follow-up for email escalation", () => {
    const src = readFile("lead-disposition.ts");
    expect(src).toContain("nextFollowUpAt");
  });
});

describe("365+ Day Dormant Lead Guard (v3)", () => {
  it("lead-disposition.ts includes createdAt in stale takeover query", () => {
    const src = readFile("lead-disposition.ts");
    // The stale takeover query must select createdAt to calculate lead age
    expect(src).toContain("createdAt: leads.createdAt");
  });

  it("lead-disposition.ts has 365+ day dormant lead guard before email escalation", () => {
    const src = readFile("lead-disposition.ts");
    expect(src).toContain("365+ DAY DORMANT LEAD GUARD");
    expect(src).toContain("isDormant365");
    // Guard must come BEFORE the email escalation check
    const guardIdx = src.indexOf("isDormant365");
    const emailEscIdx = src.indexOf("Escalate to email");
    expect(guardIdx).toBeLessThan(emailEscIdx);
  });

  it("lead-disposition.ts does NOT flip 365+ day leads to Email when they have phone+SMS", () => {
    const src = readFile("lead-disposition.ts");
    // When isDormant365 && hasPhone && smsNotBlocked → keep current channel, do NOT call escalateToEmail
    expect(src).toContain('not flipping to Email');
    // The guard should set preferredChannel to current (not "EMAIL")
    expect(src).toContain('currentChannel === "EMAIL" ? "SMS" : currentChannel');
  });

  it("lead-disposition.ts releases humanTakeover for 365+ day dormant leads", () => {
    const src = readFile("lead-disposition.ts");
    // The guard should release humanTakeover (set to 0)
    const guardSection = src.split("365+ DAY DORMANT LEAD GUARD")[1]?.split("continue;")[0] || "";
    expect(guardSection).toContain("humanTakeover: 0");
  });

  it("lead-disposition.ts schedules follow-up for 365+ day dormant leads", () => {
    const src = readFile("lead-disposition.ts");
    // The guard should schedule a follow-up (2hr from now)
    const guardSection = src.split("365+ DAY DORMANT LEAD GUARD")[1]?.split("continue;")[0] || "";
    expect(guardSection).toContain("nextFollowUpAt");
  });

  it("lead-disposition.ts still escalates to Email for NON-dormant leads", () => {
    const src = readFile("lead-disposition.ts");
    // After the 365+ day guard, the normal email escalation path should still exist
    expect(src).toContain("escalateToEmail(candidate.id, reason)");
  });

  it("lead-disposition.ts permanent freeze path now checks phone first", () => {
    const src = readFile("lead-disposition.ts");
    // The permanent freeze section should check hasPhone && smsNotBlocked before Email
    const freezeSection = src.split("permanent freeze bug")[1]?.split("} else {")[0] || "";
    expect(freezeSection).toContain("hasPhone && smsNotBlocked");
  });
});

describe("Stale Takeover Expiry", () => {
  it("lead-disposition.ts handles NULL lastAgentActivityAt as permanent freeze", () => {
    const src = readFile("lead-disposition.ts");
    expect(src).toContain("Permanently frozen");
    expect(src).toContain("isNull(leads.lastAgentActivityAt)");
  });

  it("lead-disposition.ts handles lastAgentActivityAt > 4 hours as stale (Phase 0: reduced from 24h)", () => {
    const src = readFile("lead-disposition.ts");
    expect(src).toContain("4 * 60 * 60 * 1000"); // Phase 0: 4hr timeout
  });

  it("lead-disposition.ts stale takeover query does NOT have 3-day age filter (removed to fix lead #690005)", () => {
    const src = readFile("lead-disposition.ts");
    expect(src).toContain("Removed 3-day age filter");
    // Comment still references 24hr but the actual threshold is now 4h (Phase 0)
    expect(src).toContain("agent inactivity window is sufficient");
  });

  it("lead-disposition.ts handles agent-silent leads with >24hr stale takeover", () => {
    const src = readFile("lead-disposition.ts");
    expect(src).toContain("agent went silent");
    expect(src).toContain("Released stale takeover");
    expect(src).toContain("2 * 60 * 60 * 1000");
  });

  it("lead-disposition.ts permanent freeze path prioritizes phone over email", () => {
    const src = readFile("lead-disposition.ts");
    // The permanent freeze section should check hasPhone && smsNotBlocked FIRST
    const freezeSection = src.split("permanent freeze bug")[1] || "";
    const phoneIdx = freezeSection.indexOf("hasPhone && smsNotBlocked");
    const emailIdx = freezeSection.indexOf("hasEmail && emailNotBlocked");
    expect(phoneIdx).toBeGreaterThan(-1);
    expect(emailIdx).toBeGreaterThan(-1);
    expect(phoneIdx).toBeLessThan(emailIdx);
  });
});

describe("Post-Enrichment Segment Classification", () => {
  it("webhook-message.ts runs classifySegment when businessName is enriched but segment is NULL", () => {
    const src = readFile("webhook-message.ts");
    expect(src).toContain("POST-ENRICHMENT SEGMENT CLASSIFICATION");
    expect(src).toContain("classifySegment");
    expect(src).toContain("!lead!.omnisendSegment");
  });

  it("webhook-message.ts imports classifySegment and researchLead", () => {
    const src = readFile("webhook-message.ts");
    expect(src).toContain('import { shouldHandoffToAgent, generateContactNotes, estimateOrderValue, classifySegment }');
    expect(src).toContain('import { researchLead }');
    expect(src).toContain('import { pushContactToOmnisend }');
  });

  it("scheduling-engine.ts exports backfillUnclassifiedSegments", () => {
    const src = readFile("scheduling-engine.ts");
    expect(src).toContain("export async function backfillUnclassifiedSegments");
  });

  it("routers.ts exposes backfillUnclassified admin endpoint", () => {
    const src = readFile("routers.ts");
    expect(src).toContain("backfillUnclassified");
    expect(src).toContain("backfillUnclassifiedSegments");
  });
});
