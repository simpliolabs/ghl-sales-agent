# SMS Cold Opener Length — Root Cause Analysis

## Problem
Carolyn Culver got a 4-paragraph SMS cold opener. Should be 2-3 sentences max.

## Root Cause — Multiple Gaps

### 1. Composer Prompt (composer.ts line 97)
Says: "SMS: 1-3 sentences max, plain text, no signature needed"
BUT: This is a soft rule buried in a massive prompt. No HARD CONSTRAINT enforcement.
The HARD CONSTRAINTS section (lines 25-72) has 7 rules but NONE about SMS length.

### 2. QC Gate (qc.ts line 112-115)
LENGTH CHECK says: "SMS: 1-3 sentences. Score 0 if more than 4 sentences."
BUT: Score 0 on ONE check out of 17 (each worth 10 points) = -10 from 170 max.
That's only ~6% penalty. A message scoring 8-10 on all other checks still passes
at 160/170 = 94%. The 4-sentence SMS PASSES QC easily.

### 3. No Hard Reject for SMS Length
QC has 7 auto-reject rules (lines 42-88) but NONE for SMS exceeding 3 sentences.
A 4-paragraph SMS with good content, correct facts, and proper CTA will always pass.

### 4. Strategist maxLength
The Strategist sets `maxLength` (line 350) but it's a free-form number with no
channel-specific guidance. The Strategist can set maxLength=500 for an SMS.

### 5. Legacy ai-brain.ts Had It Right
The old system had: "Keep your response to 2-3 sentences MAX" as a CRITICAL
contextPrompt injection for first responses. The Brain Council lost this.

## Fix Plan
1. Add SMS length HARD CONSTRAINT to Composer prompt (HARD CONSTRAINTS section)
2. Add SMS length AUTO-REJECT to QC (auto-reject rules section)
3. Add programmatic character count check in brain-council-orchestrator.ts
   BEFORE sending — if SMS > 320 chars, force QC to reject or truncate
4. Add first_contact + SMS specific guidance: "2 sentences max for cold SMS"
