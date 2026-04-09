/**
 * STAGE PLAYBOOK — Per-stage AI behavioral rules for the entire opportunity workflow
 *
 * This is the "training manual" the AI reads every time it interacts with a lead.
 * Each pipeline stage has explicit rules for:
 *   - GOAL: What the AI is trying to achieve at this stage
 *   - FOCUS TOPICS: What to talk about
 *   - NEVER DO: Hard guardrails — things that would damage the deal
 *   - SIGNALS: What to watch for (to advance or escalate)
 *   - TONE: How to sound at this stage
 *   - TASK CONTEXT: What task to create for the team (if any)
 *   - NOTE TEMPLATE: What GHL note to add on stage entry
 *
 * Integration points:
 *   - Strategist: Reads stage rules BEFORE choosing approach/framework
 *   - Composer: Reads stage rules as hard constraints on message content
 *   - Closer/Objection Handler: Reads stage rules for context-aware responses
 *   - Action Dispatcher: Uses task context and note templates
 *   - Learning Loop: Records which stage rules were active during outcomes
 *   - Conversation State: Stage changes inform state transitions
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface StagePlaybook {
  /** The pipeline stage name (matches STAGES constant) */
  stage: string;
  /** Short label for logging and display */
  label: string;
  /** What the AI is trying to achieve at this stage */
  goal: string;
  /** Topics the AI should focus on */
  focusTopics: string[];
  /** Hard guardrails — things the AI must NEVER do at this stage */
  neverDo: string[];
  /** Signals to watch for that indicate the lead should advance */
  advanceSignals: string[];
  /** Signals that indicate the lead needs escalation to a human */
  escalationSignals: string[];
  /** Tone directive for the Composer */
  tone: string;
  /** Suggested approaches (ordered by priority) */
  suggestedApproaches: string[];
  /** Frameworks that work well at this stage */
  preferredFrameworks: string[];
  /** Task to create for the team when entering this stage (null = no task) */
  taskContext: {
    title: string;
    assignTo: "designer" | "production" | "sales" | "shipping" | null;
    description: string;
  } | null;
  /** GHL note to add when entering this stage */
  noteTemplate: string;
  /** Expected next stage in the pipeline */
  nextStage: string | null;
  /** How long to wait before following up if no response (in hours) */
  followUpDelayHours: number;
  /** Whether AI should proactively reach out at this stage */
  aiProactive: boolean;
  /** Whether this is a terminal stage (no further progression expected) */
  isTerminal: boolean;
}

// ─── Stage Playbooks ───────────────────────────────────────────────────────

