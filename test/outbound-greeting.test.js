"use strict";

const assert = require("assert");
const test = require("node:test");
const voiceBehavior = require("../lib/voice-behavior");

// The purpose text from the 15 Oct test call, exactly as the tenant typed it.
const REAL_PURPOSE =
  "welcome our new customers and onboard them to the business , make inquires about about them and ask if they will be willing to come on our calender and book  an appointment with our CEO - luqman or would like to talk to a manager -now on the call";

function opener(callPurpose) {
  return voiceBehavior.resolveOpeningGreeting({
    agent: { name: "Timi" },
    direction: "outbound",
    recipientName: "Rabiu",
    callPurpose,
    agentName: "Timi",
    organizationName: "Viral-Ad Media",
  });
}

test("a long multi-instruction purpose is never read out in the opener", () => {
  const line = opener(REAL_PURPOSE);
  assert.match(line, /^Hello Rabiu, this is Timi from Viral-Ad Media\./);
  assert.match(line, /I'm calling with a quick follow-up\./);
  assert.match(line, /Do you have a quick moment to talk\?$/);
  for (const fragment of ["welcome our new customers", "onboard them", "calender", "reaching out about"]) {
    assert.ok(!line.toLowerCase().includes(fragment), `opener leaked "${fragment}": ${line}`);
  }
});

test("a short, speakable purpose still gives a specific reason", () => {
  assert.match(opener("confirm your appointment for tomorrow"), /I'm calling to confirm your appointment for tomorrow\./);
  assert.match(opener("a quick check-in"), /check-in/);
});
