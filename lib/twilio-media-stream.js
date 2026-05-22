"use strict";

/**
 * Twilio Media Streams <Connect><Stream> handler.
 *
 * Twilio sends and receives G.711 u-law audio at 8000 Hz. This handler bridges
 * that audio directly to OpenAI Realtime and sends OpenAI audio deltas back to
 * Twilio using the exact Twilio media frame shape.
 *
 * This endpoint intentionally does not require the browser/widget JWT flow:
 * Twilio connects directly over WebSocket and sends call metadata in the query
 * string and/or in the `start.customParameters` payload.
 */

const https = require("https");
const WebSocket = require("ws");
const { getSupabase } = require("./supabase");
const { loadVoiceContext } = require("./context-builder");
const voiceBehavior = require("./voice-behavior");
const {
  buildVoiceIntelligencePrompt,
  extractStructuredCallInsights,
} = require("./call-intelligence");
const {
  TWILIO_OUTPUT_FORMAT,
  cleanTextForSpeech,
  elevenLabsConfig,
  normalizeProvider,
  resolveElevenLabsVoiceForAgent,
  splitTextForSpeech,
  streamElevenLabsSpeech,
  voiceSettingsFromAgent,
} = require("./elevenlabs");

const OPENAI_REALTIME_URL =
  process.env.OPENAI_REALTIME_URL ||
  `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
  )}`;

function intEnv(name, fallback, min = 0) {
  const parsed = Number(process.env[name] || fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function boolEnv(name, fallback = false) {
  const value = String(process.env[name] || (fallback ? "true" : "false"))
    .trim()
    .toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, Number(ms) || 0)),
  );
}

const VOICE_TURN_SILENCE_MS = intEnv("VOICE_TURN_SILENCE_MS", 1100, 300);
const VOICE_MIN_USER_SPEECH_MS = intEnv("VOICE_MIN_USER_SPEECH_MS", 600, 100);
const VOICE_RESPONSE_DEBOUNCE_MS = intEnv("VOICE_RESPONSE_DEBOUNCE_MS", 0, 0);
const VOICE_TTS_CHUNK_PAUSE_MS = intEnv("VOICE_TTS_CHUNK_PAUSE_MS", 0, 0);
const VOICE_ALLOW_BARGE_IN = boolEnv("VOICE_ALLOW_BARGE_IN", true);
const VOICE_BARGE_IN_MIN_SPEECH_MS = intEnv(
  "VOICE_BARGE_IN_MIN_SPEECH_MS",
  300,
  100,
);
const VOICE_BARGE_IN_CLEAR_MS = intEnv("VOICE_BARGE_IN_CLEAR_MS", 150, 0);
const VOICE_TWILIO_MARKS_ENABLED = boolEnv("VOICE_TWILIO_MARKS_ENABLED", true);
const VOICE_ALLOW_MULTILINGUAL = boolEnv("VOICE_ALLOW_MULTILINGUAL", false);
const DEFAULT_CALL_LANGUAGE = String(process.env.DEFAULT_CALL_LANGUAGE || "en")
  .trim()
  .toLowerCase();
const VOICE_DISABLE_FILLER_ACKS = boolEnv("VOICE_DISABLE_FILLER_ACKS", true);
const CALL_END_CONFIRMATION_ENABLED = boolEnv(
  "CALL_END_CONFIRMATION_ENABLED",
  true,
);
const VOICE_VAD_THRESHOLD = Number(process.env.VOICE_VAD_THRESHOLD || 0.5);
const VOICE_VAD_PREFIX_PADDING_MS = intEnv(
  "VOICE_VAD_PREFIX_PADDING_MS",
  300,
  0,
);

const DEFAULT_VOICE = process.env.OPENAI_REALTIME_VOICE || "alloy";
const OPENAI_REALTIME_TRANSCRIPTION_MODEL =
  process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL || "gpt-4o-transcribe";
const OPENAI_REALTIME_TRANSCRIPTION_LANGUAGE = String(
  process.env.OPENAI_REALTIME_TRANSCRIPTION_LANGUAGE || "en",
).trim();
const OPENAI_REALTIME_TRANSCRIPTION_PROMPT = String(
  process.env.OPENAI_REALTIME_TRANSCRIPTION_PROMPT ||
    "Phone call audio. Transcribe exactly what the caller says. Do not invent words, languages, goodbyes, or names. Preserve English business-call wording.",
).trim();
const DEFAULT_GREETING =
  process.env.TWILIO_MEDIA_INITIAL_GREETING ||
  "Hello, thank you for calling. How can I help you today?";

const CLOSING_MESSAGE =
  process.env.TWILIO_MEDIA_CLOSING_MESSAGE ||
  "Thank you for calling. Have a wonderful day.";
const IDLE_TIMEOUT_MS = Math.max(
  5000,
  Number(
    process.env.INBOUND_CALL_IDLE_TIMEOUT_MS ||
      process.env.VOICE_IDLE_HANGUP_MS ||
      15000,
  ),
);
const NO_SPEECH_TIMEOUT_MS = Math.max(
  5000,
  intEnv("NO_SPEECH_TIMEOUT_SECONDS", 15, 5) * 1000,
);
const NO_SPEECH_FOLLOWUP_TIMEOUT_MS = Math.max(
  5000,
  intEnv("NO_SPEECH_FOLLOWUP_TIMEOUT_SECONDS", 10, 5) * 1000,
);
const FINAL_AUDIO_HANGUP_DELAY_MS = Math.max(
  500,
  Number(process.env.TWILIO_FINAL_AUDIO_HANGUP_DELAY_MS || 1200),
);
const MAX_INBOUND_CALL_SECONDS = Math.max(
  30,
  Number(process.env.MAX_INBOUND_CALL_SECONDS || 900),
);
const CALL_CONTEXT_LOAD_TIMEOUT_MS = Math.max(
  750,
  Number(process.env.CALL_CONTEXT_LOAD_TIMEOUT_MS || 3500),
);
const OUTBOUND_LEAVE_VOICEMAIL =
  String(process.env.OUTBOUND_LEAVE_VOICEMAIL || "false")
    .trim()
    .toLowerCase() === "true";
const OUTBOUND_LEAVE_VOICEMAIL_RESULT_AS_NOTE =
  String(process.env.OUTBOUND_LEAVE_VOICEMAIL_RESULT_AS_NOTE || "false")
    .trim()
    .toLowerCase() === "true";
const SCHEDULED_CALL_VOICE_PROVIDER = String(
  process.env.SCHEDULED_CALL_VOICE_PROVIDER || "agent_default",
)
  .trim()
  .toLowerCase();
const SCHEDULED_CALL_MAX_ASSISTANT_SENTENCE_COUNT = Math.max(
  1,
  intEnv("SCHEDULED_CALL_MAX_ASSISTANT_SENTENCE_COUNT", 2, 1),
);
const SCHEDULED_CALL_WAIT_FOR_USER_AFTER_GREETING = boolEnv(
  "SCHEDULED_CALL_WAIT_FOR_USER_AFTER_GREETING",
  true,
);
const SCHEDULED_CALL_DISABLE_MONOLOGUE = boolEnv(
  "SCHEDULED_CALL_DISABLE_MONOLOGUE",
  true,
);
const OUTBOUND_VOICE_TURN_SILENCE_MS = intEnv(
  "OUTBOUND_VOICE_TURN_SILENCE_MS",
  Math.max(VOICE_TURN_SILENCE_MS, 1700),
  300,
);
const OUTBOUND_VOICE_MIN_USER_SPEECH_MS = intEnv(
  "OUTBOUND_VOICE_MIN_USER_SPEECH_MS",
  Math.max(VOICE_MIN_USER_SPEECH_MS, 750),
  100,
);
const OUTBOUND_VOICE_RESPONSE_DEBOUNCE_MS = intEnv(
  "OUTBOUND_VOICE_RESPONSE_DEBOUNCE_MS",
  Math.max(VOICE_RESPONSE_DEBOUNCE_MS, 800),
  0,
);
const OUTBOUND_CALL_DISABLE_MONOLOGUE = boolEnv(
  "OUTBOUND_CALL_DISABLE_MONOLOGUE",
  true,
);
const OUTBOUND_CALL_MAX_ASSISTANT_SENTENCE_COUNT = Math.max(
  1,
  intEnv(
    "OUTBOUND_CALL_MAX_ASSISTANT_SENTENCE_COUNT",
    SCHEDULED_CALL_MAX_ASSISTANT_SENTENCE_COUNT,
    1,
  ),
);
const ELEVENLABS_GREETING_AUDIO_TIMEOUT_MS = intEnv(
  "ELEVENLABS_GREETING_AUDIO_TIMEOUT_MS",
  3500,
  1000,
);
const ELEVENLABS_GREETING_AUDIO_FALLBACK_RETRIES = intEnv(
  "ELEVENLABS_GREETING_AUDIO_FALLBACK_RETRIES",
  4,
  1,
);
const ELEVENLABS_GREETING_AUDIO_FALLBACK_RETRY_MS = intEnv(
  "ELEVENLABS_GREETING_AUDIO_FALLBACK_RETRY_MS",
  900,
  250,
);

const activeTwilioSessions = new Set();

const OPENAI_VOICE_ALLOWLIST = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "fable",
  "onyx",
  "nova",
]);

const DASHBOARD_VOICE_MAP = {
  zephyr: "shimmer",
  puck: "echo",
  charon: "onyx",
  kore: "nova",
  fenrir: "onyx",
};

function safeSend(ws, payload) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
      return true;
    }
  } catch (err) {
    console.warn("[twilio-media-stream] safeSend warning:", err.message);
  }
  return false;
}