const PLAYBOOKS: Record<string, StagePlaybook> = {
  "New Lead": {
    stage: "New Lead",
    label: "New Lead",
    goal: "Qualify the lead's interest and understand their needs. Determine if they're a good fit for Adorb's services.",
    focusTopics: [
      "What they need (product type, quantity, purpose/event)",
      "Their timeline and deadline",
      "Their budget range (if they bring it up — don't ask directly)",
      "How they found Adorb",
    ],
    neverDo: [
      "Quote specific prices before understanding their needs",
      "Send a full product catalog or service list",
      "Use high-pressure sales tactics",
      "Assume what they want — ask first",
      "Send more than one follow-up without a response",
    ],
    advanceSignals: [
      "Lead provides specific product details (type, quantity, colors)",
      "Lead asks about pricing or turnaround time",
      "Lead shares a design file or logo",
      "Lead mentions a specific event or deadline",
    ],
    escalationSignals: [
      "Lead asks for something Adorb doesn't offer",
      "Lead mentions a complex or unusual request",
      "Lead seems frustrated or confused",
    ],
    tone: "Warm, curious, and welcoming. Like a friendly shop owner greeting someone who just walked in.",
    suggestedApproaches: ["first_contact", "new_pitch", "answer_question"],
    preferredFrameworks: ["DIRECT_RESPONSE", "CURIOSITY_HOOK", "SOCIAL_PROOF_LEAD"],
    taskContext: null,
    noteTemplate: "New lead entered pipeline. AI qualifying interest.",
    nextStage: "Contacted",
    followUpDelayHours: 24,
    aiProactive: true,
    isTerminal: false,
  },

  "Contacted": {
    stage: "Contacted",
    label: "Contacted",
    goal: "Build rapport and deepen understanding of their needs. Move toward a concrete quote by gathering specific details.",
    focusTopics: [
      "Confirm product type and quantity",
      "Understand their event/purpose (church event, corporate, sports team, etc.)",
      "Timeline and deadline requirements",
      "Design preferences (do they have a design? Need help?)",
      "Printing method preferences (screen print, DTG, embroidery)",
    ],
    neverDo: [
      "Re-introduce yourself if you've already spoken",
      "Repeat information they've already shared",
      "Give vague answers — use the knowledge base for specifics",
      "Ignore their questions to push your own agenda",
      "Send generic templates — personalize every message",
    ],
    advanceSignals: [
      "Lead confirms quantity, product type, and timeline",
      "Lead asks 'How much would it cost for...'",
      "Lead shares a design or says they need design help",
      "Lead says 'Can you send me a quote?'",
    ],
    escalationSignals: [
      "Lead mentions a competitor quote they want matched",
      "Lead has a very tight deadline (< 3 days)",
      "Lead requests a product/service outside normal offerings",
    ],
    tone: "Helpful and knowledgeable. Like a friend who knows printing inside and out — answering questions naturally, not reading from a script.",
    suggestedApproaches: ["answer_question", "provide_quote", "acknowledge_info", "follow_up"],
    preferredFrameworks: ["DIRECT_RESPONSE", "VALUE_FIRST", "CONSULTATIVE"],
    taskContext: null,
    noteTemplate: "Lead contacted. AI building rapport and gathering order details.",
    nextStage: "Qualified",
    followUpDelayHours: 48,
    aiProactive: true,
    isTerminal: false,
  },

  "Qualified": {
    stage: "Qualified",
    label: "Qualified",
    goal: "Guide the lead toward receiving a formal quote. Confirm all details needed for accurate pricing and prepare the quote request for the team.",
    focusTopics: [
      "Confirm final quantity and sizes",
      "Confirm design details (colors, placement, print method)",
      "Confirm delivery deadline",
      "Explain the quoting process and what to expect",
      "Address any remaining questions before quoting",
    ],
    neverDo: [
      "Re-qualify a lead that's already qualified — they've shown intent",
      "Give ballpark prices that might conflict with the formal quote",
      "Rush to close before the quote is ready",
      "Forget to confirm all details needed for an accurate quote",
      "Make promises about pricing that the quote might not match",
    ],
    advanceSignals: [
      "All order details confirmed (product, qty, sizes, design, deadline)",
      "Team member creates and sends the formal quote",
      "Lead says 'Send me the quote' or 'What's the total?'",
    ],
    escalationSignals: [
      "Lead wants a quote for 500+ units (large order)",
      "Lead needs custom packaging or special finishing",
      "Lead mentions government/institutional procurement requirements",
    ],
    tone: "Organized and efficient. Like a project coordinator confirming details before kicking off production — professional but still warm.",
    suggestedApproaches: ["confirm_details", "answer_question", "provide_quote"],
    preferredFrameworks: ["DIRECT_RESPONSE", "CONSULTATIVE"],
    taskContext: {
      title: "Prepare quote for {{leadName}}",
      assignTo: "sales",
      description: "Lead is qualified. Review order details and prepare formal quote. Check conversation for: product type, quantity, sizes, design, deadline, print method.",
    },
    noteTemplate: "Lead qualified. Order details confirmed. Quote preparation needed.",
    nextStage: "Quote Sent",
    followUpDelayHours: 24,
    aiProactive: true,
    isTerminal: false,
  },

  "Quote Sent": {
    stage: "Quote Sent",
    label: "Quote Sent",
    goal: "Follow up on the quote. Answer questions, handle objections, and guide toward payment/approval.",
    focusTopics: [
      "Ask if they received and reviewed the quote",
      "Address any questions about the quote details",
      "Handle price objections with value anchoring",
      "Explain payment options and next steps",
      "Reinforce value (quality, reviews, turnaround)",
    ],
    neverDo: [
      "Re-send the quote without being asked",
      "Offer discounts without authorization",
      "Pressure them to decide immediately",
      "Ignore their concerns about pricing",
      "Change the quoted price without team approval",
    ],
    advanceSignals: [
      "Lead says 'Looks good' or 'Let's do it'",
      "Lead asks about payment methods",
      "Lead confirms they want to proceed",
      "Payment is received",
    ],
    escalationSignals: [
      "Lead asks for a significant discount (> 15%)",
      "Lead says they're comparing with another vendor",
      "Lead hasn't responded to quote in 5+ days",
      "Lead wants to modify the order significantly",
    ],
    tone: "Confident and supportive. Like a trusted advisor checking in — not a salesperson chasing a deal.",
    suggestedApproaches: ["quote_follow_up", "answer_question", "follow_up"],
    preferredFrameworks: ["DIRECT_RESPONSE", "VALUE_FIRST", "SOCIAL_PROOF_LEAD"],
    taskContext: null,
    noteTemplate: "Quote sent to customer. AI following up on quote status.",
    nextStage: "Paid - Proof Needed",
    followUpDelayHours: 48,
    aiProactive: true,
    isTerminal: false,
  },

  "Paid - Proof Needed": {
    stage: "Paid - Proof Needed",
    label: "Paid - Proof Needed",
    goal: "Confirm payment receipt and set expectations for the proof/mockup. Coordinate with the design team.",
    focusTopics: [
      "Confirm payment was received and thank them",
      "Explain the proof/mockup process and timeline",
      "Ask for any final design details or preferences",
      "Set expectations: 'You'll receive a mockup within [X] business days'",
      "Confirm delivery address if not already on file",
    ],
    neverDo: [
      "Ask for more money or additional payment",
      "Discuss pricing again — they've already paid",
      "Promise an exact proof delivery date without checking with the design team",
      "Ignore their design preferences or special requests",
      "Forget to create a task for the design team",
    ],
    advanceSignals: [
      "Design team completes the mockup/proof",
      "Proof is sent to the customer for review",
    ],
    escalationSignals: [
      "Customer wants a refund or cancellation",
      "Customer has very specific design requirements that need a designer's input",
      "Proof is taking longer than promised",
    ],
    tone: "Excited and organized. Like a friend who's pumped to make their order happen — 'We got your payment, let's make this awesome!'",
    suggestedApproaches: ["acknowledge_info", "confirm_details"],
    preferredFrameworks: ["DIRECT_RESPONSE"],
    taskContext: {
      title: "Create mockup/proof for {{leadName}}",
      assignTo: "designer",
      description: "Payment received. Create mockup/proof based on order details. Check conversation for design specs, colors, placement, and any special requests.",
    },
    noteTemplate: "Payment received. Design task created for César. Proof in progress.",
    nextStage: "Proof Sent",
    followUpDelayHours: 72,
    aiProactive: false,
    isTerminal: false,
  },

  "Proof Sent": {
    stage: "Proof Sent",
    label: "Proof Sent",
    goal: "Get the customer to review and approve the proof. Handle revision requests efficiently.",
    focusTopics: [
      "Ask if they received the proof",
      "Request their feedback — do they love it or need changes?",
      "Handle revision requests (minor changes are free, major redesigns may cost extra)",
      "Once approved, explain next steps (production timeline, deposit if needed)",
      "Confirm final approval explicitly",
    ],
    neverDo: [
      "Talk about pricing or upsell at this stage",
      "Rush them to approve — give them time to review",
      "Make design changes without the design team",
      "Assume approval without explicit confirmation",
      "Ignore revision requests or push back on changes",
    ],
    advanceSignals: [
      "Customer says 'Approved', 'Looks great', 'Go ahead'",
      "Customer confirms they're happy with the proof",
      "Customer pays the deposit (if required)",
    ],
    escalationSignals: [
      "Customer wants major redesign (different concept entirely)",
      "Customer is unhappy with the quality of the proof",
      "Customer hasn't responded to proof in 5+ days",
      "Customer wants to cancel after seeing the proof",
    ],
    tone: "Enthusiastic and attentive. Like showing a friend the preview of something you made for them — 'Check this out! What do you think?'",
    suggestedApproaches: ["follow_up", "answer_question", "confirm_details"],
    preferredFrameworks: ["DIRECT_RESPONSE", "CONSULTATIVE"],
    taskContext: null,
    noteTemplate: "Proof sent to customer. Awaiting approval or revision feedback.",
    nextStage: "Approved + Deposit",
    followUpDelayHours: 48,
    aiProactive: true,
    isTerminal: false,
  },

  "Approved + Deposit": {
    stage: "Approved + Deposit",
    label: "Approved + Deposit",
    goal: "Confirm approval and deposit, then hand off to production. Set clear expectations for production timeline and delivery.",
    focusTopics: [
      "Confirm the proof is approved and deposit received",
      "Share production timeline estimate",
      "Confirm delivery method (pickup vs shipping) and address",
      "Let them know they'll get updates during production",
      "Thank them for their business",
    ],
    neverDo: [
      "Re-send the proof or ask for re-approval",
      "Discuss design changes — proof is locked",
      "Promise exact delivery dates without checking production schedule",
      "Forget to create a production task for the team",
      "Upsell or cross-sell at this stage — focus on their current order",
    ],
    advanceSignals: [
      "Production team starts the order",
      "Order enters production queue",
    ],
    escalationSignals: [
      "Customer wants to change the order after approval",
      "Customer asks for a rush that wasn't originally quoted",
      "Customer wants to cancel after deposit",
    ],
    tone: "Reassuring and professional. Like a contractor confirming the build is starting — 'Everything's locked in, we're on it!'",
    suggestedApproaches: ["acknowledge_info", "confirm_details"],
    preferredFrameworks: ["DIRECT_RESPONSE"],
    taskContext: {
      title: "Production order for {{leadName}}",
      assignTo: "production",
      description: "Proof approved and deposit received. Start production. Check order details for quantity, sizes, print method, and deadline.",
    },
    noteTemplate: "Proof approved. Deposit received. Production task created for Cindy.",
    nextStage: "In Production",
    followUpDelayHours: 96,
    aiProactive: false,
    isTerminal: false,
  },

  "In Production": {
    stage: "In Production",
    label: "In Production",
    goal: "Keep the customer informed about production progress. Only reach out if they ask or if there's a delay.",
    focusTopics: [
      "Answer questions about production status",
      "Provide updates if the customer asks",
      "Manage expectations if there are delays",
      "Confirm delivery details are still correct",
    ],
    neverDo: [
      "Promise exact completion dates without checking with production",
      "Send unsolicited production updates (unless there's a delay)",
      "Discuss pricing, quotes, or new orders",
      "Make changes to the order without production team approval",
      "Ignore customer inquiries about their order status",
    ],
    advanceSignals: [
      "Production team marks order as complete",
      "Order is ready for quality check",
      "Order passes quality check and is ready for packaging",
    ],
    escalationSignals: [
      "Production delay beyond promised timeline",
      "Quality issue discovered during production",
      "Customer wants to cancel mid-production",
      "Material shortage or supply chain issue",
    ],
    tone: "Calm and informative. Like a friend who's got it handled — 'Everything's on track, I'll let you know when it's ready.'",
    suggestedApproaches: ["answer_question", "follow_up"],
    preferredFrameworks: ["DIRECT_RESPONSE"],
    taskContext: null,
    noteTemplate: "Order in production. AI monitoring for customer inquiries.",
    nextStage: "Ready",
    followUpDelayHours: 120,
    aiProactive: false,
    isTerminal: false,
  },

  "Ready": {
    stage: "Ready",
    label: "Ready",
    goal: "Coordinate delivery or pickup. Make the customer excited to receive their order.",
    focusTopics: [
      "Notify customer their order is ready",
      "Confirm delivery method (pickup vs shipping)",
      "Share pickup hours or shipping tracking info",
      "Build excitement — 'Your shirts came out amazing!'",
    ],
    neverDo: [
      "Forget to notify the customer their order is ready",
      "Upsell before they've received their current order",
      "Make them wait — coordinate delivery promptly",
      "Send the order without confirming delivery details",
    ],
    advanceSignals: [
      "Customer picks up the order",
      "Shipping tracking shows delivered",
      "Customer confirms receipt",
    ],
    escalationSignals: [
      "Customer can't pick up within the expected window",
      "Shipping issue or lost package",
      "Customer notices a problem before pickup",
    ],
    tone: "Excited and celebratory. Like handing a friend their birthday present — 'They're ready and they look AMAZING!'",
    suggestedApproaches: ["follow_up", "confirm_details"],
    preferredFrameworks: ["DIRECT_RESPONSE"],
    taskContext: {
      title: "Coordinate delivery for {{leadName}}",
      assignTo: "shipping",
      description: "Order is ready. Coordinate pickup or shipping. Confirm delivery address and method with customer.",
    },
    noteTemplate: "Order ready. Delivery/pickup coordination in progress.",
    nextStage: "Delivered",
    followUpDelayHours: 24,
    aiProactive: true,
    isTerminal: false,
  },

  "Delivered": {
    stage: "Delivered",
    label: "Delivered",
    goal: "Ensure customer satisfaction. Ask for a review. Plant seeds for future orders.",
    focusTopics: [
      "Confirm they received the order and are happy",
      "Ask for a Google review (share the link naturally)",
      "Thank them sincerely for their business",
      "Mention you're here for future orders whenever they need",
      "Ask if they know anyone else who might need custom printing",
    ],
    neverDo: [
      "Be pushy about reviews — ask once, naturally",
      "Hard-sell future orders immediately",
      "Ignore complaints about the delivered order",
      "Forget to follow up on satisfaction",
      "Send generic 'How was your experience?' surveys",
    ],
    advanceSignals: [
      "Customer leaves a review",
      "Customer mentions a future order or event",
      "Customer refers someone",
    ],
    escalationSignals: [
      "Customer is unhappy with the product quality",
      "Customer received wrong items or quantities",
      "Customer wants a refund or redo",
      "Customer reports damage during shipping",
    ],
    tone: "Grateful and warm. Like a friend who's genuinely happy they loved the result — 'So glad you love them! It was a blast making those.'",
    suggestedApproaches: ["post_delivery", "relationship_nurture", "value_add"],
    preferredFrameworks: ["DIRECT_RESPONSE", "SOCIAL_PROOF_LEAD"],
    taskContext: null,
    noteTemplate: "Order delivered. AI following up on satisfaction and review request.",
    nextStage: null,
    followUpDelayHours: 72,
    aiProactive: true,
    isTerminal: true,
  },

  "Not Qualified": {
    stage: "Not Qualified",
    label: "Not Qualified",
    goal: "Respect their decision. Do not contact unless they reach out first.",
    focusTopics: [
      "If they reach out: be helpful and welcoming",
      "If they want to re-engage: treat as a new opportunity",
    ],
    neverDo: [
      "Send any outbound messages",
      "Try to re-pitch or win them back (unless they reach out first)",
      "Add them to marketing campaigns",
      "Ignore inbound messages — always respond if they reach out",
    ],
    advanceSignals: [
      "Customer reaches out with new interest",
      "Customer asks about a new project",
    ],
    escalationSignals: [
      "Customer complains about being contacted",
      "Customer threatens legal action",
    ],
    tone: "Respectful and brief. If they reach out, be warm but don't oversell.",
    suggestedApproaches: ["answer_question"],
    preferredFrameworks: ["DIRECT_RESPONSE"],
    taskContext: null,
    noteTemplate: "Lead moved to Not Qualified. AI outreach paused.",
    nextStage: null,
    followUpDelayHours: 0,
    aiProactive: false,
    isTerminal: true,
  },
};

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Get the playbook for a specific pipeline stage.
 * Returns null if the stage is not recognized.
 */
