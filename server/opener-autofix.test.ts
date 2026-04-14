/**
 * Tests for the Post-Compose Opener Auto-Fix
 *
 * The orchestrator checks if the Composer generated a repeated opener
 * (same first 4 words as any prior outbound message). If so, it surgically
 * replaces just the opener with a diverse alternative, preventing circuit
 * breaker accumulation for what is a formatting issue, not a content problem.
 *
 * These tests validate the opener matching logic and replacement behavior
 * in isolation (without running the full orchestrator).
 */

import { describe, it, expect } from "vitest";

// ─── Extracted opener auto-fix logic (mirrors orchestrator implementation) ───

function extractOpener4(msg: string): string {
  return msg.trim().split(/\s+/).slice(0, 4).join(" ").toLowerCase().replace(/[!.,?]/g, "");
}

function extractOpener3(msg: string): string {
  return msg.trim().split(/\s+/).slice(0, 3).join(" ").toLowerCase().replace(/[!.,?]/g, "");
}

function isRepeatedOpener(composedMessage: string, priorOutbound: Array<{ messageBody: string }>): boolean {
  const composedOpener4 = extractOpener4(composedMessage);
  const composedOpener3 = extractOpener3(composedMessage);
  for (const prior of priorOutbound) {
    const priorOpener4 = extractOpener4(prior.messageBody || "");
    const priorOpener3 = extractOpener3(prior.messageBody || "");
    if ((priorOpener4.length > 8 && composedOpener4 === priorOpener4) ||
        (priorOpener3.length > 5 && composedOpener3 === priorOpener3)) {
      return true;
    }
  }
  return false;
}

function applyOpenerAutoFix(
  composedMessage: string,
  priorOutbound: Array<{ messageBody: string }>,
  leadName: string,
  unansweredCount: number
): { fixed: boolean; message: string } {
  if (!priorOutbound.length || !composedMessage) return { fixed: false, message: composedMessage };

  const matched = isRepeatedOpener(composedMessage, priorOutbound);
  if (!matched) return { fixed: false, message: composedMessage };

  const leadFirstName = (leadName || "").split(" ")[0] || "there";
  const msgBody = composedMessage.trim();
  const greetingEndIdx = msgBody.indexOf("\n");
  const bodyAfterGreeting = greetingEndIdx > -1 ? msgBody.slice(greetingEndIdx).trimStart() : msgBody;

  const diverseOpeners =
    unansweredCount >= 3
      ? [`Quick question —`, `Honest question —`, `Random thought —`, `Plot twist —`, `Between us —`, `${leadFirstName}, real talk —`]
      : unanswered >= 2
      ? [`${leadFirstName}, just checking in —`, `Circling back on this —`, `One more thing —`, `Still thinking about this —`, `${leadFirstName}, wanted to follow up —`]
      : [`${leadFirstName},`, `Quick update —`, `Good news:`, `So,`, `Checking in —`, `Just wanted to share —`, `One thing —`];

  const newOpener = diverseOpeners[0]; // deterministic for tests
  const hasGreetingLine = /^(hey|hi|hello|yo)\s+\S+/i.test(msgBody.split("\n")[0]);
  let newMessage: string;
  if (hasGreetingLine && greetingEndIdx > -1) {
    newMessage = `${newOpener}\n\n${bodyAfterGreeting}`;
  } else {
    newMessage = `${newOpener}\n\n${msgBody}`;
  }

  return { fixed: true, message: newMessage };
}

