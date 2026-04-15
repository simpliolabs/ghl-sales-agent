/**
 * Tests for getNextBusinessHoursSlot slot pointer logic.
 * Verifies that sequential calls produce non-overlapping 10-min slots
 * starting at 9:30 AM ET, and that the per-agent pointer prevents clustering.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getNextBusinessHoursSlot, resetAgentSlotPointer } from "./ghl";

// Helper: create a Date at a specific ET time on a Monday
function etDate(hour: number, minute: number = 0): Date {
  // Apr 14, 2026 is a Monday
  const d = new Date("2026-04-14T00:00:00.000Z");
  // ET is UTC-4 in April (EDT)
  d.setUTCHours(hour + 4, minute, 0, 0);
  return d;
}

describe("getNextBusinessHoursSlot — slot pointer", () => {
  beforeEach(() => {
    // Reset all agent pointers before each test
    resetAgentSlotPointer("Abby Bouwer");
    resetAgentSlotPointer("Chris McHendry");
    resetAgentSlotPointer("default");
  });

  it("returns 9:30 AM ET when called outside business hours (8 AM)", () => {
    const from = etDate(8, 0); // 8:00 AM ET — before business hours
    const slot = getNextBusinessHoursSlot(from, "Abby Bouwer");
    const etFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    expect(etFormatter.format(slot.start)).toBe("09:30");
  });

  it("returns 9:30 AM ET when called at exactly 9:00 AM (before open)", () => {
    const from = etDate(9, 0); // 9:00 AM ET — before 9:30 AM open
    const slot = getNextBusinessHoursSlot(from, "Abby Bouwer");
    const etFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    expect(etFormatter.format(slot.start)).toBe("09:30");
  });

  it("returns 9:30 AM ET when called at 9:25 AM (just before open)", () => {
    const from = etDate(9, 25); // 9:25 AM ET — before 9:30 AM open
    const slot = getNextBusinessHoursSlot(from, "Abby Bouwer");
    const etFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    expect(etFormatter.format(slot.start)).toBe("09:30");
  });

  it("sequential calls produce non-overlapping 10-min slots", () => {
    const from = etDate(8, 0); // outside business hours → first slot = 9:30 AM
    const slot1 = getNextBusinessHoursSlot(from, "Abby Bouwer");
    const slot2 = getNextBusinessHoursSlot(from, "Abby Bouwer");
    const slot3 = getNextBusinessHoursSlot(from, "Abby Bouwer");

    // Each slot must start at or after the previous slot's end
    expect(slot2.start.getTime()).toBeGreaterThanOrEqual(slot1.end.getTime());
    expect(slot3.start.getTime()).toBeGreaterThanOrEqual(slot2.end.getTime());

    // Each slot must be exactly 10 minutes
    expect(slot1.end.getTime() - slot1.start.getTime()).toBe(10 * 60 * 1000);
    expect(slot2.end.getTime() - slot2.start.getTime()).toBe(10 * 60 * 1000);
    expect(slot3.end.getTime() - slot3.start.getTime()).toBe(10 * 60 * 1000);
  });

  it("different agents get independent slot pointers (no cross-contamination)", () => {
    const from = etDate(8, 0);
    const abby1 = getNextBusinessHoursSlot(from, "Abby Bouwer");
    const chris1 = getNextBusinessHoursSlot(from, "Chris McHendry");

    // Both agents should start at 9:30 AM independently
    expect(abby1.start.getTime()).toBe(chris1.start.getTime());
  });

  it("10 sequential appointments fill 9:30 AM to 11:00 AM without gaps", () => {
    const from = etDate(8, 0);
    const slots = Array.from({ length: 10 }, () =>
      getNextBusinessHoursSlot(from, "Abby Bouwer")
    );

    // First slot: 9:30 AM
    const etFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    expect(etFormatter.format(slots[0].start)).toBe("09:30");
    expect(etFormatter.format(slots[1].start)).toBe("09:40");
    expect(etFormatter.format(slots[2].start)).toBe("09:50");
    expect(etFormatter.format(slots[9].start)).toBe("11:00");

    // No gaps between consecutive slots
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].start.getTime()).toBe(slots[i - 1].end.getTime());
    }
  });

  it("slots wrap to next business day when past 5 PM", () => {
    const from = etDate(8, 0);
    // Book 45 slots (45 × 10 min = 450 min = 7.5 hours) to fill 9:30 AM → 5:00 PM
    // Business day: 9:30 AM to 5:00 PM = 7.5 hours = 45 slots
    const slots = Array.from({ length: 46 }, () =>
      getNextBusinessHoursSlot(from, "Abby Bouwer")
    );
    const etFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    // Last slot of the day (index 44): starts at 4:50 PM
    expect(etFormatter.format(slots[44].start)).toBe("16:50");
    // First slot of next day (index 45): starts at 9:30 AM
    expect(etFormatter.format(slots[45].start)).toBe("09:30");
    // And it should be on a different day than slot 0
    const day0 = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", day: "2-digit" }).format(slots[0].start);
    const day45 = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", day: "2-digit" }).format(slots[45].start);
    expect(day45).not.toBe(day0);
  });

  it("returns next 10-min mark when called during business hours", () => {
    const from = etDate(10, 7); // 10:07 AM ET — within business hours
    resetAgentSlotPointer("Abby Bouwer");
    const slot = getNextBusinessHoursSlot(from, "Abby Bouwer");
    const etFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    // 10:07 + 5 min = 10:12 → rounds up to 10:20
    expect(etFormatter.format(slot.start)).toBe("10:20");
  });

  it("never books before 9:30 AM ET (safety clamp)", () => {
    // Simulate a stale pointer at 8:00 AM (before open)
    const from = etDate(8, 0);
    const slot = getNextBusinessHoursSlot(from, "Abby Bouwer");
    const etFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const formatted = etFormatter.format(slot.start);
    const [h, m] = formatted.split(":").map(Number);
    const totalMin = h * 60 + m;
    expect(totalMin).toBeGreaterThanOrEqual(9 * 60 + 30); // >= 9:30 AM
    expect(totalMin).toBeLessThan(17 * 60); // < 5:00 PM
  });

  it("never books on Saturday or Sunday", () => {
    // Apr 18, 2026 is a Saturday
    const saturday = new Date("2026-04-18T14:00:00.000Z"); // 10 AM EDT Saturday
    resetAgentSlotPointer("Abby Bouwer");
    const slot = getNextBusinessHoursSlot(saturday, "Abby Bouwer");
    const etDayFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
    });
    const dayName = etDayFormatter.format(slot.start);
    expect(["Sat", "Sun"]).not.toContain(dayName);
  });
});
