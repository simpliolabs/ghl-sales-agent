# Adorb Outreach System — Master Reverse-Engineering Spec

**Version:** 1.0 (Consolidated)
**Repo:** `simpliolabs/ghl-sales-agent`
**Manus Project:** `adorb-outreach` · Checkpoint: `ad5e537e`
**Date:** May 16, 2026

---

## Executive Summary

**From:** 30,552 lines · 7 brains · 47 rules · 20 timers · 19.6% AI participation
**To:** ~8,000–10,000 lines · 1 brain · 5 rules · 11 timers · deal-closing · self-learning

This document is the single source of truth for the complete reverse-engineering of the Adorb Outreach System. It consolidates the original 6-phase engineering path, all 14 amendments, 5 gap fixes, and all clarifications into one buildable spec.

---

## Architecture Map: Before and After

```
BEFORE (current)
GHL Webhook → webhook handler → Brain Council Orchestrator
                                    │
                    ┌───────────────┼───────────────────────┐
                    ▼               ▼                       ▼
               Strategist      Researcher              [7 pre-flight gates]
                    │               │
                    ▼               ▼
               Composer ←──── [9 programmatic overrides]
                    │
                    ▼
                QC Brain
                    │
                    ▼
             Expert Panel (Brand + Conversion + Compliance)
                    │
                    ▼
                  Send
                    
+ 20 background timers all targeting the same leads independently
+ 47 hard rules spread across 6+ files
+ 90s cooldown + daily cap + processing lock + dedup lock fighting each other

─────────────────────────────────────────────────────────────────────

AFTER (target)
GHL Webhook → webhook handler → OUTBOX (idempotent enqueue)
                                    │
                     [All 4 senders enqueue here. One worker drains it.]
                                    │
                    ┌───────────────▼───────────────────────┐
                    │         OUTBOX WORKER                 │
                    │  1. Claim lead (atomic)               │
                    │  2. Run 5 hard guards (TypeScript)    │
                    │  3. Call single brain (1-2 LLM calls) │
                    │  4. Run 5 output guards (TypeScript)  │
                    │  5. Send via GHL                      │
                    │  6. Log decision + release            │
                    └───────────────────────────────────────┘
                    
+ 11 background timers (all enqueue into outbox, never send directly)
+ 5 hard rules enforced by TypeScript middleware, not LLM
+ Quote / appointment / payment as tool calls inside the single brain
+ LoRA fine-tuning flywheel (weekly self-improvement)
+ Confusion detection + post-send review (self-repair)
```

---

## Phase 0 — Emergency Relief (Day 1–2, no architecture change)

Config and parameter changes only. Deploy as a single PR. Fully reversible.

### 0.1 Disable 12 of 20 timers via feature flag

In `webhooks.ts` (timer hub), wrap these in `if (process.env.DISABLE_LEGACY_TIMERS !== 'true')`:

| Timer to disable | File | Reason |
|---|---|---|
| Brain Council Self-Review (30 min) | `brain-council-review.ts` | Replaced by outbox |
| Retroactive Correction Scan (15 min) | `auto-correction.ts` | Single brain won't need post-hoc correction |
| Lookback Drip (30 min) | `lookback-engine.ts` | Replaced by vector similarity in Phase 5 |
| Event-Driven Triggers (30 min) | `event-driven-triggers.ts` | Simplify in Phase 3 |
| Stale Schedule Recalculation (1 hr) | `scheduling-engine.ts` | Rebuild in Phase 3 |
| Overdue Catch-Up (1 hr) | `follow-up-trigger.ts` | Merge into Follow-Up Trigger |
| Learning Promotion Scan (2 hr) | `learning-loop.ts` | Rebuild in Phase 5 |
| Weekly Monday Review (6 hr) | `ab-testing.ts` + `auto-skill-hunter.ts` | Deleted in Phase 3 |
| Seasonal Campaign Executor (2 hr) | `seasonal-campaign-executor.ts` | Re-enable after Phase 3 |
| Supervisor (5 min) | `supervisor.ts` | Outbox worker replaces invariant enforcement |
| SLA Timer (30 min) | `sla-timer.ts` | Re-enable after Phase 3 |
| Post-Delivery Executor (30 min) | `post-delivery-executor.ts` | Re-enable after Phase 4 |

Set `DISABLE_LEGACY_TIMERS=true` in server env. Keep the remaining 8 timers running.

### 0.2 Parameter changes in existing code

```typescript
// brain-council-orchestrator.ts
DB_SEND_COOLDOWN_MS = 90_000 → 30_000     // less false-blocking on fast convos
PROCESSING_LOCK_TTL_MS = 300_000 → 60_000  // 5 min → 1 min stuck lock
DAILY_PROACTIVE_CAP = 1 → 3               // for leads with score >= 80
HUMAN_TAKEOVER_AUTO_EXPIRE_HOURS = 24 → 4  // stale takeovers clear faster
```

### 0.3 One-shot stale takeover cleanup script

```sql
UPDATE leads 
SET humanTakeover = 0
WHERE humanTakeover = 1
  AND lastAgentActivityAt < NOW() - INTERVAL 4 HOUR
  AND id NOT IN (
    SELECT DISTINCT leadId FROM conversations
    WHERE direction = 'outbound'
      AND senderType = 'human'
      AND createdAt > NOW() - INTERVAL 4 HOUR
  );
```

### 0.4 Expected impact from Phase 0 alone

- AI participation rate: 19.6% → ~32–38%
- Hot leads: 6 → 15–25 (as false `humanTakeover` flags clear)
- Duplicate-send risk: slightly higher (cooldown reduced) — Phase 1 fixes this properly
- Zero new code written; fully reversible by setting `DISABLE_LEGACY_TIMERS=false`

**Gate to Phase 1:** Monitor for 24h. If duplicate sends spike above 5% of sends, revert `DB_SEND_COOLDOWN_MS` only.

---

## Phase 1 — The Outbox (Week 1)

The structural fix for duplicate-send and false-block problems. Fix orchestration before touching the brain.

### 1.0 TiDB SKIP LOCKED Pre-Check (BLOCKING prerequisite)

Run against production TiDB before writing any outbox code:

```sql
CREATE TABLE _skip_locked_test (id INT PRIMARY KEY, status VARCHAR(20));
INSERT INTO _skip_locked_test VALUES (1, 'pending');
SELECT * FROM _skip_locked_test WHERE status = 'pending' FOR UPDATE SKIP LOCKED;
DROP TABLE _skip_locked_test;
```

**If SKIP LOCKED works:** proceed as written below.

**If SKIP LOCKED errors:** use this optimistic-lock fallback pattern:

```typescript
async function claimOutboxRows(workerId: string, limit = 10): Promise<OutboxRow[]> {
  const now = new Date();
  const expiry = new Date(now.getTime() - 120_000);

  await db.execute(sql`
    UPDATE outbox
    SET status = 'claimed', claimed_by = ${workerId}, claimed_at = ${now}
    WHERE (status = 'pending' AND scheduled_at <= ${now})
       OR (status = 'claimed' AND claimed_at < ${expiry})
    ORDER BY scheduled_at ASC
    LIMIT ${limit}
  `);

  return db.select().from(outbox)
    .where(and(eq(outbox.claimedBy, workerId), eq(outbox.status, 'claimed')))
    .limit(limit);
}
```

### 1.1 New table: `outbox`

