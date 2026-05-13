import { describe, it, expect, vi, beforeEach } from "vitest";
import { shouldDeferResponse, getDeferredSendAt } from "./deferred-response-processor";

describe("Agent-First Delay — shouldDeferResponse", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function afterEach(fn: () => void) {
    // vitest afterEach
    return (globalThis as any).__vitest_afterEach?.(fn) || fn;
  }

  it("returns true for brand new lead during business hours", () => {
    // Set to Tuesday 10am EST (14:00 UTC)
    vi.setSystemTime(new Date("2026-04-14T14:00:00.000Z")); // Tuesday
    const lead = { createdAt: new Date(Date.now() - 60_000), humanTakeover: 0 }; // created 1 min ago
    expect(shouldDeferResponse(lead, 0)).toBe(true);
  });

  it("returns TRUE for lead with existing conversations during business hours (agent-first for ALL)", () => {
    vi.setSystemTime(new Date("2026-04-14T14:00:00.000Z")); // Tuesday 10am EST
    const lead = { createdAt: new Date(Date.now() - 60_000), humanTakeover: 0 };
    // Existing customers also get deferred so agent can respond first
    expect(shouldDeferResponse(lead, 3)).toBe(true);
  });

  it("returns false on weekends", () => {
    // Saturday 10am EST (14:00 UTC)
    vi.setSystemTime(new Date("2026-04-18T14:00:00.000Z")); // Saturday
    const lead = { createdAt: new Date(Date.now() - 60_000), humanTakeover: 0 };
    expect(shouldDeferResponse(lead, 0)).toBe(false);
  });

  it("returns false before 9am EST", () => {
    // Tuesday 8am EST (12:00 UTC)
    vi.setSystemTime(new Date("2026-04-14T12:00:00.000Z"));
    const lead = { createdAt: new Date(Date.now() - 60_000), humanTakeover: 0 };
    expect(shouldDeferResponse(lead, 0)).toBe(false);
  });

  it("returns false after 5pm EST", () => {
    // Tuesday 6pm EST (22:00 UTC)
    vi.setSystemTime(new Date("2026-04-14T22:00:00.000Z"));
    const lead = { createdAt: new Date(Date.now() - 60_000), humanTakeover: 0 };
    expect(shouldDeferResponse(lead, 0)).toBe(false);
  });

  it("returns TRUE for lead created more than 5 minutes ago during business hours (no creation-time gate)", () => {
    vi.setSystemTime(new Date("2026-04-14T14:00:00.000Z")); // Tuesday 10am EST
    const lead = { createdAt: new Date(Date.now() - 10 * 60_000), humanTakeover: 0 }; // created 10 min ago
    // Creation time no longer gates deferral — all leads deferred during biz hours
    expect(shouldDeferResponse(lead, 0)).toBe(true);
  });

  it("returns false if humanTakeover is already 1", () => {
    vi.setSystemTime(new Date("2026-04-14T14:00:00.000Z")); // Tuesday 10am EST
    const lead = { createdAt: new Date(Date.now() - 60_000), humanTakeover: 1 };
    expect(shouldDeferResponse(lead, 0)).toBe(false);
  });

  it("returns true at exactly 9am EST Monday", () => {
    // Monday 9am EST (13:00 UTC)
    vi.setSystemTime(new Date("2026-04-13T13:00:00.000Z"));
    const lead = { createdAt: new Date(Date.now() - 60_000), humanTakeover: 0 };
    expect(shouldDeferResponse(lead, 0)).toBe(true);
  });

  it("returns true at 4:59pm EST Friday", () => {
    // Friday 4:59pm EST (20:59 UTC)
    vi.setSystemTime(new Date("2026-04-17T20:59:00.000Z"));
    const lead = { createdAt: new Date(Date.now() - 60_000), humanTakeover: 0 };
    expect(shouldDeferResponse(lead, 0)).toBe(true);
  });

  it("returns false at exactly 5pm EST", () => {
    // Friday 5pm EST (21:00 UTC)
    vi.setSystemTime(new Date("2026-04-17T21:00:00.000Z"));
    const lead = { createdAt: new Date(Date.now() - 60_000), humanTakeover: 0 };
    expect(shouldDeferResponse(lead, 0)).toBe(false);
  });
});

describe("Agent-First Delay — getDeferredSendAt", () => {
  it("returns a date 15 minutes in the future", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T14:00:00.000Z"));
    const sendAt = getDeferredSendAt();
    expect(sendAt.getTime()).toBe(new Date("2026-04-14T14:15:00.000Z").getTime());
    vi.useRealTimers();
  });
});
