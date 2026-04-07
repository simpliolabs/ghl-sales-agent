/**
 * AUTO-CORRECTION ENGINE
 * 
 * Detects bad messages that were already sent and automatically:
 * 1. Sends an apology to the customer
 * 2. Sends the correct message (locked template or safe fallback)
 * 3. Logs the correction in the audit trail
 * 4. Notifies the owner
 * 
 * Triggers:
 * - Post-send QC check: After Brain Council sends a message, run a secondary validation
 * - Retroactive scan: Periodic check for sent messages with violations
 * - Confusion detection: When a lead replies with confusion after an AI message
 */

import { notifyOwner } from "./_core/notification";
import { sendMessage } from "./ghl";
import { 
  updateAuditCorrection, 
  getUncorrectedViolations,
  addConversation,
  getLeadById,
  getBrainCouncilAuditForLead,
  updateLeadFields,
  isAiOffline,
} from "./db";

// --- VIOLATION PATTERNS THAT REQUIRE CORRECTION ---
const CRITICAL_VIOLATIONS = [
  "irrelevant_research",   // Talked about wrong business (like Chick-fil-A for a church)
  "wrong_business",        // Referenced wrong company entirely
  "form_data_ignored",     // Ignored what the lead actually asked for
];

// --- CONFUSION SIGNALS FROM LEAD REPLIES ---
const CONFUSION_PATTERNS = [
  /what\s+(are\s+you|do\s+you\s+mean|is\s+this)/i,
  /wrong\s+(person|number|message|business)/i,
  /who\s+is\s+this/i,
  /i\s+didn'?t\s+(ask|say|mention|order)/i,
  /that'?s\s+not\s+(me|my|what|right|correct)/i,
  /huh\??/i,
  /what\??$/i,
  /confused/i,
  /makes?\s+no\s+sense/i,
  /not\s+sure\s+what\s+you('re|\s+are)\s+talking/i,
  /never\s+(said|mentioned|asked)/i,
];

/**
 * Check if a lead's reply indicates confusion about a previous AI message
 */
export function detectConfusion(replyText: string): boolean {
  return CONFUSION_PATTERNS.some(pattern => pattern.test(replyText));
}

/**
 * Build the apology + correct message for a lead
 */
function buildCorrectionMessages(
  leadName: string,
  agentName: string,
  formData: { productType?: string; purpose?: string; timeline?: string },
  channel: string,
): { apology: string; correct: string } {
  const firstName = (leadName || "").split(" ")[0] || "there";
  const agentFirst = (agentName || "Adorb").split(" ")[0];

  const apology = `Hey ${firstName}, so sorry about that last message — that was a mix-up on our end! Let me start fresh.`;

  // Build the correct locked template message
  let correct = `${agentFirst} here from Adorb! We have a 4.9 star review helping`;
  if (formData.purpose) {
    correct += ` ${formData.purpose.toLowerCase()}`;
  } else {
    correct += ` businesses like yours`;
  }
  correct += ` with customized ${(formData.productType || "custom gear").toLowerCase()}`;
  if (formData.timeline) {
    correct += ` ${formData.timeline.toLowerCase()}`;
  }
  correct += `. Do you have a design ready or would you like our team to help?`;

  return { apology, correct };
}

/**
 * Send auto-correction for a specific audit entry
 */
export async function sendAutoCorrection(params: {
  auditId: number;
  leadId: number;
  contactId: string;
  channel: string;
  reason: string;
  formData?: { productType?: string; purpose?: string; timeline?: string };
}): Promise<{ success: boolean; error?: string }> {
  const { auditId, leadId, contactId, channel, reason, formData } = params;

  try {
    // Check if AI is offline before sending corrections
    if (await isAiOffline()) {
      console.log(`[AutoCorrect] AI offline — skipping correction for lead ${leadId}`);
      return { success: false, error: "AI is offline" };
    }

    const lead = await getLeadById(leadId);
    if (!lead) return { success: false, error: "Lead not found" };

    const agentName = lead.assignedAgent || "Adorb";
    const { apology, correct } = buildCorrectionMessages(
      lead.name || "",
      agentName,
      formData || {},
      channel,
    );

    const fullCorrection = `${apology}\n\n${correct}`;

    // Send the correction via the same channel
    const sendOpts = buildSendOpts(channel, apology, agentName);
    if (!sendOpts) return { success: false, error: `Cannot send via channel: ${channel}` };

    // Send apology
    try {
      await sendMessage(contactId, sendOpts);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[AutoCorrect] Failed to send apology to ${contactId}:`, errMsg);
      return { success: false, error: errMsg };
    }

    // Small delay for natural feel
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Send correct message
    const correctOpts = buildSendOpts(channel, correct, agentName);
    if (correctOpts) {
      try {
        await sendMessage(contactId, correctOpts);
      } catch (err) {
        console.error(`[AutoCorrect] Failed to send correction to ${contactId}:`, err);
      }
    }

    // Log conversations
    await addConversation({
      leadId,
      channel,
      direction: "outbound",
      messageBody: `[AUTO-CORRECTION] ${apology}`,
      senderType: "ai",
      senderName: agentName,
    });
    await addConversation({
      leadId,
      channel,
      direction: "outbound",
      messageBody: `[AUTO-CORRECTION] ${correct}`,
      senderType: "ai",
      senderName: agentName,
    });

    // Update audit entry
    await updateAuditCorrection(auditId, {
      correctionSent: 1,
      correctionMessage: fullCorrection,
      correctionReason: reason,
    });

    // Notify owner
    await notifyOwner({
      title: `🔧 Auto-Correction Sent: ${lead.name || "Lead #" + leadId}`,
      content: `An auto-correction was sent to ${lead.name || "Lead #" + leadId} (${channel}).\n\nReason: ${reason}\n\nApology: ${apology}\n\nCorrect message: ${correct}`,
    });

    console.log(`[AutoCorrect] Correction sent for audit #${auditId}, lead #${leadId}: ${reason}`);
    return { success: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[AutoCorrect] Error:`, errMsg);
    return { success: false, error: errMsg };
  }
}

/**
 * Post-send validation: Check if a just-sent Brain Council message needs correction
 * Called immediately after a Brain Council message is sent
 */
export async function postSendValidation(params: {
  auditId: number;
  leadId: number;
  contactId: string;
  channel: string;
  sentMessage: string;
  violationCategory?: string;
  qcScore: number;
  formData?: { productType?: string; purpose?: string; timeline?: string };
}): Promise<void> {
  const { auditId, leadId, contactId, channel, sentMessage, violationCategory, qcScore, formData } = params;

  // Only auto-correct for critical violations that were somehow sent
  if (!violationCategory || !CRITICAL_VIOLATIONS.includes(violationCategory)) return;

  // If QC score was high enough to pass but violation was still detected, correct it
  if (qcScore >= 50) {
    console.log(`[AutoCorrect] Post-send validation caught violation "${violationCategory}" for lead ${leadId} (QC=${qcScore}). Sending correction.`);
    await sendAutoCorrection({
      auditId,
      leadId,
      contactId,
      channel,
      reason: `Post-send validation: "${violationCategory}" violation detected after message was sent (QC score: ${qcScore})`,
      formData,
    });
  }
}

/**
 * Confusion-triggered correction: When a lead replies with confusion
 * Called from the message webhook handler when confusion is detected
 */
export async function handleConfusionReply(params: {
  leadId: number;
  contactId: string;
  channel: string;
  confusionMessage: string;
  formData?: { productType?: string; purpose?: string; timeline?: string };
}): Promise<boolean> {
  const { leadId, contactId, channel, confusionMessage, formData } = params;

  // Check recent audit entries for this lead to find the problematic message
  const recentAudits = await getBrainCouncilAuditForLead(leadId, 5);
  const lastSentAudit = recentAudits.find(a => a.messageSent === 1 && a.correctionSent === 0);

  if (!lastSentAudit) return false;

  // Check if the last sent message had any violations or low QC score
  const needsCorrection = 
    (lastSentAudit.violationCategory && CRITICAL_VIOLATIONS.includes(lastSentAudit.violationCategory)) ||
    (lastSentAudit.qcScore !== null && lastSentAudit.qcScore < 70);

  if (!needsCorrection) return false;

  console.log(`[AutoCorrect] Confusion detected from lead ${leadId}: "${confusionMessage}". Last audit #${lastSentAudit.id} had violation="${lastSentAudit.violationCategory}", QC=${lastSentAudit.qcScore}`);

  const result = await sendAutoCorrection({
    auditId: lastSentAudit.id,
    leadId,
    contactId,
    channel,
    reason: `Lead replied with confusion: "${confusionMessage}". Previous message had violation: ${lastSentAudit.violationCategory || "low QC score " + lastSentAudit.qcScore}`,
    formData,
  });

  return result.success;
}

/**
 * Retroactive scan: Check for sent messages with uncorrected violations
 * Should be called periodically (e.g., every 15 minutes)
 */
export async function retroactiveCorrectionScan(): Promise<number> {
  // Check if AI is offline before running the scan
  if (await isAiOffline()) {
    console.log(`[AutoCorrect/Scan] AI offline — skipping retroactive scan`);
    return 0;
  }

  const violations = await getUncorrectedViolations(10);
  let corrected = 0;

  for (const v of violations) {
    // Only auto-correct critical violations
    if (!v.violationCategory || !CRITICAL_VIOLATIONS.includes(v.violationCategory)) continue;

    // Get the lead to find contact ID and channel
    const lead = await getLeadById(v.leadId);
    if (!lead || !lead.ghlContactId) continue;

    const channel = v.channel || lead.lastOutboundChannel || "SMS";

    console.log(`[AutoCorrect/Scan] Found uncorrected violation for lead ${v.leadId}: ${v.violationCategory}`);

    const result = await sendAutoCorrection({
      auditId: v.id,
      leadId: v.leadId,
      contactId: lead.ghlContactId,
      channel,
      reason: `Retroactive scan: "${v.violationCategory}" violation detected on audit #${v.id}`,
    });

    if (result.success) corrected++;
  }

  if (corrected > 0) {
    console.log(`[AutoCorrect/Scan] Corrected ${corrected} messages`);
  }

  return corrected;
}

// --- HELPER: Build send options for a channel ---
function buildSendOpts(
  channel: string,
  message: string,
  fromName: string,
): Parameters<typeof sendMessage>[1] | undefined {
  switch (channel) {
    case "Email":
      return { type: "Email", subject: `${fromName.split(" ")[0]} from Adorb Custom Tees`, html: `<p>${message}</p>`, fromName };
    case "FB":
      return { type: "FB", message };
    case "IG":
      return { type: "IG", message };
    case "WhatsApp":
      return { type: "WhatsApp", message };
    case "SMS":
      return { type: "SMS", message };
    default:
      return { type: "SMS", message };
  }
}
