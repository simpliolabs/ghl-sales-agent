/**
 * AREA CODE → TIMEZONE TESTS
 *
 * Tests for recipient-timezone-aware TCPA quiet hours compliance.
 * Ensures SMS sends respect the recipient's local timezone, not just ET.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getTimezoneForPhone,
  isTcpaQuietHoursForRecipient,
  nextTcpaWindowForRecipient,
} from "./area-code-timezone";

describe("getTimezoneForPhone", () => {
  it("returns ET for South Florida area codes (305, 954, 786)", () => {
    expect(getTimezoneForPhone("+13051234567")).toBe("America/New_York");
    expect(getTimezoneForPhone("+19541234567")).toBe("America/New_York");
    expect(getTimezoneForPhone("+17861234567")).toBe("America/New_York");
  });

  it("returns CT for Houston (832), Chicago (312), Dallas (214)", () => {
    expect(getTimezoneForPhone("+18321234567")).toBe("America/Chicago");
    expect(getTimezoneForPhone("+13121234567")).toBe("America/Chicago");
    expect(getTimezoneForPhone("+12141234567")).toBe("America/Chicago");
  });

  it("returns MT for Denver (303), Phoenix (602)", () => {
    expect(getTimezoneForPhone("+13031234567")).toBe("America/Denver");
    expect(getTimezoneForPhone("+16021234567")).toBe("America/Denver");
  });

  it("returns PT for Los Angeles (213), Seattle (206)", () => {
    expect(getTimezoneForPhone("+12131234567")).toBe("America/Los_Angeles");
    expect(getTimezoneForPhone("+12061234567")).toBe("America/Los_Angeles");
  });

  it("returns AK for Alaska (907)", () => {
    expect(getTimezoneForPhone("+19071234567")).toBe("America/Anchorage");
  });

  it("returns HI for Hawaii (808)", () => {
    expect(getTimezoneForPhone("+18081234567")).toBe("Pacific/Honolulu");
  });

  it("falls back to ET for unknown area codes", () => {
    expect(getTimezoneForPhone("+19991234567")).toBe("America/New_York");
  });

  it("falls back to ET for null/undefined/empty phone", () => {
    expect(getTimezoneForPhone(null)).toBe("America/New_York");
    expect(getTimezoneForPhone(undefined)).toBe("America/New_York");
    expect(getTimezoneForPhone("")).toBe("America/New_York");
  });

  it("handles phone without +1 prefix", () => {
    expect(getTimezoneForPhone("3051234567")).toBe("America/New_York");
    expect(getTimezoneForPhone("8321234567")).toBe("America/Chicago");
  });

  it("handles phone with dashes/spaces", () => {
    expect(getTimezoneForPhone("+1 (305) 123-4567")).toBe("America/New_York");
    expect(getTimezoneForPhone("832-123-4567")).toBe("America/Chicago");
  });
});

describe("isTcpaQuietHoursForRecipient", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns true at 8 AM ET for an ET lead (before 9 AM)", () => {
    // 8 AM ET = 12:00 UTC (during EDT)
    vi.setSystemTime(new Date("2026-04-14T12:00:00.000Z")); // Tuesday
    expect(isTcpaQuietHoursForRecipient("+13051234567")).toBe(true);
  });

  it("returns false at 10 AM ET for an ET lead", () => {
    // 10 AM ET = 14:00 UTC (during EDT)
    vi.setSystemTime(new Date("2026-04-14T14:00:00.000Z"));
    expect(isTcpaQuietHoursForRecipient("+13051234567")).toBe(false);
  });

  it("returns true at 9 PM ET for an ET lead (at 9 PM)", () => {
    // 9 PM ET = 01:00 UTC next day (during EDT)
    vi.setSystemTime(new Date("2026-04-15T01:00:00.000Z"));
    expect(isTcpaQuietHoursForRecipient("+13051234567")).toBe(true);
  });

  it("returns true at 9 AM ET for a PT lead (6 AM PT — before 9 AM local)", () => {
    // 9 AM ET = 6 AM PT. Lead in LA (213) should be in quiet hours.
    vi.setSystemTime(new Date("2026-04-14T13:00:00.000Z")); // 9 AM EDT
    expect(isTcpaQuietHoursForRecipient("+12131234567")).toBe(true);
  });

  it("returns false at 12 PM ET for a PT lead (9 AM PT — at 9 AM local)", () => {
    // 12 PM ET = 9 AM PT. Lead in LA should be OK.
    vi.setSystemTime(new Date("2026-04-14T16:00:00.000Z")); // 12 PM EDT
    expect(isTcpaQuietHoursForRecipient("+12131234567")).toBe(false);
  });

  it("returns true at 9 PM ET for a CT lead (8 PM CT — still OK) → false", () => {
    // 9 PM ET = 8 PM CT. Lead in Houston (832) should be OK (before 9 PM local).
    vi.setSystemTime(new Date("2026-04-15T01:00:00.000Z")); // 9 PM EDT
    expect(isTcpaQuietHoursForRecipient("+18321234567")).toBe(false);
  });

  it("returns true at midnight ET for a PT lead (9 PM PT — at 9 PM local)", () => {
    // Midnight ET = 9 PM PT. Lead in LA should be in quiet hours.
    vi.setSystemTime(new Date("2026-04-15T04:00:00.000Z")); // Midnight EDT
    expect(isTcpaQuietHoursForRecipient("+12131234567")).toBe(true);
  });

  it("falls back to ET for unknown area codes", () => {
    // 10 AM ET = 14:00 UTC. Unknown area code falls back to ET = not quiet hours.
    vi.setSystemTime(new Date("2026-04-14T14:00:00.000Z"));
    expect(isTcpaQuietHoursForRecipient("+19991234567")).toBe(false);
  });
});

describe("nextTcpaWindowForRecipient", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns next 9 AM ET for an ET lead when called at 10 PM ET", () => {
    // 10 PM ET = 02:00 UTC next day
    vi.setSystemTime(new Date("2026-04-15T02:00:00.000Z")); // 10 PM EDT
    const next = nextTcpaWindowForRecipient("+13051234567");
    // Should be 9 AM ET next day = 13:00 UTC
    const etStr = next.toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
    expect(etStr).toBe("09:00");
  });

  it("returns next 9 AM PT for a PT lead when called at 6 AM PT (quiet hours)", () => {
    // 6 AM PT = 9 AM ET = 13:00 UTC
    vi.setSystemTime(new Date("2026-04-14T13:00:00.000Z"));
    const next = nextTcpaWindowForRecipient("+12131234567");
    // Should be 9 AM PT = 12 PM ET = 16:00 UTC
    const ptStr = next.toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: false });
    expect(ptStr).toBe("09:00");
  });

  it("returns next 9 AM CT for a CT lead when called at 10 PM CT", () => {
    // 10 PM CT = 11 PM ET = 03:00 UTC next day
    vi.setSystemTime(new Date("2026-04-15T03:00:00.000Z"));
    const next = nextTcpaWindowForRecipient("+18321234567");
    const ctStr = next.toLocaleString("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hour12: false });
    expect(ctStr).toBe("09:00");
  });
});
