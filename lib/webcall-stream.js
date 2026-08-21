"use strict";

/**
 * ============================================================
 * lib/webcall-stream.js
 * ============================================================
 * "Talk to Your Agent" — live browser call.
 *
 * This mirrors the PROVEN, already-working browser realtime path
 * in realtime-proxy.js (the chatbot widget's /realtime route) as
 * closely as possible — same OpenAI session config shape, same
 * audio format (audio/pcm @ 24000), same readiness handling — and
 * adds the two things the phone pipeline needs for a REAL agent:
 *
 *   1. loadVoiceContext() for the exact persona/greeting/KB the
 *      phone agent uses (so it's a true test of the real agent).
 *   2. The DASHBOARD_VOICE_MAP that twilio-media-stream.js uses to
 *      translate dashboard voice names ("Zephyr", "Puck", ...) into
 *      real OpenAI realtime voices ("shimmer", "echo", ...).
 *      Passing an unmapped name like "Zephyr" straight to OpenAI
 *      makes the Realtime session reject and close immediately —
 *      which presented as a call that connected then ended at 0:00
 *      with no audio.
 *
 * Isolated handler, isolated failure domain — cannot affect Twilio
 * calls or the /realtime chatbot proxy.
 * ============================================================
 */

const WebSocket = require("ws");
const { getSupabase } = require("./supabase");
const { verifyWebcallToken } = require("./webcall-auth");
const { loadVoiceContext } = require("./context-builder");
const { createRuntimeMeter } = require("./runtime-meter");
const { insertUsageEvent } = require("./usage-ledger");

/**
 * Fire-and-forget billing write that can never take the process down.
 *
 * insertUsageEvent rethrows Supabase errors, which are plain objects rather
 * than Error instances. Calling it as `void insertUsageEvent(...)` left the
 * rejection unhandled, and Node's default --unhandled-rejections=throw turns
 * that into a process exit — killing every live call on the container, not
 * just the one whose billing write failed. Billing must never be able to do
 * that: log it and carry on, exactly as the phone path does.
 */
function meterUsageSafely(event, label) {
  Promise.resolve()
    .then(() => insertUsageEvent(event))
    .catch((err) => {
      console.warn(
        `[webcall-stream] usage event skipped (${label}):`,
        err?.message || err?.details || JSON.stringify(err || {}),
      );
    });
}
const {
  getRuntimeCreditStatus,
  runtimeCreditStopMessage,
} = require("./runtime-credit-enforcement");
const {
  normalizeProvider,
  resolveElevenLabsVoiceForAgent,
  streamElevenLabsSpeech,
  cleanTextForSpeech,
} = require("./elevenlabs");

const OPENAI_REALTIME_URL =
  process.env.OPENAI_REALTIME_URL ||
  "wss://api.openai.com/v1/realtime?model=gpt-realtime";

// Same allowlist + mapping the working Twilio path uses. Dashboard voice
// names are NOT valid OpenAI realtime voices and must be translated.
const OPENAI_VOICE_ALLOWLIST = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "cedar",
  "marin",
]);

// Dashboard voice names -> real OpenAI realtime voices.
//
// The catalogue has always offered ElevenLabs voice names (Bella, Domi, Rachel
// and friends) regardless of which provider an agent is set to, so agents get
// saved with provider=openai and voice="Domi". Those names resolved to
// nothing, the call fell back to a default voice, and the UI told the operator
// their chosen voice was unavailable — on a call that was otherwise fine.
// Mapping them to the nearest OpenAI voice keeps a sensible, stable voice
// instead of a warning. The proper fix is to stop offering incompatible
// pairings at save time; this stops it degrading the call meanwhile.
const DASHBOARD_VOICE_MAP = {
  // Google-style names already offered in the dashboard
  zephyr: "shimmer",
  puck: "echo",
  charon: "sage",
  kore: "coral",
  fenrir: "ash",
  // Common ElevenLabs names, matched roughly on timbre
  bella: "coral",
  domi: "coral",
  rachel: "shimmer",
  elli: "shimmer",
  sarah: "shimmer",
  charlotte: "sage",
  matilda: "coral",
  adam: "ash",
  antoni: "echo",
  josh: "echo",
  arnold: "ash",
  sam: "verse",
  daniel: "ash",
  george: "ash",
  callum: "verse",
  liam: "echo",
};

function normalizeVoiceName(value) {
  return String(value || "")
    .trim()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9_ -]/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Resolve a configured voice name to a real OpenAI realtime voice, and report
 * whether the agent's actual selection could be honoured.
 *
 * The `matched` flag is the point. The old version returned only the voice
 * name, so a configured voice the map didn't recognise (e.g. "Domi", an
 * ElevenLabs name left on an OpenAI-provider agent) silently became "alloy"
 * with nothing logged anywhere. Callers can now tell the difference between
 * "using the voice you chose" and "using a substitute", and say so.
 */
