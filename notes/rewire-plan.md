# Webhook Rewire Plan

## Brain Council Output Shape (used by webhook-message.ts)

The downstream code after `runBrainCouncil()` uses these fields:
- `aiResponse.message` — the composed message text
- `aiResponse.channel` — recommended send channel
- `aiResponse.fromName` — sender name for email
- `aiResponse.subject` — email subject
- `aiResponse.blocked` — whether to abort
- `aiResponse.blockReason` — why it was blocked
- `aiResponse.violationCategory` — for post-send validation
- `aiResponse.fallbackUsed` — whether fallback was used
- `aiResponse.fallbackMessage` — the fallback text
- `aiResponse.qcScore` — quality score
- `aiResponse.score` — opportunity/priority score
- `aiResponse.segment` — lead segment
- `aiResponse.angle` — approach angle used
- `aiResponse.framework` — framework used
- `aiResponse.nextEngagementHours` — suggested follow-up timing
- `aiResponse.strategyReasoning` — reasoning text
- `aiResponse.extractedDates` — any dates extracted
- `aiResponse.fromName` — sender name

## Pre-flight Checks in Brain Council Orchestrator (MUST preserve)

1. **AI offline check** — `isAiOffline()` → abort
2. **DB lock** — prevent concurrent Brain Council runs for same lead
3. **humanTakeover check** — if lead.humanTakeover=1, abort
4. **DND channel check** — `isChannelDnd(leadId, channel)` → abort
5. **Already responded** — AI outbound in last 90 seconds → abort (skip for inbound replies)
6. **Circuit breaker** — consecutive failures → set humanTakeover, abort

## Strategy: Adapter Pattern

Instead of rewriting the entire downstream code (which uses many Brain Council fields),
create an adapter that:
1. Runs the pre-flight checks (extracted from orchestrator)
2. Calls `runSingleBrain()`
3. Maps the SingleBrainOutput to the BrainCouncilOutput shape

This way:
- webhook-message.ts and webhook-contact.ts need minimal changes (just swap the import)
- All pre-flight safety checks are preserved
- The output shape stays compatible with all downstream code
- We can delete the orchestrator later once everything is verified
