/**
 * Tests for Fix 12:
 * 1. HARD GATE 1 source filter — 'ghl', 'Facebook', 'fb' are no longer blocked
 * 2. findExistingLeadByIdentity — dedup by email/phone across different ghlContactIds
 * 3. Lookback engine HARD GATE 1 — same fix applied there
 */

import { describe, expect, it, afterAll } from "vitest";
import { upsertLead, getLeadsDueForFollowUp, findExistingLeadByIdentity, getDb, updateLeadFields } from "./db";
import { leads } from "../drizzle/schema";
import { eq, sql } from "drizzle-orm";

const TEST_PREFIX = `fix12_${Date.now()}_`;

async function cleanupTestLeads() {
  const db = await getDb();
  if (!db) return;
  await db.delete(leads).where(eq(leads.source, "vitest_fix12"));
  await db.delete(leads).where(eq(leads.source, "vitest_fix12_ghl"));
  await db.delete(leads).where(eq(leads.source, "vitest_fix12_fb"));
}

afterAll(async () => {
  await cleanupTestLeads();
});

describe("Fix 12 — HARD GATE 1: source filter no longer blocks ghl/Facebook/fb", () => {
  it("lead with source='ghl' and reactivatedFromMigration=0 IS included in follow-ups", async () => {
    const ghlId = `${TEST_PREFIX}ghl_source_1`;
    const lead = await upsertLead({
      ghlContactId: ghlId,
      name: "GHL Source Lead",
      email: "ghl-source@test.com",
      phone: "555-0001",
      source: "vitest_fix12_ghl",
    });
    expect(lead).not.toBeNull();

    // Set nextFollowUpAt to the past so it's due
    await updateLeadFields(lead!.id, {
      nextFollowUpAt: new Date(Date.now() - 60_000),
      humanTakeover: 0,
      pipelineStage: "new_lead",
    });

    // Override source to 'ghl' directly in DB (upsert may have set it differently)
    const db = await getDb();
    await db!.update(leads).set({ source: "ghl" }).where(eq(leads.id, lead!.id));

    const dueLeads = await getLeadsDueForFollowUp();
    const found = dueLeads.find((l: any) => l.id === lead!.id);
    expect(found).toBeDefined();
  });

  it("lead with source='transferred_contact' and reactivatedFromMigration=0 is STILL blocked", async () => {
    const ghlId = `${TEST_PREFIX}transferred_source_1`;
    const lead = await upsertLead({
      ghlContactId: ghlId,
      name: "Transferred Lead",
      email: "transferred@test.com",
      source: "vitest_fix12",
    });
    expect(lead).not.toBeNull();

    // Set nextFollowUpAt to the past and source to transferred_contact
    await updateLeadFields(lead!.id, {
      nextFollowUpAt: new Date(Date.now() - 60_000),
      humanTakeover: 0,
      pipelineStage: "new_lead",
    });
    const db = await getDb();
    await db!.update(leads).set({ source: "transferred_contact", reactivatedFromMigration: 0 }).where(eq(leads.id, lead!.id));

    const dueLeads = await getLeadsDueForFollowUp();
    const found = dueLeads.find((l: any) => l.id === lead!.id);
    expect(found).toBeUndefined(); // Should NOT be in the list
  });

  it("lead with source='transferred_contact' and reactivatedFromMigration=1 IS included", async () => {
    const ghlId = `${TEST_PREFIX}reactivated_1`;
    const lead = await upsertLead({
      ghlContactId: ghlId,
      name: "Reactivated Lead",
      email: "reactivated@test.com",
      source: "vitest_fix12",
    });
    expect(lead).not.toBeNull();

    await updateLeadFields(lead!.id, {
      nextFollowUpAt: new Date(Date.now() - 60_000),
      humanTakeover: 0,
      pipelineStage: "new_lead",
    });
    const db = await getDb();
    await db!.update(leads).set({ source: "transferred_contact", reactivatedFromMigration: 1 }).where(eq(leads.id, lead!.id));

    const dueLeads = await getLeadsDueForFollowUp();
    const found = dueLeads.find((l: any) => l.id === lead!.id);
    expect(found).toBeDefined();
  });
});

describe("Fix 12 — findExistingLeadByIdentity: dedup by email/phone", () => {
  it("finds an existing lead by email when ghlContactId differs", async () => {
    const ghlId1 = `${TEST_PREFIX}dedup_email_A`;
    const ghlId2 = `${TEST_PREFIX}dedup_email_B`;

    // Create the canonical lead
    const lead1 = await upsertLead({
      ghlContactId: ghlId1,
      name: "Canonical Lead",
      email: `dedup-${TEST_PREFIX}@test.com`,
      source: "vitest_fix12",
    });
    expect(lead1).not.toBeNull();

    // Now search for a lead with the same email but different ghlContactId
    const found = await findExistingLeadByIdentity(
      `dedup-${TEST_PREFIX}@test.com`,
      null,
      ghlId2,
    );
    expect(found).not.toBeNull();
    expect(found!.id).toBe(lead1!.id);
    expect(found!.ghlContactId).toBe(ghlId1);
  });

  it("finds an existing lead by phone when ghlContactId differs", async () => {
    const ghlId1 = `${TEST_PREFIX}dedup_phone_A`;
    const ghlId2 = `${TEST_PREFIX}dedup_phone_B`;
    const uniquePhone = `555-${Date.now()}`;

    const lead1 = await upsertLead({
      ghlContactId: ghlId1,
      name: "Phone Lead",
      phone: uniquePhone,
      source: "vitest_fix12",
    });
    expect(lead1).not.toBeNull();

    const found = await findExistingLeadByIdentity(
      null,
      uniquePhone,
      ghlId2,
    );
    expect(found).not.toBeNull();
    expect(found!.id).toBe(lead1!.id);
  });

  it("does NOT find a lead when the ghlContactId matches (same lead, not a duplicate)", async () => {
    const ghlId = `${TEST_PREFIX}dedup_same_1`;

    const lead = await upsertLead({
      ghlContactId: ghlId,
      name: "Same Lead",
      email: `same-${TEST_PREFIX}@test.com`,
      source: "vitest_fix12",
    });
    expect(lead).not.toBeNull();

    // Search with the SAME ghlContactId — should return null (not a duplicate)
    const found = await findExistingLeadByIdentity(
      `same-${TEST_PREFIX}@test.com`,
      null,
      ghlId,
    );
    expect(found).toBeNull();
  });

  it("returns null when no email or phone is provided", async () => {
    const found = await findExistingLeadByIdentity(null, null, "some_id");
    expect(found).toBeNull();
  });

  it("returns the OLDEST lead (lowest ID) when multiple matches exist", async () => {
    const ghlId1 = `${TEST_PREFIX}dedup_oldest_A`;
    const ghlId2 = `${TEST_PREFIX}dedup_oldest_B`;
    const ghlId3 = `${TEST_PREFIX}dedup_oldest_C`;
    const sharedEmail = `oldest-${TEST_PREFIX}@test.com`;

    // Create two leads with the same email but different ghlContactIds
    const lead1 = await upsertLead({
      ghlContactId: ghlId1,
      email: sharedEmail,
      source: "vitest_fix12",
    });
    const lead2 = await upsertLead({
      ghlContactId: ghlId2,
      email: sharedEmail,
      source: "vitest_fix12",
    });
    expect(lead1).not.toBeNull();
    expect(lead2).not.toBeNull();

    // Search from a third ghlContactId — should find lead1 (oldest)
    const found = await findExistingLeadByIdentity(sharedEmail, null, ghlId3);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(lead1!.id);
  });
});
