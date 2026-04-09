/**
 * CENTRALIZED GHL PIPELINE STAGE IDS
 *
 * Single source of truth for all GHL pipeline and stage ID mappings.
 * Confirmed via GHL API on April 9, 2026.
 *
 * When new pipelines are added in GHL, update ONLY this file.
 */

// ─── Pipeline IDs ──────────────────────────────────────────────────────────

export const GHL_PIPELINES = {
  BULK_PRINTING: "OpojlMx3cTa0ts0e2pMc",
  T_SHIRT_INQUIRY: "5YIrCvKmzb27yXHP3fBF",
  T_SHIRT_PRINTING: "FgRa75sGUcw5lh0kPAwH",
  NEW_PIPELINE: "xyRhqslao3CnMQHJxLoy",
  FOLLOW_UP: "sOJmH5op75E4HgXpTonU",
  MARKETING: "DywhWMjMSu4VpCez1QPd",
} as const;

// ─── Stage IDs by Pipeline ─────────────────────────────────────────────────

/** "New Lead" stage IDs (one per pipeline) */
export const NEW_LEAD_STAGE_IDS = new Set([
  "69534612-6905-413a-a3b9-3c3de2365a6a", // Bulk Printing - New Lead
  "a54400ac-e9df-44e2-8872-45ccccf9a442", // 100 T-shirt Inquiry - New Lead
  "305eab1c-7e93-4fbc-b65b-0d3ae733c170", // 100 T-shirt Printing - New Lead
  "6f959956-f049-4847-b60a-37e568ce5877", // New pipeline - New Lead
  "1383c170-2c01-4a6a-a2be-a3a28201bda8", // Marketing - New Lead
]);

/** "Contacted" stage IDs keyed by pipeline ID */
export const CONTACTED_STAGE_IDS: Record<string, string> = {
  [GHL_PIPELINES.BULK_PRINTING]: "6dbcb373-9832-4c45-a5e6-176f92685f67",
  [GHL_PIPELINES.T_SHIRT_INQUIRY]: "6501f3bf-b2a9-4c0f-935f-fc8441f6deb0",
  [GHL_PIPELINES.T_SHIRT_PRINTING]: "c77cc672-e9df-4d9f-a4d9-518eda6979bf",
  [GHL_PIPELINES.NEW_PIPELINE]: "50ebf4df-0b37-4621-b9d8-1184ab8fbcef",
};

/** "Qualified" stage IDs keyed by pipeline ID */
export const QUALIFIED_STAGE_IDS: Record<string, string> = {
  [GHL_PIPELINES.BULK_PRINTING]: "dee13ae5-1db8-45aa-9f4a-33a6b271cb94",
  [GHL_PIPELINES.T_SHIRT_INQUIRY]: "45c2fc05-fe5f-4427-9523-f0f8ae000a39",
};

/** "Quote Sent" stage IDs keyed by pipeline ID */
export const QUOTE_SENT_STAGE_IDS: Record<string, string> = {
  [GHL_PIPELINES.BULK_PRINTING]: "d5ed2202-ffcc-4706-8cdc-5d7afba05ffd",
  [GHL_PIPELINES.T_SHIRT_INQUIRY]: "ea2093b5-3d71-4b00-aa3f-bcfda3d43012",
  [GHL_PIPELINES.NEW_PIPELINE]: "799debb9-4d5b-48b6-857a-8f8d1363c2c6",
};

/** "Paid - Proof Needed" stage IDs keyed by pipeline ID */
export const PAID_PROOF_NEEDED_STAGE_IDS: Record<string, string> = {
  [GHL_PIPELINES.BULK_PRINTING]: "32f1463d-1f48-4bef-8cd9-f1ff797d7907",
  [GHL_PIPELINES.T_SHIRT_INQUIRY]: "1ff090fe-8f51-45ea-898e-53f8fe94836e",
};

/** "Proof Sent" stage IDs keyed by pipeline ID */
export const PROOF_SENT_STAGE_IDS: Record<string, string> = {
  [GHL_PIPELINES.BULK_PRINTING]: "15207cd9-625c-4e69-bfe2-5abcad656f06",
  [GHL_PIPELINES.T_SHIRT_INQUIRY]: "83137df0-bfc3-4b71-96aa-3ee3d0ba4eee",
};

/** "Approved + Deposit" stage IDs keyed by pipeline ID */
export const APPROVED_STAGE_IDS: Record<string, string> = {
  [GHL_PIPELINES.BULK_PRINTING]: "a285af5e-3e5f-4b25-925a-baa0fe98c9e7",
  [GHL_PIPELINES.T_SHIRT_INQUIRY]: "7c74ae56-5803-4df6-9a03-042467c5a350",
};

/** "In Production" stage IDs keyed by pipeline ID */
export const IN_PRODUCTION_STAGE_IDS: Record<string, string> = {
  [GHL_PIPELINES.BULK_PRINTING]: "8922982e-eb03-47fa-96e2-200c1fa0a3a7",
  [GHL_PIPELINES.T_SHIRT_INQUIRY]: "2bd9c631-6914-413c-b228-bc2125ae35bd",
};

/** "Ready" stage IDs keyed by pipeline ID */
export const READY_STAGE_IDS: Record<string, string> = {
  [GHL_PIPELINES.BULK_PRINTING]: "076697f1-a054-4f82-a795-f0f38a4a56f7",
  [GHL_PIPELINES.T_SHIRT_INQUIRY]: "58b73824-41a3-45f1-bef5-6cb67303cecd",
};