function safeJson(value) {
  try {
    return JSON.stringify(value || {});
  } catch (_) {
    return "{}";
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function normalizeVoiceName(value) {
  return String(value || "")
    .trim()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9_ -]/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function mapVoiceProfileToOpenAi(voiceProfile) {
  const configuredDefault = normalizeVoiceName(
    process.env.OPENAI_REALTIME_VOICE || DEFAULT_VOICE,
  );
  const fallback = OPENAI_VOICE_ALLOWLIST.has(configuredDefault)
    ? configuredDefault
    : "alloy";
  const normalized = normalizeVoiceName(voiceProfile);
  if (!normalized) return fallback;
  if (OPENAI_VOICE_ALLOWLIST.has(normalized)) return normalized;
  if (DASHBOARD_VOICE_MAP[normalized]) return DASHBOARD_VOICE_MAP[normalized];
  const firstWord = normalized.split(" ")[0];
  if (DASHBOARD_VOICE_MAP[firstWord]) return DASHBOARD_VOICE_MAP[firstWord];
  if (OPENAI_VOICE_ALLOWLIST.has(firstWord)) return firstWord;
  return fallback;
}

function sessionKeyFor(context, streamSid) {
  return `${context.callSid || "no-call"}:${streamSid || "no-stream"}`;
}

function queryContext(req) {
  const parsed = new URL(req.url || "", "http://localhost");
  const params = parsed.searchParams;
  return {
    path: parsed.pathname,
    query: Object.fromEntries(params.entries()),
    orgId: firstNonEmpty(params.get("orgId"), params.get("organizationId")),
    agentId: firstNonEmpty(params.get("agentId"), params.get("voiceAgentId")),
    callRecordId: firstNonEmpty(params.get("callRecordId")),
    callSid: firstNonEmpty(params.get("callSid")),
    direction: firstNonEmpty(params.get("direction"), "inbound"),
    callerPhone: firstNonEmpty(params.get("callerPhone"), params.get("from")),
    recipientPhone: firstNonEmpty(
      params.get("recipientPhone"),
      params.get("to"),
    ),
    recipientName: firstNonEmpty(
      params.get("recipientName"),
      params.get("targetName"),
    ),
    targetName: firstNonEmpty(
      params.get("targetName"),
      params.get("recipientName"),
    ),
    leadId: firstNonEmpty(params.get("leadId")),
    callPurpose: firstNonEmpty(params.get("callPurpose")),
    customInstructions: firstNonEmpty(params.get("customInstructions")),
    language: firstNonEmpty(params.get("language"), params.get("callLanguage")),
    agentName: firstNonEmpty(params.get("agentName")),
    organizationName: firstNonEmpty(
      params.get("organizationName"),
      params.get("businessName"),
      params.get("companyName"),
    ),
    voiceProviderHint: firstNonEmpty(params.get("voiceProviderHint")),
    openAiVoiceHint: firstNonEmpty(
      params.get("openAiVoice"),
      params.get("openaiVoice"),
      params.get("openAiVoiceHint"),
    ),
    elevenLabsVoiceIdHint: firstNonEmpty(
      params.get("elevenLabsVoiceId"),
      params.get("elevenlabsVoiceId"),
      params.get("elevenLabsVoiceIdHint"),
    ),
    elevenLabsVoiceNameHint: firstNonEmpty(
      params.get("elevenLabsVoiceName"),
      params.get("elevenlabsVoiceName"),
      params.get("elevenLabsVoiceNameHint"),
    ),
    voiceProfile: firstNonEmpty(params.get("voiceProfile")),
    voiceProviderOverride: firstNonEmpty(params.get("voiceProviderOverride")),
    voiceProviderFallbackReason: firstNonEmpty(
      params.get("voiceProviderFallbackReason"),
    ),
    scheduleId: firstNonEmpty(params.get("scheduleId")),
    scheduleRunId: firstNonEmpty(params.get("scheduleRunId")),
  };
}

function mergeStartParameters(context, start) {
  const custom = start?.customParameters || {};
  return {
    ...context,
    orgId: firstNonEmpty(custom.orgId, custom.organizationId, context.orgId),
    agentId: firstNonEmpty(
      custom.agentId,
      custom.voiceAgentId,
      context.agentId,
    ),
    callRecordId: firstNonEmpty(custom.callRecordId, context.callRecordId),
    callSid: firstNonEmpty(start?.callSid, custom.callSid, context.callSid),
    direction: firstNonEmpty(custom.direction, context.direction, "inbound"),
    callerPhone: firstNonEmpty(
      custom.callerPhone,
      custom.from,
      start?.from,
      context.callerPhone,
    ),
    recipientPhone: firstNonEmpty(
      custom.recipientPhone,
      custom.to,
      start?.to,
      context.recipientPhone,
    ),
    recipientName: firstNonEmpty(
      custom.recipientName,
      custom.targetName,
      custom.name,
      context.recipientName,
      context.targetName,
    ),
    targetName: firstNonEmpty(
      custom.targetName,
      custom.recipientName,
      custom.name,
      context.targetName,
      context.recipientName,
    ),
    leadId: firstNonEmpty(custom.leadId, context.leadId),
    callPurpose: firstNonEmpty(custom.callPurpose, context.callPurpose),
    customInstructions: firstNonEmpty(
      custom.customInstructions,
      context.customInstructions,
    ),
    language: firstNonEmpty(
      custom.language,
      custom.callLanguage,
      context.language,
    ),
    agentName: firstNonEmpty(custom.agentName, context.agentName),
    organizationName: firstNonEmpty(
      custom.organizationName,
      custom.businessName,
      custom.companyName,
      context.organizationName,
      context.businessName,
      context.companyName,
    ),
    voiceProviderHint: firstNonEmpty(
      custom.voiceProviderHint,
      context.voiceProviderHint,
    ),
    openAiVoiceHint: firstNonEmpty(
      custom.openAiVoice,
      custom.openaiVoice,
      custom.openAiVoiceHint,
      context.openAiVoiceHint,
    ),
    elevenLabsVoiceIdHint: firstNonEmpty(
      custom.elevenLabsVoiceId,
      custom.elevenlabsVoiceId,
      custom.elevenLabsVoiceIdHint,
      context.elevenLabsVoiceIdHint,
    ),
    elevenLabsVoiceNameHint: firstNonEmpty(
      custom.elevenLabsVoiceName,
      custom.elevenlabsVoiceName,
      custom.elevenLabsVoiceNameHint,
      context.elevenLabsVoiceNameHint,
    ),
    voiceProfile: firstNonEmpty(custom.voiceProfile, context.voiceProfile),
    voiceProviderOverride: firstNonEmpty(
      custom.voiceProviderOverride,
      context.voiceProviderOverride,
    ),
    voiceProviderFallbackReason: firstNonEmpty(
      custom.voiceProviderFallbackReason,
      context.voiceProviderFallbackReason,
    ),
    scheduleId: firstNonEmpty(custom.scheduleId, context.scheduleId),
    scheduleRunId: firstNonEmpty(custom.scheduleRunId, context.scheduleRunId),
  };
}

function logLifecycle(label, details = {}) {
  console.log(`[twilio-media-stream] ${label}`, details);
}

function getOpenAiErrorMessage(event) {
  const err = event?.error || event;
  return String(err?.message || err?.code || safeJson(err));
}

function normalizeSpeechText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9+\s.'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCallLanguage(value) {
  const raw = String(value || DEFAULT_CALL_LANGUAGE || "en").trim();
  const lower = raw.toLowerCase();
  if (!lower || /^(en|eng|english|en-us|en_us|en-gb|en_gb)$/i.test(lower)) {
    return { code: "en", name: "English" };
  }
  if (/^(fr|fra|fre|french|fr-fr)$/i.test(lower))
    return { code: "fr", name: "French" };
  if (/^(es|spa|spanish|es-es|es-mx)$/i.test(lower))
    return { code: "es", name: "Spanish" };
  if (/^(ar|ara|arabic)$/i.test(lower)) return { code: "ar", name: "Arabic" };
  if (/^(pt|por|portuguese)$/i.test(lower))
    return { code: "pt", name: "Portuguese" };
  if (/^(de|ger|deu|german)$/i.test(lower))
    return { code: "de", name: "German" };
  return VOICE_ALLOW_MULTILINGUAL
    ? { code: lower.slice(0, 8), name: raw }
    : { code: "en", name: "English" };
}

function configuredLanguageForContext(context = {}) {
  return normalizeCallLanguage(
    firstNonEmpty(
      context.language,
      context.callLanguage,
      context.sessionLanguage,
      context.agent?.language,
      DEFAULT_CALL_LANGUAGE,
      "en",
    ),
  );
}

function languageRulesForContext(context = {}) {
  const language = configuredLanguageForContext(context);
  const multilingualText = VOICE_ALLOW_MULTILINGUAL
    ? "Only switch languages after the caller explicitly asks and the business context supports that language. Logically return to the configured language when the caller asks."
    : `If the caller speaks another language, politely continue in ${language.name} and say you can currently assist in ${language.name}.`;
  return [
    "LANGUAGE RULE:",
    `- The configured call language is ${language.name} (${language.code}).`,
    `- Speak only in ${language.name} from the first word of the call.`,
    "- Do not spontaneously switch to French, Spanish, Arabic, or any other language.",
    "- Do not mirror accidental multilingual noise, background speech, transcript artifacts, or knowledge-base language.",
    multilingualText,
  ].join("\n");
}

function looksLikeNonEnglishForConfiguredLanguage(text, context = {}) {
  const value = String(text || "").trim();
  if (!value) return false;
  const language = configuredLanguageForContext(context);
  if (language.code !== "en") return false;
  const markers = [
    /\b(bonjour|bonsoir|d'accord|daccord|tr[eè]s\s+bien|bien\s+s[uû]r|merci|au\s+revoir|rappellera|souhaitez|cr[eé]neau|pr[eé]f[eé]rez|noter\s+cela|je\s+vais|est[-\s]?ce\s+que|hola|gracias|adios|buenos\s+d[ií]as|hablo|idioma)\b/i,
    /[àâçéèêëîïôûùüÿñ¿¡]/i,
    /\b(je|vous|nous|avec|pour|dans|une|des|les|que|qui|est|pas|tr[eè]s)\b/i,
  ];
  return markers.some((pattern) => pattern.test(value));
}

function buildLanguageCorrectionText(context = {}) {
  const language = configuredLanguageForContext(context);
  const identity = voiceBehavior.buildCallerIdentityPhrase({
    agentName: context.agentName || context.agent?.name || "",
    organizationName:
      context.organizationName ||
      context.businessName ||
      context.companyName ||
      context.organization?.name ||
      "",
  });
  const cleanPurpose = voiceBehavior.sanitizeOutboundPurposeText(
    context.callPurpose || "",
    160,
  );
  if (isOutboundContext(context)) {
    const purposeClause = cleanPurpose
      ? ` I'm calling about ${cleanPurpose}.`
      : " I'm calling for a quick follow-up.";
    return `Sorry about that — I'll continue in ${language.name}. ${identity ? `This is ${identity}.` : "This is the configured phone agent for this business."}${purposeClause} Do you have a quick moment?`;
  }
  return `Sorry about that — I'll continue in ${language.name}. ${identity ? `This is ${identity}.` : "This is the configured receptionist for this business."} How can I help?`;
}

function enforceSpeechLanguage(text, context = {}, label = "assistant") {
  const value = String(text || "").trim();
  if (!value || VOICE_ALLOW_MULTILINGUAL) return value;
  if (!looksLikeNonEnglishForConfiguredLanguage(value, context)) return value;
  const replacement = buildLanguageCorrectionText(context);
  console.warn(
    "[language-guard] blocked non-configured-language assistant text",
    {
      callSid: context.callSid || "",
      streamSid: context.streamSid || "",
      label,
      configuredLanguage: configuredLanguageForContext(context),
      originalPreview: value.slice(0, 180),
      replacementPreview: replacement.slice(0, 180),
    },
  );
  return replacement;
}

function hasEndIntent(text, options = {}) {
  const t = normalizeSpeechText(text);
  if (!t) return false;

  // Strict caller-driven close detection. Do not end on "thank you" alone.
  // The previous barge-in fix became too conservative because it could cancel
  // a valid goodbye hangup on any speech-start/noise event. This detector only
  // fires for explicit goodbye/hangup language or clear "that's all" answers
  // when the assistant has just asked if anything else is needed.
  const explicitClosePatterns = [
    /\b(bye|goodbye|good bye|talk to you later)\b/,
    /\b(end|finish|close|disconnect)\s+(the\s+)?call\b/,
    /\b(hang\s*up|you can hang\s*up|please hang\s*up)\b/,
    /\b(thank you|thanks)\b.*\b(bye|goodbye|good bye)\b/,
    /\b(bye|goodbye|good bye)\b.*\b(thank you|thanks)\b/,
    /\b(that'?s all|that is all|nothing else|no more questions)\b.*\b(thank you|thanks|bye|goodbye|good bye)\b/,
    /\b(no,?\s*)?(that'?s all|that is all|nothing else|no more questions)\b.*\b(end|hang\s*up|bye|goodbye|good bye)\b/,
  ];

  if (explicitClosePatterns.some((pattern) => pattern.test(t))) return true;

  if (options.afterAnythingElsePrompt) {
    return /\b(no,?\s*)?(that'?s all|that is all|nothing else|no more questions)\b/.test(
      t,
    );
  }

  return false;
}

function assistantAskedAnythingElse(text) {
  const t = normalizeSpeechText(text);
  return /\b(anything else|anything more|is there anything else|do you need anything else|can i help with anything else)\b/.test(
    t,
  );
}

function assistantAskedEndPermission(text) {
  const t = normalizeSpeechText(text);
  if (!t) return false;
  return (
    /\b(is it okay|is it ok|should i|can i|may i|okay if i|ok if i)\b.{0,80}\b(end|finish|close|hang\s*up|disconnect)\b/.test(
      t,
    ) ||
    /\b(that completes|that'?s all|that is all)\b.{0,100}\b(end|finish|close|hang\s*up|disconnect)\b/.test(
      t,
    )
  );
}

function isSimpleEndPermissionYes(text) {
  const t = normalizeSpeechText(text);
  if (!t) return false;
  return (
    /^(yes|yeah|yep|sure|ok|okay|alright|all right|please|please do|go ahead|you can|you may|that'?s fine|that is fine)\.?$/.test(
      t,
    ) ||
    /\b(yes|yeah|yep|sure|ok|okay|alright|all right|please do|go ahead|you can|you may)\b.{0,40}\b(end|finish|close|hang\s*up|disconnect)\b/.test(
      t,
    )
  );
}

function hasHangupCancelIntent(text) {
  const t = normalizeSpeechText(text);
  if (!t) return false;
  return /\b(wait|hold on|one more thing|i'?m not done|i am not done|not done|actually|before you go|don'?t hang up|do not hang up|i still|i have another|another question)\b/.test(
    t,
  );
}

function isHangupConfirmationAffirmative(text) {
  const t = normalizeSpeechText(text);
  if (!t) return false;
  return [
    /^(yes|yeah|yep|sure|ok|okay|alright|all right|correct|please do|go ahead)\.?$/,
    /\b(yes|yeah|yep|sure|ok|okay|alright|all right),?\s*(end|finish|close|hang\s*up|disconnect)\b/,
    /\b(end|finish|close|disconnect)\s+(the\s+)?call\b/,
    /\b(you can|please|kindly)\s+(end|finish|close|hang\s*up|disconnect)\b/,
    /\b(that'?s all|that is all|nothing else|no more questions|no,?\s*that'?s all)\b/,
    /\b(thank you|thanks).{0,40}\b(bye|goodbye|good bye)\b/,
    /\b(bye|goodbye|good bye)\b/,
  ].some((pattern) => pattern.test(t));
}

function isHangupConfirmationNegativeOrContinue(text) {
  const t = normalizeSpeechText(text);
  if (!t) return false;
  return [
    /\b(no|not yet|wait|hold on|one more thing|i'?m not done|i am not done|not done|actually|before you go|don'?t hang up|do not hang up)\b/,
    /\b(i still|i have another|another question|can you also|i want to ask|i need to ask|let me ask)\b/,
  ].some((pattern) => pattern.test(t));
}

function hangupConfirmationPrompt(context = {}, reason = "") {
  const name = voiceBehavior.cleanRecipientNameForSpeech(
    firstNonEmpty(
      context.recipientName,
      context.targetName,
      context.callerName,
    ),
  );
  const prefix = name ? `${name}, ` : "";
  if (isOutboundContext(context)) {
    return `${prefix}will that be all for today, or is there anything else I can help you with?`;
  }
  if (/message|callback|lead|complaint/i.test(String(reason || ""))) {
    return `${prefix}I have your message. Is there anything else you need help with?`;
  }
  return `${prefix}is there anything else I can help you with?`;
}

function isOutboundContext(context = {}) {
  return (
    String(context.direction || "")
      .trim()
      .toLowerCase() === "outbound"
  );
}

function sanitizeOutboundPurposeText(text, maxChars = 150) {
  return voiceBehavior.sanitizeOutboundPurposeText(text, maxChars);
}

function conciseOutboundPurposeForGreeting(text, maxChars = 140) {
  return sanitizeOutboundPurposeText(text, maxChars);
}

function outboundGreetingReasonClause(text) {
  return voiceBehavior.outboundGreetingReasonClause(text);
}

function sentenceCaseStart(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function buildOutboundGreeting(options = {}) {
  return voiceBehavior.buildOutboundGreeting(options);
}

function repairOutboundPurposePhrasing(text) {
  return voiceBehavior.repairOutboundPurposePhrasing(text);
}

function outboundMessageCaptureEnabled() {
  const value = String(process.env.OUTBOUND_MESSAGE_CAPTURE_ENABLED || "true")
    .trim()
    .toLowerCase();
  return !(
    value === "false" ||
    value === "0" ||
    value === "no" ||
    value === "off"
  );
}

function shouldEnableMessageCapture(context = {}) {
  if (isOutboundContext(context)) return outboundMessageCaptureEnabled();
  return true;
}

function isLikelyVoicemailOrIvrText(text) {
  const t = normalizeSpeechText(text);
  if (!t) return false;
  const strongPhrases = [
    "please record your message",
    "record your message",
    "after the tone",
    "message saved",
    "save the recording",
    "mailbox",
    "voicemail",
    "voice mail",
    "leave your message",
  ];
  if (strongPhrases.some((phrase) => t.includes(phrase))) return true;
  const weakSignals = [
    "press 1",
    "press one",
    "press 2",
    "press two",
    "press 3",
    "press three",
    "press star",
    "press any digit",
    "leave a message",
    "re record",
    "rerecord",
  ];
  const hits = weakSignals.filter((phrase) => t.includes(phrase)).length;
  return hits >= 2;
}

function looksLikeMessageCapture(text) {
  const t = normalizeSpeechText(text);
  if (!t) return false;
  return /\b(leave (a )?message|take (a )?message|call me back|callback|call back|my name is|this is [a-z]|my phone|my number|please tell|let them know|message is|i need|i want to|can someone|have someone)\b/.test(
    t,
  );
}

function extractCallerNameFromTranscript(text) {
  const value = String(text || "");
  const patterns = [
    /\bmy name is\s+([A-Za-z][A-Za-z .'-]{1,60})/i,
    /\bthis is\s+([A-Za-z][A-Za-z .'-]{1,60})/i,
    /\bi am\s+([A-Za-z][A-Za-z .'-]{1,60})/i,
    /\bi'm\s+([A-Za-z][A-Za-z .'-]{1,60})/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1])
      return match[1]
        .replace(
          /\b(and|calling|from|my|phone|number|message|callback)\b.*$/i,
          "",
        )
        .trim()
        .slice(0, 80);
  }
  return "";
}

function extractCallbackTimeFromTranscript(text) {
  const value = String(text || "");
  const patterns = [
    /\b(call me back|callback|call back|reach me)\s+(at|around|by|after|before)?\s*([^.;!?\n]{2,80})/i,
    /\b(preferred callback time|best time to call)\s*(is|:)?\s*([^.;!?\n]{2,80})/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const raw = match?.[3] || match?.[2] || "";
    if (raw) return raw.trim().slice(0, 120);
  }
  return "";
}

function extractPhoneFromTranscript(text, fallback = "") {
  const direct = String(text || "")
    .replace(/\s+/g, " ")
    .match(/\+?\d[\d\s().-]{6,}\d/);
  if (direct?.[0]) return direct[0].replace(/[^+\d]/g, "").slice(0, 32);
  return String(fallback || "").trim();
}

function summarizeTranscript(lines, max = 900) {
  const text = (lines || [])
    .map(
      (line) => String(line.role || "unknown") + ": " + String(line.text || ""),
    )
    .join("\n")
    .trim();
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

function buildTranscriptArray(lines) {
  return (lines || [])
    .filter((line) => line && line.text)
    .map((line) => ({
      role: line.role || "unknown",
      text: String(line.text || "").trim(),
      ts: line.ts || new Date().toISOString(),
    }));
}

function mergeMetadata(existing, patch) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? existing
      : {};
  return { ...base, ...(patch || {}) };
}

function buildLeadReason(message, callbackTime) {
  const parts = [];
  if (message) parts.push(String(message).trim());
  if (callbackTime)
    parts.push("Callback preference/time: " + String(callbackTime).trim());
  return parts.join("\n").slice(0, 1800);
}

function cleanCapturedMessageText(text, maxChars = 1800) {
  let value = String(text || "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*(user|caller|recipient|assistant|agent)\s*:\s*/i, "")
        .trim(),
    )
    .filter(Boolean)
    .join(" ")
    .replace(/^"|"$/g, "")
    .replace(/^(?:the\s+)?message\s+(?:is|was)\s*[:,-]?\s*/i, "")
    .replace(
      /^please\s+(?:tell|let)\s+(?:them|the\s+team|someone)\s+(?:know\s+)?(?:that\s+)?/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (!value) return "";
  if (value.length > maxChars)
    value = value.slice(0, maxChars - 1).replace(/[\s,;:.-]+$/, "") + "...";
  return value;
}

function extractMessageForTeamFromTranscript(text, context = {}) {
  const value = String(text || "").trim();
  if (!value) return "";
  const lines = value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const joined = lines.join(" ");
  const patterns = [
    /(?:please\s+)?(?:tell|let)\s+(?:them|the\s+team|someone|him|her)\s+(?:know\s+)?(?:that\s+)?(.{8,800})/i,
    /(?:my\s+)?message\s+(?:is|was)\s*[:,-]?\s*(.{8,800})/i,
    /(?:take|leave)\s+(?:a\s+)?message\s*[:,-]?\s*(.{8,800})/i,
    /(?:call\s+me\s+back|callback|call\s+back)\s*(?:at|around|on|when|tomorrow|today|next|after|before)?\s*(.{0,800})/i,
  ];
  for (const pattern of patterns) {
    const match = joined.match(pattern);
    if (match?.[1]) {
      const cleaned = cleanCapturedMessageText(match[1]);
      if (cleaned) return cleaned;
    }
  }
  const candidate = lines.length ? lines[lines.length - 1] : joined;
  const cleaned = cleanCapturedMessageText(candidate);
  if (!cleaned) return "";
  if (cleaned.length <= 500 || looksLikeMessageCapture(cleaned)) return cleaned;
  return cleaned.slice(0, 500).replace(/[\s,;:.-]+$/, "") + "...";
}

function parseJsonMaybe(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch (_) {
    return {};
  }
}

function parseToolArguments(args) {
  const parsed = parseJsonMaybe(args);
  return {
    caller_name: firstNonEmpty(
      parsed.caller_name,
      parsed.callerName,
      parsed.name,
    ),
    caller_phone: firstNonEmpty(
      parsed.caller_phone,
      parsed.callerPhone,
      parsed.phone,
    ),
    message: firstNonEmpty(parsed.message, parsed.question, parsed.reason),
    callback_time: firstNonEmpty(
      parsed.callback_time,
      parsed.callbackTime,
      parsed.requested_callback_time,
    ),
    email: firstNonEmpty(parsed.email),
  };
}

function captureToolDefinition() {
  return {
    type: "function",
    name: "capture_inbound_message",
    description:
      "Save a caller's voice message, callback request, unanswered question, or follow-up details after collecting whatever contact fields are naturally available. Use for inbound and outbound calls.",
    parameters: {
      type: "object",
      properties: {
        caller_name: {
          type: "string",
          description: "Caller name, if provided.",
        },
        caller_phone: {
          type: "string",
          description: "Caller phone number, if provided.",
        },
        message: {
          type: "string",
          description:
            "The caller's message, question, or reason for callback.",
        },
        callback_time: {
          type: "string",
          description: "Preferred callback time or callback preference.",
        },
        email: {
          type: "string",
          description: "Caller email address, if provided.",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
  };
}

function likelyUnansweredQuestion(text, assistantText) {
  const a = normalizeSpeechText(assistantText);
  const q = String(text || "").trim();
  if (!q || q.length < 8) return false;
  return (
    /\?/.test(q) ||
    /\b(what|how|when|where|why|do you|can you|is there|are there|price|cost|sell|offer)\b/i.test(
      q,
    ) ||
    /\b(do not have|don't have|not have enough information|cannot answer|not in.*knowledge|team.*follow up|take a message)\b/.test(
      a,
    )
  );
}

async function endTwilioCall(callSid) {
  if (!callSid) throw new Error("Missing callSid");
  const accountSid = (process.env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = (process.env.TWILIO_AUTH_TOKEN || "").trim();
  if (!accountSid || !authToken)
    throw new Error(
      "TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is not configured on Railway",
    );
  const form = "Status=completed";
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "POST",
        hostname: "api.twilio.com",
        path: `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(callSid)}.json`,
        auth: `${accountSid}:${authToken}`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(form),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300)
            return resolve({ statusCode: res.statusCode, data });
          reject(
            new Error(
              `Twilio REST HTTP ${res.statusCode}: ${data.slice(0, 500)}`,
            ),
          );
        });
      },
    );
    req.on("error", reject);
    req.write(form);
    req.end();
  });
}

async function safeDbWrite(label, fn) {
  try {
    const result = await fn();
    if (result?.error) {
      console.warn(
        `[message-capture] ${label} failed`,
        result.error.message || result.error,
      );
      return { data: null, error: result.error };
    }
    return { data: result?.data || null, error: null };
  } catch (err) {
    console.warn(`[message-capture] ${label} failed`, err.message || err);
    return { data: null, error: err };
  }
}

async function createTenantNotification({
  db,
  context,
  type,
  title,
  body = "",
  callRecordId = null,
  metadata = {},
}) {
  const organizationId = context.orgId || context.organizationId || null;
  if (!organizationId || !type || !title) return null;
  const result = await safeDbWrite("tenant_notifications insert", () =>
    db
      .from("tenant_notifications")
      .insert({
        organization_id: organizationId,
        type,
        title,
        body: String(body || "").slice(0, 1000),
        entity_type: callRecordId ? "call_record" : "voice_call",
        entity_id: callRecordId || null,
        voice_agent_id: context.agentId || null,
        call_record_id: callRecordId || null,
        is_read: false,
        metadata,
      })
      .select("id")
      .maybeSingle(),
  );
  if (result?.data?.id) {
    console.log("[notification] created", {
      type,
      id: result.data.id,
      callRecordId,
    });
  }
  return result?.data || null;
}

async function createNotificationsFromInsights({
  db,
  context,
  callRecordId,
  insights,
}) {
  if (!insights || !callRecordId) return;
  const fields = insights.collected_fields || {};
  const baseMeta = {
    call_purpose: insights.call_purpose || context.callPurpose || "",
    schedule_id: context.scheduleId || "",
    schedule_run_id: context.scheduleRunId || "",
    direct_recipient: insights.direct_recipient || null,
  };
  if (insights.flags?.has_message_for_team) {
    await createTenantNotification({
      db,
      context,
      type: "message_captured",
      title: "Call message captured",
      body:
        fields.message_for_team ||
        "A caller left a message during a voice call.",
      callRecordId,
      metadata: { ...baseMeta, collected_fields: fields },
    });
  }
  if (insights.flags?.has_callback_request) {
    await createTenantNotification({
      db,
      context,
      type: "lead_requested_follow_up",
      title: "Caller requested follow-up",
      body: fields.callback_time
        ? `Callback requested: ${fields.callback_time}`
        : "The caller requested follow-up.",
      callRecordId,
      metadata: { ...baseMeta, collected_fields: fields },
    });
  }
  if (insights.flags?.has_unanswered_question) {
    await createTenantNotification({
      db,
      context,
      type: "unanswered_question_captured",
      title: "Unanswered question captured",
      body:
        fields.unanswered_question ||
        fields.question_asked ||
        "A caller asked a question that needs follow-up.",
      callRecordId,
      metadata: { ...baseMeta, collected_fields: fields },
    });
  }
  if (insights.flags?.has_transfer_request) {
    await createTenantNotification({
      db,
      context,
      type: "transfer_requested",
      title: "Caller requested a human transfer",
      body: "The caller asked to speak with a human or representative.",
      callRecordId,
      metadata: { ...baseMeta, collected_fields: fields },
    });
  }
  if (insights.flags?.has_opt_out) {
    await createTenantNotification({
      db,
      context,
      type: "opt_out_requested",
      title: "Caller requested do-not-call handling",
      body: "The caller asked not to be contacted again.",
      callRecordId,
      metadata: { ...baseMeta, collected_fields: fields },
    });
  }
  await createTenantNotification({
    db,
    context,
    type: "call_completed",
    title: "Call completed",
    body: insights.summary || "A voice call was completed.",
    callRecordId,
    metadata: { ...baseMeta, collected_fields: fields },
  });
}

async function findExistingCallRecord(db, { callRecordId, twilioCallSid }) {
  if (callRecordId) {
    const byId = await safeDbRead("call_records existing by id", () =>
      db.from("call_records").select("*").eq("id", callRecordId).maybeSingle(),
    );
    if (byId.data) return byId.data;
  }
  if (twilioCallSid) {
    const bySid = await safeDbRead(
      "call_records existing by twilio_call_sid",
      () =>
        db
          .from("call_records")
          .select("*")
          .eq("twilio_call_sid", twilioCallSid)
          .maybeSingle(),
    );
    if (bySid.data) return bySid.data;
  }
  return null;
}

function uniq(values) {
  return [...new Set((values || []).filter(Boolean))];
}

async function findLeadsForCall(db, callSid, callRecordId) {
  const needles = uniq([firstNonEmpty(callSid), firstNonEmpty(callRecordId)]);
  const all = [];
  for (const needle of needles) {
    const result = await safeDbRead(
      "leads existing assignment_context",
      () =>
        db
          .from("leads")
          .select("*")
          .ilike("assignment_context", "%" + needle + "%")
          .limit(25),
      [],
    );
    if (Array.isArray(result.data)) all.push(...result.data);
  }
  return uniqueRowsById(all);
}

async function findExistingLeadForCall(db, callSid, callRecordId) {
  const leads = await findLeadsForCall(db, callSid, callRecordId);
  return leads.length ? chooseCanonicalLead(leads, null) : null;
}

function uniqueRowsById(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const id = row?.id || JSON.stringify(row);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

function leadCompletenessScore(lead) {
  let score = 0;
  const name = String(lead?.name || "").trim();
  const phone = String(lead?.phone || "").trim();
  const reason = String(lead?.reason || "").trim();
  const email = String(lead?.email || "").trim();
  if (name && !/^unknown/i.test(name)) score += 5;
  if (
    phone &&
    phone !== "the number I'm calling with" &&
    phone !== "the number i am calling with"
  )
    score += phone.startsWith("+") ? 5 : 2;
  if (reason.length > 20) score += 5;
  if (email) score += 2;
  if (String(lead?.status || "") !== "duplicate") score += 1;
  return score;
}

function chooseCanonicalLead(leads, metadataLeadId = null) {
  const list = uniqueRowsById(leads || []);
  if (!list.length) return null;
  if (metadataLeadId) {
    const matched = list.find((lead) => lead?.id === metadataLeadId);
    if (matched) return matched;
  }
  return list.slice().sort((a, b) => {
    const scoreDiff = leadCompletenessScore(b) - leadCompletenessScore(a);
    if (scoreDiff) return scoreDiff;
    return (
      new Date(b?.created_at || 0).getTime() -
      new Date(a?.created_at || 0).getTime()
    );
  })[0];
}

async function findLeadById(db, leadId) {
  if (!leadId) return null;
  const result = await safeDbRead("lead by metadata lead_id", () =>
    db.from("leads").select("*").eq("id", leadId).maybeSingle(),
  );
  return result.data || null;
}

function normalizeCapturedPhone(value, fallback = "") {
  const raw = String(value || "").trim();
  const fb = String(fallback || "").trim();
  if (!raw) return fb;
  const lowered = raw.toLowerCase();
  if (
    /(number i'?m calling|number i am calling|same number|this number|caller id|calling from)/i.test(
      lowered,
    )
  )
    return fb || raw;
  const digits = raw.replace(/[^0-9+]/g, "");
  if (!digits || digits.replace(/[^0-9]/g, "").length < 7) return fb || raw;
  return digits.startsWith("+") ? digits : raw;
}

function buildLeadPayload({
  organizationId,
  voiceAgentId,
  callerName,
  callerPhone,
  email,
  messageText,
  callbackTime,
  status,
  source,
  twilioCallSid,
  callRecordId,
  existingCallRecord,
}) {
  return {
    organization_id: organizationId,
    name: callerName || "Unknown Caller",
    phone: callerPhone || null,
    email: email || "",
    reason: buildLeadReason(messageText, callbackTime),
    status: status || "new",
    source,
    tags: ["voice_agent", source || "inbound_call"],
    voice_agent_id: voiceAgentId,
    assignment_context: `Captured from ${source || "inbound_call"} ${twilioCallSid || existingCallRecord?.id || callRecordId || "unknown"}`,
  };
}

async function updateExistingLeadForCall(db, lead, payload) {
  if (!lead?.id) return { data: null, error: new Error("Missing lead id") };
  const existingTags = Array.isArray(lead.tags) ? lead.tags : [];
  const mergedTags = [...new Set([...existingTags, ...(payload.tags || [])])];
  const update = {
    name: payload.name || lead.name || "Unknown Caller",
    phone:
      normalizeCapturedPhone(payload.phone, lead.phone || "") ||
      lead.phone ||
      null,
    email: payload.email || lead.email || "",
    reason:
      payload.reason &&
      String(payload.reason).length >= String(lead.reason || "").length
        ? payload.reason
        : lead.reason || payload.reason || "",
    status:
      lead.status === "duplicate"
        ? "new"
        : lead.status || payload.status || "new",
    source: lead.source || payload.source || "inbound_call",
    tags: mergedTags,
    voice_agent_id: lead.voice_agent_id || payload.voice_agent_id || null,
    assignment_context: lead.assignment_context || payload.assignment_context,
  };
  console.log("[message-capture] updating existing lead id=" + lead.id);
  return safeDbWrite("leads update existing", () =>
    db.from("leads").update(update).eq("id", lead.id).select("*").maybeSingle(),
  );
}

async function updateCallRecordWithMessage(
  db,
  {
    existingCallRecord,
    callRecordId,
    twilioCallSid,
    transcriptArray,
    summary,
    callerName,
    callerPhone,
    metadataPatch,
  },
) {
  const metadata = mergeMetadata(existingCallRecord?.metadata, metadataPatch);
  const update = {
    transcript: transcriptArray,
    summary: String(summary || "").slice(0, 1800),
    status: "completed",
    metadata,
  };
  if (callerName) update.caller_name = callerName;
  if (callerPhone) update.caller_phone = callerPhone;
  console.log("[message-capture] updating call record metadata", {
    callRecordId,
    twilioCallSid,
    status: metadata.message_capture_status || "",
  });
  if (existingCallRecord?.id || callRecordId) {
    return safeDbWrite("call_records update by id", () =>
      db
        .from("call_records")
        .update(update)
        .eq("id", existingCallRecord?.id || callRecordId)
        .select("id, metadata")
        .maybeSingle(),
    );
  }
  if (twilioCallSid) {
    return safeDbWrite("call_records update by twilio_call_sid", () =>
      db
        .from("call_records")
        .update(update)
        .eq("twilio_call_sid", twilioCallSid)
        .select("id, metadata")
        .maybeSingle(),
    );
  }
  return { data: null, error: new Error("No call record identifier") };
}

function transcriptText(lines, role = null) {
  return (lines || [])
    .filter((line) => !role || String(line.role || "").toLowerCase() === role)
    .map((line) => String(line.text || "").trim())
    .filter(Boolean)
    .join("\n");
}

async function saveTranscriptOnly({ context, transcriptLines, summary = "" }) {
  const db = getSupabase();
  const callRecordId = context.callRecordId || null;
  const twilioCallSid = context.callSid || null;
  if (!callRecordId && !twilioCallSid)
    return { saved: false, reason: "missing call record id/callSid" };
  const existingCallRecord = await findExistingCallRecord(db, {
    callRecordId,
    twilioCallSid,
  });
  const transcriptArray = buildTranscriptArray(transcriptLines);
  const insights = extractStructuredCallInsights({
    transcriptLines,
    context,
    existingSummary: summary || existingCallRecord?.summary || "",
  });
  const metadata = mergeMetadata(existingCallRecord?.metadata, {
    call_intelligence: insights,
    collected_fields: insights.collected_fields || {},
    message_for_team: insights.collected_fields?.message_for_team || "",
    call_purpose: insights.call_purpose || context.callPurpose || "",
    custom_instructions:
      insights.custom_instructions || context.customInstructions || "",
    call_end_details: {
      ended_at: new Date().toISOString(),
      transcript_length: transcriptArray.length,
      twilio_call_sid: twilioCallSid || null,
    },
    ...(context.voiceOutputDebug
      ? { voice_output: context.voiceOutputDebug }
      : {}),
  });
  const update = {
    transcript: transcriptArray,
    summary: String(
      insights.summary ||
        summary ||
        existingCallRecord?.summary ||
        summarizeTranscript(transcriptLines, 900),
    ).slice(0, 1800),
    status: "completed",
    metadata,
  };
  const result =
    existingCallRecord?.id || callRecordId
      ? await safeDbWrite("call_records transcript update by id", () =>
          db
            .from("call_records")
            .update(update)
            .eq("id", existingCallRecord?.id || callRecordId)
            .select("id")
            .maybeSingle(),
        )
      : await safeDbWrite("call_records transcript update by sid", () =>
          db
            .from("call_records")
            .update(update)
            .eq("twilio_call_sid", twilioCallSid)
            .select("id")
            .maybeSingle(),
        );
  if (result?.data?.id) {
    console.log("[call-record] transcript saved", {
      id: result.data.id,
      transcriptLength: transcriptArray.length,
    });
    await createNotificationsFromInsights({
      db,
      context,
      callRecordId: result.data.id,
      insights,
    });
    if (insights.collected_fields?.unanswered_question) {
      await insertUnansweredQuestion({
        context,
        callRecordId: result.data.id,
        question: insights.collected_fields.unanswered_question,
        botResponse: transcriptText(transcriptLines, "assistant"),
      });
    }
  }
  return {
    saved: Boolean(result?.data?.id),
    id: result?.data?.id || null,
    insights,
  };
}

async function insertUnansweredQuestion({
  context,
  callRecordId,
  question,
  botResponse,
}) {
  const db = getSupabase();
  const organizationId = context.orgId || context.organizationId || null;
  const voiceAgentId = context.agentId || null;
  if (!organizationId || !question) return null;
  const result = await safeDbWrite("unanswered_questions insert", () =>
    db
      .from("unanswered_questions")
      .insert({
        organization_id: organizationId,
        voice_agent_id: voiceAgentId,
        call_record_id: callRecordId || null,
        question: String(question).slice(0, 2000),
        bot_response: String(botResponse || "").slice(0, 2000),
        source: isOutboundContext(context) ? "outbound_call" : "inbound_call",
        is_resolved: false,
      })
      .select("id")
      .maybeSingle(),
  );
  if (result?.data?.id)
    console.log("[unanswered-question] saved id=" + result.data.id);
  return result?.data || null;
}

async function persistInboundCallMessage({
  context,
  transcriptLines,
  userTranscripts,
  assistantTranscripts,
  captureState,
  toolArgs = null,
  status = "new",
  mode = "tool",
}) {
  const db = getSupabase();
  const transcriptArray = buildTranscriptArray(transcriptLines);
  const transcriptSummary = summarizeTranscript(transcriptLines, 12000);
  const userText = (userTranscripts || []).join("\n").trim();
  const assistantText = (assistantTranscripts || []).join(" ").trim();
  const args = toolArgs ? parseToolArguments(toolArgs) : {};
  const messageText = firstNonEmpty(
    cleanCapturedMessageText(args.message),
    extractMessageForTeamFromTranscript(captureState.message, context),
    extractMessageForTeamFromTranscript(userText, context),
    cleanCapturedMessageText(captureState.message),
    cleanCapturedMessageText(userText),
    cleanCapturedMessageText(transcriptSummary),
  );
  const callerName = firstNonEmpty(
    args.caller_name,
    captureState.callerName,
    extractCallerNameFromTranscript(userText),
    "Unknown Caller",
  );
  const callerPhone = normalizeCapturedPhone(
    firstNonEmpty(
      args.caller_phone,
      captureState.callerPhone,
      extractPhoneFromTranscript(userText, context.callerPhone),
      context.callerPhone,
    ),
    context.callerPhone,
  );
  const callbackTime = firstNonEmpty(
    args.callback_time,
    captureState.callbackTime,
    extractCallbackTimeFromTranscript(userText),
  );
  const email = firstNonEmpty(args.email, captureState.email);
  const organizationId = context.orgId || context.organizationId || null;
  const voiceAgentId = context.agentId || null;
  const callRecordId = context.callRecordId || null;
  const twilioCallSid = context.callSid || null;
  const direction = String(context.direction || "inbound").toLowerCase();
  const source = direction === "outbound" ? "outbound_call" : "inbound_call";

  if (direction === "outbound" && context.voicemailDetected) {
    console.log("[message-capture] skipped outbound voicemail", {
      callSid: twilioCallSid,
    });
    return {
      saved: false,
      skipped: true,
      reason: "outbound voicemail detected",
    };
  }
  if (direction === "outbound" && !outboundMessageCaptureEnabled()) {
    console.log(
      "[message-capture] skipped because direction=outbound and no human interest detected",
      { callSid: twilioCallSid },
    );
    return {
      saved: false,
      skipped: true,
      reason: "outbound message capture disabled",
    };
  }

  if (!organizationId || !messageText)
    return { saved: false, reason: "missing organization or message" };

  console.log("[message-capture] parsed args", {
    callerName,
    callerPhone,
    callbackTime,
    email: email ? "provided" : "",
  });

  const existingCallRecord = await findExistingCallRecord(db, {
    callRecordId,
    twilioCallSid,
  });
  const existingMetadata = existingCallRecord?.metadata || {};
  const metadataLeadId =
    existingMetadata?.inbound_call_message?.lead_id ||
    captureState.savedLeadId ||
    null;
  const leadPayload = buildLeadPayload({
    organizationId,
    voiceAgentId,
    callerName,
    callerPhone,
    email,
    messageText,
    callbackTime,
    status,
    source,
    twilioCallSid,
    callRecordId,
    existingCallRecord,
  });

  if (direction === "outbound" && !context.leadId) {
    const savedAt = new Date().toISOString();
    const outboundMessage = {
      lead_id: null,
      caller_name: callerName || context.recipientName || "Outbound Recipient",
      caller_phone:
        callerPhone || context.recipientPhone || context.callerPhone || "",
      message: messageText,
      callback_time: callbackTime || "",
      email: email || "",
      saved_at: savedAt,
      source,
      mode,
      direct_recipient: {
        name: context.recipientName || context.targetName || "",
        phone: context.recipientPhone || "",
      },
    };
    await updateCallRecordWithMessage(db, {
      existingCallRecord,
      callRecordId,
      twilioCallSid,
      transcriptArray,
      summary: messageText,
      callerName: outboundMessage.caller_name,
      callerPhone: outboundMessage.caller_phone,
      metadataPatch: {
        outbound_call_message: outboundMessage,
        message: messageText,
        message_captured: messageText,
        captured_message: messageText,
        caller_message: messageText,
        callback_time: callbackTime || "",
        callback_requested: Boolean(callbackTime),
        message_capture_status:
          mode === "fallback"
            ? "fallback_saved_without_lead"
            : "saved_without_lead",
      },
    });
    await createTenantNotification({
      db,
      context,
      type: callbackTime ? "lead_requested_follow_up" : "message_captured",
      title: callbackTime
        ? "Outbound recipient requested follow-up"
        : "Outbound call message captured",
      body: messageText,
      callRecordId: existingCallRecord?.id || callRecordId || null,
      metadata: {
        outbound_call_message: outboundMessage,
        message: messageText,
        callback_time: callbackTime || "",
        callback_requested: Boolean(callbackTime),
      },
    });
    captureState.messageCaptureSaved = true;
    captureState.saved = true;
    captureState.saveResult = {
      saved: true,
      lead: null,
      message: messageText,
      callbackTime,
      outboundNoLead: true,
    };
    console.log(
      "[message-capture] outbound direct message saved without lead insert",
      {
        callSid: twilioCallSid,
        callRecordId: existingCallRecord?.id || callRecordId || "",
      },
    );
    return captureState.saveResult;
  }

  let canonicalLead = null;
  if (captureState.messageCaptureSaved && captureState.savedLeadId) {
    canonicalLead = await findLeadById(db, captureState.savedLeadId);
    if (canonicalLead?.id)
      console.log("[message-capture] existing lead found", {
        leadId: canonicalLead.id,
        source: "memory",
      });
  }
  if (!canonicalLead && metadataLeadId) {
    canonicalLead = await findLeadById(db, metadataLeadId);
    if (canonicalLead?.id)
      console.log("[message-capture] existing lead found", {
        leadId: canonicalLead.id,
        source: "call_record_metadata",
      });
  }
  const leadsForCall = await findLeadsForCall(
    db,
    twilioCallSid,
    existingCallRecord?.id || callRecordId,
  );
  if (!canonicalLead && leadsForCall.length) {
    canonicalLead = chooseCanonicalLead(leadsForCall, metadataLeadId);
    if (canonicalLead?.id)
      console.log("[message-capture] existing lead found", {
        leadId: canonicalLead.id,
        source: "assignment_context",
      });
  }

  let savedLead = null;
  if (canonicalLead?.id) {
    if (
      mode === "fallback" &&
      (captureState.messageCaptureSaved || metadataLeadId)
    ) {
      console.log(
        "[message-capture] fallback skipped existing lead id=" +
          canonicalLead.id,
      );
    } else {
      console.log("[message-capture] duplicate prevented", {
        callSid: twilioCallSid,
        leadId: canonicalLead.id,
        mode,
      });
    }
    const updated = await updateExistingLeadForCall(
      db,
      canonicalLead,
      leadPayload,
    );
    savedLead = updated?.data || canonicalLead;
  } else {
    console.log("[message-capture] inserting lead", {
      organizationId,
      voiceAgentId,
      callRecordId,
      twilioCallSid,
    });
    const leadInsert = await safeDbWrite("leads insert", () =>
      db.from("leads").insert(leadPayload).select("*").maybeSingle(),
    );
    if (!leadInsert?.data?.id) {
      const failedPatch = {
        message_capture_status: "failed",
        message_capture_error:
          leadInsert?.error?.message ||
          String(leadInsert?.error || "lead insert failed"),
      };
      await updateCallRecordWithMessage(db, {
        existingCallRecord,
        callRecordId,
        twilioCallSid,
        transcriptArray,
        summary: messageText,
        callerName,
        callerPhone,
        metadataPatch: failedPatch,
      });
      console.warn("[message-capture] save failed", failedPatch);
      return {
        saved: false,
        error: failedPatch.message_capture_error,
        message: messageText,
      };
    }
    savedLead = leadInsert.data;
    console.log("[message-capture] saved lead id=" + savedLead.id);
  }

  captureState.messageCaptureSaved = true;
  captureState.savedLeadId = savedLead.id;
  captureState.saved = true;
  console.log("[message-capture] canonical lead id=" + savedLead.id);

  const savedAt = new Date().toISOString();
  const inboundMessage = {
    lead_id: savedLead.id,
    caller_name: callerName || savedLead.name || "Unknown Caller",
    caller_phone: callerPhone || savedLead.phone || context.callerPhone || "",
    message: messageText,
    callback_time: callbackTime || "",
    email: email || savedLead.email || "",
    saved_at: savedAt,
    source,
    mode,
  };

  await updateCallRecordWithMessage(db, {
    existingCallRecord,
    callRecordId,
    twilioCallSid,
    transcriptArray,
    summary: messageText,
    callerName,
    callerPhone,
    metadataPatch: {
      inbound_call_message: inboundMessage,
      message: messageText,
      message_captured: messageText,
      captured_message: messageText,
      caller_message: messageText,
      callback_time: callbackTime || "",
      callback_requested: Boolean(callbackTime),
      message_capture_status: mode === "fallback" ? "fallback_saved" : "saved",
    },
  });

  if (likelyUnansweredQuestion(messageText, assistantText)) {
    await insertUnansweredQuestion({
      context,
      callRecordId: existingCallRecord?.id || callRecordId,
      question: messageText,
      botResponse: assistantText,
    });
  }

  return {
    saved: true,
    duplicatePrevented: Boolean(canonicalLead?.id),
    lead: savedLead,
    callerName,
    callerPhone,
    callbackTime,
    email,
    message: messageText,
  };
}

async function markOutboundVoicemailDetected(
  context,
  transcriptText = "",
  answeredBy = "phrase",
) {
  if (!isOutboundContext(context) || !context.callSid) return null;
  const db = getSupabase();
  const existingCallRecord = await findExistingCallRecord(db, {
    callRecordId: context.callRecordId || null,
    twilioCallSid: context.callSid,
  });
  const metadata = mergeMetadata(existingCallRecord?.metadata, {
    answered_by: answeredBy || "voicemail_or_ivr",
    machine_detection_result: answeredBy || "phrase_detected",
    voicemail_detected: true,
    message_capture_skipped_reason: "outbound_voicemail_or_ivr",
    voicemail_detection_phrase: String(transcriptText || "").slice(0, 500),
    outbound_recipient_phone: context.recipientPhone || "",
    outbound_call_purpose: context.callPurpose || "",
  });
  const patch = { metadata };
  if (existingCallRecord?.id) {
    await safeDbWrite("call_records mark outbound voicemail by id", () =>
      db
        .from("call_records")
        .update(patch)
        .eq("id", existingCallRecord.id)
        .select("id")
        .maybeSingle(),
    );
  } else {
    await safeDbWrite("call_records mark outbound voicemail by sid", () =>
      db
        .from("call_records")
        .update(patch)
        .eq("twilio_call_sid", context.callSid)
        .select("id")
        .maybeSingle(),
    );
  }
  console.log("[outbound-call] voicemail detected", {
    callSid: context.callSid,
    answeredBy: answeredBy || "phrase_detected",
  });
  console.log("[message-capture] skipped outbound voicemail", {
    callSid: context.callSid,
  });
  return metadata;
}

function outboundVoicemailMessage(context = {}) {
  const agentName = firstNonEmpty(context.agentName, "your assistant");
  const organizationName = firstNonEmpty(
    context.organizationName,
    "the business",
  );
  return `Hello, this is ${agentName} from ${organizationName}. We were calling to follow up. Please call us back when convenient. Thank you.`;
}

async function loadCallMessageDebug(callSid) {
  const db = getSupabase();
  const sid = String(callSid || "").trim();
  if (!sid) return { ok: false, error: "callSid is required" };
  const callRecord = await safeDbRead(
    "debug call_records by twilio_call_sid",
    () =>
      db
        .from("call_records")
        .select("*")
        .eq("twilio_call_sid", sid)
        .maybeSingle(),
  );
  const callRecordId = callRecord.data?.id || null;
  const metadata = callRecord.data?.metadata || {};
  const inbound = metadata?.inbound_call_message || null;
  const outbound = metadata?.outbound_call_message || null;
  const capturedMessage =
    inbound ||
    outbound ||
    (metadata?.message_captured ||
    metadata?.captured_message ||
    metadata?.message
      ? {
          lead_id: null,
          message:
            metadata?.message_captured ||
            metadata?.captured_message ||
            metadata?.message,
        }
      : null);
  const leads = await findLeadsForCall(db, sid, callRecordId);
  const metadataLead = capturedMessage?.lead_id
    ? await findLeadById(db, capturedMessage.lead_id)
    : null;
  const voicemailDetected = Boolean(
    metadata?.voicemail_detected ||
    String(metadata?.answered_by || "").match(/machine|fax|voicemail|ivr/i),
  );
  const canonicalLead = voicemailDetected
    ? null
    : metadataLead ||
      chooseCanonicalLead(leads, capturedMessage?.lead_id || null);
  let unanswered = { data: [], error: null };
  if (callRecordId)
    unanswered = await safeDbRead(
      "debug unanswered_questions by call_record_id",
      () =>
        db
          .from("unanswered_questions")
          .select("*")
          .eq("call_record_id", callRecordId)
          .limit(25),
      [],
    );

  const transcript = callRecord.data?.transcript;
  const transcriptLength = Array.isArray(transcript)
    ? transcript.length
    : typeof transcript === "string" && transcript
      ? 1
      : 0;
  const structuredMessageSaved = voicemailDetected
    ? false
    : Boolean(
        capturedMessage?.lead_id ||
        capturedMessage?.message ||
        metadata?.message_captured ||
        metadata?.captured_message,
      );
  const leadSaved = voicemailDetected
    ? false
    : Boolean(canonicalLead?.id || capturedMessage?.lead_id);
  const unansweredQuestionSaved = Boolean((unanswered.data || []).length);
  const messageCaptureStatus =
    metadata?.message_capture_status || (leadSaved ? "saved" : "not_saved");
  const activeLeads = leads.filter(
    (lead) => String(lead?.status || "").toLowerCase() !== "duplicate",
  );
  const activeDuplicateLeadIds = activeLeads
    .map((lead) => lead.id)
    .filter((id) => id && id !== canonicalLead?.id);
  const markedDuplicateLeadIds = leads
    .filter((lead) => String(lead?.status || "").toLowerCase() === "duplicate")
    .map((lead) => lead.id)
    .filter(Boolean);
  const duplicateLeadIds = leads.map((lead) => lead.id).filter(Boolean);
  return {
    ok: true,
    callSid: sid,
    callRecordFound: Boolean(callRecord.data),
    transcriptFound: transcriptLength > 0,
    structuredMessageSaved,
    leadSaved,
    unansweredQuestionSaved,
    lead:
      canonicalLead ||
      (capturedMessage?.lead_id
        ? { id: capturedMessage.lead_id, fromCallRecordMetadata: true }
        : null),
    unansweredQuestions: (unanswered.data || []).map((row) => ({
      id: row.id,
      question: row.question,
      bot_response: row.bot_response,
      source: row.source,
      is_resolved: row.is_resolved,
    })),
    callRecord: callRecord.data
      ? {
          id: callRecord.data.id,
          organization_id: callRecord.data.organization_id,
          voice_agent_id: callRecord.data.voice_agent_id,
          summary: callRecord.data.summary || "",
          transcriptLength,
          metadata,
          direction: callRecord.data.direction || metadata.direction || "",
          answered_by: metadata.answered_by || "",
          voicemail_detected: voicemailDetected,
          recording_sid:
            callRecord.data.recording_sid ||
            metadata?.recording?.recording_sid ||
            "",
          recording_status:
            callRecord.data.recording_status ||
            metadata?.recording?.recording_status ||
            "",
          recording_available: Boolean(
            callRecord.data.recording_available ||
            metadata?.recording?.recording_status === "completed",
          ),
        }
      : null,
    messageCaptureStatus,
    duplicates: {
      count: activeDuplicateLeadIds.length,
      leadIds: duplicateLeadIds,
      activeDuplicateLeadIds,
      markedDuplicateLeadIds,
    },
  };
}

async function loadCallRecordDebug(callSid) {
  const db = getSupabase();
  const sid = String(callSid || "").trim();
  if (!sid) return { ok: false, error: "callSid is required" };
  const callRecord = await safeDbRead(
    "debug call_records full by twilio_call_sid",
    () =>
      db
        .from("call_records")
        .select("*")
        .eq("twilio_call_sid", sid)
        .maybeSingle(),
  );
  const record = callRecord.data || null;
  const metadata = record?.metadata || {};
  const transcript = Array.isArray(record?.transcript) ? record.transcript : [];
  const messageDebug = await loadCallMessageDebug(sid);
  return {
    ok: true,
    callSid: sid,
    callRecordFound: Boolean(record),
    direction: record?.direction || metadata.direction || "",
    answered_by: metadata.answered_by || "",
    machine_detection_result: metadata.machine_detection_result || "",
    voicemail_detected: Boolean(metadata.voicemail_detected),
    leadSaved: Boolean(messageDebug.leadSaved),
    leadSource: messageDebug.lead?.source || null,
    transcriptPreview: transcript.slice(0, 6),
    recording_sid:
      record?.recording_sid || metadata?.recording?.recording_sid || "",
    recording_status:
      record?.recording_status || metadata?.recording?.recording_status || "",
    recording_available: Boolean(
      record?.recording_available ||
      metadata?.recording?.recording_status === "completed",
    ),
    messageCaptureSkippedReason: metadata.message_capture_skipped_reason || "",
    duplicateLeadCount: messageDebug.duplicates?.count || 0,
    voiceProvider:
      metadata.voice_output?.voiceProvider || metadata.voiceProvider || "",
    voiceId: metadata.voice_output?.voiceId || "",
    fallbackUsed: Boolean(
      metadata.voice_output?.fallbackUsed || metadata.voice_provider_fallback,
    ),
    greetingSent: Boolean(metadata.voice_output?.greetingSent),
    greetingTtsCompleted: Boolean(metadata.voice_output?.greetingTtsCompleted),
    activeTts: Boolean(metadata.voice_output?.activeTts),
    queuedTtsCount: Number(metadata.voice_output?.queuedTtsCount || 0),
    noSpeechTimeoutStartedAt:
      metadata.voice_output?.noSpeechTimeoutStartedAt || null,
    callerSpeechDetected: Boolean(metadata.voice_output?.callerSpeechDetected),
    noSpeechTimeoutFired: Boolean(metadata.voice_output?.noSpeechTimeoutFired),
    audioFramesSentToTwilio: Number(
      metadata.voice_output?.audioFramesSentToTwilio || 0,
    ),
    elevenlabsErrors: metadata.voice_output?.elevenLabsErrors || [],
    openaiAudioIgnoredCount: Number(
      metadata.voice_output?.openaiAudioIgnoredCount || 0,
    ),
    duplicateGreetingPrevented: Number(
      metadata.voice_output?.duplicateGreetingPrevented || 0,
    ),
    closeReason:
      metadata.close_reason || metadata.voice_output?.hangupReason || "",
    hangupReason:
      metadata.hangup_reason || metadata.voice_output?.hangupReason || "",
    metadata,
  };
}

async function dedupeCallMessage(callSid) {
  const db = getSupabase();
  const sid = String(callSid || "").trim();
  if (!sid) return { ok: false, error: "callSid is required" };
  const callRecord = await safeDbRead(
    "dedupe call_records by twilio_call_sid",
    () =>
      db
        .from("call_records")
        .select("*")
        .eq("twilio_call_sid", sid)
        .maybeSingle(),
  );
  const callRecordId = callRecord.data?.id || null;
  const metadata = callRecord.data?.metadata || {};
  const inbound = metadata?.inbound_call_message || {};
  const leads = await findLeadsForCall(db, sid, callRecordId);
  if (!leads.length)
    return {
      ok: true,
      callSid: sid,
      canonicalLead: null,
      duplicatesMarked: [],
      duplicateCount: 0,
    };
  const canonical = chooseCanonicalLead(leads, inbound?.lead_id || null);
  if (!canonical?.id)
    return {
      ok: false,
      callSid: sid,
      error: "No canonical lead could be selected",
    };
  console.log("[message-capture] canonical lead id=" + canonical.id);

  const duplicates = leads.filter((lead) => lead.id !== canonical.id);
  const duplicatesMarked = [];
  for (const dup of duplicates) {
    const tags = Array.isArray(dup.tags) ? dup.tags : [];
    const nextTags = [...new Set([...tags, "duplicate"])];
    const result = await safeDbWrite("leads mark duplicate", () =>
      db
        .from("leads")
        .update({ status: "duplicate", tags: nextTags })
        .eq("id", dup.id)
        .select("id")
        .maybeSingle(),
    );
    if (result?.data?.id) duplicatesMarked.push(result.data.id);
  }

  if (callRecord.data?.id) {
    const nextInbound = { ...(inbound || {}), lead_id: canonical.id };
    const nextMetadata = mergeMetadata(metadata, {
      inbound_call_message: nextInbound,
      message_capture_status: metadata?.message_capture_status || "saved",
      duplicate_leads_marked: duplicatesMarked,
    });
    await safeDbWrite("call_records canonical lead metadata update", () =>
      db
        .from("call_records")
        .update({ metadata: nextMetadata })
        .eq("id", callRecord.data.id)
        .select("id")
        .maybeSingle(),
    );
  }

  return {
    ok: true,
    callSid: sid,
    canonicalLead: canonical,
    duplicatesMarked,
    duplicateCount: duplicatesMarked.length,
  };
}

async function safeDbRead(label, fn, fallback = null) {
  try {
    const result = await fn();
    if (result?.error) {
      const message = result.error.message || String(result.error);
      console.warn(`[twilio-media-stream] ${label} warning:`, message);
      return { data: fallback, error: message };
    }
    return { data: result?.data ?? fallback, error: null };
  } catch (err) {
    const message = err?.message || String(err);
    console.warn(`[twilio-media-stream] ${label} failed:`, message);
    return { data: fallback, error: message };
  }
}

async function loadAgentAndPrompt(context) {
  const fallbackPrompt =
    "You are an AI phone assistant for this business. Be concise, natural, and helpful. Speak in short phone-friendly sentences. If specific business knowledge is not loaded, say you do not have enough information in the business knowledge base and offer to take a message.";
  const diagnostics = {};

  try {
    const db = getSupabase();
    let agent = null;
    let organization = null;
    let effectiveOrgId = firstNonEmpty(context.orgId);

    if (context.agentId && effectiveOrgId) {
      const strict = await safeDbRead(
        "voice_agents strict id+organization+active lookup",
        () =>
          db
            .from("voice_agents")
            .select("*")
            .eq("id", context.agentId)
            .eq("organization_id", effectiveOrgId)
            .eq("is_active", true)
            .maybeSingle(),
      );
      diagnostics.agentStrictLookup =
        strict.error || (strict.data ? "matched" : "no row");
      agent = strict.data || null;
    }

    if (!agent && context.agentId && effectiveOrgId) {
      const scoped = await safeDbRead(
        "voice_agents scoped id+organization lookup",
        () =>
          db
            .from("voice_agents")
            .select("*")
            .eq("id", context.agentId)
            .eq("organization_id", effectiveOrgId)
            .maybeSingle(),
      );
      diagnostics.agentScopedLookup =
        scoped.error ||
        (scoped.data ? "matched without is_active=true filter" : "no row");
      agent = scoped.data || null;
    }

    if (!agent && context.agentId) {
      const byId = await safeDbRead("voice_agents id-only lookup", () =>
        db
          .from("voice_agents")
          .select("*")
          .eq("id", context.agentId)
          .maybeSingle(),
      );
      diagnostics.agentIdOnlyLookup =
        byId.error || (byId.data ? "matched by id only" : "no row");
      agent = byId.data || null;
      if (
        agent?.organization_id &&
        effectiveOrgId &&
        agent.organization_id !== effectiveOrgId
      ) {
        diagnostics.organizationMismatch = `agent.organization_id=${agent.organization_id} but request orgId=${effectiveOrgId}`;
      }
    }

    if (agent?.organization_id)
      effectiveOrgId = firstNonEmpty(effectiveOrgId, agent.organization_id);

    if (effectiveOrgId) {
      const orgLookup = await safeDbRead("organizations lookup", () =>
        db
          .from("organizations")
          .select("*")
          .eq("id", effectiveOrgId)
          .maybeSingle(),
      );
      diagnostics.organizationLookup =
        orgLookup.error || (orgLookup.data ? "matched" : "no row");
      organization = orgLookup.data || null;
    }

    if (!agent && organization?.active_voice_agent_id) {
      const activeAgent = await safeDbRead(
        "voice_agents active_voice_agent_id fallback lookup",
        () =>
          db
            .from("voice_agents")
            .select("*")
            .eq("id", organization.active_voice_agent_id)
            .eq("organization_id", organization.id)
            .maybeSingle(),
      );
      diagnostics.activeVoiceAgentFallback =
        activeAgent.error || (activeAgent.data ? "matched" : "no row");
      agent = activeAgent.data || null;
    }

    if (
      agent?.organization_id &&
      (!organization || organization.id !== agent.organization_id)
    ) {
      const agentOrg = await safeDbRead(
        "organizations agent.organization_id lookup",
        () =>
          db
            .from("organizations")
            .select("*")
            .eq("id", agent.organization_id)
            .maybeSingle(),
      );
      diagnostics.agentOrganizationLookup =
        agentOrg.error || (agentOrg.data ? "matched" : "no row");
      organization = agentOrg.data || organization;
      effectiveOrgId = agent.organization_id;
    }

    if (!agent) {
      logLifecycle("agent/context fallback prompt used", {
        orgId: context.orgId,
        agentId: context.agentId,
        organizationName: organization?.name || "",
        diagnostics,
      });
      const selectedVoice = mapVoiceProfileToOpenAi("");
      return {
        agent: null,
        organization,
        systemPrompt: fallbackPrompt,
        greeting: DEFAULT_GREETING,
        selectedVoice,
        openAiVoice: selectedVoice,
        voiceProvider: "openai",
        fallbackProvider: "openai",
        elevenLabsVoice: null,
        language: "English",
        voiceProfile: "",
        voiceContext: {
          stats: {
            faqs: 0,
            knowledgeChunks: 0,
            uploadedDocumentChunks: 0,
            scrapedContent: 0,
            productsServices: 0,
            callPurposes: 0,
            linkedChatbots: 0,
            finalPromptChars: fallbackPrompt.length,
          },
          diagnostics,
          samples: {
            firstFaq: "",
            firstKnowledgeChunk: "",
            firstProductService: "",
          },
          debug: null,
        },
      };
    }

    let voiceContext = null;
    let systemPrompt = fallbackPrompt;
    try {
      const contextDirection =
        context.direction || agent.direction || "inbound";
      const contextQuery =
        String(contextDirection).toLowerCase() === "outbound"
          ? [
              "outbound phone call",
              context.callPurpose || "",
              context.customInstructions || "",
              "business products services faqs follow up customer support",
            ]
              .filter(Boolean)
              .join(" ")
          : "inbound phone call business products services faqs support";
      voiceContext = await loadVoiceContext(
        db,
        effectiveOrgId || agent.organization_id,
        agent,
        contextQuery,
        {
          direction: contextDirection,
          callPurpose: context.callPurpose || "",
          customInstructions: context.customInstructions || "",
          leadId: context.leadId || "",
          scheduleId: context.scheduleId || "",
          scheduleRunId: context.scheduleRunId || "",
          callRecordId: context.callRecordId || "",
          recipientPhone: context.recipientPhone || context.callerPhone || "",
          recipientName: context.recipientName || context.targetName || "",
          callerPhone: context.callerPhone || "",
          assignmentContext:
            context.callPurpose || context.customInstructions || "",
        },
      );
      systemPrompt =
        voiceContext?.systemPrompt ||
        agent.system_prompt ||
        agent.prompt ||
        fallbackPrompt;
      systemPrompt = [
        systemPrompt,
        buildVoiceIntelligencePrompt({
          context,
          agent,
          organization: voiceContext?.organization || organization,
          voiceContext,
        }),
      ]
        .filter(Boolean)
        .join("\n\n");
      if (voiceContext?.organization) organization = voiceContext.organization;
      voiceContext.diagnostics = {
        ...(voiceContext.diagnostics || {}),
        ...diagnostics,
      };
    } catch (contextErr) {
      systemPrompt = agent.system_prompt || agent.prompt || fallbackPrompt;
      console.warn(
        "[twilio-media-stream] context-builder fallback prompt used:",
        contextErr.message,
      );
      voiceContext = {
        stats: {
          faqs: 0,
          knowledgeChunks: 0,
          uploadedDocumentChunks: 0,
          scrapedContent: 0,
          productsServices: 0,
          callPurposes: 0,
          linkedChatbots: 0,
          finalPromptChars: systemPrompt.length,
        },
        diagnostics: { ...diagnostics, contextBuilder: contextErr.message },
        samples: {
          firstFaq: "",
          firstKnowledgeChunk: "",
          firstProductService: "",
        },
        debug: null,
      };
    }

    const isOutbound =
      String(context.direction || "").toLowerCase() === "outbound";
    const organizationNameForGreeting =
      voiceBehavior.cleanOrganizationNameForSpeech(
        firstNonEmpty(organization?.name, context.organizationName),
      );
    const agentNameForGreeting = voiceBehavior.cleanAgentNameForSpeech(
      firstNonEmpty(agent.name, context.agentName),
    );
    const currentCallDebugForGreeting = voiceContext?.debug?.currentCall || {};
    const recipientNameForGreeting = voiceBehavior.cleanRecipientNameForSpeech(
      firstNonEmpty(
        context.recipientName,
        context.targetName,
        currentCallDebugForGreeting.directRecipientName,
        currentCallDebugForGreeting.leadName,
      ),
    );
    const generatedOutboundGreeting = buildOutboundGreeting({
      recipientName: recipientNameForGreeting,
      agentName: agentNameForGreeting,
      organizationName: organizationNameForGreeting,
      callPurpose:
        context.callPurpose || currentCallDebugForGreeting.callPurpose || "",
    });
    const customOutboundGreeting = voiceBehavior.safeCustomOutboundGreeting(
      firstNonEmpty(agent.outbound_greeting, agent.outbound_intro),
    );
    const outboundGreetingSource = boolEnv("OUTBOUND_USE_AGENT_GREETING", false)
      ? firstNonEmpty(customOutboundGreeting, generatedOutboundGreeting)
      : generatedOutboundGreeting;
    const outboundGreeting = voiceBehavior.repairOutboundAssistantText(
      repairOutboundPurposePhrasing(outboundGreetingSource),
      {
        ...context,
        recipientName: recipientNameForGreeting,
        targetName: recipientNameForGreeting,
      },
    );
    const defaultInboundGreeting = voiceBehavior.buildInboundGreeting({
      agentName: agentNameForGreeting,
      organizationName: organizationNameForGreeting,
    });
    const greeting = isOutbound
      ? outboundGreeting
      : firstNonEmpty(
          agent.greeting,
          agent.welcome_message,
          defaultInboundGreeting,
          DEFAULT_GREETING,
        );
    const language = firstNonEmpty(agent.language, "English");
    const voiceProfile = firstNonEmpty(
      context.openAiVoiceHint,
      agent.openai_voice,
      agent.openai_voice_id,
      agent.voice,
      "",
    );
    const selectedVoice = mapVoiceProfileToOpenAi(voiceProfile);
    const configuredVoiceProvider = normalizeProvider(
      firstNonEmpty(
        context.voiceProviderOverride,
        context.voiceProviderHint,
        agent.voice_provider,
        process.env.VOICE_PROVIDER_DEFAULT,
      ),
      "openai",
    );
    const configuredFallbackProvider = normalizeProvider(
      firstNonEmpty(process.env.VOICE_PROVIDER_FALLBACK, "openai"),
      "openai",
    );
    let voiceProvider = configuredVoiceProvider;
    let elevenLabsVoice = null;
    const voiceSettings = voiceSettingsFromAgent(agent);
    if (voiceProvider === "elevenlabs") {
      const voiceResolution = await resolveElevenLabsVoiceForAgent(db, agent);
      if (voiceResolution.ok && voiceResolution.voice?.voiceId) {
        elevenLabsVoice = voiceResolution.voice;
      } else {
        console.warn(
          "[voice-provider] elevenlabs unavailable; fallback=openai",
          {
            callSid: context.callSid,
            agentId: agent.id || context.agentId || "",
            reason: voiceResolution.reason || "voice_resolution_failed",
          },
        );
        voiceProvider = configuredFallbackProvider || "openai";
      }
    }

    const stats = voiceContext?.stats || {};
    const mergedDiagnostics = voiceContext?.diagnostics || diagnostics;
    console.log(
      "[voice-agent-context] orgId",
      effectiveOrgId || context.orgId || agent.organization_id || "",
    );
    console.log(
      "[voice-agent-context] agentId",
      agent.id || context.agentId || "",
    );
    console.log("[voice-agent-context] agentName", agent.name || "");
    console.log(
      "[voice-agent-context] organizationName",
      organization?.name || "",
    );
    console.log("[voice-agent-context] language", language);
    console.log("[voice-agent-context] greeting", greeting);
    console.log("[voice-agent-context] voiceProfile", voiceProfile);
    console.log("[voice-agent-context] voiceProvider", voiceProvider);
    if (context.voiceProviderOverride) {
      console.log("[voice-agent-context] voiceProviderOverride", {
        voiceProviderOverride: context.voiceProviderOverride,
        fallbackReason: context.voiceProviderFallbackReason || "",
      });
    }
    if (voiceProvider === "elevenlabs") {
      console.log("[voice-agent-context] voiceSettings", voiceSettings);
    }
    if (elevenLabsVoice?.voiceId) {
      console.log(
        "[voice-agent-context] elevenLabsVoiceId",
        elevenLabsVoice.voiceId,
      );
      console.log(
        "[voice-agent-context] elevenLabsModel",
        elevenLabsVoice.modelId || elevenLabsConfig().defaultModel,
      );
    }
    console.log(
      "[voice-agent-context] faqs count",
      stats.faqs || 0,
      mergedDiagnostics.faqs || "",
    );
    console.log(
      "[voice-agent-context] knowledge chunks count",
      stats.knowledgeChunks || 0,
      mergedDiagnostics.knowledgeChunks || "",
    );
    console.log(
      "[voice-agent-context] scraped content count",
      stats.scrapedContent || 0,
      mergedDiagnostics.scrapedContent || "",
    );
    console.log(
      "[voice-agent-context] uploaded chunks count",
      stats.uploadedDocumentChunks || 0,
      mergedDiagnostics.uploadedDocumentChunks || "",
    );
    console.log(
      "[voice-agent-context] products/services count",
      stats.productsServices || 0,
      mergedDiagnostics.productsServices || "",
    );
    console.log(
      "[voice-agent-context] call purposes count",
      stats.callPurposes || 0,
      mergedDiagnostics.callPurposes || "",
    );
    console.log(
      "[voice-agent-context] final prompt chars",
      stats.finalPromptChars || systemPrompt.length,
    );

    logLifecycle("agent loaded", {
      agentId: agent.id || context.agentId,
      agentName: agent.name || "",
      organizationId: effectiveOrgId || context.orgId || agent.organization_id,
      organizationName: organization?.name || "",
      language,
      voiceProfile,
      greetingMessage: greeting,
    });

    console.log(
      `[voice-map] ${voiceProfile || "default"} -> provider=${voiceProvider} openaiFallback=${selectedVoice} elevenLabsVoice=${elevenLabsVoice?.voiceId || "none"}`,
    );
    logLifecycle("voice profile mapped", {
      callSid: context.callSid,
      dashboardVoiceProfile: voiceProfile,
      voiceProvider,
      fallbackProvider: configuredFallbackProvider,
      openaiVoice: selectedVoice,
      elevenLabsVoiceId: elevenLabsVoice?.voiceId || "",
      elevenLabsModel: elevenLabsVoice?.modelId || "",
    });

    return {
      agent,
      organization,
      systemPrompt,
      greeting,
      selectedVoice,
      openAiVoice: selectedVoice,
      voiceProvider,
      fallbackProvider: configuredFallbackProvider,
      elevenLabsVoice,
      voiceSettings,
      language,
      voiceProfile,
      voiceContext,
    };
  } catch (err) {
    console.warn("[twilio-media-stream] prompt load warning:", err.message);
    const selectedVoice = mapVoiceProfileToOpenAi("");
    return {
      agent: null,
      organization: null,
      systemPrompt: fallbackPrompt,
      greeting: DEFAULT_GREETING,
      selectedVoice,
      openAiVoice: selectedVoice,
      voiceProvider: "openai",
      fallbackProvider: "openai",
      elevenLabsVoice: null,
      voiceSettings: {},
      language: "English",
      voiceProfile: "",
      voiceContext: {
        stats: {
          faqs: 0,
          knowledgeChunks: 0,
          uploadedDocumentChunks: 0,
          scrapedContent: 0,
          productsServices: 0,
          callPurposes: 0,
          linkedChatbots: 0,
          finalPromptChars: fallbackPrompt.length,
        },
        diagnostics: { fatalPromptLoadError: err.message },
        samples: {
          firstFaq: "",
          firstKnowledgeChunk: "",
          firstProductService: "",
        },
        debug: null,
      },
    };
  }
}

async function loadTwilioAgentContextForDebug({ orgId, agentId }) {
  const context = { orgId, agentId, direction: "inbound" };
  const loaded = await loadAgentAndPrompt(context);
  const debug = loaded.voiceContext?.debug || {};
  return {
    agentName: debug.agent?.name || loaded.agent?.name || "",
    organizationName:
      debug.organization?.name || loaded.organization?.name || "",
    language: loaded.language || loaded.agent?.language || "English",
    voiceProfile: loaded.voiceProfile || loaded.agent?.voice || "",
    greeting: loaded.greeting || "",
    promptPreview:
      debug.finalPromptPreview ||
      String(loaded.systemPrompt || "").slice(0, 500),
    agent: debug.agent || {
      id: loaded.agent?.id || agentId || "",
      name: loaded.agent?.name || "",
      language: loaded.language || loaded.agent?.language || "",
      voiceProfile: loaded.voiceProfile || loaded.agent?.voice || "",
      greeting: loaded.greeting || "",
      direction: loaded.agent?.direction || "",
    },
    organization: debug.organization || {
      id: loaded.organization?.id || orgId || "",
      name: loaded.organization?.name || "",
    },
    counts: debug.counts || {
      faqs: 0,
      knowledgeChunks: 0,
      uploadedDocumentChunks: 0,
      scrapedContent: 0,
      productsServices: 0,
      callPurposes: 0,
      finalPromptChars: String(loaded.systemPrompt || "").length,
    },
    samples: debug.samples || {
      firstFaq: "",
      firstKnowledgeChunk: "",
      firstProductService: "",
    },
    diagnostics: debug.diagnostics || loaded.voiceContext?.diagnostics || {},
    openaiVoice: loaded.selectedVoice || "",
    finalPromptPreview:
      debug.finalPromptPreview ||
      String(loaded.systemPrompt || "").slice(0, 1500),
    finalPromptChars:
      debug.finalPromptChars || String(loaded.systemPrompt || "").length,
  };
}

function isScheduledOutboundContext(context = {}) {
  return (
    String(context.direction || "").toLowerCase() === "outbound" &&
    Boolean(context.scheduleId || context.scheduleRunId)
  );
}

function turnSilenceMsForContext(context = {}) {
  return isOutboundContext(context)
    ? OUTBOUND_VOICE_TURN_SILENCE_MS
    : VOICE_TURN_SILENCE_MS;
}

function minUserSpeechMsForContext(context = {}) {
  return isOutboundContext(context)
    ? OUTBOUND_VOICE_MIN_USER_SPEECH_MS
    : VOICE_MIN_USER_SPEECH_MS;
}

function responseDebounceMsForContext(context = {}) {
  return isOutboundContext(context)
    ? OUTBOUND_VOICE_RESPONSE_DEBOUNCE_MS
    : VOICE_RESPONSE_DEBOUNCE_MS;
}

function maxAssistantSentencesForContext(context = {}) {
  if (isScheduledOutboundContext(context))
    return SCHEDULED_CALL_MAX_ASSISTANT_SENTENCE_COUNT;
  if (isOutboundContext(context))
    return OUTBOUND_CALL_MAX_ASSISTANT_SENTENCE_COUNT;
  return 0;
}

function shouldDisableOutboundMonologue(context = {}) {
  if (isScheduledOutboundContext(context))
    return SCHEDULED_CALL_DISABLE_MONOLOGUE;
  if (isOutboundContext(context)) return OUTBOUND_CALL_DISABLE_MONOLOGUE;
  return false;
}

function enhanceSystemPromptForScheduledCall(systemPrompt, context = {}) {
  if (!isOutboundContext(context)) return systemPrompt;
  const maxSentences = maxAssistantSentencesForContext(context) || 2;
  const rules = [
    voiceBehavior.outboundBehaviorRules({
      callPurpose: context.callPurpose || "",
      recipientName: context.recipientName || context.targetName || "",
    }),
    isScheduledOutboundContext(context)
      ? "Scheduled outbound call rules:"
      : "Outbound call rules:",
    "- You placed this outbound call. Be respectful, brief, and assume the recipient may be busy.",
    "- Use the known recipient name when available in the greeting, occasionally during the conversation, and in the final goodbye. Do not overuse the name. Do not invent a name.",
    "- If the recipient asks whether you know their name, answer only from the provided call context.",
    "- Introduce yourself and the business, state the call purpose in natural grammar, then pause and listen.",
    "- Never say awkward phrases like 'for the purpose of', 'because to', or 'to for the purpose of'. Rephrase the purpose into a normal sentence.",
    "- After the opening greeting, do not continue with a monologue. Wait for the recipient's real response.",
    "- Ask one question at a time, then wait. Do not keep talking over the recipient.",
    "- If the recipient interrupts, stop speaking immediately, listen, acknowledge their concern, then answer briefly.",
    "- If they ask why you are calling or say they did not request the call, calmly explain the call purpose once, apologize for the interruption, and offer to take a message, schedule a callback, or end the call.",
    "- If they are busy, ask whether they prefer a callback time or want to leave a message. Capture only the message/callback details, not the full conversation.",
    "- Use business knowledge and FAQs to answer questions. If the answer is not available, say so and offer to take a message.",
    "- Before ending, ask one closing confirmation only. If the caller confirms, says okay/alright/sure/thanks/bye/goodbye, or gives no further request, give one short final goodbye and stop.",
    "- After you have said goodbye, do not ask if they want to leave a message and do not reopen the conversation unless the caller clearly asks a new question before hangup.",
    `- Keep each assistant turn to at most ${maxSentences} short sentence(s), unless the recipient asks for detail.`,
  ];
  if (context.callPurpose) {
    rules.push(
      `- Call purpose to convey naturally: ${sanitizeOutboundPurposeText(context.callPurpose, 240) || context.callPurpose}`,
    );
  }
  if (context.customInstructions)
    rules.push(
      `- Additional outbound instruction from the operator: ${context.customInstructions}`,
    );
  return [String(systemPrompt || "").trim(), rules.join("\n")]
    .filter(Boolean)
    .join("\n\n");
}

function scheduledProviderOverrideFromEnv(context = {}) {
  if (!isScheduledOutboundContext(context)) return "";
  if (["openai", "elevenlabs"].includes(SCHEDULED_CALL_VOICE_PROVIDER))
    return SCHEDULED_CALL_VOICE_PROVIDER;
  return "";
}

function dynamicIdentityRules(context = {}) {
  const agentName = voiceBehavior.cleanAgentNameForSpeech(
    firstNonEmpty(context.agentName, context.agent?.name),
  );
  const organizationName = voiceBehavior.cleanOrganizationNameForSpeech(
    firstNonEmpty(
      context.organizationName,
      context.businessName,
      context.companyName,
      context.organization?.name,
    ),
  );
  const direction = String(context.direction || "").toLowerCase();
  const rules = [
    "Dynamic SaaS agent identity rules:",
    languageRulesForContext(context),
  ];
  if (agentName)
    rules.push(`- Your configured agent name for this call is ${agentName}.`);
  if (organizationName)
    rules.push(`- You represent ${organizationName} in this call.`);
  if (direction === "outbound") {
    rules.push(
      "- This is an outbound business call placed by the configured tenant agent. Never claim you are a generic virtual assistant, ChatGPT, or an unrelated online assistant.",
      "- If asked who you are, state the configured agent name and business if available, then briefly explain the call purpose.",
      "- If asked where you got the number, explain that you only have the contact details provided for this outreach, then offer to continue, take a message, schedule a callback, stop the call, or respect an opt-out.",
      "- If exact business context is unavailable, say you do not have enough details loaded yet and offer to take a message. Do not invent a business identity.",
    );
  } else {
    rules.push(
      "- This is an inbound business call. Act as the configured business receptionist, not as a generic assistant.",
      "- If exact business context is unavailable, collect a message or callback request instead of inventing facts.",
    );
  }
  return rules.join("\n");
}

function enhanceSystemPromptForVoice(systemPrompt, context = {}) {
  const base = String(systemPrompt || "").trim();
  const rules = [
    dynamicIdentityRules(context),
    "Voice-call behavior rules:",
    "- Wait for the caller to finish speaking before answering.",
    "- Do not respond to tiny noises, breaths, clipped syllables, or unclear partial utterances.",
    "- Keep spoken replies concise: one to three short sentences unless the caller asks for detail.",
    "- Use natural punctuation and pacing for phone speech.",
  ];
  if (VOICE_DISABLE_FILLER_ACKS) {
    rules.push(
      "- Avoid filler-only acknowledgements such as 'Got it', 'Okay', or 'Sure' while the caller may still be speaking.",
    );
  }
  return [base, rules.join("\n")].filter(Boolean).join("\n\n");
}

function openAiRealtimeTranscriptionConfig(context = {}) {
  const callLanguage = configuredLanguageForContext(context);
  const config = {
    model: OPENAI_REALTIME_TRANSCRIPTION_MODEL,
    language: OPENAI_REALTIME_TRANSCRIPTION_LANGUAGE || callLanguage.code,
  };
  if (!config.language && callLanguage.code) {
    config.language = callLanguage.code;
  }
  if (OPENAI_REALTIME_TRANSCRIPTION_PROMPT) {
    config.prompt = OPENAI_REALTIME_TRANSCRIPTION_PROMPT;
  }
  return config;
}

function openAiRealtimeTurnDetection(context = {}) {
  return {
    type: "server_vad",
    threshold: VOICE_VAD_THRESHOLD,
    prefix_padding_ms: VOICE_VAD_PREFIX_PADDING_MS,
    silence_duration_ms: turnSilenceMsForContext(context),
    create_response: true,
    interrupt_response: true,
  };
}

function openAiRealtimeAudioInput(context = {}) {
  return {
    format: { type: "audio/pcmu" },
    transcription: openAiRealtimeTranscriptionConfig(context),
    turn_detection: openAiRealtimeTurnDetection(context),
  };
}

function openAiRealtimeAudioOutput(selectedVoice) {
  return {
    format: { type: "audio/pcmu" },
    voice: selectedVoice || DEFAULT_VOICE,
  };
}

function realtimeSessionUpdate(
  systemPrompt,
  selectedVoice,
  enableMessageCapture = true,
  context = {},
) {
  return realtimeSessionUpdateCurrent(
    systemPrompt,
    selectedVoice,
    enableMessageCapture,
    context,
  );
}

function realtimeSessionUpdateCurrent(
  systemPrompt,
  selectedVoice,
  enableMessageCapture = true,
  context = {},
) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: enhanceSystemPromptForVoice(systemPrompt, context),
      output_modalities: ["audio"],
      tools: enableMessageCapture ? [captureToolDefinition()] : [],
      tool_choice: enableMessageCapture ? "auto" : "none",
      audio: {
        input: openAiRealtimeAudioInput(context),
        output: openAiRealtimeAudioOutput(selectedVoice),
      },
    },
  };
}

function realtimeSessionUpdateTextOnly(
  systemPrompt,
  enableMessageCapture = true,
  context = {},
) {
  return realtimeSessionUpdateTextOnlyCurrent(
    systemPrompt,
    enableMessageCapture,
    context,
  );
}

function realtimeSessionUpdateTextOnlyCurrent(
  systemPrompt,
  enableMessageCapture = true,
  context = {},
) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: enhanceSystemPromptForVoice(systemPrompt, context),
      output_modalities: ["text"],
      tools: enableMessageCapture ? [captureToolDefinition()] : [],
      tool_choice: enableMessageCapture ? "auto" : "none",
      audio: {
        input: openAiRealtimeAudioInput(context),
      },
    },
  };
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collapseDuplicateWords(text) {
  let output = String(text || "");
  for (let i = 0; i < 4; i += 1) {
    output = output.replace(/\b([A-Za-z]{2,})\b(?:\s*[—-]\s*|\s+)\1\b/gi, "$1");
  }
  return output;
}

function removeRepeatedIntro(text, context = {}) {
  let output = String(text || "");
  const agentName = escapeRegExp(context.agentName || "");
  const orgName = escapeRegExp(context.organizationName || "");
  if (agentName) {
    output = output.replace(
      new RegExp(`(this is\\s+${agentName})(?:[,.!]?\\s*)\\1`, "ig"),
      `$1`,
    );
  }
  if (orgName) {
    output = output.replace(
      new RegExp(
        `(calling\\s+${orgName}|reached\\s+${orgName})(?:[,.!]?\\s*)\\1`,
        "ig",
      ),
      `$1`,
    );
  }
  return output;
}

function isTinyTtsFragment(text) {
  const t = normalizeSpeechText(text);
  if (!t) return true;
  if (t.length < 8) return true;
  return /^(for|this is|hello|hi|okay|ok|sure|got it|thanks|thank you)$/i.test(
    t,
  );
}

function clipScheduledAssistantText(text, context = {}) {
  if (!isOutboundContext(context) || !shouldDisableOutboundMonologue(context))
    return text;
  const maxSentences = maxAssistantSentencesForContext(context) || 2;
  const parts = String(text || "")
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= maxSentences) return text;
  const clipped = parts.slice(0, maxSentences).join(" ");
  console.log("[voice-quality] outbound assistant response clipped", {
    callSid: context.callSid || "",
    originalSentences: parts.length,
    keptSentences: maxSentences,
  });
  return clipped;
}

