"use strict";

/**
 * ws-server.js  –  Agently WebSocket Server (Railway)
 *
 * Handles two WebSocket paths:
 *   /ws        → Twilio ConversationRelay (voice calls)
 *   /realtime  → OpenAI Realtime API proxy (chat widget voice mode)
 *
 * The /realtime path replaces the old 3-step pipeline:
 *   OLD: Whisper (~800ms) + GPT (~1.5s) + TTS (~600ms) = ~3-5s per turn
 *   NEW: OpenAI Realtime API proxy = <500ms first audio, sub-second turns
 */

try {
  require("dotenv").config();
} catch (_) {}

const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const { handleConversationRelayWS } = require("./lib/conversation-relay");
const { handleRealtimeProxy } = require("./lib/realtime-proxy");
const {
  handleTwilioMediaStreamWS,
  loadTwilioAgentContextForDebug,
  loadCallMessageDebug,
  loadCallRecordDebug,
  dedupeCallMessage,
} = require("./lib/twilio-media-stream");

// Scheduler — exports startLeadScheduler / executeDueSchedules
let executeDueSchedules = null;
try {
  const scheduler = require("./lib/scheduler");
  executeDueSchedules =
    scheduler.executeDueSchedules || scheduler.startLeadScheduler || null;
} catch (e) {
  console.warn("[WS] Scheduler not available:", e.message);
}

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 8080;

// ── Health endpoint ───────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    status: "ok",
    service: "agently-ws",
    ts: new Date().toISOString(),
    paths: {
      conversationRelay: "/ws",
      twilioMediaStream: "/api/twilio/media-stream",
      realtimeProxy: "/realtime",
    },
    voiceProviders: {
      default: process.env.VOICE_PROVIDER_DEFAULT || "openai",
      fallback: process.env.VOICE_PROVIDER_FALLBACK || "openai",
      elevenLabsConfigured: Boolean(
        (process.env.ELEVENLABS_API_KEY || "").trim(),
      ),
      elevenLabsDefaultModel:
        process.env.ELEVENLABS_DEFAULT_MODEL || "eleven_flash_v2_5",
      elevenLabsTwilioOutputFormat:
        process.env.ELEVENLABS_TWILIO_OUTPUT_FORMAT || "ulaw_8000",
    },
  }),
);

app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    status: "ok",
    service: "agently-ws",
    ts: new Date().toISOString(),
    paths: {
      conversationRelay: "/ws",
      twilioMediaStream: "/api/twilio/media-stream",
      realtimeProxy: "/realtime",
    },
    voiceProviders: {
      default: process.env.VOICE_PROVIDER_DEFAULT || "openai",
      fallback: process.env.VOICE_PROVIDER_FALLBACK || "openai",
      elevenLabsConfigured: Boolean(
        (process.env.ELEVENLABS_API_KEY || "").trim(),
      ),
      elevenLabsDefaultModel:
        process.env.ELEVENLABS_DEFAULT_MODEL || "eleven_flash_v2_5",
      elevenLabsTwilioOutputFormat:
        process.env.ELEVENLABS_TWILIO_OUTPUT_FORMAT || "ulaw_8000",
    },
  }),
);

function requireDebugToken(req, res) {
  const expectedToken = (process.env.DEBUG_CONTEXT_TOKEN || "").trim();
  const providedToken = String(
    req.query.token ||
      req.get("x-debug-context-token") ||
      req.get("authorization")?.replace(/^Bearer\s+/i, "") ||
      "",
  ).trim();

  if (!expectedToken) {
    res.status(404).json({ ok: false, error: "Debug endpoint is disabled." });
    return false;
  }
  if (providedToken !== expectedToken) {
    res.status(401).json({ ok: false, error: "Unauthorized." });
    return false;
  }
  return true;
}

app.get("/debug/agent-context", async (req, res) => {
  if (!requireDebugToken(req, res)) return;

  const orgId = String(
    req.query.orgId || req.query.organizationId || "",
  ).trim();
  const agentId = String(
    req.query.agentId || req.query.voiceAgentId || "",
  ).trim();
  if (!orgId || !agentId) {
    return res
      .status(400)
      .json({ ok: false, error: "orgId and agentId are required." });
  }

  try {
    const context = await loadTwilioAgentContextForDebug({ orgId, agentId });
    return res.json({ ok: true, ...context });
  } catch (err) {
    console.error("[debug/agent-context] failed:", err.message);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to load agent context." });
  }
});

