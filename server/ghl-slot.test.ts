/**
 * Tests for getNextBusinessHoursSlot slot pointer logic.
 * Verifies that sequential calls produce non-overlapping 10-min slots
 * starting at 9 AM ET, and that the per-agent pointer prevents clustering.
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

  it("returns 9:00 AM ET when called outside business hours (8 AM)", () => {
    const from = etDate(8, 0); // 8:00 AM ET — before business hours
    const slot = getNextBusinessHoursSlot(from, "Abby Bouwer");
    const etHour = parseInt(
      new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false })
        .format(slot.start)
    );
    expect(etHour).toBe(9);
  });

  it("sequential calls produce non-overlapping 10-min slots", () => {
    const from = etDate(8, 0); // outside business hours → first slot = 9:00 AM
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

    // Both agents should start at 9:00 AM independently
    expect(abby1.start.getTime()).toBe(chris1.start.getTime());
  });

  it("10 sequential appointments fill 9:00 AM to 10:40 AM without gaps", () => {
    const from = etDate(8, 0);
    const slots = Array.from({ length: 10 }, () =>
      getNextBusinessHoursSlot(from, "Abby Bouwer")
    );

    // First slot: 9:00 AM
    const etFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    expect(etFormatter.format(slots[0].start)).toBe("09:00");
    expect(etFormatter.format(slots[1].start)).toBe("09:10");
    expect(etFormatter.format(slots[2].start)).toBe("09:20");
    expect(etFormatter.format(slots[9].start)).toBe("10:30");

    // No gaps between consecutive slots
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].start.getTime()).toBe(slots[i - 1].end.getTime());
    }
  });

  it("slots wrap to next business day when past 5 PM", () => {
    const from = etDate(8, 0);
    // Book 48 slots (48 × 10 min = 480 min = 8 hours) to fill 9 AM → 5 PM
    // Slots 0-47 fill Mon 9:00 AM → 4:50 PM (slot 47 ends at 5:00 PM)
    // Slot 48 (the 49th) should wrap to next business day at 9:00 AM
    const slots = Array.from({ length: 49 }, () =>
      getNextBusinessHoursSlot(from, "Abby Bouwer")
    );
    const etFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    // Last slot of the day (index 47): starts at 4:50 PM
    expect(etFormatter.format(slots[47].start)).toBe("16:50");
    // First slot of next day (index 48): starts at 9:00 AM
    expect(etFormatter.format(slots[48].start)).toBe("09:00");
    // And it should be on a different day than slot 0
    const day0 = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", day: "2-digit" }).format(slots[0].start);
    const day48 = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", day: "2-digit" }).format(slots[48].start);
    expect(day48).not.toBe(day0);
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
});
