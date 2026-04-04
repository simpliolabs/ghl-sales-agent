import { describe, it, expect } from "vitest";

describe("GHL API Key Validation", () => {
  it("should authenticate with the GHL contacts endpoint", async () => {
    const GHL_API_KEY = process.env.GHL_API_KEY;
    const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

    expect(GHL_API_KEY).toBeTruthy();
    expect(GHL_LOCATION_ID).toBeTruthy();

    const res = await fetch(
      `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&limit=1`,
      {
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          Version: "2021-07-28",
        },
      }
    );

    const data = await res.json();
    // Should NOT get 401 unauthorized
    expect(data.statusCode).not.toBe(401);
    // Should have contacts array (even if empty)
    expect(data.contacts).toBeDefined();
  });
});