function prepareAssistantTextForTts(text, context = {}) {
  let output = cleanTextForSpeech(text)
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/([.!?]){2,}/g, "$1")
    .replace(/\b(um+|uh+|erm+)\b[, ]*/gi, "")
    .replace(/\s*[—–-]\s*/g, " — ")
    .trim();
  output = collapseDuplicateWords(output);
  output = removeRepeatedIntro(output, context);
  if (isOutboundContext(context)) {
    output = repairOutboundPurposePhrasing(output);
    output = voiceBehavior.repairOutboundAssistantText(output, context);
  }
  if (VOICE_DISABLE_FILLER_ACKS) {
    output = output
      .replace(
        /^(got it|okay|ok|sure|alright|all right|great|thanks|thank you)[,!.\s]+(?=[A-Z0-9])/i,
        "",
      )
      .replace(/^(got it|okay|ok|sure|alright|all right|great)[.!\s]*$/i, "")
      .trim();
  }
  output = output
    .replace(/\b(for)\s+\1\b/gi, "$1")
    .replace(/\b(this is)\s+\1\b/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
  output = clipScheduledAssistantText(output, context);
  output = enforceSpeechLanguage(output, context, "assistant-tts");
  if (isTinyTtsFragment(output)) return "";
  return output;
}

function withLanguageInstruction(instructions, context = {}) {
  return [languageRulesForContext(context), String(instructions || "")]
    .filter(Boolean)
    .join("\n\n");
}

