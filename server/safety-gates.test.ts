/**
 * Layer 0: Safety Gates — Tests for DNC/DND pre-flight checks, email HTML formatting, and review links
 */
import { describe, it, expect } from "vitest";

// ============================================================
// Test 1: formatEmailHtml helper
// ============================================================
describe("formatEmailHtml", () => {
  // Import the function directly
  let formatEmailHtml: (text: string) => string;

  it("should be importable from webhook-helpers", async () => {
    const mod = await import("./webhook-helpers");
    formatEmailHtml = mod.formatEmailHtml;
    expect(typeof formatEmailHtml).toBe("function");
  });

  it("should convert newlines to <br> tags", async () => {
    const mod = await import("./webhook-helpers");
    formatEmailHtml = mod.formatEmailHtml;
    const input = "Hey there,\n\nThis is line 2.\n\nBest,\nChris";
    const result = formatEmailHtml(input);
    expect(result).toContain("<br>");
    expect(result).not.toBe(`<p>${input}</p>`);
  });

  it("should preserve existing HTML tags", async () => {
    const mod = await import("./webhook-helpers");
    formatEmailHtml = mod.formatEmailHtml;
    const input = "<p>Already formatted</p>";
    const result = formatEmailHtml(input);
    expect(result).toContain("<p>Already formatted</p>");
  });

  it("should handle empty string", async () => {
    const mod = await import("./webhook-helpers");
    formatEmailHtml = mod.formatEmailHtml;
    const result = formatEmailHtml("");
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
  });

  it("should handle text with no newlines", async () => {
    const mod = await import("./webhook-helpers");
    formatEmailHtml = mod.formatEmailHtml;
    const result = formatEmailHtml("Single line message");
    expect(result).toContain("Single line message");
  });

  it("should handle signature block formatting", async () => {
    const mod = await import("./webhook-helpers");
    formatEmailHtml = mod.formatEmailHtml;
    const input = "Hey there,\n\nGreat to connect!\n\n---\nBest,\nChris | Adorb Custom Printing\n(954) 932-8543\nprint@adorbcustomtees.com";
    const result = formatEmailHtml(input);
    expect(result).toContain("<br>");
    // Should have line breaks between signature lines
    expect(result).toContain("Chris");
    expect(result).toContain("Adorb");
  });
});

// ============================================================
// Test 2: DNC keyword detection
// ============================================================
describe("DNC keyword detection", () => {
  it("should export DNC_KEYWORDS from scheduling-engine", async () => {
    const mod = await import("./scheduling-engine");
    expect(mod.DNC_KEYWORDS).toBeDefined();
    expect(Array.isArray(mod.DNC_KEYWORDS)).toBe(true);
    expect(mod.DNC_KEYWORDS.length).toBeGreaterThan(0);
  });

  it("should export checkDnc function from scheduling-engine", async () => {
    const mod = await import("./scheduling-engine");
    expect(typeof mod.checkDnc).toBe("function");
  });

  it("DNC_KEYWORDS should include common opt-out phrases", async () => {
    const mod = await import("./scheduling-engine");
    const keywords = mod.DNC_KEYWORDS.map((k: string) => k.toLowerCase());
    expect(keywords).toContain("stop");
    expect(keywords).toContain("unsubscribe");
  });

  it("checkDnc should detect DNC keywords in message array", async () => {
    const mod = await import("./scheduling-engine");
    // checkDnc checks if lower === kw or starts/ends with kw
    const messages = [
      { messageBody: "stop", direction: "inbound", senderType: "lead" },
    ];
    const result = mod.checkDnc(messages as any);
    expect(result).toBe(true);
  });

  it("checkDnc should detect DNC keyword at start of message", async () => {
    const mod = await import("./scheduling-engine");
    const messages = [
      { messageBody: "Stop messaging me", direction: "inbound", senderType: "lead" },
    ];
    const result = mod.checkDnc(messages as any);
    expect(result).toBe(true);
  });

  it("checkDnc should detect DNC keyword at end of message", async () => {
    const mod = await import("./scheduling-engine");
    const messages = [
      { messageBody: "please unsubscribe", direction: "inbound", senderType: "lead" },
    ];
    const result = mod.checkDnc(messages as any);
    expect(result).toBe(true);
  });

  it("checkDnc should not flag normal messages", async () => {
    const mod = await import("./scheduling-engine");
    const messages = [
      { messageBody: "Yes I'm interested in custom shirts", direction: "inbound", senderType: "lead" },
    ];
    const result = mod.checkDnc(messages as any);
    expect(result).toBe(false);
  });

  it("checkDnc should only check inbound messages", async () => {
    const mod = await import("./scheduling-engine");
    const messages = [
      { messageBody: "stop", direction: "outbound", senderType: "ai" },
    ];
    const result = mod.checkDnc(messages as any);
    expect(result).toBe(false);
  });
});

// ============================================================
// Test 3: Review links are correct
// ============================================================
describe("Review links correctness", () => {
  it("composer.ts should not contain g.co/kgs/adorb", async () => {
    const fs = await import("fs");
    const composerContent = fs.readFileSync("server/composer.ts", "utf-8");
    expect(composerContent).not.toContain("g.co/kgs/adorb");
  });

  it("brand-assets.ts should contain correct review URLs (centralized source of truth)", async () => {
    const fs = await import("fs");
    const brandContent = fs.readFileSync("shared/brand-assets.ts", "utf-8");
    expect(brandContent).toContain("https://share.google/Bl291vQ1iaSRs9jmG");
    expect(brandContent).toContain("https://www.trustpilot.com/review/adorbcustomtees.com");
    expect(brandContent).toContain("https://adorbcustomtees.com/pages/reviews");
  });

  it("composer.ts should import from brand-assets (not hardcode URLs)", async () => {
    const fs = await import("fs");
    const composerContent = fs.readFileSync("server/composer.ts", "utf-8");
    expect(composerContent).toContain("from \"../shared/brand-assets\"");
  });

  it("qc.ts should not contain g.co/kgs/adorb", async () => {
    const fs = await import("fs");
    const qcContent = fs.readFileSync("server/qc.ts", "utf-8");
    expect(qcContent).not.toContain("g.co/kgs/adorb");
  });

  it("no server file should contain g.co/kgs", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const serverDir = "server";
    const files = fs.readdirSync(serverDir).filter((f: string) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(serverDir, file), "utf-8");
      expect(content).not.toContain("g.co/kgs");
    }
  });
});

// ============================================================
// Test 4: All email senders use formatEmailHtml
// ============================================================
describe("Email HTML formatting coverage", () => {
  it("no server file should contain raw html: <p>${ pattern", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const serverDir = "server";
    const files = fs.readdirSync(serverDir).filter((f: string) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(serverDir, file), "utf-8");
      // Check for raw <p>${ patterns that indicate unformatted email HTML
      const rawHtmlPattern = /html:\s*`<p>\$\{/;
      expect(rawHtmlPattern.test(content)).toBe(false);
    }
  });

  it("webhook-helpers.ts should export formatEmailHtml", async () => {
    const mod = await import("./webhook-helpers");
    expect(typeof mod.formatEmailHtml).toBe("function");
  });
});

// ============================================================
// Test 5: GHL DND sync and per-channel check
// ============================================================
describe("GHL DND sync infrastructure", () => {
  it("should export syncGhlDnd from db", async () => {
    const mod = await import("./db");
    expect(typeof mod.syncGhlDnd).toBe("function");
  });

  it("should export isChannelDnd from db", async () => {
    const mod = await import("./db");
    expect(typeof mod.isChannelDnd).toBe("function");
  });
});
