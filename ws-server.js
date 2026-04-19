"use strict";

try {
  require("dotenv").config();
} catch (_) {}

const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const { handleConversationRelayWS } = require("./lib/conversation-relay");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 8080;

app.get("/health", (_req, res) =>
  res.json({
    status: "ok",
    service: "agently-ws",
    ts: new Date().toISOString(),
  }),
);
app.get("/", (_req, res) =>
  res.json({ service: "Agently ConversationRelay WS Server" }),
);

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const url = request.url || "";
  if (url.startsWith("/ws") || url.startsWith("/api/twilio/ws")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleConversationRelayWS(ws, request);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`\n🔌 Agently WS Server running on port ${PORT}`);
  console.log(`📡 Health: http://localhost:${PORT}/health`);
  console.log(`🎙️  ConversationRelay: wss://YOUR-DOMAIN/ws\n`);
});
