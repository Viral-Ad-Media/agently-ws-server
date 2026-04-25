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
    status: "ok",
    service: "agently-ws",
    ts: new Date().toISOString(),
    paths: {
      conversationRelay: "/ws",
      realtimeProxy: "/realtime",
    },
  }),
);

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
  } else if (url === "/realtime") {
    // Chat widget real-time voice mode (OpenAI Realtime API proxy)
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleRealtimeProxy(ws, request);
    });
  } else {
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
  console.log(`⚡  Widget RT:   wss://YOUR-DOMAIN/realtime\n`);
});

process.on("SIGTERM", () => {
  console.log("[WS] Shutting down…");
  server.close(() => process.exit(0));
});
