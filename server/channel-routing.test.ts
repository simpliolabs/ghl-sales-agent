/**
 * Tests for Bug Fix Apr 22 2026:
 *  1. sourceToChannel() — single source of truth for source → channel mapping
 *  2. ensureEmailSignature() — signature always present in outbound emails
 *  3. formatEmailHtml() — signature renders correctly in HTML output
 */

import { describe, it, expect } from "vitest";
import { sourceToChannel, ensureEmailSignature, formatEmailHtml } from "./webhook-helpers";

// ─── sourceToChannel ────────────────────────────────────────────────────────

describe("sourceToChannel()", () => {
  it("maps 'Facebook' → 'FB'", () => {
    expect(sourceToChannel("Facebook")).toBe("FB");
  });

  it("maps 'facebook' (lowercase) → 'FB'", () => {
    expect(sourceToChannel("facebook")).toBe("FB");
  });

  it("maps 'fb' → 'FB'", () => {
    expect(sourceToChannel("fb")).toBe("FB");
  });

  it("maps 'lead_form' → 'FB'", () => {
    expect(sourceToChannel("lead_form")).toBe("FB");
  });

  it("maps 'instagram' → 'IG'", () => {
    expect(sourceToChannel("instagram")).toBe("IG");
  });

  it("maps 'ig' → 'IG'", () => {
    expect(sourceToChannel("ig")).toBe("IG");
  });

  it("maps 'email' → 'Email'", () => {
    expect(sourceToChannel("email")).toBe("Email");
  });

  it("maps 'whatsapp' → 'WhatsApp'", () => {
    expect(sourceToChannel("whatsapp")).toBe("WhatsApp");
  });

  it("maps unknown source → 'SMS' (safe default)", () => {
    expect(sourceToChannel("transferred_contact")).toBe("SMS");
    expect(sourceToChannel("r")).toBe("SMS");
    expect(sourceToChannel("ghl")).toBe("SMS");
    expect(sourceToChannel("bulk_import")).toBe("SMS");
  });

  it("maps null → 'SMS'", () => {
    expect(sourceToChannel(null)).toBe("SMS");
  });

  it("maps undefined → 'SMS'", () => {
    expect(sourceToChannel(undefined)).toBe("SMS");
  });

  it("maps empty string → 'SMS'", () => {
    expect(sourceToChannel("")).toBe("SMS");
  });
});

// ─── ensureEmailSignature ────────────────────────────────────────────────────

describe("ensureEmailSignature()", () => {
  it("appends signature when message has no signature", () => {
    const msg = "Hey Michael!\n\nSaw you were looking for custom T-shirts.";
    const result = ensureEmailSignature(msg);
    expect(result).toContain("adorbcustomtees.com");
    expect(result).toContain("Adorb Custom Printing");
    expect(result).toContain("{AGENT}");
  });

  it("does NOT double-append when signature already present (contains brand domain)", () => {
    const msg = "Hey!\n\n---\nBest,\nChris | Adorb Custom Printing\n(954) 932-8543\nprint@adorbcustomtees.com\nadorbcustomtees.com";
    const result = ensureEmailSignature(msg);
    const count = (result.match(/adorbcustomtees\.com/g) || []).length;
    // Should have exactly 2 occurrences (email address + domain) — not more
    expect(count).toBeLessThanOrEqual(2);
  });

  it("does NOT double-append when signature already present (contains brand name)", () => {
    const msg = "Hey!\n\nBest,\nAbby | Adorb Custom Printing";
    const result = ensureEmailSignature(msg);
    const count = (result.match(/Adorb Custom Printing/g) || []).length;
    expect(count).toBe(1);
  });

  it("appends even when message contains '---' without brand anchor", () => {
    const msg = "Here are the options:\n\n---\n\nOption A: 50 shirts\nOption B: 100 shirts";
    const result = ensureEmailSignature(msg);
    expect(result).toContain("adorbcustomtees.com");
  });

  it("returns empty string unchanged", () => {
    expect(ensureEmailSignature("")).toBe("");
  });
});

// ─── Email send path: signature + agent name replacement ────────────────────

describe("Email send path: ensureEmailSignature + {AGENT} replacement + formatEmailHtml", () => {
  it("produces HTML output containing the brand domain", () => {
    const rawMessage = "Hey Michael!\n\nSaw you were looking for custom T-shirts for Abundant Blessings Fellowship.";
    const agentFirst = "Chris";
    const signedMsg = ensureEmailSignature(rawMessage).replace(/\{AGENT\}/g, agentFirst);
    const html = formatEmailHtml(signedMsg);

    expect(html).toContain("adorbcustomtees.com");
    expect(html).toContain("Adorb Custom Printing");
    expect(html).toContain("Chris");
    expect(html).not.toContain("{AGENT}");
  });

  it("produces HTML with the signature rendered", () => {
    const rawMessage = "Hi there!";
    const signedMsg = ensureEmailSignature(rawMessage).replace(/\{AGENT\}/g, "Abby");
    const html = formatEmailHtml(signedMsg);

    expect(html).toContain("adorbcustomtees.com");
    expect(html).toContain("Abby");
  });
});
