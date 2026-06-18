"use strict";

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9\s.'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function boolValue(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["false", "0", "no", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function sanitizeForSpeech(value, fallback = "") {
  return String(value || fallback || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[<>`{}[\]|\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function normalizeSettings(agent = {}) {
  const raw = agent.call_screening_settings || agent.callScreeningSettings || {};
  const enabled = boolValue(
    raw.enabled !== undefined ? raw.enabled : agent.call_screening_enabled ?? agent.callScreeningEnabled,
    true,
  );
  return {
    enabled,
    responseMessage: firstNonEmpty(raw.responseMessage, raw.response_message, agent.call_screening_message, agent.callScreeningMessage),
    allowPurposeDisclosure: boolValue(raw.allowPurposeDisclosure ?? raw.allow_purpose_disclosure, true),
  };
}

function detectScreeningPrompt(text = "") {
  const t = normalizeText(text);
  if (!t) return null;

  const promptPatterns = [
    /\b(state|say|tell me|please say|please state)\b.{0,35}\b(your name|who you are|the name|name)\b/,
    /\b(who is calling|who's calling|who are you|may i ask who is calling|can i ask who is calling)\b/,
    /\b(what is|what's|state|say|tell me)\b.{0,45}\b(reason|purpose|regarding|about)\b.{0,25}\b(call|calling)\b/,
    /\b(what is this call about|what's this call about|what is this regarding|what's this regarding)\b/,
    /\b(announce yourself|identify yourself|screening this call|call is being screened|google assistant is screening|assistant is screening)\b/,
    /\b(before i connect|before i transfer|before i put you through)\b.{0,55}\b(name|reason|purpose|calling|call)\b/,
    /\b(to get you connected|to connect you|to put you through)\b.{0,45}\b(name|reason|purpose)\b/,
  ];
  if (promptPatterns.some((pattern) => pattern.test(t))) {
    return { kind: "prompt", confidence: "high", normalized: t };
  }

  const transferPatterns = [
    /\b(one moment|just a moment|hold on|please hold|hang on)\b.{0,60}\b(connect|transfer|get them|put you through|reach them)\b/,
    /\b(i'?ll try to (connect|get|reach)|trying to connect|connecting you|transferring you)\b/,
    /\b(stay on the line|please stay on the line)\b/,
  ];
  if (transferPatterns.some((pattern) => pattern.test(t))) {
    return { kind: "transfer", confidence: "medium", normalized: t };
  }

  return null;
}

function buildScreeningResponse({ agent = {}, organization = {}, context = {}, settings = {} } = {}) {
  const custom = sanitizeForSpeech(settings.responseMessage || "");
  if (custom) return custom;

  const agentName = sanitizeForSpeech(firstNonEmpty(context.agentName, agent.name), "the assistant");
  const organizationName = sanitizeForSpeech(
    firstNonEmpty(context.organizationName, context.businessName, organization.name),
    "the business",
  );
  const purpose = sanitizeForSpeech(firstNonEmpty(context.callPurpose, context.normalizedPurpose), "");

  const identity = `This is ${agentName} calling from ${organizationName}.`;
  if (settings.allowPurposeDisclosure !== false && purpose) {
    return `${identity} I am calling about ${purpose}.`;
  }
  return `${identity} It is a brief business call.`;
}

function promptRules(settings = {}) {
  if (settings.enabled === false) return "";
  return [
    "CALL-SCREENING ASSISTANT RULES:",
    "- If an automated screening assistant asks who is calling, state only your configured agent name, business name, and call purpose briefly.",
    "- Do not deliver the main call script to the screening assistant.",
    "- After answering the screening assistant, pause and wait to be connected to the real recipient.",
    "- When the real recipient joins, restart naturally with the normal greeting and call purpose.",
  ].join("\n");
}

module.exports = {
  normalizeSettings,
  detectScreeningPrompt,
  buildScreeningResponse,
  promptRules,
};
