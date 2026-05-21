/**
 * Foundation C.3 — Fabricated Infrastructure Guardrail Tests
 *
 * Verifies that Rules 18-20 are present and correctly worded in both
 * single-brain.ts and brain-council.ts COMPOSER_PROMPT.
 *
 * These are prompt-content tests — they verify the guardrail text is
 * present in the system prompts, not that the LLM obeys it (live LLM
 * compliance is verified via the verifyFoundationC3 endpoint post-deploy).
 */

import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";

const SINGLE_BRAIN_PATH = join(__dirname, "single-brain.ts");
const BRAIN_COUNCIL_PATH = join(__dirname, "brain-council.ts");

const singleBrainSrc = readFileSync(SINGLE_BRAIN_PATH, "utf-8");
const brainCouncilSrc = readFileSync(BRAIN_COUNCIL_PATH, "utf-8");

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extract the HARD CONSTRAINTS block from single-brain.ts */
function extractHardConstraints(src: string): string {
  const start = src.indexOf("HARD CONSTRAINTS (violating ANY of these = system failure)");
  const end = src.indexOf("═══ COLD OUTREACH FORMAT");
  if (start === -1 || end === -1) return "";
  return src.slice(start, end);
}

/** Extract the COMPOSER_PROMPT from brain-council.ts */
function extractComposerPrompt(src: string): string {
  const start = src.indexOf("const COMPOSER_PROMPT = `");
  const end = src.indexOf("You write the message. The QC brain will review it before it goes out.`");
  if (start === -1 || end === -1) return "";
  return src.slice(start, end);
}

const hardConstraints = extractHardConstraints(singleBrainSrc);
const composerPrompt = extractComposerPrompt(brainCouncilSrc);

// ── Rule 18: NEVER FABRICATE INFRASTRUCTURE ───────────────────────────────

describe("Rule 18 — NEVER FABRICATE INFRASTRUCTURE (single-brain.ts)", () => {
  it("Rule 18 header is present", () => {
    expect(hardConstraints).toContain("18. NEVER FABRICATE INFRASTRUCTURE");
  });

  it("calendar invite prohibition is explicit", () => {
    expect(hardConstraints).toContain("Calendar invites (Adorb does NOT send calendar invites");
  });

  it("appointment confirmation prohibition is explicit", () => {
    expect(hardConstraints).toContain("Appointment confirmations the customer didn't explicitly book");
  });

  it("customer portals prohibition is explicit", () => {
    expect(hardConstraints).toContain("Customer portals, account dashboards, login links (these do not exist)");
  });

  it("order numbers prohibition is explicit", () => {
    expect(hardConstraints).toContain("Order numbers, invoice numbers, tracking numbers unless verified");
  });

  it("'as discussed in our meeting' prohibition is explicit", () => {
    expect(hardConstraints).toContain("As discussed in our meeting");
  });

  it("instructs to ASK before claiming a call exists", () => {
    expect(hardConstraints).toContain("If you want to schedule a call, ASK if they'd like to schedule one");
  });
});

describe("Rule 18 — NEVER FABRICATE INFRASTRUCTURE (brain-council.ts COMPOSER_PROMPT)", () => {
  it("FABRICATED INFRASTRUCTURE section is present", () => {
    expect(composerPrompt).toContain("FABRICATED INFRASTRUCTURE (HARD CONSTRAINT)");
  });

  it("calendar invite prohibition is explicit", () => {
    expect(composerPrompt).toContain("Calendar invites (Adorb does NOT send calendar invites");
  });

  it("customer portals prohibition is explicit", () => {
    expect(composerPrompt).toContain("Customer portals, account dashboards, login links (these do not exist)");
  });

  it("instructs to ASK before claiming a call exists", () => {
    expect(composerPrompt).toContain("If you want to schedule a call, ASK if they'd like to schedule one");
  });
});

// ── Rule 19: TIGHTEN THE FOLLOW-UP HOOK ───────────────────────────────────

