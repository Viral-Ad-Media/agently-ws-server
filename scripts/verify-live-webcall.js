"use strict";
// Short live handshake using the user's existing test fixture. No user audio,
// appointment mutation, contact mutation, or email is sent. Usage is metered.
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const fixture = require("../../test-artifacts/gmail-calendar-20261008/state.json");
const mode = process.argv[2];
if (!["owner", "caller"].includes(mode)) throw new Error("Expected owner or caller mode");
const endpoint = process.argv[3];
if (!endpoint || new URL(endpoint).hostname !== "agently-calls.zxy7w9w65bv9y.us-east-1.cs.amazonlightsail.com") throw new Error("Unexpected test endpoint");
const token = jwt.sign({ purpose: "webcall", orgId: fixture.org, agentId: fixture.agent, userId: fixture.user, mode }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: 90 });
const ws = new WebSocket(`${endpoint}?token=${encodeURIComponent(token)}`);
let ready = false;
let audioBytes = 0;
let transcript = "";
let ending = false;
const timeout = setTimeout(() => { console.error("Live voice greeting timed out"); process.exitCode = 1; ws.terminate(); }, 40000);
function end() {
  if (ending) return;
  ending = true;
  ws.send(JSON.stringify({ type: "session.end" }));
  setTimeout(() => ws.close(), 3000).unref();
}
ws.on("message", (raw) => {
  const message = JSON.parse(raw);
  if (message.type === "session.ready") ready = true;
  if (message.type === "output_audio") audioBytes += Buffer.from(message.audio, "base64").length;
  if (message.type === "transcript.agent" && !message.partial) {
    transcript = message.text;
    end();
  }
  if (message.type === "session.error") { console.error(message.code, message.message); process.exitCode = 1; end(); }
  if (message.type === "session.ended") ws.close();
});
ws.on("error", (err) => { console.error(err.message); process.exitCode = 1; });
ws.on("close", () => {
  clearTimeout(timeout);
  console.log(JSON.stringify({ mode, ready, audioBytes, greeting: transcript }));
  if (!ready || !audioBytes || !transcript) process.exitCode = 1;
});
