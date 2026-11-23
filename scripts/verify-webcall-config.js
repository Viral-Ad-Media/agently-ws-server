"use strict";
// Read-only provider handshake. No audio, response generation or business writes.
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const WebSocket = require("ws");
const { _internals } = require("../lib/webcall-stream");
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error("OPENAI_API_KEY is not configured");
const ws = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", { headers: { Authorization: `Bearer ${key}` } });
let owner = false;
let completed = false;
const timer = setTimeout(() => { console.error("Realtime configuration check timed out"); ws.terminate(); process.exitCode = 1; }, 20000);
function update() {
  ws.send(JSON.stringify(_internals.openAiSessionConfig({ systemPrompt: "Configuration verification only. Do not speak.", voice: "alloy", textOnly: false, enableCalendarTools: true, enableOwnerTools: owner, transcriptionLanguage: "en" })));
}
ws.on("open", update);
ws.on("message", (raw) => {
  const event = JSON.parse(raw);
  if (event.type === "error") { console.error("Configuration rejected:", event.error?.code, event.error?.message); process.exitCode = 1; clearTimeout(timer); ws.close(); }
  if (event.type !== "session.updated") return;
  console.log(JSON.stringify({ mode: owner ? "owner" : "caller", accepted: true, transcription: event.session.audio?.input?.transcription?.model, noiseReduction: event.session.audio?.input?.noise_reduction?.type, tools: event.session.tools?.map((t) => t.name) }));
  if (!owner) { owner = true; update(); } else { completed = true; clearTimeout(timer); ws.close(); }
});
ws.on("error", (err) => { console.error(err.message); clearTimeout(timer); process.exitCode = 1; });
ws.on("close", () => { clearTimeout(timer); if (!completed) process.exitCode = 1; });
