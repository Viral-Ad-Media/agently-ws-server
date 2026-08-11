"use strict";

/**
 * ============================================================
 * lib/webcall-stream.js
 * ============================================================
 * "Talk to Your Agent" — live browser test call.
 *
 * This is a NEW, isolated WebSocket handler. It does not modify
 * or share any mutable state with twilio-media-stream.js, and a
 * failure here cannot affect real phone calls.
 *
 * Fidelity is the entire point of this feature: the business
 * owner is testing the exact agent that will answer real calls.
 * So this handler reuses the same shared modules the phone
 * pipeline uses for everything that determines what the agent
 * knows and sounds like:
 *
 *   - context-builder.js  loadVoiceContext()   → persona/prompt/KB
 *   - elevenlabs.js       resolveElevenLabsVoiceForAgent() /
 *                         streamElevenLabsSpeech()          → voice
 *   - runtime-credit-enforcement.js                          → billing gate
 *   - runtime-meter.js / usage-ledger.js                     → metering
 *
 * What is NOT reused from twilio-media-stream.js: the Twilio
 * u-law framing, call-record persistence, lead capture, and
 * outbound-call state machine — none of that applies to a
 * short-lived self-test session that never touches a real
 * customer or a real phone number.
 *
 * Browser <-> server protocol (JSON text frames):
 *
 *   Browser -> Server
 *     { type: "input_audio", audio: "<base64 PCM16 24kHz mono>" }
 *     { type: "session.end" }
 *
 *   Server -> Browser
 *     { type: "session.ready", agentName, greeting, voiceProvider }
 *     { type: "output_audio", audio: "<base64 PCM16 24kHz mono>" }
 *     { type: "transcript.user", text }
 *     { type: "transcript.agent", text, partial? }
 *     { type: "session.error", code, message }
 *     { type: "session.ended", reason }
 *
 * The browser never sees which provider (OpenAI native audio vs.
 * OpenAI text + ElevenLabs) produced a given output_audio chunk —
 * playback is provider-agnostic PCM16/24kHz either way.
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
  `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
  )}`;

const OPENAI_VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "marin",
  "sage",
  "shimmer",
  "verse",
]);

function intEnv(name, fallback, min = 0) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, value);
}

function numEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
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
// Mirrors twilio-media-stream.js's inbound-call turn detection defaults so
// the test call paces conversation the same way a real call would.
const VOICE_VAD_THRESHOLD = numEnv("VOICE_VAD_THRESHOLD", 0.68);
const VOICE_VAD_PREFIX_PADDING_MS = intEnv("VOICE_VAD_PREFIX_PADDING_MS", 300);
const VOICE_TURN_SILENCE_MS = intEnv("VOICE_TURN_SILENCE_MS", 1100, 300);

// In-memory per-org concurrency guard. Good enough for a single-instance
// Railway deployment; documented as a soft limit in CHANGES.txt.
const activeSessionsByOrg = new Map();

function safeSend(ws, payload) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  } catch (_) {
    /* ignore */
  }
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

function normalizeOpenAiVoice(value) {
  const v = String(value || "").trim().toLowerCase();
  return OPENAI_VOICES.has(v) ? v : "alloy";
}

function incrementOrgSessionCount(orgId) {
  const current = activeSessionsByOrg.get(orgId) || 0;
  activeSessionsByOrg.set(orgId, current + 1);
  return current + 1;
}

function decrementOrgSessionCount(orgId) {
  const current = activeSessionsByOrg.get(orgId) || 0;
  const next = Math.max(0, current - 1);
  if (next === 0) activeSessionsByOrg.delete(orgId);
  else activeSessionsByOrg.set(orgId, next);
}

async function loadAgentRow(db, orgId, agentId) {
  const strict = await db
    .from("voice_agents")
    .select("*")
    .eq("id", agentId)
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .maybeSingle();
  if (strict?.data) return strict.data;

  const scoped = await db
    .from("voice_agents")
    .select("*")
    .eq("id", agentId)
    .eq("organization_id", orgId)
    .maybeSingle();
  return scoped?.data || null;
}

