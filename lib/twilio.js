"use strict";

const TWILIO_ACCOUNT_SID = () => process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = () => process.env.TWILIO_AUTH_TOKEN;

const TWILIO_BASE = "https://api.twilio.com/2010-04-01";

async function twilioRequest(method, path, params = null, isFullUrl = false) {
  const sid = TWILIO_ACCOUNT_SID();
  const token = TWILIO_AUTH_TOKEN();
  if (!sid || !token)
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN required");

  const url = isFullUrl ? path : `${TWILIO_BASE}/Accounts/${sid}${path}`;
  const headers = {
    Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
    "Content-Type": "application/x-www-form-urlencoded",
  };
  let body;
  if (params && (method === "POST" || method === "PUT"))
    body = new URLSearchParams(params).toString();
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
  if (!res.ok)
    throw new Error(
      data?.message || data?.error_message || `Twilio ${res.status}`,
    );
  return data;
}

// ── Phone number management ─────────────────────────────────────
async function listSupportedCountries() {
  const data = await twilioRequest(
    "GET",
    "/AvailablePhoneNumbers.json",
    null,
    true,
  );
  return (data?.countries || []).map((c) => ({
    country: c.country_code,
    countryName: c.country,
    hasLocal: !!c.subresource_uris?.local,
    hasTollFree: !!c.subresource_uris?.toll_free,
    hasMobile: !!c.subresource_uris?.mobile,
  }));
}

