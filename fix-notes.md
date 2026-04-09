# Scheduling Architecture Fix — Implementation Notes

## Fix 4: 30-Day Max Cap + Long-Lead Sequence

### Changes needed:
1. **scheduling-engine.ts**: Add `MAX_FOLLOWUP_DELAY_MS = 30 * 24 * 60 * 60 * 1000` constant
2. **scheduling-engine.ts**: Enforce cap in `calculateNextFollowUp()` — clamp all results
3. **scheduling-engine.ts**: The silence cadence at position 5 returns 720h (30 days) and 1440h (60 days) — these need capping
4. **scheduling-engine.ts**: Customer timeline P1 can schedule 60 days before a 90+ day event — this is the long-lead exception
5. **stage-playbook.ts**: Add long-lead sequence guidance to relevant stages (New Lead, Contacted, Qualified)
6. **strategist.ts / composer.ts**: Stage playbook injection already works — just need to add long-lead content to playbook

### Long-Lead Architecture:
- Customer-stated timeline (P1) is the ONLY path that can exceed 30 days
- P1 already has graduated touchpoint logic (60d before, 30d before, 14d before, etc.)
- The cap should apply to P3 (silence cadence), P4 (age+score), P5 (stage events), and fallback
- P1 is exempt because it's driven by actual customer-stated event dates

## Fix 2: 24hr humanTakeover Timeout + Multi-Channel

### Changes needed:
1. **ghl.ts**: Change `AGENT_TAKEOVER_WINDOW_MS` from 2hr → 24hr in send gate
2. **webhook-message.ts**: Change attachment handler window from 2hr → 24hr (line 64)
3. **lead-disposition.ts**: Change stale takeover threshold from 7 days → 24hr
4. **scheduling-engine.ts**: Already uses 24hr in humanTakeover check — GOOD
5. **stage-playbook.ts**: Add "human-assisted support role" guidance
6. **New logic**: When humanTakeover=1 AND agent active on channel X, AI can use OTHER channels for general info/nurture (not re-pitching)

### Multi-Channel Support Role:
- Need new field or logic to track WHICH channel the agent is active on
- AI can send on other channels but in "support role" mode (general info, not sales pitch)
- Strategist/Composer need training for this mode
- After 24hr with no agent activity on ANY channel → full AI re-engagement

## Fix 3: Hourly Overdue Catch-Up

### Changes needed:
1. **follow-up-trigger.ts**: Already has `processOverdueFollowUps()` — runs every 10min with MAX_PER_CYCLE=10
2. **New**: Add dedicated `processOverdueCatchUp()` that runs every 60min with batch of 20
3. **webhooks.ts**: Wire the hourly timer
4. The existing 10-min timer handles normal drip; the hourly timer catches leads that fell through cracks

### Key difference from existing follow-up trigger:
- Existing: processes leads where nextFollowUpAt <= NOW() (normal drip)
- Overdue catch-up: specifically targets leads where nextFollowUpAt is SIGNIFICANTLY past (e.g., > 1 hour overdue)
- This prevents double-processing with the normal 10-min timer

## Fix 1: Compress Schedule (One-Time Migration)

### Changes needed:
1. **New**: `compressSchedule()` function in scheduling-engine.ts
2. Query all leads with nextFollowUpAt > now + 30 days
3. Redistribute across next 7-14 days, staggered 50-100/day
4. Preserve relative ordering
5. Admin tRPC endpoint to trigger manually
