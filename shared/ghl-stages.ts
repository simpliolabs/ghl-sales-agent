/**
 * CENTRALIZED GHL PIPELINE STAGE IDS
 *
 * Single source of truth for all GHL pipeline and stage ID mappings.
 * Previously duplicated in 5+ files (brain-council-orchestrator, follow-up-trigger,
 * webhook-contact, lead-disposition, etc.).
 *
 * When new pipelines are added in GHL, update ONLY this file.
 */

// ─── Pipeline IDs ──────────────────────────────────────────────────────────

export const GHL_PIPELINES = {
  BULK_PRINTING: "OpojlMx3cTa0ts0e2pMc",
  T_SHIRT_INQUIRY: "5YIrCvKmzb27yXHP3fBF",
  T_SHIRT_PRINTING: "FgRa75sGUcw5lh0kPAwH",
  NEW_PIPELINE: "xyRhqslao3CnMQHJxLoy",
} as const;

// ─── Stage IDs by Pipeline ─────────────────────────────────────────────────

/** "New Lead" stage IDs (one per pipeline) */
export const NEW_LEAD_STAGE_IDS = new Set([
  "69534612-6905-413a-a3b9-3c3de2365a6a", // Bulk Printing - New Lead
  "a54400ac-e9df-44e2-8872-45ccccf9a442", // 100 T-shirt Inquiry - New Lead
  "305eab1c-7e93-4fbc-b65b-0d3ae733c170", // 100 T-shirt Printing - New Lead
  "6f959956-f049-4847-b60a-37e568ce5877", // New pipeline - New Lead
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
  [GHL_PIPELINES.BULK_PRINTING]: "c3b3e7a1-8d4f-4b2a-9e6c-1a2b3c4d5e6f", // Placeholder — needs real ID
  [GHL_PIPELINES.T_SHIRT_INQUIRY]: "d4c4f8b2-9e5g-5c3b-af7d-2b3c4d5e6f7g", // Placeholder — needs real ID
};

/** "Not Qualified" stage IDs keyed by pipeline ID */
export const NOT_QUALIFIED_STAGE_IDS: Record<string, string> = {
  [GHL_PIPELINES.BULK_PRINTING]: "6f1ca442-4a6b-490f-bf49-95a5870f7f86",
  [GHL_PIPELINES.T_SHIRT_INQUIRY]: "6ca358e4-db09-4818-9896-ab21bad0c0e7",
};

/** "Won" / "Delivered" stage IDs keyed by pipeline ID */
export const WON_STAGE_IDS: Record<string, string> = {
  // These will be populated when we confirm the exact GHL stage IDs
  // For now, the pipeline handler uses STAGES.DELIVERED which is name-based
};

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
