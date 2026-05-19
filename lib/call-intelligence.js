"use strict";

function asString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return "";
}

function normalizeText(text) {
  return asString(text).toLowerCase().replace(/\s+/g, " ").trim();
}

function transcriptText(lines, role = null) {
  return (lines || [])
    .filter((line) => !role || String(line.role || "").toLowerCase() === role)
    .map((line) => asString(line.text))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function lastMatchingLine(lines, predicate) {
  const copy = [...(lines || [])].reverse();
  return copy.find((line) => predicate(asString(line.text), line)) || null;
}

function extractEmail(text) {
  const match = asString(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : "";
}

function extractPhone(text, fallback = "") {
  const match = asString(text).match(/\+?\d[\d\s().-]{6,}\d/);
  if (!match) return fallback || "";
  const cleaned = match[0].replace(/[^+\d]/g, "");
  return cleaned || fallback || "";
}

function extractCallbackTime(text) {
  const value = asString(text);
  const patterns = [
    /\b(call me back|call back|callback|reach me|follow up)\s+(at|around|by|after|before|tomorrow|today|next week)?\s*([^.;!?\n]{0,90})/i,
    /\b(tomorrow|today|next week|this afternoon|this evening|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[^.;!?\n]{0,80}/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const raw = firstNonEmpty(match?.[3], match?.[0]);
    if (raw)
      return raw
        .replace(/^\s*(at|around|by|after|before)\s+/i, "")
        .trim()
        .slice(0, 120);
  }
  return "";
}

function detectInterest(text) {
  const t = normalizeText(text);
  if (
    /\b(yes|interested|sounds good|tell me more|send|call me|book|schedule|appointment|i want|let'?s do|go ahead)\b/.test(
      t,
    )
  )
    return "interested";
  if (
    /\b(maybe|not sure|later|another time|think about|send information)\b/.test(
      t,
    )
  )
    return "maybe";
  if (
    /\b(no|not interested|stop calling|do not call|don'?t call|remove me|unsubscribe|decline)\b/.test(
      t,
    )
  )
    return "not_interested";
  return "unknown";
}

function detectOptOut(text) {
  return /\b(stop calling|do not call|don'?t call|remove me|unsubscribe|take me off|opt out|wrong number)\b/i.test(
    asString(text),
  );
}

function detectTransferRequest(text) {
  return /\b(human|representative|agent|manager|someone else|transfer|speak to a person|real person)\b/i.test(
    asString(text),
  );
}

function detectAppointmentInterest(text) {
  return /\b(appointment|book|schedule|meeting|consultation|demo|call me back|callback|follow up)\b/i.test(
    asString(text),
  );
}

function detectObjection(text) {
  const line = lastMatchingLine(
    text.split("\n").map((t) => ({ text: t })),
    (value) =>
      /\b(expensive|price|cost|busy|not interested|already have|too much|can'?t afford|later|no time|don'?t need|skeptical|not sure)\b/i.test(
        value,
      ),
  );
  return line ? asString(line.text).slice(0, 400) : "";
}

function detectMessageForTeam(text) {
  const value = asString(text);
  const patterns = [
    /\b(please tell|tell the team|let them know|message is|take a message|leave a message)\b([^\n]{0,500})/i,
    /\b(call me back|call back|callback|reach me|follow up)\b([^\n]{0,500})/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return asString(match[0]).slice(0, 600);
  }
  return "";
}

function detectQuestion(text) {
  const lines = asString(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const match = lines.find((line) =>
    /\?|\b(what|how|when|where|why|can you|do you|is there|are there|price|cost)\b/i.test(
      line,
    ),
  );
  return match ? match.slice(0, 500) : "";
}

function assistantCouldNotAnswer(assistantText) {
  return /\b(i don'?t have|i do not have|not have enough information|cannot answer|can'?t answer|team can follow up|take a message|not in.*knowledge)\b/i.test(
    asString(assistantText),
  );
}

function extractStructuredCallInsights({
  transcriptLines = [],
  context = {},
  existingSummary = "",
} = {}) {
  const callerText = transcriptText(transcriptLines, "caller");
  const assistantText = transcriptText(transcriptLines, "assistant");
  const allText = [callerText, assistantText].filter(Boolean).join("\n");
  const messageForTeam = detectMessageForTeam(callerText);
  const callbackTime = extractCallbackTime(callerText);
  const questionAsked = detectQuestion(callerText);
  const unansweredQuestion =
    questionAsked && assistantCouldNotAnswer(assistantText)
      ? questionAsked
      : "";
  const optOut = detectOptOut(callerText);
  const transferRequested = detectTransferRequest(callerText);
  const appointmentInterest = detectAppointmentInterest(callerText);
  const interestLevel = optOut ? "opt_out" : detectInterest(callerText);
  const objection = detectObjection(callerText);
  const email = extractEmail(callerText);
  const phone = extractPhone(
    callerText,
    firstNonEmpty(context.recipientPhone, context.callerPhone),
  );
  const requestedFollowUp = Boolean(
    callbackTime ||
    /\b(call me|call back|callback|follow up|reach me)\b/i.test(callerText),
  );
  const completedByUserApproval =
    /\b(yes|yeah|okay|ok|sure|go ahead|you can|that's all|that is all)\b.{0,60}\b(end|hang up|bye|goodbye|finish)\b/i.test(
      callerText,
    );
  const callerEnded =
    /\b(bye|goodbye|thank you|thanks|that'?s all|that is all)\b/i.test(
      callerText,
    );
  const summaryParts = [];
  if (existingSummary) summaryParts.push(asString(existingSummary));
  if (questionAsked) summaryParts.push(`Question asked: ${questionAsked}`);
  if (messageForTeam) summaryParts.push(`Message/follow-up: ${messageForTeam}`);
  if (callbackTime) summaryParts.push(`Callback preference: ${callbackTime}`);
  if (objection) summaryParts.push(`Objection/concern: ${objection}`);
  if (optOut)
    summaryParts.push("Caller requested opt-out/do-not-call handling.");
  if (transferRequested)
    summaryParts.push("Caller requested a human/transfer.");
  return {
    call_purpose: firstNonEmpty(context.callPurpose),
    custom_instructions: firstNonEmpty(context.customInstructions),
    direct_recipient: {
      name: firstNonEmpty(context.recipientName, context.targetName),
      phone: firstNonEmpty(context.recipientPhone),
    },
    collected_fields: {
      phone,
      email,
      interest_level: interestLevel,
      question_asked: questionAsked,
      objection,
      requested_follow_up: requestedFollowUp,
      callback_time: callbackTime,
      appointment_interest: appointmentInterest,
      transfer_requested: transferRequested,
      opt_out_requested: optOut,
      message_for_team: messageForTeam,
      unanswered_question: unansweredQuestion,
      caller_ended_or_approved_end: Boolean(
        completedByUserApproval || callerEnded,
      ),
    },
    flags: {
      has_message_for_team: Boolean(messageForTeam),
      has_callback_request: Boolean(requestedFollowUp),
      has_unanswered_question: Boolean(unansweredQuestion),
      has_opt_out: Boolean(optOut),
      has_transfer_request: Boolean(transferRequested),
    },
    summary: summaryParts.filter(Boolean).join("\n").slice(0, 1800),
    raw_text_sample: allText.slice(0, 4000),
  };
}

function buildVoiceIntelligencePrompt({
  context = {},
  agent = {},
  organization = {},
  voiceContext = {},
} = {}) {
  const isOutbound =
    String(context.direction || "").toLowerCase() === "outbound";
  const callPurpose = firstNonEmpty(
    context.callPurpose,
    voiceContext?.debug?.currentCall?.callPurpose,
  );
  const customInstructions = firstNonEmpty(
    context.customInstructions,
    voiceContext?.debug?.currentCall?.customInstructions,
  );
  const recipientName = firstNonEmpty(
    context.recipientName,
    context.targetName,
    voiceContext?.debug?.currentCall?.directRecipientName,
    voiceContext?.debug?.currentCall?.leadName,
  );
  const recipientPhone = firstNonEmpty(
    context.recipientPhone,
    voiceContext?.debug?.currentCall?.recipientPhone,
  );
  const businessName = firstNonEmpty(organization?.name, "the business");
  const agentName = firstNonEmpty(agent?.name, "the assistant");
  const lines = [
    "VOICE AGENT INTELLIGENCE AND CALL-CONTROL RULES:",
    `- You are ${agentName} for ${businessName}. Stay in this role for the entire call.`,
    "- Use the tenant/agent knowledge, FAQs, organization details, call purpose, and custom instructions already provided in this prompt.",
    "- If the answer is not in the provided business knowledge, do not invent it. Offer to take a message or have the team follow up.",
    "- Listen patiently. Wait for a stable caller utterance before answering.",
    "- Do not interrupt or talk over the caller. If interrupted, stop immediately and listen until the caller finishes.",
    "- After any interruption or objection, acknowledge the caller's concern before continuing.",
    "- Never produce overlapping responses or repeat the greeting.",
    "- Ask one question at a time. Keep phone replies concise and natural.",
    "- If the caller gives a message or callback request, repeat it back once briefly for confirmation and store it.",
    "- If the caller asks for a human or transfer and transfer is not available in the current call, acknowledge it and capture the request for follow-up.",
    "- If the caller opts out or says do not call, acknowledge politely and do not continue pitching.",
    "- End-call rule: ask for permission once before ending when the objective appears complete. Once the caller confirms, give one short closing and end. Do not ask for confirmation a second time.",
  ];
  if (isOutbound) {
    lines.push(
      "- OUTBOUND MODE: you initiated this call to a known recipient. Do not behave like an inbound receptionist.",
    );
    if (recipientName || recipientPhone) {
      lines.push(
        `- Known recipient: ${recipientName || "name not provided"}${recipientPhone ? ` (${recipientPhone})` : ""}. Do not ask for their name or phone unless they correct it or offer another contact detail.`,
      );
    }
    lines.push(
      "- The call purpose is the reason you are reaching out. Mention it naturally and briefly, then wait for the recipient.",
    );
    lines.push(
      "- Reword the call purpose into a correct sentence. Never say 'for the purpose of', 'because to', or 'to for the purpose of'.",
    );
    lines.push(
      "- If the recipient asks why you are calling or says they did not request the call, apologize for the interruption, explain the purpose once, and offer to schedule a callback, take a message, or end the call.",
    );
    lines.push(
      "- Do not ask 'How can I help you?' at the start of an outbound call. You called them; explain why you called.",
    );
    lines.push(
      "- Do not collect lead basics that are already known from the direct recipient or lead record. Only capture new information naturally offered, such as callback time, email, objection, message, or opt-out.",
    );
    lines.push(
      "- When saving a message, save the recipient's actual message/callback details only, not the full transcript.",
    );
  } else {
    lines.push(
      "- INBOUND MODE: the caller reached the business. They may be anonymous. It is appropriate to ask for name/contact details when needed for follow-up or message capture.",
    );
  }
  if (callPurpose) lines.push(`- Current call purpose: ${callPurpose}`);
  if (customInstructions)
    lines.push(
      `- Operator custom instructions for this call: ${customInstructions}`,
    );
  return lines.join("\n");
}

module.exports = {
  buildVoiceIntelligencePrompt,
  extractStructuredCallInsights,
};
