# Architecture Map — Pre-Refactor

## webhooks.ts (1386 lines) — SPLIT INTO:

### Shared utilities (webhook-utils.ts)
- GHL_CUSTOM_FIELD_IDS constant
- extractGhlFormData(customFields)
- resolveGhlContactId(contactId, email, phone)
- extractContactData(ghlContact)
- sendMessageWithRetry(contactId, message, channel, leadId)
- normalizeChannel(type)
- detectEventType(payload)
- addWebhookLog() calls

### contact-handler.ts
- handleContactWebhook(payload, detectedType)
  - Creates/updates lead
  - Assigns agent via handleStageAutomation
  - LOCKED first-contact template (2 messages)
  - Form data extraction from GHL custom fields
  - Imports: db.*, ghl.*, webhook-utils.*

### message-handler.ts
- handleMessageWebhook(payload, detectedType)
  - Processes inbound/outbound messages
  - Runs Brain Council for follow-ups
  - Confusion detection + auto-correction
  - Post-send validation
  - Imports: db.*, ghl.*, brain-council.*, auto-correction.*, webhook-utils.*

### pipeline-handler.ts
- handlePipelineWebhook(payload)
  - Stage transitions
  - Notifications
  - Imports: db.*, ghl.*, webhook-utils.*

### task-handler.ts
- handleTaskWebhook(payload)
  - Task creation
  - Imports: db.*, ghl.*, webhook-utils.*

### webhook-router.ts (new entry point)
- createWebhookRouter()
  - Unified POST /api/webhooks/ghl
  - GET /api/webhooks/health
  - Event detection → route to handler
  - Webhook logging
  - Retroactive correction scan timer
  - Imports: all handlers, webhook-utils

## brain-council.ts (1288 lines) — SPLIT INTO:

### brain-types.ts
- BrainCouncilInput, StrategyDecision, ResearchResult, ComposedMessage, QCVerdict, BrainCouncilOutput
- ViolationCategory type

### brain-context.ts
- buildLeadContext(leadId)

### strategist.ts
- STRATEGIST_PROMPT
- runStrategist(input, context)

### researcher.ts
- RESEARCHER_PROMPT
- runResearcher(input, context, strategy)

### composer.ts
- COMPOSER_PROMPT
- runComposer(input, context, strategy, research)

### qc.ts
- QC_PROMPT
- runQC(input, context, strategy, composed)
- detectViolations(composed, qc, strategy, context, input, research)

### brain-accountability.ts
- buildSafeFallback(context, input)
- checkCircuitBreaker(leadId)
- updateCircuitBreaker(leadId, failed)
- notifyOwnerOfViolation(...)

### brain-council.ts (new orchestrator — ~150 lines)
- runBrainCouncil(input) — coordinates all brains
- Imports: all brain modules

## auto-correction.ts (stays as-is, already clean)

## Dependency order:
1. brain-types.ts (no deps)
2. brain-context.ts (deps: db, drizzle/schema)
3. strategist.ts (deps: brain-types, brain-context, llm)
4. researcher.ts (deps: brain-types, brain-context, llm)
5. composer.ts (deps: brain-types, brain-context, llm)
6. qc.ts (deps: brain-types, brain-context, llm)
7. brain-accountability.ts (deps: brain-types, brain-context, db, notification)
8. brain-council.ts orchestrator (deps: all above)
9. webhook-utils.ts (deps: db, ghl)
10. contact-handler.ts (deps: db, ghl, webhook-utils)
11. message-handler.ts (deps: db, ghl, brain-council, auto-correction, webhook-utils)
12. pipeline-handler.ts (deps: db, ghl, webhook-utils)
13. task-handler.ts (deps: db, ghl, webhook-utils)
14. webhook-router.ts (deps: all handlers, webhook-utils)
