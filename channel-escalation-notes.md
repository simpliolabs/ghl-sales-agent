# Channel Escalation Fix — Root Cause Analysis

## Problem
Sarah Weiss got 5+ SMS with zero replies. System never switched to Email.

## Root Cause
`selectChannel()` in scheduling-engine.ts has a hard SMS bias:
- cadencePosition 0-2: use primary (but override Email→SMS if phone exists)
- cadencePosition 3: stay on SMS
- cadencePosition 4-5: SMS if phone, else Email
- cadencePosition 6+: SMS if phone, else Email

The function has NO awareness of `consecutiveUnanswered` — it only knows `cadencePosition`.
And `cadencePosition` is set by `calculateSilenceCadence()` based on days since last outbound,
NOT on how many messages went unanswered.

## Data Available
- `consecutiveUnanswered` is already computed in `calculateNextFollowUp()` (line 595)
- `convHistory` has `.channel` field on each message — can count per-channel unanswered
- Lead has `dndSms`, `dndEmail`, `dndFb`, `dndWhatsapp` fields
- Lead has `phone`, `email` fields

## Fix Plan
1. Add `consecutiveUnanswered` parameter to `selectChannel()`
2. Add `dndSms` and `dndEmail` parameters (to avoid escalating to a blocked channel)
3. New rules:
   - SMS lead with 3+ unanswered → switch to Email (if email available + not DND)
   - Email lead with 2+ unanswered → switch to SMS (if phone available + not DND)
   - At cadencePosition 5+ (deep dormancy): always try alternate channel
4. Update all 4 call sites of `selectChannel()` to pass the new params
5. Count per-channel consecutive unanswered (not just total) for more precise escalation