// Fix the typo in the function above
function applyOpenerAutoFixFixed(
  composedMessage: string,
  priorOutbound: Array<{ messageBody: string }>,
  leadName: string,
  unansweredCount: number
): { fixed: boolean; message: string } {
  if (!priorOutbound.length || !composedMessage) return { fixed: false, message: composedMessage };

  const matched = isRepeatedOpener(composedMessage, priorOutbound);
  if (!matched) return { fixed: false, message: composedMessage };

  const leadFirstName = (leadName || "").split(" ")[0] || "there";
  const msgBody = composedMessage.trim();
  const greetingEndIdx = msgBody.indexOf("\n");
  const bodyAfterGreeting = greetingEndIdx > -1 ? msgBody.slice(greetingEndIdx).trimStart() : msgBody;

  const diverseOpeners =
    unansweredCount >= 3
      ? [`Quick question —`, `Honest question —`, `Random thought —`, `Plot twist —`, `Between us —`, `${leadFirstName}, real talk —`]
      : unansweredCount >= 2
      ? [`${leadFirstName}, just checking in —`, `Circling back on this —`, `One more thing —`, `Still thinking about this —`, `${leadFirstName}, wanted to follow up —`]
      : [`${leadFirstName},`, `Quick update —`, `Good news:`, `So,`, `Checking in —`, `Just wanted to share —`, `One thing —`];

  const newOpener = diverseOpeners[0]; // deterministic for tests
  const hasGreetingLine = /^(hey|hi|hello|yo)\s+\S+/i.test(msgBody.split("\n")[0]);
  let newMessage: string;
  if (hasGreetingLine && greetingEndIdx > -1) {
    newMessage = `${newOpener}\n\n${bodyAfterGreeting}`;
  } else {
    newMessage = `${newOpener}\n\n${msgBody}`;
  }

  return { fixed: true, message: newMessage };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Opener Auto-Fix: isRepeatedOpener detection", () => {
  it("detects exact 4-word opener match — Laura pattern", () => {
    // The exact Laura Damian case: both messages start with "Hey Laura, following up"
    const composed = "Hey Laura, following up on your t-shirt request for Rodriguez Family Child Care.";
    const prior = [{ messageBody: "Hey Laura, following up on your text inquiry for Rodriguez Family Child Care." }];
    expect(isRepeatedOpener(composed, prior)).toBe(true);
  });

  it("detects exact 4-word opener match — generic case", () => {
    const composed = "Hey John, following up on your order details.";
    const prior = [{ messageBody: "Hey John, following up on your inquiry last week." }];
    expect(isRepeatedOpener(composed, prior)).toBe(true);
  });

  it("detects exact 3-word opener match", () => {
    // "hi there how" === "hi there how" (> 5 chars)
    const composed = "Hi there, how are you doing today?";
    const prior = [{ messageBody: "Hi there, how can I help you?" }];
    expect(isRepeatedOpener(composed, prior)).toBe(true);
  });

  it("does NOT flag when openers are different", () => {
    const composed = "Quick update — we have a new design option for you.";
    const prior = [{ messageBody: "Hey Laura, following up on your t-shirt request." }];
    expect(isRepeatedOpener(composed, prior)).toBe(false);
  });

  it("does NOT flag when prior outbound is empty", () => {
    const composed = "Hey Laura, following up.";
    expect(isRepeatedOpener(composed, [])).toBe(false);
  });

  it("detects match across multiple prior messages", () => {
    const composed = "Hey Laura, following up on your t-shirt request.";
    const prior = [
      { messageBody: "Quick update — we have a new design option." },
      { messageBody: "Hey Laura, following up on your inquiry." },
    ];
    expect(isRepeatedOpener(composed, prior)).toBe(true);
  });

  it("is case-insensitive for opener comparison", () => {
    const composed = "HEY LAURA, FOLLOWING UP on your request.";
    const prior = [{ messageBody: "hey laura, following up on your inquiry." }];
    expect(isRepeatedOpener(composed, prior)).toBe(true);
  });

  it("ignores punctuation in opener comparison", () => {
    const composed = "Hey Laura! Following up on your request.";
    const prior = [{ messageBody: "Hey Laura, following up on your inquiry." }];
    // "hey laura following up" === "hey laura following up" after stripping punctuation
    expect(isRepeatedOpener(composed, prior)).toBe(true);
  });

  it("does NOT flag when prior message body is empty", () => {
    const composed = "Hey Laura, following up.";
    const prior = [{ messageBody: "" }];
    expect(isRepeatedOpener(composed, prior)).toBe(false);
  });

  it("does NOT flag when openers diverge after the first word", () => {
    // "Hi, how are" vs "Hi, nice to" — different 3-word openers, no match
    const composed = "Hi, how are you?";
    const prior = [{ messageBody: "Hi, nice to meet you." }];
    expect(isRepeatedOpener(composed, prior)).toBe(false);
  });

  it("DOES flag when 3-word opener matches (> 5 chars)", () => {
    // "Hi there how" (12 chars) matches "Hi there how"
    const composed = "Hi there, how are you doing?";
    const prior = [{ messageBody: "Hi there, how can I help?" }];
    expect(isRepeatedOpener(composed, prior)).toBe(true);
  });
});

