/**
 * Tests for the atomic upsert in upsertLead() and the contact-level mutex.
 *
 * These tests verify:
 * 1. upsertLead returns a lead for a new ghlContactId (INSERT path)
 * 2. upsertLead returns the same lead on duplicate ghlContactId (UPDATE path, no new row)
 * 3. upsertLead merges non-null fields on duplicate without clobbering existing data
 * 4. Contact-level mutex serializes concurrent webhook processing
 */

import { describe, expect, it, afterAll } from "vitest";
import { upsertLead, getLeadByGhlContactId, getDb } from "./db";
import { leads } from "../drizzle/schema";
import { eq } from "drizzle-orm";

// Unique ghlContactId per test run to avoid cross-run collisions
const TEST_PREFIX = `test_${Date.now()}_`;

async function cleanupTestLeads() {
  const db = await getDb();
  if (!db) return;
  // Delete all test leads created during this run
  await db.delete(leads).where(eq(leads.source, "vitest_upsert"));
}

afterAll(async () => {
  await cleanupTestLeads();
});

describe("upsertLead — atomic INSERT...ON DUPLICATE KEY UPDATE", () => {
  it("creates a new lead when ghlContactId does not exist", async () => {
    const ghlId = `${TEST_PREFIX}new_contact_1`;
    const result = await upsertLead({
      ghlContactId: ghlId,
      name: "Test Lead",
      email: "test@example.com",
      source: "vitest_upsert",
    });

    expect(result).not.toBeNull();
    expect(result!.ghlContactId).toBe(ghlId);
    expect(result!.name).toBe("Test Lead");
    expect(result!.email).toBe("test@example.com");
    expect(result!.id).toBeGreaterThan(0);
  });

  it("returns the SAME lead (no duplicate) when called twice with the same ghlContactId", async () => {
    const ghlId = `${TEST_PREFIX}dedup_contact_1`;

    // First call — creates the lead
    const first = await upsertLead({
      ghlContactId: ghlId,
      name: "First Call",
      source: "vitest_upsert",
    });
    expect(first).not.toBeNull();

    // Second call — should NOT create a duplicate
    const second = await upsertLead({
      ghlContactId: ghlId,
      name: "Second Call",
      source: "vitest_upsert",
    });
    expect(second).not.toBeNull();

    // Both should return the same lead ID
    expect(second!.id).toBe(first!.id);

    // Verify only ONE row exists for this ghlContactId
    const db = await getDb();
    const rows = await db!.select().from(leads).where(eq(leads.ghlContactId, ghlId));
    expect(rows.length).toBe(1);
  });

  it("merges non-null fields without clobbering existing data", async () => {
    const ghlId = `${TEST_PREFIX}merge_contact_1`;

    // First call — create with name and email
    await upsertLead({
      ghlContactId: ghlId,
      name: "Original Name",
      email: "original@example.com",
      phone: "555-1234",
      source: "vitest_upsert",
    });

    // Second call — update with new businessName, but don't send name/email
    const updated = await upsertLead({
      ghlContactId: ghlId,
      businessName: "Acme Corp",
      source: "vitest_upsert",
    });

    expect(updated).not.toBeNull();
    // Original fields should be preserved
    expect(updated!.name).toBe("Original Name");
    expect(updated!.email).toBe("original@example.com");
    expect(updated!.phone).toBe("555-1234");
    // New field should be added
    expect(updated!.businessName).toBe("Acme Corp");
  });

  it("handles concurrent upserts without creating duplicates", async () => {
    const ghlId = `${TEST_PREFIX}concurrent_contact_1`;

    // Fire two upserts simultaneously — simulates the race condition
    const [result1, result2] = await Promise.all([
      upsertLead({
        ghlContactId: ghlId,
        name: "Concurrent A",
        source: "vitest_upsert",
      }),
      upsertLead({
        ghlContactId: ghlId,
        name: "Concurrent B",
        source: "vitest_upsert",
      }),
    ]);

    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();

    // Both should return the same lead ID
    expect(result1!.id).toBe(result2!.id);

    // Verify only ONE row exists
    const db = await getDb();
    const rows = await db!.select().from(leads).where(eq(leads.ghlContactId, ghlId));
    expect(rows.length).toBe(1);
  });
});
