/**
 * migrated-channel.test.ts — Tests for Fix 10: MIGRATED_SOURCES cleanup
 * and enforceMigratedChannel 2-hour safety net.
 *
 * Root cause: 'ghl', 'Facebook', 'fb' were in MIGRATED_SOURCES, causing
 * 326+ new leads (like Pete Marrero) to be treated as migrated email-only
 * contacts even though they came in fresh from Facebook forms.
 */
import { describe, it, expect } from "vitest";
import { MIGRATED_SOURCES, enforceMigratedChannel, isMigratedEmailOnly } from "./webhook-helpers";

describe("MIGRATED_SOURCES list (Fix 10)", () => {
  it("should include transferred_contact", () => {
    expect(MIGRATED_SOURCES).toContain("transferred_contact");
  });

  it("should include 'r' (old import batch)", () => {
    expect(MIGRATED_SOURCES).toContain("r");
  });

  it("should include 'n' (no source label batch)", () => {
    expect(MIGRATED_SOURCES).toContain("n");
  });

  it("should include 'bulk_import'", () => {
    expect(MIGRATED_SOURCES).toContain("bulk_import");
  });

  it("should NOT include 'ghl' — used by new GHL webhook contacts", () => {
    expect(MIGRATED_SOURCES).not.toContain("ghl");
  });

  it("should NOT include 'Facebook' — used by new Facebook form leads", () => {
    expect(MIGRATED_SOURCES).not.toContain("Facebook");
  });

  it("should NOT include 'fb' — used by new Facebook shorthand leads", () => {
    expect(MIGRATED_SOURCES).not.toContain("fb");
  });
});

describe("enforceMigratedChannel — 2-hour safety net (Fix 10)", () => {
  const baseMigratedLead = {
    source: "transferred_contact",
    convState: "new_lead",
    lastMessageAt: null,
    reactivatedFromMigration: 0,
    researchData: null,
  };

  it("should force Email for OLD migrated lead requesting FB", () => {
    const lead = {
      ...baseMigratedLead,
      createdAt: new Date("2025-01-01"), // Very old
    };
    expect(enforceMigratedChannel(lead, "FB")).toBe("Email");
  });

  it("should force Email for OLD migrated lead requesting SMS", () => {
    const lead = {
      ...baseMigratedLead,
      createdAt: new Date("2025-01-01"),
    };
    expect(enforceMigratedChannel(lead, "SMS")).toBe("Email");
  });

  it("should NOT force Email for BRAND NEW lead (< 2 hours old) even if source matches", () => {
    const lead = {
      ...baseMigratedLead,
      createdAt: new Date(), // Just created
    };
    expect(enforceMigratedChannel(lead, "FB")).toBe("FB");
  });

  it("should NOT force Email for lead created 1 hour ago", () => {
    const lead = {
      ...baseMigratedLead,
      createdAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
    };
    expect(enforceMigratedChannel(lead, "SMS")).toBe("SMS");
  });

  it("should force Email for lead created 3 hours ago with migrated source", () => {
    const lead = {
      ...baseMigratedLead,
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000), // 3 hours ago
    };
    expect(enforceMigratedChannel(lead, "FB")).toBe("Email");
  });

  it("should pass through for non-migrated source regardless of age", () => {
    const lead = {
      source: "ghl",
      convState: "new_lead",
      lastMessageAt: null,
      reactivatedFromMigration: 0,
      researchData: null,
      createdAt: new Date("2025-01-01"), // Old but source is 'ghl' — not migrated anymore
    };
    expect(enforceMigratedChannel(lead, "FB")).toBe("FB");
  });

  it("should pass through for reactivated migrated lead", () => {
    const lead = {
      ...baseMigratedLead,
      createdAt: new Date("2025-01-01"),
      reactivatedFromMigration: 1,
    };
    expect(enforceMigratedChannel(lead, "FB")).toBe("FB");
  });

  it("should handle string createdAt (from DB)", () => {
    const lead = {
      ...baseMigratedLead,
      createdAt: new Date().toISOString(), // String format from DB
    };
    expect(enforceMigratedChannel(lead, "FB")).toBe("FB"); // Brand new
  });

  it("should handle null createdAt gracefully — fall through to migration check", () => {
    const lead = {
      ...baseMigratedLead,
      createdAt: null,
    };
    // No createdAt → skip safety net → check migration → is migrated → Email
    expect(enforceMigratedChannel(lead, "FB")).toBe("Email");
  });
});

describe("Pete Marrero scenario (Fix 10)", () => {
  it("new GHL contact from FB form should NOT be treated as migrated", () => {
    const peteMarrero = {
      source: "ghl",
      convState: "new_lead",
      lastMessageAt: null,
      reactivatedFromMigration: 0,
      researchData: null,
      createdAt: new Date(), // Just created via webhook
    };
    // source='ghl' is no longer in MIGRATED_SOURCES
    expect(isMigratedEmailOnly(peteMarrero)).toBe(false);
    // Channel should stay FB
    expect(enforceMigratedChannel(peteMarrero, "FB")).toBe("FB");
  });

  it("new Facebook source contact should NOT be treated as migrated", () => {
    const fbLead = {
      source: "Facebook",
      convState: "new_lead",
      lastMessageAt: null,
      reactivatedFromMigration: 0,
      researchData: null,
      createdAt: new Date(),
    };
    expect(isMigratedEmailOnly(fbLead)).toBe(false);
    expect(enforceMigratedChannel(fbLead, "FB")).toBe("FB");
  });
});
