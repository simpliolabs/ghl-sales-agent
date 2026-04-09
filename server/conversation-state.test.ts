/**
 * Tests for Phase A: Conversation State Machine + Intent Classifier
 *
 * Tests:
 * 1. Intent classifier keyword fallback (no LLM)
 * 2. Conversation state machine transitions
 * 3. State machine hard overrides (human takeover, DNC, stale)
 * 4. Pipeline-driven state inference
 * 5. Context assembly includes convState/intentHistory
 * 6. Webhook-message.ts imports and wires the state machine
 */

import { describe, it, expect } from "vitest";
import { computeNextState, stateFromPipelineStage, type ConversationState } from "./conversation-state";
import { fallbackIntent, type IntentResult, type MessageIntent } from "./intent-classifier";
import fs from "fs";
import path from "path";

// ─── Helper: Build a mock IntentResult ──────────────────────────────────────

function makeIntent(intent: MessageIntent, overrides: Partial<IntentResult> = {}): IntentResult {
  return {
    intent,
    confidence: 80,
    reasoning: "Test intent",
    closingSignal: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── 1. Intent Classifier Keyword Fallback ──────────────────────────────────

describe("Intent Classifier — Keyword Fallback", () => {
  it("detects DNC keywords", () => {
    expect(fallbackIntent("stop").intent).toBe("dnc");
    expect(fallbackIntent("STOP").intent).toBe("dnc");
    expect(fallbackIntent("unsubscribe me please").intent).toBe("dnc");
    expect(fallbackIntent("Please remove me from your list").intent).toBe("dnc");
    expect(fallbackIntent("opt out").intent).toBe("dnc");
  });

  it("detects complaint keywords", () => {
    expect(fallbackIntent("I'm very unhappy with the order").intent).toBe("complaint");
    expect(fallbackIntent("This is terrible quality").intent).toBe("complaint");
    expect(fallbackIntent("I never received my order").intent).toBe("complaint");
  });

  it("detects price inquiry keywords", () => {
    expect(fallbackIntent("how much for 50 shirts?").intent).toBe("price_inquiry");
    expect(fallbackIntent("What's the price per shirt?").intent).toBe("price_inquiry");
    expect(fallbackIntent("Can I get a quote?").intent).toBe("price_inquiry");
  });

  it("detects confirmation keywords", () => {
    expect(fallbackIntent("yes").intent).toBe("confirmation");
    expect(fallbackIntent("sounds good").intent).toBe("confirmation");
    expect(fallbackIntent("perfect!").intent).toBe("confirmation");
    expect(fallbackIntent("let's do it").intent).toBe("confirmation");
  });

  it("treats standalone 'thank you' as general_chat (not closing)", () => {
    const result = fallbackIntent("thank you");
    expect(result.intent).toBe("general_chat");
    expect(result.closingSignal).toBe(false);
  });

  it("detects questions by question mark", () => {
    expect(fallbackIntent("What's your turnaround time?").intent).toBe("question");
  });

  it("returns unclear for ambiguous messages", () => {
    expect(fallbackIntent("ok").intent).toBe("unclear");
    expect(fallbackIntent("hmm").intent).toBe("unclear");
  });

  it("always returns a valid IntentResult shape", () => {
    const result = fallbackIntent("random message");
    expect(result).toHaveProperty("intent");
    expect(result).toHaveProperty("confidence");
    expect(result).toHaveProperty("reasoning");
    expect(result).toHaveProperty("closingSignal");
    expect(result).toHaveProperty("timestamp");
    expect(typeof result.confidence).toBe("number");
    expect(typeof result.closingSignal).toBe("boolean");
    expect(typeof result.timestamp).toBe("number");
  });
});

// ─── 2. Conversation State Machine Transitions ─────────────────────────────

describe("Conversation State Machine — computeNextState", () => {
  const defaultCtx = {
    pipelineStage: undefined,
    humanTakeover: false,
    daysSinceLastResponse: 1,
    allChannelsBlocked: false,
  };

  describe("Intent-driven transitions from new_lead", () => {
    it("new_lead + question → exploring", () => {
      const { state } = computeNextState("new_lead", makeIntent("question"), defaultCtx);
      expect(state).toBe("exploring");
    });

    it("new_lead + general_chat → exploring", () => {
      const { state } = computeNextState("new_lead", makeIntent("general_chat"), defaultCtx);
      expect(state).toBe("exploring");
    });

    it("new_lead + design_request → interested", () => {
      const { state } = computeNextState("new_lead", makeIntent("design_request"), defaultCtx);
      expect(state).toBe("interested");
    });

    it("new_lead + price_inquiry → interested", () => {
      const { state } = computeNextState("new_lead", makeIntent("price_inquiry"), defaultCtx);
      expect(state).toBe("interested");
    });

    it("new_lead + attachment_only → interested", () => {
      const { state } = computeNextState("new_lead", makeIntent("attachment_only"), defaultCtx);
      expect(state).toBe("interested");
    });
  });

  describe("Closing signals", () => {
    it("interested + thank_you_close with closingSignal → committed", () => {
      const intent = makeIntent("thank_you_close", { closingSignal: true });
      const { state } = computeNextState("interested", intent, defaultCtx);
      expect(state).toBe("committed");
    });

    it("exploring + confirmation with closingSignal → committed", () => {
      const intent = makeIntent("confirmation", { closingSignal: true });
      const { state } = computeNextState("exploring", intent, defaultCtx);
      expect(state).toBe("committed");
    });

    it("new_lead + confirmation without closingSignal → interested", () => {
      const intent = makeIntent("confirmation", { closingSignal: false });
      const { state } = computeNextState("new_lead", intent, defaultCtx);
      expect(state).toBe("interested");
    });

    it("thank_you_close without closingSignal from new_lead → exploring (not committed)", () => {
      const intent = makeIntent("thank_you_close", { closingSignal: false });
      const { state } = computeNextState("new_lead", intent, defaultCtx);
      expect(state).toBe("exploring");
    });
  });

  describe("Objection handling", () => {
    it("any state + objection → objecting", () => {
      for (const s of ["new_lead", "exploring", "interested", "committed"] as ConversationState[]) {
        const { state } = computeNextState(s, makeIntent("objection"), defaultCtx);
        expect(state).toBe("objecting");
      }
    });
  });

  describe("DNC transitions", () => {
    it("any state + dnc intent → dnc_channel", () => {
      const { state } = computeNextState("exploring", makeIntent("dnc"), defaultCtx);
      expect(state).toBe("dnc_channel");
    });
  });

  describe("Complaint escalation", () => {
    it("any state + complaint → human_active", () => {
      const { state } = computeNextState("interested", makeIntent("complaint"), defaultCtx);
      expect(state).toBe("human_active");
    });
  });

  describe("Reorder intent", () => {
    it("any state + reorder → interested", () => {
      const { state } = computeNextState("fulfilled", makeIntent("reorder"), defaultCtx);
      expect(state).toBe("interested");
    });
  });

  describe("State preservation", () => {
    it("committed + unclear → stays committed", () => {
      const { state } = computeNextState("committed", makeIntent("unclear"), defaultCtx);
      expect(state).toBe("committed");
    });

    it("interested + general_chat → stays interested", () => {
      const { state } = computeNextState("interested", makeIntent("general_chat"), defaultCtx);
      expect(state).toBe("interested");
    });

    it("interested + question → stays interested", () => {
      const { state } = computeNextState("interested", makeIntent("question"), defaultCtx);
      expect(state).toBe("interested");
    });
  });
});

// ─── 3. Hard Overrides ──────────────────────────────────────────────────────

describe("Conversation State Machine — Hard Overrides", () => {
  it("humanTakeover=true always → human_active regardless of intent", () => {
    const ctx = { humanTakeover: true, allChannelsBlocked: false };
    const { state } = computeNextState("interested", makeIntent("design_request"), ctx);
    expect(state).toBe("human_active");
  });

  it("allChannelsBlocked=true always → dnc_all regardless of intent", () => {
    const ctx = { humanTakeover: false, allChannelsBlocked: true };
    const { state } = computeNextState("exploring", makeIntent("question"), ctx);
    expect(state).toBe("dnc_all");
  });

  it("7+ days no response → stale (unless terminal state)", () => {
    const ctx = { humanTakeover: false, allChannelsBlocked: false, daysSinceLastResponse: 10 };
    const { state } = computeNextState("exploring", makeIntent("unclear"), ctx);
    expect(state).toBe("stale");
  });

  it("7+ days no response does NOT override committed", () => {
    const ctx = { humanTakeover: false, allChannelsBlocked: false, daysSinceLastResponse: 10 };
    const { state } = computeNextState("committed", makeIntent("unclear"), ctx);
    expect(state).toBe("committed");
  });

  it("7+ days no response does NOT override fulfilled", () => {
    const ctx = { humanTakeover: false, allChannelsBlocked: false, daysSinceLastResponse: 10 };
    const { state } = computeNextState("fulfilled", makeIntent("unclear"), ctx);
    expect(state).toBe("fulfilled");
  });

  it("humanTakeover takes priority over allChannelsBlocked", () => {
    const ctx = { humanTakeover: true, allChannelsBlocked: true };
    const { state } = computeNextState("new_lead", makeIntent("question"), ctx);
    expect(state).toBe("human_active");
  });
});

// ─── 4. Pipeline-Driven State Inference ─────────────────────────────────────

describe("stateFromPipelineStage", () => {
  it("maps 'Delivered' → fulfilled", () => {
    expect(stateFromPipelineStage("Delivered")).toBe("fulfilled");
  });

  it("maps 'Won' → fulfilled", () => {
    expect(stateFromPipelineStage("Won")).toBe("fulfilled");
  });

  it("maps 'Proof Sent' → committed", () => {
    expect(stateFromPipelineStage("Proof Sent")).toBe("committed");
  });

  it("maps 'Deposit Received' → committed", () => {
    expect(stateFromPipelineStage("Deposit Received")).toBe("committed");
  });

  it("maps 'Qualified' → interested", () => {
    expect(stateFromPipelineStage("Qualified")).toBe("interested");
  });

  it("maps 'Not Qualified' → dnc_all", () => {
    expect(stateFromPipelineStage("Not Qualified")).toBe("dnc_all");
  });

  it("maps New Lead and Contacted to conversation states", () => {
    expect(stateFromPipelineStage("New Lead")).toBe("new_lead");
    expect(stateFromPipelineStage("Contacted")).toBe("exploring");
  });

  it("returns null for truly unknown stages", () => {
    expect(stateFromPipelineStage("Some Random Stage")).toBeNull();
    expect(stateFromPipelineStage("Undefined Pipeline")).toBeNull();
  });
});

// ─── 5. Pipeline-driven hard override in computeNextState ───────────────────

describe("Pipeline stage overrides in computeNextState", () => {
  it("pipeline stage 'Delivered' → fulfilled regardless of intent", () => {
    const ctx = { pipelineStage: "Delivered", humanTakeover: false, allChannelsBlocked: false };
    const { state } = computeNextState("exploring", makeIntent("question"), ctx);
    expect(state).toBe("fulfilled");
  });

  it("pipeline stage 'Won' → fulfilled", () => {
    const ctx = { pipelineStage: "Won", humanTakeover: false, allChannelsBlocked: false };
    const { state } = computeNextState("interested", makeIntent("design_request"), ctx);
    expect(state).toBe("fulfilled");
  });
});

// ─── 6. Source File Integration Checks ──────────────────────────────────────

describe("Phase A Integration — Source File Checks", () => {
  it("brain-types.ts LeadContext includes convState field", () => {
    const src = fs.readFileSync(path.join(__dirname, "brain-types.ts"), "utf-8");
    expect(src).toContain("convState?:");
  });

  it("brain-types.ts LeadContext includes intentHistory field", () => {
    const src = fs.readFileSync(path.join(__dirname, "brain-types.ts"), "utf-8");
    expect(src).toContain("intentHistory?:");
  });

  it("brain-context.ts returns convState from lead", () => {
    const src = fs.readFileSync(path.join(__dirname, "brain-context.ts"), "utf-8");
    expect(src).toContain("convState:");
    expect(src).toContain("intentHistory:");
  });

  it("webhook-message.ts imports processInboundState", () => {
    const src = fs.readFileSync(path.join(__dirname, "webhook-message.ts"), "utf-8");
    expect(src).toContain("processInboundState");
    expect(src).toContain("conversation-state");
  });

  it("webhook-message.ts calls processInboundState in observation mode", () => {
    const src = fs.readFileSync(path.join(__dirname, "webhook-message.ts"), "utf-8");
    expect(src).toContain("PHASE A: CONVERSATION STATE MACHINE (observation mode)");
    expect(src).toContain("processInboundState({");
  });

  it("schema.ts includes convState column on leads table", () => {
    const src = fs.readFileSync(path.join(__dirname, "../drizzle/schema.ts"), "utf-8");
    expect(src).toContain("convState:");
    expect(src).toContain("convStateUpdatedAt:");
    expect(src).toContain("intentHistory:");
  });
});

// ─── 7. Paulette's Case — The Key Scenario ─────────────────────────────────

describe("Paulette's Case — Thank You After Confirmation", () => {
  it("interested + thank_you_close(closingSignal=true) → committed", () => {
    // Paulette gave design details (interested state)
    // Then said "Thank you" after AI confirmed the details
    // This should transition to committed, NOT stay in interested
    const intent = makeIntent("thank_you_close", {
      closingSignal: true,
      confidence: 92,
      reasoning: "Customer said 'thank you' after design details were confirmed",
    });
    const result = computeNextState("interested", intent, {
      humanTakeover: false,
      allChannelsBlocked: false,
    });
    expect(result.state).toBe("committed");
    expect(result.reason.toLowerCase()).toContain("closing signal");
  });

  it("new_lead + thank_you (no closing signal) → exploring (NOT committed)", () => {
    // A polite "thank you" at the start of conversation is NOT a close
    const intent = makeIntent("thank_you_close", {
      closingSignal: false,
      confidence: 40,
      reasoning: "Generic thank you at start of conversation",
    });
    const result = computeNextState("new_lead", intent, {
      humanTakeover: false,
      allChannelsBlocked: false,
    });
    expect(result.state).toBe("exploring");
    expect(result.state).not.toBe("committed");
  });
});
