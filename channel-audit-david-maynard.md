# David Maynard Channel Routing Audit

## What happened
- David submitted FB lead form at 10:34 PM
- System sent EMAIL at 10:35 PM instead of replying on FB
- Three problems: (1) not business hours, (2) wrong channel, (3) email content

## Root cause analysis

### Path: webhook-contact.ts (Contact Created webhook)

The contact created webhook fires when GHL creates a new contact from the FB lead form.
After a 45s delay (for GHL to index), it:

1. Fetches GHL conversation history
2. Extracts form data (3 layers)
3. Detects channel (8 layers)
4. Runs Brain Council
5. Sends message

### Channel detection worked correctly
Layer 0 (form data in conversation body) → detects "FB"
Layer 1 (GHL inbound message type) → would detect type 4 or 11 = "FB"
So `channel = "FB"` at line 574.

### Brain Council overrides channel
Line 600: `runBrainCouncil({ channel: "FB", ... })`
The Strategist LLM returns `strategy.channel = "Email"` (it decided Email was better)
Orchestrator line 1457: returns `channel: strategy.channel` = "Email"

### webhook-contact.ts line 627-628 CORRECTLY forces FB
```js
const isDetectedSocial = ["FB", "IG", "WhatsApp", "Live_Chat"].includes(channel);
let brainChannel = isDetectedSocial ? channel : (brainResult.channel || channel);
```
So `brainChannel = "FB"` (correct!)

### BUT: The message was COMPOSED for Email
The Brain Council Strategist told the Composer to write for Email channel.
The Composer wrote an email-formatted message with email subject line.
Then `buildSendOpts("FB", emailFormattedMessage, ...)` sends it as FB.

### WAIT — the screenshot shows "Email • 10:35 PM"
This means an EMAIL was actually sent, not FB. So either:
1. The channel detection FAILED and defaulted to SMS/Email at Layer 8
2. OR the message went through a different code path

### Most likely scenario
The GHL conversation history was EMPTY at the 45s mark (GHL hadn't indexed the FB form yet).
Layer 0: formExtractedFromConversation = false (no inbound msgs in ghlHistory)
Layer 1-7: all miss
Layer 8: lead has email AND phone → `detectedChannel = "SMS"` (line 563)

Then the Strategist chose "Email" → Brain Council returned "Email"
Line 627: `isDetectedSocial = false` (channel is "SMS", not social)
Line 628: `brainChannel = brainResult.channel || channel` = "Email"

### ALSO: No business hours gate
There is NO business hours check in webhook-contact.ts for the immediate send path.
`shouldDeferResponse()` at line 645 returns false at 10:34 PM (outside business hours).
So the message goes straight to the immediate send path at line 693.

## Three fixes needed

### Fix 1: Business hours should NOT gate inbound replies
Per user: "when a client submits a lead we can reach back right away in same channel"
Business hours only applies to proactive SMS outreach.
FB/IG/Email replies can go out anytime.
This is ALREADY correct in webhook-contact.ts — no business hours gate.

### Fix 2: Channel detection must not fall through to Layer 8
When GHL history is empty but form data exists, the channel should be FB.
Add a new check: if formFields.length > 0 AND source contains "facebook"/"fb", force FB.

### Fix 3: Brain Council must compose for the CORRECT channel
The Strategist must receive and respect the inbound channel.
If `isInboundReply = true` and `channel = "FB"`, the Strategist MUST compose for FB.
The orchestrator should enforce: `strategy.channel = input.channel` for inbound replies.

## Files to change
1. `webhook-contact.ts` — strengthen channel detection when GHL history is empty
2. `brain-council-orchestrator.ts` — enforce inbound channel in strategy
3. `strategist.ts` — add inbound channel awareness to prompt