async function searchAvailableNumbers({
  country = "US",
  type = "Local",
  areaCode,
  contains,
  limit = 20,
}) {
  const url = `/AvailablePhoneNumbers/${country}/${type}.json`;
  const params = {
    PageSize: String(Math.min(limit, 40)),
    VoiceEnabled: "true",
  };
  if (areaCode) params.AreaCode = areaCode;
  if (contains) params.Contains = contains;
  const data = await twilioRequest("GET", url, params);
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

async function purchasePhoneNumber({ phoneNumber, friendlyName }) {
  const apiUrl = (process.env.API_URL || "").replace(/\/$/, "");
  const params = {
    PhoneNumber: phoneNumber,
    VoiceUrl: `${apiUrl}/api/twilio/voice-inbound`,
    VoiceMethod: "POST",
    StatusCallback: `${apiUrl}/api/twilio/call-status`,
    StatusCallbackMethod: "POST",
    SmsUrl: `${apiUrl}/api/twilio/sms-inbound`,
    SmsMethod: "POST",
  };
  if (friendlyName) params.FriendlyName = friendlyName;
  return twilioRequest("POST", "/IncomingPhoneNumbers.json", params);
}

async function updateNumberWebhooks({ phoneSid }) {
  const apiUrl = (process.env.API_URL || "").replace(/\/$/, "");
  return twilioRequest("POST", `/IncomingPhoneNumbers/${phoneSid}.json`, {
    VoiceUrl: `${apiUrl}/api/twilio/voice-inbound`,
    VoiceMethod: "POST",
    StatusCallback: `${apiUrl}/api/twilio/call-status`,
    StatusCallbackMethod: "POST",
  });
}

async function releasePhoneNumber(phoneSid) {
  return twilioRequest("DELETE", `/IncomingPhoneNumbers/${phoneSid}.json`);
}

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

// ── ConversationRelay TwiML ─────────────────────────────────────
const VOICE_MAP = {
  Domi: { provider: "ElevenLabs", voiceId: "AZnzlk1XvdvUeBnXmlld" },
  Bella: { provider: "ElevenLabs", voiceId: "EXAVITQu4vr4xnSDxMaL" },
  Josh: { provider: "ElevenLabs", voiceId: "TxGEqnHWrfWFTfGW9XjX" },
  Arnold: { provider: "ElevenLabs", voiceId: "VR6AewLTigWG4xSOukaG" },
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

function buildConversationRelayTwiml({ agentRow, wsUrl, greeting }) {
  const voice =
    VOICE_MAP[agentRow.voice] ||
    VOICE_MAP[process.env.DEFAULT_CONVERSATION_RELAY_VOICE] ||
    Object.values(VOICE_MAP)[0];
  const langCode = LANGUAGE_MAP[agentRow.language] || "en-US";
  const welcome = (
    greeting ||
    agentRow.greeting ||
    "Hello, thank you for calling. How can I help you today?"
  ).replace(/"/g, "&quot;");
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
      welcomeGreeting="${welcome}"
      language="${langCode}"
      transcriptionProvider="Deepgram"
      ${voiceAttr}
      interruptible="true"
      dtmfDetection="false"
    />
  </Connect>
</Response>`;
}

function buildOutboundTwiml({ agentRow, wsUrl }) {
  return buildConversationRelayTwiml({ agentRow, wsUrl });
}

// ── Call logs & billing ─────────────────────────────────────────
async function fetchCallLogs({ to, from, limit = 50, startTime }) {
  const params = { PageSize: String(Math.min(limit, 100)) };
  if (to) params.To = to;
  if (from) params.From = from;
  if (startTime) params.StartTime = startTime;
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

async function makeOutboundCall({ from, to, twimlUrl, statusCallbackUrl }) {
  const apiUrl = (process.env.API_URL || "").replace(/\/$/, "");
  const data = await twilioRequest("POST", "/Calls.json", {
    From: from,
    To: to,
    Url: twimlUrl || `${apiUrl}/api/twilio/outbound-twiml`,
    Method: "POST",
    StatusCallback: statusCallbackUrl || `${apiUrl}/api/twilio/call-status`,
    StatusCallbackMethod: "POST",
    StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    Record: "true",
    RecordingStatusCallback: `${apiUrl}/api/twilio/recording-status`,
    RecordingStatusCallbackMethod: "POST",
  });
  return { callSid: data.sid, status: data.status };
}

// ── System prompt builder for WebSocket handler ─────────────────
function buildSystemPrompt(agentRow, faqs = [], knowledgeChunks = []) {
  const faqText = (faqs || []).length
    ? faqs.map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`).join("\n\n")
    : "";
  const knowledgeText = (knowledgeChunks || []).length
    ? knowledgeChunks
        .map(
          (chunk, index) => `[Relevant ${index + 1}] ${chunk.content || chunk}`,
        )
        .join("\n\n---\n\n")
    : "";
  const captureFields = Array.isArray(agentRow?.data_capture_fields)
    ? agentRow.data_capture_fields.join(", ")
    : "name, phone, email, reason";
  const callPurposes = Array.isArray(agentRow?.call_purposes)
    ? agentRow.call_purposes
        .map((item) => `- ${String(item || "").trim()}`)
        .filter((item) => item !== "- ")
    : [];

  const isOutbound = String(agentRow?.direction || "").toLowerCase() === "outbound";
  const lines = [
    `You are ${agentRow?.name || "the AI assistant"}, an AI ${agentRow?.tone || "Professional"} ${isOutbound ? "outbound representative" : "inbound receptionist"} for this business.`,
    isOutbound
      ? "This is an outbound call. We called them: introduce yourself, state the reason in natural grammar, ask if they have a quick moment, then listen. Never open with 'How can I help you today?' or ask who they are."
      : "This is an inbound call. They called the business: greet warmly, ask how you can help, answer naturally, briefly, and accurately.",
    isOutbound
      ? "Treat call purposes as internal notes. Rewrite malformed purpose text into a clean recipient-facing sentence; never read awkward phrases like 'for the purpose of', 'because to', 'to for the purpose of', or duplicate 'about about'."
      : "Do not use outbound language like 'I'm calling because...' on inbound calls.",
    `Business hours: ${agentRow?.business_hours || "9am-5pm Monday-Friday"}.`,
    `Capture the caller's ${captureFields} when appropriate.`,
    "Use only the information that is relevant to the current request. Do not recite unrelated FAQs or unrelated website content.",
    "If you cannot answer accurately, say so plainly, offer to take a message, and avoid inventing details.",
    'If the caller asks for a human or transfer and escalation is configured, say you are transferring them and end with {"action":"transfer"}.',
  ];

  if (callPurposes.length && agentRow?.direction === "outbound") {
    lines.push(`CALL PURPOSES:\n${callPurposes.join("\n")}`);
  }
  if (faqText) lines.push(`FAQS:\n${faqText}`);
  if (knowledgeText) lines.push(`RELEVANT KNOWLEDGE:\n${knowledgeText}`);
  lines.push("Keep each spoken reply short and phone-friendly.");
  lines.push(
    'When the conversation is ending, add a final JSON line exactly like {\"captured\": {\"name\": \"...\", \"phone\": \"...\", \"email\": \"...\", \"reason\": \"...\"}}.',
  );
  return lines.join("\n\n");
}

module.exports = {
  listSupportedCountries,
  searchAvailableNumbers,
  purchasePhoneNumber,
  updateNumberWebhooks,
  releasePhoneNumber,
  listOwnedNumbers,
  buildConversationRelayTwiml,
  buildOutboundTwiml,
  buildSystemPrompt,
  VOICE_MAP,
  LANGUAGE_MAP,
  fetchCallLogs,
  fetchMonthlyBilling,
  makeOutboundCall,
};
