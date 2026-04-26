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

  safeSend(browserWs, { type: "session.connecting" });

  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  let openaiReady = false;
  let browserClosed = false;
  const pendingClientEvents = [];
  let readyTimer = null;

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

    if (ev.type === "error") {
      console.error(
        `[RT][${chatbotId}] OpenAI error:`,
        JSON.stringify(ev.error || ev),
      );
      safeSend(browserWs, {
        type: "error",
        error: ev.error || { message: "OpenAI Realtime API error" },
      });
      return;
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

  openaiWs.on("close", (code, reason) => {
    console.log(
      `[realtime-proxy] OpenAI closed code=${code} reason=${reason || ""}`,
    );
    if (readyTimer) clearTimeout(readyTimer);
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

  browserWs.on("close", (code) => {
    browserClosed = true;
    console.log(`[realtime-proxy] Browser closed code=${code}`);
    closeOpenAI(1000);
  });

  browserWs.on("error", (err) => {
    console.error("[realtime-proxy] Browser WS error:", err.message);
    closeOpenAI(1000);
  });
}

module.exports = { handleRealtimeProxy };