function buildTextResponse(instructions, context = {}) {
  return {
    type: "response.create",
    response: {
      output_modalities: ["text"],
      instructions: withLanguageInstruction(instructions, context),
    },
  };
}

function buildOpenAiAudioResponse(instructions, context = {}) {
  return {
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      instructions: withLanguageInstruction(instructions, context),
    },
  };
}

function buildGreetingResponse(greeting, context = {}) {
  return buildCurrentGreetingResponse(greeting, context);
}

function buildCurrentGreetingResponse(greeting, context = {}) {
  return {
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      instructions: withLanguageInstruction(
        `Speak exactly this greeting and nothing else. Do not add extra questions, introductions, or helpdesk phrases: ${greeting}`,
        context,
      ),
    },
  };
}

function extractOpenAiAudioDelta(event) {
  if (!event || typeof event !== "object") return "";
  return firstNonEmpty(
    event.delta,
    event.audio,
    event?.response?.audio?.delta,
    event?.item?.audio?.delta,
    event?.output?.audio?.delta,
  );
}

function isAudioDeltaEvent(type) {
  return (
    type === "response.audio.delta" ||
    type === "response.output_audio.delta" ||
    type === "output_audio.delta" ||
    type.endsWith(".audio.delta") ||
    type.endsWith("output_audio.delta")
  );
}

