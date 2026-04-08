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

  it("lead-disposition.ts has NOT_QUALIFIED_STAGE_IDS for both pipelines", () => {
    const src = readFile("lead-disposition.ts");
    expect(src).toContain("OpojlMx3cTa0ts0e2pMc"); // Bulk Printing Pipeline
    expect(src).toContain("5YIrCvKmzb27yXHP3fBF"); // 100 T-shirt Inquiry
    expect(src).toContain("6f1ca442-4a6b-490f-bf49-95a5870f7f86"); // Bulk Printing NQ stage
    expect(src).toContain("6ca358e4-db09-4818-9896-ab21bad0c0e7"); // 100 T-shirt NQ stage
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
  it("brain-council-orchestrator.ts moves DNC leads to not_qualified (not just humanTakeover)", () => {
    const src = readFile("brain-council-orchestrator.ts");
    // Must set pipelineStage to not_qualified when DNC detected
    expect(src).toContain('pipelineStage: "not_qualified"');
    // Must call updateOpportunityStage for GHL pipeline update
    expect(src).toContain("updateOpportunityStage");
    // Must add a note about DNC
    expect(src).toMatch(/DNC detected.*Not Qualified/);
  });

  it("follow-up-trigger.ts moves DNC leads to not_qualified (not just humanTakeover)", () => {
    const src = readFile("follow-up-trigger.ts");
    // Must set pipelineStage to not_qualified when DNC detected
    expect(src).toContain('pipelineStage: "not_qualified"');
    // Must have the NQ stage IDs
    expect(src).toContain("6f1ca442-4a6b-490f-bf49-95a5870f7f86");
  });

  it("webhook-contact.ts moves DNC leads to not_qualified (not just humanTakeover)", () => {
    const src = readFile("webhook-contact.ts");
    // Must set pipelineStage to not_qualified when DNC detected
    expect(src).toContain('pipelineStage: "not_qualified"');
    // Must have the NQ stage IDs
    expect(src).toContain("6f1ca442-4a6b-490f-bf49-95a5870f7f86");
  });

  it("all DNC handlers use the same NQ stage IDs", () => {
    const files = ["brain-council-orchestrator.ts", "follow-up-trigger.ts", "webhook-contact.ts", "lead-disposition.ts"];
    const bulkNqId = "6f1ca442-4a6b-490f-bf49-95a5870f7f86";
    const inquiryNqId = "6ca358e4-db09-4818-9896-ab21bad0c0e7";

    for (const file of files) {
      const src = readFile(file);
      expect(src).toContain(bulkNqId);
      // lead-disposition.ts and brain-council-orchestrator.ts have both pipeline IDs
      // follow-up-trigger.ts and webhook-contact.ts should also have both
    }
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

describe("Stale Takeover Expiry", () => {
  it("lead-disposition.ts handles NULL lastAgentActivityAt as permanent freeze", () => {
    const src = readFile("lead-disposition.ts");
    expect(src).toContain("Permanently frozen");
    expect(src).toContain("isNull(leads.lastAgentActivityAt)");
  });

  it("lead-disposition.ts handles lastAgentActivityAt > 7 days as stale", () => {
    const src = readFile("lead-disposition.ts");
    expect(src).toContain("7 * 24 * 60 * 60 * 1000");
  });

  it("lead-disposition.ts only processes leads older than 7 days", () => {
    const src = readFile("lead-disposition.ts");
    expect(src).toContain("INTERVAL 7 DAY");
  });
});
