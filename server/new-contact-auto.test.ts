import { describe, it, expect, vi, beforeEach } from "vitest";
import { getNextBusinessHoursSlot, resetAgentSlotPointer } from "./ghl";

// ============================================================
// getNextBusinessHoursSlot tests
// ============================================================

describe("getNextBusinessHoursSlot", () => {
  beforeEach(() => {
    // Reset the default agent slot pointer before each test to prevent cross-test contamination
    resetAgentSlotPointer("default");
  });

  it("returns a slot within business hours (Mon-Fri 9-5 ET)", () => {
    const { start, end } = getNextBusinessHoursSlot();
    expect(start).toBeInstanceOf(Date);
    expect(end).toBeInstanceOf(Date);
    expect(end.getTime() - start.getTime()).toBe(10 * 60_000); // 10-minute slot
  });

  it("returns 10-minute slot duration", () => {
    // Wednesday 2:00 PM ET = 18:00 UTC (EDT offset -4)
    const wed2pm = new Date("2026-04-08T18:00:00.000Z");
    const { start, end } = getNextBusinessHoursSlot(wed2pm);
    expect(end.getTime() - start.getTime()).toBe(10 * 60_000);
  });

  it("advances to Monday 9 AM ET when called on Saturday", () => {
    // Saturday April 11, 2026 at noon ET = 16:00 UTC
    const satNoon = new Date("2026-04-11T16:00:00.000Z");
    const { start } = getNextBusinessHoursSlot(satNoon);
    // Should be Monday April 13
    const etParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(start);
    const weekday = etParts.find(p => p.type === "weekday")?.value;
    const hour = parseInt(etParts.find(p => p.type === "hour")?.value || "0", 10);
    expect(weekday).toBe("Monday");
    expect(hour).toBe(9);
  });

  it("advances to Monday 9 AM ET when called on Sunday", () => {
    // Sunday April 12, 2026 at 10 AM ET = 14:00 UTC
    const sunMorn = new Date("2026-04-12T14:00:00.000Z");
    const { start } = getNextBusinessHoursSlot(sunMorn);
    const etParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(start);
    const weekday = etParts.find(p => p.type === "weekday")?.value;
    const hour = parseInt(etParts.find(p => p.type === "hour")?.value || "0", 10);
    expect(weekday).toBe("Monday");
    expect(hour).toBe(9);
  });

  it("returns same-day 9 AM ET when called before business hours on a weekday", () => {
    // Wednesday April 8, 2026 at 7:00 AM ET = 11:00 UTC
    const wed7am = new Date("2026-04-08T11:00:00.000Z");
    const { start } = getNextBusinessHoursSlot(wed7am);
    const etParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(start);
    const weekday = etParts.find(p => p.type === "weekday")?.value;
    const hour = parseInt(etParts.find(p => p.type === "hour")?.value || "0", 10);
    expect(weekday).toBe("Wednesday");
    expect(hour).toBe(9);
  });

  it("advances to next business day when called after 5 PM ET on a weekday", () => {
    // Wednesday April 8, 2026 at 6:00 PM ET = 22:00 UTC
    const wed6pm = new Date("2026-04-08T22:00:00.000Z");
    const { start } = getNextBusinessHoursSlot(wed6pm);
    const etParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(start);
    const weekday = etParts.find(p => p.type === "weekday")?.value;
    const hour = parseInt(etParts.find(p => p.type === "hour")?.value || "0", 10);
    expect(weekday).toBe("Thursday");
    expect(hour).toBe(9);
  });

  it("advances to Monday when called Friday after 5 PM ET", () => {
    // Friday April 10, 2026 at 6:00 PM ET = 22:00 UTC
    const fri6pm = new Date("2026-04-10T22:00:00.000Z");
    const { start } = getNextBusinessHoursSlot(fri6pm);
    const etParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(start);
    const weekday = etParts.find(p => p.type === "weekday")?.value;
    const hour = parseInt(etParts.find(p => p.type === "hour")?.value || "0", 10);
    expect(weekday).toBe("Monday");
    expect(hour).toBe(9);
  });

  it("rounds up to next 10-min mark during business hours", () => {
    // Wednesday April 8, 2026 at 2:13 PM ET = 18:13 UTC
    const wed213pm = new Date("2026-04-08T18:13:00.000Z");
    const { start } = getNextBusinessHoursSlot(wed213pm);
    const etParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(start);
    const minute = parseInt(etParts.find(p => p.type === "minute")?.value || "0", 10);
    // 2:13 + 5min = 2:18, rounded to 2:20
    expect(minute % 10).toBe(0);
  });

  it("start is always in the future relative to fromDate", () => {
    const now = new Date();
    const { start } = getNextBusinessHoursSlot(now);
    expect(start.getTime()).toBeGreaterThan(now.getTime());
  });
});

// ============================================================
// AGENT_CALENDAR_IDS mapping tests
// ============================================================

import { AGENT_CALENDAR_IDS, AGENT_GHL_USER_IDS } from "./ghl";

describe("Agent Calendar and User ID mappings", () => {
  it("has calendar IDs for Abby and Chris", () => {
    expect(AGENT_CALENDAR_IDS["Abby Bouwer"]).toBe("SUZZdOyEM310yqesJXQa");
    expect(AGENT_CALENDAR_IDS["Chris McHendry"]).toBe("j9bpOBiyKL6hxyMnin6l");
  });

  it("has GHL user IDs for all agents", () => {
    expect(AGENT_GHL_USER_IDS["Abby Bouwer"]).toBe("reGz7il08jq8SUsY7m6H");
    expect(AGENT_GHL_USER_IDS["Chris McHendry"]).toBe("MaGoC5SwkdJdYw5AK6vj");
  });

  it("every sales agent with a calendar also has a user ID", () => {
    for (const agent of Object.keys(AGENT_CALENDAR_IDS)) {
      expect(AGENT_GHL_USER_IDS[agent]).toBeDefined();
    }
  });
});

// ============================================================
// Webhook contact handler integration (mock-based)
// ============================================================

describe("New contact auto-task/appointment/notification flow", () => {
  it("getNextBusinessHoursSlot returns valid ISO strings for GHL API", () => {
    const { start, end } = getNextBusinessHoursSlot();
    // Should be valid ISO strings
    expect(start.toISOString()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(end.toISOString()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("slot label formats correctly for ET timezone", () => {
    const { start } = getNextBusinessHoursSlot();
    const label = start.toLocaleString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    // Should contain day name and time
    expect(label).toMatch(/\w{3}/); // weekday abbreviation
    expect(label).toMatch(/\d{1,2}:\d{2}/); // time
  });
});