describe("Rule 19 — TIGHTEN THE FOLLOW-UP HOOK (single-brain.ts)", () => {
  it("Rule 19 header is present", () => {
    expect(hardConstraints).toContain("19. TIGHTEN THE FOLLOW-UP HOOK");
  });

  it("5+ unanswered threshold is specified", () => {
    expect(hardConstraints).toContain("5+ unanswered");
  });

  it("stale_thread_close_loop reason code is present", () => {
    expect(hardConstraints).toContain("stale_thread_close_loop");
  });

  it("explicitly bans inventing process steps to fill silence", () => {
    expect(hardConstraints).toContain("NEVER invent process steps to fill the silence");
  });

  it("names the calendar invite as the specific failure mode", () => {
    expect(hardConstraints).toContain("a calendar invite, an appointment, a \"confirming\"");
  });
});

describe("Rule 19 — FOLLOW-UP HOOK DISCIPLINE (brain-council.ts COMPOSER_PROMPT)", () => {
  it("FOLLOW-UP HOOK DISCIPLINE section is present", () => {
    expect(composerPrompt).toContain("FOLLOW-UP HOOK DISCIPLINE");
  });

  it("5+ consecutive unanswered threshold is specified", () => {
    expect(composerPrompt).toContain("5+ consecutive unanswered");
  });

  it("explicitly bans inventing process steps to fill silence", () => {
    expect(composerPrompt).toContain("NEVER invent process steps to fill the silence");
  });
});

// ── Rule 20: REALITY CHECK ────────────────────────────────────────────────

describe("Rule 20 — REALITY CHECK BEFORE COMPOSING (single-brain.ts)", () => {
  it("Rule 20 header is present", () => {
    expect(hardConstraints).toContain("20. REALITY CHECK BEFORE COMPOSING");
  });

  it("audit question is present", () => {
    expect(hardConstraints).toContain("If audited, would Adorb's team confirm this artifact exists?");
  });

  it("REWRITE instruction is present", () => {
    expect(hardConstraints).toContain("REWRITE without that reference");
  });
});

describe("Rule 20 — REALITY CHECK (brain-council.ts COMPOSER_PROMPT)", () => {
  it("REALITY CHECK section is present", () => {
    expect(composerPrompt).toContain("REALITY CHECK");
  });

  it("audit question is present", () => {
    expect(composerPrompt).toContain("If audited, would Adorb's team confirm this artifact exists?");
  });

  it("REWRITE instruction is present", () => {
    expect(composerPrompt).toContain("REWRITE without that reference");
  });
});

// ── Structural integrity ───────────────────────────────────────────────────

describe("Structural integrity — rules are in correct order", () => {
  it("single-brain.ts: Rule 18 appears after Rule 17", () => {
    const r17 = hardConstraints.indexOf("17. SIGN-OFFS");
    const r18 = hardConstraints.indexOf("18. NEVER FABRICATE INFRASTRUCTURE");
    expect(r17).toBeGreaterThan(-1);
    expect(r18).toBeGreaterThan(r17);
  });

  it("single-brain.ts: Rule 19 appears after Rule 18", () => {
    const r18 = hardConstraints.indexOf("18. NEVER FABRICATE INFRASTRUCTURE");
    const r19 = hardConstraints.indexOf("19. TIGHTEN THE FOLLOW-UP HOOK");
    expect(r18).toBeGreaterThan(-1);
    expect(r19).toBeGreaterThan(r18);
  });

  it("single-brain.ts: Rule 20 appears after Rule 19", () => {
    const r19 = hardConstraints.indexOf("19. TIGHTEN THE FOLLOW-UP HOOK");
    const r20 = hardConstraints.indexOf("20. REALITY CHECK BEFORE COMPOSING");
    expect(r19).toBeGreaterThan(-1);
    expect(r20).toBeGreaterThan(r19);
  });

  it("brain-council.ts: FABRICATED INFRASTRUCTURE appears after ANTI-REPETITION RULES", () => {
    const antiRep = composerPrompt.indexOf("ANTI-REPETITION RULES");
    const fabInfra = composerPrompt.indexOf("FABRICATED INFRASTRUCTURE");
    expect(antiRep).toBeGreaterThan(-1);
    expect(fabInfra).toBeGreaterThan(antiRep);
  });

  it("brain-council.ts: REALITY CHECK appears after FOLLOW-UP HOOK DISCIPLINE", () => {
    const hookDisc = composerPrompt.indexOf("FOLLOW-UP HOOK DISCIPLINE");
    const realityCheck = composerPrompt.indexOf("REALITY CHECK");
    expect(hookDisc).toBeGreaterThan(-1);
    expect(realityCheck).toBeGreaterThan(hookDisc);
  });
});
