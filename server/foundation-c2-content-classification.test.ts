/**
 * Foundation C.2 — Inbound Content Classification
 *
 * Tests:
 *   1: real customer message → real_message
 *   2: WhatsApp channel promo → channel_promo
 *   3: FB form data → form_data
 *   4: link-only message → link_only
 *   5: auto-generated system message → auto_generated
 *   6: empty body with attachment → sticker_or_reaction
 *   7: real short message is NOT filtered
 *   8: URL with surrounding text is real_message (not link_only)
 *   9: WhatsApp non-promo message is real_message
 *   10: form data without phone number is real_message
 *   11: missed call auto-generated message → auto_generated
 */

import { describe, it, expect } from "vitest";
import { classifyInboundContent } from "./webhook-message";

const EMPTY_PAYLOAD: Record<string, unknown> = {};

describe("classifyInboundContent — Foundation C.2", () => {
  it("1: real customer message → real_message", () => {
    const result = classifyInboundContent("Hey, how much for 50 shirts?", "SMS", EMPTY_PAYLOAD);
    expect(result.kind).toBe("real_message");
  });

  it("2: WhatsApp channel promo → channel_promo", () => {
    const result = classifyInboundContent(
      "Follow the Adorb Custom Tees channel on WhatsApp: https://whatsapp.com/channel/abc123",
      "WhatsApp",
      EMPTY_PAYLOAD
    );
    expect(result.kind).toBe("channel_promo");
    expect(result.reason).toMatch(/channel/i);
  });

  it("3: FB form data → form_data", () => {
    const result = classifyInboundContent(
      "Full Name: John Smith\nPhone Number: 786-555-1234\nWhat type of products: T-shirts",
      "FB",
      EMPTY_PAYLOAD
    );
    expect(result.kind).toBe("form_data");
  });

  it("4: link-only message (URL with no surrounding text) → link_only", () => {
    const result = classifyInboundContent("https://bit.ly/promo123", "SMS", EMPTY_PAYLOAD);
    expect(result.kind).toBe("link_only");
  });

  it("5: auto-generated 'joined the group' message → auto_generated", () => {
    const result = classifyInboundContent("Joined the group", "FB", EMPTY_PAYLOAD);
    expect(result.kind).toBe("auto_generated");
  });

  it("6: empty body with attachment → sticker_or_reaction", () => {
    const result = classifyInboundContent("", "FB", { attachments: ["sticker_url"] });
    expect(result.kind).toBe("sticker_or_reaction");
  });

  it("7: real short message 'Yes please' is NOT filtered", () => {
    const result = classifyInboundContent("Yes please", "SMS", EMPTY_PAYLOAD);
    expect(result.kind).toBe("real_message");
  });

  it("8: URL with surrounding text is real_message (not link_only)", () => {
    // "Check out our website at https://example.com for more info" — has real text
    const result = classifyInboundContent(
      "Check out our website at https://example.com for more info",
      "SMS",
      EMPTY_PAYLOAD
    );
    expect(result.kind).toBe("real_message");
  });

  it("9: WhatsApp promo pattern only fires on WhatsApp channel, not SMS", () => {
    // Same promo text on SMS should NOT be classified as channel_promo
    const result = classifyInboundContent(
      "Follow the channel on WhatsApp: https://whatsapp.com/channel/abc123",
      "SMS",
      EMPTY_PAYLOAD
    );
    // On SMS, the WhatsApp promo pattern does not apply — falls through to real_message
    expect(result.kind).toBe("real_message");
  });

  it("10: form data requires both name AND contact field to trigger", () => {
    // Only "Full Name:" without phone/email/product — should be real_message
    const result = classifyInboundContent("Full Name: John Smith", "SMS", EMPTY_PAYLOAD);
    expect(result.kind).toBe("real_message");
  });

  it("11: 'missed call' auto-generated message → auto_generated", () => {
    const result = classifyInboundContent("Missed call", "SMS", EMPTY_PAYLOAD);
    expect(result.kind).toBe("auto_generated");
  });
});
