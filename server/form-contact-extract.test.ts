/**
 * Tests for extractContactFieldsFromFormData — ensures form-submitted
 * email, phone, name, and businessName are correctly extracted and mapped
 * to canonical lead fields.
 */

import { describe, expect, it } from "vitest";
import { extractContactFieldsFromFormData } from "./webhook-helpers";

describe("extractContactFieldsFromFormData", () => {
  it("extracts email from form data with 'Email' label", () => {
    const fields = [
      { label: "Email", value: "jromeb26@gmail.com" },
      { label: "Product Type", value: "T-shirts" },
    ];
    const result = extractContactFieldsFromFormData(fields);
    expect(result.email).toBe("jromeb26@gmail.com");
    expect(result).not.toHaveProperty("phone");
  });

  it("extracts phone from form data with 'Phone' label", () => {
    const fields = [
      { label: "Phone", value: "(804) 955-8201" },
      { label: "Purpose", value: "Sports Team" },
    ];
    const result = extractContactFieldsFromFormData(fields);
    expect(result.phone).toBe("(804) 955-8201");
  });

  it("extracts all contact fields from a full Facebook form submission", () => {
    const fields = [
      { label: "Company", value: "Evergreen Athletic Association" },
      { label: "Timeline", value: "This month" },
      { label: "Product Type", value: "T-shirts" },
      { label: "Email", value: "jromeb26@gmail.com" },
      { label: "Full Name", value: "Jerome Booker" },
      { label: "Phone", value: "(804) 955-8201" },
      { label: "Purpose", value: "Sports Team" },
    ];
    const result = extractContactFieldsFromFormData(fields);
    expect(result.email).toBe("jromeb26@gmail.com");
    expect(result.phone).toBe("(804) 955-8201");
    expect(result.name).toBe("Jerome Booker");
    expect(result.businessName).toBe("Evergreen Athletic Association");
  });

  it("rejects invalid email (no @ sign)", () => {
    const fields = [{ label: "Email", value: "not-an-email" }];
    const result = extractContactFieldsFromFormData(fields);
    expect(result).not.toHaveProperty("email");
  });

  it("rejects invalid phone (too few digits)", () => {
    const fields = [{ label: "Phone", value: "123" }];
    const result = extractContactFieldsFromFormData(fields);
    expect(result).not.toHaveProperty("phone");
  });

  it("handles empty form data gracefully", () => {
    const result = extractContactFieldsFromFormData([]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("handles alternate label formats (case-insensitive)", () => {
    const fields = [
      { label: "EMAIL ADDRESS", value: "test@example.com" },
      { label: "PHONE NUMBER", value: "555-123-4567" },
    ];
    const result = extractContactFieldsFromFormData(fields);
    expect(result.email).toBe("test@example.com");
    expect(result.phone).toBe("555-123-4567");
  });

  it("does not extract non-contact fields", () => {
    const fields = [
      { label: "Product Type", value: "T-shirts" },
      { label: "Timeline", value: "ASAP" },
      { label: "Purpose", value: "Fundraiser" },
    ];
    const result = extractContactFieldsFromFormData(fields);
    expect(Object.keys(result)).toHaveLength(0);
  });
});
