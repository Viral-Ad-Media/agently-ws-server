"use strict";
/*
 * Owner-mode isolation.
 *
 * Owner tools read the tenant's appointment book — their customers' personal
 * data. They must be ABSENT unless the speaker is a verified owner, decided
 * from the signed token's userId and nothing else. An earlier draft hardcoded
 * enableOwnerTools: true, safe only while every token route sat behind login;
 * the first public webcall would have read the agenda to a stranger and no
 * test would have failed. These tests are that missing failure.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  OWNER_TOOL_NAMES,
  ownerToolDefinitions,
  isOwnerTool,
  resolveOwnerMode,
  buildOwnerInstructions,
  scheduleWindow,
} = require("../lib/webcall-owner-tools");
const { _internals } = require("../lib/webcall-stream");

/** Minimal users-table fake: from("users").select().eq("id", x).maybeSingle(). */
function fakeDb(users, { throws = false } = {}) {
  return {
    from() {
      let id = null;
      const api = {
        select: () => api,
        eq: (_col, value) => {
          id = value;
          return api;
        },
        maybeSingle: async () => {
          if (throws) throw new Error("db down");
          return { data: users.find((u) => u.id === id) || null, error: null };
        },
      };
      return api;
    },
  };
}

const USERS = [{ id: "user-1", name: "Ada" }];

test("owner tool set: schedule read plus calendar management", () => {
  for (const name of ["get_my_schedule", "check_calendar_availability", "book_appointment", "cancel_appointment"]) {
    assert.ok(OWNER_TOOL_NAMES.includes(name), name);
  }
  for (const d of ownerToolDefinitions()) assert.ok(isOwnerTool(d.name), d.name);
});

test("a verified token userId that exists is an owner", async () => {
  const mode = await resolveOwnerMode(fakeDb(USERS), { orgId: "org-1", userId: "user-1" });
  assert.deepEqual(mode, { isOwner: true, ownerName: "Ada" });
});

test("no userId, a placeholder, an unknown user, or a db failure is NOT an owner", async () => {
  const db = fakeDb(USERS);
  assert.equal((await resolveOwnerMode(db, { orgId: "org-1" })).isOwner, false);
  assert.equal((await resolveOwnerMode(db, { orgId: "org-1", userId: null })).isOwner, false);
  assert.equal((await resolveOwnerMode(db, { orgId: "org-1", userId: "" })).isOwner, false);
  assert.equal((await resolveOwnerMode(db, { orgId: "org-1", userId: "unknown" })).isOwner, false);
  assert.equal((await resolveOwnerMode(db, { orgId: "org-1", userId: "user-ghost" })).isOwner, false);
  assert.equal((await resolveOwnerMode(db, { userId: "user-1" })).isOwner, false, "needs an org");
  assert.equal((await resolveOwnerMode(fakeDb(USERS, { throws: true }), { orgId: "org-1", userId: "user-1" })).isOwner, false);
});

test("caller session exposes only availability and booking when its calendar is connected", () => {
  const base = { systemPrompt: "x", voice: "alloy", textOnly: false, transcriptionLanguage: "en" };
  const names = (cfg) => ((cfg.session || cfg).tools || []).map((t) => t.name);
  const privateOwnerOnly = ["get_my_schedule", "reschedule_appointment", "describe_my_knowledge", "find_leads", "prepare_emails", "send_prepared_emails"];

  const stranger = _internals.openAiSessionConfig({ ...base, enableSearchTool: true });
  assert.ok(!names(stranger).some((name) => privateOwnerOnly.includes(name)), "no private owner tool without owner mode");

  const caller = _internals.openAiSessionConfig({ ...base, enableCalendarTools: true });
  assert.deepEqual(names(caller), ["check_calendar_availability", "book_appointment"]);
  assert.ok(!names(caller).includes("cancel_appointment"), "caller cannot cancel an existing appointment");
  assert.ok(!names(caller).some((name) => privateOwnerOnly.includes(name)), "caller has no private owner tools");

  const truthyButNotTrue = _internals.openAiSessionConfig({ ...base, enableSearchTool: false, enableOwnerTools: "yes", enableCalendarTools: true });
  assert.ok(!names(truthyButNotTrue).some((name) => privateOwnerOnly.includes(name)), "only a real boolean true enables private owner tools");

  const owner = _internals.openAiSessionConfig({ ...base, enableSearchTool: true, enableCalendarTools: true, enableOwnerTools: true });
  assert.ok(names(owner).includes("get_my_schedule"));
  assert.ok(names(owner).includes("search_business_knowledge"));
});

test("owner mode requires an explicit signed-token mode claim", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "webcall-stream.js"), "utf8");
  assert.ok(!/enableOwnerTools:\s*true/.test(src), "enableOwnerTools must be derived, not hardcoded");
  assert.match(src, /enableOwnerTools:\s*ownerMode\.isOwner/);
  assert.match(src, /claims\.mode === "owner"/);
  assert.match(src, /enableCalendarTools:\s*calendarToolsEnabled/);
});