export function getStagePlaybook(stage: string | null | undefined): StagePlaybook | null {
  if (!stage) return null;
  // Direct match
  if (PLAYBOOKS[stage]) return PLAYBOOKS[stage];
  // Case-insensitive match
  const normalized = Object.keys(PLAYBOOKS).find(
    k => k.toLowerCase() === stage.toLowerCase()
  );
  return normalized ? PLAYBOOKS[normalized] : null;
}

/**
 * Get ALL playbooks (for admin display or bulk operations).
 */
export function getAllPlaybooks(): StagePlaybook[] {
  return Object.values(PLAYBOOKS);
}

/**
 * Get the ordered list of stage names (for Pipeline Kanban display).
 */
export function getStageOrder(): string[] {
  return [
    "New Lead",
    "Contacted",
    "Qualified",
    "Quote Sent",
    "Paid - Proof Needed",
    "Proof Sent",
    "Approved + Deposit",
    "In Production",
    "Ready",
    "Delivered",
    "Not Qualified",
  ];
}

// ─── Prompt Injection Helpers ──────────────────────────────────────────────

/**
 * Generate a prompt block for the Strategist brain.
 * Tells the Strategist what the AI's goal is at this stage and what approaches to prefer.
 */
export function getStrategistStageBlock(stage: string | null | undefined): string {
  const pb = getStagePlaybook(stage);
  if (!pb) return "";

  return `
=== STAGE PLAYBOOK: ${pb.label} ===
GOAL AT THIS STAGE: ${pb.goal}
FOCUS TOPICS: ${pb.focusTopics.join("; ")}
SUGGESTED APPROACHES (in priority order): ${pb.suggestedApproaches.join(", ")}
PREFERRED FRAMEWORKS: ${pb.preferredFrameworks.join(", ")}
ADVANCE SIGNALS (watch for these): ${pb.advanceSignals.join("; ")}
ESCALATION SIGNALS (flag for human): ${pb.escalationSignals.join("; ")}
AI PROACTIVE: ${pb.aiProactive ? "YES — AI should reach out if no response" : "NO — AI should only respond to inbound messages"}
NEXT STAGE: ${pb.nextStage || "Terminal (no next stage)"}

CRITICAL: Your approach selection MUST align with the stage goal above. Do NOT select an approach that contradicts the stage playbook.`;
}

