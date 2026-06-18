"use strict";

const DEFAULT_VOICEMAIL_ACTION = "hangup";
const ACTIONS = new Set([
  "hangup",
  "leave_message",
  "callback_later",
  "manual_followup",
]);

function jsonObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizeVoicemailAction(value, fallback = DEFAULT_VOICEMAIL_ACTION) {
  const raw = String(value || "").trim().toLowerCase();
  const aliases = {
    leave_voicemail: "leave_message",
    voicemail_message: "leave_message",
    message: "leave_message",
    callback: "callback_later",
    callback_later: "callback_later",
    redial: "callback_later",
    retry: "callback_later",
    retry_later: "callback_later",
    manual: "manual_followup",
    manual_follow_up: "manual_followup",
    followup: "manual_followup",
    follow_up: "manual_followup",
    skip: "hangup",
    none: "hangup",
  };
  const normalized = aliases[raw] || raw;
  if (ACTIONS.has(normalized)) return normalized;
  return ACTIONS.has(fallback) ? fallback : DEFAULT_VOICEMAIL_ACTION;
}

function readVoicemailSettings(source = {}) {
  const voiceSettings = jsonObject(source.voice_settings || source.voiceSettings);
  const nested = jsonObject(
    source.voicemail_settings ||
      source.voicemailSettings ||
      source.voicemail ||
      voiceSettings.voicemail,
  );
  const action = normalizeVoicemailAction(
    firstNonEmpty(
      source.voicemail_behavior,
      source.voicemailBehavior,
      nested.action,
      nested.mode,
      nested.behavior,
      voiceSettings.voicemailBehavior,
    ),
  );
  const message = firstNonEmpty(
    source.voicemail_message,
    source.voicemailMessage,
    nested.message,
    nested.script,
    nested.voicemailMessage,
  );
  return {
    action,
    message,
    callbackDelayMinutes: clampInt(
      firstNonEmpty(
        source.voicemail_callback_delay_minutes,
        source.voicemailCallbackDelayMinutes,
        nested.callbackDelayMinutes,
        nested.callback_delay_minutes,
      ),
      60,
      5,
      10080,
    ),
    maxRedialAttempts: clampInt(
      firstNonEmpty(
        source.voicemail_max_redial_attempts,
        source.voicemailMaxRedialAttempts,
        nested.maxRedialAttempts,
        nested.max_redial_attempts,
      ),
      1,
      0,
      10,
    ),
  };
}

function serializeVoicemailSettings(source = {}) {
  const settings = readVoicemailSettings(source);
  return {
    action: settings.action,
    message: settings.message,
    callbackDelayMinutes: settings.callbackDelayMinutes,
    maxRedialAttempts: settings.maxRedialAttempts,
  };
}

function machineDetectionModeForSettings(settings = {}) {
  const action = normalizeVoicemailAction(settings.action || settings.mode);
  return action === "leave_message" ? "DetectMessageEnd" : "Enable";
}

function isMachineAnsweredBy(answeredBy) {
  return /machine|fax|voicemail|voice_mail|answering_machine/i.test(
    String(answeredBy || ""),
  );
}

function isHumanAnsweredBy(answeredBy) {
  return /human/i.test(String(answeredBy || ""));
}

function classifyAnsweredBy(answeredBy) {
  const raw = String(answeredBy || "").trim();
  if (isMachineAnsweredBy(raw)) return "voicemail";
  if (isHumanAnsweredBy(raw)) return "answered_human";
  if (/unknown/i.test(raw)) return "unknown_answered_by";
  return raw ? "answered_other" : "unknown_answered_by";
}

function tokenReplace(template, values = {}) {
  let output = String(template || "");
  const map = {
    agent_name: values.agentName || "",
    business_name: values.businessName || values.organizationName || "",
    organization_name: values.organizationName || values.businessName || "",
    call_purpose: values.callPurpose || "",
    callback_number: values.callbackNumber || "",
    recipient_name: values.recipientName || values.targetName || "",
  };
  for (const [key, value] of Object.entries(map)) {
    output = output.replace(new RegExp(`{{\\s*${key}\\s*}}`, "gi"), value || "");
  }
  return output.replace(/\s+/g, " ").trim();
}

function buildVoicemailMessage(settings = {}, context = {}) {
  const custom = tokenReplace(settings.message || "", {
    agentName: context.agentName,
    businessName: context.businessName || context.organizationName,
    organizationName: context.organizationName || context.businessName,
    callPurpose: context.callPurpose,
    callbackNumber: context.callbackNumber || context.callerPhone || context.fromNumber,
    recipientName: context.recipientName || context.targetName,
  });
  if (custom) return custom;
  const agentName = firstNonEmpty(context.agentName, "your assistant");
  const businessName = firstNonEmpty(
    context.businessName,
    context.organizationName,
    "the business",
  );
  const purpose = firstNonEmpty(context.callPurpose, "follow up with you");
  const callback = firstNonEmpty(
    context.callbackNumber,
    context.callerPhone,
    context.fromNumber,
  );
  const callbackText = callback ? ` You can call us back at ${callback}.` : "";
  return `Hello, this is ${agentName} from ${businessName}. I am calling to ${purpose}.${callbackText} Thank you.`;
}

function callbackAt(settings = {}, now = new Date()) {
  const delay = clampInt(settings.callbackDelayMinutes, 60, 5, 10080);
  return new Date(now.getTime() + delay * 60_000).toISOString();
}

module.exports = {
  ACTIONS,
  DEFAULT_VOICEMAIL_ACTION,
  normalizeVoicemailAction,
  readVoicemailSettings,
  serializeVoicemailSettings,
  machineDetectionModeForSettings,
  isMachineAnsweredBy,
  isHumanAnsweredBy,
  classifyAnsweredBy,
  buildVoicemailMessage,
  callbackAt,
};
