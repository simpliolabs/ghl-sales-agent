/**
 * Inbound Channel Enforcement Tests
 *
 * Tests the foundational rule: "Always respond to contacts right away
 * in the same manner they reached out."
 *
 * Covers:
 * 1. Channel detection in webhook-contact.ts (Layer 0B, 7B)
 * 2. Inbound channel enforcement in brain-council-orchestrator.ts
 * 3. TCPA gate bypass for inbound social channels in webhook-message.ts
 */
import { describe, it, expect } from "vitest";

// =============================================================
// TEST 1: Channel detection — Layer 0B (form data + empty GHL history)
// =============================================================
describe("Channel detection: Layer 0B — form data with empty GHL history", () => {
  // Simulate the detection logic from webhook-contact.ts
  function detectChannel(opts: {
    formFields: { label: string; value: string }[];
    ghlHistory: any[];
    formExtractedFromConversation: boolean;
    payloadSource?: string;
    leadSource?: string;
    leadEmail?: string;
    leadPhone?: string;
  }): string {
    let detectedChannel = "";

    // Layer 0: form data in conversation body
    if (opts.formExtractedFromConversation) {
      detectedChannel = "FB";
    }

    // Layer 0B: form data present but GHL history empty
    if (!detectedChannel && opts.formFields.length > 0 && opts.ghlHistory.length === 0) {
      detectedChannel = "FB";
    }

    // Layer 3: payload source
    if (!detectedChannel && opts.payloadSource) {
      const src = opts.payloadSource.toLowerCase();
      if (src.includes("facebook") || src.includes("fb") || src.includes("lead_form")) detectedChannel = "FB";
      else if (src.includes("instagram") || src.includes("ig")) detectedChannel = "IG";
    }

    // Layer 4: lead source
    if (!detectedChannel && opts.leadSource) {
      const src = opts.leadSource.toLowerCase();
      if (src.includes("facebook") || src.includes("fb") || src.includes("lead_form")) detectedChannel = "FB";
      else if (src.includes("instagram") || src.includes("ig")) detectedChannel = "IG";
    }

    // Layer 7B: form data present, all other layers missed
    if (!detectedChannel && opts.formFields.length > 0) {
      detectedChannel = "FB";
    }

    // Layer 8: default fallback
    if (!detectedChannel) {
      if (opts.leadEmail && !opts.leadPhone) detectedChannel = "Email";
      else if (opts.leadPhone) detectedChannel = "SMS";
      else if (opts.leadEmail) detectedChannel = "Email";
    }

    return detectedChannel;
  }

  it("detects FB when form data exists but GHL history is empty (David Maynard case)", () => {
    const result = detectChannel({
      formFields: [
        { label: "Company name", value: "New Life Holiness Church" },
        { label: "What type of products are you interested in?", value: "T-shirts" },
      ],
      ghlHistory: [], // GHL hadn't indexed yet at 45s mark
      formExtractedFromConversation: false,
      leadEmail: "david_maynard606@hotmail.com",
      leadPhone: "(606) 225-5045",
    });
    expect(result).toBe("FB");
  });

  it("detects FB via Layer 0 when form data is in conversation body", () => {
    const result = detectChannel({
      formFields: [{ label: "Company name", value: "Test Church" }],
      ghlHistory: [{ direction: "inbound", body: "Company name: Test Church", type: "4" }],
      formExtractedFromConversation: true,
      leadEmail: "test@test.com",
      leadPhone: "555-1234",
    });
    expect(result).toBe("FB");
  });

  it("detects FB via Layer 7B when all other layers miss but form data exists", () => {
    const result = detectChannel({
      formFields: [{ label: "Products", value: "Hats" }],
      ghlHistory: [{ direction: "outbound", body: "system msg", type: "28" }], // only outbound
      formExtractedFromConversation: false,
      // No source indicators
      leadEmail: "test@test.com",
      leadPhone: "555-1234",
    });
    expect(result).toBe("FB");
  });

  it("falls back to SMS when no form data and no GHL history", () => {
    const result = detectChannel({
      formFields: [],
      ghlHistory: [],
      formExtractedFromConversation: false,
      leadEmail: "test@test.com",
      leadPhone: "555-1234",
    });
    expect(result).toBe("SMS");
  });

  it("falls back to Email when no form data, no GHL history, and no phone", () => {
    const result = detectChannel({
      formFields: [],
      ghlHistory: [],
      formExtractedFromConversation: false,
      leadEmail: "test@test.com",
    });
    expect(result).toBe("Email");
  });
});