app.get("/debug/call-message", async (req, res) => {
  if (!requireDebugToken(req, res)) return;
  const callSid = String(req.query.callSid || "").trim();
  if (!callSid) {
    return res.status(400).json({ ok: false, error: "callSid is required." });
  }
  try {
    const result = await loadCallMessageDebug(callSid);
    return res.json(result);
  } catch (err) {
    console.error("[debug/call-message] failed:", err.message);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to load call message debug details." });
  }
});

app.get("/debug/call-record", async (req, res) => {
  if (!requireDebugToken(req, res)) return;
  const callSid = String(req.query.callSid || "").trim();
  if (!callSid) {
    return res.status(400).json({ ok: false, error: "callSid is required." });
  }
  try {
    const result = await loadCallRecordDebug(callSid);
    return res.json(result);
  } catch (err) {
    console.error("[debug/call-record] failed:", err.message);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to load call record debug details." });
  }
});

app.post("/debug/dedupe-call-message", async (req, res) => {
  if (!requireDebugToken(req, res)) return;
  const callSid = String(req.query.callSid || "").trim();
  if (!callSid) {
    return res.status(400).json({ ok: false, error: "callSid is required." });
  }
  try {
    const result = await dedupeCallMessage(callSid);
    return res.json(result);
  } catch (err) {
    console.error("[debug/dedupe-call-message] failed:", err.message);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to dedupe call message leads." });
  }
});

app.get("/", (_req, res) =>
  res.json({ service: "Agently WS Server — /ws + /realtime" }),
);

// ── WebSocket server (handles both paths) ────────────────────
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = (request.url || "").split("?")[0];

  if (url === "/ws" || url === "/api/twilio/ws") {
    // Twilio ConversationRelay voice calls
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleConversationRelayWS(ws, request);
    });
  } else if (
    url === "/api/twilio/media-stream" ||
    url === "/media-stream" ||
    url === "/twilio/media-stream"
  ) {
    // Twilio <Connect><Stream> media stream calls.
    // Do not require browser JWT/auth here: Twilio connects directly.
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleTwilioMediaStreamWS(ws, request);
    });
  } else if (url === "/realtime") {
    // Chat widget real-time voice mode (OpenAI Realtime API proxy)
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleRealtimeProxy(ws, request);
    });
  } else {
    console.warn(`[WS] Rejected websocket upgrade path: ${url || "<empty>"}`);
    socket.destroy();
  }
});

wss.on("connection", () => {
  console.log(`[WS] Active sessions: ${wss.clients.size}`);
});

// ── Start lead scheduler (if enabled) ────────────────────────
if (process.env.ENABLE_LEAD_SCHEDULER === "true" && executeDueSchedules) {
  try {
    const intervalMs = parseInt(
      process.env.LEAD_SCHEDULER_INTERVAL_MS || "60000",
      10,
    );
    setInterval(() => {
      void executeDueSchedules();
    }, intervalMs);
    console.log(`[WS] Lead scheduler started (every ${intervalMs / 1000}s)`);
  } catch (e) {
    console.warn("[WS] Lead scheduler failed to start:", e.message);
  }
}

// ── Start per-number billing tracker ─────────────────────────
// Runs every 30 seconds here on Railway (always-on process).
// Replaces Vercel Cron (which requires paid plan for sub-daily jobs).
// Copy agently-server/lib/billing-tracker.js into this project's lib/ folder.
// NEVER exposed to users — backend-only internal cost tracking.
try {
  const bt = require("./lib/billing-tracker");
  if (typeof bt.start === "function") {
    bt.start();
    console.log("[WS] Billing tracker started (every 30s)");
  } else {
    console.warn("[WS] billing-tracker has no start() export — skipping");
  }
} catch (e) {
  console.warn(
    "[WS] Billing tracker not available (copy billing-tracker.js to lib/):",
    e.message,
  );
}

// ── Start ─────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🔌 Agently WS Server on port ${PORT}`);
  console.log(`📡 Health:     http://localhost:${PORT}/health`);
  console.log(`🎙️  Voice calls: wss://YOUR-DOMAIN/ws`);
  console.log(`📞  Twilio Stream: wss://YOUR-DOMAIN/api/twilio/media-stream`);
  console.log(`⚡  Widget RT:   wss://YOUR-DOMAIN/realtime\n`);
});

process.on("SIGTERM", () => {
  console.log("[WS] Shutting down…");
  server.close(() => process.exit(0));
});
