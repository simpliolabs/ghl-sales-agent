import { describe, expect, it } from "vitest";
import { isLlmExhausted, LLM_RETRY_DELAY_MS, MAX_LLM_RETRIES, normalizeChannel } from "./webhook-helpers";

describe("isLlmExhausted", () => {
  it("detects 412 Precondition Failed usage exhausted errors", () => {
    const err = new Error('LLM invoke failed: 412 Precondition Failed – {"code":9,"message":"your account has hit a usage exhausted"}');
    expect(isLlmExhausted(err)).toBe(true);
  });

  it("detects 429 rate limit errors", () => {
    const err = new Error("LLM invoke failed: 429 Too Many Requests");
    expect(isLlmExhausted(err)).toBe(true);
  });

  it("detects errors containing 'rate' keyword", () => {
    const err = new Error("Rate limit exceeded for this model");
    expect(isLlmExhausted(err)).toBe(true);
  });

  it("detects errors containing 'exhausted' keyword", () => {
    const err = new Error("Token budget exhausted");
    expect(isLlmExhausted(err)).toBe(true);
  });

  it("detects errors containing 'quota' keyword", () => {
    const err = new Error("Quota exceeded for the billing period");
    expect(isLlmExhausted(err)).toBe(true);
  });

  it("detects errors containing 'usage' keyword", () => {
    const err = new Error("usage limit reached");
    expect(isLlmExhausted(err)).toBe(true);
  });

  it("does NOT flag normal errors as LLM exhaustion", () => {
    expect(isLlmExhausted(new Error("Network timeout"))).toBe(false);
    expect(isLlmExhausted(new Error("500 Internal Server Error"))).toBe(false);
    expect(isLlmExhausted(new Error("Connection refused"))).toBe(false);
    expect(isLlmExhausted(new Error("Invalid JSON response"))).toBe(false);
  });

  it("handles non-Error objects gracefully", () => {
    expect(isLlmExhausted("429 rate limit")).toBe(true);
    expect(isLlmExhausted({ message: "usage exhausted" })).toBe(true);
    expect(isLlmExhausted(null)).toBe(false);
    expect(isLlmExhausted(undefined)).toBe(false);
    expect(isLlmExhausted(42)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isLlmExhausted(new Error("USAGE EXHAUSTED"))).toBe(true);
    expect(isLlmExhausted(new Error("Rate Limit Exceeded"))).toBe(true);
    expect(isLlmExhausted(new Error("QUOTA exceeded"))).toBe(true);
  });
});

describe("LLM retry constants", () => {
  it("has a 15-minute default retry delay", () => {
    expect(LLM_RETRY_DELAY_MS).toBe(15 * 60 * 1000);
  });

  it("has a max retry limit of 10", () => {
    expect(MAX_LLM_RETRIES).toBe(10);
  });
});

describe("exponential backoff calculation", () => {
  it("produces increasing delays with a cap at 4 hours", () => {
    const maxMs = 4 * 60 * 60 * 1000; // 4 hours
    const delays: number[] = [];
    for (let retry = 0; retry < 10; retry++) {
      const delay = Math.min(LLM_RETRY_DELAY_MS * Math.pow(1.5, Math.min(retry, 5)), maxMs);
      delays.push(delay);
    }

    // First retry: 15 minutes
    expect(delays[0]).toBe(LLM_RETRY_DELAY_MS);

    // Each subsequent delay should be >= the previous one
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    }

    // All delays should be <= 4 hours
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(maxMs);
    }

    // After retry 5, the exponent caps at 5, so delays plateau
    expect(delays[5]).toBe(delays[6]);
    expect(delays[6]).toBe(delays[7]);
  });
});

describe("normalizeChannel", () => {
  it("detects GHL numeric type 4 as FB", () => {
    expect(normalizeChannel(4)).toBe("FB");
    expect(normalizeChannel("4")).toBe("FB");
  });

  it("detects GHL numeric type 15 (Live_Chat) as FB", () => {
    expect(normalizeChannel(15)).toBe("FB");
    expect(normalizeChannel("15")).toBe("FB");
  });

  it("detects GHL numeric type 5 as IG", () => {
    expect(normalizeChannel(5)).toBe("IG");
    expect(normalizeChannel("5")).toBe("IG");
  });

  it("detects GHL numeric type 6 as WhatsApp", () => {
    expect(normalizeChannel(6)).toBe("WhatsApp");
    expect(normalizeChannel("6")).toBe("WhatsApp");
  });

  it("detects GHL numeric type 3 as Email", () => {
    expect(normalizeChannel(3)).toBe("Email");
    expect(normalizeChannel("3")).toBe("Email");
  });

  it("detects GHL numeric type 2 as SMS", () => {
    expect(normalizeChannel(2)).toBe("SMS");
    expect(normalizeChannel("2")).toBe("SMS");
  });

  it("detects string 'FB' as FB", () => {
    expect(normalizeChannel("FB")).toBe("FB");
    expect(normalizeChannel("fb")).toBe("FB");
    expect(normalizeChannel("Facebook")).toBe("FB");
  });

  it("detects 'live_chat' as FB", () => {
    expect(normalizeChannel("Live_Chat")).toBe("FB");
    expect(normalizeChannel("live_chat")).toBe("FB");
  });

  it("detects string 'IG' as IG", () => {
    expect(normalizeChannel("IG")).toBe("IG");
    expect(normalizeChannel("Instagram")).toBe("IG");
  });

  it("detects string 'Email' as Email", () => {
    expect(normalizeChannel("Email")).toBe("Email");
    expect(normalizeChannel("email")).toBe("Email");
  });

  it("detects string 'WhatsApp' as WhatsApp", () => {
    expect(normalizeChannel("WhatsApp")).toBe("WhatsApp");
    expect(normalizeChannel("whatsapp")).toBe("WhatsApp");
  });

  it("defaults to SMS for unknown types", () => {
    expect(normalizeChannel("SMS")).toBe("SMS");
    expect(normalizeChannel("InboundMessage")).toBe("SMS");
    expect(normalizeChannel(undefined)).toBe("SMS");
    expect(normalizeChannel(null)).toBe("SMS");
    expect(normalizeChannel("")).toBe("SMS");
  });
});
