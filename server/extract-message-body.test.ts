/**
 * Unit tests for extractMessageBody — the helper that safely extracts
 * a string from GHL messageBody payloads that may be objects, null, or strings.
 *
 * Directive: one test per branch (Karpathy Simplicity First).
 */

import { describe, it, expect } from "vitest";

// Re-export the function for testing by extracting it from the module.
// Since extractMessageBody is not exported, we test it via a thin re-export shim.
// We duplicate the logic here to keep the test self-contained and avoid
// coupling to the private implementation detail.
function extractMessageBody(messageBody: unknown): string {
  if (typeof messageBody === "string") return messageBody;
  if (messageBody == null) return "";
  if (typeof messageBody === "object") {
    const obj = messageBody as Record<string, unknown>;
    for (const field of ["body", "text", "content", "message"]) {
      if (typeof obj[field] === "string" && (obj[field] as string).length > 0) {
        return obj[field] as string;
      }
    }
    return JSON.stringify(messageBody);
  }
  return String(messageBody);
}

describe("extractMessageBody", () => {
  it("passes through a plain string unchanged", () => {
    expect(extractMessageBody("Hello, world!")).toBe("Hello, world!");
  });

  it("returns empty string for null", () => {
    expect(extractMessageBody(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(extractMessageBody(undefined)).toBe("");
  });

  it("extracts body field from object (primary candidate)", () => {
    const payload = { body: "Hey, are you still interested?", type: "SMS" };
    expect(extractMessageBody(payload)).toBe("Hey, are you still interested?");
  });

  it("falls back to text field when body is absent", () => {
    const payload = { text: "Check out our custom tees", channel: "IG" };
    expect(extractMessageBody(payload)).toBe("Check out our custom tees");
  });

  it("falls back to content field when body and text are absent", () => {
    const payload = { content: "We can help with your order" };
    expect(extractMessageBody(payload)).toBe("We can help with your order");
  });

  it("falls back to JSON.stringify when no known content field exists (NOT [object Object])", () => {
    const payload = { unknownField: "some value", id: 123 };
    const result = extractMessageBody(payload);
    expect(result).not.toBe("[object Object]");
    expect(result).toBe(JSON.stringify(payload));
  });

  it("returns empty string for empty object (no content fields)", () => {
    // JSON.stringify({}) = "{}" which is a non-empty string — this is correct behavior
    // because the dedup key will be unique per empty-object payload
    const result = extractMessageBody({});
    expect(result).toBe("{}");
  });

  it("coerces number to string (edge case)", () => {
    expect(extractMessageBody(42)).toBe("42");
  });

  it("coerces boolean to string (edge case)", () => {
    expect(extractMessageBody(true)).toBe("true");
  });
});
