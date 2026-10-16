"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const test = require("node:test");
const {
  configuredTransferNumber,
  transferAvailability,
  parseHoursText,
  transferMaxAttempts,
  buildTransferActionUrl,
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

  // Escalation working hours, judged in the business timezone.
  const at = (iso) => new Date(iso);
  const nineToFive = { escalation_hours_start: "09:00", escalation_hours_end: "17:00" };
  // 14:00Z is 10:00 in New York (EDT): open. 23:00Z is 19:00: closed.
  assert.strictEqual(transferAvailability(nineToFive, "America/New_York", at("2026-10-15T14:00:00Z")).open, true);
  const closed = transferAvailability(nineToFive, "America/New_York", at("2026-10-15T23:00:00Z"));
  assert.strictEqual(closed.open, false);
  assert.strictEqual(closed.hoursText, "9:00 AM to 5:00 PM");
  assert.strictEqual(closed.timezone, "America/New_York");
  // End is exclusive: 17:00 sharp is closed, 16:59 is open.
  assert.strictEqual(transferAvailability(nineToFive, "America/New_York", at("2026-10-15T21:00:00Z")).open, false);
  assert.strictEqual(transferAvailability(nineToFive, "America/New_York", at("2026-10-15T20:59:00Z")).open, true);
  // Same instant, different business timezone: 17:30Z is 18:30 in Lagos.
  assert.strictEqual(transferAvailability(nineToFive, "Africa/Lagos", at("2026-10-15T17:30:00Z")).open, false);
  assert.strictEqual(transferAvailability(nineToFive, "Africa/Lagos", at("2026-10-15T14:00:00Z")).open, true);
  // No usable hours never blocks a transfer; a bad timezone falls back to New York.
  assert.strictEqual(transferAvailability({}, "Not/AZone", at("2026-10-15T23:00:00Z")).open, true);
  assert.strictEqual(transferAvailability({ business_hours: "call anytime you like" }, "", at("2026-10-15T23:00:00Z")).open, true);
  assert.strictEqual(transferAvailability({}, "", at("2026-10-15T23:00:00Z")).timezone, "America/New_York");

  // The dashboard's free-text "Escalation Manager Working Hours" (business_hours).
  // 2026-10-15 is a Thursday; 2026-10-17 a Saturday.
  const monFri = { business_hours: "Mon-Fri 9AM-6PM" };
  assert.strictEqual(transferAvailability(monFri, "America/New_York", at("2026-10-15T21:30:00Z")).open, true); // Thu 5:30 PM
  assert.strictEqual(transferAvailability(monFri, "America/New_York", at("2026-10-15T22:30:00Z")).open, false); // Thu 6:30 PM
  const saturday = transferAvailability(monFri, "America/New_York", at("2026-10-17T15:00:00Z")); // Sat 11 AM
  assert.strictEqual(saturday.open, false);
  assert.strictEqual(saturday.hoursText, "Monday to Friday, 9:00 AM to 6:00 PM");
  assert.strictEqual(transferAvailability({ business_hours: "9:00 AM - 5:00 PM" }, "America/New_York", at("2026-10-17T15:00:00Z")).open, true);
  assert.deepStrictEqual(parseHoursText("Monday to Friday, 8:30am to 5pm"), { start: 510, end: 1020, days: new Set([1, 2, 3, 4, 5]) });
  assert.deepStrictEqual(parseHoursText("weekdays 9-5"), { start: 540, end: 1020, days: new Set([1, 2, 3, 4, 5]) });
  assert.strictEqual(parseHoursText("24/7").always, true);
  assert.strictEqual(parseHoursText("whenever"), null);
  // Explicit HH:MM columns win over the free text.
  assert.strictEqual(
    transferAvailability({ ...monFri, escalation_hours_start: "00:00", escalation_hours_end: "00:00" }, "America/New_York", at("2026-10-17T15:00:00Z")).open,
    true,
  );
  // Overnight window 22:00-06:00: 03:00 New York (07:00Z) open, noon closed.
  const overnight = { escalation_hours_start: "22:00", escalation_hours_end: "06:00" };
  assert.strictEqual(transferAvailability(overnight, "America/New_York", at("2026-10-15T07:00:00Z")).open, true);
  assert.strictEqual(transferAvailability(overnight, "America/New_York", at("2026-10-15T16:00:00Z")).open, false);
  // Start == end means around the clock.
  const always = transferAvailability({ escalation_hours_start: "00:00", escalation_hours_end: "00:00" }, "UTC", at("2026-10-15T03:00:00Z"));
  assert.strictEqual(always.open, true);
  assert.strictEqual(always.hoursText, "any time");

  // Redial attempts from the agent's rules (Assignment & routing): 1-3, default 2.
  assert.strictEqual(transferMaxAttempts({}), 2);
  assert.strictEqual(transferMaxAttempts({ rules: { transferAttempts: 3 } }), 3);
  assert.strictEqual(transferMaxAttempts({ rules: { transferAttempts: 9 } }), 3);
  assert.strictEqual(transferMaxAttempts({ rules: { transferAttempts: 0 } }), 1);
  assert.strictEqual(transferMaxAttempts({ rules: { transferAttempts: "x" } }), 2);

  // The <Dial action> callback carries what /transfer-status needs to retry or resume.
  const action = new URL(buildTransferActionUrl("https://api.example.test/", {
    attempt: 1, maxAttempts: 3, orgId: "org-1", agentId: "agent-1", callRecordId: "rec-1",
    direction: "outbound", accountSid: `AC${"a".repeat(32)}`, recipientName: "Rabiu", callPurpose: "x".repeat(400),
  }));
  assert.strictEqual(action.pathname, "/api/twilio/transfer-status");
  assert.strictEqual(action.searchParams.get("attempt"), "1");
  assert.strictEqual(action.searchParams.get("max"), "3");
  assert.strictEqual(action.searchParams.get("agentId"), "agent-1");
  assert.strictEqual(action.searchParams.get("callPurpose").length, 300);
  assert.strictEqual(action.searchParams.has("callerPhone"), false);
  assert.strictEqual(buildTransferActionUrl("http://insecure.test", {}), "");
  assert.match(
    buildTransferTwiml("+15551234567", action.toString()),
    /<Dial answerOnBridge="true" timeout="20" action="https:\/\/api\.example\.test\/api\/twilio\/transfer-status\?attempt=1&amp;max=3/,
  );
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
