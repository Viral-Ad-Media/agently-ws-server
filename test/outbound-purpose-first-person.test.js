"use strict";

// The agent must explain why it is calling the way a staff member would,
// to ONE person, in the first person. Tenants write purposes about the
// campaign ("reach out to all customers to give them season greetings"); the
// agent used to repeat that framing ("the reason for my calling is to reach
// out to all customers...").

const assert = require("assert");
const test = require("node:test");
const voiceBehavior = require("../lib/voice-behavior");
const voicemail = require("../lib/voicemail-policy");

function opener(callPurpose, agent = { name: "Maya" }) {
  return voiceBehavior.resolveOpeningGreeting({
    agent,
    direction: "outbound",
    recipientName: "John",
    organizationName: "Summit Ridge Roofing",
    callPurpose,
  });
}

const CAMPAIGN_WORDING = /all customers|our customers|all clients|everyone on|the reason for my call|reach out to/i;

test("seasonal campaign becomes a first-person holiday wish", () => {
  const line = opener("reach out to all customers to give them season greetings");
  assert.match(line, /^Hello John, this is Maya from Summit Ridge Roofing\./);
  assert.match(line, /I'm calling to wish you a happy holiday season\./);
  assert.doesNotMatch(line, CAMPAIGN_WORDING);
});

test("campaign audience is turned into 'you'", () => {
  const cases = {
    "remind clients their annual roof inspection is due": /I'm calling to remind you that your annual roof inspection is due\./,
    "let all customers know the office is closed on Friday": /I'm calling to let you know that the office is closed on Friday\./,
    "thank our members for their loyalty this year": /I'm calling to thank you for your loyalty this year\./,
    "Promote our new spring discount": /I'm calling to tell you about our new spring discount\./,
    "call all our customers and let them know we now offer gutter cleaning": /I'm calling to let you know we now offer gutter cleaning\./,
  };
  for (const [purpose, expected] of Object.entries(cases)) {
    const line = opener(purpose);
    assert.match(line, expected, purpose);
    assert.doesNotMatch(line, CAMPAIGN_WORDING, purpose);
  }
});

test("an inbound greeting is never used to open an outbound call", () => {
  const line = opener("confirm your appointment for tomorrow", {
    name: "Maya",
    greeting: "Hello, thanks for calling. How can I help?",
  });
  assert.doesNotMatch(line, /how can I help/i);
  assert.match(line, /I'm calling to confirm your appointment for tomorrow\./);
});

test("a dedicated outbound greeting still wins", () => {
  const line = opener("anything", { name: "Maya", outbound_greeting: "Hi John, Maya here from Summit Ridge." });
  assert.match(line, /^Hi John, Maya here from Summit Ridge\./);
});

test("the prompt gives the speech-ready reason plus first-person rules, never the raw label", () => {
  const rules = voiceBehavior.outboundBehaviorRules({
    callPurpose: "reach out to all customers to give them season greetings",
    recipientName: "John",
  });
  assert.doesNotMatch(rules, /Recipient-facing call reason: reach out/);
  assert.match(rules, /already phrased for this person.*to wish you a happy holiday season/);
  assert.match(rules, /speaking to ONE person/);
  assert.match(rules, /Never say 'the reason for my call is'/);
});

test("default voicemail uses first-person wording", () => {
  const message = voicemail.buildVoicemailMessage(
    {},
    {
      agentName: "Maya",
      businessName: "Summit Ridge Roofing",
      callPurpose: "reach out to all customers to give them season greetings",
    },
  );
  assert.match(message, /I'm calling to wish you a happy holiday season\./);
  assert.doesNotMatch(message, CAMPAIGN_WORDING);
});