async function handleTwilioMediaStreamWS(twilioWs, req) {
  let context = queryContext(req);
  let streamSid = "";
  let openaiWs = null;
  let openaiInitPromise = null;
  let openaiSocketOpen = false;
  let openaiSessionReady = false;
  let openaiSessionFallbackSent = false;
  let initialGreetingRequested = false;
  let noAudioTimer = null;
  let voiceProvider = "openai";
  let fallbackProvider = "openai";
  let elevenLabsVoice = null;
  let voiceSettings = {};
  let elevenLabsFailed = false;
  let ttsQueue = Promise.resolve();
  let activeTts = false;
  let queuedTtsCount = 0;
  let currentTtsRequestId = "";
  let assistantTextBuffer = "";
  let openAiAudioFallbackConfigured = false;
  const greetingState = {
    greetingText: "",
    greetingSent: false,
    greetingTtsStarted: false,
    greetingTtsCompleted: false,
    duplicateGreetingPrevented: 0,
  };
  let noSpeechTimer = null;
  let noSpeechFollowupTimer = null;
  let idleFollowupTimer = null;
  let noSpeechTimeoutStartedAt = null;
  let callerSpeechDetected = false;
  let noSpeechTimeoutFired = false;
  let noSpeechPrompted = false;
  let idlePrompted = false;
  let userSpeechActive = false;
  let lastCallerSpeechAt = 0;
  let openaiAudioIgnoredCount = 0;
  const elevenLabsErrors = [];
  const pendingAudio = [];
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();

  const counters = {
    twilioMediaFramesReceived: 0,
    openaiInputAudioAppended: 0,
    openaiAudioDeltasReceived: 0,
    elevenLabsChunksRequested: 0,
    elevenLabsAudioFramesSent: 0,
    audioFramesSentToTwilio: 0,
    openaiErrors: 0,
    voiceProviderFallbacks: 0,
  };

  const transcriptLines = [];
  const userTranscripts = [];
  const assistantTranscripts = [];
  const captureState = {
    detected: false,
    callerName: "",
    callerPhone: "",
    callbackTime: "",
    message: "",
    saved: false,
    saveResult: null,
    messageCaptureSaved: false,
    savedLeadId: null,
  };
  function knownCallerNameForSpeech() {
    return voiceBehavior.cleanRecipientNameForSpeech(
      firstNonEmpty(
        context.recipientName,
        context.targetName,
        captureState.callerName,
      ),
    );
  }

  function finalClosingMessage(reason = "normal_closing") {
    return voiceBehavior.buildFinalClosingMessage({
      recipientName: knownCallerNameForSpeech(),
      reason,
    });
  }

  function scheduleFinalAckHangup(
    reason = "normal_closing_after_goodbye",
    text = "",
  ) {
    if (callEndRequested || callEnded) return;
    awaitingHangupConfirmation = false;
    pendingHangup = true;
    hangupReason = reason;
    closingState = "ending_call";
    suppressAssistantResponseUntil = Date.now() + 3000;
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      safeSend(openaiWs, { type: "response.cancel" });
    }
    console.log("[conversation] final_ack_detected", {
      callSid: context.callSid,
      streamSid,
      text,
      reason,
    });
    logLifecycle("final acknowledgement detected; ending call", {
      callSid: context.callSid,
      streamSid,
      text,
      reason,
      closingState,
    });
    schedulePendingHangup(
      () => void requestTwilioCallEnd(reason),
      Math.max(900, Math.min(FINAL_AUDIO_HANGUP_DELAY_MS, 1800)),
    );
  }

  let captureSaveChain = Promise.resolve();
  const handledCaptureToolCalls = new Set();
  let messageCaptureEnabled = shouldEnableMessageCapture(context);
  let closingResponseSent = false;
  let callEndRequested = false;
  let callEnded = false;
  let idleTimer = null;
  let maxCallTimer = null;
  let pendingHangupTimers = [];
  let lastAssistantAskedAnythingElse = false;
  let lastAssistantAskedEndPermission = false;
  let closingState = "active";
  let closingReason = "";
  let closingResponseStartedAt = 0;
  let outboundVoicemailDetected = false;
  let assistantSpeaking = false;
  const pendingPlaybackMarks = new Set();
  let openAiCurrentAudioFrames = 0;
  let finalResponseCompleted = false;
  let pendingHangup = false;
  let hangupReason = "";
  let awaitingHangupConfirmation = false;
  let hangupConfirmationReason = "";
  let hangupConfirmationAskedAt = 0;
  let hangupConfirmationAttempts = 0;
  let userSpeechStartedAt = 0;
  let lastUserSpeechEndedAt = 0;
  let suppressAssistantResponseUntil = 0;
  let activeTtsGeneration = 0;
  let lastBargeInAt = 0;

  logLifecycle("connected", {
    path: context.path,
    queryParams: context.query,
    orgId: context.orgId,
    agentId: context.agentId,
    callRecordId: context.callRecordId,
    callSid: context.callSid,
  });

  markActivity("connected");
  maxCallTimer = setTimeout(() => {
    if (!callEndRequested && !callEnded) {
      void requestClosingAndHangup(
        "max-call-duration",
        "I'll end the call now. Thank you for calling.",
      );
    }
  }, MAX_INBOUND_CALL_SECONDS * 1000);

  function closeOpenAI() {
    if (noAudioTimer) {
      clearTimeout(noAudioTimer);
      noAudioTimer = null;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (noSpeechTimer) {
      clearTimeout(noSpeechTimer);
      noSpeechTimer = null;
    }
    if (noSpeechFollowupTimer) {
      clearTimeout(noSpeechFollowupTimer);
      noSpeechFollowupTimer = null;
    }
    if (idleFollowupTimer) {
      clearTimeout(idleFollowupTimer);
      idleFollowupTimer = null;
    }
    if (maxCallTimer) {
      clearTimeout(maxCallTimer);
      maxCallTimer = null;
    }
    for (const timer of pendingHangupTimers) clearTimeout(timer);
    pendingHangupTimers = [];
    try {
      if (
        openaiWs &&
        (openaiWs.readyState === WebSocket.OPEN ||
          openaiWs.readyState === WebSocket.CONNECTING)
      ) {
        openaiWs.close(1000);
      }
    } catch (_) {}
  }

  function clearIdleAndNoSpeechTimers(reason = "caller-activity") {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (idleFollowupTimer) {
      clearTimeout(idleFollowupTimer);
      idleFollowupTimer = null;
    }
    if (noSpeechTimer) {
      clearTimeout(noSpeechTimer);
      noSpeechTimer = null;
    }
    if (noSpeechFollowupTimer) {
      clearTimeout(noSpeechFollowupTimer);
      noSpeechFollowupTimer = null;
    }
    if (
      String(reason || "").startsWith("caller") &&
      (awaitingHangupConfirmation || pendingHangup || closingResponseSent)
    ) {
      // Do not cancel the closing/hangup state merely because the caller made
      // sound after a goodbye. Wait for the final transcript and classify it as
      // either a final acknowledgement or a real new request.
      idlePrompted = false;
      noSpeechPrompted = false;
      console.log(
        "[conversation] caller activity during closing; awaiting transcript",
        {
          callSid: context.callSid,
          streamSid,
          reason,
          closingState,
        },
      );
      return;
    }
    if (
      idlePrompted ||
      noSpeechPrompted ||
      awaitingHangupConfirmation ||
      pendingHangup ||
      closingResponseSent
    ) {
      clearHangupConfirmation(reason);
      cancelPendingHangup(reason);
      idlePrompted = false;
      noSpeechPrompted = false;
      if (!callEndRequested && !callEnded) closingState = "active";
    }
  }

  function markActivity(reason) {
    if (callEndRequested || callEnded) return;
    // Only caller-side activity should reset hangup timers. Assistant audio
    // must not keep the call alive or no-speech timeout will never fire.
    if (!String(reason || "").startsWith("caller")) return;
    callerSpeechDetected = true;
    lastCallerSpeechAt = Date.now();
    clearIdleAndNoSpeechTimers(reason || "caller-activity");
    console.log("[no-speech] caller speech detected reset timer", {
      callSid: context.callSid,
      streamSid,
      reason,
    });
  }

  function resetNoSpeechTimer(reason = "caller-activity") {
    markActivity(reason);
  }

  function startIdleSilenceTimer(reason = "caller-speech-ended") {
    if (callEndRequested || callEnded || userSpeechActive) return;
    if (!callerSpeechDetected || !greetingState.greetingTtsCompleted) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (callEndRequested || callEnded || userSpeechActive) return;
      idlePrompted = true;
      console.log("[idle] timeout reached; asking caller before ending", {
        callSid: context.callSid,
        streamSid,
        seconds: Math.round(IDLE_TIMEOUT_MS / 1000),
        reason,
      });
      void speakWithElevenLabs(
        "Are you still there? Is there anything else I can help you with?",
        "idle-check",
      );
      if (idleFollowupTimer) clearTimeout(idleFollowupTimer);
      idleFollowupTimer = setTimeout(() => {
        if (callEndRequested || callEnded || userSpeechActive) return;
        if (
          lastCallerSpeechAt &&
          Date.now() - lastCallerSpeechAt < NO_SPEECH_FOLLOWUP_TIMEOUT_MS
        )
          return;
        console.log("[idle] no response after check; ending call", {
          callSid: context.callSid,
          streamSid,
          followupSeconds: Math.round(NO_SPEECH_FOLLOWUP_TIMEOUT_MS / 1000),
        });
        void requestClosingAndHangup(
          "idle-timeout-confirmed-silence",
          "I will end the call now. Please call us back anytime. Goodbye.",
        );
      }, NO_SPEECH_FOLLOWUP_TIMEOUT_MS);
    }, IDLE_TIMEOUT_MS);
  }

  function startNoSpeechTimer(reason = "after-greeting") {
    if (
      callEndRequested ||
      callEnded ||
      callerSpeechDetected ||
      noSpeechTimeoutFired ||
      userSpeechActive
    )
      return;
    if (!greetingState.greetingTtsCompleted) return;
    if (noSpeechTimer) clearTimeout(noSpeechTimer);
    noSpeechTimeoutStartedAt = new Date().toISOString();
    console.log("[no-speech] timer started after greeting", {
      callSid: context.callSid,
      streamSid,
      seconds: Math.round(NO_SPEECH_TIMEOUT_MS / 1000),
      reason,
    });
    noSpeechTimer = setTimeout(() => {
      if (
        callEndRequested ||
        callEnded ||
        callerSpeechDetected ||
        userSpeechActive
      )
        return;
      noSpeechTimeoutFired = true;
      noSpeechPrompted = true;
      console.log(
        "[no-speech] timeout reached seconds=15; asking caller before ending",
        {
          callSid: context.callSid,
          streamSid,
          seconds: Math.round(NO_SPEECH_TIMEOUT_MS / 1000),
        },
      );
      void speakWithElevenLabs(
        "Are you still there? Is there anything I can help you with today?",
        "no-speech-check",
      );
      if (noSpeechFollowupTimer) clearTimeout(noSpeechFollowupTimer);
      noSpeechFollowupTimer = setTimeout(() => {
        if (
          callEndRequested ||
          callEnded ||
          callerSpeechDetected ||
          userSpeechActive
        )
          return;
        console.log("[no-speech] no response after check; closing call", {
          callSid: context.callSid,
          streamSid,
          followupSeconds: Math.round(NO_SPEECH_FOLLOWUP_TIMEOUT_MS / 1000),
        });
        void requestClosingAndHangup(
          "no-speech-confirmed-silence",
          "I will end the call now. Please call us back anytime. Goodbye.",
        );
      }, NO_SPEECH_FOLLOWUP_TIMEOUT_MS);
    }, NO_SPEECH_TIMEOUT_MS);
  }

  function refreshVoiceOutputDebug() {
    context.voiceOutputDebug = {
      voiceProvider,
      voiceId: elevenLabsVoice?.voiceId || "",
      fallbackUsed:
        counters.voiceProviderFallbacks > 0 || openAiAudioFallbackConfigured,
      greetingSent: greetingState.greetingSent,
      greetingTtsCompleted: greetingState.greetingTtsCompleted,
      activeTts,
      queuedTtsCount,
      noSpeechTimeoutStartedAt,
      callerSpeechDetected,
      noSpeechTimeoutFired,
      noSpeechPrompted,
      idlePrompted,
      userSpeechActive,
      lastCallerSpeechAt: lastCallerSpeechAt
        ? new Date(lastCallerSpeechAt).toISOString()
        : null,
      audioFramesSentToTwilio: counters.audioFramesSentToTwilio,
      elevenLabsErrors,
      openaiAudioIgnoredCount,
      duplicateGreetingPrevented: greetingState.duplicateGreetingPrevented,
      currentTtsRequestId,
      hangupReason: hangupReason || closingReason || "",
    };
    return context.voiceOutputDebug;
  }

  async function finishMessageCapture() {
    try {
      await captureSaveChain;
    } catch (_) {}
    refreshVoiceOutputDebug();
    await saveTranscriptOnly({
      context,
      transcriptLines,
      summary: summarizeTranscript(transcriptLines, 900),
    });
    if (outboundVoicemailDetected || context.voicemailDetected) {
      console.log("[message-capture] skipped outbound voicemail", {
        callSid: context.callSid,
      });
      return null;
    }
    if (!messageCaptureEnabled) {
      logLifecycle("message capture disabled for call", {
        callSid: context.callSid,
        direction: context.direction,
      });
      return null;
    }
    if (
      captureState.saved ||
      captureState.messageCaptureSaved ||
      captureState.savedLeadId
    ) {
      if (captureState.savedLeadId)
        console.log(
          "[message-capture] fallback skipped existing lead id=" +
            captureState.savedLeadId,
        );
      return captureState.saveResult;
    }
    const allUserText = (userTranscripts || []).join("\n");
    const allAssistantText = (assistantTranscripts || []).join(" ");
    const likelyMessage =
      captureState.detected ||
      looksLikeMessageCapture(allUserText) ||
      /\b(call me back|callback|take a message|leave a message|my name is|please tell|message)\b/i.test(
        allUserText,
      );
    if (!likelyMessage) return null;
    if (!captureState.detected) {
      console.log("[message-capture] fallback extraction started", {
        callSid: context.callSid,
        streamSid,
      });
      captureState.detected = true;
      captureState.callerName =
        captureState.callerName || extractCallerNameFromTranscript(allUserText);
      captureState.callerPhone =
        captureState.callerPhone ||
        normalizeCapturedPhone(
          extractPhoneFromTranscript(allUserText, context.callerPhone),
          context.callerPhone,
        );
      captureState.callbackTime =
        captureState.callbackTime ||
        extractCallbackTimeFromTranscript(allUserText);
      captureState.message = captureState.message || allUserText;
    }
    captureSaveChain = captureSaveChain
      .then(async () => {
        if (
          captureState.saved ||
          captureState.messageCaptureSaved ||
          captureState.savedLeadId
        ) {
          console.log(
            "[message-capture] fallback skipped existing lead id=" +
              (captureState.savedLeadId || "unknown"),
          );
          return (
            captureState.saveResult || {
              saved: true,
              lead: captureState.savedLeadId
                ? { id: captureState.savedLeadId }
                : null,
              duplicatePrevented: true,
            }
          );
        }
        const result = await persistInboundCallMessage({
          context,
          transcriptLines,
          userTranscripts,
          assistantTranscripts,
          captureState,
          status: "new",
          mode: "fallback",
        });
        captureState.saved = Boolean(result?.saved);
        captureState.messageCaptureSaved = Boolean(
          result?.saved || captureState.messageCaptureSaved,
        );
        captureState.savedLeadId =
          result?.lead?.id || captureState.savedLeadId || null;
        captureState.saveResult = result;
        if (context.callSid) {
          try {
            await dedupeCallMessage(context.callSid);
          } catch (_) {}
        }
        if (result?.saved)
          console.log(
            "[message-capture] fallback saved lead id=" +
              (result.lead?.id || "existing"),
          );
        return result;
      })
      .catch((err) => {
        console.warn("[message-capture] fallback save failed", {
          callSid: context.callSid,
          error: err.message || String(err),
        });
        return { saved: false, error: err.message || String(err) };
      });
    return await captureSaveChain;
  }

  async function requestTwilioCallEnd(reason) {
    if (callEndRequested || callEnded) return;
    if (userSpeechActive) {
      console.log(
        "[hangup] blocked final call end because caller is speaking",
        {
          callSid: context.callSid,
          streamSid,
          reason,
        },
      );
      startIdleSilenceTimer("final-hangup-blocked-caller-speaking");
      return;
    }
    const speakingTooLongForHangup =
      pendingHangup &&
      closingResponseStartedAt &&
      Date.now() - closingResponseStartedAt >
        Math.max(3000, FINAL_AUDIO_HANGUP_DELAY_MS + 2500);
    if (
      assistantSpeaking &&
      !finalResponseCompleted &&
      !speakingTooLongForHangup
    ) {
      pendingHangup = true;
      hangupReason = reason || hangupReason || "pending";
      console.log("[hangup] skipped because assistant still speaking", {
        callSid: context.callSid,
        streamSid,
        reason: hangupReason,
      });
      schedulePendingHangup(
        () => void requestTwilioCallEnd(hangupReason || reason),
        Math.max(FINAL_AUDIO_HANGUP_DELAY_MS, 1800),
      );
      return;
    }
    if (speakingTooLongForHangup) {
      console.warn(
        "[hangup] forcing call end after closing audio grace period",
        {
          callSid: context.callSid,
          streamSid,
          reason,
        },
      );
    }
    callEndRequested = true;
    pendingHangup = false;
    closingState = "hangup_completed";
    if (idleTimer) clearTimeout(idleTimer);
    if (maxCallTimer) clearTimeout(maxCallTimer);
    for (const timer of pendingHangupTimers) clearTimeout(timer);
    pendingHangupTimers = [];
    try {
      await finishMessageCapture();
    } catch (_) {}
    try {
      if (context.callSid) await dedupeCallMessage(context.callSid);
    } catch (dedupeErr) {
      console.warn("[message-capture] final dedupe pass failed", {
        callSid: context.callSid,
        error: dedupeErr.message || String(dedupeErr),
      });
    }
    logLifecycle("ending Twilio call", {
      callSid: context.callSid,
      streamSid,
      reason,
    });
    try {
      if (!context.callSid)
        throw new Error(
          "Missing callSid; cannot complete Twilio call via REST",
        );
      await endTwilioCall(context.callSid);
      callEnded = true;
      if (String(reason || "").includes("no-speech")) {
        console.log("[no-speech] call ended", {
          callSid: context.callSid,
          streamSid,
          reason,
        });
      }
      if (String(reason || "").includes("idle-timeout")) {
        console.log("[idle] call ended", {
          callSid: context.callSid,
          streamSid,
          reason,
        });
      }
      logLifecycle("call ended successfully", {
        callSid: context.callSid,
        streamSid,
        reason,
      });
    } catch (err) {
      console.error("[twilio-media-stream] call end failed:", {
        callSid: context.callSid,
        streamSid,
        reason,
        error: err.message || String(err),
      });
      try {
        twilioWs.close(1000, "call end fallback");
      } catch (_) {}
    }
  }

  function schedulePendingHangup(fn, delayMs) {
    const timer = setTimeout(() => {
      pendingHangupTimers = pendingHangupTimers.filter((t) => t !== timer);
      fn();
    }, delayMs);
    pendingHangupTimers.push(timer);
    return timer;
  }

  function cancelPendingHangup(reason) {
    if (!closingResponseSent || callEndRequested || callEnded) return false;
    for (const timer of pendingHangupTimers) clearTimeout(timer);
    pendingHangupTimers = [];
    closingResponseSent = false;
    closingState = "hangup_cancelled_by_real_user_speech";
    logLifecycle("pending hangup cancelled", {
      callSid: context.callSid,
      streamSid,
      reason,
      previousClosingReason: closingReason,
    });
    closingReason = "";
    closingResponseStartedAt = 0;
    return true;
  }

  function requestHangupConfirmation(reason = "caller-end-intent") {
    if (callEndRequested || callEnded) return;
    // Outbound calls are more likely to be affected by ASR false positives or
    // short recipient acknowledgements. Do not end on a single transcript like
    // "bye"; ask once and wait for explicit confirmation.
    // For inbound, this also protects accented/ambiguous goodbye transcripts.
    if (awaitingHangupConfirmation) return;
    if (hangupConfirmationAttempts >= 1) {
      console.log(
        "[hangup] confirmation already asked once; not asking again",
        {
          callSid: context.callSid,
          streamSid,
          reason,
        },
      );
      return;
    }
    awaitingHangupConfirmation = true;
    hangupConfirmationReason = reason;
    hangupConfirmationAskedAt = Date.now();
    hangupConfirmationAttempts += 1;
    pendingHangup = false;
    hangupReason = "";
    closingState = "awaiting_hangup_confirmation";
    const prompt = hangupConfirmationPrompt(context, reason);
    console.log("[hangup] confirmation requested", {
      callSid: context.callSid,
      streamSid,
      reason,
      direction: context.direction,
      attempt: hangupConfirmationAttempts,
    });
    logLifecycle("hangup confirmation requested", {
      callSid: context.callSid,
      streamSid,
      reason,
      prompt,
      closingState,
    });
    if (voiceProvider === "elevenlabs") {
      void speakWithElevenLabs(prompt, "hangup-confirmation");
    } else if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      assistantSpeaking = true;
      finalResponseCompleted = false;
      safeSend(openaiWs, buildGreetingResponse(prompt, context));
    } else {
      logLifecycle(
        "hangup confirmation could not be spoken; keeping call open",
        { callSid: context.callSid, streamSid, reason },
      );
    }
  }

  function clearHangupConfirmation(reason = "caller-continued") {
    if (!awaitingHangupConfirmation) return;
    awaitingHangupConfirmation = false;
    hangupConfirmationReason = "";
    hangupConfirmationAskedAt = 0;
    closingState = "active";
    console.log("[hangup] confirmation cancelled", {
      callSid: context.callSid,
      streamSid,
      reason,
    });
  }

  function requestClosingAndHangup(reason, closingMessage = "") {
    if (closingResponseSent || callEndRequested || callEnded) return;
    if (userSpeechActive) {
      console.log("[hangup] blocked because caller is speaking", {
        callSid: context.callSid,
        streamSid,
        reason,
      });
      startIdleSilenceTimer("hangup-blocked-caller-speaking");
      return;
    }
    awaitingHangupConfirmation = false;
    const finalMessage =
      closingMessage && closingMessage !== CLOSING_MESSAGE
        ? closingMessage
        : finalClosingMessage(reason);
    closingResponseSent = true;
    closingState = "final_goodbye_said";
    closingReason = reason;
    closingResponseStartedAt = Date.now();
    pendingHangup = true;
    hangupReason = reason;
    finalResponseCompleted = false;
    console.log("[hangup] intent detected", {
      callSid: context.callSid,
      streamSid,
      reason,
    });
    logLifecycle("end intent detected", {
      callSid: context.callSid,
      streamSid,
      reason,
      closingState,
    });
    const finishAfterDelay = () => {
      closingState = "hangup_scheduled";
      schedulePendingHangup(
        () => void requestTwilioCallEnd(reason),
        FINAL_AUDIO_HANGUP_DELAY_MS,
      );
    };
    if (voiceProvider === "elevenlabs") {
      assistantSpeaking = true;
      finalResponseCompleted = false;
      void speakWithElevenLabs(finalMessage, "closing-message").then(() => {
        if (!callEndRequested && closingResponseSent) finishAfterDelay();
      });
      closingState = "closing_response_requested";
      logLifecycle("closing response sent", {
        callSid: context.callSid,
        streamSid,
        reason,
        closingMessage: finalMessage,
        closingState,
        voiceProvider,
      });
    } else if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      assistantSpeaking = true;
      finalResponseCompleted = false;
      safeSend(openaiWs, buildGreetingResponse(finalMessage, context));
      closingState = "closing_response_requested";
      logLifecycle("closing response sent", {
        callSid: context.callSid,
        streamSid,
        reason,
        closingMessage: finalMessage,
        closingState,
      });
      schedulePendingHangup(
        () => {
          if (!callEndRequested && closingResponseSent) finishAfterDelay();
        },
        Math.max(3500, FINAL_AUDIO_HANGUP_DELAY_MS + 1200),
      );
    } else {
      closingState = "closing_response_requested";
      logLifecycle("closing response sent", {
        callSid: context.callSid,
        streamSid,
        reason,
        closingMessage: finalMessage,
        fallback: "OpenAI not open",
        closingState,
      });
      finishAfterDelay();
    }
  }

  function sendAudioToTwilio(base64Audio) {
    if (!streamSid) {
      console.warn(
        "[twilio-media-stream] OpenAI audio received before streamSid; dropping frame",
        {
          callSid: context.callSid,
        },
      );
      return false;
    }
    const sent = safeSend(twilioWs, {
      event: "media",
      streamSid,
      media: { payload: base64Audio },
    });
    if (sent) {
      counters.audioFramesSentToTwilio += 1;
      assistantSpeaking = true;
      finalResponseCompleted = false;
      if (
        counters.audioFramesSentToTwilio === 1 ||
        counters.audioFramesSentToTwilio % 50 === 0
      ) {
        logLifecycle("audio frame sent to Twilio", {
          callSid: context.callSid,
          streamSid,
          audioFramesSentToTwilio: counters.audioFramesSentToTwilio,
        });
      }
    }
    return sent;
  }

  function sendPlaybackMark(label = "assistant", requestId = "") {
    if (!VOICE_TWILIO_MARKS_ENABLED || !streamSid) return "";
    const name = `${label}:${requestId || Date.now()}:${pendingPlaybackMarks.size + 1}`;
    const sent = safeSend(twilioWs, {
      event: "mark",
      streamSid,
      mark: { name },
    });
    if (sent) {
      pendingPlaybackMarks.add(name);
      assistantSpeaking = true;
      finalResponseCompleted = false;
      logLifecycle("Twilio playback mark sent", {
        callSid: context.callSid,
        streamSid,
        markName: name,
        pendingPlaybackMarks: pendingPlaybackMarks.size,
      });
    }
    return sent ? name : "";
  }

  function assistantOutputActive() {
    return assistantSpeaking || activeTts || pendingPlaybackMarks.size > 0;
  }

  function clearAssistantOutput(reason = "caller-barge-in") {
    activeTtsGeneration += 1;
    lastBargeInAt = Date.now();
    assistantSpeaking = false;
    finalResponseCompleted = true;
    if (currentTtsRequestId) currentTtsRequestId = "";
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      safeSend(openaiWs, { type: "response.cancel" });
    }
    if (streamSid) {
      safeSend(twilioWs, { event: "clear", streamSid });
    }
    const marksCleared = pendingPlaybackMarks.size;
    pendingPlaybackMarks.clear();
    console.log("[turn-taking] assistant output cleared", {
      callSid: context.callSid,
      streamSid,
      reason,
      voiceProvider,
      marksCleared,
    });
    logLifecycle("Twilio clear sent", {
      callSid: context.callSid,
      streamSid,
      reason,
      closingState,
    });
  }

  function configureOpenAiAudioFallback(reason = "elevenlabs-fallback") {
    if (openAiAudioFallbackConfigured) return;
    openAiAudioFallbackConfigured = true;
    voiceProvider = "openai";
    counters.voiceProviderFallbacks += 1;
    console.warn("[voice-provider] elevenlabs failed fallback=openai", {
      callSid: context.callSid,
      streamSid,
      reason,
      openaiVoice: context.sessionVoice || DEFAULT_VOICE,
    });
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      safeSend(
        openaiWs,
        realtimeSessionUpdate(
          context.systemPrompt || "You are a helpful AI phone assistant.",
          context.sessionVoice || DEFAULT_VOICE,
          messageCaptureEnabled,
          context,
        ),
      );
    }
  }

  async function speakWithOpenAiFallback(text, reason = "tts-fallback") {
    const clean = cleanTextForSpeech(text);
    if (!clean || !openaiWs || openaiWs.readyState !== WebSocket.OPEN)
      return false;
    configureOpenAiAudioFallback(reason);
    assistantSpeaking = true;
    finalResponseCompleted = false;
    return safeSend(
      openaiWs,
      buildOpenAiAudioResponse(
        `Say exactly this to the caller and then pause: ${clean}`,
        context,
      ),
    );
  }

  async function speakWithElevenLabs(text, label = "assistant") {
    const raw = String(text || "");
    console.log("[voice-output] raw assistant text", {
      callSid: context.callSid,
      streamSid,
      label,
      text: raw.slice(0, 500),
    });

    const clean = prepareAssistantTextForTts(raw, context);
    console.log("[voice-output] sanitized tts text", {
      callSid: context.callSid,
      streamSid,
      label,
      text: clean.slice(0, 500),
    });
    if (!clean) {
      console.log("[voice-output] skipped tiny fragment", {
        callSid: context.callSid,
        streamSid,
        label,
      });
      return;
    }

    const config = elevenLabsConfig(voiceSettings);
    if (
      voiceProvider !== "elevenlabs" ||
      !elevenLabsVoice?.voiceId ||
      elevenLabsFailed
    ) {
      await speakWithOpenAiFallback(clean, "elevenlabs-not-active");
      return;
    }

    const requestCreatedAt = Date.now();
    const requestId = `${requestCreatedAt}-${Math.random().toString(36).slice(2, 8)}`;
    const chunks =
      label === "initial-greeting" || label === "closing-message"
        ? [clean]
        : splitTextForSpeech(clean, config.maxCharsPerChunk).filter(Boolean);
    if (!chunks.length) return;

    if (activeTts) {
      queuedTtsCount += 1;
      console.log("[voice-output] queued text because activeTts=true", {
        callSid: context.callSid,
        streamSid,
        label,
        requestId,
        queuedTtsCount,
      });
    }

    const queuedJob = async () => {
      queuedTtsCount = Math.max(0, queuedTtsCount - 1);
      if (
        label === "assistant-response" &&
        lastBargeInAt &&
        requestCreatedAt < lastBargeInAt
      ) {
        console.log(
          "[turn-taking] skipped stale assistant response after barge-in",
          {
            callSid: context.callSid,
            streamSid,
            label,
            requestId,
          },
        );
        return;
      }
      activeTts = true;
      assistantSpeaking = true;
      finalResponseCompleted = false;
      currentTtsRequestId = requestId;
      const generation = activeTtsGeneration;
      let requestAudioFrames = 0;
      console.log("[voice-output] activeTts started requestId=" + requestId, {
        callSid: context.callSid,
        streamSid,
        label,
        provider: "elevenlabs",
        voiceId: elevenLabsVoice.voiceId,
        chunks: chunks.length,
      });

      const responseDebounceMs = responseDebounceMsForContext(context);
      if (responseDebounceMs > 0 && label === "assistant-response") {
        console.log("[turn-taking] response delayed", {
          callSid: context.callSid,
          streamSid,
          ms: responseDebounceMs,
        });
        await sleep(responseDebounceMs);
      }
      if (label === "assistant-response" && userSpeechActive) {
        console.log(
          "[turn-taking] skipped assistant response because caller is speaking",
          {
            callSid: context.callSid,
            streamSid,
            label,
            requestId,
          },
        );
        activeTts = false;
        assistantSpeaking = false;
        finalResponseCompleted = true;
        if (currentTtsRequestId === requestId) currentTtsRequestId = "";
        return;
      }

      try {
        for (const chunk of chunks) {
          if (
            generation !== activeTtsGeneration ||
            voiceProvider !== "elevenlabs" ||
            callEndRequested ||
            callEnded
          ) {
            console.log("[turn-taking] elevenlabs speech chunk cancelled", {
              callSid: context.callSid,
              streamSid,
              label,
              requestId,
              reason:
                generation !== activeTtsGeneration
                  ? "barge-in-or-clear"
                  : "call-state",
            });
            break;
          }

          counters.elevenLabsChunksRequested += 1;
          console.log("[voice-provider] elevenlabs tts started", {
            callSid: context.callSid,
            streamSid,
            label,
            requestId,
            voiceId: elevenLabsVoice.voiceId,
            modelId: elevenLabsVoice.modelId || config.defaultModel,
            outputFormat: config.twilioOutputFormat || TWILIO_OUTPUT_FORMAT,
            chars: chunk.length,
            settings: elevenLabsConfig(voiceSettings),
          });
          console.log(
            "[elevenlabs] output_format=" +
              (config.twilioOutputFormat || TWILIO_OUTPUT_FORMAT),
            {
              callSid: context.callSid,
              streamSid,
              transcodingRequired:
                (config.twilioOutputFormat || TWILIO_OUTPUT_FORMAT) !==
                TWILIO_OUTPUT_FORMAT,
            },
          );

          const streamResult = await streamElevenLabsSpeech({
            voiceId: elevenLabsVoice.voiceId,
            text: chunk,
            modelId: elevenLabsVoice.modelId || config.defaultModel,
            outputFormat: config.twilioOutputFormat || TWILIO_OUTPUT_FORMAT,
            settings: voiceSettings,
            onAudioChunk: async (audio, stats) => {
              if (
                generation !== activeTtsGeneration ||
                callEndRequested ||
                callEnded
              ) {
                console.log(
                  "[turn-taking] elevenlabs audio dropped after barge-in",
                  {
                    callSid: context.callSid,
                    streamSid,
                    label,
                    requestId,
                  },
                );
                return;
              }
              if (!audio || !audio.length) return;
              if (sendAudioToTwilio(audio.toString("base64"))) {
                requestAudioFrames += 1;
              }
              counters.elevenLabsAudioFramesSent += 1;
              if (
                stats.chunks === 1 ||
                counters.elevenLabsAudioFramesSent % 25 === 0
              ) {
                console.log("[voice-provider] elevenlabs audio sent", {
                  callSid: context.callSid,
                  streamSid,
                  label,
                  requestId,
                  bytes: audio.length,
                  streamChunks: stats.chunks,
                  chunksSent: counters.elevenLabsAudioFramesSent,
                });
              }
            },
          });
          console.log("[voice-provider] elevenlabs stream complete", {
            callSid: context.callSid,
            streamSid,
            label,
            requestId,
            bytes: streamResult.bytes,
            streamChunks: streamResult.chunks,
            timeToFirstByteMs: streamResult.timeToFirstByteMs,
          });
          if (VOICE_TTS_CHUNK_PAUSE_MS > 0)
            await sleep(VOICE_TTS_CHUNK_PAUSE_MS);
        }
        if (requestAudioFrames > 0 && generation === activeTtsGeneration) {
          sendPlaybackMark(label, requestId);
        }
      } catch (err) {
        elevenLabsFailed = true;
        elevenLabsErrors.push({
          ts: new Date().toISOString(),
          label,
          requestId,
          code: err.code || err.status || "unknown",
          message: err.message || String(err),
        });
        console.error("[voice-provider] elevenlabs tts failed", {
          callSid: context.callSid,
          streamSid,
          label,
          requestId,
          error: err.message || String(err),
          code: err.code || err.status || "unknown",
        });
        console.warn(
          "[voice-output] fallback to openai reason=" +
            (err.code || err.message || "elevenlabs-tts-failed"),
          {
            callSid: context.callSid,
            streamSid,
            requestId,
          },
        );
        await speakWithOpenAiFallback(
          clean,
          err.code || err.message || "elevenlabs-tts-failed",
        );
      } finally {
        if (currentTtsRequestId === requestId) currentTtsRequestId = "";
        activeTts = false;
        if (
          !pendingHangup &&
          generation === activeTtsGeneration &&
          pendingPlaybackMarks.size === 0
        ) {
          assistantSpeaking = false;
          finalResponseCompleted = true;
        }
        if (label === "initial-greeting") {
          greetingState.greetingTtsCompleted = true;
          console.log("[voice-output] greeting tts completed", {
            callSid: context.callSid,
            streamSid,
            requestId,
          });
          startNoSpeechTimer("greeting-completed");
        }
        if (label === "closing-message") {
          console.log("[no-speech] closing message sent", {
            callSid: context.callSid,
            streamSid,
            requestId,
            reason: closingReason || hangupReason,
          });
        }
        console.log(
          "[voice-output] activeTts completed requestId=" + requestId,
          {
            callSid: context.callSid,
            streamSid,
            label,
            queuedTtsCount,
          },
        );
      }
    };

    ttsQueue = ttsQueue.then(queuedJob, queuedJob);
    await ttsQueue;
  }

  function flushPendingAudio() {
    if (
      !openaiWs ||
      !openaiSocketOpen ||
      openaiWs.readyState !== WebSocket.OPEN
    )
      return;
    while (pendingAudio.length) {
      const frame = pendingAudio.shift();
      if (safeSend(openaiWs, frame)) {
        counters.openaiInputAudioAppended += 1;
      }
    }
    if (counters.openaiInputAudioAppended > 0) {
      logLifecycle("pending input audio flushed to OpenAI", {
        callSid: context.callSid,
        openaiInputAudioAppended: counters.openaiInputAudioAppended,
      });
    }
  }

  function requestInitialGreeting(reason) {
    if (
      greetingState.greetingSent ||
      greetingState.greetingTtsStarted ||
      initialGreetingRequested
    ) {
      greetingState.duplicateGreetingPrevented += 1;
      console.log("[voice-output] greeting skipped duplicate", {
        callSid: context.callSid,
        streamSid,
        reason,
        duplicateGreetingPrevented: greetingState.duplicateGreetingPrevented,
      });
      return;
    }
    if (
      voiceProvider !== "elevenlabs" &&
      (!openaiWs || openaiWs.readyState !== WebSocket.OPEN)
    )
      return;
    initialGreetingRequested = true;
    greetingState.greetingText = context.greeting || DEFAULT_GREETING;
    greetingState.greetingSent = true;
    greetingState.greetingTtsStarted = true;
    console.log(
      `[voice-output] greeting text="${greetingState.greetingText}"`,
      {
        callSid: context.callSid,
        streamSid,
        reason,
        voiceProvider,
      },
    );
    if (voiceProvider === "elevenlabs") {
      void speakWithElevenLabs(greetingState.greetingText, "initial-greeting");
    } else {
      safeSend(
        openaiWs,
        buildGreetingResponse(greetingState.greetingText, context),
      );
      // OpenAI audio fallback does not expose a reliable final-TTS event in all
      // model versions, so start no-speech after a conservative greeting window.
      setTimeout(
        () => {
          greetingState.greetingTtsCompleted = true;
          startNoSpeechTimer("openai-greeting-window");
        },
        Math.max(2500, FINAL_AUDIO_HANGUP_DELAY_MS),
      );
    }
    if (isScheduledOutboundContext(context)) {
      console.log("[voice-quality] greeting sent", {
        callSid: context.callSid,
        scheduleRunId: context.scheduleRunId || "",
      });
      if (SCHEDULED_CALL_WAIT_FOR_USER_AFTER_GREETING) {
        console.log("[voice-quality] waiting for recipient response", {
          callSid: context.callSid,
          scheduleRunId: context.scheduleRunId || "",
        });
      }
    }
    logLifecycle("greeting sent", {
      callSid: context.callSid,
      streamSid,
      reason,
      greeting: greetingState.greetingText,
      voiceProvider,
      elevenLabsVoiceId: elevenLabsVoice?.voiceId || "",
    });

    noAudioTimer = setTimeout(() => {
      const noProviderAudio =
        voiceProvider === "elevenlabs"
          ? counters.elevenLabsAudioFramesSent === 0 && !elevenLabsFailed
          : counters.openaiAudioDeltasReceived === 0;
      if (!noProviderAudio) return;

      console.warn(
        `[twilio-media-stream] no ${voiceProvider} audio received within ${ELEVENLABS_GREETING_AUDIO_TIMEOUT_MS}ms`,
        {
          callSid: context.callSid,
          streamSid,
          openaiSessionReady,
          openaiSocketOpen,
          initialGreetingRequested,
          voiceProvider,
          elevenLabsAudioFramesSent: counters.elevenLabsAudioFramesSent,
          openaiAudioDeltasReceived: counters.openaiAudioDeltasReceived,
        },
      );

      if (
        voiceProvider !== "elevenlabs" ||
        greetingState.openAiGreetingFallbackStarted
      ) {
        return;
      }

      greetingState.openAiGreetingFallbackStarted = true;
      console.warn("[voice-output] greeting audio fallback scheduled", {
        callSid: context.callSid,
        streamSid,
        reason: "elevenlabs-greeting-no-audio",
        retries: ELEVENLABS_GREETING_AUDIO_FALLBACK_RETRIES,
      });

      let attempt = 0;
      const tryFallback = async () => {
        attempt += 1;
        if (callEnded || callEndRequested) return;
        if (
          counters.elevenLabsAudioFramesSent > 0 ||
          counters.openaiAudioDeltasReceived > 0
        ) {
          console.log(
            "[voice-output] greeting fallback cancelled because audio started",
            {
              callSid: context.callSid,
              streamSid,
              attempt,
            },
          );
          return;
        }
        if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
          if (attempt < ELEVENLABS_GREETING_AUDIO_FALLBACK_RETRIES) {
            setTimeout(
              tryFallback,
              ELEVENLABS_GREETING_AUDIO_FALLBACK_RETRY_MS,
            );
          }
          return;
        }
        console.warn("[voice-output] greeting fallback to openai", {
          callSid: context.callSid,
          streamSid,
          attempt,
          greeting: greetingState.greetingText,
        });
        await speakWithOpenAiFallback(
          greetingState.greetingText || context.greeting || DEFAULT_GREETING,
          "elevenlabs-greeting-no-audio",
        );
      };
      void tryFallback();
    }, ELEVENLABS_GREETING_AUDIO_TIMEOUT_MS);
  }

  async function handleCaptureInboundMessage(rawArgs, callId = "") {
    if (outboundVoicemailDetected || context.voicemailDetected) {
      console.log("[message-capture] skipped outbound voicemail", {
        callSid: context.callSid,
        callId,
      });
      return {
        saved: false,
        skipped: true,
        reason: "outbound voicemail detected",
      };
    }
    if (!messageCaptureEnabled) {
      console.log(
        "[message-capture] ignored because capture is disabled for this call",
        { callSid: context.callSid, direction: context.direction, callId },
      );
      return {
        saved: false,
        skipped: true,
        reason: "message capture disabled for this call direction",
      };
    }
    const toolCallKey = String(callId || "").trim();
    if (toolCallKey && handledCaptureToolCalls.has(toolCallKey)) {
      console.log("[message-capture] duplicate tool call ignored", {
        callSid: context.callSid,
        streamSid,
        callId: toolCallKey,
      });
      return (
        captureState.saveResult || {
          saved: Boolean(captureState.savedLeadId),
          lead: captureState.savedLeadId
            ? { id: captureState.savedLeadId }
            : null,
          duplicatePrevented: true,
        }
      );
    }
    if (toolCallKey) handledCaptureToolCalls.add(toolCallKey);
    console.log("[message-capture] tool called", {
      callSid: context.callSid,
      streamSid,
      callId,
    });
    const args = parseToolArguments(rawArgs);
    captureState.detected = true;
    captureState.callerName = firstNonEmpty(
      args.caller_name,
      captureState.callerName,
    );
    captureState.callerPhone = normalizeCapturedPhone(
      firstNonEmpty(
        args.caller_phone,
        captureState.callerPhone,
        context.callerPhone,
      ),
      context.callerPhone,
    );
    captureState.callbackTime = firstNonEmpty(
      args.callback_time,
      captureState.callbackTime,
    );
    captureState.email = firstNonEmpty(args.email, captureState.email);
    captureState.message = firstNonEmpty(args.message, captureState.message);

    captureSaveChain = captureSaveChain
      .then(async () => {
        const result = await persistInboundCallMessage({
          context,
          transcriptLines,
          userTranscripts,
          assistantTranscripts,
          captureState,
          toolArgs: args,
          status: "new",
          mode: "tool",
        });
        captureState.saved = Boolean(result?.saved);
        captureState.messageCaptureSaved = Boolean(
          result?.saved || captureState.messageCaptureSaved,
        );
        captureState.savedLeadId =
          result?.lead?.id || captureState.savedLeadId || null;
        captureState.saveResult = result;
        if (context.callSid) {
          try {
            const dedupe = await dedupeCallMessage(context.callSid);
            if (dedupe?.duplicateCount)
              console.log("[message-capture] duplicate prevented", {
                callSid: context.callSid,
                duplicateCount: dedupe.duplicateCount,
                canonicalLeadId:
                  dedupe.canonicalLead?.id || captureState.savedLeadId,
              });
          } catch (dedupeErr) {
            console.warn("[message-capture] post-capture dedupe failed", {
              callSid: context.callSid,
              error: dedupeErr.message || String(dedupeErr),
            });
          }
        }
        return result;
      })
      .catch((err) => {
        console.warn("[message-capture] queued save failed", {
          callSid: context.callSid,
          error: err.message || String(err),
        });
        return { saved: false, error: err.message || String(err) };
      });

    const result = await captureSaveChain;

    const okMessage = "I’ve saved your message and callback preference.";
    const failMessage =
      "I’ve taken note of that, but I may not have been able to save it automatically. A team member can still review this call.";
    const outputText = result?.saved ? okMessage : failMessage;
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      if (callId) {
        safeSend(openaiWs, {
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify({
              success: Boolean(result?.saved),
              message: outputText,
              lead_id: result?.lead?.id || null,
            }),
          },
        });
      }
      if (voiceProvider === "elevenlabs") {
        void speakWithElevenLabs(outputText, "tool-output");
      } else {
        safeSend(openaiWs, {
          type: "response.create",
          response: {
            output_modalities: ["audio"],
            instructions: outputText,
          },
        });
      }
    }
    return result;
  }

  async function loadAgentAndPromptWithRealtimeTimeout(currentContext) {
    let timeoutId = null;
    try {
      return await Promise.race([
        loadAgentAndPrompt(currentContext),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            const err = new Error(
              `Agent context load exceeded ${CALL_CONTEXT_LOAD_TIMEOUT_MS}ms`,
            );
            err.code = "AGENT_CONTEXT_LOAD_TIMEOUT";
            reject(err);
          }, CALL_CONTEXT_LOAD_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      const isTimeout = err?.code === "AGENT_CONTEXT_LOAD_TIMEOUT";
      console.warn("[twilio-media-stream] using realtime fail-safe context", {
        callSid: currentContext.callSid,
        streamSid,
        reason: err.message || String(err),
        timeoutMs: CALL_CONTEXT_LOAD_TIMEOUT_MS,
      });
      const selectedVoice = mapVoiceProfileToOpenAi(
        currentContext.voiceProfile || "",
      );
      const agentName = voiceBehavior.cleanAgentNameForSpeech(
        currentContext.agentName,
      );
      const organizationName = voiceBehavior.cleanOrganizationNameForSpeech(
        firstNonEmpty(
          currentContext.organizationName,
          currentContext.businessName,
          currentContext.companyName,
        ),
      );
      const outbound = isOutboundContext(currentContext);
      const greeting = outbound
        ? buildOutboundGreeting({
            recipientName:
              currentContext.recipientName || currentContext.targetName || "",
            agentName,
            organizationName,
            callPurpose: currentContext.callPurpose || "follow up briefly",
          })
        : voiceBehavior.buildInboundGreeting({ agentName, organizationName });
      const systemPrompt = outbound
        ? [
            voiceBehavior.dynamicAgentIdentityLine({
              agentName,
              organizationName,
              direction: "outbound",
            }),
            "The full business knowledge base is still loading, so keep this call simple and safe.",
            `Call purpose: ${sanitizeOutboundPurposeText(currentContext.callPurpose || "follow up briefly", 240) || "follow up briefly"}.`,
            "State the purpose naturally, ask if it is a good time, then listen. Do not monologue. Do not invent facts. Offer to take a message, schedule a callback, or end the call politely.",
          ].join("\n")
        : [
            voiceBehavior.dynamicAgentIdentityLine({
              agentName,
              organizationName,
              direction: "inbound",
            }),
            "The full business knowledge base is still loading, so greet the caller, listen, and collect a clear message or callback request if you cannot answer precisely. Do not invent facts.",
          ].join("\n");
      return {
        agent: { id: currentContext.agentId || "", name: agentName },
        organization: {
          id: currentContext.orgId || currentContext.organizationId || "",
          name: organizationName,
        },
        systemPrompt,
        greeting,
        selectedVoice,
        openAiVoice: selectedVoice,
        voiceProvider: "openai",
        fallbackProvider: "openai",
        elevenLabsVoice: null,
        voiceSettings: {},
        language: "English",
        voiceProfile: "",
        voiceContext: {
          stats: { finalPromptChars: systemPrompt.length },
          diagnostics: {
            realtimeFailSafe: true,
            timedOut: isTimeout,
            error: err.message || String(err),
          },
          samples: {},
          debug: {},
        },
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  async function ensureOpenAI() {
    if (openaiWs) return;
    if (openaiInitPromise) return openaiInitPromise;
    openaiInitPromise = ensureOpenAIInternal().finally(() => {
      openaiInitPromise = null;
    });
    return openaiInitPromise;
  }

  async function ensureOpenAIInternal() {
    if (openaiWs) return;
    if (!apiKey) {
      console.error("[twilio-media-stream] OPENAI_API_KEY is not configured", {
        callSid: context.callSid,
      });
      return;
    }

    const {
      agent,
      organization,
      systemPrompt,
      greeting,
      selectedVoice,
      voiceProvider: loadedVoiceProvider,
      fallbackProvider: loadedFallbackProvider,
      elevenLabsVoice: loadedElevenLabsVoice,
      voiceSettings: loadedVoiceSettings,
      language,
      voiceProfile,
      voiceContext,
    } = await loadAgentAndPromptWithRealtimeTimeout(context);
    if (agent?.id && !context.agentId) context.agentId = agent.id;
    context.agentName = agent?.name || context.agentName || "";
    context.organizationName =
      organization?.name || context.organizationName || "";
    const currentCallDebug = voiceContext?.debug?.currentCall || {};
    context.recipientName = voiceBehavior.cleanRecipientNameForSpeech(
      firstNonEmpty(
        context.recipientName,
        context.targetName,
        currentCallDebug.directRecipientName,
        currentCallDebug.leadName,
      ),
    );
    context.targetName = context.recipientName || context.targetName || "";
    if (context.recipientName && !captureState.callerName) {
      captureState.callerName = context.recipientName;
    }
    console.log("[call-session] recipientName loaded", {
      callSid: context.callSid,
      streamSid,
      recipientName: context.recipientName || "",
      source: context.recipientName ? "context" : "missing",
    });
    context.recipientPhone = firstNonEmpty(
      context.recipientPhone,
      currentCallDebug.directRecipientPhone,
      currentCallDebug.recipientPhone,
    );
    context.greeting = greeting;
    const scheduledSystemPrompt = enhanceSystemPromptForScheduledCall(
      systemPrompt,
      context,
    );
    context.systemPrompt = scheduledSystemPrompt;
    context.sessionVoice = selectedVoice;
    context.language = firstNonEmpty(
      context.language,
      language,
      DEFAULT_CALL_LANGUAGE,
      "en",
    );
    context.sessionLanguage = context.language;
    voiceProvider = normalizeProvider(
      loadedVoiceProvider || process.env.VOICE_PROVIDER_DEFAULT,
      "openai",
    );
    const scheduledProviderOverride = scheduledProviderOverrideFromEnv(context);
    if (scheduledProviderOverride) {
      voiceProvider = scheduledProviderOverride;
      console.log("[voice-quality] scheduled call provider=", {
        callSid: context.callSid,
        provider: voiceProvider,
      });
    }
    fallbackProvider = normalizeProvider(
      loadedFallbackProvider || process.env.VOICE_PROVIDER_FALLBACK,
      "openai",
    );
    elevenLabsVoice = loadedElevenLabsVoice || null;
    voiceSettings = loadedVoiceSettings || {};
    if (voiceProvider === "elevenlabs" && !elevenLabsVoice?.voiceId) {
      console.warn(
        "[voice-provider] elevenlabs selected but no voice_id resolved; fallback=openai",
        {
          callSid: context.callSid,
          agentId: context.agentId || agent?.id || "",
        },
      );
      voiceProvider = fallbackProvider || "openai";
    }
    console.log("[voice-provider] selected", {
      callSid: context.callSid,
      streamSid,
      voiceProvider,
      fallbackProvider,
      elevenLabsVoiceId: elevenLabsVoice?.voiceId || "",
      openaiVoice: selectedVoice,
      voiceSettings,
    });
    console.log("[turn-taking] config", {
      callSid: context.callSid,
      streamSid,
      silenceMs: turnSilenceMsForContext(context),
      minUserSpeechMs: minUserSpeechMsForContext(context),
      responseDebounceMs: responseDebounceMsForContext(context),
      outboundSilenceMs: OUTBOUND_VOICE_TURN_SILENCE_MS,
      outboundMinUserSpeechMs: OUTBOUND_VOICE_MIN_USER_SPEECH_MS,
      outboundResponseDebounceMs: OUTBOUND_VOICE_RESPONSE_DEBOUNCE_MS,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      noSpeechFollowupTimeoutMs: NO_SPEECH_FOLLOWUP_TIMEOUT_MS,
      allowBargeIn: VOICE_ALLOW_BARGE_IN,
      disableFillerAcks: VOICE_DISABLE_FILLER_ACKS,
      callEndConfirmationEnabled: CALL_END_CONFIRMATION_ENABLED,
    });
    if (isScheduledOutboundContext(context)) {
      console.log("[voice-quality] scheduled config", {
        callSid: context.callSid,
        scheduleId: context.scheduleId || "",
        scheduleRunId: context.scheduleRunId || "",
        provider: voiceProvider,
        waitForUserAfterGreeting: SCHEDULED_CALL_WAIT_FOR_USER_AFTER_GREETING,
        disableMonologue: SCHEDULED_CALL_DISABLE_MONOLOGUE,
        maxAssistantSentenceCount: SCHEDULED_CALL_MAX_ASSISTANT_SENTENCE_COUNT,
      });
    }

    if (voiceProvider === "elevenlabs") {
      requestInitialGreeting("twilio-start-elevenlabs-immediate");
    }

    openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    openaiWs.on("open", () => {
      openaiSocketOpen = true;
      logLifecycle("OpenAI websocket/session created", {
        callSid: context.callSid,
        streamSid,
        modelUrl: OPENAI_REALTIME_URL.replace(/api_key=[^&]+/i, "api_key=***"),
        input_audio_format: "audio/pcmu",
        output_audio_format: "audio/pcmu",
      });

      messageCaptureEnabled = shouldEnableMessageCapture(context);
      safeSend(
        openaiWs,
        voiceProvider === "elevenlabs"
          ? realtimeSessionUpdateTextOnly(
              scheduledSystemPrompt,
              messageCaptureEnabled,
              context,
            )
          : realtimeSessionUpdate(
              scheduledSystemPrompt,
              selectedVoice,
              messageCaptureEnabled,
              context,
            ),
      );
      logLifecycle("session voice", {
        callSid: context.callSid,
        streamSid,
        voice: selectedVoice,
        voiceProvider,
        elevenLabsVoiceId: elevenLabsVoice?.voiceId || "",
      });
      logLifecycle("session language", {
        callSid: context.callSid,
        streamSid,
        language,
        configuredLanguage: configuredLanguageForContext(context),
        multilingualEnabled: VOICE_ALLOW_MULTILINGUAL,
      });
      logLifecycle("OpenAI session.update sent", {
        callSid: context.callSid,
        streamSid,
        voice: selectedVoice || DEFAULT_VOICE,
        voiceProvider,
        elevenLabsVoiceId: elevenLabsVoice?.voiceId || "",
        input_audio_format: "audio/pcmu",
        output_audio_format:
          voiceProvider === "elevenlabs" ? "disabled_text_only" : "audio/pcmu",
      });

      // If OpenAI does not echo session.created/session.updated quickly, still
      // trigger the greeting and allow queued caller audio to flow.
      setTimeout(() => {
        if (!openaiSessionReady && openaiWs?.readyState === WebSocket.OPEN) {
          openaiSessionReady = true;
          logLifecycle("OpenAI session ready by timeout fallback", {
            callSid: context.callSid,
            streamSid,
          });
          flushPendingAudio();
          requestInitialGreeting("session-ready-timeout");
        }
      }, 1200);
    });

    openaiWs.on("message", (data, isBinary) => {
      if (isBinary) return;
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        console.warn("[twilio-media-stream] non-json OpenAI message ignored");
        return;
      }

      const type = String(event?.type || "");

      if (
        type === "response.function_call_arguments.done" ||
        type === "response.output_item.done"
      ) {
        const item =
          event.item ||
          event.response?.output?.find?.(
            (entry) => entry?.type === "function_call",
          ) ||
          null;
        const name = firstNonEmpty(event.name, item?.name);
        const args = firstNonEmpty(event.arguments, item?.arguments);
        const callId = firstNonEmpty(
          event.call_id,
          event.callId,
          item?.call_id,
          item?.id,
        );
        if (name === "capture_inbound_message") {
          void handleCaptureInboundMessage(args, callId);
          return;
        }
      }

      if (type === "conversation.item.created") {
        const item = event.item || {};
        if (
          item.type === "function_call" &&
          item.name === "capture_inbound_message" &&
          item.arguments
        ) {
          void handleCaptureInboundMessage(
            item.arguments,
            item.call_id || item.id || "",
          );
          return;
        }
      }

      if (type === "session.updated" || type === "session.created") {
        openaiSessionReady = true;
        logLifecycle(`OpenAI ${type} event`, {
          callSid: context.callSid,
          streamSid,
        });
        flushPendingAudio();
        requestInitialGreeting(type);
        return;
      }

      if (type === "error") {
        counters.openaiErrors += 1;
        const errMsg = getOpenAiErrorMessage(event);
        console.error("[twilio-media-stream] OpenAI error event", {
          callSid: context.callSid,
          streamSid,
          error: event.error || event,
        });

        // Some deployments use the newer gpt-realtime session object shape. If
        // the legacy audio-format session update is rejected, send the current
        // shape once without closing the call.
        if (
          !openaiSessionFallbackSent &&
          /input_audio_format|output_audio_format|unknown parameter|invalid|beta api|realtime beta api|session object/i.test(
            errMsg,
          )
        ) {
          openaiSessionFallbackSent = true;
          safeSend(
            openaiWs,
            voiceProvider === "elevenlabs"
              ? realtimeSessionUpdateTextOnlyCurrent(
                  scheduledSystemPrompt,
                  messageCaptureEnabled,
                  context,
                )
              : realtimeSessionUpdateCurrent(
                  scheduledSystemPrompt,
                  selectedVoice,
                  messageCaptureEnabled,
                  context,
                ),
          );
          requestInitialGreeting("openai-session-fallback");
          logLifecycle("OpenAI current session fallback sent", {
            callSid: context.callSid,
            streamSid,
            error: errMsg,
          });
        }
        return;
      }

      if (type === "conversation.item.input_audio_transcription.completed") {
        const transcript = firstNonEmpty(
          event.transcript,
          event?.item?.content?.[0]?.transcript,
        );
        if (transcript) {
          userTranscripts.push(transcript);
          context.lastUserTranscript = transcript;
          transcriptLines.push({
            role: "caller",
            text: transcript,
            ts: new Date().toISOString(),
          });
          console.log("[transcript] final user transcript", {
            callSid: context.callSid,
            text: transcript,
          });
          const transcriptWordCount = String(transcript)
            .trim()
            .split(/\s+/)
            .filter(Boolean).length;
          if (
            transcriptWordCount >= 2 ||
            String(transcript).trim().length >= 8
          ) {
            suppressAssistantResponseUntil = 0;
          }
          markActivity("caller-transcript");
          if (!userSpeechActive)
            startIdleSilenceTimer("caller-transcript-final");
          if (
            isOutboundContext(context) &&
            isLikelyVoicemailOrIvrText(transcript)
          ) {
            outboundVoicemailDetected = true;
            context.voicemailDetected = true;
            messageCaptureEnabled = false;
            console.log(
              "[outbound-call] voicemail/IVR transcript detected; not saving as lead",
              { callSid: context.callSid, text: transcript.slice(0, 160) },
            );
            void markOutboundVoicemailDetected(
              context,
              transcript,
              "phrase_detected",
            );
            if (!OUTBOUND_LEAVE_VOICEMAIL) {
              requestClosingAndHangup(
                "outbound-voicemail-detected",
                "Thank you. Goodbye.",
              );
            } else {
              requestClosingAndHangup(
                "outbound-voicemail-message",
                outboundVoicemailMessage(context),
              );
            }
          }
          if (
            messageCaptureEnabled &&
            !outboundVoicemailDetected &&
            !isLikelyVoicemailOrIvrText(transcript) &&
            looksLikeMessageCapture(transcript)
          ) {
            captureState.detected = true;
            captureState.callerName =
              captureState.callerName ||
              extractCallerNameFromTranscript(transcript);
            captureState.callerPhone =
              captureState.callerPhone ||
              normalizeCapturedPhone(
                extractPhoneFromTranscript(transcript, context.callerPhone),
                context.callerPhone,
              );
            captureState.callbackTime =
              captureState.callbackTime ||
              extractCallbackTimeFromTranscript(transcript);
            captureState.message = [captureState.message, transcript]
              .filter(Boolean)
              .join("\n")
              .trim();
            console.log("[message-capture] detected", {
              callSid: context.callSid,
              streamSid,
              direction: context.direction,
            });
            console.log(
              "[message-capture] callerName",
              captureState.callerName || "",
            );
            console.log(
              "[message-capture] callbackTime",
              captureState.callbackTime || "",
            );
          }
          if (awaitingHangupConfirmation) {
            if (
              isHangupConfirmationAffirmative(transcript) ||
              isSimpleEndPermissionYes(transcript)
            ) {
              console.log("[hangup] confirmation accepted", {
                callSid: context.callSid,
                streamSid,
                text: transcript,
                reason: hangupConfirmationReason || "caller-confirmed-end",
              });
              requestClosingAndHangup(
                hangupConfirmationReason || "caller-confirmed-end",
                CLOSING_MESSAGE,
              );
            } else if (
              isHangupConfirmationNegativeOrContinue(transcript) ||
              !hasEndIntent(transcript, {
                afterAnythingElsePrompt: lastAssistantAskedAnythingElse,
              })
            ) {
              clearHangupConfirmation("caller-continued-after-confirmation");
              lastAssistantAskedEndPermission = false;
            }
          } else if (
            lastAssistantAskedEndPermission &&
            isSimpleEndPermissionYes(transcript)
          ) {
            console.log("[hangup] model end-permission accepted", {
              callSid: context.callSid,
              streamSid,
              text: transcript,
            });
            lastAssistantAskedEndPermission = false;
            requestClosingAndHangup(
              "caller-confirmed-model-end-permission",
              CLOSING_MESSAGE,
            );
          } else if (
            closingResponseSent &&
            !callEndRequested &&
            hasHangupCancelIntent(transcript)
          ) {
            cancelPendingHangup("caller-continued-after-close");
          } else if (
            hasEndIntent(transcript, {
              afterAnythingElsePrompt:
                lastAssistantAskedAnythingElse ||
                lastAssistantAskedEndPermission,
            })
          ) {
            if (
              lastAssistantAskedEndPermission ||
              lastAssistantAskedAnythingElse
            ) {
              console.log(
                "[hangup] end intent accepted after assistant permission prompt",
                {
                  callSid: context.callSid,
                  streamSid,
                  text: transcript,
                },
              );
              lastAssistantAskedEndPermission = false;
              requestClosingAndHangup(
                "caller-confirmed-end-after-prompt",
                CLOSING_MESSAGE,
              );
            } else {
              requestHangupConfirmation("caller-end-intent");
            }
          }
        }
        return;
      }

      if (
        type === "response.audio_transcript.delta" ||
        type === "response.output_audio_transcript.delta" ||
        type === "response.output_text.delta" ||
        type === "response.text.delta"
      ) {
        const delta = firstNonEmpty(event.delta, event.text);
        if (delta) {
          assistantTextBuffer += delta;
          assistantTranscripts.push(delta);
        }
      }

      if (
        type === "response.audio_transcript.done" ||
        type === "response.output_audio_transcript.done" ||
        type === "response.text.done" ||
        type === "response.output_text.done"
      ) {
        const text = firstNonEmpty(
          event.transcript,
          event.text,
          assistantTextBuffer,
        );
        if (text) {
          const preparedAssistantText = prepareAssistantTextForTts(
            text,
            context,
          );
          transcriptLines.push({
            role: "assistant",
            text: preparedAssistantText || text,
            ts: new Date().toISOString(),
          });
          console.log("[transcript] final assistant transcript", {
            callSid: context.callSid,
            text: preparedAssistantText || text,
          });
          lastAssistantAskedAnythingElse = assistantAskedAnythingElse(
            preparedAssistantText || text,
          );
          lastAssistantAskedEndPermission = assistantAskedEndPermission(
            preparedAssistantText || text,
          );
          if (voiceProvider === "elevenlabs") {
            if (
              suppressAssistantResponseUntil &&
              Date.now() < suppressAssistantResponseUntil
            ) {
              console.log("[turn-taking] ignored short partial", {
                callSid: context.callSid,
                streamSid,
                reason:
                  "suppressed assistant response after short caller audio",
              });
            } else if (preparedAssistantText) {
              void speakWithElevenLabs(
                preparedAssistantText,
                "assistant-response",
              );
            }
          }
          assistantTextBuffer = "";
          // Do not end the call just because the assistant says a goodbye-like
          // phrase. Some generated responses include polite sign-offs while the
          // caller still wants to continue or is speaking over the assistant.
          // Hangup is driven by explicit caller intent, idle timeout, or max
          // duration only.
        }
      }

      if (type === "response.created") {
        if (
          suppressAssistantResponseUntil &&
          Date.now() < suppressAssistantResponseUntil &&
          !closingResponseSent &&
          !awaitingHangupConfirmation
        ) {
          safeSend(openaiWs, { type: "response.cancel" });
          assistantTextBuffer = "";
          console.log(
            "[turn-taking] cancelled OpenAI response after short caller audio",
            {
              callSid: context.callSid,
              streamSid,
            },
          );
          return;
        }
        assistantTextBuffer = "";
        openAiCurrentAudioFrames = 0;
        assistantSpeaking = true;
        finalResponseCompleted = false;
        logLifecycle("OpenAI response.created", {
          callSid: context.callSid,
          streamSid,
          responseId: event?.response?.id || "",
        });
      }

      if (type === "response.done") {
        if (openAiCurrentAudioFrames > 0) {
          sendPlaybackMark("openai-response", event?.response?.id || "");
          openAiCurrentAudioFrames = 0;
        }
        if (pendingPlaybackMarks.size === 0) {
          assistantSpeaking = false;
          finalResponseCompleted = true;
        }
        if (pendingHangup)
          console.log("[hangup] final audio done", {
            callSid: context.callSid,
            streamSid,
            reason: hangupReason || closingReason,
          });
        logLifecycle("OpenAI response.done", {
          callSid: context.callSid,
          streamSid,
          status: event?.response?.status || "",
          audioDeltas: counters.openaiAudioDeltasReceived,
          audioFramesSentToTwilio: counters.audioFramesSentToTwilio,
        });
        if (closingResponseSent && !callEndRequested) {
          closingState = "closing_audio_done";
          console.log("[hangup] pending until assistant audio done", {
            callSid: context.callSid,
            streamSid,
            reason: hangupReason || closingReason,
          });
          schedulePendingHangup(
            () =>
              void requestTwilioCallEnd(
                hangupReason || "closing-response-done",
              ),
            FINAL_AUDIO_HANGUP_DELAY_MS,
          );
        } else if (awaitingHangupConfirmation) {
          console.log(
            "[hangup] waiting for caller confirmation before ending",
            {
              callSid: context.callSid,
              streamSid,
              reason: hangupConfirmationReason,
              direction: context.direction,
            },
          );
        }
      }

      if (type === "input_audio_buffer.speech_started" && streamSid) {
        userSpeechStartedAt = Date.now();
        userSpeechActive = true;
        callerSpeechDetected = true;
        markActivity("caller-speech-start");
        console.log("[turn-taking] user speech started", {
          callSid: context.callSid,
          streamSid,
          assistantSpeaking,
          voiceProvider,
        });
        // Clear Twilio buffered audio when real caller speech overlaps assistant
        // playback. pendingPlaybackMarks tracks audio that has been sent to
        // Twilio but not yet confirmed as fully played.
        if (VOICE_ALLOW_BARGE_IN && assistantOutputActive()) {
          const speechStartToken = userSpeechStartedAt;
          const clearDelay = Math.max(
            VOICE_BARGE_IN_CLEAR_MS,
            Math.min(VOICE_BARGE_IN_MIN_SPEECH_MS, 350),
          );
          setTimeout(() => {
            if (
              userSpeechStartedAt === speechStartToken &&
              assistantOutputActive() &&
              !callEndRequested &&
              !callEnded
            ) {
              console.log("[turn-taking] barge-in detected", {
                callSid: context.callSid,
                streamSid,
                voiceProvider,
                clearDelayMs: clearDelay,
                pendingPlaybackMarks: pendingPlaybackMarks.size,
              });
              clearAssistantOutput(
                "caller-speech-started-during-assistant-audio",
              );
            }
          }, clearDelay);
        }
        return;
      }

      if (type === "input_audio_buffer.speech_stopped" && streamSid) {
        lastUserSpeechEndedAt = Date.now();
        const speechDurationMs = userSpeechStartedAt
          ? lastUserSpeechEndedAt - userSpeechStartedAt
          : 0;
        console.log("[turn-taking] user speech ended", {
          callSid: context.callSid,
          streamSid,
          speechDurationMs,
        });
        userSpeechActive = false;
        const minUserSpeechMs = minUserSpeechMsForContext(context);
        if (speechDurationMs > 0 && speechDurationMs < minUserSpeechMs) {
          suppressAssistantResponseUntil =
            Date.now() + Math.max(1500, turnSilenceMsForContext(context));
          console.log("[turn-taking] ignored short partial", {
            callSid: context.callSid,
            streamSid,
            speechDurationMs,
            minUserSpeechMs,
          });
        } else {
          markActivity("caller-speech-ended");
          startIdleSilenceTimer("caller-speech-ended");
        }
        return;
      }

      if (isAudioDeltaEvent(type)) {
        if (voiceProvider === "elevenlabs") {
          counters.openaiAudioDeltasReceived += 1;
          openaiAudioIgnoredCount += 1;
          if (counters.openaiAudioDeltasReceived === 1) {
            console.warn(
              "[voice-provider] ignored OpenAI audio delta because ElevenLabs is primary",
              {
                callSid: context.callSid,
                streamSid,
                voiceProvider,
              },
            );
          }
          return;
        }
        if (
          suppressAssistantResponseUntil &&
          Date.now() < suppressAssistantResponseUntil &&
          !closingResponseSent &&
          !awaitingHangupConfirmation
        ) {
          openaiAudioIgnoredCount += 1;
          return;
        }
        assistantSpeaking = true;
        finalResponseCompleted = false;
        const audioDelta = extractOpenAiAudioDelta(event);
        if (!audioDelta) {
          console.warn(
            "[twilio-media-stream] OpenAI audio delta event had no payload",
            {
              type,
              callSid: context.callSid,
              streamSid,
            },
          );
          return;
        }
        counters.openaiAudioDeltasReceived += 1;
        if (
          counters.openaiAudioDeltasReceived === 1 ||
          counters.openaiAudioDeltasReceived % 50 === 0
        ) {
          logLifecycle("OpenAI audio delta received", {
            callSid: context.callSid,
            streamSid,
            openaiAudioDeltasReceived: counters.openaiAudioDeltasReceived,
          });
        }
        if (sendAudioToTwilio(audioDelta)) {
          openAiCurrentAudioFrames += 1;
        }
      }
    });

    openaiWs.on("error", (err) => {
      counters.openaiErrors += 1;
      console.error("[twilio-media-stream] OpenAI WS error:", {
        callSid: context.callSid,
        streamSid,
        message: err.message,
      });
    });

    openaiWs.on("close", (code, reason) => {
      openaiSocketOpen = false;
      openaiSessionReady = false;
      logLifecycle("OpenAI WS closed", {
        code,
        reason: reason?.toString?.() || "",
        callSid: context.callSid,
        streamSid,
        counters,
      });
    });
  }

  twilioWs.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      console.warn("[twilio-media-stream] non-json Twilio message ignored", {
        callSid: context.callSid,
      });
      return;
    }

    markActivity(message.event || "twilio-message");

    if (message.event === "connected") {
      logLifecycle("Twilio connected event", {
        callSid: context.callSid,
        protocol: message.protocol || "",
        version: message.version || "",
      });
      return;
    }

    if (message.event === "start") {
      streamSid = message.start?.streamSid || message.streamSid || streamSid;
      context = mergeStartParameters(context, message.start || {});
      context.streamSid = streamSid;
      const startRecipientName = voiceBehavior.cleanRecipientNameForSpeech(
        firstNonEmpty(context.recipientName, context.targetName),
      );
      if (startRecipientName) {
        context.recipientName = startRecipientName;
        context.targetName = context.targetName || startRecipientName;
        captureState.callerName = captureState.callerName || startRecipientName;
      }
      console.log("[call-session] recipientName from stream", {
        callSid: context.callSid,
        streamSid,
        recipientName: startRecipientName || "",
      });
      messageCaptureEnabled = shouldEnableMessageCapture(context);
      logLifecycle("message capture mode", {
        callSid: context.callSid,
        direction: context.direction,
        enabled: messageCaptureEnabled,
      });
      const activeKey = sessionKeyFor(context, streamSid);
      if (activeTwilioSessions.has(activeKey)) {
        console.warn(
          "[twilio-media-stream] duplicate Twilio stream session blocked",
          { callSid: context.callSid, streamSid, activeKey },
        );
        twilioWs.close(1000, "duplicate stream");
        return;
      }
      activeTwilioSessions.add(activeKey);
      twilioWs.__twilioActiveKey = activeKey;
      logLifecycle("Twilio start event", {
        path: context.path,
        orgId: context.orgId,
        agentId: context.agentId,
        callRecordId: context.callRecordId,
        callSid: context.callSid,
        streamSid,
        customParameters: message.start?.customParameters || {},
        leadId: context.leadId || "",
        callPurpose: context.callPurpose || "",
        recipientPhone: context.recipientPhone || "",
      });
      try {
        await ensureOpenAI();
      } catch (err) {
        console.error("[twilio-media-stream] ensureOpenAI failed on start", {
          callSid: context.callSid,
          streamSid,
          error: err.message || String(err),
        });
      }
      return;
    }

    if (message.event === "media") {
      counters.twilioMediaFramesReceived += 1;
      const payload = message.media?.payload;
      if (!payload) {
        console.warn(
          "[twilio-media-stream] Twilio media frame missing payload",
          {
            callSid: context.callSid,
            streamSid,
            mediaFramesReceived: counters.twilioMediaFramesReceived,
          },
        );
        return;
      }

      if (
        counters.twilioMediaFramesReceived === 1 ||
        counters.twilioMediaFramesReceived % 100 === 0
      ) {
        logLifecycle("Twilio media frames received", {
          callSid: context.callSid,
          streamSid,
          mediaFramesReceived: counters.twilioMediaFramesReceived,
        });
      }

      const openAiAudio = {
        type: "input_audio_buffer.append",
        audio: payload,
      };

      if (
        openaiWs &&
        openaiSocketOpen &&
        openaiWs.readyState === WebSocket.OPEN
      ) {
        if (safeSend(openaiWs, openAiAudio)) {
          counters.openaiInputAudioAppended += 1;
          if (
            counters.openaiInputAudioAppended === 1 ||
            counters.openaiInputAudioAppended % 100 === 0
          ) {
            logLifecycle("OpenAI input audio appended", {
              callSid: context.callSid,
              streamSid,
              openaiInputAudioAppended: counters.openaiInputAudioAppended,
            });
          }
        } else {
          console.warn(
            "[twilio-media-stream] media frame received but input audio append failed",
            {
              callSid: context.callSid,
              streamSid,
              openaiSocketOpen,
              readyState: openaiWs?.readyState,
            },
          );
        }
      } else {
        pendingAudio.push(openAiAudio);
        if (pendingAudio.length > 250) pendingAudio.shift();
        if (pendingAudio.length === 1 || pendingAudio.length % 100 === 0) {
          console.warn(
            "[twilio-media-stream] media frame queued; OpenAI not ready yet",
            {
              callSid: context.callSid,
              streamSid,
              pendingAudio: pendingAudio.length,
              hasOpenAI: !!openaiWs,
              openaiSocketOpen,
            },
          );
        }
        if (!openaiWs) {
          void ensureOpenAI().catch((err) => {
            console.error(
              "[twilio-media-stream] ensureOpenAI failed on media",
              {
                callSid: context.callSid,
                streamSid,
                error: err.message || String(err),
              },
            );
          });
        }
      }
      return;
    }

    if (message.event === "mark") {
      const markName = String(message.mark?.name || "");
      if (markName) pendingPlaybackMarks.delete(markName);
      if (pendingPlaybackMarks.size === 0 && !activeTts) {
        assistantSpeaking = false;
        finalResponseCompleted = true;
      }
      logLifecycle("Twilio playback mark received", {
        callSid: context.callSid,
        streamSid,
        markName,
        pendingPlaybackMarks: pendingPlaybackMarks.size,
      });
      return;
    }

    if (message.event === "stop") {
      logLifecycle("Twilio stop event", {
        callSid: context.callSid,
        streamSid,
        counters,
      });
      void (async () => {
        try {
          await finishMessageCapture();
        } catch (_) {}
        try {
          if (context.callSid) await dedupeCallMessage(context.callSid);
        } catch (dedupeErr) {
          console.warn("[message-capture] final dedupe pass failed", {
            callSid: context.callSid,
            error: dedupeErr.message || String(dedupeErr),
          });
        }
      })();
      closeOpenAI();
      return;
    }

    console.warn("[twilio-media-stream] unhandled Twilio event", {
      event: message.event,
      callSid: context.callSid,
      streamSid,
    });
  });

  twilioWs.on("close", (code, reason) => {
    if (twilioWs.__twilioActiveKey)
      activeTwilioSessions.delete(twilioWs.__twilioActiveKey);
    logLifecycle("closed", {
      code,
      reason: reason?.toString?.() || "",
      callSid: context.callSid,
      streamSid,
      counters,
    });
    if (
      counters.twilioMediaFramesReceived > 0 &&
      counters.openaiInputAudioAppended === 0
    ) {
      console.warn(
        "[twilio-media-stream] media received but no input audio appended to OpenAI",
        {
          callSid: context.callSid,
          streamSid,
          reason:
            "OpenAI websocket was not open or input append failed before call ended.",
          counters,
        },
      );
    }
    void (async () => {
      try {
        await finishMessageCapture();
      } catch (_) {}
      try {
        if (context.callSid) await dedupeCallMessage(context.callSid);
      } catch (dedupeErr) {
        console.warn("[message-capture] final dedupe pass failed", {
          callSid: context.callSid,
          error: dedupeErr.message || String(dedupeErr),
        });
      }
    })();
    closeOpenAI();
  });

  twilioWs.on("error", (err) => {
    console.error("[twilio-media-stream] socket error:", {
      callSid: context.callSid,
      streamSid,
      message: err.message,
    });
    closeOpenAI();
  });
}

module.exports = {
  handleTwilioMediaStreamWS,
  loadTwilioAgentContextForDebug,
  loadCallMessageDebug,
  dedupeCallMessage,
  mapVoiceProfileToOpenAi,
};
