"use strict";

/**
 * twilio.js – All Twilio interactions for Agently
 *
 * Covers:
 *  - Phone number search / purchase / release / list (using company master credentials)
 *  - ConversationRelay TwiML generation (inbound + outbound)
 *  - Webhook configuration on purchased numbers
 *  - Call log / recording fetch from Twilio
 *  - Usage / billing data fetch from Twilio
 *  - WhatsApp messaging helpers (basic foundation)
 */

const TWILIO_ACCOUNT_SID = () => process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = () => process.env.TWILIO_AUTH_TOKEN;

// Base URL for company-wide master Twilio account
const TWILIO_BASE = "https://api.twilio.com/2010-04-01";

// ─────────────────────────────────────────────────────────────
// Internal fetch helper (Basic-Auth against master credentials)
// ─────────────────────────────────────────────────────────────
async function twilioRequest(method, path, params = null, isFullUrl = false) {
  const sid = TWILIO_ACCOUNT_SID();
  const token = TWILIO_AUTH_TOKEN();

  if (!sid || !token) {
    throw new Error(
      "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in environment variables.",
    );
  }

  const url = isFullUrl ? path : `${TWILIO_BASE}/Accounts/${sid}${path}`;
  const headers = {
    Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
    "Content-Type": "application/x-www-form-urlencoded",
  };

  let body;
  if (params && (method === "POST" || method === "PUT")) {
    body = new URLSearchParams(params).toString();
  }

  let fetchUrl = url;
  if (params && method === "GET") {
    const qs = new URLSearchParams(params).toString();
    fetchUrl = url + (url.includes("?") ? "&" : "?") + qs;
  }

  const res = await fetch(fetchUrl, { method, headers, body });

  if (res.status === 204) return null;

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }

  if (!res.ok) {
    const msg =
      data?.message || data?.error_message || `Twilio ${res.status} on ${path}`;
    throw new Error(msg);
  }
  return data;
}

// ─────────────────────────────────────────────────────────────
// Phone number search & purchase
// ─────────────────────────────────────────────────────────────

/**
 * List countries where Twilio supports voice numbers.
 */
async function listSupportedCountries() {
  const sid = TWILIO_ACCOUNT_SID();
  const token = TWILIO_AUTH_TOKEN();
  const url = `${TWILIO_BASE}/Accounts/${sid}/AvailablePhoneNumbers.json`;
  const data = await twilioRequest("GET", url, null, true);
  return (data?.countries || []).map((c) => ({
    country: c.country_code,
    countryName: c.country,
    hasLocal: !!c.subresource_uris?.local,
    hasTollFree: !!c.subresource_uris?.toll_free,
    hasMobile: !!c.subresource_uris?.mobile,
  }));
}

/**
 * Search available phone numbers in a country.
 * type: 'Local' | 'TollFree' | 'Mobile'
 */
async function searchAvailableNumbers({
  country = "US",
  type = "Local",
  areaCode,
  contains,
  limit = 20,
}) {
  const sid = TWILIO_ACCOUNT_SID();
  const token = TWILIO_AUTH_TOKEN();
  const url = `${TWILIO_BASE}/Accounts/${sid}/AvailablePhoneNumbers/${country}/${type}.json`;

  const params = {
    PageSize: String(Math.min(limit, 40)),
    VoiceEnabled: "true",
  };
  if (areaCode) params.AreaCode = areaCode;
  if (contains) params.Contains = contains;

  const data = await twilioRequest("GET", url, params, true);
  return (data?.available_phone_numbers || []).map((n) => ({
    phoneNumber: n.phone_number,
    friendlyName: n.friendly_name,
    locality: n.locality || "",
    region: n.region || "",
    isoCountry: n.iso_country,
    capabilities: {
      voice: n.capabilities?.voice ?? true,
      sms: n.capabilities?.SMS ?? false,
      mms: n.capabilities?.MMS ?? false,
    },
    addressRequired: n.address_requirements || "none",
    monthlyPrice: n.price || null,
  }));
}

