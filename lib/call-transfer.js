"use strict";

const https = require("https");

// The dashboard saves whatever the tenant typed, e.g. "(254) 268-8827", so
// normalize to E.164 before deciding a transfer destination exists.
function normalizeTransferNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  let e164 = "";
  if (raw.startsWith("+")) e164 = `+${digits}`;
  else if (raw.startsWith("00")) e164 = `+${digits.slice(2)}`;
  // Bare 10-digit numbers are North American; 11 digits starting 1 likewise.
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : "";
}

function configuredTransferNumber(agent = {}) {
  if (!agent) return "";
  return (
    normalizeTransferNumber(agent.call_transfer_number) ||
    normalizeTransferNumber(agent.escalation_phone)
  );
}

// Escalation working hours. The dashboard's "Escalation Manager Working Hours"
// field is free text saved to voice_agents.business_hours (e.g. "Mon-Fri
// 9AM-6PM", "9:00 AM - 5:00 PM", "24/7"). Explicit escalation_hours_start/end
// columns (HH:MM) win when set. With nothing usable, transfers are not blocked.
const DEFAULT_TIMEZONE = "America/New_York";
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_PREFIX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes > 0)) return null;
  return hours * 60 + minutes;
}

// "9", "9am", "9:30 pm", "17:00", "noon", "midnight" -> minutes after midnight.
function parseLooseClock(text) {
  const value = String(text || "").trim().toLowerCase();
  if (value === "noon") return 12 * 60;
  if (value === "midnight") return 0;
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/.exec(value);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const meridiem = (match[3] || "").replace(/\./g, "");
  if (minutes > 59 || hours > 24) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === "pm" && hours !== 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
  }
  return hours * 60 + minutes;
}

function dayIndex(word) {
  const key = String(word || "").slice(0, 3).toLowerCase();
  return Object.prototype.hasOwnProperty.call(DAY_PREFIX, key) ? DAY_PREFIX[key] : null;
}

// Mon-Fri / Monday to Friday / weekdays / weekends / every day -> set of day numbers.
function parseDays(text) {
  const value = String(text || "").toLowerCase();
  if (/\bweekdays?\b/.test(value)) return new Set([1, 2, 3, 4, 5]);
  if (/\bweekends?\b/.test(value)) return new Set([0, 6]);
  const range = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?\s*(?:-|–|to|through|thru)\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/.exec(value);
  if (range) {
    const days = new Set();
    let day = dayIndex(range[1]);
    const end = dayIndex(range[2]);
    for (let i = 0; i < 7; i++) {
      days.add(day);
      if (day === end) break;
      day = (day + 1) % 7;
    }
    return days;
  }
  return null;
}

function parseHoursText(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  if (/24\s*\/\s*7|24\s*hours|around the clock|any ?time|always/i.test(value)) {
    return { always: true, days: parseDays(value) };
  }
  const clock = String.raw`(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|noon|midnight)`;
  const match = new RegExp(`${clock}\\s*(?:-|–|to|until|till)\\s*${clock}`, "i").exec(value);
  if (!match) return null;
  let start = parseLooseClock(match[1]);
  const end = parseLooseClock(match[2]);
  if (start === null || end === null) return null;
  // "9-5" with no am/pm: read the end as afternoon when it would otherwise precede the start.
  if (!/[ap]\.?m/i.test(match[0]) && end <= start && end < 12 * 60) {
    return { start, end: end + 12 * 60, days: parseDays(value) };
  }
  return { start, end, days: parseDays(value) };
}

function formatClock(totalMinutes) {
  const minutesInDay = totalMinutes % (24 * 60);
  const hours24 = Math.floor(minutesInDay / 60);
  const minutes = minutesInDay % 60;
  const suffix = hours24 < 12 ? "AM" : "PM";
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function formatDays(days) {
  if (!days || days.size === 7) return "";
  const sorted = [...days].sort((a, b) => a - b);
  const weekdays = [1, 2, 3, 4, 5];
  if (sorted.length === 5 && weekdays.every((d) => days.has(d))) return "Monday to Friday";
  if (sorted.length === 2 && days.has(0) && days.has(6)) return "Saturday and Sunday";
  return sorted.map((d) => DAY_NAMES[d]).join(", ");
}

function validTimezone(zone) {
  const value = String(zone || "").trim();
  if (!value) return "";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value;
  } catch (_) {
    return "";
  }
}

function clockIn(timezone, now) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return {
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
    day: dayIndex(get("weekday")),
  };
}

function resolveHours(agent = {}) {
  const start = parseClock(agent?.escalation_hours_start);
  const end = parseClock(agent?.escalation_hours_end);
  if (start !== null && end !== null) return { start, end, days: null };
  return parseHoursText(agent?.business_hours);
}

/**
 * Whether the escalation contact takes live transfers right now, judged in the
 * business's timezone. End before start is an overnight window (22:00-06:00);
 * start == end, "24/7", or no usable hours means any time.
 */
