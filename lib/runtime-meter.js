"use strict";

const crypto = require("crypto");
const { logRailwayRuntimeUsage } = require("./usage-ledger");

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] || (fallback ? "true" : "false"))
    .trim()
    .toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

function intEnv(name, fallback, min = 0) {
  const n = Number(process.env[name] || fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

function stableKey(parts) {
  return crypto
    .createHash("sha256")
    .update(parts.filter(Boolean).map(String).join("|"))
    .digest("hex");
}

// Railway runtime cost per second, read from the same RAILWAY_RATE_CARD_JSON
// the vendor-rate sync uses. Matched loosely on provider/service so the rate
// applies to every websocket_runtime_* event type this meter emits, rather
// than only the bare "websocket_runtime" name the card happens to carry.
let railwayRateCache = null;
function railwayRuntimeUnitCostUsd() {
  if (railwayRateCache !== null) return railwayRateCache;
  let rate = 0;
  try {
    // RUNTIME_RATE_CARD_JSON only; the Railway key is gone with the vendor.
    // Left unset, runtime seconds carry no unit cost and are never billed.
    const raw = process.env.RUNTIME_RATE_CARD_JSON;
    if (raw) {
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const match = rows.find(
        (r) =>
          r &&
          String(r.provider || "").toLowerCase() === "aws" &&
          String(r.service || "").toLowerCase() === "runtime" &&
          String(r.unit || "").toLowerCase() === "seconds",
      );
      const value = Number(match?.unitCostUsd ?? match?.unit_cost_usd);
      if (Number.isFinite(value) && value > 0) rate = value;
    }
  } catch (err) {
    console.warn(
      "[runtime-meter] RUNTIME_RATE_CARD_JSON is set but did not parse:",
      err?.message || String(err),
    );
  }
  if (!rate) {
    console.warn(
      "[runtime-meter] no runtime rate resolved; runtime usage prices at $0. This is expected: runtime is shared infrastructure, not a per-tenant provider cost.",
    );
  }
  railwayRateCache = rate;
  return rate;
}

function createRuntimeMeter({
  organizationId,
  userId,
  callId,
  chatbotId,
  voiceAgentId,
  route,
  externalId,
  metadata,
}) {
  const startedAt = Date.now();
  const sessionId =
    externalId ||
    stableKey([
      "runtime-session",
      route,
      organizationId,
      callId,
      chatbotId,
      voiceAgentId,
      startedAt,
    ]).slice(0, 24);
  const heartbeatSeconds = intEnv("BILLING_RUNTIME_HEARTBEAT_SECONDS", 60, 15);
  const heartbeatEnabled = boolEnv("BILLING_RUNTIME_HEARTBEATS_ENABLED", false);
  let finished = false;
  let heartbeatCount = 0;
  let timer = null;

  async function write(eventType, seconds, reason = null, extra = {}) {
    try {
      return await logRailwayRuntimeUsage({
        organizationId: organizationId || null,
        userId: userId || null,
        seconds: safeNumber(seconds),
        // Runtime seconds are NOT a billable provider cost any more. We left
        // Railway, so there is no per-second invoice to recover; the flat AWS
        // Lightsail bill is recovered by apportionment in
        // lib/usage-billing-engine.js instead. The seconds are still recorded
        // because they are the driver that apportionment divides by.
        unitCostUsd: null,
        billable: false,
        callId: callId || null,
        voiceAgentId: voiceAgentId || null,
        chatbotId: chatbotId || null,
        externalId: `${sessionId}:${eventType}${extra.heartbeat_count ? `:${extra.heartbeat_count}` : ""}`,
        eventType,
        metadata: {
          route: route || "unknown_ws_route",
          runtime_session_id: sessionId,
          started_at: new Date(startedAt).toISOString(),
          reason,
          ...(metadata || {}),
          ...(extra || {}),
        },
      });
    } catch (err) {
      console.warn(
        "[runtime-meter] usage log skipped",
        eventType,
        err.message || String(err),
      );
      return null;
    }
  }

  async function start() {
    await write("websocket_runtime_started", 0, "session_started");
    if (heartbeatEnabled && heartbeatSeconds > 0) {
      timer = setInterval(() => {
        if (finished) return;
        heartbeatCount += 1;
        const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        void write("websocket_runtime_heartbeat", seconds, "heartbeat", {
          heartbeat_count: heartbeatCount,
        });
      }, heartbeatSeconds * 1000);
      if (typeof timer.unref === "function") timer.unref();
    }
  }

  async function finish(reason = "session_closed") {
    if (finished) return null;
    finished = true;
    if (timer) clearInterval(timer);
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    return write("websocket_runtime_final", seconds, reason, {
      heartbeat_count: heartbeatCount,
      finished_at: new Date().toISOString(),
    });
  }

  return {
    sessionId,
    startedAt,
    start,
    finish,
  };
}

module.exports = { createRuntimeMeter };
