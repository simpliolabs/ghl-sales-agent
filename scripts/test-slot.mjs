// Simulate Julia Barney's appointment creation at 8:58 PM ET Monday Apr 14
// 8:58 PM ET = 00:58 UTC Apr 15 (EDT offset -4)
import { getNextBusinessHoursSlot, resetAgentSlotPointer } from "../server/ghl.ts";

resetAgentSlotPointer("Abby Bouwer");
resetAgentSlotPointer("default");

const now = new Date("2026-04-15T00:58:00.000Z"); // 8:58 PM ET Mon
console.log("Input time (UTC):", now.toISOString());
console.log("Input time (ET):", now.toLocaleString("en-US", { timeZone: "America/New_York" }));

const slot = getNextBusinessHoursSlot(now, "Abby Bouwer");
console.log("\nSlot start (UTC):", slot.start.toISOString());
console.log("Slot start (ET):", slot.start.toLocaleString("en-US", { timeZone: "America/New_York" }));
console.log("Slot end (UTC):", slot.end.toISOString());
console.log("Slot end (ET):", slot.end.toLocaleString("en-US", { timeZone: "America/New_York" }));

// Check: does GHL interpret the ISO string as UTC or ET?
// If GHL shows "08:00 AM EST" for a slot at 2026-04-15T13:00:00.000Z,
// that means GHL is interpreting it as UTC and displaying in EST (UTC-5),
// NOT EDT (UTC-4). 13:00 UTC = 8:00 AM EST = 9:00 AM EDT
console.log("\n--- GHL Timezone Analysis ---");
console.log("If GHL shows 08:00 AM EST for this slot:");
console.log("  13:00 UTC = 8:00 AM EST (UTC-5) = 9:00 AM EDT (UTC-4)");
console.log("  GHL is using EST (winter time) instead of EDT (summer time)");
console.log("  Or: GHL calendar timezone is set to EST, not America/New_York");