```sql
CREATE TABLE outbox (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  lead_id       INT NOT NULL,
  idem_key      VARCHAR(64) NOT NULL,
  source        ENUM('webhook','responder','follow_up','manual') NOT NULL,
  payload       JSON NOT NULL,
  status        ENUM('pending','claimed','sent','failed','skipped') DEFAULT 'pending',
  claimed_by    VARCHAR(64),
  claimed_at    TIMESTAMP NULL,
  scheduled_at  TIMESTAMP NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  sent_at       TIMESTAMP NULL,
  error         TEXT,
  retry_count   INT DEFAULT 0,
  
  UNIQUE KEY uk_idem (lead_id, idem_key),
  INDEX idx_pending (status, scheduled_at)
);
```

### 1.2 Idempotency key formula

```typescript
function makeIdemKey(leadId: number, triggerSource: string, windowMs = 300_000): string {
  const bucket = Math.floor(Date.now() / windowMs);
  return sha256(`${leadId}:${triggerSource}:${bucket}`).slice(0, 64);
}
```

For inbound message responses, include first 50 chars of inbound body:
```typescript
const key = makeIdemKey(leadId, `reply:${inboundBody.slice(0, 50)}`);
```

### 1.3 Convert all 4 senders to outbox producers

Replace direct `runBrainCouncil()` calls with `enqueueOutbox()`:

**`webhook-message.ts`** (inbound reply):
```typescript
await enqueueOutbox({
  leadId: lead.id,
  idemKey: makeIdemKey(lead.id, `reply:${message.body.slice(0, 50)}`),
  source: 'webhook',
  scheduledAt: shouldDefer(lead) ? addMinutes(now, 15) : now,
  payload: { trigger: 'inbound_reply', channelHint: message.channel }
});
```

**`follow-up-trigger.ts`** (overdue follow-up):
```typescript
await enqueueOutbox({
  leadId: lead.id,
  idemKey: makeIdemKey(lead.id, 'follow_up'),
  source: 'follow_up',
  scheduledAt: lead.nextFollowUpAt,
  payload: { trigger: 'proactive_follow_up' }
});
```

**`webhook-contact.ts`** (first contact):
```typescript
await enqueueOutbox({
  leadId: lead.id,
  idemKey: makeIdemKey(lead.id, 'first_contact'),
  source: 'webhook',
  scheduledAt: addSeconds(now, 45),
  payload: { trigger: 'first_contact', channel: detectedChannel }
});
```

### 1.4 New file: `outbox-worker.ts` (~200 lines)

Drains the outbox every 2 minutes. The ONLY path through which messages are sent.

```typescript
export async function drainOutbox(): Promise<void> {
  const rows = await claimOutboxRows(INSTANCE_ID, 10);
  await Promise.allSettled(rows.map(processOutboxRow));
}

async function processOutboxRow(row: OutboxRow): Promise<void> {
  const lead = await getLead(row.lead_id);
  const startTime = Date.now();
  
  try {
    const guardResult = await runInputGuards(lead);
    if (guardResult.blocked) {
      await markOutbox(row.id, 'skipped', guardResult.reason);
      return;
    }
    if (guardResult.deferred) {
      await rescheduleOutbox(row.id, guardResult.deferUntil);
      return;
    }

    let decision: BrainDecision;

    if (row.payload.draftMessage) {
      // Path A: Pre-composed content (static nurture sequences)
      decision = {
        message: row.payload.draftMessage,
        channel: row.payload.channel ?? lead.preferredChannel,
        nextFollowUpHours: row.payload.nextFollowUpHours ?? 0,
        pipelineAction: null,
        routeToHuman: false,
        routeReason: null,
        confidence: 100,
        toolLog: [],
      };
    } else {
      // Path B: LLM-generated
      decision = await callSingleBrain(lead, row.payload);
    }

    const outputGuard = runOutputGuards(decision, lead, decision.toolLog ?? []);
    if (outputGuard.blocked) {
      if (outputGuard.reason === 'system_leak') {
        const retry = await callSingleBrain(lead, { ...row.payload, systemLeakRetry: true });
        if (runOutputGuards(retry, lead, retry.toolLog ?? []).blocked) {
          await markOutbox(row.id, 'failed', 'output_guard_retry_failed');
          return;
        }
        Object.assign(decision, retry);
      } else {
        await markOutbox(row.id, 'skipped', outputGuard.reason);
        return;
      }
    }

    await sendViaGHL(decision.message, decision.channel, lead);
    
    const nextState = deriveNextConvState(lead.convState, decision, lead);
    await Promise.all([
      markOutbox(row.id, 'sent'),
      logDecision(lead.id, row, decision, startTime),
      updateLeadAfterSend(lead, decision, nextState),
      postSendCheck(lead, decision, row),
    ]);

  } catch (err) {
    await markOutbox(row.id, 'failed', String(err));
    if (row.retry_count < 3) {
      await enqueueOutbox({ ...row, scheduledAt: addSeconds(now, 60) });
    }
  }
}
```

### 1.5 New file: `input-guards.ts` (~100 lines)

5 hard input guards. Pure TypeScript, no LLM calls.

```typescript
export async function runInputGuards(lead: Lead): Promise<GuardResult> {
  // Guard 1: Global AI offline
  const settings = await getSystemSettings();
  if (!settings.aiOnline) return block('ai_offline');

  // Guard 2: DNC keyword scan (last 5 inbound messages)
  const recent = await getRecentInbound(lead.id, 5);
  if (hasDNCKeywords(recent)) {
    await setHumanTakeover(lead.id, 'dnc_keyword');
    return block('dnc_keyword');
  }

  // Guard 3: GHL DND per-channel
  const dnd = await checkGHLDND(lead.ghlContactId, lead.preferredChannel);
  if (dnd) return block('ghl_dnd');

  // Guard 4: humanTakeover active (and not expired)
  if (lead.humanTakeover && !isHumanTakeoverExpired(lead)) return block('human_takeover');

  // Guard 5: TCPA quiet hours
  const tz = getTimezoneFromAreaCode(lead.phone);
  if (isQuietHours(tz)) {
    return defer(nextBusinessHour(tz));
  }

  // Guard 5b: FB 24hr window check (channel override, not block)
  if (lead.preferredChannel === 'FB') {
    const windowOpen = await checkFBWindow(lead.ghlContactId);
    if (!windowOpen) {
      lead.effectiveChannel = 'SMS'; // silently override
    }
  }

  return pass();
}
```

### 1.6 Remove from existing code (after outbox is live)

Delete from `brain-council-orchestrator.ts`:
- The 90-second DB cooldown check
- The `DB processing lock (5-min TTL)` logic
- The `already-responded check`
- The daily send cap producer logic (keep cap enforcement in outbox-worker only)

**Gate to Phase 2:** Outbox live in production. Zero duplicate sends in 48h. All 4 senders writing to outbox. Cooldown/lock stack removed.

---

## Phase 2 — The Single Brain (Week 1–2)

Build alongside the existing pipeline. Don't replace anything yet.

### 2.0 Prompt Versioning Table (REQUIRED)

```sql
CREATE TABLE prompt_versions (
  id          INT PRIMARY KEY AUTO_INCREMENT,
  version     VARCHAR(20) NOT NULL,
  template    TEXT NOT NULL,
  is_active   BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  notes       TEXT
);
```

The system prompt is database-driven. Prompt iterations require zero code deploys — just a database update and setting `is_active`.

### 2.1 New file: `pricing-data.json`

**BLOCKING: Must be extracted verbatim from `shared/sales-training.ts`.** Do NOT invent numbers.

