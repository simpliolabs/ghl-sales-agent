import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

function readFile(name: string) {
  return readFileSync(join(__dirname, name), "utf-8");
}

describe("Live Chat Channel Support", () => {
  it("normalizeChannel preserves Live_Chat as distinct type (not FB)", () => {
    const src = readFile("webhook-helpers.ts");
    // Type 15 must map to Live_Chat, not FB
    expect(src).toMatch(/lower === "15"\) return "Live_Chat"/);
    // String "live_chat" must map to Live_Chat
    expect(src).toMatch(/live_chat.*return "Live_Chat"/);
  });

  it("buildSendOpts supports Live_Chat channel", () => {
    const src = readFile("webhook-helpers.ts");
    expect(src).toContain('channel === "Live_Chat"');
    expect(src).toContain('type: "Live_Chat"');
  });

  it("sendMessage accepts Live_Chat type", () => {
    const src = readFile("ghl.ts");
    expect(src).toContain('"Live_Chat"');
  });

  it("strategist recognizes Live_Chat as valid channel", () => {
    const src = readFile("strategist.ts");
    expect(src).toContain("Live_Chat");
    expect(src).toContain("SMS|Email|FB|IG|WhatsApp|Live_Chat");
  });

  it("strategist has Live Chat urgency rule", () => {
    const src = readFile("strategist.ts");
    expect(src).toContain("LIVE CHAT URGENCY RULE");
    expect(src).toContain("LIVE VISITOR ON WEBSITE");
  });


  it("channel-fallback includes Live_Chat in priority list", () => {
    const src = readFile("channel-fallback.ts");
    expect(src).toContain('"Live_Chat"');
    expect(src).toContain("CHANNEL_PRIORITY");
  });
});

describe("Contact Info Capture", () => {

  it("strategist surfaces contact gap in ENGAGEMENT STATE", () => {
    const src = readFile("strategist.ts");
    expect(src).toContain("CONTACT GAP");
    expect(src).toContain("Email on file");
    expect(src).toContain("Phone on file");
  });
});

describe("Channel-Specific DNC", () => {
  it("channel-fallback.ts has channel priority order", () => {
    const src = readFile("channel-fallback.ts");
    expect(src).toContain("CHANNEL_PRIORITY");
    expect(src).toContain('"Email"');
    expect(src).toContain('"FB"');
    expect(src).toContain('"IG"');
    expect(src).toContain('"WhatsApp"');
    expect(src).toContain('"SMS"');
  });

  it("channel-fallback.ts maps channels to DND fields", () => {
    const src = readFile("channel-fallback.ts");
    expect(src).toContain('"dndSms"');
    expect(src).toContain('"dndEmail"');
    expect(src).toContain('"dndFb"');
    expect(src).toContain('"dndWhatsapp"');
  });

  it("channel-fallback.ts has handleChannelDnc that escalates or moves to not_qualified", () => {
    const src = readFile("channel-fallback.ts");
    expect(src).toContain("handleChannelDnc");
    expect(src).toContain("escalated");
    expect(src).toContain("not_qualified");
    expect(src).toContain("allChannelsExhausted");
  });


  it("follow-up-trigger.ts uses channel-specific DNC", () => {
    const src = readFile("follow-up-trigger.ts");
    expect(src).toContain("handleChannelDnc");
    expect(src).toContain("detectDncChannel");
  });

  it("webhook-contact.ts uses channel-specific DNC", () => {
    const src = readFile("webhook-contact.ts");
    expect(src).toContain("handleChannelDnc");
    expect(src).toContain("detectDncChannel");
  });

  it("detectDncChannel recognizes Live_Chat as its own channel", () => {
    const src = readFile("channel-fallback.ts");
    expect(src).toContain("LIVE_CHAT");
    expect(src).toContain('return "Live_Chat"');
  });
});