/**
 * Generate a prompt block for the Composer brain.
 * Gives the Composer hard constraints on what to say and not say.
 */
export function getComposerStageBlock(stage: string | null | undefined): string {
  const pb = getStagePlaybook(stage);
  if (!pb) return "";

  return `
=== STAGE RULES (MANDATORY — these override general guidelines) ===
CURRENT STAGE: ${pb.label}
STAGE GOAL: ${pb.goal}
TONE: ${pb.tone}
FOCUS ON: ${pb.focusTopics.join("; ")}
NEVER DO (hard guardrails):
${pb.neverDo.map(n => `  ❌ ${n}`).join("\n")}

Your message MUST serve the stage goal above. If the stage says "don't discuss pricing", do NOT discuss pricing even if the strategy directive mentions it.`;
}

/**
 * Generate a prompt block for the Closer brain.
 * Provides stage-specific context for closing committed leads.
 */
export function getCloserStageBlock(stage: string | null | undefined): string {
  const pb = getStagePlaybook(stage);
  if (!pb) return "";

  return `
=== CURRENT PIPELINE STAGE: ${pb.label} ===
STAGE GOAL: ${pb.goal}
NEXT STEP: ${pb.nextStage ? `Move toward "${pb.nextStage}"` : "This is a terminal stage"}
FOCUS: ${pb.focusTopics.join("; ")}
NEVER: ${pb.neverDo.join("; ")}
TONE: ${pb.tone}`;
}

