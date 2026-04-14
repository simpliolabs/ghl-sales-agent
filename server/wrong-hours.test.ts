/**
 * Tests for the wrong_hours QC deterministic guard.
 *
 * The business is CLOSED on weekends (Mon-Fri 9:30am-5pm only).
 * Any message that states Saturday/Sunday availability must be blocked.
 */
import { describe, it, expect } from "vitest";

// Replicate the exact patterns from qc.ts for unit testing
const wrongHoursPatterns = [
  /open\s+saturdays?/i,
  /open\s+sundays?/i,
  /saturdays?\s+(?:10am|9am|8am|\d+am|\d+:\d+)/i,
  /sundays?\s+(?:10am|9am|8am|\d+am|\d+:\d+)/i,
  /(?:see you|visit|come in|stop by|swing by)\s+(?:this\s+)?saturday/i,
  /(?:see you|visit|come in|stop by|swing by)\s+(?:this\s+)?sunday/i,
  /your\s+saturday\s+(?:visit|appointment|meeting)/i,
  /your\s+sunday\s+(?:visit|appointment|meeting)/i,
  /saturday\s+visit/i,
  /sunday\s+visit/i,
  /we(?:'re|\s+are)\s+open\s+(?:monday\s+(?:through|thru|to|-)\s+saturday|mon(?:day)?\s*-\s*sat(?:urday)?)/i,
];

function detectWrongHours(msg: string): string | null {
  const match = wrongHoursPatterns.find(p => p.test(msg));
  if (!match) return null;
  return msg.match(match)?.[0] || "weekend availability claim";
}

describe("wrong_hours QC guard", () => {
  describe("SHOULD BLOCK — messages with wrong hours/weekend availability", () => {
    it("blocks 'open Saturdays 10am-4pm'", () => {
      expect(detectWrongHours("We're open Saturdays 10am-4pm!")).toBeTruthy();
    });

    it("blocks 'open Saturday'", () => {
      expect(detectWrongHours("We're open Saturday, come on by!")).toBeTruthy();
    });

    it("blocks 'open Sundays'", () => {
      expect(detectWrongHours("We're open Sundays too!")).toBeTruthy();
    });

    it("blocks 'Saturday 10am'", () => {
      expect(detectWrongHours("Saturday 10am works great for us.")).toBeTruthy();
    });

    it("blocks 'see you Saturday'", () => {
      expect(detectWrongHours("Awesome, see you Saturday!")).toBeTruthy();
    });

    it("blocks 'see you this Saturday'", () => {
      expect(detectWrongHours("Great, see you this Saturday at the shop!")).toBeTruthy();
    });

    it("blocks 'your Saturday visit' (the exact Jimmie bug)", () => {
      expect(detectWrongHours(
        "Awesome, Jimmie! Glad you got it. We're all set for your Saturday visit to discuss screen printing, DTF durability, and getting Basoom Llc's brand out there. See you then!"
      )).toBeTruthy();
    });

    it("blocks 'Saturday visit'", () => {
      expect(detectWrongHours("Looking forward to your Saturday visit!")).toBeTruthy();
    });

    it("blocks 'come in Saturday'", () => {
      expect(detectWrongHours("Feel free to come in Saturday.")).toBeTruthy();
    });

    it("blocks 'stop by Saturday'", () => {
      expect(detectWrongHours("You can stop by Saturday anytime.")).toBeTruthy();
    });

    it("blocks 'swing by Sunday'", () => {
      expect(detectWrongHours("Swing by Sunday and we'll get you sorted.")).toBeTruthy();
    });

    it("blocks 'open Monday through Saturday'", () => {
      expect(detectWrongHours("We're open Monday through Saturday 9am-6pm.")).toBeTruthy();
    });

    it("blocks 'open Mon-Sat'", () => {
      expect(detectWrongHours("We're open Mon-Sat for walk-ins.")).toBeTruthy();
    });
  });

  describe("SHOULD PASS — messages with correct hours or no hours claim", () => {
    it("passes correct Mon-Fri hours", () => {
      expect(detectWrongHours("We're open Mon-Fri 9:30am-5pm (closed weekends).")).toBeNull();
    });

    it("passes message with no hours reference", () => {
      expect(detectWrongHours("Hey Jimmie! Looking forward to chatting about your Basoom Llc branding.")).toBeNull();
    });

    it("passes appointment confirmation for a weekday", () => {
      expect(detectWrongHours("We're all set for your Wednesday visit to discuss screen printing!")).toBeNull();
    });

    it("passes 'see you Monday'", () => {
      expect(detectWrongHours("Great, see you Monday at 10am!")).toBeNull();
    });

    it("passes 'see you Friday'", () => {
      expect(detectWrongHours("Looking forward to seeing you Friday!")).toBeNull();
    });

    it("passes message mentioning Saturday in a non-availability context (e.g., order for Saturday event)", () => {
      // "Saturday" in context of an event the LEAD is attending, not our store hours
      expect(detectWrongHours("We can have your shirts ready before your Saturday event!")).toBeNull();
    });

    it("passes message mentioning Saturday delivery", () => {
      expect(detectWrongHours("We can ship it so it arrives by Saturday.")).toBeNull();
    });

    it("passes 'closed weekends' statement", () => {
      expect(detectWrongHours("We're closed weekends but open Mon-Fri 9:30am-5pm.")).toBeNull();
    });
  });
});
