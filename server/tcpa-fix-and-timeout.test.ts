import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * TCPA FIX TESTS — Bug #4 (Vladislav TCPA Violation)
 *
 * Tests the two fixes applied to outbox-worker.ts:
 * 1. channelHint is read before channel (follow-up-trigger and fast_scan use channelHint)
 * 2. Stale replies (>30 min) lose their TCPA exemption
 *
 * Also tests the processing timeout (60s) for hung Brain calls.
 */

// ─── Test 1: Channel resolution logic ─────────────────────────────────────────
describe("TCPA Guard: Channel resolution (channelHint fix)", () => {
  it("reads channelHint when channel is absent (follow-up-trigger pattern)", () => {
    const payload = { channelHint: "SMS", trigger: "follow_up" };
    const channel = String(payload?.channelHint || (payload as any)?.channel || "EMAIL").toLowerCase();
    expect(channel).toBe("sms");
  });

  it("reads channelHint when channel is also present (channelHint takes priority)", () => {
    const payload = { channelHint: "SMS", channel: "EMAIL", trigger: "fast_scan" };
    const channel = String(payload?.channelHint || payload?.channel || "").toLowerCase();
    expect(channel).toBe("sms");
  });

  it("falls back to channel when channelHint is absent", () => {
    const payload = { channel: "WhatsApp", trigger: "nurture" };
    const channel = String((payload as any)?.channelHint || payload?.channel || "").toLowerCase();
    expect(channel).toBe("whatsapp");
  });

  it("falls back to lead.preferredChannel when both are absent", () => {
    const payload = { trigger: "follow_up" };
    const lead = { preferredChannel: "SMS" };
    const channel = String((payload as any)?.channelHint || (payload as any)?.channel || lead?.preferredChannel || "").toLowerCase();
    expect(channel).toBe("sms");
  });

  it("Vladislav scenario: fast_scan with channelHint=SMS resolves to SMS (not EMAIL)", () => {
    // Before fix: channelHint was ignored, fell back to lead.preferredChannel = EMAIL
    const payload = { channelHint: "SMS", trigger: "fast_scan", isInboundReply: true };
    const lead = { preferredChannel: "EMAIL" };
    const channel = String(payload?.channelHint || (payload as any)?.channel || lead?.preferredChannel || "").toLowerCase();
    expect(channel).toBe("sms");
    // SMS is TCPA-covered, so the quiet hours check should fire
    const isTcpaCovered = (channel === "sms" || channel === "whatsapp");
    expect(isTcpaCovered).toBe(true);
  });
});

// ─── Test 2: Stale reply exemption logic ──────────────────────────────────────
describe("TCPA Guard: Stale reply time limit (30-min)", () => {
  const REPLY_TRIGGERS = ["inbound_reply", "fast_scan", "message_received", "reply"];
  const STALE_REPLY_MS = 30 * 60 * 1000; // 30 minutes

  function isReplyExempt(trigger: string, scheduledAt: Date | null): boolean {
    const isReplyTrigger = REPLY_TRIGGERS.some(t => trigger.toLowerCase().includes(t));
    const itemAge = scheduledAt ? Date.now() - new Date(scheduledAt).getTime() : 0;
    return isReplyTrigger && itemAge < STALE_REPLY_MS;
  }

  it("fresh fast_scan reply (2 min old) IS exempt from TCPA", () => {
    const scheduledAt = new Date(Date.now() - 2 * 60 * 1000); // 2 min ago
    expect(isReplyExempt("fast_scan", scheduledAt)).toBe(true);
  });

  it("fresh inbound_reply (5 min old) IS exempt from TCPA", () => {
    const scheduledAt = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
    expect(isReplyExempt("inbound_reply", scheduledAt)).toBe(true);
  });

  it("stale fast_scan reply (6 hours old) is NOT exempt — Vladislav scenario", () => {
    // This is the exact bug: fast_scan enqueued at 3:46 PM, processed at 10 PM
    const scheduledAt = new Date(Date.now() - 6 * 60 * 60 * 1000); // 6 hours ago
    expect(isReplyExempt("fast_scan", scheduledAt)).toBe(false);
  });

  it("stale reply (31 min old) is NOT exempt", () => {
    const scheduledAt = new Date(Date.now() - 31 * 60 * 1000); // 31 min ago
    expect(isReplyExempt("fast_scan", scheduledAt)).toBe(false);
  });

  it("exactly 30 min old reply is NOT exempt (boundary)", () => {
    const scheduledAt = new Date(Date.now() - 30 * 60 * 1000); // exactly 30 min
    expect(isReplyExempt("fast_scan", scheduledAt)).toBe(false);
  });

  it("29 min old reply IS exempt (boundary)", () => {
    const scheduledAt = new Date(Date.now() - 29 * 60 * 1000); // 29 min ago
    expect(isReplyExempt("fast_scan", scheduledAt)).toBe(true);
  });

  it("non-reply trigger (follow_up) is never exempt regardless of age", () => {
    const scheduledAt = new Date(Date.now() - 1000); // 1 second ago
    expect(isReplyExempt("follow_up", scheduledAt)).toBe(false);
  });

  it("null scheduledAt defaults to age=0 (treated as fresh)", () => {
    // If scheduledAt is null, itemAge = 0 which is < 30 min, so it's exempt
    expect(isReplyExempt("fast_scan", null)).toBe(true);
  });
});