test("caller booking requires the caller to affirm after the agent proposes a time", () => {
  assert.equal(_internals.clearCallerConfirmation("Yes, book that time."), true);
  assert.equal(_internals.clearCallerConfirmation("That works for me!"), true);
  assert.equal(_internals.clearCallerConfirmation("No, not that time."), false);
  assert.equal(_internals.clearCallerConfirmation("I need to book an appointment."), false);
});

test("calendar tools are not advertised without configured internal API access", async () => {
  const previousApi = process.env.API_URL;
  const previousSecret = process.env.INTERNAL_API_SECRET;
  delete process.env.API_URL;
  delete process.env.INTERNAL_API_SECRET;
  try {
    const db = { from() { throw new Error("must fail closed before database query"); } };
    assert.equal(await _internals.resolveWebcallCalendarConnection(db, "org-1"), null);
  } finally {
    if (previousApi === undefined) delete process.env.API_URL;
    else process.env.API_URL = previousApi;
    if (previousSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = previousSecret;
  }
});

test("the phone path never loads the owner-tools module", () => {
  const phoneSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "twilio-media-stream.js"), "utf8");
  assert.ok(!phoneSrc.includes("webcall-owner-tools"));
  assert.ok(!phoneSrc.includes("get_my_schedule"));
});

test("owner instructions address the owner, not a caller", () => {
  const text = buildOwnerInstructions({ ownerName: "Ada", businessName: "Nutra Wellness", agentName: "Timi" });
  assert.match(text, /Ada/);
  assert.match(text, /PRIVATE OWNER CALL/);
  assert.match(text, /localStart and localEnd exactly as supplied/);
  assert.match(text, /Never convert or infer a local time/);
});

test("schedule window defaults to one day and caps at seven", () => {
  const now = new Date("2026-10-07T09:00:00.000Z");
  assert.deepEqual(scheduleWindow({}, now), { fromISO: "2026-10-07T09:00:00.000Z", toISO: "2026-10-08T09:00:00.000Z" });
  const week = scheduleWindow({ date: "2026-10-09", days: 30 }, now);
  assert.equal(week.fromISO, "2026-10-09T00:00:00.000Z");
  assert.equal(week.toISO, "2026-10-16T00:00:00.000Z");
});

// --- per-call runner: emails only go out after prepare, once ----------------

const { createOwnerToolRunner } = require("../lib/webcall-owner-tools");

function recordingFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const path = String(url).split("/api/internal/owner")[1];
    calls.push({ path, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(responses[path] || { success: true }), { status: 200 });
  };
  return { calls, fetchImpl };
}

function withInternalEnv(fn) {
  const prev = { API_URL: process.env.API_URL, INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET };
  process.env.API_URL = "http://api.test";
  process.env.INTERNAL_API_SECRET = "s";
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("send_prepared_emails refuses a batch this call never prepared", () =>
  withInternalEnv(async () => {
    const { calls, fetchImpl } = recordingFetch({});
    const runner = createOwnerToolRunner({ organizationId: "o", voiceAgentId: "a", fetchImpl });
    const result = await runner.run("send_prepared_emails", { batch_id: "made-up" });
    assert.equal(result.code, "unknown_batch");
    assert.equal(calls.length, 0, "nothing reaches the send endpoint");
  }));

test("prepared drafts are sent exactly as prepared, and only once", () =>
  withInternalEnv(async () => {
    const drafts = [
      { leadId: "l1", name: "Luqman", to: "luqman@example.com", subject: "New time", body: "Hi Luqman..." },
      { leadId: "l2", name: "Ada", to: "ada@example.com", subject: "New time", body: "Hi Ada..." },
    ];
    const { calls, fetchImpl } = recordingFetch({
      "/email/prepare": { success: true, from: "owner@gmail.test", drafts, skipped: [] },
      "/email/send": { success: true, sent: 2, failed: 0 },
    });
    const runner = createOwnerToolRunner({ organizationId: "o", voiceAgentId: "a", fetchImpl });
    const prepared = await runner.run("prepare_emails", { purpose: "reschedule", tag: "vip" });
    assert.equal(prepared.recipient_count, 2);
    assert.equal(prepared.sample.to, "luqman@example.com");
    assert.ok(!("drafts" in prepared), "the model gets a summary, not raw drafts it could edit");

    const sent = await runner.run("send_prepared_emails", { batch_id: prepared.batch_id });
    assert.equal(sent.sent, 2);
    const sendCall = calls.find((c) => c.path === "/email/send");
    assert.deepEqual(sendCall.body.drafts, drafts);
    assert.equal(sendCall.body.organizationId, "o");

    const again = await runner.run("send_prepared_emails", { batch_id: prepared.batch_id });
    assert.equal(again.code, "unknown_batch", "a batch cannot be sent twice");
  }));

test("the owner tool list carries the new business tools", () => {
  const names = ownerToolDefinitions().map((d) => d.name);
  for (const n of ["reschedule_appointment", "describe_my_knowledge", "find_leads", "prepare_emails", "send_prepared_emails"]) {
    assert.ok(names.includes(n), n);
    assert.ok(isOwnerTool(n), n);
  }
});