Schema:
```json
{
  "minimumOrder": 1,
  "note": "No minimums — even 1 shirt. Pricing per unit decreases with quantity.",
  "products": {
    "tshirt": {
      "name": "Custom T-Shirt (Gildan 3000)",
      "tiers": [
        { "minQty": 1,  "maxQty": 5,   "sides": { "1": null,  "2": null  }, "note": "call for quote" },
        { "minQty": 6,  "maxQty": 11,  "sides": { "1": 15.35, "2": 18.35 } },
        { "minQty": 12, "maxQty": 19,  "sides": { "1": 14.10, "2": 17.10 } },
        { "minQty": 20, "maxQty": 44,  "sides": { "1": 11.90, "2": 14.90 } },
        { "minQty": 45, "maxQty": 59,  "sides": { "1": 8.75,  "2": 11.75 } },
        { "minQty": 60, "maxQty": 74,  "sides": { "1": 7.85,  "2": 10.85 } },
        { "minQty": 75, "maxQty": 199, "sides": { "1": 6.85,  "2": 9.85  } },
        { "minQty": 200,"maxQty": null, "sides": { "1": null, "2": null }, "note": "call for bulk quote" }
      ],
      "sizeUpcharges": { "2XL": 2.50, "3XL-5XL": 3.50 },
      "rushFeePercent": 20,
      "setupFee": 0
    }
  }
}
```

Extract ALL products from `sales-training.ts` (hoodies, polos, hats, tote bags, etc.).

### 2.2 New file: `pricing-engine.ts` (~100 lines)

```typescript
export function getQuote(qty: number, sides: 1|2, product: string, rush = false): QuoteResult {
  const p = pricingData.products[product];
  if (!p) return { error: `Unknown product: ${product}`, callForQuote: true };

  const tier = p.tiers.find(t => qty >= t.minQty && (t.maxQty === null || qty <= t.maxQty));
  if (!tier) return { error: `Qty ${qty} outside pricing table`, callForQuote: true };

  const perUnit = tier.sides[String(sides)];
  if (perUnit === null) return {
    callForQuote: true,
    message: `For orders of ${qty}, we quote individually — reply with your full order details.`
  };

  const subtotal = perUnit * qty;
  const rushFee = rush ? subtotal * (p.rushFeePercent / 100) : 0;
  const total = subtotal + rushFee + p.setupFee;
  
  return {
    perUnit, subtotal, rushFee, setupFee: p.setupFee, total, qty, sides, product,
    breakdown: `${qty} × $${perUnit.toFixed(2)} (${sides}-side ${p.name})${rush ? ` + $${rushFee.toFixed(2)} rush` : ''} = $${total.toFixed(2)}`
  };
}
```

This is the ONLY code allowed to produce prices. The LLM calls it as a tool.

### 2.3 New file: `single-brain.ts` (~400 lines)

Two-step LLM loop pattern (tools then json_schema):

```typescript
export async function callSingleBrain(lead: Lead, trigger: TriggerPayload): Promise<BrainDecision> {
  const [history, topApproaches, avoidApproaches, leadMemory] = await Promise.all([
    getConversationHistory(lead.id, 20),
    getTopApproaches(lead.segment, lead.preferredChannel, lead.pipelineStage, 3),
    getAvoidApproaches(lead.segment, lead.preferredChannel, 3),
    getLeadMemory(lead.id),
  ]);

  const model = await getActiveModel(); // checks for promoted LoRA model
  const promptTemplate = await getActivePromptTemplate(); // from prompt_versions table
  const systemPrompt = renderTemplate(promptTemplate, { lead, history, topApproaches, avoidApproaches, leadMemory, trigger });

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: buildUserPrompt(lead, trigger) },
  ];

  const toolLog: ToolCallRecord[] = [];
  let iterations = 0;
  const MAX_TOOL_ROUNDS = 3;

  // Step 1: Tool execution loop (no response_format)
  while (iterations < MAX_TOOL_ROUNDS) {
    const response = await invokeLLM({
      model,
      messages,
      tools: BRAIN_TOOLS,
      tool_choice: 'auto',
      temperature: 0.7,
      max_tokens: 600,
    });

    const msg = response.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls?.length) break;

    for (const call of msg.tool_calls) {
      const result = await executeTool(call.function.name, JSON.parse(call.function.arguments), lead);
      toolLog.push({ name: call.function.name, args: call.function.arguments, result });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
    iterations++;
  }

  // Step 2: Final structured output (json_schema, no tools)
  const finalResponse = await invokeLLM({
    model,
    messages: [...messages, { role: 'user', content: 'Now return your final decision as JSON.' }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'brain_decision',
        strict: true,
        schema: BRAIN_DECISION_SCHEMA,
      }
    },
    temperature: 0,
    max_tokens: 400,
  });

  const decision = JSON.parse(finalResponse.choices[0].message.content!) as BrainDecision;
  const promptVersion = await getActivePromptVersion();
  return { ...decision, toolLog, promptVersion };
}
```

**Cost:** 1-2 LLM calls average (1 if no tools, 2 if tools called + finalization). Max 3 in edge cases. Still 2-4x cheaper than current 4-8 calls.

### 2.4 System prompt template

```
You are Alex, a sales closer for Adorb Custom Printing (Hallandale Beach, FL).
We print custom apparel: t-shirts, hoodies, hats, and more for churches, 
corporate teams, sports leagues, and events.

━━ LEAD CONTEXT ━━
Name: {{lead.name}}
Business: {{lead.businessName || 'not provided'}}
Channel they used: {{lead.preferredChannel}}
Pipeline stage: {{lead.pipelineStage}}
Days since first contact: {{daysSince}}
Lead score: {{lead.opportunityScore}}/100
What we know about them: {{leadMemory.facts | join(', ') || 'nothing yet'}}

━━ CONVERSATION HISTORY (last 20 messages) ━━
{{conversationHistory}}

━━ WHAT HAS WORKED FOR SIMILAR LEADS ━━
{{topApproaches | each → "• {{approach}}: {{replyRate}}% reply rate ({{n}} samples)"}}
{{if none: "No data yet — trust your instincts"}}

━━ WHAT TO AVOID ━━  
{{avoidApproaches | each → "• AVOID {{approach}}: {{replyRate}}% reply rate ({{n}} samples)"}}

━━ YOUR OBJECTIVE FOR THIS STAGE ({{lead.pipelineStage}}) ━━
Goal: {{stageData.objective}}
{{stageData.signals_to_ask_for.length ? `Still need to learn: ${stageData.signals_to_ask_for.join(', ')}` : ''}}
Avoid: {{stageData.avoid.join(' | ')}}

━━ PRICING (use getQuote tool — never quote freehand) ━━
Products: Custom T-Shirts, Hoodies, Polo Shirts, Hats, Tote Bags
No minimum order — even 1 shirt. Call getQuote for any qty ≥ 6.
For qty 1-5, return callForQuote:true and tell the lead we'll quote them directly.

━━ COLD OUTREACH RULES ━━
(Apply when conversationHistory is empty or all messages are from us with no reply)

FIRST CONTACT (zero conversation history):
• For SMS ONLY — use the intentional typo + correction pattern:
  Part 1: Slight misspelling of their name + hook
  "Hey Jenifer — noticed you were asking about custom shirts for your church event"
  (Note: misspell by one letter — not unrecognizable, just slightly off)
  Part 2: Casual self-correction + value prop + single question
  "Jennifer* — sorry! Anyway, we do custom tees for churches from $11.90/shirt, 
   no minimums. How many are you thinking for the event?"
  Format: separate parts with \n---\n
  The misspelling must be subtle (one transposed or doubled letter).
  The correction in Part 2 is what makes this feel human.

• For Email / FB / IG / WA: Use a casual shortened form of their name 
  (Mike not Michael, Jen not Jennifer) — no typo, no correction mechanic.
  One message under 80 words, no split.

FOLLOW-UP WITH NO REPLY YET:
• You MUST use a different approach than the previous message. 
  Check the conversation history — do not repeat the same angle.
• Rotation order (skip any that are in avoid list):
  HORMOZI_ACA → CURIOSITY_HOOK → SOAP_OPERA → CASE_STUDY → 
  DIRECT_RESPONSE → HORMOZI_VALUE → then BREAKUP
• Never use SOCIAL_PROOF (permanently banned).
• Never use HORMOZI_INDIRECT (referral ask — never appropriate here).

BREAKUP (final message — only when daysSinceFirst > 7 AND messages sent ≥ 4):
• One sentence. Warm close, no guilt. 
• Set nextFollowUpHours: 0 — do not schedule anything after this.
• Set pipelineAction: "mark_lost".

NEVER ON COLD OUTREACH:
• Do not mention "Brain Council", "AI", "algorithm", "system", or "automated".
• Do not open with "Just following up" — it signals automation.
• Do not ask more than one question in a message.

━━ YOUR JOB ━━
Close the deal. Move this lead forward. Be direct, warm, and specific.

If they asked a question → answer it clearly.
If they seem ready to buy → compute a quote with getQuote, then offer a payment link.
If they want to meet → book an appointment.
If they said stop/unsubscribe/remove me → call markDNC().
If there's a complaint or they demand a human → call routeToHuman().
If no response needed (spam, system message) → return message: null.

━━ RETURN JSON ━━
{
  "message": string | null,
  "channel": "SMS" | "Email" | "FB" | "IG" | "WA",
  "nextFollowUpHours": number,
  "pipelineAction": "advance" | "mark_won" | "mark_lost" | "dnc" | null,
  "routeToHuman": boolean,
  "routeReason": string | null,
  "confidence": 0-100
}

Rules: 
- channel must match {{lead.preferredChannel}} unless lead explicitly asked for a different one
- nextFollowUpHours: 2-4 for hot leads (score>80), 24-48 for warm, 72-96 for cold
- If you called getQuote, the price in message MUST match the tool result exactly
```