async function recordWebcallSession(db, row) {
  try {
    await db.from("webcall_sessions").insert(row);
  } catch (err) {
    // This table is additive/optional — never let audit logging break a
    // live test session.
    console.warn(
      "[webcall-stream] webcall_sessions insert skipped:",
      err.message || String(err),
    );
  }
}

function realtimeSessionConfigForAgent({ systemPrompt, provider, voice }) {
  const turnDetection = {
    type: "server_vad",
    threshold: VOICE_VAD_THRESHOLD,
    prefix_padding_ms: VOICE_VAD_PREFIX_PADDING_MS,
    silence_duration_ms: VOICE_TURN_SILENCE_MS,
    create_response: true,
    interrupt_response: true,
  };

  const audioInput = {
    format: { type: "audio/pcm", rate: 24000 },
    turn_detection: turnDetection,
  };

  if (provider === "elevenlabs") {
    return {
      type: "session.update",
      session: {
        type: "realtime",
        instructions: systemPrompt,
        output_modalities: ["text"],
        audio: { input: audioInput },
      },
    };
  }

  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: systemPrompt,
      output_modalities: ["audio"],
      audio: {
        input: audioInput,
        output: {
          format: { type: "audio/pcm", rate: 24000 },
          voice: normalizeOpenAiVoice(voice),
        },
      },
    },
  };
}

