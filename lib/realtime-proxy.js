"use strict";

/**
 * lib/realtime-proxy.js
 *
 * Browser widget <-> Agently WS server <-> OpenAI Realtime API proxy.
 *
 * The browser sends JSON client events containing Base64 PCM16 audio chunks.
 * OpenAI also returns JSON events containing Base64 PCM16 audio deltas. Do not
 * expect binary frames from OpenAI here.
 */

const WebSocket = require("ws");
const { getSupabase } = require("./supabase");
const { logOpenAIUsage } = require("./usage-ledger");
const { createRuntimeMeter } = require("./runtime-meter");

const OPENAI_REALTIME_URL =
  process.env.OPENAI_REALTIME_URL ||
  "wss://api.openai.com/v1/realtime?model=gpt-realtime";

const ALLOWED_VOICES = new Set([
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

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch (_) {}
}

function waitForInitMessage(ws) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeListener("message", handler);
      reject(new Error("session.init timeout after 5s"));
    }, 5000);

    function handler(data, isBinary) {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "session.init") {
          clearTimeout(timeout);
          ws.removeListener("message", handler);
          resolve(msg);
        }
      } catch (_) {}
    }

    ws.on("message", handler);
  });
}

function normalizeVoice(value) {
  const v = String(value || "alloy")
    .trim()
    .toLowerCase();
  return ALLOWED_VOICES.has(v) ? v : "alloy";
}

function realtimeUsageFromEvent(event) {
  return event?.response?.usage || event?.usage || null;
}

function realtimeResponseId(event) {
  return event?.response?.id || event?.response_id || event?.id || null;
}

async function loadChatbotOwner(chatbotId) {
  if (!chatbotId || chatbotId === "unknown") return null;
  try {
    const db = getSupabase();
    const { data } = await db
      .from("chatbots")
      .select("id,organization_id,knowledge_base_id")
      .eq("id", chatbotId)
      .maybeSingle();
    return data || null;
  } catch (err) {
    console.warn(
      "[realtime-proxy] chatbot owner lookup skipped",
      err.message || String(err),
    );
    return null;
  }
}

function realtimeSessionConfig({ systemPrompt, voice }) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      model: "gpt-realtime",
      instructions: systemPrompt,
      output_modalities: ["audio"],
      audio: {
        input: {
          format: {
            type: "audio/pcm",
            rate: 24000,
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 650,
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          format: {
            type: "audio/pcm",
            rate: 24000,
          },
          voice,
        },
      },
    },
  };
}

