# Single Brain Prompt Quality Assessment

## Summary Rating: Level 3 (Solid Intermediate) — NOT Level 4-5

## Evidence

### What's Working (Level 3 indicators):
1. **Clear hard constraints** — 10 explicit "NEVER" rules
2. **Structured context injection** — lead data, memory, history, AI state all templated
3. **Tool-augmented accuracy** — getQuote prevents hallucinated prices
4. **Stage-aware behavior** — 9 stages with objective/signals/avoid
5. **Brand voice guide** — channel-specific voice rules
6. **Persona playbooks** — 8 customer segments with tailored approaches
7. **Output guards** — 6 deterministic post-generation safety checks

### What's Missing for Level 4-5:

1. **No chain-of-thought / reasoning scaffold** — The prompt says "decide what to do" but doesn't guide HOW to reason. Level 4-5 prompts include explicit reasoning steps: "First analyze the lead's last message intent, then check stage alignment, then select approach, then compose."

2. **No few-shot examples in the system prompt** — The prompt describes behavior but never SHOWS it. Level 4-5 prompts include 3-5 gold-standard input/output pairs demonstrating ideal behavior for tricky scenarios.

3. **No self-critique / reflection loop** — The two-step LLM loop is purely tool-use → finalize. Level 4-5 systems include a "review your draft against these criteria before finalizing" step.

4. **No dynamic context selection** — The prompt dumps ALL context every time (brand voice, competitive intel, seasonal calendar, persona playbooks, escalation rules). Level 4-5 systems select relevant context based on the situation, reducing noise and improving focus.

5. **No explicit decision tree** — The prompt has stage behaviors but no explicit "if X then Y" decision logic for common scenarios (e.g., "if lead hasn't responded in 7+ days AND you've sent 3+ messages, use breakup framework"). The constraints mention breakup rules but don't structure the decision.

6. **No tone/register calibration** — Beyond "like a text from a friend," there's no nuanced register control. Level 4-5 prompts calibrate formality based on the lead's own language patterns.

7. **No anti-pattern library with corrections** — The prompt says what NOT to do but doesn't show the corrected version. Level 4-5 prompts include "BAD: ... → GOOD: ..." pairs.

8. **Weak JSON output enforcement** — Uses a "respond with JSON matching this schema" instruction but no response_format constraint. The parseDecision() fallback (confidence: 30) suggests this fails regularly enough to need a safety net.

9. **No conversation-flow awareness** — The prompt doesn't explicitly model conversational dynamics (e.g., "if lead asked a question, answer it FIRST before advancing your agenda").

10. **Token bloat** — Injecting full PERSONA_PLAYBOOKS (all 8 personas), full COMPETITIVE_INTEL, full SEASONAL_CALENDAR, and full ESCALATION_RULES on every call regardless of relevance wastes context window and dilutes signal.

## Production Reality Check

**CRITICAL**: The prompt_versions table shows `abTrafficPercent = 0`, meaning the single brain is NOT being used in production at all. All traffic is still going through the legacy Brain Council path. The single brain has only been tested via the outbox worker's Path B, which is currently gated at 0%.

## Recommendation

The prompt is a solid v1 that works because of the surrounding infrastructure (output guards, pricing engine, stage behavior data). But the prompt text itself is a straightforward "role + rules + context dump + output format" pattern — this is Level 3.

To reach Level 4-5:
- Add structured reasoning steps (think → plan → compose → self-check)
- Add few-shot examples for the 5 most common scenarios
- Use response_format: json_schema for reliable structured output
- Implement dynamic context selection (only inject relevant persona/seasonal/competitive info)
- Add explicit decision trees for high-stakes scenarios
- Add anti-pattern corrections as examples