### 2.5 New file: `stage-behavior.json`

```json
{
  "new_lead": {
    "objective": "Get a first response. Do not pitch pricing yet.",
    "signals_to_ask_for": ["event type", "quantity estimate", "timeline"],
    "avoid": ["leading with price", "long messages", "multiple questions"]
  },
  "exploring": {
    "objective": "Understand their need fully before quoting.",
    "signals_to_ask_for": ["exact quantity", "shirt style", "in-hands date", "budget range"],
    "avoid": ["quoting before you know quantity and style", "rushing to close"]
  },
  "quote_requested": {
    "objective": "Deliver exact quote immediately using getQuote tool. Then offer payment link.",
    "signals_to_ask_for": [],
    "avoid": ["vague pricing", "saying 'around' or 'approximately'", "delaying quote"]
  },
  "quote_sent": {
    "objective": "Follow up on the quote. Remove friction. Address any hesitation.",
    "signals_to_ask_for": ["are they ready to proceed", "any questions on the quote"],
    "avoid": ["sending another quote without them asking", "pressuring"]
  },
  "appointment_scheduled": {
    "objective": "Confirm the appointment and prep them for the call.",
    "signals_to_ask_for": ["confirm they got the calendar invite", "any questions before the call"],
    "avoid": ["pitching more before the call", "rescheduling without their request"]
  },
  "negotiating": {
    "objective": "Close. Offer to adjust quantity, style, or rush options — not price.",
    "signals_to_ask_for": ["what's holding them back", "revised quantity if budget is the issue"],
    "avoid": ["discounting directly", "re-explaining the product they already understand"]
  },
  "won": {
    "objective": "Confirm order details. Set expectations on timeline and proof.",
    "signals_to_ask_for": ["shipping address", "artwork file", "approval on proof"],
    "avoid": ["upselling immediately", "any sales language — they already bought"]
  },
  "lost": {
    "objective": "Warm close. Leave the door open.",
    "signals_to_ask_for": [],
    "avoid": ["re-pitching", "asking why they didn't buy", "guilt"]
  },
  "stale": {
    "objective": "Re-engage with something new. Don't reference the old conversation.",
    "signals_to_ask_for": ["any upcoming events", "did their needs change"],
    "avoid": ["'just following up'", "repeating prior messages"]
  }
}
```

### 2.6 New file: `output-guards.ts` (~80 lines)

```typescript
export function runOutputGuards(decision: BrainDecision, lead: Lead, toolLog: ToolCall[]): GuardResult {
  // Guard 1: System leak
  const SYSTEM_PATTERNS = /brain council|strategist|composer|qc brain|expert panel|json\s*\{|"\s*:\s*"/i;
  if (decision.message && SYSTEM_PATTERNS.test(decision.message)) return block('system_leak');

  // Guard 2: Channel mismatch (first response must use inbound channel)
  if (lead.messageCount === 0 && decision.channel !== lead.preferredChannel) {
    decision.channel = lead.preferredChannel; // force, don't block
  }

  // Guard 3: Price validation — if message mentions $, verify getQuote was called
  if (decision.message?.includes('$')) {
    const quoteCall = toolLog.find(t => t.name === 'getQuote');
    if (!quoteCall) return block('unverified_price');
    const quotedTotal = quoteCall.result?.total;
    if (quotedTotal && !decision.message.includes(quotedTotal.toFixed(2))) {
      return block('price_mismatch');
    }
  }

  // Guard 4: DNC check on outgoing message
  if (decision.message && hasDNCKeywords([decision.message])) return block('outbound_dnc_phrase');

  // Guard 5: Null message with advance action
  if (!decision.message && decision.pipelineAction === 'advance') {
    decision.pipelineAction = null;
  }

  return pass();
}
```

### 2.7 Feature-flag routing (A/B the single brain)

```typescript
// outbox-worker.ts
const useSingleBrain = (lead.id % 100) < Number(process.env.SINGLE_BRAIN_PCT ?? '0');
const decision = useSingleBrain
  ? await callSingleBrain(lead, row.payload)
  : await runLegacyBrainCouncil(lead, row.payload);
```

Ramp plan:
- `SINGLE_BRAIN_PCT=10` for 48h
- `SINGLE_BRAIN_PCT=50` if reply rate within 5% of legacy after 7 days
- `SINGLE_BRAIN_PCT=100` if still matching or better

**Gate to Phase 3:** Single brain at 50% traffic for 7 days with reply rate ≥ legacy. Zero pricing hallucinations.

---

## Phase 3 — Strangle & Delete (Week 2–3)

Once `SINGLE_BRAIN_PCT=100`, execute the delete list.

### 3.0 Pre-Delete Extractions (BEFORE any deletes)

**Step 0A — Create `lead-utils.ts`:**

