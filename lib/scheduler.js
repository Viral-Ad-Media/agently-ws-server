"use strict";

const { getSupabase } = require("./supabase");
const { makeOutboundCall } = require("./twilio");
const {
  isE164,
  cleanPhone,
  guessCountryFromE164,
  normalizeCountry,
  jsonArray,
  serializeRun,
  buildEffectiveSchedulerLimits,
} = require("./outreach-utils");

let schedulerTimer = null;
let runInProgress = false;
const providerFailureCounts = new Map();

function nowIso() {
  return new Date().toISOString();
}

function apiBaseUrl() {
  return (process.env.API_URL || "").replace(/\/$/, "");
}

function intEnv(name, fallback) {
  const parsed = parseInt(process.env[name] || String(fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    query.set(key, String(value));
  });
  return `${base}/api/twilio/outbound-twiml?${query.toString()}`;
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
  if (
    String(
      process.env.SCHEDULER_PROVIDER_HTTP_CHECKS || "false",
    ).toLowerCase() !== "true"
  ) {
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
        modalities: ["text"],
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
  if (provider !== "elevenlabs")
    return { ok: true, provider: "elevenlabs", code: "not_selected" };
  const apiKey = String(process.env.ELEVENLABS_API_KEY || "").trim();
  if (!apiKey)
    return {
      ok: false,
      provider: "elevenlabs",
      code: "missing_api_key",
      message: "ELEVENLABS_API_KEY is not configured.",
    };
  if (!agent?.voice_id && !agent?.voice_catalog_id) {
    return {
      ok: false,
      provider: "elevenlabs",
      code: "missing_voice_id",
      message: "Agent has no ElevenLabs voice_id or voice_catalog_id.",
    };
  }
  if (
    String(
      process.env.SCHEDULER_PROVIDER_HTTP_CHECKS || "false",
    ).toLowerCase() !== "true"
  ) {
    return { ok: true, provider: "elevenlabs", code: "configured" };
  }
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user", {
      headers: { "xi-api-key": apiKey },
    });
    if (res.ok) return { ok: true, provider: "elevenlabs", code: "ok" };
    return {
      ok: false,
      provider: "elevenlabs",
      code: `http_${res.status}`,
      message: (await res.text()).slice(0, 500),
    };
  } catch (err) {
    return {
      ok: false,
      provider: "elevenlabs",
      code: "health_check_failed",
      message: err.message || String(err),
    };
  }
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

