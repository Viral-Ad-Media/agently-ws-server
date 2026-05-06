"use strict";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DEFAULT_TIMEZONE = "America/New_York";

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value || ""),
  );
}

function normalizeArray(value) {
  if (Array.isArray(value))
    return value.filter(
      (item) =>
        item !== undefined && item !== null && String(item).trim() !== "",
    );
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function normalizeScheduleStatus(status, fallback = "draft") {
  const allowed = new Set([
    "draft",
    "active",
    "paused",
    "completed",
    "cancelled",
    "failed",
  ]);
  const value = String(status || fallback)
    .trim()
    .toLowerCase();
  return allowed.has(value) ? value : fallback;
}

function normalizeScheduleType(type) {
  const allowed = new Set([
    "one_time",
    "daily",
    "weekly",
    "monthly",
    "custom_cron",
  ]);
  const value = String(type || "one_time")
    .trim()
    .toLowerCase();
  return allowed.has(value) ? value : "one_time";
}

function normalizeRunStatus(status, fallback = "queued") {
  // Compatibility with the live lead_outreach_runs_status_check constraint.
  // Existing DBs commonly allow only queued/initiated/failed/completed.
  const allowed = new Set(["queued", "initiated", "completed", "failed"]);
  const aliases = {
    pending: "queued",
    retry_scheduled: "queued",
    processing: "initiated",
    queued_to_twilio: "initiated",
    skipped: "failed",
    no_answer: "failed",
    voicemail: "completed",
    blocked_provider_unavailable: "failed",
    blocked_quota: "failed",
    blocked_country: "failed",
    cancelled: "failed",
    canceled: "failed",
  };
  const raw = String(status || fallback)
    .trim()
    .toLowerCase();
  const value = aliases[raw] || raw;
  return allowed.has(value) ? value : fallback;
}

function cleanPhone(value) {
  return String(value || "").trim();
}

function isE164(value) {
  return /^\+[1-9]\d{7,14}$/.test(String(value || "").trim());
}

function normalizeDirectRecipients(value) {
  const raw = normalizeArray(value);
  const recipients = [];
  const seen = new Set();

  for (const item of raw) {
    let phone = "";
    let name = "";
    let metadata = {};

    if (typeof item === "string") {
      phone = cleanPhone(item);
    } else if (item && typeof item === "object") {
      phone = cleanPhone(
        item.phone ||
          item.phoneNumber ||
          item.to ||
          item.destination ||
          item.destinationPhone ||
          item.number ||
          "",
      );
      name = String(
        item.name || item.fullName || item.targetName || item.label || "",
      ).trim();
      metadata =
        item.metadata &&
        typeof item.metadata === "object" &&
        !Array.isArray(item.metadata)
          ? item.metadata
          : {};
    }

    if (!isE164(phone) || seen.has(phone)) continue;
    seen.add(phone);
    recipients.push({
      phone,
      name: name || "Direct recipient",
      metadata,
    });
  }

  return recipients;
}

function guessCountryFromE164(phone) {
  const p = String(phone || "").trim();
  if (p.startsWith("+1")) return "US";
  if (p.startsWith("+44")) return "GB";
  if (p.startsWith("+234")) return "NG";
  if (p.startsWith("+233")) return "GH";
  if (p.startsWith("+27")) return "ZA";
  if (p.startsWith("+61")) return "AU";
  if (p.startsWith("+33")) return "FR";
  if (p.startsWith("+49")) return "DE";
  return "UNKNOWN";
}

function normalizeCountry(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function jsonObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

function positiveInt(
  value,
  fallback,
  { min = 1, max = Number.MAX_SAFE_INTEGER } = {},
) {
  const parsed = parseInt(String(value ?? ""), 10);
  const base = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, base));
}

function limitValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function normalizeLimitConfig(value = {}) {
  const source = jsonObject(value);
  const aliases = {
    maxConcurrentCalls: [
      "maxConcurrentCalls",
      "max_concurrent_calls",
      "concurrentCalls",
    ],
    maxOutboundCallsPerMinute: [
      "maxOutboundCallsPerMinute",
      "max_outbound_calls_per_minute",
      "callsPerMinute",
      "cpm",
    ],
    maxDailyOutboundCalls: [
      "maxDailyOutboundCalls",
      "max_daily_outbound_calls",
      "dailyOutboundCalls",
      "daily",
    ],
    maxCallsPerDay: [
      "maxCallsPerDay",
      "max_calls_per_day",
      "scheduleDailyCalls",
    ],
  };
  const normalized = {};
  Object.entries(aliases).forEach(([key, keys]) => {
    const value = limitValue(...keys.map((name) => source[name]));
    if (value !== undefined)
      normalized[key] = positiveInt(value, undefined, { min: 1 });
  });
  return normalized;
}

function buildEffectiveSchedulerLimits({
  organization = {},
  schedule = {},
  env = process.env,
} = {}) {
  const orgLimits = normalizeLimitConfig(
    organization.outbound_call_limits ||
      organization.call_limits ||
      organization.metadata?.outboundCallLimits,
  );
  const scheduleMetadata = jsonObject(schedule.metadata);
  const scheduleLimits = normalizeLimitConfig(
    scheduleMetadata.limits || scheduleMetadata.callLimits || {},
  );
  const plan = String(organization.plan || "starter").toLowerCase();
  const planDefaults = {
    starter: {
      maxConcurrentCalls: 3,
      maxOutboundCallsPerMinute: 5,
      maxDailyOutboundCalls: 500,
    },
    pro: {
      maxConcurrentCalls: 10,
      maxOutboundCallsPerMinute: 30,
      maxDailyOutboundCalls: 5000,
    },
    enterprise: {
      maxConcurrentCalls: 50,
      maxOutboundCallsPerMinute: 100,
      maxDailyOutboundCalls: 50000,
    },
  }[plan] || {
    maxConcurrentCalls: 3,
    maxOutboundCallsPerMinute: 5,
    maxDailyOutboundCalls: 500,
  };

  const platform = {
    maxGlobalOutboundCallsPerMinute: positiveInt(
      env.MAX_GLOBAL_OUTBOUND_CALLS_PER_MINUTE,
      30,
    ),
    maxOrgOutboundCallsPerMinute: positiveInt(
      env.MAX_ORG_OUTBOUND_CALLS_PER_MINUTE,
      planDefaults.maxOutboundCallsPerMinute,
    ),
    maxOrgConcurrentCalls: positiveInt(
      env.MAX_ORG_CONCURRENT_CALLS,
      planDefaults.maxConcurrentCalls,
    ),
    maxOrgDailyOutboundCalls: positiveInt(
      env.MAX_ORG_DAILY_OUTBOUND_CALLS,
      planDefaults.maxDailyOutboundCalls,
    ),
  };

  return {
    maxGlobalOutboundCallsPerMinute: platform.maxGlobalOutboundCallsPerMinute,
    maxOrgOutboundCallsPerMinute: positiveInt(
      limitValue(
        scheduleLimits.maxOutboundCallsPerMinute,
        orgLimits.maxOutboundCallsPerMinute,
        platform.maxOrgOutboundCallsPerMinute,
      ),
      platform.maxOrgOutboundCallsPerMinute,
    ),
    maxOrgConcurrentCalls: positiveInt(
      limitValue(
        scheduleLimits.maxConcurrentCalls,
        orgLimits.maxConcurrentCalls,
        platform.maxOrgConcurrentCalls,
      ),
      platform.maxOrgConcurrentCalls,
    ),
    maxOrgDailyOutboundCalls: positiveInt(
      limitValue(
        scheduleLimits.maxDailyOutboundCalls,
        orgLimits.maxDailyOutboundCalls,
        schedule.max_calls_per_day,
        platform.maxOrgDailyOutboundCalls,
      ),
      platform.maxOrgDailyOutboundCalls,
    ),
    maxScheduleCallsPerDay: positiveInt(
      limitValue(
        scheduleLimits.maxCallsPerDay,
        schedule.max_calls_per_day,
        orgLimits.maxCallsPerDay,
        platform.maxOrgDailyOutboundCalls,
      ),
      platform.maxOrgDailyOutboundCalls,
    ),
    source: {
      plan,
      hasOrganizationOverride: Object.keys(orgLimits).length > 0,
      hasScheduleOverride: Object.keys(scheduleLimits).length > 0,
    },
  };
}

function localParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? 0 : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function localDateTimeToUtc({ date, time, timezone }) {
  const [year, month, day] = String(date || "")
    .split("-")
    .map(Number);
  const [hour, minute] = String(time || "00:00")
    .split(":")
    .map(Number);
  if (
    !year ||
    !month ||
    !day ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    throw new Error("Invalid local date/time.");
  }
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  for (let i = 0; i < 3; i += 1) {
    const parts = localParts(guess, timezone || DEFAULT_TIMEZONE);
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second || 0,
    );
    const target = Date.UTC(year, month - 1, day, hour, minute, 0);
    guess = new Date(guess.getTime() + (target - asUtc));
  }
  return guess;
}

function isoDateInTimezone(date, timezone) {
  const parts = localParts(date, timezone || DEFAULT_TIMEZONE);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addDaysIso(dateString, days) {
  const [year, month, day] = String(dateString).split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return d.toISOString().slice(0, 10);
}

function weekdayCodeForLocalDate(dateString) {
  const [year, month, day] = String(dateString).split("-").map(Number);
  return WEEKDAYS[
    new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).getUTCDay()
  ];
}

function normalizeTimesPerDay(value, fallbackTime) {
  const raw = normalizeArray(value || fallbackTime || "10:00");
  const times = raw
    .map((time) =>
      String(time || "")
        .trim()
        .slice(0, 5),
    )
    .filter((time) => /^\d{2}:\d{2}$/.test(time));
  return [...new Set(times.length ? times : ["10:00"])];
}

function normalizeDaysOfWeek(value) {
  return [
    ...new Set(
      normalizeArray(value)
        .map((day) =>
          String(day || "")
            .slice(0, 3)
            .toLowerCase(),
        )
        .filter((day) => WEEKDAYS.includes(day)),
    ),
  ];
}

function resolveStartAt(body = {}, timezone = DEFAULT_TIMEZONE) {
  if (body.startAt || body.start_at)
    return new Date(body.startAt || body.start_at).toISOString();
  const localDate =
    body.startLocalDate || body.start_local_date || body.localDate || body.date;
  const localTime =
    body.startTime || body.start_time || body.localTime || body.time;
  if (localDate && localTime) {
    return localDateTimeToUtc({
      date: localDate,
      time: String(localTime).slice(0, 5),
      timezone,
    }).toISOString();
  }
  return null;
}