/** "Delivered" / "Won" stage IDs keyed by pipeline ID */
export const DELIVERED_STAGE_IDS: Record<string, string> = {
  [GHL_PIPELINES.BULK_PRINTING]: "117d9332-7654-42bc-92de-829ae3be6337",
  [GHL_PIPELINES.T_SHIRT_INQUIRY]: "b3bec5e2-0b24-41fd-bbbc-fcf37b073e78",
};

/** "Not Qualified" stage IDs keyed by pipeline ID */
export const NOT_QUALIFIED_STAGE_IDS: Record<string, string> = {
  [GHL_PIPELINES.BULK_PRINTING]: "6f1ca442-4a6b-490f-bf49-95a5870f7f86",
  [GHL_PIPELINES.T_SHIRT_INQUIRY]: "6ca358e4-db09-4818-9896-ab21bad0c0e7",
};

// ─── "New pipeline" specific stages ────────────────────────────────────────

export const NEW_PIPELINE_STAGES = {
  REPLIED: "bbdbf48c-245d-452e-a00d-9c88260dff0c",
  ORDER_REQUESTED: "16b113e2-c766-453f-9b21-808f1254130e",
  PAYMENT_RECEIVED: "42979115-da6e-4ed5-8475-1c35d29cea7e",
  ORDER_CLOSED: "757ad143-8f4b-4b7e-bceb-23b9cc9fb46e",
} as const;

// ─── "100 T-shirt Printing" specific stages ────────────────────────────────

export const T_SHIRT_PRINTING_STAGES = {
  PROPOSAL_SENT: "5b1f61ce-7722-483e-81ba-7b2b65e5c0fe",
  CLOSED: "084cafc6-e09b-4e09-87b5-467aa2993395",
} as const;

// ─── Marketing Pipeline stages ─────────────────────────────────────────────

export const MARKETING_STAGES = {
  NEW_LEAD: "1383c170-2c01-4a6a-a2be-a3a28201bda8",
  HOT_LEAD: "bbd7b72a-3941-4c70-a382-8bd9ffb1e11d",
  NEW_BOOKING: "351e93ff-da50-4859-b17b-7e424a88ea5b",
  VISIT_ATTENDED: "c068000c-c921-4305-98b1-3543327882f8",
  SALE: "21303a4a-0145-4465-b47c-9ff61b242e37",
  LEFT_A_REVIEW: "ed6ec388-bfd4-4977-b9cd-890fa9f7e18d",
} as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Get the "Not Qualified" stage ID for a given pipeline.
 * Returns null if the pipeline is unknown.
 */
export function getNqStageId(pipelineId: string | null | undefined): string | null {
  if (!pipelineId) return null;
  return NOT_QUALIFIED_STAGE_IDS[pipelineId] || null;
}

/**
 * Get the "Contacted" stage ID for a given pipeline.
 * Returns null if the pipeline is unknown.
 */
export function getContactedStageId(pipelineId: string | null | undefined): string | null {
  if (!pipelineId) return null;
  return CONTACTED_STAGE_IDS[pipelineId] || null;
}

/**
 * Get the "Qualified" stage ID for a given pipeline.
 * Returns null if the pipeline is unknown.
 */
export function getQualifiedStageId(pipelineId: string | null | undefined): string | null {
  if (!pipelineId) return null;
  return QUALIFIED_STAGE_IDS[pipelineId] || null;
}

/**
 * Get the "Delivered" / "Won" stage ID for a given pipeline.
 * Returns null if the pipeline is unknown.
 */
export function getDeliveredStageId(pipelineId: string | null | undefined): string | null {
  if (!pipelineId) return null;
  return DELIVERED_STAGE_IDS[pipelineId] || null;
}

/**
 * Get any stage ID by pipeline and stage name.
 * Useful for dynamic lookups.
 */
export function getStageId(pipelineId: string, stageName: string): string | null {
  const stageMap: Record<string, Record<string, string>> = {
    "New Lead": Object.fromEntries(
      Array.from(NEW_LEAD_STAGE_IDS).map((id, i) => {
        const pipelines = [GHL_PIPELINES.BULK_PRINTING, GHL_PIPELINES.T_SHIRT_INQUIRY, GHL_PIPELINES.T_SHIRT_PRINTING, GHL_PIPELINES.NEW_PIPELINE, GHL_PIPELINES.MARKETING];
        return [pipelines[i], id];
      })
    ),
    "Contacted": CONTACTED_STAGE_IDS,
    "Qualified": QUALIFIED_STAGE_IDS,
    "Quote Sent": QUOTE_SENT_STAGE_IDS,
    "Paid - Proof Needed": PAID_PROOF_NEEDED_STAGE_IDS,
    "Proof Sent": PROOF_SENT_STAGE_IDS,
    "Approved + Deposit": APPROVED_STAGE_IDS,
    "In Production": IN_PRODUCTION_STAGE_IDS,
    "Ready": READY_STAGE_IDS,
    "Delivered": DELIVERED_STAGE_IDS,
    "Not Qualified": NOT_QUALIFIED_STAGE_IDS,
  };

  const normalizedName = Object.keys(stageMap).find(
    k => k.toLowerCase() === stageName.toLowerCase()
  );
  if (!normalizedName) return null;
  return stageMap[normalizedName][pipelineId] || null;
}