/**
 * Purchase (provision) a phone number onto the master account.
 * Returns the IncomingPhoneNumber record.
 */
async function purchasePhoneNumber({
  phoneNumber,
  voiceWebhookUrl,
  statusCallbackUrl,
  friendlyName,
}) {
  const apiUrl = (process.env.API_URL || "").replace(/\/$/, "");
  const inboundUrl = voiceWebhookUrl || `${apiUrl}/api/twilio/voice-inbound`;
  const statusUrl = statusCallbackUrl || `${apiUrl}/api/twilio/call-status`;

  const params = {
    PhoneNumber: phoneNumber,
    VoiceUrl: inboundUrl,
    VoiceMethod: "POST",
    StatusCallback: statusUrl,
    StatusCallbackMethod: "POST",
    SmsUrl: `${apiUrl}/api/twilio/sms-inbound`,
    SmsMethod: "POST",
  };
  if (friendlyName) params.FriendlyName = friendlyName;

  return twilioRequest("POST", "/IncomingPhoneNumbers.json", params);
}

/**
 * Update webhooks on an existing Twilio number (by SID).
 */
async function updateNumberWebhooks({
  phoneSid,
  voiceWebhookUrl,
  statusCallbackUrl,
}) {
  const apiUrl = (process.env.API_URL || "").replace(/\/$/, "");
  const params = {
    VoiceUrl: voiceWebhookUrl || `${apiUrl}/api/twilio/voice-inbound`,
    VoiceMethod: "POST",
    StatusCallback: statusCallbackUrl || `${apiUrl}/api/twilio/call-status`,
    StatusCallbackMethod: "POST",
  };
  return twilioRequest(
    "POST",
    `/IncomingPhoneNumbers/${phoneSid}.json`,
    params,
  );
}

/**
 * Release (delete) a number from the account.
 */
async function releasePhoneNumber(phoneSid) {
  return twilioRequest("DELETE", `/IncomingPhoneNumbers/${phoneSid}.json`);
}

/**
 * List all numbers currently on the master account.
 */
async function listOwnedNumbers() {
  const data = await twilioRequest("GET", "/IncomingPhoneNumbers.json", {
    PageSize: "100",
  });
  return (data?.incoming_phone_numbers || []).map((n) => ({
    sid: n.sid,
    phoneNumber: n.phone_number,
    friendlyName: n.friendly_name,
    voiceUrl: n.voice_url,
    smsUrl: n.sms_url,
    dateCreated: n.date_created,
    capabilities: {
      voice: n.capabilities?.voice ?? true,
      sms: n.capabilities?.SMS ?? false,
    },
  }));
}

// ─────────────────────────────────────────────────────────────
// ConversationRelay – TwiML generation
// Docs: https://www.twilio.com/docs/voice/twiml/connect/conversationrelay
// ─────────────────────────────────────────────────────────────

/**
 * Supported voices per provider
 * ElevenLabs uses model IDs, Google uses BCP-47 codes.
 * We define our own human-friendly names mapping to real IDs.
 */
const VOICE_MAP = {
  // ElevenLabs voices (high quality, preferred)
  Rachel: { provider: "ElevenLabs", voiceId: "21m00Tcm4TlvDq8ikWAM" }, // female, calm
  Domi: { provider: "ElevenLabs", voiceId: "AZnzlk1XvdvUeBnXmlld" }, // female, strong
  Bella: { provider: "ElevenLabs", voiceId: "EXAVITQu4vr4xnSDxMaL" }, // female, soft
  Josh: { provider: "ElevenLabs", voiceId: "TxGEqnHWrfWFTfGW9XjX" }, // male, deep
  Arnold: { provider: "ElevenLabs", voiceId: "VR6AewLTigWG4xSOukaG" }, // male, crisp
  // Google voices (fallback, free-tier friendly)
  "Wavenet-F": { provider: "Google", voiceId: "en-US-Wavenet-F" },
  "Wavenet-D": { provider: "Google", voiceId: "en-US-Wavenet-D" },
  "Polly-Joanna": { provider: "Amazon", voiceId: "Joanna" },
  "Polly-Matthew": { provider: "Amazon", voiceId: "Matthew" },
};

