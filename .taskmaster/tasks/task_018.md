# Task ID: 18

**Title:** Phase 3: Pre-Delete Extractions (signal-patterns.ts)

**Status:** pending

**Dependencies:** 17

**Priority:** high

**Description:** Before any deletes: create signal-patterns.ts (confusion/wrong-business/negative-sentiment regex arrays extracted from auto-correction.ts). Update imports.

**Details:**

Extract CONFUSION_PATTERNS, WRONG_BUSINESS_PATTERNS, NEGATIVE_SENTIMENT_PATTERNS from auto-correction.ts into signal-patterns.ts. Update all files that import from strategist.ts, error-memory.ts, skill-registry.ts to import from lead-utils.ts instead. Run tsc --noEmit to confirm 0 errors BEFORE proceeding to deletes.

**Test Strategy:**

Verify signal-patterns.ts has all regex patterns from auto-correction.ts. Verify tsc --noEmit passes with 0 errors. Verify no imports reference files about to be deleted.