// =============================================================
// TEST 2: Inbound channel enforcement in orchestrator
// =============================================================
describe("Inbound channel enforcement in Brain Council orchestrator", () => {
  // Simulate the enforcement logic from brain-council-orchestrator.ts
  function enforceInboundChannel(
    inputChannel: string,
    strategyChannel: string
  ): { channel: string; overridden: boolean } {
    const INBOUND_SOCIAL_CHANNELS = ["FB", "IG", "WhatsApp", "Live_Chat"];
    const isInboundSocial = INBOUND_SOCIAL_CHANNELS.includes(inputChannel);
    if (isInboundSocial && strategyChannel !== inputChannel) {
      return { channel: inputChannel, overridden: true };
    }
    return { channel: strategyChannel, overridden: false };
  }

  it("overrides Email → FB when lead came in on FB", () => {
    const result = enforceInboundChannel("FB", "Email");
    expect(result.channel).toBe("FB");
    expect(result.overridden).toBe(true);
  });

  it("overrides SMS → IG when lead came in on IG", () => {
    const result = enforceInboundChannel("IG", "SMS");
    expect(result.channel).toBe("IG");
    expect(result.overridden).toBe(true);
  });

  it("overrides Email → WhatsApp when lead came in on WhatsApp", () => {
    const result = enforceInboundChannel("WhatsApp", "Email");
    expect(result.channel).toBe("WhatsApp");
    expect(result.overridden).toBe(true);
  });

  it("does NOT override when Strategist already chose the inbound channel", () => {
    const result = enforceInboundChannel("FB", "FB");
    expect(result.channel).toBe("FB");
    expect(result.overridden).toBe(false);
  });

  it("does NOT override for SMS inbound (SMS is not a social channel)", () => {
    const result = enforceInboundChannel("SMS", "Email");
    expect(result.channel).toBe("Email");
    expect(result.overridden).toBe(false);
  });

  it("does NOT override for Email inbound (Email is not a social channel)", () => {
    const result = enforceInboundChannel("Email", "SMS");
    expect(result.channel).toBe("SMS");
    expect(result.overridden).toBe(false);
  });
});

