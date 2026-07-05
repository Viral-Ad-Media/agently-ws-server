#!/usr/bin/env node
"use strict";

/**
 * diagnose-rate-cards.js  (agently-ws-server)
 *
 * Explains WHY live-call rows were written with cost = 0. Run it with the
 * SAME environment the WS server runs with (locally: `node diagnose-rate-cards.js`;
 * on Railway: run it as a one-off on the service).
 *
 * It prints, for each provider, whether the *_RATE_CARD_JSON env var is
 * present, parses, and contains an entry for the event types the runtime
 * actually writes. If any say MISSING, that is the reason cost was 0 for
 * that provider in the live runtime.
 *
 * NOTE: after installing billing_autopricing_trigger.sql, pricing is done in
 * the database and no longer depends on these env vars — so this is now a
 * diagnostic/optimization aid, not a blocker.
 */

try {
  require("dotenv").config();
} catch (_) {}

const ENV_KEYS = [
  "OPENAI_RATE_CARD_JSON",
  "ELEVENLABS_RATE_CARD_JSON",
  "RAILWAY_RATE_CARD_JSON",
  "SUPABASE_RATE_CARD_JSON",
  "TWILIO_RATE_CARD_JSON",
  "RESEND_RATE_CARD_JSON",
  "VENDOR_RATE_CARD_JSON",
];

// Event types the live runtime writes as billable, that MUST have a rate.
const REQUIRED = [
  ["openai", "realtime", "text_input_tokens", "tokens"],
  ["openai", "realtime", "audio_input_tokens", "tokens"],
  ["openai", "realtime", "text_output_tokens", "tokens"],
  ["openai", "realtime", "audio_output_tokens", "tokens"],
  ["openai", "realtime", "cached_text_input_tokens", "tokens"],
  ["openai", "realtime", "openai_realtime_blended_tokens", "tokens"],
  ["elevenlabs", "voice", "tts_or_agent_voice", "characters"],
  ["railway", "runtime", "websocket_runtime", "seconds"],
];

function buildIndex() {
  const index = new Map();
  const present = {};
  for (const key of ENV_KEYS) {
    const raw = process.env[key];
    present[key] = Boolean(raw);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const k = [
          row.provider || "*",
          row.service || "*",
          row.eventType || row.event_type || "*",
          row.unit || "*",
        ]
          .join("|")
          .toLowerCase();
        index.set(k, Number(row.unitCostUsd ?? row.unit_cost_usd ?? 0));
      }
    } catch (e) {
      console.log(`  ⚠ ${key} is set but does NOT parse as JSON: ${e.message}`);
    }
  }
  return { index, present };
}

console.log("=".repeat(66));
console.log("Rate card env diagnostic (agently-ws-server)");
console.log("=".repeat(66));

const { index, present } = buildIndex();

console.log("\nEnv vars present on THIS process:");
for (const key of ENV_KEYS) {
  console.log(`  ${present[key] ? "SET    " : "MISSING"}  ${key}`);
}

console.log("\nRequired billable event types -> rate found?");
let missing = 0;
for (const [p, s, e, u] of REQUIRED) {
  const k = `${p}|${s}|${e}|${u}`.toLowerCase();
  const has = index.has(k);
  if (!has) missing += 1;
  console.log(`  ${has ? "OK  " : "FAIL"}  ${p}/${s}/${e}/${u}`);
}

console.log("\n" + "=".repeat(66));
if (missing === 0) {
  console.log(
    "✅ All required rates are loadable in this process. If live rows are\n" +
      "   still $0, the DEPLOYED build predates the rate-card code — redeploy.",
  );
} else {
  console.log(
    `❌ ${missing} required rate(s) MISSING in this process's env. That is why\n` +
      "   live rows were written with cost = 0. Two options:\n" +
      "   1) (recommended) install billing_autopricing_trigger.sql so the DB\n" +
      "      prices rows regardless of runtime env — permanent fix.\n" +
      "   2) set the missing *_RATE_CARD_JSON var(s) on THIS service and redeploy.",
  );
}
console.log("=".repeat(66));
process.exit(missing === 0 ? 0 : 1);