function resolveOpenAiVoice(voiceProfile) {
  const configuredDefault = normalizeVoiceName(
    process.env.OPENAI_REALTIME_VOICE || "alloy",
  );
  const fallback = OPENAI_VOICE_ALLOWLIST.has(configuredDefault)
    ? configuredDefault
    : "alloy";
  const normalized = normalizeVoiceName(voiceProfile);
  if (!normalized) {
    return { voice: fallback, matched: false, reason: "no_voice_configured" };
  }
  if (OPENAI_VOICE_ALLOWLIST.has(normalized)) {
    return { voice: normalized, matched: true, reason: "openai_voice" };
  }
  if (DASHBOARD_VOICE_MAP[normalized]) {
    return {
      voice: DASHBOARD_VOICE_MAP[normalized],
      matched: true,
      reason: "dashboard_voice_map",
    };
  }
  const firstWord = normalized.split(" ")[0];
  if (DASHBOARD_VOICE_MAP[firstWord]) {
    return {
      voice: DASHBOARD_VOICE_MAP[firstWord],
      matched: true,
      reason: "dashboard_voice_map",
    };
  }
  if (OPENAI_VOICE_ALLOWLIST.has(firstWord)) {
    return { voice: firstWord, matched: true, reason: "openai_voice" };
  }
  return { voice: fallback, matched: false, reason: "unrecognised_voice_name" };
}

function mapVoiceToOpenAi(voiceProfile) {
  return resolveOpenAiVoice(voiceProfile).voice;
}

// OpenAI realtime unit costs, read from the same OPENAI_RATE_CARD_JSON the
// vendor-rate sync maintains, so token pricing is never hardcoded here.
let openAiRateCache = null;
function openAiRealtimeRates() {
  if (openAiRateCache) return openAiRateCache;
  const rates = {};
  try {
    const raw = process.env.OPENAI_RATE_CARD_JSON;
    if (raw) {
      const parsed = JSON.parse(raw);
      for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!row || String(row.provider || "").toLowerCase() !== "openai") continue;
        const cost = Number(row.unitCostUsd ?? row.unit_cost_usd);
        const key = String(row.eventType || row.event_type || "").trim();
        if (key && Number.isFinite(cost)) rates[key] = cost;
      }
    }
  } catch (err) {
    console.warn(
      "[webcall-stream] OPENAI_RATE_CARD_JSON did not parse:",
      err?.message || String(err),
    );
  }
  openAiRateCache = rates;
  return rates;
}

// Split a realtime usage object into the same billable components the phone
// path uses, so both paths price identically against the same rate card.
function realtimeUsageBreakdown(usage) {
  if (!usage || typeof usage !== "object") return [];
  const n = (v) => {
    const x = Number(v || 0);
    return Number.isFinite(x) && x > 0 ? x : 0;
  };
  const inD = usage.input_token_details || usage.inputTokenDetails || {};
  const outD = usage.output_token_details || usage.outputTokenDetails || {};
  const audioIn = n(inD.audio_tokens ?? inD.audio);
  const cachedIn = n(inD.cached_tokens ?? inD.cached);
  const audioOut = n(outD.audio_tokens ?? outD.audio);
  const totalIn = n(usage.input_tokens ?? usage.prompt_tokens);
  const totalOut = n(usage.output_tokens ?? usage.completion_tokens);
  const items = [
    { eventType: "text_input_tokens", quantity: Math.max(0, totalIn - audioIn - cachedIn) },
    { eventType: "cached_text_input_tokens", quantity: cachedIn },
    { eventType: "audio_input_tokens", quantity: audioIn },
    { eventType: "text_output_tokens", quantity: Math.max(0, totalOut - audioOut) },
    { eventType: "audio_output_tokens", quantity: audioOut },
  ].filter((it) => it.quantity > 0);
  if (!items.length) {
    const total = totalIn + totalOut;
    if (total > 0) {
      return [{ eventType: "openai_realtime_blended_tokens", quantity: total }];
    }
  }
  return items;
}

function intEnv(name, fallback, min = 0) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, value);
}

const WEBCALL_MAX_SESSION_SECONDS = intEnv(
  "WEBCALL_MAX_SESSION_SECONDS",
  300,
  30,
);
const WEBCALL_MAX_CONCURRENT_PER_ORG = intEnv(
  "WEBCALL_MAX_CONCURRENT_PER_ORG",
  1,
  1,
);

const activeSessionsByOrg = new Map();

function safeSend(ws, payload) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  } catch (_) {}
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch (_) {
    return null;
  }
}

function isAudioDeltaEvent(type) {
  return (
    type === "response.audio.delta" ||
    type === "response.output_audio.delta" ||
    type === "output_audio.delta" ||
    (typeof type === "string" &&
      (type.endsWith(".audio.delta") || type.endsWith("output_audio.delta")))
  );
}

function extractOpenAiAudioDelta(event) {
  if (!event || typeof event !== "object") return "";
  return (
    event.delta ||
    event.audio ||
    event?.response?.audio?.delta ||
    event?.item?.audio?.delta ||
    event?.output?.audio?.delta ||
    ""
  );
}

function incOrg(orgId) {
  activeSessionsByOrg.set(orgId, (activeSessionsByOrg.get(orgId) || 0) + 1);
}
function decOrg(orgId) {
  const n = Math.max(0, (activeSessionsByOrg.get(orgId) || 0) - 1);
  if (n === 0) activeSessionsByOrg.delete(orgId);
  else activeSessionsByOrg.set(orgId, n);
}

async function loadAgentRow(db, orgId, agentId) {
  const strict = await db
    .from("voice_agents")
    .select("*")
    .eq("id", agentId)
    .eq("organization_id", orgId)
    .maybeSingle();
  return strict?.data || null;
}

async function recordWebcallSession(db, row) {
  try {
    await db.from("webcall_sessions").insert(row);
  } catch (err) {
    console.warn(
      "[webcall-stream] webcall_sessions insert skipped:",
      err.message || String(err),
    );
  }
}

