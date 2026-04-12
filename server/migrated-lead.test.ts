import { describe, it, expect } from "vitest";
import { isMigratedEmailOnly, enforceMigratedChannel, MIGRATED_SOURCE } from "./webhook-helpers";

describe("Migrated Lead Channel Restriction", () => {
  // --- isMigratedEmailOnly ---
  describe("isMigratedEmailOnly", () => {
    it("returns true for a transferred_contact with new_lead state and not reactivated", () => {
      expect(isMigratedEmailOnly({
        source: MIGRATED_SOURCE,
        convState: "new_lead",
        lastMessageAt: null,
        reactivatedFromMigration: 0,
      })).toBe(true);
    });

    it("returns true for a transferred_contact with null convState (defaults to new_lead)", () => {
      expect(isMigratedEmailOnly({
        source: MIGRATED_SOURCE,
        convState: null,
        lastMessageAt: null,
        reactivatedFromMigration: null,
      })).toBe(true);
    });

    it("returns false for a non-migrated lead", () => {
      expect(isMigratedEmailOnly({
        source: "fb_form",
        convState: "new_lead",
        lastMessageAt: null,
        reactivatedFromMigration: 0,
      })).toBe(false);
    });

    it("returns false for a migrated lead that has been explicitly reactivated", () => {
      expect(isMigratedEmailOnly({
        source: MIGRATED_SOURCE,
        convState: "new_lead",
        lastMessageAt: new Date(),
        reactivatedFromMigration: 1,
      })).toBe(false);
    });

    it("returns false for a migrated lead that has progressed beyond new_lead", () => {
      expect(isMigratedEmailOnly({
        source: MIGRATED_SOURCE,
        convState: "exploring",
        lastMessageAt: null,
        reactivatedFromMigration: 0,
      })).toBe(false);
    });

    it("returns false for a migrated lead in 'interested' state", () => {
      expect(isMigratedEmailOnly({
        source: MIGRATED_SOURCE,
        convState: "interested",
        lastMessageAt: null,
        reactivatedFromMigration: 0,
      })).toBe(false);
    });

    it("returns false for a migrated lead in 'committed' state", () => {
      expect(isMigratedEmailOnly({
        source: MIGRATED_SOURCE,
        convState: "committed",
        lastMessageAt: null,
        reactivatedFromMigration: 0,
      })).toBe(false);
    });

    it("returns false when source is null", () => {
      expect(isMigratedEmailOnly({
        source: null,
        convState: "new_lead",
        lastMessageAt: null,
        reactivatedFromMigration: 0,
      })).toBe(false);
    });
  });

  // --- enforceMigratedChannel ---
  describe("enforceMigratedChannel", () => {
    const migratedLead = {
      source: MIGRATED_SOURCE,
      convState: "new_lead",
      lastMessageAt: null,
      reactivatedFromMigration: 0,
    };

    const normalLead = {
      source: "fb_form",
      convState: "new_lead",
      lastMessageAt: null,
      reactivatedFromMigration: 0,
    };

    const reactivatedMigratedLead = {
      source: MIGRATED_SOURCE,
      convState: "new_lead",
      lastMessageAt: new Date(),
      reactivatedFromMigration: 1,
    };

    it("forces SMS to Email for migrated leads", () => {
      expect(enforceMigratedChannel(migratedLead, "SMS")).toBe("Email");
    });

    it("forces WhatsApp to Email for migrated leads", () => {
      expect(enforceMigratedChannel(migratedLead, "WhatsApp")).toBe("Email");
    });

    it("forces FB to Email for migrated leads", () => {
      expect(enforceMigratedChannel(migratedLead, "FB")).toBe("Email");
    });

    it("keeps Email as Email for migrated leads", () => {
      expect(enforceMigratedChannel(migratedLead, "Email")).toBe("Email");
    });

    it("does NOT force channel for non-migrated leads", () => {
      expect(enforceMigratedChannel(normalLead, "SMS")).toBe("SMS");
      expect(enforceMigratedChannel(normalLead, "WhatsApp")).toBe("WhatsApp");
      expect(enforceMigratedChannel(normalLead, "FB")).toBe("FB");
    });

    it("does NOT force channel for reactivated migrated leads", () => {
      expect(enforceMigratedChannel(reactivatedMigratedLead, "SMS")).toBe("SMS");
      expect(enforceMigratedChannel(reactivatedMigratedLead, "WhatsApp")).toBe("WhatsApp");
    });
  });

  // --- MIGRATED_SOURCE constant ---
  describe("MIGRATED_SOURCE", () => {
    it("equals 'transferred_contact'", () => {
      expect(MIGRATED_SOURCE).toBe("transferred_contact");
    });
  });
});
