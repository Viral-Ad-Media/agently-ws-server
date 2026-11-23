"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeCallTranscript } = require("../lib/call-transcript");
const { customerPhone } = require("../lib/customer-contact");
test("outbound callback details use the customer number rather than the business line", () => {
  assert.equal(customerPhone({direction:"outbound",callerPhone:"+15550000001",recipientPhone:"+15550000002"}),"+15550000002");
  assert.equal(customerPhone({direction:"outbound",callerPhone:"+15550000001"}),"");
  assert.equal(customerPhone({direction:"inbound",callerPhone:"+15550000002"}),"+15550000002");
});
test("retrying a transfer and saving a resumed stream retains every conversation segment", () => {
  const first = {role:"caller",text:"My name is Luqman",ts:"2026-10-19T12:00:00Z"};
  const representative = {role:"transcription",speaker:"Speaker B",text:"Hello",recording_sid:"RE-human",ts:"2026-10-19T12:01:00Z"};
  const resumed = {role:"assistant",text:"Would you like to leave a message?",ts:"2026-10-19T12:02:00Z"};
  assert.deepEqual(mergeCallTranscript([first,representative],[resumed]),[first,representative,resumed]);
  assert.deepEqual(mergeCallTranscript([first],[first,resumed]),[first,resumed]);
});