// OpenAI session config — IDENTICAL shape to realtime-proxy.js's proven
// config, only the voice + instructions differ per agent.
// Transcribing the CALLER's audio is opt-out via env. The handler below has
// always listened for input_audio_transcription.completed, but the session was
// never told to produce it — so the transcript only ever showed agent turns.
// If OpenAI ever rejects this field, set WEBCALL_INPUT_TRANSCRIPTION_MODEL=""
// on Railway to disable it without a code deploy; audio is unaffected either way.
const WEBCALL_INPUT_TRANSCRIPTION_MODEL =
  process.env.WEBCALL_INPUT_TRANSCRIPTION_MODEL === undefined
    ? "whisper-1"
    : String(process.env.WEBCALL_INPUT_TRANSCRIPTION_MODEL).trim();

// Turn-detection tuning. silence_duration_ms is the main "calmness" knob: it's
// how long the caller has to go quiet before the model decides their turn is
// over and starts responding. At 650ms, an ordinary mid-sentence pause ("so
// basically... I wanted to know...") read as the end of a turn, so the agent
// started talking while the caller was still mid-thought — which then LOOKED
// like the agent interrupting them, and the caller talking back over it made
// it worse. Widened to 900ms by default, matching the more patient pacing of
// Claude/ChatGPT voice mode. threshold nudged up slightly too, so breathing
// and background noise are less likely to be misread as speech starting.
// Both are env-tunable without a code change if the new defaults still feel
// wrong in either direction.
function floatEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}
// Raised from 0.55 after live testing: the agent was replying to coughs,
// keyboard noise and background chatter. threshold is how confident the model
// must be that it is hearing speech before it treats the turn as started, so
// a higher value simply requires a clearer voice. 0.7 rejects most room noise
// while still triggering on normal speaking volume. If it ever starts missing
// softly-spoken callers, lower this rather than the silence window.
const WEBCALL_VAD_THRESHOLD = floatEnv("WEBCALL_VAD_THRESHOLD", 0.7);
const WEBCALL_VAD_PREFIX_PADDING_MS = floatEnv(
  "WEBCALL_VAD_PREFIX_PADDING_MS",
  300,
);
const WEBCALL_VAD_SILENCE_MS = floatEnv("WEBCALL_VAD_SILENCE_MS", 900);

// Must match twilio-media-stream.js's definition — context-builder tells the
// agent this tool exists whenever a knowledge base is selected, for BOTH call
// paths. The web call never registered it, so the model was told it had a tool
// it could not call: it verbalised the intent instead ("call query: exchange
// rate dollar to naira"), paused, then answered from prompt knowledge only.
function searchToolDefinition() {
  return {
    type: "function",
    name: "search_business_knowledge",
    description:
      "Look up specific, current details about this business (products, services, pricing, policies, availability) using the caller's own words. Call this whenever the caller asks about something specific that you are not already fully certain of from the conversation so far — better to check than to guess or generalize. Silent to the caller; never mention using it.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The specific thing to look up, in plain words close to how the caller asked it (e.g. 'vitamin k2 d3 price', 'probiotics', 'shipping policy').",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

// Whisper auto-detects the spoken language per utterance when none is given,
// and on short or noisy audio it guesses badly — an English caller was
// transcribed as Hindi mid-call. The agent's configured language is a far
// better prior than a two-second audio clip, so pin it.
const LANGUAGE_ISO = {
  english: "en",
  spanish: "es",
  french: "fr",
  german: "de",
  portuguese: "pt",
  italian: "it",
  dutch: "nl",
  arabic: "ar",
  hindi: "hi",
  chinese: "zh",
  japanese: "ja",
  korean: "ko",
  russian: "ru",
  turkish: "tr",
  polish: "pl",
  swedish: "sv",
  yoruba: "yo",
  igbo: "ig",
  hausa: "ha",
  swahili: "sw",
};

function languageIsoCode(language) {
  const key = String(language || "").trim().toLowerCase();
  if (!key) return null;
  if (LANGUAGE_ISO[key]) return LANGUAGE_ISO[key];
  // Accept an ISO code that was configured directly ("en", "en-US").
  const short = key.split(/[-_]/)[0];
  if (/^[a-z]{2}$/.test(short)) return short;
  return null;
}

function openAiSessionConfig({
  systemPrompt,
  voice,
  textOnly,
  enableSearchTool,
  transcriptionLanguage,
}) {
  const session = {
    type: "realtime",
    model: "gpt-realtime",
    instructions: systemPrompt,
    output_modalities: textOnly ? ["text"] : ["audio"],
    ...(enableSearchTool
      ? { tools: [searchToolDefinition()], tool_choice: "auto" }
      : {}),
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
        ...(WEBCALL_INPUT_TRANSCRIPTION_MODEL
          ? {
              transcription: {
                model: WEBCALL_INPUT_TRANSCRIPTION_MODEL,
                ...(transcriptionLanguage
                  ? { language: transcriptionLanguage }
                  : {}),
              },
            }
          : {}),
        turn_detection: {
          type: "server_vad",
          threshold: WEBCALL_VAD_THRESHOLD,
          prefix_padding_ms: WEBCALL_VAD_PREFIX_PADDING_MS,
          silence_duration_ms: WEBCALL_VAD_SILENCE_MS,
          create_response: true,
          interrupt_response: true,
        },
      },
    },
  };
  if (!textOnly) {
    session.audio.output = {
      format: { type: "audio/pcm", rate: 24000 },
      voice,
    };
  }
  return { type: "session.update", session };
}