```typescript
// Deterministic lead scoring (no LLM)
export function scoreLeadQuick(lead: Lead, signals: LeadSignals): number {
  let score = 0;
  if (lead.phone) score += 10;
  if (lead.email) score += 10;
  if (lead.businessName) score += 10;
  if (signals.hasReplied) score += 30;
  if (signals.emailOpened) score += 15;
  if (signals.linkClicked) score += 20;
  if (signals.appointmentBooked) score += 25;
  const daysSinceLastActivity = getDaysSince(signals.lastActivityAt);
  if (daysSinceLastActivity > 30) score -= 20;
  if (daysSinceLastActivity > 60) score -= 20;
  if (signals.consecutiveNoReplies >= 4) score -= 15;
  return Math.max(0, Math.min(100, score));
}

// Rule-based segment classification (rare LLM fallback)
export async function classifySegment(lead: Lead): Promise<string> {
  const text = `${lead.businessName} ${lead.tags?.join(' ')} ${lead.notes}`.toLowerCase();
  const SEGMENT_KEYWORDS = {
    church: ['church', 'ministry', 'pastor', 'congregation', 'worship', 'faith'],
    corporate: ['llc', 'inc', 'corp', 'company', 'enterprise', 'solutions'],
    sports: ['team', 'league', 'athletic', 'soccer', 'football', 'basketball'],
    event: ['event', 'wedding', 'reunion', 'festival', 'conference', 'gala'],
    school: ['school', 'university', 'college', 'academy', 'students'],
  };
  let bestMatch = { segment: 'general', score: 0 };
  for (const [segment, keywords] of Object.entries(SEGMENT_KEYWORDS)) {
    const score = keywords.filter(kw => text.includes(kw)).length;
    if (score > bestMatch.score) bestMatch = { segment, score };
  }
  if (bestMatch.score >= 1) return bestMatch.segment;
  if (!lead.businessName && !lead.notes) return 'general'; // no data = no LLM call
  return classifySegmentWithLLM(lead); // rare fallback
}

// Pure data assembler (no LLM)
export async function buildLeadContext(lead: Lead): Promise<LeadContext> {
  const [memory, history, signals] = await Promise.all([
    getLeadMemory(lead.id),
    getConversationHistory(lead.id, 5),
    getLeadSignals(lead.id),
  ]);
  return {
    segment: lead.segment ?? await classifySegment(lead),
    knownFacts: memory.facts,
    estimatedQty: memory.estimatedQty ?? null,
    eventDate: memory.eventDate ?? null,
    lastTopicDiscussed: history[0]?.topicTag ?? null,
    engagementTier: signals.hasReplied ? 'warm' : signals.emailOpened ? 'lukewarm' : 'cold',
  };
}
```

**Step 0B — Create `signal-patterns.ts`:**

Extract from `auto-correction.ts` before deleting it:

```typescript
export const CONFUSION_PATTERNS = [
  /who is this/i, /wrong number/i, /what\??$/i, /huh\??$/i,
  /i don'?t (know|remember) you/i, /how did you get (my|this) number/i,
  /not interested/i, /stop (texting|messaging|contacting)/i,
];

export const WRONG_BUSINESS_PATTERNS = [
  /wrong (company|business|person)/i,
  /i never (contacted|reached out|inquired)/i,
  /don'?t (know|recognize) your (company|business)/i,
];

export const NEGATIVE_SENTIMENT_PATTERNS = [
  /leave me alone/i, /don'?t contact me/i, /remove (me|my number)/i,
];
```

**Step 0C — Update imports:**
- `webhook-contact.ts` → import from `lead-utils.ts`
- `follow-up-trigger.ts` → import from `lead-utils.ts`
- `webhook-message.ts` → import `CONFUSION_PATTERNS` from `signal-patterns.ts`

Run `tsc --noEmit`. Confirm 0 errors. NOW proceed to deletes.

### 3.1 Delete order

**Step 1 — Delete brain files:**
```
DELETE: expert-panel.ts          (187 lines)
DELETE: deliberation-judge.ts    (175 lines)
DELETE: closer.ts                (195 lines)
DELETE: objection-handler.ts     (248 lines)
DELETE: brain-council-review.ts  (452 lines)
DELETE: brain-council.ts        (1,315 lines)
DELETE: auto-correction.ts       (337 lines)
```

**Step 2 — Delete strategy/learning/meta files:**
```
DELETE: strategist.ts            (687 lines)
DELETE: composer.ts              (808 lines)
DELETE: researcher.ts            (272 lines)
DELETE: lead-researcher.ts       (473 lines)
DELETE: auto-skill-hunter.ts     (462 lines)
DELETE: strategy-autopilot.ts    (237 lines)
DELETE: skill-registry.ts        (398 lines)
DELETE: ab-testing.ts            (634 lines)
DELETE: few-shot-retrieval.ts    (248 lines)
DELETE: error-memory.ts          (597 lines)
DELETE: lookback-engine.ts       (527 lines)
DELETE: deferred-response-processor.ts (218 lines)
```

Run `tsc --noEmit`. Fix errors.

**Step 3 — Rewrite:**
```
REWRITE: brain-council-orchestrator.ts (1,497 → 50 lines stub importing outbox-worker)
REWRITE: qc.ts (1,159 → 0 lines, replaced by output-guards.ts)
REWRITE: brain-types.ts (177 → ~60 lines)
REWRITE: brain-context.ts (155 → ~80 lines)
```

**Step 4 — Simplify:**
```
SIMPLIFY: scheduling-engine.ts (1,278 → ~400 lines)
SIMPLIFY: learning-loop.ts (1,223 → ~150 lines)
SIMPLIFY: webhook-message.ts (1,028 → ~300 lines)
SIMPLIFY: webhook-contact.ts (825 → ~350 lines)
SIMPLIFY: lead-disposition.ts (463 → ~120 lines)
SIMPLIFY: db.ts (1,365 → ~700 lines)
SIMPLIFY: persona-learning.ts (640 → ~80 lines)
SIMPLIFY: conversation-state.ts (282 → ~55 lines, passive observer only)
DELETE:   stage-playbook.ts (743 → replaced by stage-behavior.json)
```

### 3.2 `conversation-state.ts` — Passive Observer Pattern

```typescript
export type ConvState = 
  | 'new' | 'contacted' | 'engaged' | 'exploring' | 'quoted'
  | 'negotiating' | 'booked' | 'payment_sent' | 'closed_won'
  | 'closed_lost' | 'human_takeover' | 'dnc';

export function deriveNextConvState(current: ConvState, decision: BrainDecision, lead: Lead): ConvState {
  if (decision.pipelineAction === 'dnc') return 'dnc';
  if (decision.routeToHuman) return 'human_takeover';
  if (decision.pipelineAction === 'mark_won') return 'closed_won';
  if (decision.pipelineAction === 'mark_lost') return 'closed_lost';
  if (decision.toolLog?.some(t => t.name === 'createPaymentLink')) return 'payment_sent';
  if (decision.toolLog?.some(t => t.name === 'bookAppointment')) return 'booked';
  if (decision.toolLog?.some(t => t.name === 'getQuote')) return 'quoted';
  if (current === 'new' || current === 'contacted') return 'contacted';
  return current;
}
```

### 3.3 Database tables to drop

```sql
DROP TABLE ab_experiments;
DROP TABLE ab_assignments;
DROP TABLE hall_of_fame;
DROP TABLE supervisor_audit;
DROP TABLE error_memory;
DROP TABLE skill_proposals;
DROP TABLE strategy_adjustments;
DROP TABLE deferred_responses;
```

### 3.4 Rename `brain_council_audit` → `decision_log`

```sql
ALTER TABLE brain_council_audit RENAME TO decision_log;

ALTER TABLE decision_log
  DROP COLUMN IF EXISTS strategist_output,
  DROP COLUMN IF EXISTS researcher_output,
  DROP COLUMN IF EXISTS expert_panel_scores,
  DROP COLUMN IF EXISTS qc_violations,
  DROP COLUMN IF EXISTS deliberation_output;

ALTER TABLE decision_log
  ADD COLUMN brain_version VARCHAR(10) DEFAULT 'v2',
  ADD COLUMN tools_called JSON,
  ADD COLUMN input_guard_result VARCHAR(50),
  ADD COLUMN output_guard_result VARCHAR(50),
  ADD COLUMN latency_ms INT,
  ADD COLUMN llm_calls TINYINT DEFAULT 1,
  ADD COLUMN outbox_id BIGINT NULL,
  ADD COLUMN prompt_version VARCHAR(20),
  ADD COLUMN flagged_for_review TINYINT DEFAULT 0,
  ADD COLUMN flag_reason VARCHAR(50),
  ADD COLUMN reviewed_at TIMESTAMP NULL,
  ADD CONSTRAINT fk_decision_outbox FOREIGN KEY (outbox_id) REFERENCES outbox(id) ON DELETE SET NULL;
```

