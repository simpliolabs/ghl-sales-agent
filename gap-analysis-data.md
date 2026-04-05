# Adorb Outreach System - Raw Data Findings

## Database Stats (Apr 5, 2026)

### Lead Inventory
- Total leads: 1,630
- With GHL ID: 1,630 (100%)
- With email: 798 (49%)
- With phone: 1,309 (80%)
- With business name: 169 (10%)

### Scoring
- Scored: 1,630 (100%)
- Average score: 50
- Hot (80+): 4
- Warm (50-79): 1,524
- Cold (<50): 102

### Agent Assignments
- Abby Bouwer: 6
- Chris McHendry: 6
- UNASSIGNED: 1,618 (99.3%)

### Engagement Funnel
- AI contacted: 1,541 / 1,630 (95%)
- Replied: 701 / 1,541 (45%)
- Never contacted: 89
- Human takeover: 0
- Leads with research: 0

### Conversation Stats
- Total messages: 9,613
- Outbound: 7,286
- Inbound: 2,327
- Avg messages per lead: 6.2
- Outbound by AI: 9
- Outbound by Human: 7,277
- Leads with inbound but no outbound (MISSED): 16

### Channel Distribution
- SMS: 9,594
- Facebook: 14
- InboundMessage: 5

### Engagement Freshness
- Active (7d): 15
- Stale (30d+): 0
- Never messaged: 1,615

### Conversion Funnel
- new_lead: 522
- contacted: 730
- quote_sent: 40
- approved: 2
- delivered: 7
- not_qualified: 326
- Contact rate: 68%
- Quote rate (of contacted): 5%
- Close rate (of contacted): 1%

### Follow-ups
- Scheduled: 1,630
- Overdue: 20

### Pipeline Value
- Leads with value: 24
- Total pipeline: $9,199

### Brain Council
- Audits: 7
- Blocked: 0
- Knowledge base: 1 file

### Webhooks
- Total logged: 17
- Unknown type: 10 (59%)

### AI State
- Records: 6
- Circuit-broken: 0

## Code Architecture
- brain-council.ts: 1,287 lines
- webhooks.ts: 1,386 lines
- auto-correction.ts: 310 lines
- ghl.ts: 193 lines
- db.ts: 401 lines
- routers.ts: 258 lines
- Total server code: 3,835 lines
