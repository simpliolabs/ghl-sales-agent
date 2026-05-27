/**
 * crons.test.ts — v1.9 Phase 1.C/D
 *
 * Vitest tests for the 5 cleanup crons in server/crons.ts.
 * All DB interactions are mocked — no real DB required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────
const {
  mockExecute,
  mockSweepExpiredLeadComposeLocks,
  mockGetPendingReconciliation,
  mockMarkReconciled,
} = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockSweepExpiredLeadComposeLocks: vi.fn(),
  mockGetPendingReconciliation: vi.fn(),
  mockMarkReconciled: vi.fn(),
}));

const mockDb = { execute: mockExecute };

vi.mock("./db", () => ({ getDb: vi.fn() }));
vi.mock("./lead-active-compose", () => ({
  sweepExpiredLeadComposeLocks: mockSweepExpiredLeadComposeLocks,
}));
vi.mock("./sent-messages", () => ({
  getPendingReconciliation: mockGetPendingReconciliation,
  markReconciled: mockMarkReconciled,
}));

import { getDb } from "./db";
import {
  cleanupOrphanedClaims,
  cleanupExpiredLeadActiveCompose,
  reconcileOrphanedSentMessages,
  sentMessagesRetention,
  victimRemediationSkeleton,
  ORPHAN_CLAIM_EXPIRY_MS,
  SENT_MESSAGES_RETENTION_DAYS,
} from "./crons";

const mockGetDb = vi.mocked(getDb);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeExecuteResult(affectedRows: number) {
  // MySQL2 ResultSetHeader format: result[0] = { affectedRows, ... }
  return [{ affectedRows }, []];
}

function makeRowsResult(rows: any[]) {
  // MySQL2 SELECT format: result[0] = rows array
  return [rows, []];
}

/** Extract SQL string from a Drizzle sql`...` template tag object. */
function extractSql(call: any): string {
  const chunks = call?.queryChunks;
  if (Array.isArray(chunks) && chunks.length > 0) {
    const parts: string[] = [];
    for (const chunk of chunks) {
      if (Array.isArray(chunk?.value)) {
        parts.push(...chunk.value.filter((v: any) => typeof v === "string"));
      }
    }
    return parts.join(" ");
  }
  return call?.sql ?? String(call);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3.1 — cleanupOrphanedClaims
// ─────────────────────────────────────────────────────────────────────────────
describe("cleanupOrphanedClaims", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockResolvedValue(mockDb as any);
  });

  it("returns {reclaimed:0, errors:0} when no orphaned rows exist", async () => {
    mockExecute.mockResolvedValue(makeExecuteResult(0));
    const result = await cleanupOrphanedClaims();
    expect(result).toEqual({ reclaimed: 0, errors: 0 });
    expect(mockExecute).toHaveBeenCalledOnce();
  });

  it("returns {reclaimed:N, errors:0} when N orphaned rows are reclaimed", async () => {
    mockExecute.mockResolvedValue(makeExecuteResult(3));
    const result = await cleanupOrphanedClaims();
    expect(result).toEqual({ reclaimed: 3, errors: 0 });
  });

  it("emits UPDATE outbox SET outbox_status = 'pending' SQL", async () => {
    mockExecute.mockResolvedValue(makeExecuteResult(0));
    await cleanupOrphanedClaims();
    const call = mockExecute.mock.calls[0][0];
    console.log('DEBUG call keys:', Object.keys(call || {}));
    const chunks2 = call?.queryChunks;
    console.log('DEBUG chunks2 type:', typeof chunks2, Array.isArray(chunks2));
    if (chunks2) {
      for (const c of chunks2) {
        console.log('DEBUG chunk type:', typeof c, 'isArr:', Array.isArray(c?.value), 'val:', JSON.stringify(c?.value));
      }
    }
    const sqlStr = extractSql(call);
    console.log('DEBUG sqlStr:', JSON.stringify(sqlStr));
    expect(sqlStr).toMatch(/UPDATE\s+outbox/i);
    expect(sqlStr).toMatch(/outbox_status\s*=\s*'pending'/i);
    expect(sqlStr).toMatch(/claimedBy\s*=\s*NULL/i);
  });

  it("returns {reclaimed:0, errors:1} when DB is unavailable", async () => {
    mockGetDb.mockResolvedValue(null as any);
    const result = await cleanupOrphanedClaims();
    expect(result).toEqual({ reclaimed: 0, errors: 1 });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("returns {reclaimed:0, errors:1} when execute throws", async () => {
    mockExecute.mockRejectedValue(new Error("DB connection lost"));
    const result = await cleanupOrphanedClaims();
    expect(result).toEqual({ reclaimed: 0, errors: 1 });
  });

  it("uses ORPHAN_CLAIM_EXPIRY_MS as the expiry threshold", () => {
    expect(ORPHAN_CLAIM_EXPIRY_MS).toBe(120_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3.2 — cleanupExpiredLeadActiveCompose
// ─────────────────────────────────────────────────────────────────────────────
describe("cleanupExpiredLeadActiveCompose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to sweepExpiredLeadComposeLocks and returns deleted count", async () => {
    mockSweepExpiredLeadComposeLocks.mockResolvedValue(5);
    const result = await cleanupExpiredLeadActiveCompose();
    expect(result).toEqual({ deleted: 5, errors: 0 });
    expect(mockSweepExpiredLeadComposeLocks).toHaveBeenCalledOnce();
  });

  it("returns {deleted:0, errors:0} when no expired locks exist", async () => {
    mockSweepExpiredLeadComposeLocks.mockResolvedValue(0);
    const result = await cleanupExpiredLeadActiveCompose();
    expect(result).toEqual({ deleted: 0, errors: 0 });
  });

  it("returns {deleted:0, errors:1} when sweepExpiredLeadComposeLocks throws", async () => {
    mockSweepExpiredLeadComposeLocks.mockRejectedValue(new Error("DB error"));
    const result = await cleanupExpiredLeadActiveCompose();
    expect(result).toEqual({ deleted: 0, errors: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3.3 — reconcileOrphanedSentMessages
// ─────────────────────────────────────────────────────────────────────────────
describe("reconcileOrphanedSentMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns {checked:0, confirmed:0, unknown:0, errors:0} when no pending rows", async () => {
    mockGetPendingReconciliation.mockResolvedValue([]);
    const result = await reconcileOrphanedSentMessages();
    expect(result).toEqual({ checked: 0, confirmed: 0, unknown: 0, errors: 0 });
    expect(mockMarkReconciled).not.toHaveBeenCalled();
  });

  it("marks each pending row as 'unknown' (PO Option 1 — GHL lookup unavailable)", async () => {
    const pendingRows = [
      { id: 1, leadId: 100, channel: "SMS", ghlMessageId: "msg-abc", sentAt: new Date() },
      { id: 2, leadId: 101, channel: "Email", ghlMessageId: null, sentAt: new Date() },
    ];
    mockGetPendingReconciliation.mockResolvedValue(pendingRows);
    mockMarkReconciled.mockResolvedValue(undefined);

    const result = await reconcileOrphanedSentMessages();
    expect(result.checked).toBe(2);
    expect(result.unknown).toBe(2);
    expect(result.confirmed).toBe(0);
    expect(result.errors).toBe(0);
    expect(mockMarkReconciled).toHaveBeenCalledTimes(2);
    expect(mockMarkReconciled).toHaveBeenCalledWith(1, "unknown");
    expect(mockMarkReconciled).toHaveBeenCalledWith(2, "unknown");
  });

  it("counts errors when markReconciled throws for a row", async () => {
    mockGetPendingReconciliation.mockResolvedValue([
      { id: 1, leadId: 100, channel: "SMS", ghlMessageId: null, sentAt: new Date() },
    ]);
    mockMarkReconciled.mockRejectedValue(new Error("DB write failed"));

    const result = await reconcileOrphanedSentMessages();
    expect(result.errors).toBe(1);
    expect(result.unknown).toBe(0);
  });

  it("returns errors:1 when getPendingReconciliation throws", async () => {
    mockGetPendingReconciliation.mockRejectedValue(new Error("DB read failed"));
    const result = await reconcileOrphanedSentMessages();
    expect(result.errors).toBe(1);
    expect(result.checked).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3.4 — sentMessagesRetention
// ─────────────────────────────────────────────────────────────────────────────
describe("sentMessagesRetention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockResolvedValue(mockDb as any);
  });

  it("returns {deleted:0, errors:0} when no old rows exist", async () => {
    mockExecute.mockResolvedValue(makeExecuteResult(0));
    const result = await sentMessagesRetention();
    expect(result).toEqual({ deleted: 0, errors: 0 });
  });

  it("returns {deleted:N, errors:0} when N rows are deleted", async () => {
    mockExecute.mockResolvedValue(makeExecuteResult(42));
    const result = await sentMessagesRetention();
    expect(result).toEqual({ deleted: 42, errors: 0 });
  });

  it("emits DELETE FROM sent_messages SQL with retention interval", async () => {
    mockExecute.mockResolvedValue(makeExecuteResult(0));
    await sentMessagesRetention();
    const call = mockExecute.mock.calls[0][0];
    const sqlStr = extractSql(call);
    expect(sqlStr).toMatch(/DELETE\s+FROM\s+sent_messages/i);
    expect(sqlStr).toMatch(/reconciledAt/i);
  });

  it("uses SENT_MESSAGES_RETENTION_DAYS = 30", () => {
    expect(SENT_MESSAGES_RETENTION_DAYS).toBe(30);
  });

  it("returns {deleted:0, errors:1} when DB is unavailable", async () => {
    mockGetDb.mockResolvedValue(null as any);
    const result = await sentMessagesRetention();
    expect(result).toEqual({ deleted: 0, errors: 1 });
  });

  it("returns {deleted:0, errors:1} when execute throws", async () => {
    mockExecute.mockRejectedValue(new Error("Disk full"));
    const result = await sentMessagesRetention();
    expect(result).toEqual({ deleted: 0, errors: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3.5 — victimRemediationSkeleton
// ─────────────────────────────────────────────────────────────────────────────
describe("victimRemediationSkeleton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockResolvedValue(mockDb as any);
  });

  it("returns {scanned:100, candidates:0, errors:0} when no candidates found", async () => {
    mockExecute.mockResolvedValue(makeRowsResult([]));
    const result = await victimRemediationSkeleton();
    expect(result).toEqual({ scanned: 100, candidates: 0, errors: 0 });
  });

  it("returns candidates count matching rows returned from DB", async () => {
    const rows = [
      { id: 1, firstName: "Test", lastName: "Lead", ghlContactId: "abc", dncStatus: "opted_out", lastMessageAt: new Date(), consecutiveNullCount: 0 },
      { id: 2, firstName: "Test2", lastName: "Lead2", ghlContactId: "def", dncStatus: null, lastMessageAt: new Date(), consecutiveNullCount: 6 },
    ];
    mockExecute.mockResolvedValue(makeRowsResult(rows));
    const result = await victimRemediationSkeleton();
    expect(result.candidates).toBe(2);
    expect(result.errors).toBe(0);
  });

  it("emits SELECT query scanning for DNC/null-count signals", async () => {
    mockExecute.mockResolvedValue(makeRowsResult([]));
    await victimRemediationSkeleton();
    const call = mockExecute.mock.calls[0][0];
    const sqlStr = extractSql(call);
    expect(sqlStr).toMatch(/SELECT/i);
    expect(sqlStr).toMatch(/leads/i);
    expect(sqlStr).toMatch(/dncStatus|consecutiveNullCount/i);
  });

  it("returns {scanned:0, candidates:0, errors:1} when DB is unavailable", async () => {
    mockGetDb.mockResolvedValue(null as any);
    const result = await victimRemediationSkeleton();
    expect(result).toEqual({ scanned: 0, candidates: 0, errors: 1 });
  });

  it("returns {scanned:0, candidates:0, errors:1} when execute throws", async () => {
    mockExecute.mockRejectedValue(new Error("Query timeout"));
    const result = await victimRemediationSkeleton();
    expect(result).toEqual({ scanned: 0, candidates: 0, errors: 1 });
  });

  it("does NOT perform any write operations (skeleton only)", async () => {
    mockExecute.mockResolvedValue(makeRowsResult([]));
    await victimRemediationSkeleton();
    expect(mockExecute).toHaveBeenCalledOnce();
    const call = mockExecute.mock.calls[0][0];
    const sqlStr = extractSql(call);
    expect(sqlStr).not.toMatch(/UPDATE|DELETE|INSERT/i);
  });
});