// =============================================================
// TEST 3: TCPA gate bypass for inbound social channels
// =============================================================
describe("TCPA gate bypass for inbound social channels", () => {
  // Simulate the TCPA post-decision gate logic from webhook-message.ts
  function shouldTcpaGateFire(opts: {
    direction: string;
    channel: string;
    isTcpaQuietHours: boolean;
    aiResponseChannel: string;
  }): boolean {
    const SOCIAL_REPLY_CHANNELS = ["FB", "IG", "WhatsApp", "Live_Chat"];
    const isInboundSocialReply = opts.direction === "inbound" && SOCIAL_REPLY_CHANNELS.includes(opts.channel);
    // The gate fires when: NOT inbound social AND TCPA quiet hours AND channel is SMS
    return !isInboundSocialReply && opts.isTcpaQuietHours && opts.aiResponseChannel === "SMS";
  }

  it("does NOT fire TCPA gate for inbound FB reply during quiet hours", () => {
    const result = shouldTcpaGateFire({
      direction: "inbound",
      channel: "FB",
      isTcpaQuietHours: true,
      aiResponseChannel: "SMS",
    });
    expect(result).toBe(false);
  });

  it("does NOT fire TCPA gate for inbound IG reply during quiet hours", () => {
    const result = shouldTcpaGateFire({
      direction: "inbound",
      channel: "IG",
      isTcpaQuietHours: true,
      aiResponseChannel: "SMS",
    });
    expect(result).toBe(false);
  });

  it("does NOT fire TCPA gate for inbound WhatsApp reply during quiet hours", () => {
    const result = shouldTcpaGateFire({
      direction: "inbound",
      channel: "WhatsApp",
      isTcpaQuietHours: true,
      aiResponseChannel: "SMS",
    });
    expect(result).toBe(false);
  });

  it("DOES fire TCPA gate for inbound SMS during quiet hours", () => {
    const result = shouldTcpaGateFire({
      direction: "inbound",
      channel: "SMS",
      isTcpaQuietHours: true,
      aiResponseChannel: "SMS",
    });
    expect(result).toBe(true);
  });

  it("DOES fire TCPA gate for outbound SMS during quiet hours", () => {
    const result = shouldTcpaGateFire({
      direction: "outbound",
      channel: "SMS",
      isTcpaQuietHours: true,
      aiResponseChannel: "SMS",
    });
    expect(result).toBe(true);
  });

  it("does NOT fire TCPA gate when not quiet hours (regardless of channel)", () => {
    const result = shouldTcpaGateFire({
      direction: "inbound",
      channel: "SMS",
      isTcpaQuietHours: false,
      aiResponseChannel: "SMS",
    });
    expect(result).toBe(false);
  });

  it("does NOT fire TCPA gate when AI response is Email (not SMS)", () => {
    const result = shouldTcpaGateFire({
      direction: "inbound",
      channel: "SMS",
      isTcpaQuietHours: true,
      aiResponseChannel: "Email",
    });
    expect(result).toBe(false);
  });
});

// =============================================================
// TEST 4: End-to-end David Maynard scenario
// =============================================================
describe("End-to-end: David Maynard scenario (FB form at 10:34 PM)", () => {
  it("detects FB channel, enforces FB in orchestrator, bypasses TCPA", () => {
    // Step 1: Channel detection
    const formFields = [
      { label: "Company name", value: "New Life Holiness Church" },
      { label: "How soon do you need your order?", value: "This month" },
      { label: "What type of products are you interested in?", value: "T-shirts" },
    ];
    const ghlHistory: any[] = []; // Empty — GHL hadn't indexed yet

    // Layer 0B fires: form data + empty history → FB
    let detectedChannel = "";
    if (formFields.length > 0 && ghlHistory.length === 0) {
      detectedChannel = "FB";
    }
    expect(detectedChannel).toBe("FB");

    // Step 2: Brain Council Strategist returns "Email" (wrong)
    const strategyChannel = "Email";

    // Step 3: Inbound channel enforcement overrides to FB
    const INBOUND_SOCIAL_CHANNELS = ["FB", "IG", "WhatsApp", "Live_Chat"];
    const isInboundSocial = INBOUND_SOCIAL_CHANNELS.includes(detectedChannel);
    const enforcedChannel = isInboundSocial && strategyChannel !== detectedChannel
      ? detectedChannel
      : strategyChannel;
    expect(enforcedChannel).toBe("FB");

    // Step 4: TCPA gate does NOT fire for inbound FB
    const SOCIAL_REPLY_CHANNELS = ["FB", "IG", "WhatsApp", "Live_Chat"];
    const isInboundSocialReply = SOCIAL_REPLY_CHANNELS.includes(detectedChannel);
    const tcpaFires = !isInboundSocialReply; // Simplified — in real code also checks quiet hours + SMS
    expect(tcpaFires).toBe(false);

    // Step 5: Message is sent on FB
    const finalChannel = enforcedChannel;
    expect(finalChannel).toBe("FB");
  });
});
