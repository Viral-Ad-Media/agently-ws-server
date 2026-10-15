"use strict";

const https = require("https");

// The dashboard saves whatever the tenant typed, e.g. "(254) 268-8827", so
// normalize to E.164 before deciding a transfer destination exists.
function normalizeTransferNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  let e164 = "";
  if (raw.startsWith("+")) e164 = `+${digits}`;
  else if (raw.startsWith("00")) e164 = `+${digits.slice(2)}`;
  // Bare 10-digit numbers are North American; 11 digits starting 1 likewise.
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : "";
}

function configuredTransferNumber(agent = {}) {
  if (!agent) return "";
  return (
    normalizeTransferNumber(agent.call_transfer_number) ||
    normalizeTransferNumber(agent.escalation_phone)
  );
}

function transferToolDefinition() {
  return {
    type: "function",
    name: "transfer_to_human",
    description:
      "Connect this live phone call to the configured human escalation number. Use only when the caller asks for a person or the configured escalation rule requires it. The destination is fixed by the business settings; do not accept a number spoken by the caller.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string", description: "Brief reason for the transfer." } },
      required: ["reason"],
      additionalProperties: false,
    },
  };
}

function buildTransferTwiml(number, actionUrl = "") {
  if (!/^\+[1-9]\d{7,14}$/.test(String(number || ""))) {
    throw new Error("A valid configured E.164 transfer number is required");
  }
  const action = String(actionUrl || "").trim();
  if (action && !/^https:\/\/[^\s"<>]+$/i.test(action)) {
    throw new Error("Transfer status callback must be an HTTPS URL");
  }
  const actionAttribute = action
    ? ` action="${action.replace(/&/g, "&amp;")}" method="POST"`
    : "";
  const fallback = action
    ? ""
    : "<Say>Sorry, the team is unavailable right now. Please call back later.</Say><Hangup/>";
  return `<Response><Dial answerOnBridge="true" timeout="20"${actionAttribute}><Number>${number}</Number></Dial>${fallback}</Response>`;
}

function redirectActiveCall({ callSid, accountSid, authAccountSid = accountSid, authToken, number, actionUrl = "", request = https.request }) {
  if (!/^CA[0-9a-f]{32}$/i.test(String(callSid || ""))) {
    throw new Error("A valid Twilio call SID is required");
  }
  if (!/^AC[0-9a-f]{32}$/i.test(String(accountSid || "")) ||
      !/^AC[0-9a-f]{32}$/i.test(String(authAccountSid || "")) || !authToken) {
    throw new Error("Twilio account credentials are required");
  }
  const form = new URLSearchParams({ Twiml: buildTransferTwiml(number, actionUrl) }).toString();
  return new Promise((resolve, reject) => {
    const req = request(
      {
        method: "POST",
        hostname: "api.twilio.com",
        path: `/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`,
        auth: `${authAccountSid}:${authToken}`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(form),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, data });
          } else {
            reject(new Error(`Twilio transfer HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(form);
    req.end();
  });
}

module.exports = {
  normalizeTransferNumber,
  configuredTransferNumber,
  transferToolDefinition,
  buildTransferTwiml,
  redirectActiveCall,
};