### 3.5 Re-enable 3 timers as outbox producers

- **Fast Missed-Reply Scanner (2 min):** Enqueue `trigger: 'missed_reply'`
- **Post-Delivery Executor (30 min):** Enqueue post-delivery follow-up steps
- **Seasonal Campaign Executor (2 hr):** Enqueue seasonal sends

### 3.6 Convert nurture timers to outbox producers

**Lost Lead Nurture:**
```typescript
await enqueueOutbox({
  leadId: lead.id,
  idemKey: makeIdemKey(lead.id, `lost_nurture_${quarter}`),
  source: 'follow_up',
  scheduledAt: now,
  payload: { trigger: 'lost_lead_nurture', channel }
});
```

**Import Contact Nurture:** Same pattern with `trigger: 'import_nurture'`.

### 3.7 Message splitting in `ghl.ts` (KEEP)

```typescript
async function sendSMS(message: string, lead: Lead): Promise<void> {
  // Intentional 2-part split (cold outreach format)
  if (message.includes('\n---\n')) {
    const [part1, part2] = message.split('\n---\n');
    await ghlSend(part1.trim(), lead);
    await sleep(4000 + Math.random() * 2000); // 4-6s human-feeling delay
    await ghlSend(part2.trim(), lead);
    return;
  }

  // Existing length-based split (messages >160 chars)
  if (message.length > 160) {
    const mid = findNaturalBreak(message, 160);
    await ghlSend(message.slice(0, mid).trim(), lead);
    await sleep(3000 + Math.random() * 2000);
    await ghlSend(message.slice(mid).trim(), lead);
    return;
  }

  await ghlSend(message, lead);
}
```

### 3.8 Timer inventory after Phase 3

| # | Timer | Interval | Purpose |
|---|---|---|---|
| 1 | Outbox Worker | 2 min | Drain outbox (the only sender) |
| 2 | Follow-Up Trigger | 10 min | Enqueue overdue follow-ups |
| 3 | Stuck Claim Cleaner | 5 min | Clear outbox rows claimed_at > 2 min |
| 4 | Outcome Backfill | 30 min | Attribute replies to AI messages |
| 5 | Disposition Sweep | 30 min | DNC cleanup, takeover expiry |
| 6 | SLA Timer | 30 min | Alert on unanswered agent handoffs |
| 7 | Post-Delivery Executor | 30 min | Post-delivery sequences |
| 8 | Learning Weight Updater | 1 hr | Update segment weights |
| 9 | Seasonal Campaign | 2 hr | Seasonal sends |
| 10 | Import Contact Nurture | 6 hr | Monthly email to imported contacts |
| 11 | Lost Lead Nurture | 24 hr | Quarterly re-engagement |

### 3.9 Test Plan

**Delete test files for all deleted modules** (~6,000 test lines removed).

**Write new tests:**