async function handleWebcallStreamWS(browserWs, req) {
  const params = new URL(req.url || "", "http://localhost").searchParams;
  const token = params.get("token") || "";
  const startedAt = Date.now();

  const claims = await verifyWebcallToken(token);
  if (!claims) {
    safeSend(browserWs, {
      type: "session.error",
      code: "AUTH_INVALID",
      message: "Could not validate this call link. Reopen the widget and try again.",
    });
    try {
      browserWs.close(4401, "invalid_token");
    } catch (_) {}
    return;
  }

  const { orgId, agentId, userId } = claims;
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    safeSend(browserWs, {
      type: "session.error",
      code: "SERVER_NOT_CONFIGURED",
      message: "Voice calling is temporarily unavailable. Please try again shortly.",
    });
    try {
      browserWs.close(1011, "not_configured");
    } catch (_) {}
    return;
  }

  const db = getSupabase();

  const creditStatus = await getRuntimeCreditStatus({
    organizationId: orgId,
    action: "voice_call",
  });
  if (creditStatus.shouldBlock) {
    safeSend(browserWs, {
      type: "session.error",
      code: "INSUFFICIENT_CREDIT",
      message: runtimeCreditStopMessage(creditStatus),
    });
    try {
      browserWs.close(4402, "insufficient_credit");
    } catch (_) {}
    return;
  }

  if ((activeSessionsByOrg.get(orgId) || 0) >= WEBCALL_MAX_CONCURRENT_PER_ORG) {
    safeSend(browserWs, {
      type: "session.error",
      code: "SESSION_LIMIT",
      message: "Only one live call can run at a time. End the other session and try again.",
    });
    try {
      browserWs.close(4429, "concurrency_limit");
    } catch (_) {}
    return;
  }

  let agentRow = null;
  let voiceContext = null;
  try {
    agentRow = await loadAgentRow(db, orgId, agentId);
    if (!agentRow) {
      safeSend(browserWs, {
        type: "session.error",
        code: "AGENT_NOT_FOUND",
        message: "This agent could not be found. Refresh the page and try again.",
      });
      try {
        browserWs.close(4404, "agent_not_found");
      } catch (_) {}
      return;
    }
    voiceContext = await loadVoiceContext(
      db,
      orgId,
      agentRow,
      "inbound phone call business products services faqs support",
      { direction: "inbound" },
    );
  } catch (err) {
    console.error("[webcall-stream] context load failed:", err.message || err);
    safeSend(browserWs, {
      type: "session.error",
      code: "CONTEXT_LOAD_FAILED",
      message: "Could not load this agent's configuration. Please try again.",
    });
    try {
      browserWs.close(1011, "context_load_failed");
    } catch (_) {}
    return;
  }

  const systemPrompt = String(
    voiceContext?.systemPrompt ||
      agentRow.system_prompt ||
      agentRow.prompt ||
      "You are a helpful phone assistant for this business. Be concise, warm, and natural.",
  ).slice(0, 12000);

  const provider = normalizeProvider(
    voiceContext?.debug?.agent?.voiceProvider || agentRow.voice_provider,
    "openai",
  );
  const greeting =
    voiceContext?.debug?.agent?.greeting ||
    agentRow.greeting ||
    "Hello! How can I help you today?";
  const agentName = agentRow.name || "Your Agent";
  const agentLanguage = String(
    voiceContext?.debug?.agent?.language || agentRow.language || "English",
  ).trim();
  const selectedKnowledgeBaseId =
    voiceContext?.selectedKnowledgeBaseId ||
    agentRow.knowledge_base_id ||
    null;

  // context-builder already emits languageRules(), but it sits mid-prompt and
  // systemPrompt is truncated to 12k above — a large knowledge base can push
  // the language rule out entirely. Anchoring it at the very front, AFTER the
  // truncation, means the configured language can never be lost.
  const sessionInstructions = [
    `LANGUAGE: You speak only in ${agentLanguage}. Every response must be entirely in ${agentLanguage}, including your first words.`,
    `Never open in, switch to, or repeat yourself in another language unless the caller explicitly asks you to.`,
    "",
    systemPrompt,
  ].join("\n");

  const configuredVoiceName = String(
    voiceContext?.debug?.agent?.openai_voice ||
      agentRow.openai_voice ||
      agentRow.voice ||
      "",
  ).trim();

  // Resolve the voice this agent is ACTUALLY configured with.
  //
  // Catalog resolution used to run only when voice_provider was literally
  // "elevenlabs". That meant an agent carrying an explicit
  // elevenlabs_voice_id / voice_catalog_id but a stale provider column had its
  // real selection ignored. Try the catalog whenever there is an explicit
  // selection to resolve, so the chosen voice wins over a stale column.
  let elevenLabsVoiceId = "";
  let elevenLabsModelId = "";
  let resolvedVoiceLabel = "";
  let voiceSource = "";
  let voiceFallbackReason = "";

  const hasExplicitCatalogSelection = Boolean(
    agentRow.elevenlabs_voice_id ||
      agentRow.voice_catalog_id ||
      (agentRow.voice_id && provider === "elevenlabs"),
  );

  if (provider === "elevenlabs" || hasExplicitCatalogSelection) {
    try {
      const resolved = await resolveElevenLabsVoiceForAgent(db, agentRow);
      if (resolved?.ok && resolved.voice?.voiceId) {
        elevenLabsVoiceId = resolved.voice.voiceId;
        elevenLabsModelId = resolved.voice.modelId || "";
        resolvedVoiceLabel = resolved.voice.name || "";
        voiceSource = resolved.source || "voice_catalog";
      } else if (provider === "elevenlabs") {
        voiceFallbackReason = resolved?.reason || "voice_resolution_failed";
      }
    } catch (err) {
      voiceFallbackReason = "voice_resolution_error";
      console.warn(
        "[webcall-stream] ElevenLabs voice resolution failed, falling back to OpenAI voice:",
        err.message || String(err),
      );
    }
  }

  // ElevenLabs is used when the provider says so, or when the agent has an
  // explicit catalog selection that resolved — the selection is the clearer
  // statement of intent than a column that may not have been kept in sync.
  //
  // WEBCALL_FORCE_REALTIME overrides this to always use OpenAI's native
  // speech-to-speech on the WEBCALL path specifically, regardless of the
  // agent's configured provider. Real phone calls (twilio-media-stream.js)
  // are untouched by this flag — they still honour whatever the agent is
  // actually configured with. The ElevenLabs path is inherently cascaded
  // (generate text, then synthesize it, then stream that), which is what
  // read as "it generates the text first and then reads it out" rather than
  // talking as it thinks. True STS removes that generate-then-speak seam and
  // gives the model direct control over cutting off mid-utterance for
  // interruption, instead of routing it through the chunk-cancel guard.
  // Defaults ON: test calls should demonstrate the same low-latency,
  // natural-barge-in behaviour every other realtime voice interface has, and
  // it costs the agent nothing configured on ElevenLabs for the phone side.
  // Set WEBCALL_FORCE_REALTIME=false on Railway to test an agent's actual
  // configured ElevenLabs voice on a web call instead.
  const forceRealtime =
    String(process.env.WEBCALL_FORCE_REALTIME ?? "true").trim().toLowerCase() !==
    "false";
  const elevenLabsConfigured =
    Boolean(elevenLabsVoiceId) &&
    (provider === "elevenlabs" || hasExplicitCatalogSelection);
  const useElevenLabs = !forceRealtime && elevenLabsConfigured;
  // True when the agent is genuinely configured for ElevenLabs and the ONLY
  // reason it isn't being used is the platform-level override — as opposed to
  // the agent being on OpenAI with a voice name (like "Domi") that doesn't
  // map to anything. Both cases fall through to the OpenAI fallback voice
  // below, but they are not the same situation and must not produce the same
  // "this is misconfigured, go fix it" warning.
  const realtimeOverrideActive = forceRealtime && elevenLabsConfigured;

  const openAiResolution = resolveOpenAiVoice(configuredVoiceName);
  const openAiVoice = openAiResolution.voice;

  if (useElevenLabs) {
    resolvedVoiceLabel = resolvedVoiceLabel || configuredVoiceName;
    voiceSource = voiceSource || "elevenlabs";
  } else {
    resolvedVoiceLabel = openAiVoice;
    voiceSource = realtimeOverrideActive
      ? "webcall_force_realtime"
      : openAiResolution.reason;
    if (!realtimeOverrideActive && !openAiResolution.matched && configuredVoiceName) {
      voiceFallbackReason = voiceFallbackReason || openAiResolution.reason;
    }
  }

  // Never substitute a voice silently — UNLESS the substitution is the
  // deliberate WEBCALL_FORCE_REALTIME override, which is expected behaviour,
  // not a misconfiguration. If the agent's configured voice could not be
  // honoured for any other reason, the log says exactly what was asked for
  // and what is actually being spoken, and the browser is told so it can
  // surface it.
  const voiceHonoured =
    useElevenLabs || openAiResolution.matched || realtimeOverrideActive;
  if (realtimeOverrideActive) {
    console.log(
      `[webcall-stream] realtime override active agent=${agentId} configuredProvider=elevenlabs configuredVoice="${configuredVoiceName || "(none)"}" using=openai:${openAiVoice} (WEBCALL_FORCE_REALTIME=true)`,
    );
  } else if (!voiceHonoured) {
    console.warn("[webcall-stream] configured voice could not be honoured", {
      agentId,
      configuredVoice: configuredVoiceName || "(none)",
      configuredProvider: provider,
      speakingAs: resolvedVoiceLabel,
      reason: voiceFallbackReason || "unrecognised_voice_name",
      hint: "Set the agent to a voice in voice_catalog, or to a valid OpenAI realtime voice.",
    });
  } else {
    console.log(
      `[webcall-stream] voice resolved agent=${agentId} configured="${configuredVoiceName || "(none)"}" using="${resolvedVoiceLabel}" source=${voiceSource}`,
    );
  }

  incOrg(orgId);

  const runtimeMeter = createRuntimeMeter({
    organizationId: orgId,
    userId: userId || null,
    voiceAgentId: agentId,
    route: "webcall_agent_test",
    externalId: `webcall:${agentId}:${startedAt}`,
    metadata: { provider: useElevenLabs ? "elevenlabs" : "openai" },
  });
  void runtimeMeter.start();

  let sessionEnded = false;
  let openaiReady = false;
  let readyTimer = null;
  let sessionTimer = null;
  let textBuffer = "";
  const pending = [];
  // Bumped every time the caller starts speaking. Any audio still being
  // produced for an earlier generation is discarded rather than sent.
  let speechGeneration = 0;
  let elevenLabsCharsSpoken = 0;

  // Barge-in. Two things have to happen and previously neither did:
  //   1. stop producing audio here (the generation bump, above), and
  //   2. tell the browser to drop what it has ALREADY buffered — the client
  //      schedules every chunk ahead on the WebAudio timeline, so seconds of
  //      speech can be queued and will play out even after we stop sending.
  function interruptPlayback(source) {
    speechGeneration += 1;
    textBuffer = "";
    safeSend(browserWs, { type: "agent.interrupted", source: source || "vad" });
  }

  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  async function finishSession(reason) {
    if (sessionEnded) return;
    sessionEnded = true;
    if (readyTimer) clearTimeout(readyTimer);
    if (sessionTimer) clearTimeout(sessionTimer);
    decOrg(orgId);
    await runtimeMeter.finish(reason);

    // Bill the synthesis actually used on the cascaded path.
    if (elevenLabsCharsSpoken > 0) {
      let elevenRate = null;
      try {
        const parsed = JSON.parse(process.env.ELEVENLABS_RATE_CARD_JSON || "[]");
        const row = (Array.isArray(parsed) ? parsed : [parsed]).find(
          (r) => r && String(r.unit || "").toLowerCase() === "characters",
        );
        const v = Number(row?.unitCostUsd ?? row?.unit_cost_usd);
        if (Number.isFinite(v) && v > 0) elevenRate = v;
      } catch (_) {}
      meterUsageSafely({
        organizationId: orgId,
        userId: userId || null,
        provider: "elevenlabs",
        service: "voice",
        eventType: "tts_or_agent_voice",
        source: "agently_ws_webcall_meter",
        externalId: `webcall:${agentId}:${startedAt}:elevenlabs`,
        voiceAgentId: agentId,
        unit: "characters",
        quantity: elevenLabsCharsSpoken,
        unitCostUsd: elevenRate,
        metadata: { route: "webcall_agent_test", voice_id: elevenLabsVoiceId || null },
      }, "elevenlabs_characters");
    }
    await recordWebcallSession(db, {
      organization_id: orgId,
      voice_agent_id: agentId,
      user_id: userId || null,
      voice_provider: useElevenLabs ? "elevenlabs" : "openai",
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date().toISOString(),
      duration_seconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
      end_reason: reason,
    });
    try {
      if (
        openaiWs.readyState === WebSocket.OPEN ||
        openaiWs.readyState === WebSocket.CONNECTING
      ) {
        openaiWs.close(1000);
      }
    } catch (_) {}
    safeSend(browserWs, { type: "session.ended", reason });
    try {
      if (browserWs.readyState === WebSocket.OPEN) browserWs.close(1000, reason);
    } catch (_) {}
  }

  function flushPending() {
    if (!openaiReady || openaiWs.readyState !== WebSocket.OPEN) return;
    while (pending.length) openaiWs.send(pending.shift());
  }

  function markReady(reason) {
    if (openaiReady || sessionEnded) return;
    openaiReady = true;
    if (readyTimer) clearTimeout(readyTimer);
    console.log(`[webcall-stream] ready (${reason}) agent=${agentId} voice=${openAiVoice} provider=${useElevenLabs ? "elevenlabs" : "openai"}`);
    safeSend(browserWs, {
      type: "session.ready",
      agentName,
      greeting,
      voiceProvider: useElevenLabs ? "elevenlabs" : "openai",
      // So the widget can tell the operator when the voice they picked in the
      // dashboard is not the voice they are hearing.
      voiceConfigured: configuredVoiceName || null,
      voiceUsed: resolvedVoiceLabel || null,
      voiceHonoured,
      voiceFallbackReason: voiceHonoured ? null : voiceFallbackReason || null,
    });
    // Ask the agent to greet first, as it would answering a real call.
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          // The old instruction was "greet the caller warmly and naturally"
          // with no language and no reference to the configured greeting. The
          // model was free to pick a language — which is why an English agent
          // opened in Spanish — and free to improvise instead of introducing
          // the business the way the dashboard greeting says to.
          instructions: [
            `Speak ONLY in ${agentLanguage}. Every word of this greeting must be in ${agentLanguage}.`,
            `You are ${agentName}. Answer this call now, warmly and naturally, exactly as you would a real phone call.`,
            greeting
              ? `Use this configured greeting as your opening. Keep its meaning, the business name, and any introduction it contains: "${greeting}"`
              : "Introduce yourself and the business before asking how you can help.",
            "Do not greet in any other language first. Do not translate or repeat the greeting in another language.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      }),
    );
    flushPending();
    sessionTimer = setTimeout(
      () => void finishSession("time_limit"),
      WEBCALL_MAX_SESSION_SECONDS * 1000,
    );
    if (typeof sessionTimer.unref === "function") sessionTimer.unref();
  }

  // Live knowledge lookup, mirroring twilio-media-stream.js. Runs the same
  // search_knowledge_chunks / search_faqs RPCs against the agent's own
  // knowledge base, returns the result to the model as function_call_output,
  // then asks it to answer from those results.
  const handledSearchToolCalls = new Set();

  async function handleSearchKnowledgeTool(rawArgs, callId = "") {
    const key = String(callId || "").trim();
    if (key && handledSearchToolCalls.has(key)) return;
    if (key) handledSearchToolCalls.add(key);

    let parsed = {};
    try {
      parsed = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs || {};
    } catch (_) {
      parsed = {};
    }
    const query = String(parsed.query || parsed.question || parsed.topic || "").trim();

    let outputPayload;
    if (!query) {
      outputPayload = { found: false, results: [], note: "No search query was provided." };
    } else {
      try {
        const kbIds = selectedKnowledgeBaseId ? [selectedKnowledgeBaseId] : null;
        const [chunkResult, faqResult] = await Promise.all([
          db
            .rpc("search_knowledge_chunks", {
              p_organization_id: orgId,
              p_knowledge_base_ids: kbIds,
              p_query: query,
              // Sized from measurement, not guesswork. Ranking is
              // text-similarity based, so a page's own SEO prose ("black
              // market exchange rate, daily naira exchange rate...") outranks
              // the chunk holding the actual table: on abokirate.com the
              // rate-bearing chunks sit at ranks 17-29 while keyword-stuffed
              // filler takes 1-3. At a limit of 6 the answer was unreachable.
              p_limit: 20,
              // Those chunks carry the figure at character 531-1693, so a
              // 500-char window returned the page nav and cut the numbers off.
              // 1800 covers every occurrence measured.
              p_max_chars: 1800,
            })
            .then((r) => r, (e) => ({ data: [], error: e })),
          db
            .rpc("search_faqs", {
              p_organization_id: orgId,
              p_knowledge_base_ids: kbIds,
              p_query: query,
              p_limit: 4,
            })
            .then((r) => r, (e) => ({ data: [], error: e })),
        ]);
        const chunks = (chunkResult?.data || []).filter(
          (r) => Number(r?.search_score || 0) > 0,
        );
        const faqs = (faqResult?.data || []).filter(
          (r) => Number(r?.search_score || 0) > 0,
        );
        const found = chunks.length > 0 || faqs.length > 0;
        outputPayload = {
          found,
          results: [
            ...faqs.slice(0, 3).map((f) => ({
              type: "faq",
              question: f.question,
              answer: f.answer,
            })),
            ...chunks.slice(0, 5).map((c) => ({
              type: "info",
              title: c.source_title || "",
              content: c.content,
              url: c.source_url || "",
            })),
          ],
        };
        console.log(
          `[webcall-stream] knowledge search agent=${agentId} query="${query}" found=${found} results=${outputPayload.results.length}`,
        );
      } catch (err) {
        console.warn(
          "[webcall-stream] knowledge search failed:",
          err?.message || String(err),
        );
        outputPayload = {
          found: false,
          results: [],
          note: "Search is temporarily unavailable.",
        };
      }
    }

    if (openaiWs && openaiWs.readyState === WebSocket.OPEN && callId) {
      safeSend(openaiWs, {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(outputPayload),
        },
      });
      safeSend(openaiWs, {
        type: "response.create",
        response: {
          instructions: outputPayload.found
            ? `Answer the caller's question using the search results you just received, in ${agentLanguage}. Give real names, details and lists. Never mention that you searched, a tool, or a knowledge base.`
            : `The search found nothing relevant. In ${agentLanguage}, help with the closest relevant thing you already know about this business, or warmly offer to take a message. Never say you lack information or mention searching or a knowledge base.`,
        },
      });
    }
  }

  async function speakWithElevenLabs(text) {
    const clean = cleanTextForSpeech(text);
    if (!clean) return;
    // ElevenLabs bills on characters submitted, so count at submission —
    // an utterance cut short by barge-in has still been charged for.
    elevenLabsCharsSpoken += clean.length;
    // Capture the generation this utterance belongs to. If the caller starts
    // talking mid-sentence, interruptPlayback() bumps the counter and the
    // chunk callback below throws, which unwinds the read loop inside
    // streamElevenLabsSpeech. Without this the whole utterance kept streaming
    // to the browser no matter what the caller did — OpenAI's
    // interrupt_response only cancels OpenAI's own response, and in the
    // ElevenLabs path OpenAI produces text, not the audio being played.
    const generation = speechGeneration;
    // ElevenLabs streams arbitrary byte lengths, but the payload is 16-bit
    // PCM — two bytes per sample. The browser decodes each message on its own
    // with `new Int16Array(bytes.buffer)`, so a chunk that ends mid-sample
    // shifted every following sample by one byte and decoded as white noise.
    // That is the "TV static" mixed through the speech. Carry the odd trailing
    // byte into the next chunk so every message we emit is sample-aligned and
    // an even number of bytes.
    let carry = Buffer.alloc(0);
    try {
      await streamElevenLabsSpeech({
        voiceId: elevenLabsVoiceId,
        modelId: elevenLabsModelId || undefined,
        text: clean,
        outputFormat: "pcm_24000",
        onAudioChunk: async (buffer) => {
          if (generation !== speechGeneration) {
            const stale = new Error("__webcall_interrupted__");
            stale.__interrupted = true;
            throw stale;
          }
          const data = carry.length
            ? Buffer.concat([carry, buffer])
            : Buffer.from(buffer);
          const usable = data.length - (data.length % 2);
          carry =
            usable === data.length
              ? Buffer.alloc(0)
              : Buffer.from(data.subarray(usable));
          if (!usable) return; // nothing but a half sample yet
          safeSend(browserWs, {
            type: "output_audio",
            audio: data.subarray(0, usable).toString("base64"),
          });
        },
      });
    } catch (err) {
      if (err && err.__interrupted) return; // caller barged in; expected
      console.warn(
        "[webcall-stream] ElevenLabs streaming failed:",
        err.message || String(err),
      );
    }
  }

  openaiWs.on("open", () => {
    console.log(`[webcall-stream] OpenAI connected agent=${agentId}`);
    openaiWs.send(
      JSON.stringify(
        openAiSessionConfig({
          systemPrompt: sessionInstructions,
          voice: openAiVoice,
          textOnly: useElevenLabs,
          enableSearchTool: Boolean(selectedKnowledgeBaseId),
          transcriptionLanguage: languageIsoCode(agentLanguage),
        }),
      ),
    );
    readyTimer = setTimeout(() => markReady("timeout"), 1200);
  });

  openaiWs.on("message", (raw) => {
    if (sessionEnded) return;
    const event = safeJsonParse(raw);
    if (!event) return;
    const type = event.type || "";

    if (type === "session.updated" || type === "session.created") {
      markReady(type);
      return;
    }

    if (type === "error") {
      const err = event.error || event;
      const msg = String(err.message || err.code || "");
      if (/no active response found|cancellation failed/i.test(msg)) return;
      // A real, non-benign error at this stage almost always means the
      // session config was rejected — log it loudly so it's visible.
      console.error(`[webcall-stream] OpenAI error agent=${agentId}:`, JSON.stringify(err));
      return;
    }

    // Token metering. The web call previously metered runtime seconds only,
    // so the two largest cost drivers — realtime tokens and, on the cascaded
    // path, ElevenLabs characters — were never billed at all. One itemized,
    // rate-card-matching event per component, exactly as the phone path does.
    if (type === "response.done") {
      const usage = event?.response?.usage || event?.usage || null;
      const items = realtimeUsageBreakdown(usage);
      if (items.length) {
        const rates = openAiRealtimeRates();
        const ref = event?.response?.id || `${Date.now()}`;
        for (const item of items) {
          meterUsageSafely({
            organizationId: orgId,
            userId: userId || null,
            provider: "openai",
            service: "realtime",
            eventType: item.eventType,
            source: "agently_ws_webcall_meter",
            externalId: `webcall:${agentId}:${ref}:${item.eventType}`,
            voiceAgentId: agentId,
            unit: "tokens",
            quantity: item.quantity,
            unitCostUsd: rates[item.eventType] ?? null,
            metadata: { route: "webcall_agent_test", model: "gpt-realtime", usage },
          }, `openai_${item.eventType}`);
        }
      }
      return;
    }

    // Knowledge-lookup tool calls. Both event shapes are handled because the
    // realtime API surfaces completed function calls either as a done event or
    // as a created conversation item depending on the flow.
    if (
      type === "response.function_call_arguments.done" &&
      event.name === "search_business_knowledge"
    ) {
      void handleSearchKnowledgeTool(event.arguments, event.call_id || event.item_id || "");
      return;
    }
    if (type === "conversation.item.created") {
      const item = event.item || {};
      if (
        item.type === "function_call" &&
        item.name === "search_business_knowledge" &&
        item.arguments
      ) {
        void handleSearchKnowledgeTool(item.arguments, item.call_id || item.id || "");
      }
      return;
    }

    // Server-side VAD says the caller has started talking. This is the barge-in
    // trigger: kill in-flight synthesis and flush the browser's audio queue.
    if (type === "input_audio_buffer.speech_started") {
      interruptPlayback("vad");
      safeSend(browserWs, { type: "user.speaking", speaking: true });
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      safeSend(browserWs, { type: "user.speaking", speaking: false });
      return;
    }

    if (
      type === "conversation.item.input_audio_transcription.completed" &&
      event.transcript
    ) {
      safeSend(browserWs, { type: "transcript.user", text: event.transcript });
      return;
    }

    if (!useElevenLabs && isAudioDeltaEvent(type)) {
      const delta = extractOpenAiAudioDelta(event);
      if (delta) safeSend(browserWs, { type: "output_audio", audio: delta });
      return;
    }
    if (
      !useElevenLabs &&
      (type === "response.output_audio_transcript.done" ||
        type === "response.audio_transcript.done") &&
      event.transcript
    ) {
      safeSend(browserWs, { type: "transcript.agent", text: event.transcript });
      return;
    }

    if (useElevenLabs && type === "response.text.delta" && event.delta) {
      textBuffer += event.delta;
      safeSend(browserWs, {
        type: "transcript.agent",
        text: textBuffer,
        partial: true,
      });
      return;
    }
    if (
      useElevenLabs &&
      (type === "response.text.done" || type === "response.output_text.done")
    ) {
      const finalText = event.text || textBuffer;
      textBuffer = "";
      if (finalText) {
        safeSend(browserWs, { type: "transcript.agent", text: finalText });
        void speakWithElevenLabs(finalText);
      }
      return;
    }
  });

  openaiWs.on("error", (err) => {
    console.error("[webcall-stream] OpenAI WS error:", err.message || err);
    safeSend(browserWs, {
      type: "session.error",
      code: "REALTIME_CONNECTION_FAILED",
      message: "Could not connect to the voice engine. Please try again.",
    });
    void finishSession("openai_error");
  });

  openaiWs.on("close", (code, reason) => {
    console.log(
      `[webcall-stream] OpenAI closed code=${code} reason=${reason || ""} agent=${agentId}`,
    );
    if (!sessionEnded) void finishSession(`openai_closed_${code}`);
  });

  browserWs.on("message", (raw, isBinary) => {
    if (isBinary || sessionEnded) return;
    const event = safeJsonParse(raw);
    if (!event) return;

    if (event.type === "session.end") {
      void finishSession("caller_hangup");
      return;
    }

    if (event.type === "input_audio" && event.audio) {
      const payload = JSON.stringify({
        type: "input_audio_buffer.append",
        audio: event.audio,
      });
      if (openaiReady && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(payload);
      } else {
        pending.push(payload);
        if (pending.length > 300) pending.shift();
      }
    }
  });

  browserWs.on("close", () => {
    if (!sessionEnded) void finishSession("browser_closed");
  });

  browserWs.on("error", (err) => {
    console.warn("[webcall-stream] browser WS error:", err.message || err);
    if (!sessionEnded) void finishSession("browser_error");
  });
}

module.exports = { handleWebcallStreamWS };
