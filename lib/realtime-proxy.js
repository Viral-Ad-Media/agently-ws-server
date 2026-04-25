"use strict";

/**
 * lib/realtime-proxy.js
 *
 * OpenAI Realtime API proxy for the embedded chat widget.
 * NO Supabase needed — config comes from the widget on connection.
 */

const WebSocket = require("ws");

const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

const ALLOWED_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

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
      if (isBinary) return; // ignore audio before init
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

async function handleRealtimeProxy(browserWs, req) {
  const params = new URL(req.url || "", "http://localhost").searchParams;
  const chatbotId = params.get("chatbotId") || "unknown";
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();

  if (!apiKey) {
    safeSend(browserWs, {
      type: "error",
      message: "Server configuration error.",
    });
    browserWs.close(1011, "Server error");
    return;
  }

  console.log(`[realtime-proxy] New session chatbotId=${chatbotId}`);

  // Step 1: wait for session.init from widget (sent immediately on open)
  let systemPrompt =
    "You are a helpful voice assistant. Keep replies to 1-3 sentences.";
  let voice = "alloy";

  try {
    const init = await waitForInitMessage(browserWs);
    systemPrompt =
      init.systemPrompt && init.systemPrompt.trim()
        ? init.systemPrompt
        : systemPrompt;
    voice = ALLOWED_VOICES.includes(init.voice) ? init.voice : "alloy";
    console.log(
      `[realtime-proxy] Init ok — voice=${voice} promptLen=${systemPrompt.length}`,
    );
  } catch (e) {
    console.warn(`[realtime-proxy] ${e.message} — using defaults`);
  }

  // Step 2: open OpenAI Realtime WebSocket
  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  let openaiReady = false;
  const pendingAudio = [];

  openaiWs.on("open", () => {
    openaiReady = true;
    console.log(`[realtime-proxy] OpenAI connected chatbotId=${chatbotId}`);

    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          voice,
          instructions: systemPrompt,
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
          },
          temperature: 0.7,
          max_response_output_tokens: 150,
        },
      }),
    );

    safeSend(browserWs, { type: "session.ready", voice });

    // Flush any audio buffered while connecting
    pendingAudio.forEach((chunk) => {
      if (openaiWs.readyState === WebSocket.OPEN)
        openaiWs.send(chunk, { binary: true });
    });
    pendingAudio.length = 0;
  });

  // Step 3: relay OpenAI → Browser
  openaiWs.on("message", (data, isBinary) => {
    if (browserWs.readyState !== WebSocket.OPEN) return;
    browserWs.send(data, { binary: !!isBinary });

    if (!isBinary) {
      try {
        const ev = JSON.parse(data.toString());
        if (
          ev.type === "conversation.item.input_audio_transcription.completed"
        ) {
          console.log(
            `[RT][${chatbotId}] User: ${(ev.transcript || "").slice(0, 80)}`,
          );
        }
        if (ev.type === "response.audio_transcript.done") {
          console.log(
            `[RT][${chatbotId}] AI: ${(ev.transcript || "").slice(0, 80)}`,
          );
        }
        if (ev.type === "error") {
          console.error(`[RT] OpenAI error:`, JSON.stringify(ev.error));
        }
      } catch (_) {}
    }
  });

  openaiWs.on("error", (err) => {
    console.error("[realtime-proxy] OpenAI WS error:", err.message);
    safeSend(browserWs, { type: "error", message: "AI connection error." });
    try {
      browserWs.close();
    } catch (_) {}
  });

  openaiWs.on("close", (code) => {
    console.log(`[realtime-proxy] OpenAI closed code=${code}`);
    try {
      if (browserWs.readyState === WebSocket.OPEN) browserWs.close();
    } catch (_) {}
  });

  // Step 4: relay Browser → OpenAI
  browserWs.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!openaiReady) {
        pendingAudio.push(Buffer.from(data));
        return;
      }
      if (openaiWs.readyState === WebSocket.OPEN)
        openaiWs.send(data, { binary: true });
      return;
    }
    let ev;
    try {
      ev = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (ev.type === "session.init") return; // already handled
    if (ev.type === "session.end") {
      try {
        if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close(1000);
      } catch (_) {}
      return;
    }
    if (!openaiReady) return;
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(data);
  });

  browserWs.on("close", (code) => {
    console.log(`[realtime-proxy] Browser closed code=${code}`);
    try {
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close(1000);
    } catch (_) {}
  });

  browserWs.on("error", (err) => {
    console.error("[realtime-proxy] Browser WS error:", err.message);
    try {
      openaiWs.close();
    } catch (_) {}
  });
}

module.exports = { handleRealtimeProxy };
