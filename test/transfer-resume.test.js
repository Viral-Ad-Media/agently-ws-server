"use strict";

const assert = require("assert");
const test = require("node:test");
const { _testing: t } = require("../lib/twilio-media-stream");

// Open around the clock so the tests don't depend on the time they run.
const agent = {
  escalation_phone: "(254) 268-8827",
  escalation_hours_start: "00:00",
  escalation_hours_end: "00:00",
};

function toolNames(session) {
  return session.session.tools.map((tool) => tool.name);
}

test("the resume flag arrives through the stream start parameters", () => {
  const ctx = t.mergeStartParameters({}, { customParameters: { transferResume: "failed" } });
  assert.strictEqual(t.isTransferResume(ctx), true);
  assert.strictEqual(t.isTransferResume({}), false);
});

test("a normal call offers transfer_to_human and the 'please hold' line", () => {
  const ctx = { agent, organization: { timezone: "America/Chicago" } };
  const session = t.realtimeSessionUpdateTextOnlyCurrent("prompt", true, ctx);
  assert.ok(toolNames(session).includes("transfer_to_human"));
  assert.match(session.session.instructions, /let me try to connect you with one of our team\. Please hold/i);
});

test("a reconnected caller is not offered another transfer and gets the message/callback offer", () => {
  const ctx = { agent, organization: { timezone: "America/Chicago" }, transferResume: "failed" };
  assert.strictEqual(t.transferToolAvailable(ctx), false);
  for (const session of [
    t.realtimeSessionUpdateTextOnlyCurrent("prompt", true, ctx),
    t.realtimeSessionUpdateCurrent("prompt", "alloy", true, ctx),
  ]) {
    assert.ok(!toolNames(session).includes("transfer_to_human"));
    assert.match(session.session.instructions, /nobody answered/i);
    assert.match(session.session.instructions, /Do not try to transfer again/);
  }
  assert.match(t.TRANSFER_RESUME_GREETING, /leave a message, or have someone call you back\?$/);
});