/**
 * Generate a prompt block for the Objection Handler brain.
 * Provides stage-specific context for handling objections.
 */
export function getObjectionHandlerStageBlock(stage: string | null | undefined): string {
  const pb = getStagePlaybook(stage);
  if (!pb) return "";

  return `
=== OBJECTION CONTEXT — CURRENT STAGE: ${pb.label} ===
STAGE GOAL: ${pb.goal}
ESCALATION TRIGGERS: ${pb.escalationSignals.join("; ")}
TONE: ${pb.tone}
NOTE: Address the objection within the context of the current stage. ${pb.isTerminal ? "This is a terminal stage — be respectful and brief." : `The next milestone is "${pb.nextStage}" — guide toward it after resolving the objection.`}`;
}

/**
 * Get task context for the Action Dispatcher when entering a stage.
 * Returns null if no task is needed for this stage.
 */
export function getStageTaskContext(stage: string | null | undefined, leadName: string): {
  title: string;
  assignTo: "designer" | "production" | "sales" | "shipping" | null;
  description: string;
} | null {
  const pb = getStagePlaybook(stage);
  if (!pb?.taskContext) return null;

  return {
    title: pb.taskContext.title.replace("{{leadName}}", leadName || "Unknown"),
    assignTo: pb.taskContext.assignTo,
    description: pb.taskContext.description,
  };
}

