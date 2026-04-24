import { describe, expect, it, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Mock all DB functions
vi.mock("./db", () => ({
  getAllLeads: vi.fn().mockResolvedValue([
    { id: 1, ghlContactId: "c1", firstName: "John", lastName: "Doe", email: "john@test.com", phone: "555-1234", companyName: "ACME", opportunityScore: 85, pipelineStage: "Contacted", source: "facebook", omnisendSegment: "churches", assignedAgent: "Abby Bouwer", humanTakeover: 0, lastContactedAt: new Date(), createdAt: new Date() },
    { id: 2, ghlContactId: "c2", firstName: "Jane", lastName: "Smith", email: "jane@test.com", phone: "555-5678", companyName: "XYZ Corp", opportunityScore: 45, pipelineStage: "New Lead", source: "website", omnisendSegment: null, assignedAgent: null, humanTakeover: 0, lastContactedAt: null, createdAt: new Date() },
  ]),
  getHotLeads: vi.fn().mockResolvedValue([
    { id: 1, ghlContactId: "c1", firstName: "John", lastName: "Doe", email: "john@test.com", phone: "555-1234", companyName: "ACME", opportunityScore: 85, pipelineStage: "Contacted", source: "facebook", omnisendSegment: "churches", assignedAgent: "Abby Bouwer", humanTakeover: 0, lastContactedAt: new Date(), createdAt: new Date() },
  ]),
  getLeadById: vi.fn().mockResolvedValue({ id: 1, ghlContactId: "c1", firstName: "John", lastName: "Doe", email: "john@test.com", phone: "555-1234", companyName: "ACME", opportunityScore: 85, pipelineStage: "Contacted", source: "facebook", omnisendSegment: "churches", assignedAgent: "Abby Bouwer", humanTakeover: 0, lastContactedAt: new Date(), createdAt: new Date() }),
  getConversationHistory: vi.fn().mockResolvedValue([]),
  getPipelineStats: vi.fn().mockResolvedValue([{ stage: "New Lead", count: 10 }, { stage: "Contacted", count: 5 }]),
  getAiPerformanceStats: vi.fn().mockResolvedValue({ aiMessages: 50, avgScore: 65, hotLeads: 8, totalLeads: 100 }),
  getRecentAiMessages: vi.fn().mockResolvedValue([
    { id: 1, leadId: 1, direction: "outbound", channel: "sms", messageBody: "Hi John!", senderName: "Adorb Custom Tees", timestamp: new Date() },
  ]),
  getKnowledgeFiles: vi.fn().mockResolvedValue([
    { id: 1, fileName: "catalog.pdf", fileType: "application/pdf", fileUrl: "https://cdn.example.com/catalog.pdf", googleSheetUrl: null, contentText: "T-shirts, hoodies", lastSyncedAt: null, createdAt: new Date() },
  ]),
  addKnowledgeFile: vi.fn().mockResolvedValue({ id: 2 }),
  deleteKnowledgeFile: vi.fn().mockResolvedValue(undefined),
  updateKnowledgeFile: vi.fn().mockResolvedValue(undefined),
  getActiveTweaks: vi.fn().mockResolvedValue([
    { id: 1, adminId: 1, tweakInstruction: "Tone down urgency", status: "active", appliedAt: new Date() },
  ]),
  addAiTweak: vi.fn().mockResolvedValue({ id: 2 }),
  archiveTweak: vi.fn().mockResolvedValue(undefined),
  getAgentWorkload: vi.fn().mockResolvedValue([
    { agent: "Abby Bouwer", count: 12 },
    { agent: "Chris McHendry", count: 10 },
  ]),
  getPipelineEvents: vi.fn().mockResolvedValue([]),
  getAiState: vi.fn().mockResolvedValue({ id: 1, leadId: 1, lastAngleUsed: "bottleneck_diagnosis", lastFrameworkUsed: "PAS", messageCount: 5, objectionsRaised: "price too high", interestSignals: "asked about turnaround", nextFollowUpAt: new Date(), nextBestCta: "offer quick-win", reactivateAt: null }),
  updateLeadFields: vi.fn().mockResolvedValue(undefined),
  upsertLead: vi.fn().mockResolvedValue({ id: 1 }),
}));

// Mock GHL
vi.mock("./ghl", () => ({
  getContacts: vi.fn().mockResolvedValue({ contacts: [{ id: "c1" }, { id: "c2" }], meta: { total: 2 } }),
  getPipelines: vi.fn().mockResolvedValue([{ id: "p1", name: "Bulk Printing Pipeline" }]),
}));

// Mock storage
vi.mock("./storage", () => ({
  storagePut: vi.fn().mockResolvedValue({ url: "https://cdn.example.com/file.pdf", key: "knowledge/file.pdf" }),
}));

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createProtectedContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1, openId: "test-user", email: "admin@adorb.com", name: "Admin",
    loginMethod: "manus", role: "admin", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
}