const LANGUAGE_MAP = {
  English: "en-US",
  Spanish: "es-ES",
  French: "fr-FR",
  German: "de-DE",
  Portuguese: "pt-BR",
  Italian: "it-IT",
};

/**
 * Generate TwiML to connect an inbound call to ConversationRelay.
 * Your WebSocket server at wsUrl receives text events and sends AI replies.
 */
function buildConversationRelayTwiml({ agentRow, wsUrl, greeting }) {
  const voice = VOICE_MAP[agentRow.voice] || VOICE_MAP["Rachel"];
  const langCode = LANGUAGE_MAP[agentRow.language] || "en-US";
  const welcomeGreeting =
    greeting ||
    agentRow.greeting ||
    "Hello, thank you for calling. How can I help you today?";

  // ElevenLabs requires a model attribute, others don't
  const voiceAttr =
    voice.provider === "ElevenLabs"
      ? `ttsProvider="ElevenLabs" voice="${voice.voiceId}"`
      : voice.provider === "Google"
        ? `ttsProvider="Google" voice="${voice.voiceId}"`
        : `ttsProvider="Amazon" voice="${voice.voiceId}"`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${wsUrl}"
      welcomeGreeting="${welcomeGreeting.replace(/"/g, "&quot;")}"
      language="${langCode}"
      transcriptionProvider="Deepgram"
      ${voiceAttr}
      interruptible="true"
      dtmfDetection="false"
    />
  </Connect>
</Response>`;
}

/**
 * Generate TwiML for an outbound call that immediately connects to ConversationRelay.
 */
function buildOutboundTwiml({ agentRow, wsUrl, greeting }) {
  return buildConversationRelayTwiml({ agentRow, wsUrl, greeting });
}

// ─────────────────────────────────────────────────────────────
// Call logs & billing from Twilio (scoped per phone number SID)
// ─────────────────────────────────────────────────────────────

/**
 * Fetch call logs from Twilio for a given phone number (E.164 format).
 * Returns lightweight call summaries.
 */
async function fetchCallLogs({ to, from, limit = 50, startTime }) {
  const params = { PageSize: String(Math.min(limit, 100)) };
  if (to) params.To = to;
  if (from) params.From = from;
  if (startTime) params.StartTime = startTime; // YYYY-MM-DD or ISO

  const data = await twilioRequest("GET", "/Calls.json", params);
  return (data?.calls || []).map((c) => ({
    sid: c.sid,
    to: c.to,
    from: c.from,
    status: c.status,
    direction: c.direction,
    duration: parseInt(c.duration || "0", 10),
    startTime: c.start_time,
    endTime: c.end_time,
    price: c.price,
    priceUnit: c.price_unit,
  }));
}

/**
 * Fetch recordings for a specific call SID.
 */
async function fetchCallRecordings(callSid) {
  const data = await twilioRequest("GET", `/Calls/${callSid}/Recordings.json`);
  return (data?.recordings || []).map((r) => ({
    sid: r.sid,
    duration: r.duration,
    url: `https://api.twilio.com${r.uri.replace(".json", ".mp3")}`,
    dateCreated: r.date_created,
  }));
}

/**
 * Fetch Twilio usage records for billing summary.
 * category: 'calls' | 'calls-inbound' | 'calls-outbound' | 'sms' etc.
 */
async function fetchUsageSummary({ startDate, endDate, category = "calls" }) {
  const params = {};
  if (startDate) params.StartDate = startDate;
  if (endDate) params.EndDate = endDate;
  if (category) params.Category = category;

  const data = await twilioRequest("GET", "/Usage/Records.json", params);
  return (data?.usage_records || []).map((r) => ({
    category: r.category,
    description: r.description,
    count: r.count,
    usage: r.usage,
    usageUnit: r.usage_unit,
    price: r.price,
    priceUnit: r.price_unit,
    startDate: r.start_date,
    endDate: r.end_date,
  }));
}