async function handleRealtimeProxy(browserWs, req) {
  const params = new URL(req.url || "", "http://localhost").searchParams;
  const chatbotId = params.get("chatbotId") || "unknown";
  let organizationId =
    params.get("organizationId") || params.get("orgId") || "";
  let knowledgeBaseId = params.get("knowledgeBaseId") || "";
  const startedAt = Date.now();
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();

  if (!apiKey) {
    safeSend(browserWs, {
      type: "error",
      error: {
        message: "OPENAI_API_KEY is not configured on the voice server.",
      },
    });
    browserWs.close(1011, "Server configuration error");
    return;
  }

  console.log(`[realtime-proxy] New session chatbotId=${chatbotId}`);

  if (!organizationId && chatbotId !== "unknown") {
    const owner = await loadChatbotOwner(chatbotId);
    organizationId = owner?.organization_id || "";
    knowledgeBaseId = knowledgeBaseId || owner?.knowledge_base_id || "";
  }

  let systemPrompt =
    "You are a helpful voice assistant. Keep replies to 1-3 short sentences.";
  let voice = "alloy";

  try {
    const init = await waitForInitMessage(browserWs);
    if (init.systemPrompt && String(init.systemPrompt).trim()) {
      systemPrompt = String(init.systemPrompt).trim().slice(0, 12000);
    }
    voice = normalizeVoice(init.voice);
    console.log(
      `[realtime-proxy] Init ok voice=${voice} promptLen=${systemPrompt.length}`,
    );
  } catch (e) {
    console.warn(`[realtime-proxy] ${e.message}; using defaults`);
  }

  // Ground voice mode in the SAME knowledge the text chatbot uses.
  //
  // The prompt above is assembled in the browser from the agent name, the
  // languages and at most 8 FAQs — no website pages, no uploaded PDFs, no
  // custom prompt. That is why the voice conversation knew far less than the
  // text chat on the identical chatbot. The server already knows which
  // chatbot this is, so it can build the real thing instead of trusting a
  // thin client-side summary. The client prompt stays as the fallback if
  // retrieval fails, so a knowledge problem never costs us the call.
  if (chatbotId && chatbotId !== "unknown") {
    try {
      const { loadChatbotContext, buildAssistantPrompt } = require("./call-intelligence");
      const context = await loadChatbotContext(chatbotId, "");
      const grounded = buildAssistantPrompt({ context, message: "" });
      if (grounded && grounded.trim().length > systemPrompt.length) {
        systemPrompt = [
          grounded.trim(),
          "",
          "VOICE: this is a spoken conversation. Keep every reply to 1-3 short sentences.",
          "Never use bullet points, markdown, or read URLs aloud — offer to send a link instead.",
        ]
          .join("\n")
          .slice(0, 12000);
        console.log(
          `[realtime-proxy] grounded voice prompt chatbot=${chatbotId} chunks=${context?.stats?.chunks ?? 0} faqs=${context?.stats?.faqs ?? 0} promptLen=${systemPrompt.length}`,
        );
      }
      if (context?.stats?.knowledgeEmpty) {
        console.warn(
          `[realtime-proxy] chatbot ${chatbotId} has an EMPTY knowledge base — voice replies will be generic`,
        );
      }
    } catch (err) {
      console.warn(
        "[realtime-proxy] could not ground voice prompt, using client prompt:",
        err?.message || err,
      );
    }
  }

  let audioDeltaCount = 0;
  safeSend(browserWs, { type: "session.connecting" });

  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  let openaiReady = false;
  let browserClosed = false;
  let activeResponseId = null;
  const pendingClientEvents = [];
  let readyTimer = null;
  const runtimeMeter = createRuntimeMeter({
    organizationId: organizationId || null,
    chatbotId: chatbotId !== "unknown" ? chatbotId : null,
    route: "browser_realtime_proxy",
    externalId: `${chatbotId}:realtime:${startedAt}`,
    metadata: {
      knowledge_base_id: knowledgeBaseId || null,
    },
  });
  void runtimeMeter.start();
  let runtimeLogged = false;

  async function logRuntimeOnce(reason) {
    if (runtimeLogged) return;
    runtimeLogged = true;
    await runtimeMeter.finish(reason || "session_closed");
  }

  function closeOpenAI(code = 1000) {
    try {
      if (
        openaiWs.readyState === WebSocket.OPEN ||
        openaiWs.readyState === WebSocket.CONNECTING
      ) {
        openaiWs.close(code);
      }
    } catch (_) {}
  }

  function flushPending() {
    if (!openaiReady || openaiWs.readyState !== WebSocket.OPEN) return;
    while (pendingClientEvents.length)
      openaiWs.send(pendingClientEvents.shift());
  }

  function markReadyOnce(reason) {
    if (openaiReady) return;
    openaiReady = true;
    if (readyTimer) clearTimeout(readyTimer);
    console.log(
      `[realtime-proxy] OpenAI ready (${reason}) chatbotId=${chatbotId}`,
    );
    safeSend(browserWs, { type: "session.ready", voice });
    flushPending();
  }

  openaiWs.on("open", () => {
    console.log(`[realtime-proxy] OpenAI connected chatbotId=${chatbotId}`);
    openaiWs.send(
      JSON.stringify(realtimeSessionConfig({ systemPrompt, voice })),
    );

    // If OpenAI does not echo session.updated quickly, still allow audio to flow.
    readyTimer = setTimeout(() => markReadyOnce("timeout"), 1200);
  });

  openaiWs.on("message", (data, isBinary) => {
    if (browserWs.readyState !== WebSocket.OPEN) return;

    if (isBinary) {
      browserWs.send(data, { binary: true });
      return;
    }

    const text = data.toString();
    let ev;
    try {
      ev = JSON.parse(text);
    } catch (_) {
      browserWs.send(text);
      return;
    }

    if (ev.type === "session.updated" || ev.type === "session.created") {
      markReadyOnce(ev.type);
    }

    // Voice mode reported "connecting, then listening, then silence" with
    // nothing in the logs to say why. Count what actually crosses the wire so
    // the next occurrence is diagnosable rather than guesswork: no audio
    // deltas means OpenAI never spoke, deltas with no sound means the browser
    // failed to play them, and the two need completely different fixes.
    if (ev.type === "response.output_audio.delta" || ev.type === "response.audio.delta") {
      audioDeltaCount += 1;
      if (audioDeltaCount === 1) {
        console.log(`[realtime-proxy] first audio delta chatbot=${chatbotId}`);
      }
    } else if (ev.type === "response.done") {
      console.log(
        `[realtime-proxy] response.done chatbot=${chatbotId} audioDeltas=${audioDeltaCount}`,
      );
      if (audioDeltaCount === 0) {
        console.warn(
          `[realtime-proxy] response produced NO audio chatbot=${chatbotId} — check output_modalities and voice`,
        );
      }
      audioDeltaCount = 0;
    }

    if (ev.type === "error") {
      const err = ev.error || ev;
      const errMsg = String(err.message || err.code || "");
      // Recoverable interruption race: OpenAI returns this when response.cancel
      // is sent after the active response has already finished.
      if (/no active response found|cancellation failed/i.test(errMsg)) {
        activeResponseId = null;
        console.warn(
          `[RT][${chatbotId}] Ignoring benign cancel race: ${errMsg}`,
        );
        return;
      }
      console.error(`[RT][${chatbotId}] OpenAI error:`, JSON.stringify(err));
      safeSend(browserWs, {
        type: "error",
        error: err || { message: "OpenAI Realtime API error" },
      });
      return;
    }

    if (ev.type === "response.created") {
      activeResponseId = ev.response && ev.response.id ? ev.response.id : true;
    }
    if (ev.type === "response.done") {
      activeResponseId = null;
      const usage = realtimeUsageFromEvent(ev);
      logOpenAIUsage({
        organizationId: organizationId || null,
        service: "realtime_call",
        eventType: usage
          ? "openai_realtime_tokens"
          : "openai_realtime_usage_missing",
        model: "gpt-realtime",
        usage: usage || {},
        inputTokens: usage ? undefined : 0,
        outputTokens: usage ? undefined : 0,
        chatbotId: chatbotId !== "unknown" ? chatbotId : null,
        knowledgeBaseId: knowledgeBaseId || null,
        externalId:
          realtimeResponseId(ev) || `${chatbotId}:response:${Date.now()}`,
        metadata: {
          exact_usage: Boolean(usage),
          usage_missing: !usage,
          route: "browser_realtime_proxy",
          response_status: ev.response?.status || null,
        },
      }).catch((err) => {
        console.warn(
          "[usage-ledger] realtime OpenAI usage log skipped",
          err.message || String(err),
        );
      });
    }

    browserWs.send(text);

    if (ev.type === "conversation.item.input_audio_transcription.completed") {
      console.log(
        `[RT][${chatbotId}] User: ${(ev.transcript || "").slice(0, 80)}`,
      );
    }
    if (
      ev.type === "response.output_audio_transcript.done" ||
      ev.type === "response.audio_transcript.done"
    ) {
      console.log(
        `[RT][${chatbotId}] AI: ${(ev.transcript || "").slice(0, 80)}`,
      );
    }
  });

  openaiWs.on("error", (err) => {
    console.error("[realtime-proxy] OpenAI WS error:", err.message);
    safeSend(browserWs, {
      type: "error",
      error: {
        message:
          "Could not connect to OpenAI Realtime. Check your API key and model access.",
      },
    });
    try {
      browserWs.close(1011, "OpenAI connection error");
    } catch (_) {}
  });

  openaiWs.on("close", async (code, reason) => {
    console.log(
      `[realtime-proxy] OpenAI closed code=${code} reason=${reason || ""}`,
    );
    if (readyTimer) clearTimeout(readyTimer);
    await logRuntimeOnce(`openai_close_${code}`);
    if (!browserClosed && browserWs.readyState === WebSocket.OPEN) {
      try {
        browserWs.close(code === 1000 ? 1000 : 1011);
      } catch (_) {}
    }
  });

  browserWs.on("message", (data, isBinary) => {
    if (isBinary) return;

    let ev;
    try {
      ev = JSON.parse(data.toString());
    } catch (_) {
      return;
    }

    if (ev.type === "session.init") return;
    if (ev.type === "response.cancel" && !activeResponseId) {
      // Drop stale browser cancel requests. Otherwise OpenAI returns:
      // "Cancellation failed: no active response found".
      return;
    }
    if (ev.type === "session.end") {
      closeOpenAI(1000);
      return;
    }

    const payload = JSON.stringify(ev);
    if (!openaiReady || openaiWs.readyState !== WebSocket.OPEN) {
      pendingClientEvents.push(payload);
      if (pendingClientEvents.length > 300) pendingClientEvents.shift();
      return;
    }

    openaiWs.send(payload);
  });

  browserWs.on("close", async (code) => {
    browserClosed = true;
    console.log(`[realtime-proxy] Browser closed code=${code}`);
    await logRuntimeOnce(`browser_close_${code}`);
    closeOpenAI(1000);
  });

  browserWs.on("error", (err) => {
    console.error("[realtime-proxy] Browser WS error:", err.message);
    closeOpenAI(1000);
  });
}

module.exports = { handleRealtimeProxy };
