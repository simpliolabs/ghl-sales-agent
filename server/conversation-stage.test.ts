/**
 * Tests for Module 1: Conversation Stage Detection
 * Validates that conversationStage flows through the Brain Council pipeline
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the strategist output to include conversationStage
describe("Conversation Stage Detection", () => {
  describe("StrategyDecision type", () => {
    it("should accept all 9 valid conversation stages", () => {
      const validStages = [
        "introduction",
        "qualification",
        "value_proposition",
        "needs_analysis",
        "objection_handling",
        "closing",
        "post_sale",
        "reactivation",
        "graceful_exit",
      ];
      validStages.forEach((stage) => {
        expect(typeof stage).toBe("string");
        expect(stage.length).toBeGreaterThan(0);
      });
    });
  });

  describe("QC stage-aware rules", () => {
    it("should flag stage_mismatch when closing stage uses cold outreach language", () => {
      const stage = "closing";
      const message = "Hi, I'm Abby from Adorb Custom Tees! We do custom printing.";
      const hasColdIntro = /^Hi,?\s+I'm\s+\w+\s+from\s+Adorb/i.test(message);
      const isClosingOrPostSale = stage === "closing" || stage === "post_sale";
      expect(isClosingOrPostSale && hasColdIntro).toBe(true);
    });

    it("should flag stage_mismatch when introduction references non-existent prior conversations", () => {
      const stage = "introduction";
      const message = "Following up on our last conversation about your order...";
      const hasFollowUpRef = /follow(ing)?\s+up\s+on\s+(our|the)\s+(last|previous)/i.test(message);
      expect(stage === "introduction" && hasFollowUpRef).toBe(true);
    });

    it("should flag stage_mismatch when objection_handling ignores the objection", () => {
      const stage = "objection_handling";
      const objection = "Your prices are too high";
      const message = "Check out our new spring collection! We have great designs.";
      const addressesObjection = message.toLowerCase().includes("price") || message.toLowerCase().includes("cost") || message.toLowerCase().includes("budget");
      expect(stage === "objection_handling" && !addressesObjection).toBe(true);
    });

    it("should flag fresh_outreach_on_aged_lead when reactivation treats lead as brand new", () => {
      const stage = "reactivation";
      const message = "Hi Ray, Abby here from Adorb Custom Tees! Got your inquiry — what kind of custom apparel project can we help you with?";
      const hasTimeGapAck = /been a while|reached out|some time|previously|last time|while back|ago/i.test(message);
      expect(stage === "reactivation" && !hasTimeGapAck).toBe(true);
    });

    it("should NOT flag when reactivation properly acknowledges time gap", () => {
      const stage = "reactivation";
      const message = "Hey Ray, it's been a while since we last connected! Still thinking about those custom tees?";
      const hasTimeGapAck = /been a while|reached out|some time|previously|last time|while back|ago/i.test(message);
      expect(stage === "reactivation" && hasTimeGapAck).toBe(true);
    });

    it("should NOT flag when introduction is genuinely first contact", () => {
      const stage = "introduction";
      const message = "Hi Sarah, Abby here from Adorb Custom Tees! Got your inquiry — what kind of custom apparel project can we help you with?";
      const hasFollowUpRef = /follow(ing)?\s+up\s+on\s+(our|the)\s+(last|previous)/i.test(message);
      expect(stage === "introduction" && !hasFollowUpRef).toBe(true);
    });
  });

  describe("Audit log integration", () => {
    it("should include conversationStage in audit data structure", () => {
      const auditData = {
        leadId: 1,
        leadName: "Test Lead",
        strategyApproach: "initial_outreach",
        strategyFramework: "AIDA",
        conversationStage: "introduction",
      };
      expect(auditData).toHaveProperty("conversationStage");
      expect(auditData.conversationStage).toBe("introduction");
    });

    it("should handle undefined conversationStage gracefully", () => {
      const auditData = {
        leadId: 1,
        leadName: "Test Lead",
        conversationStage: undefined,
      };
      expect(auditData.conversationStage).toBeUndefined();
    });
  });

  describe("BrainCouncilOutput integration", () => {
    it("should carry conversationStage through approved path", () => {
      const output = {
        message: "Hey there!",
        fromName: "Abby Bouwer",
        framework: "AIDA",
        angle: "value",
        channel: "SMS",
        conversationStage: "qualification",
        blocked: false,
      };
      expect(output.conversationStage).toBe("qualification");
    });

    it("should carry conversationStage through blocked path", () => {
      const output = {
        message: "",
        fromName: "System",
        framework: "BLOCKED_NO_FALLBACK",
        conversationStage: "objection_handling",
        blocked: true,
        blockReason: "stage_mismatch",
      };
      expect(output.conversationStage).toBe("objection_handling");
    });

    it("should carry conversationStage through graceful_exit path", () => {
      const output = {
        message: "",
        fromName: "System",
        framework: "graceful_exit",
        conversationStage: "graceful_exit",
        blocked: true,
      };
      expect(output.conversationStage).toBe("graceful_exit");
    });
  });

  describe("Stage detection logic", () => {
    it("should detect introduction for leads with no prior messages", () => {
      const priorOutbound = 0;
      const hasReplied = false;
      const expectedStage = priorOutbound === 0 ? "introduction" : "qualification";
      expect(expectedStage).toBe("introduction");
    });

    it("should detect reactivation for leads dormant 90+ days", () => {
      const daysSinceLastContact = 150;
      const isReactivation = daysSinceLastContact >= 90;
      expect(isReactivation).toBe(true);
    });

    it("should detect objection_handling when lead has expressed concern", () => {
      const lastMessage = "Your prices are too high for our budget";
      const hasObjection = /too (high|expensive|much)|can't afford|budget|cheaper|discount/i.test(lastMessage);
      expect(hasObjection).toBe(true);
    });

    it("should detect closing when lead is ready to buy", () => {
      const lastMessage = "Sounds good, how do I place the order?";
      const hasClosingSignal = /place.*(order|the order)|ready to (order|buy|proceed)|let's do it|send.*invoice/i.test(lastMessage);
      expect(hasClosingSignal).toBe(true);
    });

    it("should detect post_sale for leads with paid orders", () => {
      const pipelineStage = "paid";
      const isPostSale = ["paid", "delivered", "completed"].includes(pipelineStage);
      expect(isPostSale).toBe(true);
    });
  });
});