describe("leads router", () => {
  it("lists all leads", async () => {
    const caller = appRouter.createCaller(createProtectedContext());
    const leads = await caller.leads.list();
    expect(leads).toHaveLength(2);
    expect(leads[0].firstName).toBe("John");
    expect(leads[1].firstName).toBe("Jane");
  });

  it("returns hot leads with score >= 80", async () => {
    const caller = appRouter.createCaller(createProtectedContext());
    const hot = await caller.leads.hot();
    expect(hot).toHaveLength(1);
    expect(hot[0].opportunityScore).toBeGreaterThanOrEqual(80);
  });

  it("returns lead detail with history and AI state", async () => {
    const caller = appRouter.createCaller(createProtectedContext());
    const detail = await caller.leads.detail({ id: 1 });
    expect(detail).not.toBeNull();
    expect(detail!.lead.firstName).toBe("John");
    expect(detail!.aiState).toBeDefined();
    expect(detail!.aiState!.lastAngleUsed).toBe("bottleneck_diagnosis");
  });

  it("toggles human takeover", async () => {
    const caller = appRouter.createCaller(createProtectedContext());
    const result = await caller.leads.toggleHumanTakeover({ id: 1, takeover: true });
    expect(result.success).toBe(true);
  });
});

describe("pipeline router", () => {
  it("returns pipeline stats", async () => {
    const caller = appRouter.createCaller(createProtectedContext());
    const stats = await caller.pipeline.stats();
    expect(stats).toHaveLength(2);
    expect(stats[0].stage).toBe("New Lead");
  });

  it("fetches GHL pipelines", async () => {
    const caller = appRouter.createCaller(createProtectedContext());
    const pipelines = await caller.pipeline.ghlPipelines();
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0].name).toBe("Bulk Printing Pipeline");
  });
});

describe("ai router", () => {
  it("returns AI performance stats", async () => {
    const caller = appRouter.createCaller(createProtectedContext());
    const perf = await caller.ai.performance();
    expect(perf.aiMessages).toBe(50);
    expect(perf.avgScore).toBe(65);
    expect(perf.hotLeads).toBe(8);
    expect(perf.totalLeads).toBe(100);
  });

  it("returns recent AI messages", async () => {
    const caller = appRouter.createCaller(createProtectedContext());
    const msgs = await caller.ai.recentMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].messageBody).toBe("Hi John!");
  });

  it("returns active tweaks", async () => {
    const caller = appRouter.createCaller(createProtectedContext());
    const tweaks = await caller.ai.tweaks();
    expect(tweaks).toHaveLength(1);
    expect(tweaks[0].tweakInstruction).toBe("Tone down urgency");
  });

  it("adds a new tweak", async () => {
    const caller = appRouter.createCaller(createProtectedContext());
    const result = await caller.ai.addTweak({ instruction: "Be more direct" });
    expect(result).toBeDefined();
  });

  it("archives a tweak", async () => {
    const caller = appRouter.createCaller(createProtectedContext());
    const result = await caller.ai.archiveTweak({ id: 1 });
    expect(result.success).toBe(true);
  });
});

describe("knowledge router", () => {
  it("lists knowledge files", async () => {
    const caller = appRouter.createCaller(createProtectedContext());
    const files = await caller.knowledge.list();
    expect(files).toHaveLength(1);
    expect(files[0].fileName).toBe("catalog.pdf");
  });

  it("adds a Google Sheet link", async () => {
    const caller = appRouter.createCaller(createProtectedContext());
    // fetchAllSheetTabs probes multiple GIDs over the network; use a longer timeout
    const result = await caller.knowledge.addGoogleSheet({ name: "Price List", url: "https://docs.google.com/spreadsheets/d/abc123" });
    expect(result).toBeDefined();
  }, 60_000);

  it("deletes a knowledge file", async () => {
    const caller = appRouter.createCaller(createProtectedContext());
    const result = await caller.knowledge.delete({ id: 1 });
    expect(result.success).toBe(true);
  });
});

describe("agents router", () => {
  it("returns agent workload", async () => {
    const caller = appRouter.createCaller(createProtectedContext());
    const workload = await caller.agents.workload();
    expect(workload).toHaveLength(2);
    expect(workload[0].agent).toBe("Abby Bouwer");
  });
});

describe("ghl router", () => {
  it("syncs contacts from GHL", async () => {
    const caller = appRouter.createCaller(createProtectedContext());
    const result = await caller.ghl.syncContacts();
    expect(result.contacts).toBe(2);
  });
});