function buildRunCandidates(
  schedule,
  { horizonDays = 30, maxRuns = 500 } = {},
) {
  const timezone = schedule.timezone || DEFAULT_TIMEZONE;
  const type = normalizeScheduleType(
    schedule.schedule_type || schedule.scheduleType,
  );
  const startAt =
    schedule.start_at || schedule.startAt || new Date().toISOString();
  const start = new Date(startAt);
  const startLocal = localParts(start, timezone);
  const fallbackLocalTime = `${String(startLocal.hour).padStart(2, "0")}:${String(startLocal.minute).padStart(2, "0")}`;
  const times = normalizeTimesPerDay(
    schedule.times_per_day || schedule.timesPerDay,
    fallbackLocalTime,
  );
  const startLocalDate = isoDateInTimezone(start, timezone);
  const days = normalizeDaysOfWeek(
    schedule.days_of_week || schedule.daysOfWeek,
  );
  const results = [];
  const pushIfValid = (localDate, time) => {
    if (results.length >= maxRuns) return;
    const scheduled = localDateTimeToUtc({ date: localDate, time, timezone });
    if (scheduled.getTime() + 1000 < start.getTime()) return;
    results.push(scheduled.toISOString());
  };

  if (type === "one_time") {
    results.push(start.toISOString());
    return results;
  }

  for (
    let dayOffset = 0;
    dayOffset <= horizonDays && results.length < maxRuns;
    dayOffset += 1
  ) {
    const localDate = addDaysIso(startLocalDate, dayOffset);
    const weekday = weekdayCodeForLocalDate(localDate);
    if (type === "weekly" && days.length && !days.includes(weekday)) continue;
    if (type === "monthly") {
      const startDay = Number(startLocalDate.slice(-2));
      const currentDay = Number(localDate.slice(-2));
      if (currentDay !== startDay) continue;
    }
    if (type === "custom_cron") {
      // Minimal safe support: custom cron is stored but automatic generation is intentionally conservative.
      // Tenants can still generate explicit runs via API once a full cron parser is introduced.
      continue;
    }
    for (const time of times) pushIfValid(localDate, time);
  }
  return results;
}

function serializeSchedule(row = {}) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    voiceAgentId: row.voice_agent_id,
    fromNumberId: row.from_number_id || null,
    fromNumber: row.from_number || "",
    leadId: row.lead_id || null,
    leadIds: Array.isArray(row.lead_ids) ? row.lead_ids : [],
    directRecipients: Array.isArray(row.direct_recipients)
      ? row.direct_recipients
      : row.metadata?.directRecipients || [],
    name: row.name || "",
    callPurpose: row.call_purpose || row.extra_context || "",
    customInstructions: row.custom_instructions || row.extra_context || "",
    scheduleType: row.schedule_type || "one_time",
    startAt: row.start_at || null,
    timezone: row.timezone || DEFAULT_TIMEZONE,
    daysOfWeek: Array.isArray(row.days_of_week) ? row.days_of_week : [],
    timesPerDay: Array.isArray(row.times_per_day) ? row.times_per_day : [],
    maxCallsPerDay: row.max_calls_per_day || null,
    effectiveLimits:
      row.effective_limits || row.metadata?.effectiveLimits || null,
    maxAttemptsPerLead: row.max_attempts_per_lead || null,
    retryDelayMinutes: row.retry_delay_minutes || null,
    voicemailBehavior: row.voicemail_behavior || "hangup",
    status: row.status || (row.is_active === false ? "paused" : "active"),
    progress: row.progress || {},
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function serializeRun(row = {}) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    scheduleId: row.schedule_id,
    leadId: row.lead_id,
    voiceAgentId: row.voice_agent_id,
    fromNumberId: row.from_number_id || null,
    destinationPhone: row.destination_phone || row.target_phone || "",
    targetName: row.target_name || "",
    targetType: row.lead_id ? "lead" : "direct_number",
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    twilioCallSid: row.twilio_call_sid || "",
    callRecordId: row.call_record_id || null,
    attemptNumber: row.attempt_number || 1,
    errorCode: row.error_code || "",
    errorMessage: row.error_message || "",
    outcomeMetadata: row.outcome_metadata || row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

module.exports = {
  DEFAULT_TIMEZONE,
  WEEKDAYS,
  isUuid,
  isE164,
  cleanPhone,
  normalizeDirectRecipients,
  guessCountryFromE164,
  normalizeCountry,
  jsonArray,
  jsonObject,
  positiveInt,
  normalizeArray,
  normalizeScheduleStatus,
  normalizeScheduleType,
  normalizeRunStatus,
  normalizeTimesPerDay,
  normalizeDaysOfWeek,
  localDateTimeToUtc,
  resolveStartAt,
  buildEffectiveSchedulerLimits,
  buildRunCandidates,
  serializeSchedule,
  serializeRun,
};
