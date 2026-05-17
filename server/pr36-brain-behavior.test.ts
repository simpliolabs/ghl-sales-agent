/**
 * PR#3.6 — Brain Behavioral Tests
 *
 * These tests verify that the system prompt and tool definitions
 * contain the right content to guide the brain's behavior.
 * They do NOT call the LLM — they test the prompt engineering artifacts.
 *
 * Covers:
 * 1. Tool definitions include both getQuote and getMultiDesignQuote
 * 2. System prompt contains PRICING INPUTS hard constraint
 * 3. System prompt contains updated TREE 2 with multi-design branching
 * 4. Few-shot examples include both single-design and multi-design patterns
 * 5. Anti-patterns include color-asking and over-qualifying
 * 6. executeTool routes getMultiDesignQuote correctly
 */
import { describe, it, expect, vi } from "vitest";

// We need to read the source file to verify prompt content
import * as fs from "fs";
import * as path from "path";

const singleBrainSource = fs.readFileSync(
  path.join(__dirname, "single-brain.ts"),
  "utf-8"
);

describe("PR#3.6 Brain Behavioral Verification", () => {
  // ── 1. Tool definitions ────────────────────────────────────────────────
  describe("Tool definitions", () => {
    it("includes getQuote tool", () => {
      expect(singleBrainSource).toContain('name: "getQuote"');
    });

    it("includes getMultiDesignQuote tool", () => {
      expect(singleBrainSource).toContain('name: "getMultiDesignQuote"');
    });

    it("getMultiDesignQuote has designs array parameter", () => {
      // The tool definition should have a designs array
      expect(singleBrainSource).toContain('"designs"');
      expect(singleBrainSource).toContain('"array"');
    });

    it("getMultiDesignQuote description mentions volume discount", () => {
      expect(singleBrainSource).toContain("10% volume discount");
    });
  });

  // ── 2. Hard Constraint #14: PRICING INPUTS ─────────────────────────────
  describe("PRICING INPUTS hard constraint", () => {
    it("contains PRICING INPUTS section", () => {
      expect(singleBrainSource).toContain("14. PRICING INPUTS");
    });

    it("lists what AFFECTS PRICE", () => {
      expect(singleBrainSource).toContain("AFFECTS PRICE: quantity, number of print sides");
    });

    it("lists what DOES NOT AFFECT PRICE", () => {
      expect(singleBrainSource).toContain("DOES NOT AFFECT PRICE: shirt color, number of ink colors");
    });

    it("instructs to call getQuote or getMultiDesignQuote IMMEDIATELY when qty+sides known", () => {
      expect(singleBrainSource).toContain("call getQuote (1 design) or getMultiDesignQuote (2+ designs) IMMEDIATELY");
    });

    it("explicitly says do NOT ask about colors before quoting", () => {
      expect(singleBrainSource).toContain("Do NOT ask about shirt color, ink colors, or design color count before quoting");
    });
  });

  // ── 3. TREE 2: PRICING / QUOTE FLOW ────────────────────────────────────
  describe("TREE 2: PRICING / QUOTE FLOW", () => {
    it("replaces old TREE 2 with new title", () => {
      expect(singleBrainSource).toContain("TREE 2: PRICING / QUOTE FLOW");
      expect(singleBrainSource).not.toContain("TREE 2: PRICING RESPONSE");
    });

    it("includes multi-design branching", () => {
      expect(singleBrainSource).toContain("2+ designs with per-design quantities known");
      expect(singleBrainSource).toContain("2+ designs but per-design split unknown");
    });

    it("includes even-split instruction", () => {
      expect(singleBrainSource).toContain("Assume even split");
    });

    it("includes FRAMING RULE about estimates", () => {
      expect(singleBrainSource).toContain("FRAMING RULE: Always present the tool result as an");
    });

    it("includes AFTER QUOTING instruction", () => {
      expect(singleBrainSource).toContain("AFTER QUOTING: Ask about sizes, timeline, and design readiness");
    });
  });

  // ── 4. Few-shot examples ───────────────────────────────────────────────
  describe("Few-shot examples", () => {
    it("includes single-design pricing example (Example 2)", () => {
      expect(singleBrainSource).toContain("EXAMPLE 2: Lead asks about pricing — single design");
    });

    it("includes multi-design pricing example (Example 2b)", () => {
      expect(singleBrainSource).toContain("EXAMPLE 2b: Lead asks about pricing — multiple designs");
    });

    it("Example 2 frames as estimate, not exact quote", () => {
      // The good example should say "estimate" not "exact quote"
      expect(singleBrainSource).toContain("here's your estimate:");
    });

    it("Example 2b shows even-split with getMultiDesignQuote call", () => {
      expect(singleBrainSource).toContain("getMultiDesignQuote(designs=[{qty:7,sides:2},{qty:7,sides:2},{qty:6,sides:2}])");
    });

    it("Example 2 asks about sizes AFTER quoting", () => {
      expect(singleBrainSource).toContain("What sizes do you need?");
    });
  });

  // ── 5. Anti-patterns ───────────────────────────────────────────────────
  describe("Anti-patterns", () => {
    it("includes color-asking anti-pattern", () => {
      expect(singleBrainSource).toContain("How many colors in the design? And how many shirt colors?");
      expect(singleBrainSource).toContain("Colors do NOT affect price");
    });

    it("includes over-qualifying anti-pattern (Ron's exact scenario)", () => {
      expect(singleBrainSource).toContain("Could you confirm if the full-color logo");
      expect(singleBrainSource).toContain("Over-qualifying");
    });
  });

  // ── 6. executeTool routing ─────────────────────────────────────────────
  describe("executeTool routing", () => {
    it("has case handler for getMultiDesignQuote", () => {
      expect(singleBrainSource).toContain('case "getMultiDesignQuote"');
    });

    it("handler calls getMultiDesignQuote from pricing-engine", () => {
      // The handler should import and call the function
      expect(singleBrainSource).toContain("getMultiDesignQuote(designSpecs");
    });

    it("handler persists quote to DB via insertQuote", () => {
      // Should have insertQuote call within the getMultiDesignQuote case
      const caseBlock = singleBrainSource.split('case "getMultiDesignQuote"')[1]?.split("case ")[0] || "";
      expect(caseBlock).toContain("insertQuote");
    });
  });

  // ── 7. YOUR TASK section mentions both tools ───────────────────────────
  describe("YOUR TASK section", () => {
    it("mentions getMultiDesignQuote in the task instruction", () => {
      expect(singleBrainSource).toContain("getMultiDesignQuote for multi-design pricing");
    });
  });
});
