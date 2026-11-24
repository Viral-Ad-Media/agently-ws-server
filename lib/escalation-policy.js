"use strict";

const ESCALATION_RULES = [
  "Escalation and message-taking:",
  "- A request for a manager is a chance to understand the concern. Acknowledge it calmly, offer a relevant suggestion grounded in the business information, and offer once to take a message or arrange a callback before transferring.",
  "- Ask one question at a time. If they accept a message/callback, collect their name, confirm their best callback number, capture the concern and preferred callback time, read it back, and use capture_inbound_message. Never claim the message was saved before the tool succeeds.",
  "- If the caller declines that offer or insists on a representative, respect the decision and transfer promptly. Do not repeatedly pitch alternatives or make giving contact details a condition of transfer. Ask for a name/reason only if not already known and the caller is willing.",
  "- Before transferring, say 'Let me try to connect you with one of our team. Please hold for a moment.' Never claim someone has answered until confirmed. Keep the destination number private.",
  "- Never invent a remedy, refund, appointment, product detail, or promise that a manager will call at a specific time. Explain uncertainty briefly and offer the next available useful step.",
].join("\n");

// Require an actual caller turn after the alternative was offered. A model
// tool call alone is not evidence that the person agreed to be transferred.
function evaluateEscalation(lines = [], decision = {}) {
  const turns = lines.filter(x => x?.text);
  let lastCaller = -1;
  let lastOffer = -1;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (["caller", "user"].includes(t.role)) lastCaller = i;
    if (t.role === "assistant" && /\b(?:message|call\s*back|callback)\b/i.test(t.text) &&
        /\b(?:offer|take|leave|arrange|would|can|could|like|rather)\b/i.test(t.text)) lastOffer = i;
  }
  const latest = lastCaller >= 0 ? String(turns[lastCaller].text) : "";
  if (/\b(?:don't|do not|no longer)\s+(?:want|need)\s+(?:to\s+(?:talk|speak)\s+(?:to|with)\s+)?(?:a |the |your )?(?:human|person|manager|representative|supervisor|transfer)\b/i.test(latest) || /\b(?:don't|do not)\s+(?:transfer|connect|patch)\b/i.test(latest)) return { allowed: false, message: "The caller declined a transfer. Continue helping or collect the message they requested." };
  if (/\b(?:no need for|don't need|do not need|never mind|forget (?:the|a))\b.{0,25}\b(?:manager|person|human|representative|transfer)\b/i.test(latest) || /\b(?:take|leave) (?:a |the )?message\b/i.test(latest) && !/\b(?:don't|do not|won't|not)\b/i.test(latest)) return { allowed: false, message: "The caller chose a message. Collect and save their message and available callback details instead of transferring." };
  const wantsHuman = /\b(?:human|person|manager|representative|supervisor|someone|team\s*member|transfer|connect|patch)\b/i.test(latest);
  // "Can I just talk to a manager?" is a request, not a refusal: the agent
  // still offers to take a message first. Only refusing the message/callback
  // itself, or insisting, skips that offer.
  const refusesMessage = /\b(?:no|don't|do not|won't|will not|not|never)\b[^.?!]{0,30}\b(?:message|call\s*back|callback|voicemail)\b/i.test(latest);
  const insists = /\b(?:insist|insisting|demand)\b/i.test(latest);
  const explicitRefusal = wantsHuman && (refusesMessage || insists);
  // The voice model interprets other languages and indirect requests. Require
  // an actual caller turn plus explicit structured choice, rather than making
  // English keyword matching the only way a caller can reach a person.
  const semanticConfirmation = lastCaller >= 0 && decision.caller_still_wants_human === true &&
    (decision.caller_declined_alternatives === true || decision.alternatives_offered === true);
  const previousAssistant = turns.slice(0,lastCaller).reverse().find(t=>t.role === "assistant");
  const confirmedTransfer = lastOffer >= 0 && lastCaller > lastOffer && /^(?:yes|yeah|yep|please do|go ahead|please|okay)[.!\s]*$/i.test(latest.trim()) && /\b(?:transfer|connect|patch)\b/i.test(previousAssistant?.text || "") && !/\b(?:message|callback|call back)\b/i.test(previousAssistant?.text || "");
  if (semanticConfirmation || confirmedTransfer || explicitRefusal || (lastOffer >= 0 && lastCaller > lastOffer && wantsHuman)) return { allowed: true };
  return { allowed: false, message: lastOffer < 0
    ? "Before transferring, acknowledge the concern and offer once to help, take a message, or arrange a callback. Wait for the caller's answer. If they insist on a person, respect that and transfer without requiring their details."
    : "Wait for the caller's answer. Save an accepted message or callback request with the available contact details; only transfer if the caller still wants a person." };
}

module.exports = { ESCALATION_RULES, evaluateEscalation };