`outbox-worker.test.ts` (10 scenarios):
- Atomic claim (concurrent claims don't double-process)
- Duplicate enqueue with same idem_key produces 1 row
- Stale claim reclaimed by next worker run
- Failed send retries with new idem_key bucket
- DNC input guard aborts before brain call
- TCPA quiet hours defers (updates scheduled_at)
- humanTakeover active blocks send
- Pre-composed draftMessage skips brain call
- Send failure increments retryCount
- retryCount >= 3 does not re-enqueue

`single-brain.test.ts` (14 scenarios):
- First contact with zero history → uses cold outreach rules
- Inbound reply → responds on same channel
- Pricing question → calls getQuote tool
- getQuote result appears verbatim in message
- "stop messaging" in inbound → calls markDNC tool
- Complaint → calls routeToHuman tool
- Follow-up with no reply → different angle than previous message
- Breakup only after 7+ days AND 4+ unanswered messages
- Tool round limit (3) is respected
- json_schema output always matches BrainDecision type
- Confidence 0-100 always present
- SMS cold outreach → message contains \n---\n separator
- Lead on FB with 24hr window expired → channel fallback to SMS
- Lead with segment=church → topApproaches includes church-specific entries

`guards.test.ts` (10 scenarios):
- DNC keyword in last 5 messages → input guard blocks
- GHL DND → input guard blocks
- TCPA 10pm local time → input guard defers
- humanTakeover=1 set 3h ago → still blocks (< 4h expiry)
- humanTakeover=1 set 5h ago → passes (expired)
- "Brain Council" in output → output guard blocks (system_leak)
- $ in output with no getQuote call → output guard blocks
- $ in output matching getQuote result → output guard passes
- Channel mismatch on first message → forces correct channel
- Null message with advance action → strips pipelineAction

**Target after Phase 3:** 650+ tests passing.

**Gate to Phase 4:** TypeScript errors = 0. All tests passing. LOC target: ~12,000. No production incidents in 72h post-delete.

---

## Phase 4 — Closing Surface (Week 3–4)

Revenue-generating capabilities. The single brain already has tool signatures; now wire them to real APIs.

### 4.0 Stripe Prerequisite (BLOCKING)

Run `webdev_add_feature` with `feature='stripe'` before any Stripe code. This installs the SDK, creates webhook scaffold, and provisions `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`.

### 4.1 `getQuote` — already done in Phase 2

Add quote persistence:
```sql
CREATE TABLE quotes (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  lead_id       INT NOT NULL,
  product       VARCHAR(50),
  qty           INT,
  sides         TINYINT,
  per_unit      DECIMAL(10,2),
  total         DECIMAL(10,2),
  rush          BOOLEAN DEFAULT FALSE,
  status        ENUM('sent','approved','declined','expired') DEFAULT 'sent',
  sent_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at    TIMESTAMP,
  INDEX idx_lead (lead_id)
);
```

### 4.2 `bookAppointment` — GHL Calendar API

```typescript
export async function bookAppointment(lead: Lead, slot: string, notes: string): Promise<AppointmentResult> {
  const response = await ghlApi.post('/calendars/events', {
    contactId: lead.ghlContactId,
    startTime: slot,
    title: `Adorb Custom Printing — ${lead.name}`,
    notes,
  });
  await updateLeadStage(lead.id, 'appointment_scheduled');
  return { confirmation: response.data.id, humanReadable: formatSlot(slot) };
}
```

### 4.3 `createPaymentLink` — Stripe

```typescript
export async function createPaymentLink(lead: Lead, amount: number, description: string): Promise<PaymentLinkResult> {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{ price_data: { currency: 'usd', product_data: { name: description }, unit_amount: Math.round(amount * 100) }, quantity: 1 }],
    mode: 'payment',
    success_url: `${process.env.BASE_URL}/payment-success?leadId=${lead.id}`,
    cancel_url: `${process.env.BASE_URL}/payment-cancelled?leadId=${lead.id}`,
    metadata: { leadId: String(lead.id), ghlContactId: lead.ghlContactId },
    expires_at: Math.floor(Date.now() / 1000) + 86400,
  });

  await db.insert(paymentLinks).values({
    leadId: lead.id, stripeSessionId: session.id, amount, url: session.url, expiresAt: addHours(now, 24)
  });

  return { url: session.url, expiresAt: session.expires_at };
}
```

```sql
CREATE TABLE payment_links (
  id               BIGINT PRIMARY KEY AUTO_INCREMENT,
  lead_id          INT NOT NULL,
  stripe_session_id VARCHAR(255),
  amount           DECIMAL(10,2),
  url              TEXT,
  status           ENUM('pending','paid','expired','cancelled') DEFAULT 'pending',
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at       TIMESTAMP,
  paid_at          TIMESTAMP NULL
);
```

Stripe webhook handler for `checkout.session.completed`:
```typescript
case 'checkout.session.completed': {
  const session = event.data.object;
  const leadId = Number(session.metadata?.leadId);
  await Promise.all([
    db.update(paymentLinks).set({ status: 'paid', paidAt: new Date() }).where(eq(paymentLinks.stripeSessionId, session.id)),
    updateLeadStage(leadId, 'won'),
    notifyOwner({ title: 'Payment Received', content: `$${(session.amount_total! / 100).toFixed(2)} from lead ${leadId}` }),
  ]);
}
```

### 4.4 Proof workflow (lightweight)

GHL custom field `proofStatus` (values: pending, approved, revision_requested). Webhook subscription for custom field changes → enqueue outbox with `trigger: 'proof_ready'` or `trigger: 'revision_requested'`.

**Gate to Phase 5:** At least one real quote generated via getQuote tool. At least one Stripe payment link created. bookAppointment tested against GHL calendar.

---

## Phase 5 — Real-Time Learning + LoRA Pipeline (Week 4–5)

### 5.1 New table: `segment_weights`

```sql
CREATE TABLE segment_weights (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  segment     VARCHAR(50) NOT NULL,
  channel     VARCHAR(20) NOT NULL,
  stage       VARCHAR(50) NOT NULL,
  approach    VARCHAR(100) NOT NULL,
  wins        INT DEFAULT 0,
  losses      INT DEFAULT 0,
  win_rate    DECIMAL(5,2),
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_combo (segment, channel, stage, approach)
);
```

### 5.2 Outcome recording

```typescript
// When reply received within 72h of an AI message:
await db.insert(segmentWeights)
  .values({ segment, channel, stage, approach, wins: 1, losses: 0 })
  .onDuplicateKeyUpdate({ wins: sql`wins + 1`, updatedAt: sql`NOW()` });

// When no reply after 72h:
await db.insert(segmentWeights)
  .values({ segment, channel, stage, approach, wins: 0, losses: 1 })
  .onDuplicateKeyUpdate({ losses: sql`losses + 1`, updatedAt: sql`NOW()` });

// Recalculate win_rate
await db.update(segmentWeights)
  .set({ winRate: sql`wins / (wins + losses)` })
  .where(eq(segmentWeights.id, row.id));
```

### 5.3 Dynamic prompt injection

```typescript
export async function getTopApproaches(segment: string, channel: string, stage: string, n = 3) {
  return db.select().from(segmentWeights)
    .where(and(
      eq(segmentWeights.segment, segment),
      eq(segmentWeights.channel, channel),
      eq(segmentWeights.stage, stage),
      sql`(wins + losses) >= 3`
    ))
    .orderBy(desc(segmentWeights.winRate))
    .limit(n);
}

export async function getAvoidApproaches(segment: string, channel: string, n = 3) {
  return db.select().from(segmentWeights)
    .where(and(
      eq(segmentWeights.segment, segment),
      eq(segmentWeights.channel, channel),
      sql`(wins + losses) >= 3`,
      lt(segmentWeights.winRate, 0.1)
    ))
    .orderBy(asc(segmentWeights.winRate))
    .limit(n);
}
```

### 5.4 LoRA Fine-Tuning Pipeline Rewiring

**KEEP** `fine-tuning-pipeline.ts` — preserve the full auto-promote/rollback logic.

**REWRITE** `training-export.ts` to generate pairs from `decision_log`:

```typescript
async function generateTrainingPairs(filter: ExportFilter): Promise<TrainingPair[]> {
  const currentPromptVersion = await getActivePromptVersion();
  
  const outcomes = await db.execute(sql`
    SELECT dl.*, l.*, mo.*
    FROM decision_log dl
    JOIN message_outcomes mo ON mo.auditId = dl.id
    JOIN leads l ON l.id = dl.leadId
    WHERE (mo.gotReply = 1 AND mo.replyType NOT IN ('dnc', 'complaint', 'confusion'))
       OR mo.converted = 1
    AND dl.prompt_version = ${currentPromptVersion}
    AND dl.output_guard_result = 'pass'
    AND dl.message IS NOT NULL
    AND LENGTH(dl.message) >= 20
    AND dl.confidence >= 60
    ORDER BY dl.createdAt DESC
    LIMIT 500
  `);

  for (const row of outcomes) {
    const systemPrompt = await buildSystemPromptForTraining(row);
    const messages = buildTrainingMessages(row, systemPrompt);
    pairs.push({ messages });
  }
}
```

**Include tool calls in training pairs:**

```typescript
function buildTrainingMessages(row: ExportRow, systemPrompt: string): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: row.inboundMessage 
        ? `Incoming message: ${row.inboundMessage}`
        : `Outreach trigger: ${row.trigger}` },
  ];

  if (row.toolsCalled?.length) {
    messages.push({
      role: 'assistant', content: null,
      tool_calls: row.toolsCalled.map((tc, i) => ({
        id: `call_${i}`, type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    });
    for (let i = 0; i < row.toolsCalled.length; i++) {
      messages.push({
        role: 'tool', tool_call_id: `call_${i}`,
        content: JSON.stringify(row.toolsCalled[i].result),
      });
    }
  }

  messages.push({ role: 'assistant', content: row.sentMessage });
  return messages;
}
```

**Minimum training pair guard:**
```typescript
const MIN_PAIRS_TO_TRAIN = 50;
if (pairs.length < MIN_PAIRS_TO_TRAIN) {
  await logFinetuneSkipped({ reason: 'insufficient_data', pairsAvailable: pairs.length });
  return;
}
```

**Model selection in single-brain.ts:**
```typescript
async function getActiveModel(): Promise<string> {
  const [promoted] = await db.select().from(fineTuningJobs)
    .where(and(eq(fineTuningJobs.promoted, 1), eq(fineTuningJobs.abTestActive, 0)))
    .orderBy(desc(fineTuningJobs.promotedAt))
    .limit(1);
  if (promoted?.fineTunedModel) return promoted.fineTunedModel;
  return 'gpt-4.1-mini';
}
```

**A/B test prompt version anchor:**
```typescript
// When starting A/B test:
await db.update(fineTuningJobs).set({ 
  abTestActive: 1,
  abTestStartedAt: new Date(),
  abTestPromptVersion: await getActivePromptVersion(),
}).where(eq(fineTuningJobs.id, jobId));

// When evaluating: only count decisions made under the anchored prompt version
```

### 5.5 Confusion Detection (Self-Repair)

In `webhook-message.ts`, after receiving inbound message:

```typescript
import { CONFUSION_PATTERNS } from './signal-patterns';

if (CONFUSION_PATTERNS.some(p => p.test(message.body))) {
  await flagPriorAIMessage(lead.id, 'confusion_detected');
  await enqueueOutbox({
    leadId: lead.id,
    idemKey: makeIdemKey(lead.id, `confusion_recovery:${message.body.slice(0,30)}`),
    source: 'webhook',
    scheduledAt: now,
    payload: { trigger: 'confusion_recovery', confusedReply: message.body }
  });
}
```

### 5.6 Post-Send Check (Self-Review)

In `outbox-worker.ts`, after successful send:

```typescript
async function postSendCheck(lead: Lead, decision: BrainDecision, row: OutboxRow): Promise<void> {
  if (row.payload.trigger === 'inbound_reply') return;
  
  const messageWords = decision.message?.toLowerCase() ?? '';
  if (lead.businessName && messageWords.includes('your ') && 
      !messageWords.includes(lead.businessName.toLowerCase().split(' ')[0])) {
    await db.update(decisionLog)
      .set({ flaggedForReview: 1, flagReason: 'potential_wrong_business' })
      .where(eq(decisionLog.outboxId, row.id));
  }
}
```

---

## Phase 6 — Dashboard (Week 5–6)

### 6.1 Pages to keep

| Page | Change |
|---|---|
| Dashboard | Replace with: messages sent / replies / quotes sent / deals closed / revenue |
| Hot Leads | Keep — leads scoring 80+ |
| All Leads | Keep — searchable table |
| Lead Detail | Keep — conversation + single brain audit trail from decision_log |
| Review Queue | Extend Handoff Queue with "Flagged Messages" tab |

### 6.2 Review Queue dual-tab

| Tab | Content |
|---|---|
| Agent Handoffs | Leads where `routeToHuman = true` in last decision |
| Flagged Messages | `decision_log` rows where `flagged_for_review = 1`, unacknowledged |

Flagged message cards: lead name, sent message, flag reason, **Dismiss** button, **Intervene** button.

### 6.3 Revenue dashboard panel

```typescript
getRevenueMetrics: publicProcedure.query(async () => ({
  today: { messagesSent, repliesReceived, quotesSent, dealsClosed, revenueGenerated },
  week: { /* same */ },
  allTime: { /* same */ },
  conversionFunnel: { contacted, replied, quoted, closed }
}));
```

### 6.4 One-click lead controls

- **"Stop messaging"** → sets humanTakeover = 1
- **"Resume messaging"** → sets humanTakeover = 0, enqueues immediate follow-up
- **"Send message now"** → enqueues into outbox with source: 'manual'

### 6.5 Pages to remove

Remove from routing: AI Performance, Brain Council Log, Self-Learning analytics overlay, Webhook Logs UI.

---

## The Complete Self-Learning Architecture

```
FAST LOOP (every decision):
  segment_weights → prompt injection → single brain → send
  → outcome recorded → segment_weights updated
  Latency: real-time. Signal: approach × segment × channel win rates.

WEEKLY LOOP (LoRA):
  decision_log + message_outcomes → quality-filtered training pairs
  → JSONL in single-brain prompt format (including tool call turns)
  → OpenAI fine-tune → A/B at 20% (prompt-version-anchored)
  → auto-promote if +5% win rate with n≥100 per arm
  Model itself gets smarter. Compounds weekly.

REPAIR LOOP (per inbound):
  confusion detected in reply → prior message flagged as negative outcome
  → outbox enqueued with trigger: 'confusion_recovery'
  → single brain sees confused reply in history → self-corrects
  No automatic apologies. Natural correction through conversation.
```

---

## Target State After All 6 Phases

| Metric | Now | Target |
|---|---|---|
| Production LOC | 30,552 | ~8,000–10,000 |
| Server files | 67 | ~40 |
| LLM calls per message | 4–8 | 1–2 (+ tool calls) |
| Background timers | 20 | 11 |
| Hard rules | 47 | 5 (in TypeScript middleware) |
| Pricing hallucination | Possible | Impossible (getQuote tool enforced) |
| Duplicate-send risk | Mitigated by cooldown stack | Eliminated by outbox idempotency |
| False-block rate | ~80% | <5% |
| Deal-closing capability | None | Quote + Payment + Appointment |
| AI participation rate | 19.6% | Target: 55–70% |
| Cost per message | 4–8 LLM calls | 1–2 LLM calls |
| Self-learning | 90-day pattern analysis | Real-time segment_weights + weekly LoRA |

---

## Risk & Rollback at Each Gate

| Phase | Risk | Rollback |
|---|---|---|
| 0 | Duplicate sends spike | Revert `DB_SEND_COOLDOWN_MS` to 90s in env |
| 1 | Outbox worker bug drops messages | Keep direct-send path as fallback; `USE_OUTBOX=false` |
| 2 | Single brain reply rate drops | `SINGLE_BRAIN_PCT=0` — instant revert to legacy |
| 3 | Delete causes import errors | Git revert the delete commit |
| 4 | Stripe/GHL calendar failures | Disable tools in brain prompt; fallback to manual |
| 5 | Learning weights corrupt | Recalculate win_rate from raw wins/losses counts |
| 6 | Dashboard breaks | Frontend-only; backend unaffected |

---

## Complete Delete/Keep/Build Ledger

### Files deleted (total: ~8,270 lines)

```
expert-panel.ts, deliberation-judge.ts, closer.ts, objection-handler.ts,
brain-council-review.ts, brain-council.ts, auto-correction.ts, strategist.ts,
composer.ts, researcher.ts, lead-researcher.ts, auto-skill-hunter.ts,
strategy-autopilot.ts, skill-registry.ts, ab-testing.ts, few-shot-retrieval.ts,
error-memory.ts, lookback-engine.ts, deferred-response-processor.ts,
stage-playbook.ts
(20 files)
```

### Files rewritten/simplified (~7,635 lines removed)

```
brain-council-orchestrator.ts, qc.ts, learning-loop.ts, scheduling-engine.ts,
webhook-message.ts, webhook-contact.ts, lead-disposition.ts, db.ts,
brain-types.ts, brain-context.ts, persona-learning.ts, conversation-state.ts
(12 files)
```

### Files built (new, ~1,500 lines)

```
single-brain.ts (~400), outbox-worker.ts (~200), input-guards.ts (~100),
output-guards.ts (~80), pricing-engine.ts (~100), pricing-data.json (~150),
segment-weights.ts (~100), lead-utils.ts (~120), signal-patterns.ts (~40),
stage-behavior.json (~80), stripe.ts (~80), ghl-calendar.ts (~80)
(12 files)
```

### Files kept unchanged

```
ghl.ts, webhook-helpers.ts, webhooks.ts (trim timers), routers.ts (trim dead endpoints),
outcome-engine.ts, follow-up-trigger.ts, webhook-events.ts, webhook-pipeline.ts,
webhook-task.ts, cadence-engine.ts, area-code-timezone.ts, cache.ts, storage.ts,
fb-window-manager.ts, omnisend.ts, lost-lead-nurture.ts, post-delivery-executor.ts,
seasonal-campaign-executor.ts, agent-notifications.ts, action-dispatcher.ts,
fine-tuning-pipeline.ts, training-export.ts (rewritten), intent-classifier.ts,
lead-memory.ts, sla-timer.ts
```

---

## Non-Functional Requirements

1. **All prices must flow through `getQuote` tool** — the LLM never composes prices freehand
2. **All sends flow through the outbox** — no direct GHL sends from any timer or webhook
3. **Prompt is database-driven** — iterations require zero code deploys
4. **Every decision is logged** — full traceability from trigger to send in `decision_log`
5. **LoRA training only uses current prompt version** — no cross-version contamination
6. **A/B tests are prompt-version-anchored** — prompt changes mid-test don't corrupt results
7. **SMS cold outreach uses `\n---\n` split** — system sends as 2 texts with 4-6s delay
8. **Confusion detection is passive** — no auto-apologies, brain self-corrects naturally
9. **Flagged messages surface in UI** — owner decides whether to intervene
10. **Fine-tuning includes tool call turns** — model learns when to call tools, not just what to say
