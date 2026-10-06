"use strict";

/**
 * Calendar booking tools for the Twilio voice path (ws-server).
 *
 * The booking SERVICE lives in the API repo (lib/calendar-booking.js) — one
 * implementation. This module is the thin client: the three function
 * definitions the realtime session advertises, and dispatch that POSTs to
 * /api/internal/calendar/* with the shared INTERNAL_API_SECRET.
 *
 * Reads process.env.API_URL for the API base (set by lib/config.js) and
 * INTERNAL_API_SECRET for auth. When either is missing, the tools report
 * themselves unavailable instead of throwing mid-call.
 */

const TOOL_TIMEOUT_MS = 15000;

function checkAvailabilityToolDefinition() {
  return {
    type: "function",
    name: "check_calendar_availability",
    description:
      "Check which appointment slots are currently open on the business's connected calendar (Calendly or Google Calendar). Call this when the caller asks to book, reschedule, or asks 'when are you free'. Silent to the caller; never mention using it.",
    parameters: {
      type: "object",
      properties: {
        from_date: {
          type: "string",
          description:
            "Start date to search from, YYYY-MM-DD. Defaults to today. Use the caller's words ('tomorrow', 'next week') converted to a date.",
        },
        days: {
          type: "integer",
          description: "How many days ahead to look (1-14). Default 7.",
        },
      },
      additionalProperties: false,
    },
  };
}

function bookAppointmentToolDefinition() {
  return {
    type: "function",
    name: "book_appointment",
    description:
      "Book the appointment into the business's connected calendar. Only call after the caller has chosen a specific slot from check_calendar_availability and given their name. The booking is immediate and real.",
    parameters: {
      type: "object",
      properties: {
        start_time: {
          type: "string",
          description:
            "The slot's exact start time, copied verbatim from check_calendar_availability (ISO format). Never invent or round a time.",
        },
        attendee_name: {
          type: "string",
          description: "The caller's full name. Required.",
        },
        attendee_email: {
          type: "string",
          description: "The caller's email, if they gave one. Used for the calendar invite.",
        },
        attendee_phone: {
          type: "string",
          description: "The caller's phone number, if known.",
        },
        notes: {
          type: "string",
          description: "Anything the caller asked to add to the booking (reason for visit, etc.).",
        },
      },
      required: ["start_time", "attendee_name"],
      additionalProperties: false,
    },
  };
}

function cancelAppointmentToolDefinition() {
  return {
    type: "function",
    name: "cancel_appointment",
    description:
      "Cancel a booking the agent made earlier in this call. Only use the appointment id returned by book_appointment.",
    parameters: {
      type: "object",
      properties: {
        appointment_id: {
          type: "string",
          description: "The appointment id returned by book_appointment.",
        },
      },
      required: ["appointment_id"],
      additionalProperties: false,
    },
  };
}

function calendarToolDefinitions() {
  return [
    checkAvailabilityToolDefinition(),
    bookAppointmentToolDefinition(),
    cancelAppointmentToolDefinition(),
  ];
}

function apiBase() {
  return String(process.env.API_URL || "").trim().replace(/\/+$/, "");
}

function isCalendarToolsAvailable() {
  return Boolean(apiBase() && process.env.INTERNAL_API_SECRET);
}

async function callInternal(path, body) {
  const base = apiBase();
  const secret = process.env.INTERNAL_API_SECRET;
  if (!base || !secret) {
    return {
      success: false,
      code: "not_configured",
      message: "Calendar booking is not configured on this server.",
    };
  }
  const response = await fetch(`${base}/api/internal/calendar${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agently-internal-secret": secret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = null;
  }
  if (!response.ok || !json) {
    return {
      success: false,
      code: "provider_error",
      message: "The calendar is temporarily unreachable. Offer to take the caller's details so the team can book them back.",
    };
  }
  return json;
}

function parseDateInput(fromDate, days) {
  const now = new Date();
  let from = null;
  if (fromDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fromDate).trim());
    if (m) from = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  if (!from || Number.isNaN(from.getTime())) from = now;
  const n = Math.min(14, Math.max(1, Number(days) || 7));
  return { fromISO: from.toISOString(), toISO: new Date(from.getTime() + n * 24 * 3600 * 1000).toISOString() };
}

/**
 * Dispatch one calendar tool call. Returns the payload to send back as
 * function_call_output. `context` supplies organizationId, leadId,
 * callRecordId, voiceAgentId and timezone.
 */
async function dispatchCalendarTool(name, rawArgs, context = {}) {
  let args = {};
  try {
    args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : rawArgs || {};
  } catch (_) {
    args = {};
  }
  const organizationId = context.organizationId || context.orgId || null;
  if (!organizationId) {
    return { success: false, code: "not_connected", message: "No business context for this call." };
  }
  const common = {
    organizationId,
    leadId: context.leadId || null,
    callRecordId: context.callRecordId || null,
    voiceAgentId: context.voiceAgentId || null,
  };

  if (name === "check_calendar_availability") {
    const { fromISO, toISO } = parseDateInput(args.from_date, args.days);
    return callInternal("/availability", {
      ...common,
      fromISO,
      toISO,
      timezone: context.timezone || null,
    });
  }
  if (name === "book_appointment") {
    return callInternal("/book", {
      ...common,
      startISO: args.start_time,
      attendeeName: args.attendee_name,
      attendeeEmail: args.attendee_email || null,
      attendeePhone: args.attendee_phone || context.callerPhone || null,
      notes: args.notes || null,
    });
  }
  if (name === "cancel_appointment") {
    return callInternal("/cancel", { ...common, appointmentId: args.appointment_id });
  }
  return { success: false, code: "unknown_tool", message: `Unknown calendar tool: ${name}` };
}

const CALENDAR_TOOL_NAMES = new Set([
  "check_calendar_availability",
  "book_appointment",
  "cancel_appointment",
]);

function isCalendarTool(name) {
  return CALENDAR_TOOL_NAMES.has(String(name));
}

module.exports = {
  calendarToolDefinitions,
  dispatchCalendarTool,
  isCalendarTool,
  isCalendarToolsAvailable,
  CALENDAR_TOOL_NAMES,
};
