"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Real worker, isolated provider/database. Never loads .env or starts timers.
function harness(fetchPage) {
  const updates = [];
  const logs = [];
  const agent = { id: "test-agent", twilio_phone_number: "+15555550123",
    twilio_phone_sid: "CA_test", twilio_billing_usd: "50.0000",
    twilio_monthly_rental_usd: "0", twilio_billing_period_start: "2026-09-01" };
  const query = { neq() { return this; }, not() { return this; },
    then(resolve, reject) { return Promise.resolve({ data: [agent], error: null }).then(resolve, reject); } };
  const db = { from(table) {
    assert.equal(table, "voice_agents");
    return { select: () => query, update: (values) => ({ eq: async (key, id) => {
      assert.equal(key, "id"); assert.equal(id, agent.id);
      updates.push(values); return { error: null };
    } }) };
  } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../lib/billing_tracker.js"), "utf8"), {
    module, URLSearchParams, Buffer,
    process: { env: { TWILIO_ACCOUNT_SID: "AC_test", TWILIO_AUTH_TOKEN: "isolated-placeholder" } },
    console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    require: (id) => { assert.equal(id, "./supabase"); return { getSupabase: () => db }; },
    fetch: fetchPage,
    setTimeout: (fn) => { fn(); },
  });
  return { tracker: module.exports, updates, logs };
}

const page = (calls = [], next = null) => ({ ok: true, status: 200,
  json: async () => ({ calls, next_page_uri: next }) });
const rejected = () => ({ ok: false, status: 503, text: async () => "private provider response" });

test("failed first or later provider pages never overwrite a stored total", async () => {
  for (const failAt of [1, 2, 3]) {
    let calls = 0;
    const h = harness(async () => {
      calls++;
      if (calls === failAt) return rejected();
      return page([{ price: "-5" }], calls === 1 ? "/Calls.json?Page=1" : null);
    });
    await h.tracker.runOnce();
    assert.equal(h.updates.length, 0);
    assert.equal(JSON.stringify(h.logs).includes("+15555550123"), false);
    assert.equal(JSON.stringify(h.logs).includes("private provider response"), false);
  }
});

test("network and malformed/404 responses preserve stored billing", async () => {
  for (const response of [
    () => { throw new Error("network unavailable"); },
    () => ({ ok: false, status: 404 }),
    () => ({ ok: true, status: 200, json: async () => ({}) }),
    () => ({ ok: true, status: 200, json: async () => ({ calls: {} }) }),
    () => ({ ok: true, status: 200, json: async () => ({ calls: [], next_page_uri: {} }) }),
  ]) {
    const h = harness(response);
    await h.tracker.runOnce();
    assert.equal(h.updates.length, 0);
  }
});

test("pagination limit cannot silently truncate and replace the total", async () => {
  let requests = 0;
  const h = harness(async () => { requests++; return page([{ price: "-1" }], "/Calls.json?more=1"); });
  await h.tracker.runOnce();
  assert.equal(requests, 20);
  assert.equal(h.updates.length, 0);
});

test("complete inbound and outbound pages update the scoped total", async () => {
  let requests = 0;
  const h = harness(async () => {
    requests++;
    return page([{ price: requests === 1 ? "-2.50" : "-1.25" }]);
  });
  await h.tracker.runOnce();
  assert.equal(requests, 2);
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].twilio_billing_usd, "3.7500");
});

test("a later complete pass recovers after a provider failure", async () => {
  let failed = true;
  const h = harness(async () => failed ? rejected() : page([{ price: "-1" }]));
  await h.tracker.runOnce();
  assert.equal(h.updates.length, 0);
  failed = false;
  await h.tracker.runOnce();
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].twilio_billing_usd, "2.0000");
});
