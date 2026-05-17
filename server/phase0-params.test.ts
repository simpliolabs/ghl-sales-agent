/**
 * Phase 0: Emergency Relief — Parameter Validation Tests
 * 
 * Verifies all Phase 0 parameter changes are correctly applied:
 * - Cooldown: 60→30s
 * - Burst cap: 10→5
 * - Lock TTL: 300→120s
 * - Takeover window: 24h→4h
 * - Feature flag: DISABLE_LEGACY_TIMERS
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const readFile = (name: string) =>
  fs.readFileSync(path.join(__dirname, name), "utf-8");

describe("Phase 0: Parameter Tuning", () => {
  describe("Cooldown (60→30s)", () => {
    it("ghl.ts COOLDOWN_SECONDS should be 30", () => {
      const src = readFile("ghl.ts");
      expect(src).toMatch(/COOLDOWN_SECONDS\s*=\s*30/);
      expect(src).not.toMatch(/COOLDOWN_SECONDS\s*=\s*60/);
    });
  });

  describe("Burst Cap (10→5)", () => {
    it("ghl.ts BURST_MAX_SENDS should be 5", () => {
      const src = readFile("ghl.ts");
      expect(src).toMatch(/BURST_MAX_SENDS\s*=\s*5/);
      expect(src).not.toMatch(/BURST_MAX_SENDS\s*=\s*10/);
    });
  });

  describe("Lock TTL (300→120s)", () => {
    it("brain-adapter.ts lock TTL should be 120", () => {
      const src = readFile("brain-adapter.ts");
      expect(src).toMatch(/BRAIN_COUNCIL_LOCK_TTL_SECONDS\s*=\s*120/);
    });

    it("db.ts lock TTL should be 120 (must match orchestrator)", () => {
      const src = readFile("db.ts");
      expect(src).toMatch(/BRAIN_COUNCIL_LOCK_TTL_SECONDS\s*=\s*120/);
      expect(src).not.toMatch(/BRAIN_COUNCIL_LOCK_TTL_SECONDS\s*=\s*300/);
    });

    it("_core/index.ts stuck lock cleaner TTL should be 2 minutes", () => {
      const src = readFile("_core/index.ts");
      expect(src).toMatch(/STUCK_LOCK_TTL_MS\s*=\s*2\s*\*\s*60\s*\*\s*1000/);
      expect(src).not.toMatch(/STUCK_LOCK_TTL_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
    });
  });

  describe("Takeover Window (24h→4h)", () => {
    it("ghl.ts AGENT_TAKEOVER_WINDOW_MS should be 4 hours", () => {
      const src = readFile("ghl.ts");
      expect(src).toMatch(/AGENT_TAKEOVER_WINDOW_MS\s*=\s*4\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
      expect(src).not.toMatch(/AGENT_TAKEOVER_WINDOW_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
    });

    it("lead-disposition.ts stale takeover threshold should be 4 hours", () => {
      const src = readFile("lead-disposition.ts");
      expect(src).toContain("4 * 60 * 60 * 1000");
      expect(src).toContain("Phase 0");
    });

    it("supervisor.ts should use FOUR_HOURS (not TWENTY_FOUR_HOURS) for stale takeover", () => {
      const src = readFile("supervisor.ts");
      expect(src).toMatch(/FOUR_HOURS\s*=\s*4\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
      expect(src).not.toMatch(/TWENTY_FOUR_HOURS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
    });
  });

  describe("Feature Flag: DISABLE_LEGACY_TIMERS", () => {
    it("env.ts should export disableLegacyTimers", () => {
      const src = readFile("_core/env.ts");
      expect(src).toContain("disableLegacyTimers");
      expect(src).toContain("DISABLE_LEGACY_TIMERS");
    });

    it("webhooks.ts should gate legacy timers with disableLegacyTimers", () => {
      const src = readFile("webhooks.ts");
      const flagCount = (src.match(/ENV\.disableLegacyTimers/g) || []).length;
      // At least 6 timers gated in webhooks.ts
      expect(flagCount).toBeGreaterThanOrEqual(6);
    });

    it("_core/index.ts should gate legacy timers with disableLegacyTimers", () => {
      const src = readFile("_core/index.ts");
      const flagCount = (src.match(/ENV\.disableLegacyTimers/g) || []).length;
      // At least 4 timers gated in _core/index.ts
      expect(flagCount).toBeGreaterThanOrEqual(4);
    });

    it("all gated timers should log DISABLED message when flag is true", () => {
      const webhooksSrc = readFile("webhooks.ts");
      const indexSrc = readFile("_core/index.ts");
      const combined = webhooksSrc + indexSrc;
      const disabledLogs = (combined.match(/DISABLED by DISABLE_LEGACY_TIMERS/g) || []).length;
      // Every gated timer should have a DISABLED log
      expect(disabledLogs).toBeGreaterThanOrEqual(10);
    });
  });
});
