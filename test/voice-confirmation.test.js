"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createVoiceConfirmation } = require("../lib/voice-confirmation");
const { calendarWindow } = require("../lib/calendar-time");
const args = { start_time: "2026-10-09T12:30:00Z", attendee_name: "Toby" };

test("a late yes transcript authorizes the staged slot despite a later agent acknowledgement", async () => {
  const gate = createVoiceConfirmation({ timeoutMs: 100 });
  assert.equal(await gate.authorize("book_appointment", args), false);
  gate.agentSpoke();
  gate.speechStarted("turn-1");
  const approved = gate.authorize("book_appointment", args);
  gate.agentSpoke(); // 'Got it' must not erase the user's approval turn.
  gate.transcribed("turn-1", "Yes, yes, I confirm.");
  assert.equal(await approved, true);
  assert.equal(await gate.authorize("book_appointment", args), false, "approval is single-use");
});

test("approval before a preview or for changed details cannot book", async () => {
  const gate = createVoiceConfirmation({ timeoutMs: 10 });
  gate.speechStarted("before"); gate.transcribed("before", "Yes");
  assert.equal(await gate.authorize("book_appointment", args), false);
  gate.agentSpoke(); gate.speechStarted("after"); gate.transcribed("after", "Yes");
  assert.equal(await gate.authorize("book_appointment", { ...args, start_time: "2026-10-09T14:00:00Z" }), false);
});

test("old transcripts, refusals, corrections, and missing ASR fail closed", async () => {
  for (const text of ["No, wait", "Yes but use another time", "Bye bye", "I need an appointment"]) {
    const gate = createVoiceConfirmation({ timeoutMs: 5 });
    await gate.authorize("book_appointment", args);
    gate.agentSpoke(); gate.speechStarted("new");
    gate.transcribed("old", "Yes"); gate.transcribed("new", text);
    assert.equal(await gate.authorize("book_appointment", args), false);
  }
  const gate = createVoiceConfirmation({ timeoutMs: 5 });
  await gate.authorize("book_appointment", args); gate.agentSpoke(); gate.speechStarted("silent");
  assert.equal(await gate.authorize("book_appointment", args), false);
});

test("calendar date windows use Lagos midnight and daylight saving boundaries", () => {
  assert.deepEqual(calendarWindow("2026-10-09", 1, "Africa/Lagos"), { fromISO: "2026-10-08T23:00:00.000Z", toISO: "2026-10-09T23:00:00.000Z" });
  const spring = calendarWindow("2026-03-08", 1, "America/New_York");
  assert.equal((Date.parse(spring.toISO) - Date.parse(spring.fromISO)) / 3600000, 23);
});
