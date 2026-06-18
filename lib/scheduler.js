"use strict";

const { getSupabase } = require("./supabase");
const { makeOutboundCall } = require("./twilio");
const {
  readVoicemailSettings,
  machineDetectionModeForSettings,
} = require("./voicemail-policy");
const {
  validateRuntimeConfig,
  logRuntimeConfigValidation,
  buildUrl,
} = require("./config");
const {
  isE164,
  cleanPhone,
  guessCountryFromE164,
  normalizeCountry,
  jsonArray,
  serializeRun,
  detailedOutcome,
  displayStatusForRun,
  durationSecondsForRun,
  buildEffectiveSchedulerLimits,
} = require("./outreach-utils");

let schedulerTimer = null;
let runInProgress = false;
const providerFailureCounts = new Map();
const providerHealthCache = new Map();

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

function providerHealthCacheSeconds() {
  return Math.max(0, intEnv("PROVIDER_HEALTH_CACHE_SECONDS", 300));
}

function getCachedProviderHealth(cacheKey) {
  const ttlMs = providerHealthCacheSeconds() * 1000;
  if (!ttlMs) return null;
  const entry = providerHealthCache.get(cacheKey);
  if (!entry || Date.now() - entry.at > ttlMs) return null;
  return { ...entry.value, cached: true, cacheAgeMs: Date.now() - entry.at };
}

function setCachedProviderHealth(cacheKey, value) {
  if (!providerHealthCacheSeconds()) return value;
  providerHealthCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function schedulerHttpChecksEnabled() {
  return boolEnv("SCHEDULER_PROVIDER_HTTP_CHECKS", false);
}

function strictNumberReadinessEnabled() {
  return boolEnv("SCHEDULER_STRICT_NUMBER_READINESS", false);
}

function defaultOutboundVoiceCountries(country) {
  const raw =
    process.env.TWILIO_LOW_RISK_VOICE_COUNTRIES ||
    process.env.DEFAULT_OUTBOUND_VOICE_COUNTRIES ||
    "US";
  return [
    ...new Set(
      [country, ...String(raw).split(",")]
        .map(normalizeCountry)
        .filter(Boolean),
    ),
  ];
}

function voiceCountriesForNumber(number, destinationCountry) {
  return new Set(
    [
      ...jsonArray(number?.selected_outbound_voice_countries),
      normalizeCountry(number?.iso_country),
      normalizeCountry(destinationCountry),
      ...defaultOutboundVoiceCountries(number?.iso_country),
    ]
      .map(normalizeCountry)
      .filter(Boolean),
  );
}

function elevenLabsPreflightMode() {
  const mode = String(process.env.ELEVENLABS_PREFLIGHT_MODE || "key_only")
    .trim()
    .toLowerCase();
  return ["none", "key_only", "tts", "user"].includes(mode) ? mode : "key_only";
}

function fallbackProviderName() {
  return String(process.env.VOICE_PROVIDER_FALLBACK || "openai")
    .trim()
    .toLowerCase();
}

function scheduledCallVoiceProviderMode() {
  const mode = String(
    process.env.SCHEDULED_CALL_VOICE_PROVIDER || "agent_default",
  )
    .trim()
    .toLowerCase();
  return ["openai", "elevenlabs", "agent_default"].includes(mode)
    ? mode
    : "agent_default";
}

function elevenLabsRequired() {
  return boolEnv("ELEVENLABS_REQUIRED", false);
}

function safeJsonString(value, max = 1000) {
  try {
    return JSON.stringify(value).slice(0, max);
  } catch (_) {
    return String(value || "").slice(0, max);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function getSchedulerConfig() {
  return logRuntimeConfigValidation(validateRuntimeConfig());
}

function apiBaseUrl() {
  return getSchedulerConfig().apiUrl;
}

function intEnv(name, fallback) {
  const parsed = parseInt(process.env[name] || String(fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function activeCallWindowMinutes() {
  return Math.max(1, intEnv("SCHEDULER_ACTIVE_CALL_WINDOW_MINUTES", 30));
}

function hasUsableTwilioSid(value) {
  return Boolean(String(value || "").trim());
}

function isTerminalCallStatus(status) {
  const value = String(status || "")
    .trim()
    .toLowerCase();
  return [
    "completed",
    "failed",
    "busy",
    "no-answer",
    "no_answer",
    "canceled",
    "cancelled",
    "voicemail",
    "answered_voicemail",
    "machine",
    "done",
  ].includes(value);
}

function isResetOutcome(metadata) {
  const value = metadata || {};
  return Boolean(
    value.reset_reason ||
    value.autoResetReason ||
    value.cleanSlateResetAt ||
    value.debugResetAt ||
    value.deferred_reason === "daily_limit_reset",
  );
}

function limitLogLabel(code) {
  switch (code) {
    case "ORG_CONCURRENCY_LIMIT":
      return "concurrency limit reached";
    case "ORG_DAILY_LIMIT":
      return "daily limit reached";
    case "SCHEDULE_DAILY_LIMIT":
      return "schedule daily limit reached";
    case "ORG_RATE_LIMIT":
    case "GLOBAL_RATE_LIMIT":
      return "rate limit reached";
    default:
      return "scheduled-call limit reached";
  }
}

async function fetchCallRecordsByIds(db, ids) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  if (!uniqueIds.length) return new Map();
  const { data, error } = await db
    .from("call_records")
    .select("id,status,outcome,completed_at,ended_at,metadata")
    .in("id", uniqueIds);
  if (error) throw error;
  return new Map((data || []).map((record) => [record.id, record]));
}

function applyRealAttemptFilters(query) {
  return query.not("twilio_call_sid", "is", null).neq("twilio_call_sid", "");
}

async function fetchActiveConcurrency(
  db,
  organizationId,
  { currentRunId = null } = {},
) {
  const activeWindowStart = new Date(
    Date.now() - activeCallWindowMinutes() * 60_000,
  ).toISOString();
  let query = db
    .from("lead_outreach_runs")
    .select(
      "id,schedule_id,twilio_call_sid,call_record_id,started_at,status,outcome_metadata",
    )
    .eq("organization_id", organizationId)
    .eq("status", "initiated")
    .gte("started_at", activeWindowStart);
  query = applyRealAttemptFilters(query);
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data || []).filter(
    (row) => !currentRunId || row.id !== currentRunId,
  );
  const recordMap = await fetchCallRecordsByIds(
    db,
    rows.map((row) => row.call_record_id),
  );
  const countedRuns = [];
  const ignoredRuns = [];
  for (const row of rows) {
    if (isResetOutcome(row.outcome_metadata)) {
      ignoredRuns.push({ id: row.id, reason: "reset_outcome" });
      continue;
    }
    const record = row.call_record_id
      ? recordMap.get(row.call_record_id)
      : null;
    if (record) {
      const status = record.status || record.outcome;
      if (
        isTerminalCallStatus(status) ||
        record.completed_at ||
        record.ended_at
      ) {
        ignoredRuns.push({
          id: row.id,
          reason: "terminal_call_record",
          status,
        });
        continue;
      }
    }
    countedRuns.push({
      id: row.id,
      scheduleId: row.schedule_id,
      twilioCallSid: row.twilio_call_sid,
      callRecordId: row.call_record_id || null,
      startedAt: row.started_at,
      callRecordStatus: record?.status || record?.outcome || null,
    });
  }
  return {
    activeCount: countedRuns.length,
    activeWindowMinutes: activeCallWindowMinutes(),
    activeWindowStart,
    countedRunIds: countedRuns.map((row) => row.id),
    countedRuns,
    ignoredRuns,
  };
}

async function fetchDailyUsage(
  db,
  { organizationId, scheduleId = null, currentRunId = null } = {},
) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayIso = today.toISOString();

  let startedQuery = db
    .from("lead_outreach_runs")
    .select(
      "id,twilio_call_sid,call_record_id,status,started_at,outcome_metadata",
    )
    .eq("organization_id", organizationId)
    .gte("started_at", todayIso);
  if (scheduleId) startedQuery = startedQuery.eq("schedule_id", scheduleId);
  const { data: startedRows, error: startedError } = await startedQuery;
  if (startedError) throw startedError;

  let realQuery = db
    .from("lead_outreach_runs")
    .select(
      "id,twilio_call_sid,call_record_id,status,started_at,outcome_metadata",
    )
    .eq("organization_id", organizationId)
    .gte("started_at", todayIso);
  if (scheduleId) realQuery = realQuery.eq("schedule_id", scheduleId);
  realQuery = applyRealAttemptFilters(realQuery);
  const { data: realRows, error: realError } = await realQuery;
  if (realError) throw realError;

  const filteredRealRows = (realRows || []).filter(
    (row) =>
      (!currentRunId || row.id !== currentRunId) &&
      !isResetOutcome(row.outcome_metadata),
  );
  const startedButNoTwilioSid = (startedRows || []).filter(
    (row) => !hasUsableTwilioSid(row.twilio_call_sid),
  );
  return {
    sinceUtc: todayIso,
    realTwilioCallsToday: filteredRealRows.length,
    runsStartedToday: (startedRows || []).length,
    runsStartedTodayButNoTwilioSid: startedButNoTwilioSid.length,
    countedRunIds: filteredRealRows.map((row) => row.id),
    noTwilioSidRunIds: startedButNoTwilioSid.map((row) => row.id),
  };
}

function staleNoSidResetMinutes() {
  return Math.max(1, intEnv("SCHEDULER_STALE_NO_SID_RESET_MINUTES", 3));
}

function oneTimeOverflowMode() {
  const value = String(process.env.SCHEDULER_ONE_TIME_OVERFLOW_MODE || "fail")
    .trim()
    .toLowerCase();
  return ["fail", "queue"].includes(value) ? value : "fail";
}

function schedulerEnabled() {
  return (
    String(
      process.env.SCHEDULER_ENABLED ||
        process.env.ENABLE_LEAD_SCHEDULER ||
        "true",
    ).toLowerCase() !== "false"
  );
}

function encodeOutboundTwiMlUrl(base, params = {}) {
  return buildUrl(base, "/api/twilio/outbound-twiml", params);
}

function buildStatusCallbackUrl(base) {
  return buildUrl(base, "/api/twilio/call-status");
}

function buildRecordingStatusCallbackUrl(base) {
  return buildUrl(base, "/api/twilio/recording-status");
}

function buildAmdStatusCallbackUrl(base) {
  return buildUrl(base, "/api/twilio/amd-status");
}

async function checkOpenAIProvider() {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  const model = String(
    process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
  ).trim();
  if (!apiKey)
    return {
      ok: false,
      provider: "openai",
      code: "missing_api_key",
      message: "OPENAI_API_KEY is not configured.",
    };
  if (!model)
    return {
      ok: false,
      provider: "openai",
      code: "missing_model",
      message: "OPENAI_REALTIME_MODEL is not configured.",
    };
  if (!schedulerHttpChecksEnabled()) {
    return { ok: true, provider: "openai", code: "configured" };
  }
  try {
    const res = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        output_modalities: ["text"],
        instructions: "Health check.",
      }),
    });
    if (res.ok) return { ok: true, provider: "openai", code: "ok" };
    const text = await res.text();
    const code = /insufficient_quota/i.test(text)
      ? "insufficient_quota"
      : /invalid_api_key/i.test(text)
        ? "invalid_api_key"
        : /model_not_found/i.test(text)
          ? "model_not_found"
          : `http_${res.status}`;
    return { ok: false, provider: "openai", code, message: text.slice(0, 500) };
  } catch (err) {
    return {
      ok: false,
      provider: "openai",
      code: "health_check_failed",
      message: err.message || String(err),
    };
  }
}