async function reserveRun(db, run) {
  const { data, error } = await db
    .from("lead_outreach_runs")
    .update({
      status: "processing",
      started_at: nowIso(),
      updated_at: nowIso(),
    })
    .eq("id", run.id)
    .in("status", ["pending", "retry_scheduled"])
    .select()
    .maybeSingle();
  if (error) throw error;
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

async function checkLimits(db, { organizationId, organization, schedule }) {
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
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const [
    { data: concurrent },
    { data: orgMinute },
    { data: globalMinute },
    { data: orgDaily },
    { data: scheduleDaily },
  ] = await Promise.all([
    db
      .from("lead_outreach_runs")
      .select("id")
      .eq("organization_id", organizationId)
      .in("status", ["processing", "queued_to_twilio"]),
    db
      .from("lead_outreach_runs")
      .select("id")
      .eq("organization_id", organizationId)
      .gte("started_at", oneMinuteAgo)
      .in("status", ["processing", "queued_to_twilio", "completed"]),
    db
      .from("lead_outreach_runs")
      .select("id")
      .gte("started_at", oneMinuteAgo)
      .in("status", ["processing", "queued_to_twilio", "completed"]),
    db
      .from("lead_outreach_runs")
      .select("id")
      .eq("organization_id", organizationId)
      .gte("started_at", today.toISOString())
      .in("status", ["queued_to_twilio", "completed"]),
    db
      .from("lead_outreach_runs")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("schedule_id", schedule?.id || "00000000-0000-0000-0000-000000000000")
      .gte("started_at", today.toISOString())
      .in("status", ["queued_to_twilio", "completed"]),
  ]);
  if ((concurrent || []).length >= maxConcurrent)
    return {
      ok: false,
      code: "ORG_CONCURRENCY_LIMIT",
      message: "Organization concurrent scheduled-call limit reached.",
      limits,
    };
  if ((orgMinute || []).length >= maxOrgPerMinute)
    return {
      ok: false,
      code: "ORG_RATE_LIMIT",
      message: "Organization scheduled-call rate limit reached.",
      limits,
    };
  if ((globalMinute || []).length >= maxGlobalPerMinute)
    return {
      ok: false,
      code: "GLOBAL_RATE_LIMIT",
      message: "Global scheduled-call rate limit reached.",
      limits,
    };
  if ((orgDaily || []).length >= maxOrgDaily)
    return {
      ok: false,
      code: "ORG_DAILY_LIMIT",
      message: "Organization daily scheduled outbound call limit reached.",
      limits,
    };
  if ((scheduleDaily || []).length >= maxScheduleDaily)
    return {
      ok: false,
      code: "SCHEDULE_DAILY_LIMIT",
      message: "Schedule daily outbound call limit reached.",
      limits,
    };
  return { ok: true, limits };
}

async function createCallRecord(
  db,
  { run, schedule, lead, agent, number, toPhone },
) {
  const row = {
    organization_id: run.organization_id,
    voice_agent_id: agent.id,
    caller_name: lead?.name || "Outbound Lead",
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
      callPurpose: schedule.call_purpose || "",
      customInstructions: schedule.custom_instructions || "",
      billing: {
        source: "scheduled_outbound",
        schedule_id: schedule.id,
        run_id: run.id,
      },
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
  console.log("[scheduler] processing run", {
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
        status: "skipped",
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
        status: "skipped",
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
        status: "skipped",
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
      await updateRun(db, run.id, {
        status: "failed",
        completed_at: nowIso(),
        error_code: "OUTBOUND_VOICE_NOT_READY",
        error_message: "From-number is not ready for outbound voice.",
      });
      return { failed: true, reason: "outbound_voice_not_ready" };
    }

    const toPhone = cleanPhone(
      run.destination_phone || run.target_phone || lead?.phone || "",
    );
    if (!isE164(toPhone)) {
      await updateRun(db, run.id, {
        status: "skipped",
        completed_at: nowIso(),
        error_code: "INVALID_DESTINATION",
        error_message: "Lead phone is not valid E.164.",
      });
      return { skipped: true, reason: "invalid_destination" };
    }

    const destinationCountry = guessCountryFromE164(toPhone);
    const selected = new Set(
      [
        ...jsonArray(number.selected_outbound_voice_countries),
        normalizeCountry(number.iso_country),
      ]
        .map(normalizeCountry)
        .filter(Boolean),
    );
    if (!selected.has(destinationCountry) && destinationCountry !== "UNKNOWN") {
      await updateRun(db, run.id, {
        status: "blocked_country",
        completed_at: nowIso(),
        error_code: "COUNTRY_NOT_ENABLED",
        error_message: `Outbound calls to ${destinationCountry} are not enabled for this number.`,
        outcome_metadata: {
          destinationCountry,
          enabledCountries: [...selected],
        },
      });
      return { blocked: true, reason: "country_not_enabled" };
    }

    const limits = await checkLimits(db, {
      organizationId: run.organization_id,
      organization,
      schedule,
    });
    if (!limits.ok) {
      await updateRun(db, run.id, {
        status: "pending",
        started_at: null,
        error_code: limits.code,
        error_message: limits.message,
        outcome_metadata: { limits: limits.limits || null },
      });
      return { deferred: true, reason: limits.code };
    }

    const openai = await checkOpenAIProvider();
    if (!openai.ok) {
      const key = `${run.organization_id}:openai`;
      providerFailureCounts.set(key, (providerFailureCounts.get(key) || 0) + 1);
      await updateRun(db, run.id, {
        status: "blocked_provider_unavailable",
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
    if (!eleven.ok) {
      const key = `${run.organization_id}:elevenlabs`;
      providerFailureCounts.set(key, (providerFailureCounts.get(key) || 0) + 1);
      await updateRun(db, run.id, {
        status: "blocked_provider_unavailable",
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

    const record = await createCallRecord(db, {
      run,
      schedule,
      lead,
      agent,
      number,
      toPhone,
    });
    const base = apiBaseUrl();
    if (!base)
      throw new Error("API_URL is required for scheduled outbound TwiML.");
    const twimlUrl = encodeOutboundTwiMlUrl(base, {
      orgId: run.organization_id,
      agentId: agent.id,
      callRecordId: record.id,
      direction: "outbound",
      recipientPhone: toPhone,
      callerPhone:
        number.phone_number ||
        schedule.from_number ||
        agent.twilio_phone_number,
      leadId: lead.id,
      scheduleId: schedule.id,
      scheduleRunId: run.id,
      callPurpose: schedule.call_purpose || "",
      customInstructions: schedule.custom_instructions || "",
    });
    const result = await makeOutboundCall({
      from:
        number.phone_number ||
        schedule.from_number ||
        agent.twilio_phone_number,
      to: toPhone,
      twimlUrl,
      statusCallbackUrl: `${base}/api/twilio/call-status`,
    });
    await db
      .from("call_records")
      .update({
        twilio_call_sid: result.callSid,
        status: result.status || "initiated",
      })
      .eq("id", record.id);
    await updateRun(db, run.id, {
      status: "queued_to_twilio",
      twilio_call_sid: result.callSid,
      call_record_id: record.id,
      error_code: null,
      error_message: null,
      outcome_metadata: {
        twilioStatus: result.status,
        callRecordId: record.id,
      },
    });
    await db
      .from("leads")
      .update({
        source: "outbound_call",
        voice_agent_id: agent.id,
        updated_at: nowIso(),
      })
      .eq("id", lead.id)
      .eq("organization_id", run.organization_id);
    console.log("[scheduler] queued scheduled outbound call", {
      runId: run.id,
      callSid: result.callSid,
      callRecordId: record.id,
      limits: limits.limits || null,
    });
    return { success: true, runId: run.id, callSid: result.callSid };
  } catch (err) {
    console.error("[scheduler] run failed", {
      runId: run.id,
      error: err.message || String(err),
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

async function executeDueSchedules() {
  if (!schedulerEnabled()) return { skipped: true, reason: "disabled" };
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
    const limit = intEnv("SCHEDULER_MAX_RUNS_PER_TICK", 20);
    const { data: runs, error } = await db
      .from("lead_outreach_runs")
      .select("*")
      .in("status", ["pending", "retry_scheduled"])
      .lte("scheduled_for", nowIso())
      .order("scheduled_for", { ascending: true })
      .limit(limit);
    if (error) throw error;
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

function startLeadScheduler() {
  if (!schedulerEnabled()) {
    console.log(
      "[scheduler] disabled by SCHEDULER_ENABLED/ENABLE_LEAD_SCHEDULER.",
    );
    return () => {};
  }
  if (schedulerTimer) return () => clearInterval(schedulerTimer);
  const intervalMs = Math.max(
    15_000,
    intEnv("SCHEDULER_POLL_INTERVAL_SECONDS", 60) * 1000,
  );
  void executeDueSchedules();
  schedulerTimer = setInterval(() => void executeDueSchedules(), intervalMs);
  console.log(`[scheduler] running every ${intervalMs / 1000}s.`);
  return () => {
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = null;
  };
}

module.exports = { startLeadScheduler, executeDueSchedules, processRun };
