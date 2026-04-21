'use strict';

/**
 * ws-server.js  –  Standalone ConversationRelay WebSocket Server
 *
 * Deploy this on Railway, Render, or Fly.io (NOT Vercel).
 * Vercel serverless cannot hold persistent WebSocket connections.
 *
 * This tiny server does ONE job: handle Twilio ConversationRelay
 * WebSocket sessions, stream OpenAI responses, and save call records.
 *
 * All REST API routes (phone number search, billing, etc.)
 * remain on Vercel as serverless functions.
 *
 * SETUP:
 *   1. Copy this file + the /lib folder to a new Railway project
 *   2. Set env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *                    OPENAI_API_KEY, API_URL (this server's public URL)
 *   3. Deploy: railway up
 *   4. Point TWILIO_WS_URL env var on Vercel backend to this server's wss:// URL
 *
 * HOW IT FITS:
 *   Twilio inbound call → Vercel /api/twilio/voice-inbound (returns TwiML)
 *     └─ TwiML contains: <ConversationRelay url="wss://THIS-SERVER/ws?..." />
 *   Twilio opens WS → THIS SERVER handles the live session
 *   Call ends → THIS SERVER saves record to Supabase
 *
 * COST ESTIMATE (Railway Hobby):
 *   ~$5-7/mo for always-on Node process. Scales to ~100 concurrent calls.
 */

try { require('dotenv').config(); } catch (_) {}

const http    = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { handleConversationRelayWS } = require('./lib/conversation-relay');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 8080;

// ── Health endpoint (Railway/Render uses this) ────────────────
app.get('/health', (_req, res) => res.json({
  status: 'ok',
  service: 'agently-ws',
  ts: new Date().toISOString(),
}));

app.get('/', (_req, res) => res.json({ service: 'Agently ConversationRelay WS Server' }));

// ── WebSocket server ──────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = request.url || '';
  if (url.startsWith('/ws') || url.startsWith('/api/twilio/ws')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleConversationRelayWS(ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (_ws) => {
  console.log(`[WS] Active sessions: ${wss.clients.size}`);
});

// ── Start ─────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🔌 Agently WS Server running on port ${PORT}`);
  console.log(`📡 Health: http://localhost:${PORT}/health`);
  console.log(`🎙️  ConversationRelay: wss://YOUR-DOMAIN/ws\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[WS] SIGTERM received, closing server…');
  server.close(() => process.exit(0));
});
