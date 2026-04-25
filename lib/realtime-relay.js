"use strict";

/**
 * ============================================================
 * lib/realtime-relay.js
 * ============================================================
 * OpenAI Realtime API bridge for Twilio ConversationRelay.
 *
 * WHY THIS EXISTS:
 *   The old flow: Twilio ConversationRelay → WS server calls
 *   GPT-4o-mini chat API → waits 2–4 seconds for full response.
 *
 *   New flow: Twilio ConversationRelay → WS server opens a
 *   PERSISTENT WebSocket to OpenAI Realtime API → text responses
 *   stream back in ~150–300ms first token (10–15x faster).
 *
 * HOW IT WORKS:
 *   Twilio ConversationRelay sends TEXT events (not audio).
 *   Twilio's own Deepgram integration handles STT.
 *   Twilio's own ElevenLabs/Google/Amazon integration handles TTS.
 *   This server only deals in text — but the Realtime API's
 *   text mode gives us much lower latency than a regular
 *   chat.completions call because the model streams word-by-word
 *   and the connection stays warm between turns.
 *
 * SESSIONS:
 *   One RealtimeSession per active call.
 *   The session opens once on call setup and stays alive until
 *   the call ends, so there is zero cold-start per turn.
 *
 * FALLBACK:
 *   If the Realtime API connection fails for any reason,
 *   the code falls back to the standard GPT-4o-mini streaming
 *   response (original behavior) so calls never fail silently.
 * ============================================================
 */

const WebSocket = require("ws");

const REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

// ─────────────────────────────────────────────────────────────
// RealtimeSession: one per active Twilio call.
// ─────────────────────────────────────────────────────────────
class RealtimeSession {
  constructor({ systemPrompt, onText, onDone, onError, apiKey }) {
    this.systemPrompt = systemPrompt;
    this.onText = onText; // called with each token
    this.onDone = onDone; // called when AI turn is complete
    this.onError = onError; // called on fatal error
    this.apiKey = apiKey || (process.env.OPENAI_API_KEY || "").trim();
    this.ws = null;
    this.ready = false;
    this.pendingQueue = []; // messages queued before session is ready
    this._buffer = ""; // accumulates tokens for the current turn
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(REALTIME_URL, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      this.ws = ws;
      const connectTimeout = setTimeout(
        () => reject(new Error("Realtime WS connect timeout")),
        8000,
      );

      ws.on("open", () => {
        clearTimeout(connectTimeout);
        // Configure the session with our system prompt + voice settings
        ws.send(
          JSON.stringify({
            type: "session.update",
            session: {
              modalities: ["text"], // text only — Twilio handles audio
              instructions: this.systemPrompt,
              temperature: 0.65,
              max_response_output_tokens: 200,
              turn_detection: null, // Twilio handles VAD — we drive manually
            },
          }),
        );
        this.ready = true;
        // Drain any messages queued while we were connecting
        this.pendingQueue.forEach((msg) => this._send(msg));
        this.pendingQueue = [];
        resolve();
      });

      ws.on("message", (raw) => {
        let event;
        try {
          event = JSON.parse(raw.toString());
        } catch {
          return;
        }

        this._handleEvent(event);
      });

      ws.on("error", (err) => {
        console.warn("[Realtime] WS error:", err.message);
        if (!this.ready) reject(err);
        if (this.onError) this.onError(err);
      });

      ws.on("close", (code, reason) => {
        console.log(`[Realtime] WS closed: ${code} ${reason}`);
        this.ready = false;
      });
    });
  }

  _handleEvent(event) {
    const { type } = event;

    // Stream text delta — send each token to Twilio immediately
    if (type === "response.text.delta") {
      const token = event.delta || "";
      if (token) {
        this._buffer += token;
        if (this.onText) this.onText(token);
      }
      return;
    }

    // AI turn complete
    if (type === "response.text.done") {
      const fullText = event.text || this._buffer;
      this._buffer = "";
      if (this.onDone) this.onDone(fullText);
      return;
    }

    // Response done (may arrive after text.done)
    if (type === "response.done") {
      return;
    }

    // Rate limit / error from OpenAI
    if (type === "error") {
      const msg = event.error?.message || "Realtime API error";
      console.error("[Realtime] API error:", msg, event.error?.code);
      if (this.onError) this.onError(new Error(msg));
      return;
    }
  }

  // Send a user message and trigger AI response
  send(userText) {
    const messages = [
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText }],
        },
      },
      {
        type: "response.create",
        response: { modalities: ["text"] },
      },
    ];

    if (!this.ready) {
      // Queue until session is ready (race on first message of call)
      messages.forEach((m) => this.pendingQueue.push(m));
    } else {
      messages.forEach((m) => this._send(m));
    }
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    this.ready = false;
    this.pendingQueue = [];
    this._buffer = "";
  }
}

// ─────────────────────────────────────────────────────────────
// Factory: create and connect a RealtimeSession for one call.
// Returns the session on success, null on failure (use fallback).
// ─────────────────────────────────────────────────────────────
async function createRealtimeSession({
  systemPrompt,
  onText,
  onDone,
  onError,
}) {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    console.warn(
      "[Realtime] OPENAI_API_KEY not set — skipping Realtime API, using fallback",
    );
    return null;
  }

  const session = new RealtimeSession({
    systemPrompt,
    onText,
    onDone,
    onError,
    apiKey,
  });
  try {
    await session.connect();
    console.log("[Realtime] Session connected ✅");
    return session;
  } catch (err) {
    console.warn(
      "[Realtime] Failed to connect, falling back to standard API:",
      err.message,
    );
    return null;
  }
}

module.exports = { RealtimeSession, createRealtimeSession };
