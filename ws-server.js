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
const {
  safeConfigForDebug,
  logRuntimeConfigValidation,
  validateRuntimeConfig,
} = require("./lib/config");

// Scheduler — production scheduled outbound worker runs on Railway.
let startLeadScheduler = null;
let executeDueSchedules = null;
let debugProviderHealth = null;
let debugSchedule = null;
let debugCleanSlate = null;
let debugSchedulerLimits = null;
try {
  const scheduler = require("./lib/scheduler");
  startLeadScheduler = scheduler.startLeadScheduler || null;
  executeDueSchedules = scheduler.executeDueSchedules || null;
  debugProviderHealth = scheduler.debugProviderHealth || null;
  debugSchedule = scheduler.debugSchedule || null;
  debugCleanSlate = scheduler.debugCleanSlate || null;
  debugSchedulerLimits = scheduler.debugSchedulerLimits || null;
} catch (e) {
  console.warn("[WS] Scheduler not available:", e.message);
}

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 8080;
logRuntimeConfigValidation(validateRuntimeConfig());

// ── Health endpoint ───────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({
    // Reports the billing gate so you can see WHY calls are being refused
    // without having to read container logs. The previous design exited the
    // process instead, which meant this endpoint never answered at all.
    ok:
      typeof global.__agentlyBillingGateOpen === "function"
        ? global.__agentlyBillingGateOpen()
        : true,
    status:
      typeof global.__agentlyBillingGateOpen === "function" &&
      !global.__agentlyBillingGateOpen()
        ? "degraded_billing_unavailable"
        : "ok",
    billing: {
      ready:
        typeof global.__agentlyBillingGateOpen === "function"
          ? global.__agentlyBillingGateOpen()
          : null,
      error:
        typeof global.__agentlyBillingError === "function"
          ? global.__agentlyBillingError()
          : null,
    },
    service: "agently-ws",
    ts: new Date().toISOString(),
    paths: {
      conversationRelay: "/ws",
      twilioMediaStream: "/api/twilio/media-stream",
      realtimeProxy: "/realtime",
    },
    config: safeConfigForDebug(),
    voiceProviders: {
      default: process.env.VOICE_PROVIDER_DEFAULT || "openai",
      fallback: process.env.VOICE_PROVIDER_FALLBACK || "openai",
      elevenLabsConfigured: Boolean(
        (process.env.ELEVENLABS_API_KEY || "").trim(),
      ),
      elevenLabsPreflightMode:
        process.env.ELEVENLABS_PREFLIGHT_MODE || "key_only",
      elevenLabsRequired:
        String(process.env.ELEVENLABS_REQUIRED || "false").toLowerCase() ===
        "true",
      providerHealthCacheSeconds: Number(
        process.env.PROVIDER_HEALTH_CACHE_SECONDS || 300,
      ),
      elevenLabsDefaultModel:
        process.env.ELEVENLABS_DEFAULT_MODEL || "eleven_flash_v2_5",
      elevenLabsTwilioOutputFormat:
        process.env.ELEVENLABS_TWILIO_OUTPUT_FORMAT || "ulaw_8000",
      elevenLabsSpeed: Number(process.env.ELEVENLABS_SPEED || 0.92),
      elevenLabsOptimizeStreamingLatency: Number(
        process.env.ELEVENLABS_OPTIMIZE_STREAMING_LATENCY || 3,
      ),
      idleHangupMs: Number(process.env.NO_SPEECH_TIMEOUT_SECONDS || 15) * 1000,
      noSpeechTimeoutSeconds: Number(
        process.env.NO_SPEECH_TIMEOUT_SECONDS || 15,
      ),
      callEndConfirmationEnabled:
        String(
          process.env.CALL_END_CONFIRMATION_ENABLED || "false",
        ).toLowerCase() === "true",
      schedulerEnabled:
        String(
          process.env.SCHEDULER_ENABLED ||
            process.env.ENABLE_LEAD_SCHEDULER ||
            "true",
        ).toLowerCase() !== "false",
      schedulerPollIntervalSeconds: Number(
        process.env.SCHEDULER_POLL_INTERVAL_SECONDS || 60,
      ),
      maxGlobalOutboundCallsPerMinute: Number(
        process.env.MAX_GLOBAL_OUTBOUND_CALLS_PER_MINUTE || 30,
      ),
      maxOrgOutboundCallsPerMinute: Number(
        process.env.MAX_ORG_OUTBOUND_CALLS_PER_MINUTE || 5,
      ),
      maxOrgConcurrentCalls: Number(process.env.MAX_ORG_CONCURRENT_CALLS || 3),
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
    config: safeConfigForDebug(),
    voiceProviders: {
      default: process.env.VOICE_PROVIDER_DEFAULT || "openai",
      fallback: process.env.VOICE_PROVIDER_FALLBACK || "openai",
      elevenLabsConfigured: Boolean(
        (process.env.ELEVENLABS_API_KEY || "").trim(),
      ),
      elevenLabsPreflightMode:
        process.env.ELEVENLABS_PREFLIGHT_MODE || "key_only",
      elevenLabsRequired:
        String(process.env.ELEVENLABS_REQUIRED || "false").toLowerCase() ===
        "true",
      providerHealthCacheSeconds: Number(
        process.env.PROVIDER_HEALTH_CACHE_SECONDS || 300,
      ),
      elevenLabsDefaultModel:
        process.env.ELEVENLABS_DEFAULT_MODEL || "eleven_flash_v2_5",
      elevenLabsTwilioOutputFormat:
        process.env.ELEVENLABS_TWILIO_OUTPUT_FORMAT || "ulaw_8000",
      elevenLabsSpeed: Number(process.env.ELEVENLABS_SPEED || 0.92),
      elevenLabsOptimizeStreamingLatency: Number(
        process.env.ELEVENLABS_OPTIMIZE_STREAMING_LATENCY || 3,
      ),
      idleHangupMs: Number(process.env.NO_SPEECH_TIMEOUT_SECONDS || 15) * 1000,
      noSpeechTimeoutSeconds: Number(
        process.env.NO_SPEECH_TIMEOUT_SECONDS || 15,
      ),
      callEndConfirmationEnabled:
        String(
          process.env.CALL_END_CONFIRMATION_ENABLED || "false",
        ).toLowerCase() === "true",
      schedulerEnabled:
        String(
          process.env.SCHEDULER_ENABLED ||
            process.env.ENABLE_LEAD_SCHEDULER ||
            "true",
        ).toLowerCase() !== "false",
      schedulerPollIntervalSeconds: Number(
        process.env.SCHEDULER_POLL_INTERVAL_SECONDS || 60,
      ),
      maxGlobalOutboundCallsPerMinute: Number(
        process.env.MAX_GLOBAL_OUTBOUND_CALLS_PER_MINUTE || 30,
      ),
      maxOrgOutboundCallsPerMinute: Number(
        process.env.MAX_ORG_OUTBOUND_CALLS_PER_MINUTE || 5,
      ),
      maxOrgConcurrentCalls: Number(process.env.MAX_ORG_CONCURRENT_CALLS || 3),
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

app.get("/debug/config", async (req, res) => {
  if (!requireDebugToken(req, res)) return;
  try {
    return res.json({
      ok: true,
      ts: new Date().toISOString(),
      ...safeConfigForDebug(),
    });
  } catch (err) {
    console.error("[debug/config] failed:", err.message);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to load config debug details." });
  }
});

app.get("/debug/provider-health", async (req, res) => {
  if (!requireDebugToken(req, res)) return;
  try {
    if (!debugProviderHealth) {
      return res
        .status(503)
        .json({ ok: false, error: "Provider health debug is unavailable." });
    }
    const health = await debugProviderHealth();
    return res.json({ ok: true, ts: new Date().toISOString(), ...health });
  } catch (err) {
    console.error("[debug/provider-health] failed:", err.message);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to load provider health." });
  }
});

app.get("/debug/schedule/:id", async (req, res) => {
  if (!requireDebugToken(req, res)) return;
  try {
    if (!debugSchedule) {
      return res
        .status(503)
        .json({ ok: false, error: "Schedule debug is unavailable." });
    }
    const result = await debugSchedule(String(req.params.id || ""));
    return res.json({ ts: new Date().toISOString(), ...result });
  } catch (err) {
    console.error("[debug/schedule] failed:", err.message);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to load schedule debug details." });
  }
});

app.get("/debug/scheduler", async (req, res) => {
  if (!requireDebugToken(req, res)) return;
  const payload = {
    ok: true,
    ts: new Date().toISOString(),
    schedulerEnabled:
      String(
        process.env.SCHEDULER_ENABLED ||
          process.env.ENABLE_LEAD_SCHEDULER ||
          "true",
      ).toLowerCase() !== "false",
    rawSchedulerEnabled: String(
      process.env.SCHEDULER_ENABLED ||
        process.env.ENABLE_LEAD_SCHEDULER ||
        "true",
    ),
    workerStarted: Boolean(startLeadScheduler),
    pollIntervalSeconds: Number(
      process.env.SCHEDULER_POLL_INTERVAL_SECONDS || 60,
    ),
    staleNoSidResetMinutes: Number(
      process.env.SCHEDULER_STALE_NO_SID_RESET_MINUTES || 3,
    ),
    activeCallWindowMinutes: Number(
      process.env.SCHEDULER_ACTIVE_CALL_WINDOW_MINUTES || 30,
    ),
    oneTimeOverflowMode: process.env.SCHEDULER_ONE_TIME_OVERFLOW_MODE || "fail",
    config: safeConfigForDebug(),
  };
  if (debugSchedulerLimits && (req.query.organizationId || req.query.orgId)) {
    try {
      payload.limitsDebug = await debugSchedulerLimits({
        organizationId: req.query.organizationId || req.query.orgId || "",
        scheduleId: req.query.scheduleId || "",
      });
    } catch (err) {
      payload.limitsDebug = {
        ok: false,
        error: err.message || String(err),
      };
      console.error("[debug/scheduler] limits debug failed:", err.message);
    }
  }
  return res.json(payload);
});

app.get("/debug/scheduler/limits", async (req, res) => {
  if (!requireDebugToken(req, res)) return;
  try {
    if (!debugSchedulerLimits) {
      return res
        .status(503)
        .json({ ok: false, error: "Scheduler limits debug is unavailable." });
    }
    const result = await debugSchedulerLimits({
      organizationId: req.query.organizationId || req.query.orgId || "",
      scheduleId: req.query.scheduleId || "",
    });
    return res.json({ ts: new Date().toISOString(), ...result });
  } catch (err) {
    console.error("[debug/scheduler/limits] failed:", err.message);
    return res.status(500).json({
      ok: false,
      error: "Failed to load scheduler limits debug.",
      detail: err.message,
    });
  }
});

app.post("/debug/scheduler/run-once", async (req, res) => {
  if (!requireDebugToken(req, res)) return;
  try {
    if (!executeDueSchedules) {
      return res.status(503).json({
        ok: false,
        error: "Scheduler executeDueSchedules is unavailable.",
      });
    }
    const summary = await executeDueSchedules();
    return res.json({ ok: true, ts: new Date().toISOString(), summary });
  } catch (err) {
    console.error("[debug/scheduler/run-once] failed:", err.message);
    return res.status(500).json({
      ok: false,
      error: "Failed to run scheduler once.",
      detail: err.message,
    });
  }
});

app.post("/debug/scheduler/clean-slate", async (req, res) => {
  if (!requireDebugToken(req, res)) return;
  try {
    if (!debugCleanSlate) {
      return res
        .status(503)
        .json({ ok: false, error: "Clean slate helper is unavailable." });
    }
    const result = await debugCleanSlate({
      organizationId: req.query.organizationId || req.query.orgId || "",
      scheduleId: req.query.scheduleId || "",
      dryRun: req.query.dryRun || false,
      resetLinked: req.query.resetLinked || false,
      resetLinkedOlderThanMinutes:
        req.query.resetLinkedOlderThanMinutes ||
        req.query.linkedOlderThanMinutes ||
        2,
    });
    return res.json({ ts: new Date().toISOString(), ...result });
  } catch (err) {
    console.error("[debug/scheduler/clean-slate] failed:", err.message);
    return res.status(500).json({
      ok: false,
      error: "Failed to clean scheduled test rows.",
      detail: err.message,
    });
  }
});

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

// ── Start scheduled outbound worker (if enabled) ──────────────
try {
  if (startLeadScheduler) {
    startLeadScheduler();
  } else if (executeDueSchedules) {
    const intervalMs = Math.max(
      15000,
      Number(process.env.SCHEDULER_POLL_INTERVAL_SECONDS || 60) * 1000,
    );
    setInterval(() => void executeDueSchedules(), intervalMs);
    console.log(
      `[WS] Scheduled outbound worker started (every ${intervalMs / 1000}s)`,
    );
  }
} catch (e) {
  console.warn("[WS] Scheduled outbound worker failed to start:", e.message);
}

// ── Start per-number billing tracker ─────────────────────────
// Runs every 30 seconds here on Railway (always-on process).
// Replaces Vercel Cron (which requires paid plan for sub-daily jobs).
// Copy agently-server/lib/billing-tracker.js into this project's lib/ folder.
// NEVER exposed to users — backend-only internal cost tracking.
// ── BILLING TRACKER ─────────────────────────────────────────────────────────
//
// REVISED. My previous version called process.exit(1) when the tracker failed
// to load. That was wrong, and it is what put this container into a restart
// loop. The reasoning was "never serve calls unbilled" — correct goal, wrong
// mechanism. A crash loop is strictly worse than the problem it prevents:
//
//   • the process dies before it can tell you why, so the logs are near-empty
//   • Railway restarts it every few seconds, and every boot re-runs the
//     scheduler, the billing self-test and the workers below — a query storm
//     against the SAME Supabase project the login API depends on
//   • /health never comes up, so nothing downstream can see the real state
//
// New behaviour: the process STAYS UP and healthy, but refuses to accept
// calls while billing is broken. Same protection, no collateral damage.
let BILLING_READY = false;
let BILLING_ERROR = null;

try {
  const bt = require("./lib/billing-tracker");
  if (typeof bt.start !== "function") {
    throw new Error("billing-tracker module has no start() export");
  }
  bt.start();
  BILLING_READY = true;
  console.log("[WS] Billing tracker started.");
} catch (err) {
  BILLING_ERROR = (err && err.message) || String(err);
  console.error("[WS] BILLING TRACKER FAILED TO START:", BILLING_ERROR);
  console.error(
    "[WS] Calls will be REJECTED while billing is down, but the server stays " +
      "up so you can read this and /health reports the reason. " +
      "Set BILLING_TRACKER_OPTIONAL=true to accept calls anyway (revenue loss).",
  );
}

const BILLING_OPTIONAL =
  String(process.env.BILLING_TRACKER_OPTIONAL || "false").toLowerCase() ===
  "true";

/** Call sites check this before accepting a media stream. */
function billingGateOpen() {
  return BILLING_READY || BILLING_OPTIONAL;
}
global.__agentlyBillingGateOpen = billingGateOpen;
global.__agentlyBillingError = () => BILLING_ERROR;

// ── BACKGROUND WORKERS ──────────────────────────────────────────────────────
//
// Deliberately delayed and jittered. If this container ever does end up in a
// restart loop, workers that fire instantly on boot turn that loop into a
// denial-of-service against your own Supabase project — which is shared with
// the login API. The delay means a container that dies young never reaches
// them at all.
const WORKER_BOOT_DELAY_MS = Number(process.env.WORKER_BOOT_DELAY_MS || 20000);
const bootJitter = Math.floor(Math.random() * 5000);

setTimeout(() => {
  try {
    require("./lib/scrape-worker").start();
  } catch (err) {
    console.error("[WS] scrape worker failed to start:", err?.message || err);
  }

  try {
    require("./lib/change-monitor").start();
  } catch (err) {
    console.error("[WS] change monitor failed to start:", err?.message || err);
  }
}, WORKER_BOOT_DELAY_MS + bootJitter);

// NOTE: the wallet settlement sweep that used to live here has been REMOVED.
//
// It was a real bug on my part. lib/wallet-settlement.js needs
// postWalletDebitForChargeDirectly, which exists in the API server's
// lib/usage-ledger.js. This repo has its own, much smaller usage-ledger.js
// that exports only four functions and not that one — so the symbol resolved
// to undefined and every sweep threw TypeError after first running a
// 5000-row query against billing_customer_usage_charges.
//
// Settlement belongs on Vercel, where the full ledger lives. It already runs
// synchronously on every top-up (api/routes/billing-usage.js), which covers
// the case that matters. If you want a periodic sweep as well, point a cron
// at POST /api/billing-usage/wallets/settle-all rather than running it here.

// ── Start ─────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🔌 Agently WS Server on port ${PORT}`);
  console.log(`📡 Health:     http://localhost:${PORT}/health`);
  const cfg = safeConfigForDebug();
  const wsBase = cfg.twilioWsUrlValid
    ? cfg.twilioWsUrl
    : `ws://localhost:${PORT}`;
  console.log(`🎙️  Voice calls: ${wsBase}/ws`);
  console.log(`📞  Twilio Stream: ${wsBase}/api/twilio/media-stream`);
  console.log(`⚡  Widget RT:   ${wsBase}/realtime\n`);

  // ── Billing runtime self-test ─────────────────────────────────
  // This is the single check that would have caught the "only Twilio rows
  // appear" bug on day one: it exercises the exact same getSupabase() +
  // billing_usage_events upsert path that live calls use, at boot, with a
  // non-billable synthetic row. If this fails, live calls WILL also fail to
  // write OpenAI/ElevenLabs/Railway usage, and the reason will be printed
  // here instead of being buried inside a live-call try/catch.
  (async () => {
    try {
      const { getSupabase } = require("./lib/supabase");
      const db = getSupabase();
      const probeKey = `ws_boot_selftest:${process.env.RAILWAY_DEPLOYMENT_ID || process.env.HOSTNAME || "local"}:${new Date().toISOString().slice(0, 13)}`;
      const { error } = await db.from("billing_usage_events").upsert(
        {
          organization_id: null,
          provider: "agently",
          service: "ws_boot_selftest",
          event_type: "boot_check",
          source: "agently_ws_boot_selftest",
          external_id: probeKey,
          idempotency_key: probeKey,
          unit: "check",
          quantity: 1,
          billable: false,
          occurred_at: new Date().toISOString(),
          metadata: {
            note: "boot-time connectivity probe, safe to ignore/delete",
          },
        },
        { onConflict: "idempotency_key" },
      );
      if (error) throw error;
      console.log(
        "[billing-selftest] ✅ Supabase + billing_usage_events writable at boot. Live-call billing writes should work.",
      );
    } catch (err) {
      console.error(
        "\n❌❌❌ [billing-selftest] FAILED — live-call billing writes (OpenAI/ElevenLabs/Railway) WILL be dropped. ❌❌❌",
      );
      console.error(
        "[billing-selftest] reason:",
        err && err.message ? err.message : String(err),
      );
      console.error(
        "[billing-selftest] check SUPABASE_URL and the service-role key env var (SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_ROLE_KEY) on THIS service.\n",
      );
    }
  })();
});

process.on("SIGTERM", () => {
  console.log("[WS] Shutting down…");
  server.close(() => process.exit(0));
});
