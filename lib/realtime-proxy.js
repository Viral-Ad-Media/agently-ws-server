"use strict";

/**
 * lib/realtime-proxy.js
 *
 * OpenAI Realtime API proxy for the embedded chat widget.
 * NO Supabase needed — config comes from the widget on connection.
 *
 * UPDATED: April 2026 - Compatible with latest GA Realtime API
 *
 * CHANGES FROM PREVIOUS VERSION:
 * - Updated model to gpt-4o-realtime-preview-2024-12-17 (GA stable)
 * - Removed deprecated "type: realtime" field from session config
 * - Updated audio transcription model name
 * - Updated voice options to include new GA voices
 * - Simplified session configuration structure
 * - FIX: Added `type: "realtime"` inside the session object for audio+text
 */

const WebSocket = require("ws");

// GA Realtime API — updated model (April 2026)
// Docs: https://platform.openai.com/docs/guides/realtime
const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

// GA voices (April 2026): alloy, ash, ballad, cedar, coral, echo, marin, sage, shimmer, verse
const ALLOWED_VOICES = [
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
];

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
      // NOTE: OpenAI-Beta header removed - not needed for GA API
    },
  });

  let openaiReady = false;
  const pendingAudio = [];

  openaiWs.on("open", () => {
    openaiReady = true;
    console.log(`[realtime-proxy] OpenAI connected chatbotId=${chatbotId}`);

    // Updated session configuration for GA API (April 2026)
    // IMPORTANT: `session.type = "realtime"` is now required for audio+text modalities.
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime", // <-- FIX: missing required parameter
          modalities: ["audio", "text"],
          voice,
          instructions: systemPrompt,
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          input_audio_transcription: {
            model: "whisper-1",
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
          },
          temperature: 0.7,
          max_response_output_tokens: 500,
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
          // Forward the error to the widget so the user sees what went wrong
          safeSend(browserWs, {
            type: "error",
            message: ev.error?.message || "OpenAI error",
          });
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