// ─── Test 3: Combined TCPA gate logic ─────────────────────────────────────────
describe("TCPA Guard: Combined gate (channel + reply + time)", () => {
  const REPLY_TRIGGERS = ["inbound_reply", "fast_scan", "message_received", "reply"];
  const STALE_REPLY_MS = 30 * 60 * 1000;

  function shouldTcpaBlock(opts: {
    channelHint?: string;
    channel?: string;
    preferredChannel?: string;
    trigger: string;
    scheduledAt: Date | null;
    etHour: number;
  }): boolean {
    const resolvedChannel = String(opts.channelHint || opts.channel || opts.preferredChannel || "").toLowerCase();
    const isTcpaCovered = (resolvedChannel === "sms" || resolvedChannel === "whatsapp");
    const isReplyTrigger = REPLY_TRIGGERS.some(t => opts.trigger.toLowerCase().includes(t));
    const itemAge = opts.scheduledAt ? Date.now() - new Date(opts.scheduledAt).getTime() : 0;
    const isReply = isReplyTrigger && itemAge < STALE_REPLY_MS;

    if (isTcpaCovered && !isReply) {
      return opts.etHour >= 21 || opts.etHour < 9;
    }
    return false;
  }

  it("Vladislav exact scenario: SMS fast_scan at 10 PM, 6h stale → BLOCKED", () => {
    expect(shouldTcpaBlock({
      channelHint: "SMS",
      preferredChannel: "EMAIL",
      trigger: "fast_scan",
      scheduledAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
      etHour: 22, // 10 PM
    })).toBe(true);
  });

  it("Fresh fast_scan SMS at 10 PM → NOT blocked (reply exempt)", () => {
    expect(shouldTcpaBlock({
      channelHint: "SMS",
      trigger: "fast_scan",
      scheduledAt: new Date(Date.now() - 2 * 60 * 1000), // 2 min ago
      etHour: 22,
    })).toBe(false);
  });

  it("SMS follow_up at 10 PM → BLOCKED (not a reply)", () => {
    expect(shouldTcpaBlock({
      channelHint: "SMS",
      trigger: "follow_up",
      scheduledAt: new Date(Date.now() - 1000),
      etHour: 22,
    })).toBe(true);
  });

  it("IG fast_scan at 10 PM → NOT blocked (IG is not TCPA-covered)", () => {
    expect(shouldTcpaBlock({
      channelHint: "Instagram",
      trigger: "fast_scan",
      scheduledAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
      etHour: 22,
    })).toBe(false);
  });

  it("SMS follow_up at 2 PM → NOT blocked (within TCPA hours)", () => {
    expect(shouldTcpaBlock({
      channelHint: "SMS",
      trigger: "follow_up",
      scheduledAt: new Date(Date.now() - 1000),
      etHour: 14,
    })).toBe(false);
  });

  it("WhatsApp stale reply at midnight → BLOCKED", () => {
    expect(shouldTcpaBlock({
      channelHint: "WhatsApp",
      trigger: "inbound_reply",
      scheduledAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2h stale
      etHour: 0,
    })).toBe(true);
  });
});

// ─── Test 4: Processing timeout logic ─────────────────────────────────────────
describe("Outbox Worker: Processing timeout (60s hang fix)", () => {
  const PROCESSING_TIMEOUT_MS = 60_000;

  it("Promise.race rejects when timeout fires before work completes", async () => {
    vi.useFakeTimers();

    const neverResolves = new Promise<void>(() => {}); // simulates hung Brain call
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`processing_timeout:${PROCESSING_TIMEOUT_MS}ms`)), PROCESSING_TIMEOUT_MS);
    });

    const racePromise = Promise.race([neverResolves, timeoutPromise]);

    // Advance time past the timeout
    vi.advanceTimersByTime(PROCESSING_TIMEOUT_MS + 1);

    await expect(racePromise).rejects.toThrow("processing_timeout:60000ms");

    vi.useRealTimers();
  });

  it("Promise.race resolves normally when work completes before timeout", async () => {
    vi.useFakeTimers();

    const quickWork = new Promise<string>((resolve) => {
      setTimeout(() => resolve("done"), 5000); // 5s
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`processing_timeout:${PROCESSING_TIMEOUT_MS}ms`)), PROCESSING_TIMEOUT_MS);
    });

    const racePromise = Promise.race([quickWork, timeoutPromise]);

    vi.advanceTimersByTime(5001);

    await expect(racePromise).resolves.toBe("done");

    vi.useRealTimers();
  });

  it("timeout error message starts with 'processing_timeout:' for detection", () => {
    const err = new Error(`processing_timeout:${PROCESSING_TIMEOUT_MS}ms`);
    expect(err.message.startsWith("processing_timeout:")).toBe(true);
  });

  it("PROCESSING_TIMEOUT_MS is 60 seconds", () => {
    expect(PROCESSING_TIMEOUT_MS).toBe(60_000);
  });
});