function transferAvailability(agent = {}, timezone = "", now = new Date()) {
  const zone = validTimezone(timezone) || DEFAULT_TIMEZONE;
  const hours = resolveHours(agent);
  const { minutes: current, day } = clockIn(zone, now);
  const daysText = formatDays(hours?.days);
  const dayOpen = !hours?.days || hours.days.has(day);
  if (!hours || hours.always || hours.start === hours.end) {
    return {
      open: dayOpen,
      timezone: zone,
      hoursText: daysText ? `${daysText}, any time` : "any time",
      configured: Boolean(hours),
    };
  }
  let timeOpen;
  if (hours.start < hours.end) timeOpen = current >= hours.start && current < hours.end;
  else timeOpen = current >= hours.start || current < hours.end;
  const clockText = `${formatClock(hours.start)} to ${formatClock(hours.end)}`;
  return {
    open: dayOpen && timeOpen,
    timezone: zone,
    hoursText: daysText ? `${daysText}, ${clockText}` : clockText,
    configured: true,
  };
}

// How many times to ring the escalation number before bringing the caller
// back to the agent. Stored in the agent's rules JSON (Assignment & routing).
const DEFAULT_TRANSFER_ATTEMPTS = 2;
const MAX_TRANSFER_ATTEMPTS = 3;

function transferMaxAttempts(agent = {}) {
  const raw = Number(agent?.rules?.transferAttempts);
  if (!Number.isFinite(raw)) return DEFAULT_TRANSFER_ATTEMPTS;
  return Math.min(MAX_TRANSFER_ATTEMPTS, Math.max(1, Math.round(raw)));
}

/**
 * The <Dial action> callback. The API's /transfer-status route retries the
 * number on no-answer, then reconnects the caller to the agent, so it needs
 * enough of the call's identity to rebuild the media stream.
 */
function buildTransferActionUrl(apiBase, {
  attempt = 1,
  maxAttempts = DEFAULT_TRANSFER_ATTEMPTS,
  orgId = "",
  agentId = "",
  callRecordId = "",
  direction = "",
  accountSid = "",
  callerPhone = "",
  recipientPhone = "",
  recipientName = "",
  callPurpose = "",
} = {}) {
  const base = String(apiBase || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(base)) return "";
  const url = new URL(`${base}/api/twilio/transfer-status`);
  const params = {
    attempt: String(attempt),
    max: String(maxAttempts),
    orgId,
    agentId,
    callRecordId,
    direction,
    accountSid,
    callerPhone,
    recipientPhone,
    recipientName,
    callPurpose: String(callPurpose || "").slice(0, 300),
  };
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function transferToolDefinition() {
  return {
    type: "function",
    name: "transfer_to_human",
    description:
      "Connect this live phone call to the configured human escalation number. Use only when the caller asks for a person or the configured escalation rule requires it. The destination is fixed by the business settings; do not accept a number spoken by the caller.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string", description: "Brief reason for the transfer." } },
      required: ["reason"],
      additionalProperties: false,
    },
  };
}

function buildTransferTwiml(number, actionUrl = "") {
  if (!/^\+[1-9]\d{7,14}$/.test(String(number || ""))) {
    throw new Error("A valid configured E.164 transfer number is required");
  }
  const action = String(actionUrl || "").trim();
  if (action && !/^https:\/\/[^\s"<>]+$/i.test(action)) {
    throw new Error("Transfer status callback must be an HTTPS URL");
  }
  const actionAttribute = action
    ? ` action="${action.replace(/&/g, "&amp;")}" method="POST"`
    : "";
  const fallback = action
    ? ""
    : "<Say>Sorry, the team is unavailable right now. Please call back later.</Say><Hangup/>";
  return `<Response><Dial answerOnBridge="true" timeout="20"${actionAttribute}><Number>${number}</Number></Dial>${fallback}</Response>`;
}

function redirectActiveCall({ callSid, accountSid, authAccountSid = accountSid, authToken, number, actionUrl = "", request = https.request }) {
  if (!/^CA[0-9a-f]{32}$/i.test(String(callSid || ""))) {
    throw new Error("A valid Twilio call SID is required");
  }
  if (!/^AC[0-9a-f]{32}$/i.test(String(accountSid || "")) ||
      !/^AC[0-9a-f]{32}$/i.test(String(authAccountSid || "")) || !authToken) {
    throw new Error("Twilio account credentials are required");
  }
  const form = new URLSearchParams({ Twiml: buildTransferTwiml(number, actionUrl) }).toString();
  return new Promise((resolve, reject) => {
    const req = request(
      {
        method: "POST",
        hostname: "api.twilio.com",
        path: `/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`,
        auth: `${authAccountSid}:${authToken}`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(form),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, data });
          } else {
            reject(new Error(`Twilio transfer HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(form);
    req.end();
  });
}

module.exports = {
  normalizeTransferNumber,
  configuredTransferNumber,
  transferAvailability,
  parseHoursText,
  transferMaxAttempts,
  buildTransferActionUrl,
  transferToolDefinition,
  buildTransferTwiml,
  redirectActiveCall,
};
