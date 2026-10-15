"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const test = require("node:test");
const {
  configuredTransferNumber,
  transferToolDefinition,
  buildTransferTwiml,
  redirectActiveCall,
} = require("../lib/call-transfer");

async function run() {
  assert.strictEqual(configuredTransferNumber({ escalation_phone: "+15551234567" }), "+15551234567");
  assert.strictEqual(configuredTransferNumber({ escalation_phone: "2542688827" }), "+12542688827");
  assert.strictEqual(configuredTransferNumber({ escalation_phone: "(254) 268-8827" }), "+12542688827");
  assert.strictEqual(
    configuredTransferNumber({ call_transfer_number: "", escalation_phone: "+44 20 7946 0958" }),
    "+442079460958",
  );
  assert.strictEqual(
    configuredTransferNumber({ call_transfer_number: "123", escalation_phone: "(254) 268-8827" }),
    "+12542688827",
  );
  assert.strictEqual(configuredTransferNumber({ escalation_phone: "123" }), "");
  assert.strictEqual(configuredTransferNumber(null), "");
  assert.strictEqual(transferToolDefinition().name, "transfer_to_human");
  assert.match(buildTransferTwiml("+15551234567"), /<Dial answerOnBridge="true" timeout="20">/);
  assert.match(
    buildTransferTwiml("+15551234567", "https://example.test/api/twilio/transfer-status"),
    /action="https:\/\/example.test\/api\/twilio\/transfer-status" method="POST"/,
  );
  assert.throws(() => buildTransferTwiml("+1<bad>"));
  assert.throws(() => buildTransferTwiml("+15551234567", "http://example.test/callback"));

  const accountSid = `AC${"a".repeat(32)}`;
  const authAccountSid = `AC${"c".repeat(32)}`;
  const callSid = `CA${"b".repeat(32)}`;
  let captured;
  const request = (options, onResponse) => {
    const req = new EventEmitter();
    req.write = (form) => { captured = { options, form }; };
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      onResponse(res);
      res.emit("data", "{}");
      res.emit("end");
    };
    return req;
  };
  await redirectActiveCall({
    callSid,
    accountSid,
    authAccountSid,
    authToken: "test-token",
    number: "+15551234567",
    request,
  });
  assert.strictEqual(captured.options.method, "POST");
  assert.strictEqual(captured.options.path, `/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`);
  assert.strictEqual(captured.options.auth, `${authAccountSid}:test-token`);
  assert.match(new URLSearchParams(captured.form).get("Twiml"), /<Number>\+15551234567<\/Number>/);
  assert.throws(() => redirectActiveCall({ callSid: "bad", accountSid, authToken: "x", number: "+15551234567" }));
  const rejectedRequest = (options, onResponse) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 400;
      onResponse(res);
      res.emit("data", "invalid destination");
      res.emit("end");
    };
    return req;
  };
  await assert.rejects(
    redirectActiveCall({ callSid, accountSid, authToken: "test-token", number: "+15551234567", request: rejectedRequest }),
    /Twilio transfer HTTP 400/,
  );
  console.log("call-transfer: passed");
}

if (require.main === module) run().catch((err) => { console.error(err); process.exitCode = 1; });
else test("configured live transfer uses Twilio call redirect", run);
module.exports = run;