/**
 * Get last-month billing summary.
 */
async function fetchMonthlyBilling() {
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .split("T")[0];

  const [voiceUsage, smsUsage] = await Promise.allSettled([
    fetchUsageSummary({ startDate: firstOfMonth, category: "calls" }),
    fetchUsageSummary({ startDate: firstOfMonth, category: "sms" }),
  ]);

  const voice = voiceUsage.status === "fulfilled" ? voiceUsage.value[0] : null;
  const sms = smsUsage.status === "fulfilled" ? smsUsage.value[0] : null;

  return {
    periodStart: firstOfMonth,
    voice: {
      count: voice?.count || "0",
      minutes: voice?.usage || "0",
      cost: voice?.price || "0.00",
      currency: voice?.priceUnit || "USD",
    },
    sms: {
      count: sms?.count || "0",
      cost: sms?.price || "0.00",
      currency: sms?.priceUnit || "USD",
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Outbound call
// ─────────────────────────────────────────────────────────────

/**
 * Initiate an outbound call from a Twilio number.
 * Twilio will hit twimlUrl to get TwiML (your ConversationRelay XML).
 */
async function makeOutboundCall({ from, to, twimlUrl, statusCallbackUrl }) {
  const apiUrl = (process.env.API_URL || "").replace(/\/$/, "");
  const params = {
    From: from,
    To: to,
    Url: twimlUrl || `${apiUrl}/api/twilio/outbound-twiml`,
    Method: "POST",
    StatusCallback: statusCallbackUrl || `${apiUrl}/api/twilio/call-status`,
    StatusCallbackMethod: "POST",
    StatusCallbackEvent: "initiated ringing answered completed",
    Record: "true",
    RecordingStatusCallback: `${apiUrl}/api/twilio/recording-status`,
    RecordingStatusCallbackMethod: "POST",
  };

  const data = await twilioRequest("POST", "/Calls.json", params);
  return { callSid: data.sid, status: data.status };
}

// ─────────────────────────────────────────────────────────────
// WhatsApp (foundation – omnichannel via Twilio Messaging)
// ─────────────────────────────────────────────────────────────

/**
 * Send a WhatsApp message via Twilio.
 * from must be in format: whatsapp:+14155238886 (Twilio sandbox or approved number)
 */
async function sendWhatsAppMessage({ from, to, body, mediaUrl }) {
  const params = {
    From: from.startsWith("whatsapp:") ? from : `whatsapp:${from}`,
    To: to.startsWith("whatsapp:") ? to : `whatsapp:${to}`,
    Body: body,
  };
  if (mediaUrl) params.MediaUrl = mediaUrl;
  return twilioRequest("POST", "/Messages.json", params);
}

/**
 * List WhatsApp messages for a given number.
 */
async function fetchWhatsAppMessages({ to, from, limit = 50 }) {
  const params = { PageSize: String(limit) };
  if (to) params.To = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
  if (from)
    params.From = from.startsWith("whatsapp:") ? from : `whatsapp:${from}`;
  const data = await twilioRequest("GET", "/Messages.json", params);
  return data?.messages || [];
}

// ─────────────────────────────────────────────────────────────
// Helper – build system prompt for ConversationRelay WebSocket
// ─────────────────────────────────────────────────────────────

function buildSystemPrompt(agentRow, faqs = [], knowledgeChunks = []) {
  const faqsText = faqs.length
    ? faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n")
    : "";

  const knowledgeText = knowledgeChunks.length
    ? knowledgeChunks.map((c) => c.content).join("\n---\n")
    : "";

  const agentName = agentRow.name || "AI Assistant";
  const orgName =
    agentRow.organization_name || agentRow.org_name || "our business";
  const tone = agentRow.tone || "Professional";
  const isOutbound = (agentRow.direction || "inbound") === "outbound";

  // Call purposes (outbound only)
  const callPurposes =
    Array.isArray(agentRow.call_purposes) && agentRow.call_purposes.length > 0
      ? agentRow.call_purposes
      : [];
  const purposeBlock = callPurposes.length
    ? `PURPOSE OF THIS CALL:\n${callPurposes.map((p, i) => `${i + 1}. ${p}`).join("\n")}\nMake sure to address all points above.`
    : "";

  const toneMap = {
    professional:
      "Maintain a PROFESSIONAL tone: clear, courteous, business-appropriate.",
    friendly: "Maintain a FRIENDLY tone: warm, conversational, approachable.",
    empathetic: "Maintain an EMPATHETIC tone: patient and understanding.",
  };
  const toneInstruction =
    toneMap[(tone || "").toLowerCase()] || toneMap.professional;

  const inboundRules = [
    "INTRODUCTION: At the very start of the call, say exactly:",
    `"Hello, thank you for calling ${orgName}! This is ${agentName}. How can I help you today?"`,
    "Use the caller's name once you know it.",
    "",
    "BEHAVIOUR:",
    "- Keep responses to 1–3 sentences. Voice conversations MUST be concise.",
    "- Capture the caller's name, phone number, email, and reason for calling.",
    '- Repeat back any contact detail they give you before confirming: "Just to confirm, your name is [name] and your number is [number] — is that correct?"',
    '- If asked for a human: say you are transferring them and end with {"action":"transfer"}.',
    "- If outside business hours, offer to take a message.",
    `- Never claim to be human. You are ${agentName}, an AI assistant.`,
    agentRow.rules?.autoEscalate
      ? "- Auto-escalate complex or upset callers to a human."
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const outboundRules = [
    "INTRODUCTION: At the very start, say exactly:",
    `"Hello! This is ${agentName} from ${orgName}. Am I speaking with [Lead Name]?"`,
    "Wait for confirmation. If yes, proceed. If no, ask to speak with [Lead Name] or leave a brief message.",
    "",
    "BEHAVIOUR:",
    "- You are calling THEM — their contact details are already known. NEVER ask for name, phone, or email again.",
    '- Do NOT say "How can I help you today?" — you have a specific reason for this call.',
    "- Keep responses to 1–3 sentences.",
    "- Once identity is confirmed, explain the purpose of the call clearly.",
    "- If they want to call back, agree on a time and end politely.",
    `- Never claim to be human. You are ${agentName}, an AI from ${orgName}.`,
    purposeBlock ? `\n${purposeBlock}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    `You are ${agentName}, an AI voice assistant for ${orgName}.`,
    toneInstruction,
    `BUSINESS HOURS: ${agentRow.business_hours || "9am–5pm Monday–Friday"}`,
    "",
    isOutbound ? outboundRules : inboundRules,
    "",
    faqsText ? `FREQUENTLY ASKED QUESTIONS:\n${faqsText}` : "",
    knowledgeText ? `KNOWLEDGE BASE:\n${knowledgeText}` : "",
    "",
    "At the end of the conversation output this JSON on its own line:",
    '{"captured": {"name": "...", "phone": "...", "email": "...", "reason": "..."}}',
  ]
    .filter(Boolean)
    .join("\n\n");
}

module.exports = {
  // Phone number management
  listSupportedCountries,
  searchAvailableNumbers,
  purchasePhoneNumber,
  updateNumberWebhooks,
  releasePhoneNumber,
  listOwnedNumbers,
  // ConversationRelay
  buildConversationRelayTwiml,
  buildOutboundTwiml,
  buildSystemPrompt,
  VOICE_MAP,
  LANGUAGE_MAP,
  // Call data
  fetchCallLogs,
  fetchCallRecordings,
  fetchUsageSummary,
  fetchMonthlyBilling,
  makeOutboundCall,
  // WhatsApp (foundation)
  sendWhatsAppMessage,
  fetchWhatsAppMessages,
};
