"use strict";
/*
 * Live transfer to a human for Twilio media-stream calls.
 *
 * Phone calls run on <Connect><Stream> with OpenAI Realtime, which has no
 * built-in way to hand the caller to a person. The agent gets a
 * transfer_to_human tool when its voice_agents row has a transfer number
 * (call_transfer_number, else escalation_phone). Calling it rewrites the live
 * call's TwiML over the Twilio REST API to <Dial> that number; the new TwiML
 * ends the stream, so the AI drops off and the caller is bridged.
 */
const https = require("https");

const TRANSFER_TOOL_NAME = "transfer_to_human";
const TRANSFER_HOLD_MESSAGE = "Please hold while I transfer your call.";
const TRANSFER_DIAL_TIMEOUT_SECONDS = Math.max(
  5,
  Number(process.env.TRANSFER_DIAL_TIMEOUT_SECONDS || 25) || 25,
);

/** E.164 (or a SIP URI) from whatever the tenant typed in the dashboard. */
function normalizeTransferNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^sips?:/i.test(raw)) return raw;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 8 || digits.length > 15) return "";
  if (raw.startsWith("+")) return `+${digits}`;
  if (raw.startsWith("00")) return `+${digits.slice(2)}`;
  // Bare 10-digit numbers are North American; 11 digits starting 1 likewise.
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

function transferNumberForAgent(agent) {
  if (!agent) return "";
  return normalizeTransferNumber(
    agent.call_transfer_number ||
      agent.callTransferNumber ||
      agent.escalation_phone ||
      agent.escalationPhone,
  );
}

function transferToolDefinition() {
  return {
    type: "function",
    name: TRANSFER_TOOL_NAME,
    description:
      "Transfer this live call to a real person at the business. Use it as soon as the caller asks to speak with a human, a real person, a manager, staff, or a representative, or insists after you have offered to help. Say one short line first (for example 'Sure, connecting you now'), then call this. Never read the transfer phone number aloud.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Short reason the caller wants a person.",
        },
      },
      additionalProperties: false,
    },
  };
}

function transferPromptRules(context = {}) {
  if (!context.transferNumber) return "";
  return [
    "Live transfer rules:",
    `- If the caller asks for a real person, a human, a manager, staff or a representative, say one short line such as 'Sure, connecting you now' and call ${TRANSFER_TOOL_NAME}. Do not offer to take a message instead, and do not keep answering questions.`,
    "- Never read the transfer phone number aloud.",
    `- If ${TRANSFER_TOOL_NAME} reports it failed, apologise briefly and offer to take the caller's name, number and message so the team can call back.`,
  ].join("\n");
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildTransferTwiml(number, { holdMessage = TRANSFER_HOLD_MESSAGE } = {}) {
  const target = /^sips?:/i.test(number)
    ? `<Sip>${escapeXml(number)}</Sip>`
    : `<Number>${escapeXml(number)}</Number>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    (holdMessage ? `<Say>${escapeXml(holdMessage)}</Say>` : "") +
    `<Dial timeout="${TRANSFER_DIAL_TIMEOUT_SECONDS}">${target}</Dial>` +
    `</Response>`
  );
}

/** Replace the live call's TwiML with a <Dial> to the transfer number. */
function redirectCallToNumber(callSid, number, accountSidOverride = "") {
  if (!callSid) return Promise.reject(new Error("Missing callSid"));
  if (!number) return Promise.reject(new Error("Missing transfer number"));
  const accountSid = String(
    accountSidOverride || process.env.TWILIO_ACCOUNT_SID || "",
  ).trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  if (!accountSid || !authToken)
    return Promise.reject(
      new Error("TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is not configured"),
    );
  const form = new URLSearchParams({ Twiml: buildTransferTwiml(number) }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "POST",
        hostname: "api.twilio.com",
        path: `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(callSid)}.json`,
        auth: `${accountSid}:${authToken}`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(form),
        },
        timeout: 10000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300)
            return resolve({ statusCode: res.statusCode, data });
          reject(
            new Error(`Twilio REST HTTP ${res.statusCode}: ${data.slice(0, 500)}`),
          );
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Twilio REST timeout")));
    req.on("error", reject);
    req.write(form);
    req.end();
  });
}

module.exports = {
  TRANSFER_TOOL_NAME,
  TRANSFER_HOLD_MESSAGE,
  normalizeTransferNumber,
  transferNumberForAgent,
  transferToolDefinition,
  transferPromptRules,
  buildTransferTwiml,
  redirectCallToNumber,
};
