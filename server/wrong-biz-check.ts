/**
 * wrong-biz-check.ts — Phase 5 wrong-business reference detection
 *
 * Extracted from outbox-worker.ts commit 60c810cb (Phase 5, May 17 2026).
 * Original: post-send check in Brain Council path (P5.10).
 * Restored: called from outbox-worker.ts Path B after composeAndSend returns "sent".
 */

// Verbatim patterns from commit 60c810cb — do not modify without Phase 5 review
const WRONG_BIZ_PATTERNS: RegExp[] = [
  /\b(vistaprint|custom\s?ink|zazzle|printful|printify|canva|spreadshirt|teespring|bonfire)\b/i,
  /\b(chick-?fil-?a|mcdonald'?s|starbucks|walmart|target|amazon)\b/i,
];

export interface WrongBizCheckResult {
  matched: boolean;
  pattern?: string;
}

export function checkWrongBusinessPattern(message: string): WrongBizCheckResult {
  if (!message) return { matched: false };
  const match = WRONG_BIZ_PATTERNS.find(p => p.test(message));
  return match ? { matched: true, pattern: match.source } : { matched: false };
}
