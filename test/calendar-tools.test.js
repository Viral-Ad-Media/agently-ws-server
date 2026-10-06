"use strict";
/*
 * lib/calendar-tools.js — tool definitions, dispatch plumbing.
 *
 * The provider logic lives in the API repo and is tested there. These tests
 * cover the client contract: the three advertised tools, name routing, the
 * internal-endpoint request shape, and fail-closed behavior when the API is
 * unreachable or unconfigured.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calendarToolDefinitions,
  dispatchCalendarTool,
  isCalendarTool,
  isCalendarToolsAvailable,
} = require("../lib/calendar-tools");

function withEnv(env, fn) {
  const keep = {};
  for (const k of Object.keys(env)) {
    keep[k] = process.env[k];
    process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (keep[k] === undefined) delete process.env[k];
      else process.env[k] = keep[k];
    }
  }
}

function stubFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => {
    global.fetch = original;
  };
}

test("advertises exactly the three booking tools", () => {
  const defs = calendarToolDefinitions();
  assert.equal(defs.length, 3);
  const names = defs.map((d) => d.name).sort();
  assert.deepEqual(names, ["book_appointment", "cancel_appointment", "check_calendar_availability"]);
  for (const d of defs) {
    assert.equal(d.type, "function");
    assert.ok(d.description && d.description.length > 20);
    assert.equal(d.parameters.type, "object");
  }
  const book = defs.find((d) => d.name === "book_appointment");
  assert.deepEqual(book.parameters.required, ["start_time", "attendee_name"]);
});

test("isCalendarTool routes only calendar tools", () => {
  assert.ok(isCalendarTool("check_calendar_availability"));
  assert.ok(isCalendarTool("book_appointment"));
  assert.ok(isCalendarTool("cancel_appointment"));
  assert.ok(!isCalendarTool("search_business_knowledge"));
  assert.ok(!isCalendarTool(""));
  assert.ok(!isCalendarTool(null));
});

test("tools are unavailable without API base or secret", () => {
  withEnv({ API_URL: "", INTERNAL_API_SECRET: "" }, () => {
    assert.equal(isCalendarToolsAvailable(), false);
  });
  withEnv({ API_URL: "https://api.example.com", INTERNAL_API_SECRET: "s3cret" }, () => {
    assert.equal(isCalendarToolsAvailable(), true);
  });
});

test("dispatch without an organization id fails closed without HTTP", async () => {
  const restore = stubFetch(() => {
    throw new Error("fetch must not be called");
  });
  try {
    const result = await withEnv(
      { API_URL: "https://api.example.com", INTERNAL_API_SECRET: "s3cret" },
      () => dispatchCalendarTool("check_calendar_availability", "{}", {}),
    );
    assert.equal(result.success, false);
    assert.equal(result.code, "not_connected");
  } finally {
    restore();
  }
});

test("dispatch posts to the internal availability endpoint and returns its result", async () => {
  const seen = {};
  const restore = stubFetch(async (url, opts) => {
    seen.url = url;
    seen.headers = opts.headers;
    seen.body = JSON.parse(opts.body);
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          success: true,
          provider: "google",
          slots: [{ start: "2026-10-07T14:00:00.000Z", label: "Wed, Oct 7, 10:00 AM" }],
        }),
    };
  });
  try {
    const result = await withEnv(
      { API_URL: "https://api.example.com/", INTERNAL_API_SECRET: "s3cret" },
      () =>
        dispatchCalendarTool(
          "check_calendar_availability",
          JSON.stringify({ from_date: "2026-10-07", days: 3 }),
          { organizationId: "org-1", timezone: "America/New_York" },
        ),
    );
    assert.equal(seen.url, "https://api.example.com/api/internal/calendar/availability");
    assert.equal(seen.headers["x-agently-internal-secret"], "s3cret");
    assert.equal(seen.body.organizationId, "org-1");
    assert.equal(seen.body.fromISO, "2026-10-07T00:00:00.000Z");
    assert.equal(seen.body.timezone, "America/New_York");
    assert.equal(result.success, true);
    assert.equal(result.provider, "google");
    assert.equal(result.slots.length, 1);
  } finally {
    restore();
  }
});

test("dispatch book passes caller details through", async () => {
  const seen = {};
  const restore = stubFetch(async (url, opts) => {
    seen.url = url;
    seen.body = JSON.parse(opts.body);
    return {
      ok: true,
      text: async () => JSON.stringify({ success: true, provider: "calendly", appointmentId: "a1" }),
    };
  });
  try {
    const result = await withEnv(
      { API_URL: "https://api.example.com", INTERNAL_API_SECRET: "s3cret" },
      () =>
        dispatchCalendarTool(
          "book_appointment",
          JSON.stringify({ start_time: "2026-10-07T14:00:00.000Z", attendee_name: "Ada" }),
          { organizationId: "org-1", leadId: "lead-9", callerPhone: "+15551234567" },
        ),
    );
    assert.equal(seen.url, "https://api.example.com/api/internal/calendar/book");
    assert.equal(seen.body.attendeeName, "Ada");
    assert.equal(seen.body.attendeePhone, "+15551234567");
    assert.equal(seen.body.leadId, "lead-9");
    assert.equal(result.success, true);
  } finally {
    restore();
  }
});

test("dispatch degrades gracefully when the API is down", async () => {
  const restore = stubFetch(async () => {
    throw new Error("connection refused");
  });
  try {
    await assert.rejects(
      withEnv(
        { API_URL: "https://api.example.com", INTERNAL_API_SECRET: "s3cret" },
        () => dispatchCalendarTool("cancel_appointment", JSON.stringify({ appointment_id: "a1" }), { organizationId: "org-1" }),
      ),
    );
  } finally {
    restore();
  }
});

test("malformed tool arguments do not throw", async () => {
  const restore = stubFetch(async () => ({
    ok: true,
    text: async () => JSON.stringify({ success: true, provider: "google", slots: [] }),
  }));
  try {
    const result = await withEnv(
      { API_URL: "https://api.example.com", INTERNAL_API_SECRET: "s3cret" },
      () => dispatchCalendarTool("check_calendar_availability", "not-json{{{", { organizationId: "org-1" }),
    );
    assert.equal(result.success, true); // defaults applied, no throw
  } finally {
    restore();
  }
});