async function handleWebcallStreamWS(browserWs, req) {
  const params = new URL(req.url || "", "http://localhost").searchParams;
  const token = params.get("token") || "";
  const startedAt = Date.now();

  const claims = verifyWebcallToken(token);
  if (!claims) {
    safeSend(browserWs, {
      type: "session.error",
      code: "AUTH_INVALID",
      message: "This test-call link has expired. Reopen the widget to try again.",
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
      message: "Voice testing is temporarily unavailable. Please try again shortly.",
    });
    try {
      browserWs.close(1011, "not_configured");
    } catch (_) {}
    return;
  }

  const db = getSupabase();

  // ── Credit gate — same wallet check a real call would hit ──
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

  // ── Concurrency guard ──
  const activeCount = activeSessionsByOrg.get(orgId) || 0;
  if (activeCount >= WEBCALL_MAX_CONCURRENT_PER_ORG) {
    safeSend(browserWs, {
      type: "session.error",
      code: "SESSION_LIMIT",
      message: "Only one live test call can run at a time. End the other session and try again.",
    });
    try {
      browserWs.close(4429, "concurrency_limit");
    } catch (_) {}
    return;
  }

  // ── Load the agent + build the exact prompt the phone pipeline uses ──
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

    // Same generic front-loading query twilio-media-stream.js uses for
    // inbound calls, so the agent walks in with the same FAQ/KB context.
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

  const systemPrompt =
    voiceContext?.systemPrompt ||
    agentRow.system_prompt ||
    agentRow.prompt ||
    "You are a helpful phone assistant for this business. Be concise, warm, and natural.";
  const provider = normalizeProvider(
    voiceContext?.debug?.agent?.voiceProvider || agentRow.voice_provider,
    "openai",
  );
  const greeting =
    voiceContext?.debug?.agent?.greeting ||
    agentRow.greeting ||
    "Hello! How can I help you today?";
  const agentName = agentRow.name || "Your Agent";

  incrementOrgSessionCount(orgId);

  const runtimeMeter = createRuntimeMeter({
    organizationId: orgId,
    userId: userId || null,
    voiceAgentId: agentId,
    route: "webcall_agent_test",
    externalId: `webcall:${agentId}:${startedAt}`,
    metadata: { provider, initiated_by: "talk_to_your_agent_widget" },
  });
  void runtimeMeter.start();

  let sessionEnded = false;
  let endReason = "unknown";
  let elevenLabsVoiceId = "";
  let elevenLabsModelId = "";

  if (provider === "elevenlabs") {
    try {
      const resolved = await resolveElevenLabsVoiceForAgent(db, agentRow);
      if (resolved?.ok && resolved.voice?.voiceId) {
        elevenLabsVoiceId = resolved.voice.voiceId;
        elevenLabsModelId = resolved.voice.modelId || "";
      }
    } catch (err) {
      console.warn(
        "[webcall-stream] ElevenLabs voice resolution failed, falling back to OpenAI voice:",
        err.message || String(err),
      );
    }
  }
  const useElevenLabs = provider === "elevenlabs" && Boolean(elevenLabsVoiceId);

  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  let openaiReady = false;
  let sessionTimer = null;
  let textBuffer = "";

  async function finishSession(reason) {
    if (sessionEnded) return;
    sessionEnded = true;
    endReason = reason;
    if (sessionTimer) clearTimeout(sessionTimer);
    decrementOrgSessionCount(orgId);
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
      if (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING) {
        openaiWs.close(1000);
      }
    } catch (_) {}
    safeSend(browserWs, { type: "session.ended", reason });
    try {
      if (browserWs.readyState === WebSocket.OPEN) browserWs.close(1000, reason);
    } catch (_) {}
  }

  async function speakWithElevenLabs(text) {
    const clean = cleanTextForSpeech(text);
    if (!clean) return;
    try {
      await streamElevenLabsSpeech({
        voiceId: elevenLabsVoiceId,
        modelId: elevenLabsModelId || undefined,
        text: clean,
        outputFormat: "pcm_24000",
        onAudioChunk: async (buffer) => {
          safeSend(browserWs, {
            type: "output_audio",
            audio: buffer.toString("base64"),
          });
        },
      });
    } catch (err) {
      console.warn(
        "[webcall-stream] ElevenLabs streaming failed:",
        err.message || String(err),
      );
    }
  }

  openaiWs.on("open", () => {
    const configEvent = realtimeSessionConfigForAgent({
      systemPrompt,
      provider: useElevenLabs ? "elevenlabs" : "openai",
      voice: voiceContext?.debug?.agent?.openai_voice || agentRow.openai_voice,
    });
    openaiWs.send(JSON.stringify(configEvent));

    // Fallback readiness timer in case session.updated never arrives.
    setTimeout(() => {
      if (!openaiReady) markReady("timeout");
    }, 1500);
  });

  function markReady(reason) {
    if (openaiReady) return;
    openaiReady = true;
    safeSend(browserWs, {
      type: "session.ready",
      agentName,
      greeting,
      voiceProvider: useElevenLabs ? "elevenlabs" : "openai",
    });
    // Prompt the agent to speak first, exactly as it would answering a
    // real inbound call.
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions:
            "Greet the caller now, warmly and naturally, exactly as you would when answering a real phone call.",
        },
      }),
    );
    sessionTimer = setTimeout(
      () => void finishSession("time_limit"),
      WEBCALL_MAX_SESSION_SECONDS * 1000,
    );
    if (typeof sessionTimer.unref === "function") sessionTimer.unref();
  }

  openaiWs.on("message", (raw) => {
    const event = safeJsonParse(raw);
    if (!event) return;
    const type = event.type || "";

    if (type === "session.updated" || type === "session.created") {
      markReady(type);
      return;
    }

    if (type === "error") {
      const message = event.error?.message || "Realtime session error.";
      console.warn("[webcall-stream] OpenAI error:", message);
      return;
    }

    if (
      type === "conversation.item.input_audio_transcription.completed" &&
      event.transcript
    ) {
      safeSend(browserWs, { type: "transcript.user", text: event.transcript });
      return;
    }

    // ── OpenAI-native audio branch ──
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

    // ── ElevenLabs branch: OpenAI produces text, ElevenLabs produces audio ──
    if (useElevenLabs && type === "response.text.delta" && event.delta) {
      textBuffer += event.delta;
      safeSend(browserWs, {
        type: "transcript.agent",
        text: textBuffer,
        partial: true,
      });
      return;
    }
    if (useElevenLabs && (type === "response.text.done" || type === "response.done")) {
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

  openaiWs.on("close", () => {
    if (!sessionEnded) void finishSession("openai_closed");
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
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: event.audio,
          }),
        );
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