describe("Opener Auto-Fix: replacement behavior", () => {
  it("replaces greeting line when message has newline after greeting", () => {
    const composed = "Hey Laura, following up on your t-shirt request.\n\nYour Church/Ministry event this month sounds exciting!";
    const prior = [{ messageBody: "Hey Laura, following up on your text inquiry for Rodriguez Family Child Care." }];
    const { fixed, message } = applyOpenerAutoFixFixed(composed, prior, "Laura Damian", 0);
    expect(fixed).toBe(true);
    expect(message).not.toMatch(/^Hey Laura/i);
    expect(message).toContain("Church/Ministry event");
  });

  it("preserves message body content after replacing opener", () => {
    const body = "Your Church/Ministry event this month sounds exciting! We can help with custom t-shirts.";
    const composed = `Hey Laura, following up on your t-shirt request.\n\n${body}`;
    const prior = [{ messageBody: "Hey Laura, following up on your text inquiry." }];
    const { fixed, message } = applyOpenerAutoFixFixed(composed, prior, "Laura Damian", 0);
    expect(fixed).toBe(true);
    expect(message).toContain("Church/Ministry event");
    expect(message).toContain("custom t-shirts");
  });

  it("returns fixed=false when no repeated opener", () => {
    const composed = "Quick update — we have a new design option for you.";
    const prior = [{ messageBody: "Hey Laura, following up on your t-shirt request." }];
    const { fixed } = applyOpenerAutoFixFixed(composed, prior, "Laura Damian", 0);
    expect(fixed).toBe(false);
  });

  it("uses escalated openers when unansweredCount >= 3", () => {
    const composed = "Hey Laura, following up again on your t-shirt request.";
    const prior = [{ messageBody: "Hey Laura, following up on your text inquiry." }];
    const { fixed, message } = applyOpenerAutoFixFixed(composed, prior, "Laura Damian", 3);
    expect(fixed).toBe(true);
    // unanswered >= 3 pool starts with "Quick question —"
    expect(message).toMatch(/^Quick question/);
  });

  it("uses mid-tier openers when unansweredCount is 2", () => {
    const composed = "Hey Laura, following up on your t-shirt request.";
    const prior = [{ messageBody: "Hey Laura, following up on your text inquiry." }];
    const { fixed, message } = applyOpenerAutoFixFixed(composed, prior, "Laura Damian", 2);
    expect(fixed).toBe(true);
    // unanswered >= 2 pool starts with "${firstName}, just checking in —"
    expect(message).toMatch(/^Laura, just checking in/);
  });

  it("uses base openers when unansweredCount is 0", () => {
    const composed = "Hey Laura, following up on your t-shirt request.";
    const prior = [{ messageBody: "Hey Laura, following up on your text inquiry." }];
    const { fixed, message } = applyOpenerAutoFixFixed(composed, prior, "Laura Damian", 0);
    expect(fixed).toBe(true);
    // unanswered < 2 pool starts with "${firstName},"
    expect(message).toMatch(/^Laura,/);
  });

  it("handles message without explicit greeting line (no newline)", () => {
    const composed = "Hey Laura, following up on your t-shirt request for Rodriguez Family Child Care.";
    const prior = [{ messageBody: "Hey Laura, following up on your text inquiry for Rodriguez Family Child Care." }];
    const { fixed, message } = applyOpenerAutoFixFixed(composed, prior, "Laura Damian", 0);
    expect(fixed).toBe(true);
    // No newline in original — prepends opener to full message
    expect(message).not.toMatch(/^Hey Laura/i);
  });

  it("returns fixed=false when priorOutbound is empty", () => {
    const composed = "Hey Laura, following up.";
    const { fixed } = applyOpenerAutoFixFixed(composed, [], "Laura Damian", 0);
    expect(fixed).toBe(false);
  });
});

describe("Opener Auto-Fix: Laura Damian regression test", () => {
  it("fixes the exact Laura Damian repeated opener pattern that caused circuit breaker", () => {
    // This is the exact pattern that caused Laura's circuit breaker to trip (4 consecutive blocks)
    const priorMessages = [
      { messageBody: "Hey Laura, following up on your text inquiry for Rodriguez Family Child Care." },
      { messageBody: "Hey Laura, following up on your t-shirt request for Rodriguez Family Child Care. Your Church/Ministry event this month sounds exciting." },
      { messageBody: "Hey Laura, following up on your t-shirt request for Rodriguez Family Child Care. Your Church/Ministry event this month sounds exciting!" },
    ];
    const newComposed = "Hey Laura, following up on your t-shirt request for Rodriguez Family Child Care. Your Church/Ministry event this month sounds exciting!";

    const { fixed, message } = applyOpenerAutoFixFixed(newComposed, priorMessages, "laura damian", 4);
    expect(fixed).toBe(true);
    expect(message).not.toMatch(/^Hey Laura/i);
    // Content preserved
    expect(message).toContain("Rodriguez Family Child Care");
  });

  it("does NOT fire for first contact (no prior outbound)", () => {
    const composed = "Hey Laura, following up on your t-shirt request.";
    const { fixed } = applyOpenerAutoFixFixed(composed, [], "Laura Damian", 0);
    expect(fixed).toBe(false);
  });
});