async function checkElevenLabsProviderIfNeeded(agent) {
  const provider = String(
    agent?.voice_provider || process.env.VOICE_PROVIDER_DEFAULT || "openai",
  ).toLowerCase();
  const fallbackAvailable = fallbackProviderName() === "openai";
  const required = elevenLabsRequired();
  const mode = elevenLabsPreflightMode();
  if (provider !== "elevenlabs") {
    return {
      ok: true,
      provider: "elevenlabs",
      code: "not_selected",
      preflightMode: mode,
      fallbackAvailable,
      required,
    };
  }

  console.log("[provider-health] elevenlabs preflight mode=", mode);
  const apiKey = String(process.env.ELEVENLABS_API_KEY || "").trim();
  const voiceId = String(
    agent?.elevenlabs_voice_id ||
      agent?.elevenLabsVoiceId ||
      agent?.voice_id ||
      "",
  ).trim();
  const voiceCatalogId = String(agent?.voice_catalog_id || "").trim();

  if (mode !== "user") {
    console.log("[provider-health] elevenlabs user_read check skipped");
  }
  if (mode === "none") {
    return {
      ok: true,
      provider: "elevenlabs",
      code: "preflight_skipped",
      preflightMode: mode,
      fallbackAvailable,
      required,
    };
  }
  if (!apiKey) {
    return {
      ok: false,
      provider: "elevenlabs",
      code: "missing_api_key",
      message: "ELEVENLABS_API_KEY is not configured.",
      preflightMode: mode,
      fallbackAvailable,
      required,
    };
  }
  if (!voiceId && !voiceCatalogId) {
    return {
      ok: false,
      provider: "elevenlabs",
      code: "missing_voice_id",
      message:
        "Agent has no ElevenLabs elevenlabs_voice_id, voice_id, or voice_catalog_id.",
      preflightMode: mode,
      fallbackAvailable,
      required,
    };
  }

  if (
    mode === "key_only" ||
    (!schedulerHttpChecksEnabled() && mode !== "tts" && mode !== "user")
  ) {
    console.log("[provider-health] elevenlabs tts/key check ok", {
      mode: "key_only",
      voiceId: voiceId || "catalog:" + voiceCatalogId,
    });
    return {
      ok: true,
      provider: "elevenlabs",
      code: "configured",
      preflightMode: mode,
      fallbackAvailable,
      required,
    };
  }

  const cacheKey = `elevenlabs:${mode}:${voiceId || voiceCatalogId}`;
  const cached = getCachedProviderHealth(cacheKey);
  if (cached) return cached;

  try {
    if (mode === "user") {
      const res = await fetch("https://api.elevenlabs.io/v1/user", {
        headers: { "xi-api-key": apiKey },
      });
      if (res.ok)
        return setCachedProviderHealth(cacheKey, {
          ok: true,
          provider: "elevenlabs",
          code: "ok",
          preflightMode: mode,
          fallbackAvailable,
          required,
        });
      const body = await res.text();
      const failed = {
        ok: false,
        provider: "elevenlabs",
        code: `http_${res.status}`,
        message: body.slice(0, 500),
        preflightMode: mode,
        fallbackAvailable,
        required,
      };
      console.warn("[provider-health] elevenlabs failed code=", failed.code);
      return setCachedProviderHealth(cacheKey, failed);
    }

    if (mode === "tts") {
      if (!voiceId) {
        return {
          ok: false,
          provider: "elevenlabs",
          code: "missing_voice_id_for_tts_check",
          message: "TTS preflight requires elevenlabs_voice_id or voice_id.",
          preflightMode: mode,
          fallbackAvailable,
          required,
        };
      }
      const modelId = String(
        process.env.ELEVENLABS_DEFAULT_MODEL || "eleven_flash_v2_5",
      ).trim();
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=ulaw_8000&optimize_streaming_latency=3`;
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        Math.max(1500, intEnv("PROVIDER_HEALTH_TTS_TIMEOUT_MS", 5000)),
      );
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            text: "Hi.",
            model_id: modelId,
            voice_settings: {
              stability: 0.65,
              similarity_boost: 0.8,
              style: 0.15,
              use_speaker_boost: true,
              speed: 0.92,
            },
          }),
          signal: controller.signal,
        });
        if (res.ok) {
          try {
            if (res.body && typeof res.body.cancel === "function")
              await res.body.cancel();
          } catch (_) {}
          console.log("[provider-health] elevenlabs tts/key check ok", {
            mode,
          });
          return setCachedProviderHealth(cacheKey, {
            ok: true,
            provider: "elevenlabs",
            code: "ok",
            preflightMode: mode,
            fallbackAvailable,
            required,
          });
        }
        const body = await res.text();
        const failed = {
          ok: false,
          provider: "elevenlabs",
          code: `http_${res.status}`,
          message: body.slice(0, 500),
          preflightMode: mode,
          fallbackAvailable,
          required,
        };
        console.warn("[provider-health] elevenlabs failed code=", failed.code);
        return setCachedProviderHealth(cacheKey, failed);
      } finally {
        clearTimeout(timeout);
      }
    }

    return {
      ok: true,
      provider: "elevenlabs",
      code: "configured",
      preflightMode: mode,
      fallbackAvailable,
      required,
    };
  } catch (err) {
    const failed = {
      ok: false,
      provider: "elevenlabs",
      code: err.name === "AbortError" ? "timeout" : "health_check_failed",
      message: err.message || String(err),
      preflightMode: mode,
      fallbackAvailable,
      required,
    };
    console.warn("[provider-health] elevenlabs failed code=", failed.code);
    return setCachedProviderHealth(cacheKey, failed);
  }
}

function scheduledFallbackAllowed(providerResult) {
  return (
    !elevenLabsRequired() &&
    fallbackProviderName() === "openai" &&
    providerResult?.provider === "elevenlabs"
  );
}

async function debugProviderHealth() {
  const openai = await checkOpenAIProvider();
  const elevenConfigured = Boolean(
    String(process.env.ELEVENLABS_API_KEY || "").trim(),
  );
  return {
    openai,
    elevenlabs: {
      configured: elevenConfigured,
      preflightMode: elevenLabsPreflightMode(),
      ok: elevenConfigured,
      lastError: null,
      fallbackAvailable: fallbackProviderName() === "openai",
      required: elevenLabsRequired(),
      cacheSeconds: providerHealthCacheSeconds(),
      cachedChecks: providerHealthCache.size,
    },
  };
}

async function createNotification(
  db,
  { organizationId, type, title, body, scheduleId, runId, leadId },
) {
  try {
    await db.from("tenant_notifications").insert({
      organization_id: organizationId,
      type,
      title,
      body,
      entity_type: runId ? "lead_outreach_run" : "lead_outreach_schedule",
      entity_id: runId || scheduleId || null,
      call_record_id: null,
      voice_agent_id: null,
      is_read: false,
      metadata: {
        scheduleId: scheduleId || null,
        runId: runId || null,
        leadId: leadId || null,
      },
    });
  } catch (err) {
    console.warn("[scheduler] notification skipped", {
      type,
      error: err.message || String(err),
    });
  }
}

async function updateRun(db, id, updates) {
  const { data, error } = await db
    .from("lead_outreach_runs")
    .update({ ...updates, updated_at: nowIso() })
    .eq("id", id)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function mergeOutcome(existing, patch) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? existing
      : {};
  const next =
    patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  return { ...base, ...next };
}

async function reserveRun(db, run) {
  const { data, error } = await db
    .from("lead_outreach_runs")
    .update({ status: "initiated", started_at: nowIso(), updated_at: nowIso() })
    .eq("id", run.id)
    .eq("status", "queued")
    .select()
    .maybeSingle();
  if (error) throw error;
  if (data) console.log("[outreach] run status initiated", { runId: data.id });
  return data || null;
}

async function loadContext(db, run) {
  const [
    { data: schedule },
    { data: lead },
    { data: agent },
    { data: organization },
  ] = await Promise.all([
    db
      .from("lead_outreach_schedules")
      .select("*")
      .eq("id", run.schedule_id)
      .eq("organization_id", run.organization_id)
      .maybeSingle(),
    run.lead_id
      ? db
          .from("leads")
          .select("*")
          .eq("id", run.lead_id)
          .eq("organization_id", run.organization_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db
      .from("voice_agents")
      .select("*")
      .eq("id", run.voice_agent_id)
      .eq("organization_id", run.organization_id)
      .maybeSingle(),
    db
      .from("organizations")
      .select("id,plan,outbound_call_limits,timezone")
      .eq("id", run.organization_id)
      .maybeSingle(),
  ]);
  let number = null;
  if (run.from_number_id || schedule?.from_number_id) {
    const result = await db
      .from("twilio_phone_numbers")
      .select("*")
      .eq("id", run.from_number_id || schedule.from_number_id)
      .eq("organization_id", run.organization_id)
      .maybeSingle();
    number = result.data || null;
  }
  if (!number && schedule?.from_number) {
    const result = await db
      .from("twilio_phone_numbers")
      .select("*")
      .eq("phone_number", schedule.from_number)
      .eq("organization_id", run.organization_id)
      .maybeSingle();
    number = result.data || null;
  }
  if (!number && agent?.twilio_phone_number) {
    const result = await db
      .from("twilio_phone_numbers")
      .select("*")
      .eq("phone_number", agent.twilio_phone_number)
      .eq("organization_id", run.organization_id)
      .maybeSingle();
    number = result.data || null;
  }
  return { schedule, lead, agent, number, organization };
}

function numberSupportsVoice(number) {
  const capabilities =
    typeof number?.capabilities === "string"
      ? JSON.parse(number.capabilities || "{}")
      : number?.capabilities || {};
  return !!capabilities.voice;
}

async function checkLimits(
  db,
  { organizationId, organization, schedule, currentRunId = null },
) {
  const limits = buildEffectiveSchedulerLimits({
    organization,
    schedule,
    env: process.env,
  });
  const maxConcurrent = limits.maxOrgConcurrentCalls;
  const maxOrgPerMinute = limits.maxOrgOutboundCallsPerMinute;
  const maxGlobalPerMinute = limits.maxGlobalOutboundCallsPerMinute;
  const maxOrgDaily = limits.maxOrgDailyOutboundCalls;
  const maxScheduleDaily = limits.maxScheduleCallsPerDay;
  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();

  const [activeConcurrency, orgMinute, globalMinute, orgDaily, scheduleDaily] =
    await Promise.all([
      fetchActiveConcurrency(db, organizationId, { currentRunId }),
      (async () => {
        let query = db
          .from("lead_outreach_runs")
          .select("id,twilio_call_sid,started_at,outcome_metadata")
          .eq("organization_id", organizationId)
          .gte("started_at", oneMinuteAgo);
        query = applyRealAttemptFilters(query);
        const { data, error } = await query;
        if (error) throw error;
        return (data || []).filter(
          (row) =>
            (!currentRunId || row.id !== currentRunId) &&
            !isResetOutcome(row.outcome_metadata),
        );
      })(),
      (async () => {
        let query = db
          .from("lead_outreach_runs")
          .select("id,twilio_call_sid,started_at,outcome_metadata")
          .gte("started_at", oneMinuteAgo);
        query = applyRealAttemptFilters(query);
        const { data, error } = await query;
        if (error) throw error;
        return (data || []).filter(
          (row) =>
            (!currentRunId || row.id !== currentRunId) &&
            !isResetOutcome(row.outcome_metadata),
        );
      })(),
      fetchDailyUsage(db, { organizationId, currentRunId }),
      fetchDailyUsage(db, {
        organizationId,
        scheduleId: schedule?.id || null,
        currentRunId,
      }),
    ]);

  if (activeConcurrency.activeCount >= maxConcurrent)
    return {
      ok: false,
      code: "ORG_CONCURRENCY_LIMIT",
      message: "Organization concurrent scheduled-call limit reached.",
      limits,
      activeConcurrency,
      concurrentCount: activeConcurrency.activeCount,
      countedRunIds: activeConcurrency.countedRunIds,
      activeWindowMinutes: activeCallWindowMinutes(),
    };
  if ((orgMinute || []).length >= maxOrgPerMinute)
    return {
      ok: false,
      code: "ORG_RATE_LIMIT",
      message: "Organization scheduled-call rate limit reached.",
      limits,
      countedRunIds: orgMinute.map((row) => row.id),
      countedMinuteRuns: orgMinute.length,
    };
  if ((globalMinute || []).length >= maxGlobalPerMinute)
    return {
      ok: false,
      code: "GLOBAL_RATE_LIMIT",
      message: "Global scheduled-call rate limit reached.",
      limits,
      countedRunIds: globalMinute.map((row) => row.id),
      countedMinuteRuns: globalMinute.length,
    };
  if (orgDaily.realTwilioCallsToday >= maxOrgDaily)
    return {
      ok: false,
      code: "ORG_DAILY_LIMIT",
      message: "Organization daily scheduled outbound call limit reached.",
      limits,
      dailyUsage: orgDaily,
      countedDailyRuns: orgDaily.realTwilioCallsToday,
      countedRunIds: orgDaily.countedRunIds,
    };
  if (scheduleDaily.realTwilioCallsToday >= maxScheduleDaily)
    return {
      ok: false,
      code: "SCHEDULE_DAILY_LIMIT",
      message: "Schedule daily outbound call limit reached.",
      limits,
      dailyUsage: scheduleDaily,
      countedDailyRuns: scheduleDaily.realTwilioCallsToday,
      countedRunIds: scheduleDaily.countedRunIds,
    };
  return {
    ok: true,
    limits,
    activeConcurrency,
    dailyUsage: {
      organization: orgDaily,
      schedule: scheduleDaily,
    },
  };
}

async function createCallRecord(
  db,
  { run, schedule, lead, agent, number, toPhone, providerMetadata = {} },
) {
  const outcomeMetadata =
    run?.outcome_metadata && typeof run.outcome_metadata === "object"
      ? run.outcome_metadata
      : {};
  const scheduleMetadata =
    schedule?.metadata && typeof schedule.metadata === "object"
      ? schedule.metadata
      : {};
  const platformTestMode =
    scheduleMetadata.platformTestMode === true ||
    outcomeMetadata.platformTestMode === true;
  const platformTestEventId =
    scheduleMetadata.platformTestEventId ||
    outcomeMetadata.platformTestEventId ||
    "";
  const maxCallSeconds =
    scheduleMetadata.maxCallSeconds || outcomeMetadata.maxCallSeconds || null;
  const recipientName =
    lead?.name ||
    run?.target_name ||
    outcomeMetadata?.recipientName ||
    outcomeMetadata?.targetName ||
    "";
  const row = {
    organization_id: run.organization_id,
    voice_agent_id: agent.id,
    caller_name: recipientName,
    caller_phone: toPhone,
    duration: 0,
    outcome: "queued",
    summary: "",
    transcript: [],
    lead_id: lead?.id || run.lead_id || null,
    timestamp: nowIso(),
    provider: "twilio",
    direction: "outbound",
    status: "queued",
    started_at: nowIso(),
    metadata: {
      source: "scheduled_outbound_call",
      scheduleId: schedule.id,
      scheduleRunId: run.id,
      fromNumberId: number?.id || null,
      fromNumber:
        number?.phone_number ||
        schedule.from_number ||
        agent.twilio_phone_number ||
        "",
      toPhone,
      leadId: lead?.id || run.lead_id || null,
      recipientName,
      targetName: run?.target_name || recipientName,
      directRecipient: outcomeMetadata?.directRecipient || null,
      callPurpose: schedule.call_purpose || "",
      customInstructions: schedule.custom_instructions || "",
      platformTestMode,
      platformTestEventId: platformTestEventId || null,
      maxCallSeconds: maxCallSeconds || null,
      billing: {
        source: "scheduled_outbound",
        schedule_id: schedule.id,
        run_id: run.id,
      },
      provider: providerMetadata,
    },
  };
  const { data, error } = await db
    .from("call_records")
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function processRun(db, rawRun) {
  const run = await reserveRun(db, rawRun);
  if (!run) return { skipped: true, reason: "already_reserved" };
  console.log("[outreach] scheduler picked run", {
    runId: run.id,
    scheduleId: run.schedule_id,
    organizationId: run.organization_id,
  });

  try {
    const context = await loadContext(db, run);
    const { schedule, lead, agent, number, organization } = context;
    if (
      !schedule ||
      schedule.status !== "active" ||
      schedule.is_active === false
    ) {
      await updateRun(db, run.id, {
        status: "failed",
        completed_at: nowIso(),
        error_code: "SCHEDULE_NOT_ACTIVE",
        error_message: "Schedule is not active.",
      });
      return { skipped: true, reason: "schedule_not_active" };
    }
    const runDestination = cleanPhone(
      run.destination_phone || run.target_phone || "",
    );
    if (!lead && !isE164(runDestination)) {
      await updateRun(db, run.id, {
        status: "failed",
        completed_at: nowIso(),
        error_code: "RECIPIENT_NOT_FOUND",
        error_message: "Run has no lead and no valid direct destination phone.",
      });
      return { skipped: true, reason: "recipient_not_found" };
    }
    if (
      lead &&
      (["contacted", "closed", "resolved", "opted_out", "do_not_call"].includes(
        String(lead.status || "").toLowerCase(),
      ) ||
        lead.opted_out === true)
    ) {
      await updateRun(db, run.id, {
        status: "failed",
        completed_at: nowIso(),
        error_code: "LEAD_STOP_CONDITION",
        error_message: "Lead status indicates no further calls.",
      });
      return { skipped: true, reason: "lead_stop_condition" };
    }
    if (!agent?.is_active) {
      await updateRun(db, run.id, {
        status: "failed",
        completed_at: nowIso(),
        error_code: "AGENT_NOT_READY",
        error_message: "Voice agent missing or inactive.",
      });
      return { failed: true, reason: "agent_not_ready" };
    }
    if (!number || !numberSupportsVoice(number)) {
      await updateRun(db, run.id, {
        status: "failed",
        completed_at: nowIso(),
        error_code: "NUMBER_NOT_READY",
        error_message: "From-number missing or does not support voice.",
      });
      return { failed: true, reason: "number_not_ready" };
    }
    if (
      number.outbound_voice_status &&
      number.outbound_voice_status !== "ready"
    ) {
      const strict = strictNumberReadinessEnabled();
      console.warn(
        "[outreach] from-number outbound voice status is not ready",
        {
          runId: run.id,
          scheduleId: run.schedule_id,
          numberId: number.id,
          phoneNumber: number.phone_number,
          outboundVoiceStatus: number.outbound_voice_status,
          strict,
        },
      );
      if (strict) {
        await updateRun(db, run.id, {
          status: "failed",
          completed_at: nowIso(),
          error_code: "OUTBOUND_VOICE_NOT_READY",
          error_message: "From-number is not ready for outbound voice.",
          outcome_metadata: mergeOutcome(run.outcome_metadata, {
            numberReadinessWarning: number.outbound_voice_status,
            strictNumberReadiness: true,
          }),
        });
        return { failed: true, reason: "outbound_voice_not_ready" };
      }
    }

    const toPhone = cleanPhone(
      run.destination_phone || run.target_phone || lead?.phone || "",
    );
    if (!isE164(toPhone)) {
      await updateRun(db, run.id, {
        status: "failed",
        completed_at: nowIso(),
        error_code: "INVALID_DESTINATION",
        error_message: "Lead phone is not valid E.164.",
      });
      return { skipped: true, reason: "invalid_destination" };
    }

    const destinationCountry = guessCountryFromE164(toPhone);
    const selected = voiceCountriesForNumber(number, destinationCountry);
    if (!selected.has(destinationCountry) && destinationCountry !== "UNKNOWN") {
      const strict = strictNumberReadinessEnabled();
      console.warn("[outreach] destination country not explicitly enabled", {
        runId: run.id,
        scheduleId: run.schedule_id,
        numberId: number.id,
        destinationCountry,
        enabledCountries: [...selected],
        strict,
      });
      if (strict) {
        await updateRun(db, run.id, {
          status: "failed",
          completed_at: nowIso(),
          error_code: "COUNTRY_NOT_ENABLED",
          error_message: `Outbound calls to ${destinationCountry} are not enabled for this number.`,
          outcome_metadata: mergeOutcome(run.outcome_metadata, {
            destinationCountry,
            enabledCountries: [...selected],
            outcome: "failed",
            strictNumberReadiness: true,
          }),
        });
        return { blocked: true, reason: "country_not_enabled" };
      }
    }

    const limits = await checkLimits(db, {
      organizationId: run.organization_id,
      organization,
      schedule,
      currentRunId: run.id,
    });
    if (!limits.ok) {
      const isConcurrency = limits.code === "ORG_CONCURRENCY_LIMIT";
      const isDaily = ["ORG_DAILY_LIMIT", "SCHEDULE_DAILY_LIMIT"].includes(
        limits.code,
      );
      const isRate = ["ORG_RATE_LIMIT", "GLOBAL_RATE_LIMIT"].includes(
        limits.code,
      );
      const deferredReason = isConcurrency
        ? "concurrency_limit"
        : isDaily
          ? "daily_limit"
          : isRate
            ? "rate_limit"
            : String(limits.code || "limit").toLowerCase();
      const displayOutcome = isConcurrency
        ? "deferred_concurrency_limit"
        : isDaily
          ? "deferred_daily_limit"
          : "retry_scheduled";
      const outcomePatch = {
        deferred_reason: deferredReason,
        displayOutcome,
        limits: limits.limits || null,
        dailyUsage: limits.dailyUsage || null,
        activeConcurrency: limits.activeConcurrency || null,
        countedRunIds: limits.countedRunIds || [],
        countedDailyRuns: limits.countedDailyRuns ?? null,
        deferredAt: nowIso(),
        retryAt: "next scheduler tick",
      };
      console.warn(`[outreach] ${limitLogLabel(limits.code)}`, {
        runId: run.id,
        code: limits.code,
        limits: limits.limits || null,
        countedDailyRuns: limits.countedDailyRuns ?? null,
        countedRunIds: limits.countedRunIds || [],
        activeConcurrency: limits.activeConcurrency || null,
        dailyUsage: limits.dailyUsage || null,
      });
      console.warn("[outreach] run deferred", {
        runId: run.id,
        reason: limits.code,
      });
      await updateRun(db, run.id, {
        status: "queued",
        started_at: null,
        completed_at: null,
        error_code: limits.code,
        error_message: limits.message,
        outcome_metadata: mergeOutcome(run.outcome_metadata, outcomePatch),
      });
      console.log("[outreach] run remains queued", {
        runId: run.id,
        reason: limits.code,
      });
      return { deferred: true, reason: limits.code };
    }
    if (run.outcome_metadata?.deferred_reason) {
      console.log("[outreach] capacity available, retrying deferred run", {
        runId: run.id,
        previousDeferredReason: run.outcome_metadata.deferred_reason,
      });
    }

    const openai = await checkOpenAIProvider();
    if (!openai.ok) {
      const key = `${run.organization_id}:openai`;
      providerFailureCounts.set(key, (providerFailureCounts.get(key) || 0) + 1);
      await updateRun(db, run.id, {
        status: "failed",
        completed_at: nowIso(),
        error_code: `OPENAI_${openai.code}`.toUpperCase(),
        error_message: openai.message || openai.code,
        outcome_metadata: { provider: openai },
      });
      await createNotification(db, {
        organizationId: run.organization_id,
        type: "provider_failure",
        title: "Scheduled call blocked",
        body: "OpenAI is unavailable, so a scheduled call was not placed.",
        scheduleId: run.schedule_id,
        runId: run.id,
        leadId: run.lead_id || null,
      });
      return { blocked: true, reason: "openai_unavailable" };
    }
    const eleven = await checkElevenLabsProviderIfNeeded(agent);
    let voiceProviderOverride = "";
    const scheduledProviderMode = scheduledCallVoiceProviderMode();
    const agentDefaultProvider = String(
      agent?.voice_provider || process.env.VOICE_PROVIDER_DEFAULT || "openai",
    ).toLowerCase();
    if (scheduledProviderMode !== "agent_default") {
      voiceProviderOverride = scheduledProviderMode;
      console.log("[voice-quality] scheduled call provider=", {
        runId: run.id,
        provider: scheduledProviderMode,
      });
    }
    let providerMetadata = {
      voice_provider_requested: agentDefaultProvider,
      voice_provider_used: voiceProviderOverride || agentDefaultProvider,
      scheduled_call_voice_provider_mode: scheduledProviderMode,
      preflight: { elevenlabs: eleven },
    };
    if (!eleven.ok) {
      const key = `${run.organization_id}:elevenlabs`;
      providerFailureCounts.set(key, (providerFailureCounts.get(key) || 0) + 1);
      if (scheduledFallbackAllowed(eleven)) {
        console.warn("[provider-health] falling back to openai", {
          runId: run.id,
          code: eleven.code,
        });
        console.warn("[outreach] provider fallback used runId=", run.id);
        console.log("[outreach] creating Twilio call after fallback", {
          runId: run.id,
        });
        voiceProviderOverride = "openai";
        providerMetadata = {
          voice_provider_requested: "elevenlabs",
          voice_provider_used: "openai",
          fallback_reason: `ELEVENLABS_${eleven.code}`.toUpperCase(),
          elevenlabs_error: {
            code: eleven.code,
            message: eleven.message || eleven.code,
            preflightMode: eleven.preflightMode || null,
          },
          preflight: { elevenlabs: eleven },
        };
        await updateRun(db, run.id, {
          outcome_metadata: {
            ...(run.outcome_metadata || {}),
            provider: providerMetadata,
          },
        });
      } else {
        console.warn("[outreach] run failed provider required no fallback", {
          runId: run.id,
          code: eleven.code,
        });
        await updateRun(db, run.id, {
          status: "failed",
          completed_at: nowIso(),
          error_code: `ELEVENLABS_${eleven.code}`.toUpperCase(),
          error_message: eleven.message || eleven.code,
          outcome_metadata: { provider: eleven },
        });
        await createNotification(db, {
          organizationId: run.organization_id,
          type: "provider_failure",
          title: "Scheduled call blocked",
          body: "ElevenLabs is unavailable or the agent voice is not configured, so a scheduled call was not placed.",
          scheduleId: run.schedule_id,
          runId: run.id,
          leadId: run.lead_id || null,
        });
        return { blocked: true, reason: "elevenlabs_unavailable" };
      }
    }

    const record = await createCallRecord(db, {
      run,
      schedule,
      lead,
      agent,
      number,
      toPhone,
      providerMetadata,
    });
    const config = getSchedulerConfig();
    if (!config.valid) {
      console.error("[scheduler] config invalid after run started", {
        runId: run.id,
        errors: config.configErrors,
      });
      await updateRun(db, run.id, {
        status: "queued",
        started_at: null,
        error_code: "INVALID_RUNTIME_CONFIG",
        error_message: config.configErrors.join(" "),
        outcome_metadata: {
          ...(run.outcome_metadata || {}),
          config: {
            invalid: true,
            errors: config.configErrors,
            resetToQueuedAt: nowIso(),
          },
        },
      });
      return { deferred: true, reason: "invalid_config" };
    }
    const base = config.apiUrl;
    const outcomeMetadata =
      run?.outcome_metadata && typeof run.outcome_metadata === "object"
        ? run.outcome_metadata
        : {};
    const scheduleMetadata =
      schedule?.metadata && typeof schedule.metadata === "object"
        ? schedule.metadata
        : {};
    const platformTestMode =
      scheduleMetadata.platformTestMode === true ||
      outcomeMetadata.platformTestMode === true;
    const platformTestEventId =
      scheduleMetadata.platformTestEventId ||
      outcomeMetadata.platformTestEventId ||
      "";
    const maxCallSeconds =
      scheduleMetadata.maxCallSeconds || outcomeMetadata.maxCallSeconds || null;
    const recipientName =
      lead?.name ||
      run?.target_name ||
      outcomeMetadata?.recipientName ||
      outcomeMetadata?.targetName ||
      "";
    const targetName = run?.target_name || recipientName || "";
    const voicemailSettings = readVoicemailSettings(agent || {});
    const twimlUrl = encodeOutboundTwiMlUrl(base, {
      orgId: run.organization_id,
      agentId: agent.id,
      callRecordId: record.id,
      direction: "outbound",
      recipientPhone: toPhone,
      recipientName,
      targetName,
      callerPhone:
        number.phone_number ||
        schedule.from_number ||
        agent.twilio_phone_number,
      leadId: lead?.id || null,
      scheduleId: schedule.id,
      scheduleRunId: run.id,
      callPurpose: schedule.call_purpose || "",
      customInstructions: schedule.custom_instructions || "",
      voiceProviderOverride,
      voiceProviderFallbackReason: providerMetadata.fallback_reason || "",
      maxCallSeconds: maxCallSeconds || undefined,
      platformTestMode: platformTestMode ? "true" : undefined,
      platformTestEventId: platformTestEventId || undefined,
      voicemailBehavior: voicemailSettings.action,
      voicemailMessage: voicemailSettings.message,
      voicemailCallbackDelayMinutes: voicemailSettings.callbackDelayMinutes,
      voicemailMaxRedialAttempts: voicemailSettings.maxRedialAttempts,
    });
    console.log("[outreach] outbound twiml url=", twimlUrl);
    console.log(
      "[outreach] media stream url=",
      config.twilioWsUrl
        ? buildUrl(config.twilioWsUrl, "/api/twilio/media-stream")
        : "",
    );

    const result = await makeOutboundCall({
      from:
        number.phone_number ||
        schedule.from_number ||
        agent.twilio_phone_number,
      to: toPhone,
      twimlUrl,
      statusCallbackUrl: buildStatusCallbackUrl(base),
      amdStatusCallbackUrl: buildAmdStatusCallbackUrl(base),
      machineDetection:
        process.env.OUTBOUND_MACHINE_DETECTION ||
        machineDetectionModeForSettings(voicemailSettings),
      asyncAmd: true,
      recordingStatusCallbackUrl: buildRecordingStatusCallbackUrl(base),
    });
    await db
      .from("call_records")
      .update({
        twilio_call_sid: result.callSid,
        status: result.status || "initiated",
      })
      .eq("id", record.id);
    await updateRun(db, run.id, {
      status: "initiated",
      twilio_call_sid: result.callSid,
      call_record_id: record.id,
      error_code: null,
      error_message: null,
      outcome_metadata: {
        ...(run.outcome_metadata || {}),
        provider: providerMetadata,
        twilioStatus: result.status,
        callRecordId: record.id,
        recipientName,
        targetName,
      },
    });
    if (lead?.id) {
      await db
        .from("leads")
        .update({
          source: "outbound_call",
          voice_agent_id: agent.id,
          updated_at: nowIso(),
        })
        .eq("id", lead.id)
        .eq("organization_id", run.organization_id);
    }
    console.log("[scheduler] queued scheduled outbound call", {
      runId: run.id,
      callSid: result.callSid,
      callRecordId: record.id,
      limits: limits.limits || null,
    });
    return { success: true, runId: run.id, callSid: result.callSid };
  } catch (err) {
    console.error("[outreach] run failed reason=", {
      runId: run.id,
      reason: err.message || String(err),
    });
    await updateRun(db, run.id, {
      status: "failed",
      completed_at: nowIso(),
      error_code: "WORKER_ERROR",
      error_message: err.message || String(err),
    });
    return { failed: true, error: err.message || String(err) };
  }
}

async function resetStaleNoSidRuns(db) {
  const cutoff = new Date(
    Date.now() - staleNoSidResetMinutes() * 60_000,
  ).toISOString();
  const { data, error } = await db
    .from("lead_outreach_runs")
    .update({
      status: "failed",
      completed_at: nowIso(),
      error_code: "STALE_INITIATED_NO_TWILIO_SID",
      error_message:
        "Scheduler reset this run because it was initiated but no Twilio call SID was created.",
      outcome_metadata: {
        autoResetReason: "stale_initiated_without_twilio_sid",
        autoResetAt: nowIso(),
      },
    })
    .eq("status", "initiated")
    .lt("started_at", cutoff)
    .is("twilio_call_sid", null)
    .select("id");
  if (error) {
    console.warn("[scheduler] stale no-sid reset skipped", {
      error: error.message || String(error),
    });
    return 0;
  }
  if ((data || []).length) {
    console.warn("[scheduler] stale initiated no-sid runs marked failed", {
      count: data.length,
      cutoff,
    });
  }
  return (data || []).length;
}

async function executeDueSchedules() {
  if (!schedulerEnabled()) return { skipped: true, reason: "disabled" };
  const config = getSchedulerConfig();
  if (!config.valid) {
    console.error("[scheduler] disabled invalid config");
    console.error("[scheduler] config invalid, leaving runs queued", {
      errors: config.configErrors,
    });
    return {
      skipped: true,
      reason: "invalid_config",
      configErrors: config.configErrors,
    };
  }
  if (runInProgress) return { skipped: true, reason: "already_running" };
  runInProgress = true;
  const summary = {
    processed: 0,
    queued: 0,
    failed: 0,
    skipped: 0,
    blocked: 0,
    deferred: 0,
  };
  try {
    const db = getSupabase();
    summary.staleNoSidReset = await resetStaleNoSidRuns(db);
    const limit = intEnv("SCHEDULER_MAX_RUNS_PER_TICK", 20);
    const { data: runs, error } = await db
      .from("lead_outreach_runs")
      .select("*")
      .eq("status", "queued")
      .lte("scheduled_for", nowIso())
      .order("scheduled_for", { ascending: true })
      .limit(limit);
    if (error) throw error;
    summary.dueRunsFound = (runs || []).length;
    for (const run of runs || []) {
      const result = await processRun(db, run);
      summary.processed += 1;
      if (result?.success) summary.queued += 1;
      else if (result?.failed) summary.failed += 1;
      else if (result?.blocked) summary.blocked += 1;
      else if (result?.deferred) summary.deferred += 1;
      else summary.skipped += 1;
    }
    if (summary.processed) console.log("[scheduler] tick complete", summary);
    return summary;
  } catch (err) {
    console.error("[scheduler] tick failed", err.message || String(err));
    return { ...summary, error: err.message || String(err) };
  } finally {
    runInProgress = false;
  }
}

async function debugSchedule(scheduleId) {
  const db = getSupabase();
  const [
    { data: schedule, error: scheduleError },
    { data: runs, error: runsError },
    { data: records, error: recordsError },
  ] = await Promise.all([
    db
      .from("lead_outreach_schedules")
      .select("*")
      .eq("id", scheduleId)
      .maybeSingle(),
    db
      .from("lead_outreach_runs")
      .select("*")
      .eq("schedule_id", scheduleId)
      .order("scheduled_for", { ascending: true }),
    db
      .from("call_records")
      .select("*")
      .filter("metadata->>scheduleId", "eq", scheduleId),
  ]);
  if (scheduleError) throw scheduleError;
  if (runsError) throw runsError;
  if (recordsError) throw recordsError;
  const callRecordsById = new Map(
    (records || []).map((record) => [record.id, record]),
  );
  const serverNow = new Date();
  const recipients = (runs || []).map((run) => {
    const record = run.call_record_id
      ? callRecordsById.get(run.call_record_id)
      : null;
    const scheduledForDate = run.scheduled_for
      ? new Date(run.scheduled_for)
      : null;
    const due =
      String(run.status || "") === "queued" &&
      scheduledForDate instanceof Date &&
      !Number.isNaN(scheduledForDate.getTime()) &&
      scheduledForDate <= serverNow;
    const whyNotDue = due
      ? null
      : String(run.status || "") !== "queued"
        ? `status_${run.status || "unknown"}`
        : !scheduledForDate
          ? "missing_scheduled_for"
          : scheduledForDate > serverNow
            ? "scheduled_for_future"
            : "unknown";
    return {
      ...serializeRun(run),
      due,
      whyNotDue,
      serverNowUtc: serverNow.toISOString(),
      displayOutcome: detailedOutcome(run),
      displayStatus: displayStatusForRun(run),
      durationSeconds: durationSecondsForRun(run),
      linkedCallRecord: record || null,
      providerUsed:
        run.outcome_metadata?.provider?.voice_provider_used ||
        record?.metadata?.provider?.voice_provider_used ||
        null,
      concurrencyDecision:
        run.outcome_metadata?.deferred_reason ||
        run.outcome_metadata?.displayOutcome ||
        null,
    };
  });
  const counts = recipients.reduce((acc, run) => {
    const outcome = run.outcome || "queued";
    acc[outcome] = (acc[outcome] || 0) + 1;
    return acc;
  }, {});
  return {
    ok: true,
    serverNowUtc: serverNow.toISOString(),
    schedule: schedule || null,
    summary: { total: recipients.length, ...counts },
    recipients,
    callRecords: records || [],
    voiceQuality: {
      scheduledCallVoiceProvider:
        process.env.SCHEDULED_CALL_VOICE_PROVIDER || "agent_default",
      maxAssistantSentenceCount: Number(
        process.env.SCHEDULED_CALL_MAX_ASSISTANT_SENTENCE_COUNT || 2,
      ),
      waitForUserAfterGreeting:
        String(
          process.env.SCHEDULED_CALL_WAIT_FOR_USER_AFTER_GREETING || "true",
        ).toLowerCase() !== "false",
      disableMonologue:
        String(
          process.env.SCHEDULED_CALL_DISABLE_MONOLOGUE || "true",
        ).toLowerCase() !== "false",
    },
  };
}

async function debugCleanSlate({
  organizationId,
  scheduleId,
  dryRun = false,
  resetLinked = false,
  resetLinkedOlderThanMinutes = 2,
} = {}) {
  const db = getSupabase();
  const targetOrgId = String(organizationId || "").trim();
  const targetScheduleId = String(scheduleId || "").trim();
  const shouldDryRun =
    dryRun === true || String(dryRun || "").toLowerCase() === "true";
  const shouldResetLinked =
    resetLinked === true || String(resetLinked || "").toLowerCase() === "true";
  const linkedCutoff = new Date(
    Date.now() - Math.max(1, Number(resetLinkedOlderThanMinutes || 2)) * 60_000,
  ).toISOString();
  if (!targetOrgId && !targetScheduleId) {
    const error = new Error(
      "organizationId or scheduleId is required for clean slate.",
    );
    error.code = "CLEAN_SLATE_TARGET_REQUIRED";
    throw error;
  }

  let noCallQuery = db
    .from("lead_outreach_runs")
    .select("id,schedule_id,status,twilio_call_sid,call_record_id,started_at")
    .is("call_record_id", null)
    .in("status", ["queued", "initiated", "failed", "completed"]);
  if (targetOrgId) noCallQuery = noCallQuery.eq("organization_id", targetOrgId);
  if (targetScheduleId)
    noCallQuery = noCallQuery.eq("schedule_id", targetScheduleId);
  const { data: noCallRows, error: noCallError } = await noCallQuery;
  if (noCallError) throw noCallError;
  const noCallTargets = (noCallRows || []).filter(
    (row) => !hasUsableTwilioSid(row.twilio_call_sid),
  );

  let linkedTargets = [];
  if (shouldResetLinked) {
    let linkedQuery = db
      .from("lead_outreach_runs")
      .select(
        "id,schedule_id,status,twilio_call_sid,call_record_id,started_at,outcome_metadata",
      )
      .eq("status", "initiated")
      .lt("started_at", linkedCutoff)
      .not("twilio_call_sid", "is", null)
      .neq("twilio_call_sid", "");
    if (targetOrgId)
      linkedQuery = linkedQuery.eq("organization_id", targetOrgId);
    if (targetScheduleId)
      linkedQuery = linkedQuery.eq("schedule_id", targetScheduleId);
    const { data, error } = await linkedQuery;
    if (error) throw error;
    const recordMap = await fetchCallRecordsByIds(
      db,
      (data || []).map((row) => row.call_record_id),
    );
    linkedTargets = (data || []).filter((row) => {
      const record = row.call_record_id
        ? recordMap.get(row.call_record_id)
        : null;
      if (!record) return true;
      const status = record.status || record.outcome;
      return (
        isTerminalCallStatus(status) || record.completed_at || record.ended_at
      );
    });
  }

  const scheduleIds = [
    ...new Set(
      [...noCallTargets, ...linkedTargets]
        .map((run) => run.schedule_id)
        .filter(Boolean),
    ),
  ];

  if (shouldDryRun) {
    return {
      ok: true,
      dryRun: true,
      runsMatched: noCallTargets.length,
      runsDeleted: 0,
      linkedRunsMatched: linkedTargets.length,
      linkedRunsReset: 0,
      schedulesTouched: scheduleIds.length,
      schedulesDeleted: 0,
      note: "Dry run only. Matched no-call scheduled runs and optional old linked initiated runs.",
    };
  }

  let deletedRuns = [];
  if (noCallTargets.length) {
    const { data, error } = await db
      .from("lead_outreach_runs")
      .delete()
      .in(
        "id",
        noCallTargets.map((run) => run.id),
      )
      .select("id,schedule_id,status");
    if (error) throw error;
    deletedRuns = data || [];
  }

  let resetLinkedRows = [];
  if (linkedTargets.length) {
    const { data, error } = await db
      .from("lead_outreach_runs")
      .update({
        status: "completed",
        completed_at: nowIso(),
        error_code: null,
        error_message: null,
        outcome_metadata: {
          reset_reason: "debug_clean_slate_linked_terminal_call",
          debugResetAt: nowIso(),
          note: "Debug clean slate marked an old linked initiated run terminal so it no longer occupies active concurrency.",
        },
      })
      .in(
        "id",
        linkedTargets.map((run) => run.id),
      )
      .select("id,schedule_id,status");
    if (error) throw error;
    resetLinkedRows = data || [];
  }

  let deletedSchedules = [];
  if (targetScheduleId) {
    const { count } = await db
      .from("lead_outreach_runs")
      .select("id", { count: "exact", head: true })
      .eq("schedule_id", targetScheduleId);
    if (!count) {
      const { data, error } = await db
        .from("lead_outreach_schedules")
        .delete()
        .eq("id", targetScheduleId)
        .select("id");
      if (error) throw error;
      deletedSchedules = data || [];
    }
  } else if (targetOrgId) {
    for (const id of scheduleIds) {
      const { count } = await db
        .from("lead_outreach_runs")
        .select("id", { count: "exact", head: true })
        .eq("schedule_id", id);
      if (!count) {
        const { data, error } = await db
          .from("lead_outreach_schedules")
          .delete()
          .eq("id", id)
          .eq("organization_id", targetOrgId)
          .select("id");
        if (!error && data?.length) deletedSchedules.push(...data);
      }
    }
  }

  console.warn("[debug/clean-slate] cleaned scheduled test rows", {
    organizationId: targetOrgId || null,
    scheduleId: targetScheduleId || null,
    runsDeleted: deletedRuns.length,
    linkedRunsReset: resetLinkedRows.length,
    schedulesDeleted: deletedSchedules.length,
  });

  return {
    ok: true,
    dryRun: false,
    runsMatched: noCallTargets.length,
    runsDeleted: deletedRuns.length,
    linkedRunsMatched: linkedTargets.length,
    linkedRunsReset: resetLinkedRows.length,
    schedulesTouched: scheduleIds.length,
    schedulesDeleted: deletedSchedules.length,
    note: "Deleted no-call scheduled runs and, when requested, reset old linked terminal initiated runs. Call records were preserved.",
  };
}

async function debugSchedulerLimits({ organizationId, scheduleId } = {}) {
  const db = getSupabase();
  const targetOrgId = String(organizationId || "").trim();
  const targetScheduleId = String(scheduleId || "").trim();
  if (!targetOrgId) {
    return {
      ok: false,
      error: "organizationId is required for scheduler limits debug.",
    };
  }
  let organization = null;
  let schedule = null;
  try {
    const { data } = await db
      .from("organizations")
      .select("id,plan,outbound_call_limits,timezone")
      .eq("id", targetOrgId)
      .maybeSingle();
    organization = data || null;
  } catch (err) {
    organization = null;
  }
  if (targetScheduleId) {
    const { data } = await db
      .from("lead_outreach_schedules")
      .select("*")
      .eq("id", targetScheduleId)
      .maybeSingle();
    schedule = data || null;
  }
  const limits = buildEffectiveSchedulerLimits({
    organization,
    schedule,
    env: process.env,
  });
  const [dailyUsage, activeConcurrency] = await Promise.all([
    fetchDailyUsage(db, {
      organizationId: targetOrgId,
      scheduleId: targetScheduleId || null,
    }),
    fetchActiveConcurrency(db, targetOrgId),
  ]);
  return {
    ok: true,
    organizationId: targetOrgId,
    scheduleId: targetScheduleId || null,
    limits: {
      maxOrgDailyOutboundCalls: limits.maxOrgDailyOutboundCalls,
      maxOrgConcurrentCalls: limits.maxOrgConcurrentCalls,
      maxOrgOutboundCallsPerMinute: limits.maxOrgOutboundCallsPerMinute,
      maxScheduleCallsPerDay: limits.maxScheduleCallsPerDay,
    },
    dailyUsage,
    concurrency: activeConcurrency,
  };
}

function startLeadScheduler() {
  console.log("[scheduler] startup requested");
  console.log("[scheduler] enabled env=", schedulerEnabled());
  if (!schedulerEnabled()) {
    console.log(
      "[scheduler] disabled by SCHEDULER_ENABLED/ENABLE_LEAD_SCHEDULER.",
    );
    console.log("[scheduler] not started reason=disabled_env");
    return () => {};
  }
  const config = getSchedulerConfig();
  console.log("[scheduler] config valid=", config.valid);
  if (!config.valid) {
    console.error("[scheduler] disabled invalid config");
    console.error("[scheduler] config invalid, leaving runs queued", {
      errors: config.configErrors,
    });
    console.log("[scheduler] not started reason=invalid_config");
    return () => {};
  }
  if (schedulerTimer) return () => clearInterval(schedulerTimer);
  const intervalMs = Math.max(
    15_000,
    intEnv("SCHEDULER_POLL_INTERVAL_SECONDS", 60) * 1000,
  );
  console.log("[scheduler] poll interval seconds=", intervalMs / 1000);
  void executeDueSchedules();
  schedulerTimer = setInterval(() => void executeDueSchedules(), intervalMs);
  console.log("[scheduler] worker started");
  console.log(`[scheduler] running every ${intervalMs / 1000}s.`);
  return () => {
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = null;
  };
}

module.exports = {
  startLeadScheduler,
  executeDueSchedules,
  processRun,
  debugProviderHealth,
  debugSchedule,
  debugCleanSlate,
  debugSchedulerLimits,
  checkElevenLabsProviderIfNeeded,
};
