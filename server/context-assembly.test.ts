/**
 * LAYER 1: CONTEXT ASSEMBLY — Tests
 * 
 * Verifies that:
 * 1. All Brain Council callers pass externalHistory
 * 2. Lookback context is extracted and surfaced in Strategist prompt
 * 3. brain-context.ts uses canonical getConversationHistory (no cache-key mismatch)
 * 4. All brains (Strategist, Composer, QC) merge externalHistory into their prompts
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const serverDir = path.resolve(__dirname);

function readFile(filename: string): string {
  return fs.readFileSync(path.join(serverDir, filename), "utf-8");
}

describe("Layer 1: Context Assembly", () => {

  describe("1.1: All Brain Council callers pass externalHistory", () => {
    it("webhook-message.ts passes externalHistory to runBrainCouncil", () => {
      const src = readFile("webhook-message.ts");
      // Must have externalHistory in the runBrainCouncil call
      expect(src).toMatch(/runBrainCouncil\(\{[^}]*externalHistory/s);
    });

    it("follow-up-trigger.ts enqueues into outbox with externalHistory in payload", () => {
      const src = readFile("follow-up-trigger.ts");
      // Phase 1: follow-up trigger now enqueues into outbox instead of calling runBrainCouncil directly
      // The outbox worker calls runBrainCouncil with externalHistory from the payload
      expect(src).toContain("enqueueOutbox");
      expect(src).toContain("externalHistory");
    });

    it("brain-council-review.ts fast scanner enqueues into outbox with externalHistory", () => {
      const src = readFile("brain-council-review.ts");
      // Phase 1: fast scanner and self-review now enqueue into outbox instead of calling runBrainCouncil directly
      // The outbox worker calls runBrainCouncil with externalHistory from the payload
      expect(src).toContain("enqueueOutbox");
      expect(src).toContain("externalHistory");
    });

    it("brain-council-review.ts imports fetchGhlConversationHistory", () => {
      const src = readFile("brain-council-review.ts");
      expect(src).toContain("fetchGhlConversationHistory");
      expect(src).toMatch(/import.*fetchGhlConversationHistory.*from.*ghl/);
    });

    it("brain-council-review.ts imports getConversationHistory from db", () => {
      const src = readFile("brain-council-review.ts");
      expect(src).toMatch(/import.*getConversationHistory.*from.*db/);
    });
  });

  describe("1.2: Lookback context is surfaced in Strategist prompt", () => {
    it("brain-types.ts LeadContext includes lookbackContext field", () => {
      const src = readFile("brain-types.ts");
      expect(src).toContain("lookbackContext");
    });

    it("brain-context.ts extracts lookbackContext from AI state and lead fields", () => {
      const src = readFile("brain-context.ts");
      // Must reference [LOOKBACK] marker
      expect(src).toContain("[LOOKBACK]");
      // Must set lookbackContext in the return
      expect(src).toMatch(/lookbackContext/);
      // Must check state.lastResearchSummary
      expect(src).toContain("lastResearchSummary");
      // Must check lead.lastStrategyReasoning
      expect(src).toContain("lastStrategyReasoning");
      // Must check state.sentimentTrend
      expect(src).toContain("sentimentTrend");
    });

    it("strategist.ts destructures lookbackContext from context", () => {
      const src = readFile("strategist.ts");
      expect(src).toMatch(/\{[^}]*lookbackContext[^}]*\}\s*=\s*context/s);
    });

    it("strategist.ts includes LOOKBACK ANALYSIS section in prompt", () => {
      const src = readFile("strategist.ts");
      expect(src).toContain("LOOKBACK ANALYSIS");
    });
  });

  describe("1.3: brain-context.ts uses canonical getConversationHistory", () => {
    it("imports getConversationHistory from db.ts", () => {
      const src = readFile("brain-context.ts");
      expect(src).toMatch(/import.*getConversationHistory.*from.*\.\/db/);
    });

    it("does NOT directly query conversations table for history", () => {
      const src = readFile("brain-context.ts");
      // Should NOT have a direct db.select().from(conversations)...orderBy(desc(conversations.timestamp)).limit() pattern
      // The canonical getConversationHistory handles this
      const directQueryPattern = /db\.select\(\)\.from\(conversations\)\s*\.where.*\.orderBy.*\.limit/s;
      expect(src).not.toMatch(directQueryPattern);
    });

    it("calls getConversationHistory with leadId", () => {
      const src = readFile("brain-context.ts");
      expect(src).toMatch(/getConversationHistory\(leadId/);
    });
  });

  describe("1.4: All brains merge externalHistory into their prompts", () => {
    it("strategist.ts merges externalHistory with historyStr in CONVERSATION HISTORY section", () => {
      const src = readFile("strategist.ts");
      expect(src).toMatch(/input\.externalHistory.*historyStr/s);
    });


    it("qc.ts merges externalHistory with historyStr in PRIOR CONVERSATION section", () => {
      const src = readFile("qc.ts");
      expect(src).toMatch(/input\.externalHistory.*historyStr/s);
    });
  });

  describe("1.5: Legacy brain-council.ts is dead code", () => {
    it("no active server files import from brain-council.ts (only brain-council-orchestrator.ts)", () => {
      const serverFiles = fs.readdirSync(serverDir)
        .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "brain-council.ts");
      
      for (const file of serverFiles) {
        const src = fs.readFileSync(path.join(serverDir, file), "utf-8");
        // Should not import from "./brain-council" (without -orchestrator or -review suffix)
        const legacyImport = src.match(/from\s+["']\.\/brain-council["']/);
        expect(legacyImport, `${file} imports legacy brain-council.ts`).toBeNull();
      }
    });
  });
});

describe("Layer 1.6: Prior Contact Guard — History Lookback Fix", () => {

  it("follow-up-trigger.ts ALWAYS fetches GHL history (no conditional leadAgeDays/convHistory check)", () => {
    const src = readFile("follow-up-trigger.ts");
    // Must call fetchGhlConversationHistory unconditionally (not inside an if block with leadAgeDays >= 3 && convHistory.length < 3)
    expect(src).toContain("fetchGhlConversationHistory(ghlContactId)");
    // The old conditional guard must be gone
    expect(src).not.toMatch(/if\s*\(\s*leadAgeDays\s*>=\s*3\s*&&\s*convHistory\.length\s*<\s*3\s*\)/);
  });

  it("follow-up-trigger.ts fetches 50 messages (not 20) for local history", () => {
    const src = readFile("follow-up-trigger.ts");
    // Foundation C.2 added excludeNonReal option — match the updated call signature
    expect(src).toMatch(/getConversationHistory\(leadId,\s*50/);
  });



  it("strategist.ts system prompt contains PRIOR CONTACT RULE", () => {
    const src = readFile("strategist.ts");
    expect(src).toContain("PRIOR CONTACT RULE");
    expect(src).toContain("MUST NOT use 'first_contact' or 'new_pitch'");
  });

  it("strategist.ts user input warns about prior contact when GHL history has outbound messages", () => {
    const src = readFile("strategist.ts");
    expect(src).toContain("PRIOR CONTACT DETECTED");
    // The inline regex check for outbound messages in the template literal
    expect(src).toMatch(/\[agent\\\/\//i);
  });

  it("follow-up-trigger.ts logs GHL history fetch count", () => {
    const src = readFile("follow-up-trigger.ts");
    expect(src).toContain("GHL history fetched for lead");
  });
});
