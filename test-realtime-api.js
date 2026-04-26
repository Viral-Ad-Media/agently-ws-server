// TEST: OpenAI Realtime API Structure Validator
// Run: node test-realtime-api.js

const WebSocket = require("ws");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY not set");
  process.exit(1);
}

console.log("Testing OpenAI Realtime API connection...\n");

const ws = new WebSocket(
  "wss://api.openai.com/v1/realtime?model=gpt-realtime",
  {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  },
);

ws.on("open", () => {
  console.log("✅ WebSocket connected");

  // Test session.update with CORRECT MINIMAL GA API structure
  const sessionConfig = {
    type: "session.update",
    session: {
      type: "realtime",
      model: "gpt-realtime",
      instructions: "You are a helpful assistant.",
      audio: {
        input: {
          format: {
            type: "audio/pcm",
            rate: 24000,
          },
          transcription: {
            model: "whisper-1",
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
        },
        output: {
          format: {
            type: "audio/pcm",
            rate: 24000,
          },
          voice: "alloy",
        },
      },
    },
  };

  console.log("📤 Sending session.update...");
  ws.send(JSON.stringify(sessionConfig));
});

ws.on("message", (data) => {
  const event = JSON.parse(data.toString());
  console.log(`📨 Received: ${event.type}`);

  if (event.type === "session.updated") {
    console.log("✅ Session updated successfully!");
    console.log("   Model:", event.session.model);
    console.log("   Voice:", event.session.audio?.output?.voice || "N/A");
    ws.close();
    process.exit(0);
  }

  if (event.type === "error") {
    console.error("❌ Error:", event.error?.message || event.message);
    console.error("   Code:", event.error?.code || "unknown");
    ws.close();
    process.exit(1);
  }
});

ws.on("error", (err) => {
  console.error("❌ WebSocket error:", err.message);
  process.exit(1);
});

ws.on("close", () => {
  console.log("🔌 Connection closed");
});

setTimeout(() => {
  console.error("❌ Timeout - no response from API");
  ws.close();
  process.exit(1);
}, 10000);
