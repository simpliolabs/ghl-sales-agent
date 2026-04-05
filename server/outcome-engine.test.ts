import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the database module
vi.mock("./db", () => ({
  getDb: vi.fn(),
}));

// Mock the LLM module
vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn(),
}));

// We test the exported functions by importing them after mocks are set up
import { attributeReply, attributeStageAdvance, getPatternAnalysis, buildLearningContext, backfillOutcomes } from "./outcome-engine";
import { getDb } from "./db";

// Helper to create a mock DB with chainable query builder
function createMockDb() {
  const mockResult: any[] = [];
  const chain: any = {};
  const methods = ["select", "from", "where", "orderBy", "limit", "leftJoin", "groupBy", "insert", "values", "update", "set"];
  methods.forEach(m => {
    chain[m] = vi.fn().mockReturnValue(chain);
  });
  // Make the chain thenable (resolves to mockResult)
  chain.then = (resolve: any) => resolve(mockResult);
  // Allow setting results
  chain._setResult = (r: any[]) => {
    chain.then = (resolve: any) => resolve(r);
    // Also make it directly awaitable
    Object.defineProperty(chain, Symbol.toStringTag, { value: "Promise" });
  };
  return { chain, mockResult };
}

describe("Outcome Engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("attributeReply", () => {
    it("returns null when no DB is available", async () => {
      vi.mocked(getDb).mockResolvedValue(null);
      const result = await attributeReply({
        leadId: 1,
        replyMessage: "Yes, I'm interested!",
        replyTimestamp: new Date(),
        channel: "SMS",
      });
      expect(result).toBeNull();
    });

    it("returns null when no recent AI audit entry exists", async () => {
      const chainFactory = (result: any[]) => {
        const c: any = {};
        ["select", "from", "where", "orderBy", "limit", "leftJoin", "groupBy", "insert", "values", "update", "set"]
          .forEach(m => { c[m] = vi.fn().mockReturnValue(c); });
        c.then = (resolve: any) => resolve(result);
        return c;
      };
      const mockDb: any = {};
      mockDb.select = vi.fn().mockReturnValue(chainFactory([]));
      vi.mocked(getDb).mockResolvedValue(mockDb);
      
      const result = await attributeReply({
        leadId: 1,
        replyMessage: "Yes, I'm interested!",
        replyTimestamp: new Date(),
        channel: "SMS",
      });
      expect(result).toBeNull();
    });

    it("classifies positive sentiment correctly", async () => {
      const sentAt = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
      const mockAudit = {
        id: 42,
        leadId: 1,
        messageSent: 1,
        createdAt: sentAt,
        strategyFramework: "HORMOZI_ACA",
        strategyApproach: "first_contact",
        channel: "SMS",
        composerFromName: "Abby",
        strategyTier: "1",
      };

      // Create a mock DB that returns different results for different calls
      let callCount = 0;
      const mockDb: any = {};
      const chainFactory = (result: any[]) => {
        const c: any = {};
        const methods = ["select", "from", "where", "orderBy", "limit", "leftJoin", "groupBy", "insert", "values", "update", "set"];
        methods.forEach(m => { c[m] = vi.fn().mockReturnValue(c); });
        c.then = (resolve: any) => resolve(result);
        return c;
      };

      mockDb.select = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return chainFactory([mockAudit]); // audit lookup
        if (callCount === 2) return chainFactory([]); // existing outcome check
        return chainFactory([]);
      });
      mockDb.insert = vi.fn().mockReturnValue(chainFactory([{ insertId: 1 }]));

      vi.mocked(getDb).mockResolvedValue(mockDb);

      const result = await attributeReply({
        leadId: 1,
        replyMessage: "Yes, I'm interested! Tell me more about pricing",
        replyTimestamp: new Date(),
        channel: "SMS",
      });

      expect(result).not.toBeNull();
      expect(result!.auditId).toBe(42);
      expect(result!.sentiment).toBe("positive");
      expect(result!.replyMinutes).toBeGreaterThan(0);
    });

    it("classifies negative sentiment correctly", async () => {
      const sentAt = new Date(Date.now() - 10 * 60 * 1000);
      const mockAudit = {
        id: 10,
        leadId: 2,
        messageSent: 1,
        createdAt: sentAt,
        strategyFramework: "PAS",
        strategyApproach: "follow_up",
        channel: "Email",
        composerFromName: "Chris",
        strategyTier: "2",
      };

      let callCount = 0;
      const mockDb: any = {};
      const chainFactory = (result: any[]) => {
        const c: any = {};
        ["select", "from", "where", "orderBy", "limit", "leftJoin", "groupBy", "insert", "values", "update", "set"]
          .forEach(m => { c[m] = vi.fn().mockReturnValue(c); });
        c.then = (resolve: any) => resolve(result);
        return c;
      };
      mockDb.select = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return chainFactory([mockAudit]);
        if (callCount === 2) return chainFactory([]);
        return chainFactory([]);
      });
      mockDb.insert = vi.fn().mockReturnValue(chainFactory([{ insertId: 1 }]));
      vi.mocked(getDb).mockResolvedValue(mockDb);

      const result = await attributeReply({
        leadId: 2,
        replyMessage: "Stop contacting me, not interested",
        replyTimestamp: new Date(),
        channel: "Email",
      });

      expect(result).not.toBeNull();
      expect(result!.sentiment).toBe("negative");
    });
  });

  describe("getPatternAnalysis", () => {
    it("returns empty insights when DB is unavailable", async () => {
      vi.mocked(getDb).mockResolvedValue(null);
      const insights = await getPatternAnalysis();
      expect(insights.totalTracked).toBe(0);
      expect(insights.frameworkStats).toEqual([]);
      expect(insights.channelStats).toEqual([]);
      expect(insights.topPerformers).toEqual([]);
    });
  });

  describe("buildLearningContext", () => {
    it("returns insufficient data message when fewer than 5 outcomes tracked", async () => {
      // Mock getPatternAnalysis indirectly through getDb
      vi.mocked(getDb).mockResolvedValue(null);
      const context = await buildLearningContext();
      expect(context).toContain("Insufficient data");
    });
  });

  describe("backfillOutcomes", () => {
    it("returns 0 when DB is unavailable", async () => {
      vi.mocked(getDb).mockResolvedValue(null);
      const count = await backfillOutcomes();
      expect(count).toBe(0);
    });
  });

  describe("attributeStageAdvance", () => {
    it("does nothing when DB is unavailable", async () => {
      vi.mocked(getDb).mockResolvedValue(null);
      // Should not throw
      await attributeStageAdvance({ leadId: 1, toStage: "Qualified" });
    });

    it("does nothing when no recent AI audit entry exists", async () => {
      const chainFactory = (result: any[]) => {
        const c: any = {};
        ["select", "from", "where", "orderBy", "limit", "leftJoin", "groupBy", "insert", "values", "update", "set"]
          .forEach(m => { c[m] = vi.fn().mockReturnValue(c); });
        c.then = (resolve: any) => resolve(result);
        return c;
      };
      const mockDb: any = {};
      mockDb.select = vi.fn().mockReturnValue(chainFactory([]));
      vi.mocked(getDb).mockResolvedValue(mockDb);

      // Should not throw
      await attributeStageAdvance({ leadId: 1, toStage: "Qualified" });
    });
  });
});
