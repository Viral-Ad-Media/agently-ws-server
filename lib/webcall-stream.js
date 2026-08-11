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

function mapVoiceToOpenAi(voiceProfile) {
  const configuredDefault = normalizeVoiceName(
    process.env.OPENAI_REALTIME_VOICE || "alloy",
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
function openAiSessionConfig({ systemPrompt, voice, textOnly }) {
  const session = {
    type: "realtime",
    model: "gpt-realtime",
    instructions: systemPrompt,
    output_modalities: textOnly ? ["text"] : ["audio"],
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
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

  const claims = verifyWebcallToken(token);
  if (!claims) {
    safeSend(browserWs, {
      type: "session.error",
      code: "AUTH_INVALID",
      message: "This call link has expired. Reopen the widget to try again.",
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

  // Map the dashboard voice name to a real OpenAI voice. THIS is what
  // prevents the immediate 0:00 hangup for OpenAI-voice agents.
  const openAiVoice = mapVoiceToOpenAi(
    voiceContext?.debug?.agent?.openai_voice ||
      agentRow.openai_voice ||
      agentRow.voice,
  );

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
