"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TRANSFER_TOOL_NAME,
  normalizeTransferNumber,
  transferNumberForAgent,
  transferToolDefinition,
  transferPromptRules,
  buildTransferTwiml,
} = require("../lib/human-transfer");

test("normalizes dashboard-entered numbers to E.164", () => {
  assert.equal(normalizeTransferNumber("+1 (415) 555-0100"), "+14155550100");
  assert.equal(normalizeTransferNumber("415-555-0100"), "+14155550100");
  assert.equal(normalizeTransferNumber("14155550100"), "+14155550100");
  assert.equal(normalizeTransferNumber("0044 20 7946 0958"), "+442079460958");
  assert.equal(normalizeTransferNumber("sip:desk@example.com"), "sip:desk@example.com");
  assert.equal(normalizeTransferNumber("123"), "");
  assert.equal(normalizeTransferNumber(""), "");
});

test("prefers call_transfer_number, falls back to escalation_phone", () => {
  assert.equal(
    transferNumberForAgent({ call_transfer_number: "+14155550100", escalation_phone: "+14155550199" }),
    "+14155550100",
  );
  assert.equal(transferNumberForAgent({ escalation_phone: "+14155550199" }), "+14155550199");
  assert.equal(transferNumberForAgent({}), "");
  assert.equal(transferNumberForAgent(null), "");
});

test("tool and prompt rules exist only with a transfer number", () => {
  assert.equal(transferToolDefinition().name, TRANSFER_TOOL_NAME);
  assert.equal(transferPromptRules({}), "");
  assert.match(transferPromptRules({ transferNumber: "+14155550100" }), /transfer_to_human/);
});

test("TwiML dials the number and escapes input", () => {
  const twiml = buildTransferTwiml("+14155550100");
  assert.match(twiml, /<Dial timeout="\d+"><Number>\+14155550100<\/Number><\/Dial>/);
  assert.match(twiml, /<Say>Please hold/);
  assert.match(buildTransferTwiml("sip:a&b@x.com"), /<Sip>sip:a&amp;b@x.com<\/Sip>/);
});
