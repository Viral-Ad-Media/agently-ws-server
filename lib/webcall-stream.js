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

const DASHBOARD_VOICE_MAP = {
  zephyr: "shimmer",
  puck: "echo",
  charon: "sage",
  kore: "coral",
  fenrir: "ash",
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

function openAiSessionConfig({ systemPrompt, voice, textOnly }) {
  const session = {
    type: "realtime",
    model: "gpt-realtime",
    instructions: systemPrompt,
    output_modalities: textOnly ? ["text"] : ["audio"],
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
        ...(WEBCALL_INPUT_TRANSCRIPTION_MODEL
          ? { transcription: { model: WEBCALL_INPUT_TRANSCRIPTION_MODEL } }
          : {}),
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 650,
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
  const useElevenLabs =
    Boolean(elevenLabsVoiceId) &&
    (provider === "elevenlabs" || hasExplicitCatalogSelection);

  const openAiResolution = resolveOpenAiVoice(configuredVoiceName);
  const openAiVoice = openAiResolution.voice;

  if (useElevenLabs) {
    resolvedVoiceLabel = resolvedVoiceLabel || configuredVoiceName;
    voiceSource = voiceSource || "elevenlabs";
  } else {
    resolvedVoiceLabel = openAiVoice;
    voiceSource = openAiResolution.reason;
    if (!openAiResolution.matched && configuredVoiceName) {
      voiceFallbackReason = voiceFallbackReason || openAiResolution.reason;
    }
  }

  // Never substitute a voice silently. If the agent's configured voice could
  // not be honoured, the log says exactly what was asked for and what is
  // actually being spoken, and the browser is told so it can surface it.
  const voiceHonoured = useElevenLabs || openAiResolution.matched;
  if (!voiceHonoured) {
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
          instructions:
            "Greet the caller now, warmly and naturally, as you would when answering a real phone call.",
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

  async function speakWithElevenLabs(text) {
    const clean = cleanTextForSpeech(text);
    if (!clean) return;
    // Capture the generation this utterance belongs to. If the caller starts
    // talking mid-sentence, interruptPlayback() bumps the counter and the
    // chunk callback below throws, which unwinds the read loop inside
    // streamElevenLabsSpeech. Without this the whole utterance kept streaming
    // to the browser no matter what the caller did — OpenAI's
    // interrupt_response only cancels OpenAI's own response, and in the
    // ElevenLabs path OpenAI produces text, not the audio being played.
    const generation = speechGeneration;
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
          safeSend(browserWs, {
            type: "output_audio",
            audio: buffer.toString("base64"),
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
          systemPrompt,
          voice: openAiVoice,
          textOnly: useElevenLabs,
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