/**
 * Get the GHL note template for a stage transition.
 */
export function getStageNote(stage: string | null | undefined): string {
  const pb = getStagePlaybook(stage);
  return pb?.noteTemplate || `Lead moved to ${stage || "unknown"} stage.`;
}

/**
 * Get the follow-up delay for a stage (in milliseconds).
 */
export function getStageFollowUpDelay(stage: string | null | undefined): number {
  const pb = getStagePlaybook(stage);
  return (pb?.followUpDelayHours || 48) * 60 * 60 * 1000;
}

/**
 * Check if AI should proactively reach out at this stage.
 */
export function isAiProactiveAtStage(stage: string | null | undefined): boolean {
  const pb = getStagePlaybook(stage);
  return pb?.aiProactive ?? true;
}

/**
 * Check if a stage is terminal (no further progression).
 */
export function isTerminalStage(stage: string | null | undefined): boolean {
  const pb = getStagePlaybook(stage);
  return pb?.isTerminal ?? false;
}

/**
 * Get a compact summary of the playbook for learning loop pattern recording.
 * Used to record which stage rules were active during an outcome.
 */
export function getPlaybookSummaryForLearning(stage: string | null | undefined): string {
  const pb = getStagePlaybook(stage);
  if (!pb) return "unknown_stage";
  return `${pb.label}|goal:${pb.goal.substring(0, 60)}|approaches:${pb.suggestedApproaches.join(",")}|proactive:${pb.aiProactive}`;
}
