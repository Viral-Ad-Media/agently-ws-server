"use strict";

/**
 * Twilio Media Streams <Connect><Stream> handler.
 *
 * Twilio sends and receives G.711 u-law audio at 8000 Hz. This handler bridges
 * that audio directly to OpenAI Realtime and sends OpenAI audio deltas back to
 * Twilio using the exact Twilio media frame shape.
 *
 * This endpoint intentionally does not require the browser/widget JWT flow:
 * Twilio connects directly over WebSocket and sends call metadata in the query
 * string and/or in the `start.customParameters` payload.
 */

const https = require("https");
const WebSocket = require("ws");
const { getSupabase } = require("./supabase");
const { loadVoiceContext } = require("./context-builder");

const OPENAI_REALTIME_URL =
  process.env.OPENAI_REALTIME_URL ||
  `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
  )}`;

const DEFAULT_VOICE = process.env.OPENAI_REALTIME_VOICE || "alloy";
const DEFAULT_GREETING =
  process.env.TWILIO_MEDIA_INITIAL_GREETING ||
  "Hello, this is Mimi. How can I help you today?";

const CLOSING_MESSAGE =
  process.env.TWILIO_MEDIA_CLOSING_MESSAGE ||
  "Thank you for calling Nutra Wellness. Have a wonderful day.";
const IDLE_TIMEOUT_MS = Math.max(
  15000,
  Number(process.env.INBOUND_CALL_IDLE_TIMEOUT_MS || 60000),
);
const FINAL_AUDIO_HANGUP_DELAY_MS = Math.max(
  500,
  Number(process.env.TWILIO_FINAL_AUDIO_HANGUP_DELAY_MS || 1800),
);
const MAX_INBOUND_CALL_SECONDS = Math.max(
  30,
  Number(process.env.MAX_INBOUND_CALL_SECONDS || 900),
);

const activeTwilioSessions = new Set();

const OPENAI_VOICE_ALLOWLIST = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "fable",
  "onyx",
  "nova",
]);

const DASHBOARD_VOICE_MAP = {
  rachel: "shimmer",
  "rachel female": "shimmer",
  zephyr: "shimmer",
  puck: "echo",
  charon: "onyx",
  kore: "nova",
  fenrir: "onyx",
};

function safeSend(ws, payload) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
      return true;
    }
  } catch (err) {
    console.warn("[twilio-media-stream] safeSend warning:", err.message);
  }
  return false;
}

function safeJson(value) {
  try {
    return JSON.stringify(value || {});
  } catch (_) {
    return "{}";
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function normalizeVoiceName(value) {
  return String(value || "")
    .trim()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9_ -]/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function mapVoiceProfileToOpenAi(voiceProfile) {
  const configuredDefault = normalizeVoiceName(
    process.env.OPENAI_REALTIME_VOICE || DEFAULT_VOICE,
  );
  const fallback = OPENAI_VOICE_ALLOWLIST.has(configuredDefault)
    ? configuredDefault
    : "alloy";
  const normalized = normalizeVoiceName(voiceProfile);
  if (!normalized) return fallback;
  if (OPENAI_VOICE_ALLOWLIST.has(normalized)) return normalized;
  if (DASHBOARD_VOICE_MAP[normalized]) return DASHBOARD_VOICE_MAP[normalized];
  const firstWord = normalized.split(" ")[0];
  if (DASHBOARD_VOICE_MAP[firstWord]) return DASHBOARD_VOICE_MAP[firstWord];
  if (OPENAI_VOICE_ALLOWLIST.has(firstWord)) return firstWord;
  return fallback;
}

function sessionKeyFor(context, streamSid) {
  return `${context.callSid || "no-call"}:${streamSid || "no-stream"}`;
}

function queryContext(req) {
  const parsed = new URL(req.url || "", "http://localhost");
  const params = parsed.searchParams;
  return {
    path: parsed.pathname,
    query: Object.fromEntries(params.entries()),
    orgId: firstNonEmpty(params.get("orgId"), params.get("organizationId")),
    agentId: firstNonEmpty(params.get("agentId"), params.get("voiceAgentId")),
    callRecordId: firstNonEmpty(params.get("callRecordId")),
    callSid: firstNonEmpty(params.get("callSid")),
    direction: firstNonEmpty(params.get("direction"), "inbound"),
    callerPhone: firstNonEmpty(params.get("callerPhone"), params.get("from")),
  };
}

function mergeStartParameters(context, start) {
  const custom = start?.customParameters || {};
  return {
    ...context,
    orgId: firstNonEmpty(custom.orgId, custom.organizationId, context.orgId),
    agentId: firstNonEmpty(
      custom.agentId,
      custom.voiceAgentId,
      context.agentId,
    ),
    callRecordId: firstNonEmpty(custom.callRecordId, context.callRecordId),
    callSid: firstNonEmpty(start?.callSid, custom.callSid, context.callSid),
    direction: firstNonEmpty(custom.direction, context.direction, "inbound"),
    callerPhone: firstNonEmpty(
      custom.callerPhone,
      custom.from,
      start?.from,
      context.callerPhone,
    ),
  };
}

function logLifecycle(label, details = {}) {
  console.log(`[twilio-media-stream] ${label}`, details);
}

function getOpenAiErrorMessage(event) {
  const err = event?.error || event;
  return String(err?.message || err?.code || safeJson(err));
}

function normalizeSpeechText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9+\s.'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasEndIntent(text, options = {}) {
  const t = normalizeSpeechText(text);
  if (!t) return false;

  // Strict caller-driven close detection. Do not end on "thank you" alone.
  // The previous barge-in fix became too conservative because it could cancel
  // a valid goodbye hangup on any speech-start/noise event. This detector only
  // fires for explicit goodbye/hangup language or clear "that's all" answers
  // when the assistant has just asked if anything else is needed.
  const explicitClosePatterns = [
    /\b(bye|goodbye|good bye|talk to you later)\b/,
    /\b(end|finish|close|disconnect)\s+(the\s+)?call\b/,
    /\b(hang\s*up|you can hang\s*up|please hang\s*up)\b/,
    /\b(thank you|thanks)\b.*\b(bye|goodbye|good bye)\b/,
    /\b(bye|goodbye|good bye)\b.*\b(thank you|thanks)\b/,
    /\b(that'?s all|that is all|nothing else|no more questions)\b.*\b(thank you|thanks|bye|goodbye|good bye)\b/,
    /\b(no,?\s*)?(that'?s all|that is all|nothing else|no more questions)\b.*\b(end|hang\s*up|bye|goodbye|good bye)\b/,
  ];

  if (explicitClosePatterns.some((pattern) => pattern.test(t))) return true;

  if (options.afterAnythingElsePrompt) {
    return /\b(no,?\s*)?(that'?s all|that is all|nothing else|no more questions)\b/.test(
      t,
    );
  }

  return false;
}

function assistantAskedAnythingElse(text) {
  const t = normalizeSpeechText(text);
  return /\b(anything else|anything more|is there anything else|do you need anything else|can i help with anything else)\b/.test(
    t,
  );
}

function hasHangupCancelIntent(text) {
  const t = normalizeSpeechText(text);
  if (!t) return false;
  return /\b(wait|hold on|one more thing|i'?m not done|i am not done|not done|actually|before you go|don'?t hang up|do not hang up|i still|i have another|another question)\b/.test(
    t,
  );
}

function looksLikeMessageCapture(text) {
  const t = normalizeSpeechText(text);
  if (!t) return false;
  return /\b(leave (a )?message|take (a )?message|call me back|callback|call back|my name is|this is [a-z]|my phone|my number|please tell|let them know|message is|i need|i want to|can someone|have someone)\b/.test(
    t,
  );
}

function extractCallerNameFromTranscript(text) {
  const value = String(text || "");
  const patterns = [
    /\bmy name is\s+([A-Za-z][A-Za-z .'-]{1,60})/i,
    /\bthis is\s+([A-Za-z][A-Za-z .'-]{1,60})/i,
    /\bi am\s+([A-Za-z][A-Za-z .'-]{1,60})/i,
    /\bi'm\s+([A-Za-z][A-Za-z .'-]{1,60})/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1])
      return match[1]
        .replace(
          /\b(and|calling|from|my|phone|number|message|callback)\b.*$/i,
          "",
        )
        .trim()
        .slice(0, 80);
  }
  return "";
}

function extractCallbackTimeFromTranscript(text) {
  const value = String(text || "");
  const patterns = [
    /\b(call me back|callback|call back|reach me)\s+(at|around|by|after|before)?\s*([^.;!?\n]{2,80})/i,
    /\b(preferred callback time|best time to call)\s*(is|:)?\s*([^.;!?\n]{2,80})/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const raw = match?.[3] || match?.[2] || "";
    if (raw) return raw.trim().slice(0, 120);
  }
  return "";
}

function extractPhoneFromTranscript(text, fallback = "") {
  const direct = String(text || "")
    .replace(/\s+/g, " ")
    .match(/\+?\d[\d\s().-]{6,}\d/);
  if (direct?.[0]) return direct[0].replace(/[^+\d]/g, "").slice(0, 32);
  return String(fallback || "").trim();
}

function summarizeTranscript(lines, max = 900) {
  const text = (lines || [])
    .map(
      (line) => String(line.role || "unknown") + ": " + String(line.text || ""),
    )
    .join("\n")
    .trim();
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

function buildTranscriptArray(lines) {
  return (lines || [])
    .filter((line) => line && line.text)
    .map((line) => ({
      role: line.role || "unknown",
      text: String(line.text || "").trim(),
      ts: line.ts || new Date().toISOString(),
    }));
}

function mergeMetadata(existing, patch) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? existing
      : {};
  return { ...base, ...(patch || {}) };
}

function buildLeadReason(message, callbackTime) {
  const parts = [];
  if (message) parts.push(String(message).trim());
  if (callbackTime)
    parts.push("Callback preference/time: " + String(callbackTime).trim());
  return parts.join("\n").slice(0, 1800);
}

function parseJsonMaybe(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch (_) {
    return {};
  }
}

function parseToolArguments(args) {
  const parsed = parseJsonMaybe(args);
  return {
    caller_name: firstNonEmpty(
      parsed.caller_name,
      parsed.callerName,
      parsed.name,
    ),
    caller_phone: firstNonEmpty(
      parsed.caller_phone,
      parsed.callerPhone,
      parsed.phone,
    ),
    message: firstNonEmpty(parsed.message, parsed.question, parsed.reason),
    callback_time: firstNonEmpty(
      parsed.callback_time,
      parsed.callbackTime,
      parsed.requested_callback_time,
    ),
    email: firstNonEmpty(parsed.email),
  };
}

function captureToolDefinition() {
  return {
    type: "function",
    name: "capture_inbound_message",
    description:
      "Save a caller's inbound voice message after collecting their name, phone number, message/question, and callback preference/time.",
    parameters: {
      type: "object",
      properties: {
        caller_name: {
          type: "string",
          description: "Caller name, if provided.",
        },
        caller_phone: {
          type: "string",
          description: "Caller phone number, if provided.",
        },
        message: {
          type: "string",
          description:
            "The caller's message, question, or reason for callback.",
        },
        callback_time: {
          type: "string",
          description: "Preferred callback time or callback preference.",
        },
        email: {
          type: "string",
          description: "Caller email address, if provided.",
        },
      },
      required: ["caller_name", "caller_phone", "message", "callback_time"],
      additionalProperties: false,
    },
  };
}

function likelyUnansweredQuestion(text, assistantText) {
  const a = normalizeSpeechText(assistantText);
  const q = String(text || "").trim();
  if (!q || q.length < 8) return false;
  return (
    /\?/.test(q) ||
    /\b(what|how|when|where|why|do you|can you|is there|are there|price|cost|sell|offer)\b/i.test(
      q,
    ) ||
    /\b(do not have|don't have|not have enough information|cannot answer|not in.*knowledge|team.*follow up|take a message)\b/.test(
      a,
    )
  );
}

async function endTwilioCall(callSid) {
  if (!callSid) throw new Error("Missing callSid");
  const accountSid = (process.env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = (process.env.TWILIO_AUTH_TOKEN || "").trim();
  if (!accountSid || !authToken)
    throw new Error(
      "TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is not configured on Railway",
    );
  const form = "Status=completed";
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
            new Error(
              `Twilio REST HTTP ${res.statusCode}: ${data.slice(0, 500)}`,
            ),
          );
        });
      },
    );
    req.on("error", reject);
    req.write(form);
    req.end();
  });
}

async function safeDbWrite(label, fn) {
  try {
    const result = await fn();
    if (result?.error) {
      console.warn(
        `[message-capture] ${label} failed`,
        result.error.message || result.error,
      );
      return { data: null, error: result.error };
    }
    return { data: result?.data || null, error: null };
  } catch (err) {
    console.warn(`[message-capture] ${label} failed`, err.message || err);
    return { data: null, error: err };
  }
}

async function findExistingCallRecord(db, { callRecordId, twilioCallSid }) {
  if (callRecordId) {
    const byId = await safeDbRead("call_records existing by id", () =>
      db.from("call_records").select("*").eq("id", callRecordId).maybeSingle(),
    );
    if (byId.data) return byId.data;
  }
  if (twilioCallSid) {
    const bySid = await safeDbRead(
      "call_records existing by twilio_call_sid",
      () =>
        db
          .from("call_records")
          .select("*")
          .eq("twilio_call_sid", twilioCallSid)
          .maybeSingle(),
    );
    if (bySid.data) return bySid.data;
  }
  return null;
}

function uniq(values) {
  return [...new Set((values || []).filter(Boolean))];
}

async function findLeadsForCall(db, callSid, callRecordId) {
  const needles = uniq([firstNonEmpty(callSid), firstNonEmpty(callRecordId)]);
  const all = [];
  for (const needle of needles) {
    const result = await safeDbRead(
      "leads existing assignment_context",
      () =>
        db
          .from("leads")
          .select("*")
          .ilike("assignment_context", "%" + needle + "%")
          .limit(25),
      [],
    );
    if (Array.isArray(result.data)) all.push(...result.data);
  }
  return uniqueRowsById(all);
}

async function findExistingLeadForCall(db, callSid, callRecordId) {
  const leads = await findLeadsForCall(db, callSid, callRecordId);
  return leads.length ? chooseCanonicalLead(leads, null) : null;
}

function uniqueRowsById(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const id = row?.id || JSON.stringify(row);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

function leadCompletenessScore(lead) {
  let score = 0;
  const name = String(lead?.name || "").trim();
  const phone = String(lead?.phone || "").trim();
  const reason = String(lead?.reason || "").trim();
  const email = String(lead?.email || "").trim();
  if (name && !/^unknown/i.test(name)) score += 5;
  if (
    phone &&
    phone !== "the number I'm calling with" &&
    phone !== "the number i am calling with"
  )
    score += phone.startsWith("+") ? 5 : 2;
  if (reason.length > 20) score += 5;
  if (email) score += 2;
  if (String(lead?.status || "") !== "duplicate") score += 1;
  return score;
}

function chooseCanonicalLead(leads, metadataLeadId = null) {
  const list = uniqueRowsById(leads || []);
  if (!list.length) return null;
  if (metadataLeadId) {
    const matched = list.find((lead) => lead?.id === metadataLeadId);
    if (matched) return matched;
  }
  return list.slice().sort((a, b) => {
    const scoreDiff = leadCompletenessScore(b) - leadCompletenessScore(a);
    if (scoreDiff) return scoreDiff;
    return (
      new Date(b?.created_at || 0).getTime() -
      new Date(a?.created_at || 0).getTime()
    );
  })[0];
}

async function findLeadById(db, leadId) {
  if (!leadId) return null;
  const result = await safeDbRead("lead by metadata lead_id", () =>
    db.from("leads").select("*").eq("id", leadId).maybeSingle(),
  );
  return result.data || null;
}

function normalizeCapturedPhone(value, fallback = "") {
  const raw = String(value || "").trim();
  const fb = String(fallback || "").trim();
  if (!raw) return fb;
  const lowered = raw.toLowerCase();
  if (
    /(number i'?m calling|number i am calling|same number|this number|caller id|calling from)/i.test(
      lowered,
    )
  )
    return fb || raw;
  const digits = raw.replace(/[^0-9+]/g, "");
  if (!digits || digits.replace(/[^0-9]/g, "").length < 7) return fb || raw;
  return digits.startsWith("+") ? digits : raw;
}

function buildLeadPayload({
  organizationId,
  voiceAgentId,
  callerName,
  callerPhone,
  email,
  messageText,
  callbackTime,
  status,
  source,
  twilioCallSid,
  callRecordId,
  existingCallRecord,
}) {
  return {
    organization_id: organizationId,
    name: callerName || "Unknown Caller",
    phone: callerPhone || null,
    email: email || "",
    reason: buildLeadReason(messageText, callbackTime),
    status: status || "new",
    source,
    tags: ["voice_agent", "inbound_call"],
    voice_agent_id: voiceAgentId,
    assignment_context:
      "Captured from inbound call " +
      (twilioCallSid || existingCallRecord?.id || callRecordId || "unknown"),
  };
}

async function updateExistingLeadForCall(db, lead, payload) {
  if (!lead?.id) return { data: null, error: new Error("Missing lead id") };
  const existingTags = Array.isArray(lead.tags) ? lead.tags : [];
  const mergedTags = [...new Set([...existingTags, ...(payload.tags || [])])];
  const update = {
    name: payload.name || lead.name || "Unknown Caller",
    phone:
      normalizeCapturedPhone(payload.phone, lead.phone || "") ||
      lead.phone ||
      null,
    email: payload.email || lead.email || "",
    reason:
      payload.reason &&
      String(payload.reason).length >= String(lead.reason || "").length
        ? payload.reason
        : lead.reason || payload.reason || "",
    status:
      lead.status === "duplicate"
        ? "new"
        : lead.status || payload.status || "new",
    source: lead.source || payload.source || "inbound_call",
    tags: mergedTags,
    voice_agent_id: lead.voice_agent_id || payload.voice_agent_id || null,
    assignment_context: lead.assignment_context || payload.assignment_context,
  };
  console.log("[message-capture] updating existing lead id=" + lead.id);
  return safeDbWrite("leads update existing", () =>
    db.from("leads").update(update).eq("id", lead.id).select("*").maybeSingle(),
  );
}

async function updateCallRecordWithMessage(
  db,
  {
    existingCallRecord,
    callRecordId,
    twilioCallSid,
    transcriptArray,
    summary,
    callerName,
    callerPhone,
    metadataPatch,
  },
) {
  const metadata = mergeMetadata(existingCallRecord?.metadata, metadataPatch);
  const update = {
    transcript: transcriptArray,
    summary: String(summary || "").slice(0, 1800),
    status: "completed",
    metadata,
  };
  if (callerName) update.caller_name = callerName;
  if (callerPhone) update.caller_phone = callerPhone;
  console.log("[message-capture] updating call record metadata", {
    callRecordId,
    twilioCallSid,
    status: metadata.message_capture_status || "",
  });
  if (existingCallRecord?.id || callRecordId) {
    return safeDbWrite("call_records update by id", () =>
      db
        .from("call_records")
        .update(update)
        .eq("id", existingCallRecord?.id || callRecordId)
        .select("id, metadata")
        .maybeSingle(),
    );
  }
  if (twilioCallSid) {
    return safeDbWrite("call_records update by twilio_call_sid", () =>
      db
        .from("call_records")
        .update(update)
        .eq("twilio_call_sid", twilioCallSid)
        .select("id, metadata")
        .maybeSingle(),
    );
  }
  return { data: null, error: new Error("No call record identifier") };
}

async function saveTranscriptOnly({ context, transcriptLines, summary = "" }) {
  const db = getSupabase();
  const callRecordId = context.callRecordId || null;
  const twilioCallSid = context.callSid || null;
  if (!callRecordId && !twilioCallSid)
    return { saved: false, reason: "missing call record id/callSid" };
  const existingCallRecord = await findExistingCallRecord(db, {
    callRecordId,
    twilioCallSid,
  });
  const transcriptArray = buildTranscriptArray(transcriptLines);
  const metadata = mergeMetadata(existingCallRecord?.metadata, {
    call_end_details: {
      ended_at: new Date().toISOString(),
      transcript_length: transcriptArray.length,
      twilio_call_sid: twilioCallSid || null,
    },
  });
  const update = {
    transcript: transcriptArray,
    summary: String(
      summary ||
        existingCallRecord?.summary ||
        summarizeTranscript(transcriptLines, 900),
    ).slice(0, 1800),
    status: "completed",
    metadata,
  };
  const result =
    existingCallRecord?.id || callRecordId
      ? await safeDbWrite("call_records transcript update by id", () =>
          db
            .from("call_records")
            .update(update)
            .eq("id", existingCallRecord?.id || callRecordId)
            .select("id")
            .maybeSingle(),
        )
      : await safeDbWrite("call_records transcript update by sid", () =>
          db
            .from("call_records")
            .update(update)
            .eq("twilio_call_sid", twilioCallSid)
            .select("id")
            .maybeSingle(),
        );
  if (result?.data?.id)
    console.log("[call-record] transcript saved", {
      id: result.data.id,
      transcriptLength: transcriptArray.length,
    });
  return { saved: Boolean(result?.data?.id), id: result?.data?.id || null };
}

async function insertUnansweredQuestion({
  context,
  callRecordId,
  question,
  botResponse,
}) {
  const db = getSupabase();
  const organizationId = context.orgId || context.organizationId || null;
  const voiceAgentId = context.agentId || null;
  if (!organizationId || !question) return null;
  const result = await safeDbWrite("unanswered_questions insert", () =>
    db
      .from("unanswered_questions")
      .insert({
        organization_id: organizationId,
        voice_agent_id: voiceAgentId,
        call_record_id: callRecordId || null,
        question: String(question).slice(0, 2000),
        bot_response: String(botResponse || "").slice(0, 2000),
        source: "inbound_call",
        is_resolved: false,
      })
      .select("id")
      .maybeSingle(),
  );
  if (result?.data?.id)
    console.log("[unanswered-question] saved id=" + result.data.id);
  return result?.data || null;
}

async function persistInboundCallMessage({
  context,
  transcriptLines,
  userTranscripts,
  assistantTranscripts,
  captureState,
  toolArgs = null,
  status = "new",
  mode = "tool",
}) {
  const db = getSupabase();
  const transcriptArray = buildTranscriptArray(transcriptLines);
  const transcriptSummary = summarizeTranscript(transcriptLines, 12000);
  const userText = (userTranscripts || []).join("\n").trim();
  const assistantText = (assistantTranscripts || []).join(" ").trim();
  const args = toolArgs ? parseToolArguments(toolArgs) : {};
  const messageText = firstNonEmpty(
    args.message,
    captureState.message,
    userText,
    transcriptSummary,
  );
  const callerName = firstNonEmpty(
    args.caller_name,
    captureState.callerName,
    extractCallerNameFromTranscript(userText),
    "Unknown Caller",
  );
  const callerPhone = normalizeCapturedPhone(
    firstNonEmpty(
      args.caller_phone,
      captureState.callerPhone,
      extractPhoneFromTranscript(userText, context.callerPhone),
      context.callerPhone,
    ),
    context.callerPhone,
  );
  const callbackTime = firstNonEmpty(
    args.callback_time,
    captureState.callbackTime,
    extractCallbackTimeFromTranscript(userText),
  );
  const email = firstNonEmpty(args.email, captureState.email);
  const organizationId = context.orgId || context.organizationId || null;
  const voiceAgentId = context.agentId || null;
  const callRecordId = context.callRecordId || null;
  const twilioCallSid = context.callSid || null;
  const source = "inbound_call";

  if (!organizationId || !messageText)
    return { saved: false, reason: "missing organization or message" };

  console.log("[message-capture] parsed args", {
    callerName,
    callerPhone,
    callbackTime,
    email: email ? "provided" : "",
  });

  const existingCallRecord = await findExistingCallRecord(db, {
    callRecordId,
    twilioCallSid,
  });
  const existingMetadata = existingCallRecord?.metadata || {};
  const metadataLeadId =
    existingMetadata?.inbound_call_message?.lead_id ||
    captureState.savedLeadId ||
    null;
  const leadPayload = buildLeadPayload({
    organizationId,
    voiceAgentId,
    callerName,
    callerPhone,
    email,
    messageText,
    callbackTime,
    status,
    source,
    twilioCallSid,
    callRecordId,
    existingCallRecord,
  });

  let canonicalLead = null;
  if (captureState.messageCaptureSaved && captureState.savedLeadId) {
    canonicalLead = await findLeadById(db, captureState.savedLeadId);
    if (canonicalLead?.id)
      console.log("[message-capture] existing lead found", {
        leadId: canonicalLead.id,
        source: "memory",
      });
  }
  if (!canonicalLead && metadataLeadId) {
    canonicalLead = await findLeadById(db, metadataLeadId);
    if (canonicalLead?.id)
      console.log("[message-capture] existing lead found", {
        leadId: canonicalLead.id,
        source: "call_record_metadata",
      });
  }
  const leadsForCall = await findLeadsForCall(
    db,
    twilioCallSid,
    existingCallRecord?.id || callRecordId,
  );
  if (!canonicalLead && leadsForCall.length) {
    canonicalLead = chooseCanonicalLead(leadsForCall, metadataLeadId);
    if (canonicalLead?.id)
      console.log("[message-capture] existing lead found", {
        leadId: canonicalLead.id,
        source: "assignment_context",
      });
  }

  let savedLead = null;
  if (canonicalLead?.id) {
    if (
      mode === "fallback" &&
      (captureState.messageCaptureSaved || metadataLeadId)
    ) {
      console.log(
        "[message-capture] fallback skipped existing lead id=" +
          canonicalLead.id,
      );
    } else {
      console.log("[message-capture] duplicate prevented", {
        callSid: twilioCallSid,
        leadId: canonicalLead.id,
        mode,
      });
    }
    const updated = await updateExistingLeadForCall(
      db,
      canonicalLead,
      leadPayload,
    );
    savedLead = updated?.data || canonicalLead;
  } else {
    console.log("[message-capture] inserting lead", {
      organizationId,
      voiceAgentId,
      callRecordId,
      twilioCallSid,
    });
    const leadInsert = await safeDbWrite("leads insert", () =>
      db.from("leads").insert(leadPayload).select("*").maybeSingle(),
    );
    if (!leadInsert?.data?.id) {
      const failedPatch = {
        message_capture_status: "failed",
        message_capture_error:
          leadInsert?.error?.message ||
          String(leadInsert?.error || "lead insert failed"),
      };
      await updateCallRecordWithMessage(db, {
        existingCallRecord,
        callRecordId,
        twilioCallSid,
        transcriptArray,
        summary: messageText,
        callerName,
        callerPhone,
        metadataPatch: failedPatch,
      });
      console.warn("[message-capture] save failed", failedPatch);
      return {
        saved: false,
        error: failedPatch.message_capture_error,
        message: messageText,
      };
    }
    savedLead = leadInsert.data;
    console.log("[message-capture] saved lead id=" + savedLead.id);
  }

  captureState.messageCaptureSaved = true;
  captureState.savedLeadId = savedLead.id;
  captureState.saved = true;
  console.log("[message-capture] canonical lead id=" + savedLead.id);

  const savedAt = new Date().toISOString();
  const inboundMessage = {
    lead_id: savedLead.id,
    caller_name: callerName || savedLead.name || "Unknown Caller",
    caller_phone: callerPhone || savedLead.phone || context.callerPhone || "",
    message: messageText,
    callback_time: callbackTime || "",
    email: email || savedLead.email || "",
    saved_at: savedAt,
    source,
    mode,
  };

  await updateCallRecordWithMessage(db, {
    existingCallRecord,
    callRecordId,
    twilioCallSid,
    transcriptArray,
    summary: messageText,
    callerName,
    callerPhone,
    metadataPatch: {
      inbound_call_message: inboundMessage,
      message_capture_status: mode === "fallback" ? "fallback_saved" : "saved",
    },
  });

  if (likelyUnansweredQuestion(messageText, assistantText)) {
    await insertUnansweredQuestion({
      context,
      callRecordId: existingCallRecord?.id || callRecordId,
      question: messageText,
      botResponse: assistantText,
    });
  }

  return {
    saved: true,
    duplicatePrevented: Boolean(canonicalLead?.id),
    lead: savedLead,
    callerName,
    callerPhone,
    callbackTime,
    email,
    message: messageText,
  };
}

async function loadCallMessageDebug(callSid) {
  const db = getSupabase();
  const sid = String(callSid || "").trim();
  if (!sid) return { ok: false, error: "callSid is required" };
  const callRecord = await safeDbRead(
    "debug call_records by twilio_call_sid",
    () =>
      db
        .from("call_records")
        .select("*")
        .eq("twilio_call_sid", sid)
        .maybeSingle(),
  );
  const callRecordId = callRecord.data?.id || null;
  const metadata = callRecord.data?.metadata || {};
  const inbound = metadata?.inbound_call_message || null;
  const leads = await findLeadsForCall(db, sid, callRecordId);
  const metadataLead = inbound?.lead_id
    ? await findLeadById(db, inbound.lead_id)
    : null;
  const canonicalLead =
    metadataLead || chooseCanonicalLead(leads, inbound?.lead_id || null);
  let unanswered = { data: [], error: null };
  if (callRecordId)
    unanswered = await safeDbRead(
      "debug unanswered_questions by call_record_id",
      () =>
        db
          .from("unanswered_questions")
          .select("*")
          .eq("call_record_id", callRecordId)
          .limit(25),
      [],
    );

  const transcript = callRecord.data?.transcript;
  const transcriptLength = Array.isArray(transcript)
    ? transcript.length
    : typeof transcript === "string" && transcript
      ? 1
      : 0;
  const structuredMessageSaved = Boolean(inbound?.lead_id || inbound?.message);
  const leadSaved = Boolean(canonicalLead?.id || inbound?.lead_id);
  const unansweredQuestionSaved = Boolean((unanswered.data || []).length);
  const messageCaptureStatus =
    metadata?.message_capture_status || (leadSaved ? "saved" : "not_saved");
  const duplicateLeadIds = leads.map((lead) => lead.id).filter(Boolean);
  return {
    ok: true,
    callSid: sid,
    callRecordFound: Boolean(callRecord.data),
    transcriptFound: transcriptLength > 0,
    structuredMessageSaved,
    leadSaved,
    unansweredQuestionSaved,
    lead:
      canonicalLead ||
      (inbound?.lead_id
        ? { id: inbound.lead_id, fromCallRecordMetadata: true }
        : null),
    unansweredQuestions: (unanswered.data || []).map((row) => ({
      id: row.id,
      question: row.question,
      bot_response: row.bot_response,
      source: row.source,
      is_resolved: row.is_resolved,
    })),
    callRecord: callRecord.data
      ? {
          id: callRecord.data.id,
          organization_id: callRecord.data.organization_id,
          voice_agent_id: callRecord.data.voice_agent_id,
          summary: callRecord.data.summary || "",
          transcriptLength,
          metadata,
        }
      : null,
    messageCaptureStatus,
    duplicates: {
      count: Math.max(0, duplicateLeadIds.length - (canonicalLead?.id ? 1 : 0)),
      leadIds: duplicateLeadIds,
    },
  };
}

async function dedupeCallMessage(callSid) {
  const db = getSupabase();
  const sid = String(callSid || "").trim();
  if (!sid) return { ok: false, error: "callSid is required" };
  const callRecord = await safeDbRead(
    "dedupe call_records by twilio_call_sid",
    () =>
      db
        .from("call_records")
        .select("*")
        .eq("twilio_call_sid", sid)
        .maybeSingle(),
  );
  const callRecordId = callRecord.data?.id || null;
  const metadata = callRecord.data?.metadata || {};
  const inbound = metadata?.inbound_call_message || {};
  const leads = await findLeadsForCall(db, sid, callRecordId);
  if (!leads.length)
    return {
      ok: true,
      callSid: sid,
      canonicalLead: null,
      duplicatesMarked: [],
      duplicateCount: 0,
    };
  const canonical = chooseCanonicalLead(leads, inbound?.lead_id || null);
  if (!canonical?.id)
    return {
      ok: false,
      callSid: sid,
      error: "No canonical lead could be selected",
    };
  console.log("[message-capture] canonical lead id=" + canonical.id);

  const duplicates = leads.filter((lead) => lead.id !== canonical.id);
  const duplicatesMarked = [];
  for (const dup of duplicates) {
    const tags = Array.isArray(dup.tags) ? dup.tags : [];
    const nextTags = [...new Set([...tags, "duplicate"])];
    const result = await safeDbWrite("leads mark duplicate", () =>
      db
        .from("leads")
        .update({ status: "duplicate", tags: nextTags })
        .eq("id", dup.id)
        .select("id")
        .maybeSingle(),
    );
    if (result?.data?.id) duplicatesMarked.push(result.data.id);
  }

  if (callRecord.data?.id) {
    const nextInbound = { ...(inbound || {}), lead_id: canonical.id };
    const nextMetadata = mergeMetadata(metadata, {
      inbound_call_message: nextInbound,
      message_capture_status: metadata?.message_capture_status || "saved",
      duplicate_leads_marked: duplicatesMarked,
    });
    await safeDbWrite("call_records canonical lead metadata update", () =>
      db
        .from("call_records")
        .update({ metadata: nextMetadata })
        .eq("id", callRecord.data.id)
        .select("id")
        .maybeSingle(),
    );
  }

  return {
    ok: true,
    callSid: sid,
    canonicalLead: canonical,
    duplicatesMarked,
    duplicateCount: duplicatesMarked.length,
  };
}

async function safeDbRead(label, fn, fallback = null) {
  try {
    const result = await fn();
    if (result?.error) {
      const message = result.error.message || String(result.error);
      console.warn(`[twilio-media-stream] ${label} warning:`, message);
      return { data: fallback, error: message };
    }
    return { data: result?.data ?? fallback, error: null };
  } catch (err) {
    const message = err?.message || String(err);
    console.warn(`[twilio-media-stream] ${label} failed:`, message);
    return { data: fallback, error: message };
  }
}

async function loadAgentAndPrompt(context) {
  const fallbackPrompt =
    "You are an AI phone assistant for this business. Be concise, natural, and helpful. Speak in short phone-friendly sentences. If specific business knowledge is not loaded, say you do not have enough information in the business knowledge base and offer to take a message.";
  const diagnostics = {};

  try {
    const db = getSupabase();
    let agent = null;
    let organization = null;
    let effectiveOrgId = firstNonEmpty(context.orgId);

    if (context.agentId && effectiveOrgId) {
      const strict = await safeDbRead(
        "voice_agents strict id+organization+active lookup",
        () =>
          db
            .from("voice_agents")
            .select("*")
            .eq("id", context.agentId)
            .eq("organization_id", effectiveOrgId)
            .eq("is_active", true)
            .maybeSingle(),
      );
      diagnostics.agentStrictLookup =
        strict.error || (strict.data ? "matched" : "no row");
      agent = strict.data || null;
    }

    if (!agent && context.agentId && effectiveOrgId) {
      const scoped = await safeDbRead(
        "voice_agents scoped id+organization lookup",
        () =>
          db
            .from("voice_agents")
            .select("*")
            .eq("id", context.agentId)
            .eq("organization_id", effectiveOrgId)
            .maybeSingle(),
      );
      diagnostics.agentScopedLookup =
        scoped.error ||
        (scoped.data ? "matched without is_active=true filter" : "no row");
      agent = scoped.data || null;
    }

    if (!agent && context.agentId) {
      const byId = await safeDbRead("voice_agents id-only lookup", () =>
        db
          .from("voice_agents")
          .select("*")
          .eq("id", context.agentId)
          .maybeSingle(),
      );
      diagnostics.agentIdOnlyLookup =
        byId.error || (byId.data ? "matched by id only" : "no row");
      agent = byId.data || null;
      if (
        agent?.organization_id &&
        effectiveOrgId &&
        agent.organization_id !== effectiveOrgId
      ) {
        diagnostics.organizationMismatch = `agent.organization_id=${agent.organization_id} but request orgId=${effectiveOrgId}`;
      }
    }

    if (agent?.organization_id)
      effectiveOrgId = firstNonEmpty(effectiveOrgId, agent.organization_id);

    if (effectiveOrgId) {
      const orgLookup = await safeDbRead("organizations lookup", () =>
        db
          .from("organizations")
          .select("*")
          .eq("id", effectiveOrgId)
          .maybeSingle(),
      );
      diagnostics.organizationLookup =
        orgLookup.error || (orgLookup.data ? "matched" : "no row");
      organization = orgLookup.data || null;
    }

    if (!agent && organization?.active_voice_agent_id) {
      const activeAgent = await safeDbRead(
        "voice_agents active_voice_agent_id fallback lookup",
        () =>
          db
            .from("voice_agents")
            .select("*")
            .eq("id", organization.active_voice_agent_id)
            .eq("organization_id", organization.id)
            .maybeSingle(),
      );
      diagnostics.activeVoiceAgentFallback =
        activeAgent.error || (activeAgent.data ? "matched" : "no row");
      agent = activeAgent.data || null;
    }

    if (
      agent?.organization_id &&
      (!organization || organization.id !== agent.organization_id)
    ) {
      const agentOrg = await safeDbRead(
        "organizations agent.organization_id lookup",
        () =>
          db
            .from("organizations")
            .select("*")
            .eq("id", agent.organization_id)
            .maybeSingle(),
      );
      diagnostics.agentOrganizationLookup =
        agentOrg.error || (agentOrg.data ? "matched" : "no row");
      organization = agentOrg.data || organization;
      effectiveOrgId = agent.organization_id;
    }

    if (!agent) {
      logLifecycle("agent/context fallback prompt used", {
        orgId: context.orgId,
        agentId: context.agentId,
        organizationName: organization?.name || "",
        diagnostics,
      });
      const selectedVoice = mapVoiceProfileToOpenAi("");
      return {
        agent: null,
        organization,
        systemPrompt: fallbackPrompt,
        greeting: DEFAULT_GREETING,
        selectedVoice,
        language: "English",
        voiceProfile: "",
        voiceContext: {
          stats: {
            faqs: 0,
            knowledgeChunks: 0,
            uploadedDocumentChunks: 0,
            scrapedContent: 0,
            productsServices: 0,
            callPurposes: 0,
            linkedChatbots: 0,
            finalPromptChars: fallbackPrompt.length,
          },
          diagnostics,
          samples: {
            firstFaq: "",
            firstKnowledgeChunk: "",
            firstProductService: "",
          },
          debug: null,
        },
      };
    }

    let voiceContext = null;
    let systemPrompt = fallbackPrompt;
    try {
      voiceContext = await loadVoiceContext(
        db,
        effectiveOrgId || agent.organization_id,
        agent,
        "inbound phone call business products services faqs support",
        { direction: context.direction || agent.direction || "inbound" },
      );
      systemPrompt =
        voiceContext?.systemPrompt ||
        agent.system_prompt ||
        agent.prompt ||
        fallbackPrompt;
      if (voiceContext?.organization) organization = voiceContext.organization;
      voiceContext.diagnostics = {
        ...(voiceContext.diagnostics || {}),
        ...diagnostics,
      };
    } catch (contextErr) {
      systemPrompt = agent.system_prompt || agent.prompt || fallbackPrompt;
      console.warn(
        "[twilio-media-stream] context-builder fallback prompt used:",
        contextErr.message,
      );
      voiceContext = {
        stats: {
          faqs: 0,
          knowledgeChunks: 0,
          uploadedDocumentChunks: 0,
          scrapedContent: 0,
          productsServices: 0,
          callPurposes: 0,
          linkedChatbots: 0,
          finalPromptChars: systemPrompt.length,
        },
        diagnostics: { ...diagnostics, contextBuilder: contextErr.message },
        samples: {
          firstFaq: "",
          firstKnowledgeChunk: "",
          firstProductService: "",
        },
        debug: null,
      };
    }

    const greeting = firstNonEmpty(
      agent.greeting,
      agent.welcome_message,
      DEFAULT_GREETING,
    );
    const language = firstNonEmpty(agent.language, "English");
    const voiceProfile = firstNonEmpty(agent.voice, "");
    const selectedVoice = mapVoiceProfileToOpenAi(voiceProfile);

    const stats = voiceContext?.stats || {};
    const mergedDiagnostics = voiceContext?.diagnostics || diagnostics;
    console.log(
      "[voice-agent-context] orgId",
      effectiveOrgId || context.orgId || agent.organization_id || "",
    );
    console.log(
      "[voice-agent-context] agentId",
      agent.id || context.agentId || "",
    );
    console.log("[voice-agent-context] agentName", agent.name || "");
    console.log(
      "[voice-agent-context] organizationName",
      organization?.name || "",
    );
    console.log("[voice-agent-context] language", language);
    console.log("[voice-agent-context] greeting", greeting);
    console.log("[voice-agent-context] voiceProfile", voiceProfile);
    console.log(
      "[voice-agent-context] faqs count",
      stats.faqs || 0,
      mergedDiagnostics.faqs || "",
    );
    console.log(
      "[voice-agent-context] knowledge chunks count",
      stats.knowledgeChunks || 0,
      mergedDiagnostics.knowledgeChunks || "",
    );
    console.log(
      "[voice-agent-context] scraped content count",
      stats.scrapedContent || 0,
      mergedDiagnostics.scrapedContent || "",
    );
    console.log(
      "[voice-agent-context] uploaded chunks count",
      stats.uploadedDocumentChunks || 0,
      mergedDiagnostics.uploadedDocumentChunks || "",
    );
    console.log(
      "[voice-agent-context] products/services count",
      stats.productsServices || 0,
      mergedDiagnostics.productsServices || "",
    );
    console.log(
      "[voice-agent-context] call purposes count",
      stats.callPurposes || 0,
      mergedDiagnostics.callPurposes || "",
    );
    console.log(
      "[voice-agent-context] final prompt chars",
      stats.finalPromptChars || systemPrompt.length,
    );

    logLifecycle("agent loaded", {
      agentId: agent.id || context.agentId,
      agentName: agent.name || "",
      organizationId: effectiveOrgId || context.orgId || agent.organization_id,
      organizationName: organization?.name || "",
      language,
      voiceProfile,
      greetingMessage: greeting,
    });

    console.log(
      `[voice-map] ${voiceProfile || "default"} -> ${selectedVoice} (OpenAI voice mapping; ElevenLabs is not active for this stream)`,
    );
    logLifecycle("voice profile mapped", {
      callSid: context.callSid,
      dashboardVoiceProfile: voiceProfile,
      openaiVoice: selectedVoice,
      note: "OpenAI Realtime voice mapping; ElevenLabs is not used on this stream.",
    });

    return {
      agent,
      organization,
      systemPrompt,
      greeting,
      selectedVoice,
      language,
      voiceProfile,
      voiceContext,
    };
  } catch (err) {
    console.warn("[twilio-media-stream] prompt load warning:", err.message);
    const selectedVoice = mapVoiceProfileToOpenAi("");
    return {
      agent: null,
      organization: null,
      systemPrompt: fallbackPrompt,
      greeting: DEFAULT_GREETING,
      selectedVoice,
      language: "English",
      voiceProfile: "",
      voiceContext: {
        stats: {
          faqs: 0,
          knowledgeChunks: 0,
          uploadedDocumentChunks: 0,
          scrapedContent: 0,
          productsServices: 0,
          callPurposes: 0,
          linkedChatbots: 0,
          finalPromptChars: fallbackPrompt.length,
        },
        diagnostics: { fatalPromptLoadError: err.message },
        samples: {
          firstFaq: "",
          firstKnowledgeChunk: "",
          firstProductService: "",
        },
        debug: null,
      },
    };
  }
}

async function loadTwilioAgentContextForDebug({ orgId, agentId }) {
  const context = { orgId, agentId, direction: "inbound" };
  const loaded = await loadAgentAndPrompt(context);
  const debug = loaded.voiceContext?.debug || {};
  return {
    agentName: debug.agent?.name || loaded.agent?.name || "",
    organizationName:
      debug.organization?.name || loaded.organization?.name || "",
    language: loaded.language || loaded.agent?.language || "English",
    voiceProfile: loaded.voiceProfile || loaded.agent?.voice || "",
    greeting: loaded.greeting || "",
    promptPreview:
      debug.finalPromptPreview ||
      String(loaded.systemPrompt || "").slice(0, 500),
    agent: debug.agent || {
      id: loaded.agent?.id || agentId || "",
      name: loaded.agent?.name || "",
      language: loaded.language || loaded.agent?.language || "",
      voiceProfile: loaded.voiceProfile || loaded.agent?.voice || "",
      greeting: loaded.greeting || "",
      direction: loaded.agent?.direction || "",
    },
    organization: debug.organization || {
      id: loaded.organization?.id || orgId || "",
      name: loaded.organization?.name || "",
    },
    counts: debug.counts || {
      faqs: 0,
      knowledgeChunks: 0,
      uploadedDocumentChunks: 0,
      scrapedContent: 0,
      productsServices: 0,
      callPurposes: 0,
      finalPromptChars: String(loaded.systemPrompt || "").length,
    },
    samples: debug.samples || {
      firstFaq: "",
      firstKnowledgeChunk: "",
      firstProductService: "",
    },
    diagnostics: debug.diagnostics || loaded.voiceContext?.diagnostics || {},
    openaiVoice: loaded.selectedVoice || "",
    finalPromptPreview:
      debug.finalPromptPreview ||
      String(loaded.systemPrompt || "").slice(0, 1500),
    finalPromptChars:
      debug.finalPromptChars || String(loaded.systemPrompt || "").length,
  };
}

function realtimeSessionUpdate(systemPrompt, selectedVoice) {
  return {
    type: "session.update",
    session: {
      modalities: ["audio", "text"],
      instructions: systemPrompt,
      voice: selectedVoice || DEFAULT_VOICE,
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
      input_audio_transcription: {
        model: process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL || "whisper-1",
      },
      tools: [captureToolDefinition()],
      tool_choice: "auto",
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 650,
        create_response: true,
      },
    },
  };
}

function realtimeSessionUpdateCurrent(systemPrompt, selectedVoice) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: systemPrompt,
      output_modalities: ["audio"],
      tools: [captureToolDefinition()],
      tool_choice: "auto",
      audio: {
        input: {
          format: { type: "audio/pcmu", rate: 8000 },
          transcription: {
            model:
              process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL || "whisper-1",
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 650,
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          format: { type: "audio/pcmu", rate: 8000 },
          voice: selectedVoice || DEFAULT_VOICE,
        },
      },
    },
  };
}

function buildGreetingResponse(greeting) {
  return {
    type: "response.create",
    response: {
      modalities: ["audio", "text"],
      instructions: `Greet the caller now with exactly this greeting, then pause and listen: ${greeting}`,
    },
  };
}

function buildCurrentGreetingResponse(greeting) {
  return {
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      instructions: `Greet the caller now with exactly this greeting, then pause and listen: ${greeting}`,
    },
  };
}

function extractOpenAiAudioDelta(event) {
  if (!event || typeof event !== "object") return "";
  return firstNonEmpty(
    event.delta,
    event.audio,
    event?.response?.audio?.delta,
    event?.item?.audio?.delta,
    event?.output?.audio?.delta,
  );
}

function isAudioDeltaEvent(type) {
  return (
    type === "response.audio.delta" ||
    type === "response.output_audio.delta" ||
    type === "output_audio.delta" ||
    type.endsWith(".audio.delta") ||
    type.endsWith("output_audio.delta")
  );
}

async function handleTwilioMediaStreamWS(twilioWs, req) {
  let context = queryContext(req);
  let streamSid = "";
  let openaiWs = null;
  let openaiSocketOpen = false;
  let openaiSessionReady = false;
  let openaiSessionFallbackSent = false;
  let initialGreetingRequested = false;
  let noAudioTimer = null;
  const pendingAudio = [];
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();

  const counters = {
    twilioMediaFramesReceived: 0,
    openaiInputAudioAppended: 0,
    openaiAudioDeltasReceived: 0,
    audioFramesSentToTwilio: 0,
    openaiErrors: 0,
  };

  const transcriptLines = [];
  const userTranscripts = [];
  const assistantTranscripts = [];
  const captureState = {
    detected: false,
    callerName: "",
    callerPhone: "",
    callbackTime: "",
    message: "",
    saved: false,
    saveResult: null,
    messageCaptureSaved: false,
    savedLeadId: null,
  };
  let closingResponseSent = false;
  let callEndRequested = false;
  let callEnded = false;
  let idleTimer = null;
  let maxCallTimer = null;
  let pendingHangupTimers = [];
  let lastAssistantAskedAnythingElse = false;
  let closingState = "active";
  let closingReason = "";
  let closingResponseStartedAt = 0;

  logLifecycle("connected", {
    path: context.path,
    queryParams: context.query,
    orgId: context.orgId,
    agentId: context.agentId,
    callRecordId: context.callRecordId,
    callSid: context.callSid,
  });

  markActivity("connected");
  maxCallTimer = setTimeout(() => {
    if (!callEndRequested && !callEnded) {
      void requestClosingAndHangup(
        "max-call-duration",
        "I'll end the call now. Thank you for calling.",
      );
    }
  }, MAX_INBOUND_CALL_SECONDS * 1000);

  function closeOpenAI() {
    if (noAudioTimer) {
      clearTimeout(noAudioTimer);
      noAudioTimer = null;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (maxCallTimer) {
      clearTimeout(maxCallTimer);
      maxCallTimer = null;
    }
    for (const timer of pendingHangupTimers) clearTimeout(timer);
    pendingHangupTimers = [];
    try {
      if (
        openaiWs &&
        (openaiWs.readyState === WebSocket.OPEN ||
          openaiWs.readyState === WebSocket.CONNECTING)
      ) {
        openaiWs.close(1000);
      }
    } catch (_) {}
  }

  function markActivity(reason) {
    if (callEndRequested || callEnded) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (callEndRequested || callEnded) return;
      logLifecycle("idle timeout reached", {
        callSid: context.callSid,
        streamSid,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
      });
      void requestClosingAndHangup(
        "idle-timeout",
        "I'll end the call now. Thank you for calling.",
      );
    }, IDLE_TIMEOUT_MS);
    void reason;
  }

  async function finishMessageCapture() {
    await saveTranscriptOnly({
      context,
      transcriptLines,
      summary: summarizeTranscript(transcriptLines, 900),
    });
    if (captureState.saved) {
      if (captureState.savedLeadId)
        console.log(
          "[message-capture] fallback skipped existing lead id=" +
            captureState.savedLeadId,
        );
      return captureState.saveResult;
    }
    const allUserText = (userTranscripts || []).join("\n");
    const allAssistantText = (assistantTranscripts || []).join(" ");
    const likelyMessage =
      captureState.detected ||
      looksLikeMessageCapture(allUserText) ||
      /\b(call me back|callback|take a message|leave a message|my name is|please tell|message)\b/i.test(
        allUserText,
      );
    if (!likelyMessage) return null;
    if (!captureState.detected) {
      console.log("[message-capture] fallback extraction started", {
        callSid: context.callSid,
        streamSid,
      });
      captureState.detected = true;
      captureState.callerName =
        captureState.callerName || extractCallerNameFromTranscript(allUserText);
      captureState.callerPhone =
        captureState.callerPhone ||
        normalizeCapturedPhone(
          extractPhoneFromTranscript(allUserText, context.callerPhone),
          context.callerPhone,
        );
      captureState.callbackTime =
        captureState.callbackTime ||
        extractCallbackTimeFromTranscript(allUserText);
      captureState.message = captureState.message || allUserText;
    }
    const result = await persistInboundCallMessage({
      context,
      transcriptLines,
      userTranscripts,
      assistantTranscripts,
      captureState,
      status: "new",
      mode: "fallback",
    });
    captureState.saved = Boolean(result?.saved);
    captureState.messageCaptureSaved = Boolean(result?.saved);
    captureState.savedLeadId =
      result?.lead?.id || captureState.savedLeadId || null;
    captureState.saveResult = result;
    if (result?.saved)
      console.log(
        "[message-capture] fallback saved lead id=" +
          (result.lead?.id || "existing"),
      );
    return result;
  }

  async function requestTwilioCallEnd(reason) {
    if (callEndRequested || callEnded) return;
    callEndRequested = true;
    closingState = "hangup_completed";
    if (idleTimer) clearTimeout(idleTimer);
    if (maxCallTimer) clearTimeout(maxCallTimer);
    for (const timer of pendingHangupTimers) clearTimeout(timer);
    pendingHangupTimers = [];
    try {
      await finishMessageCapture();
    } catch (_) {}
    try {
      if (context.callSid) await dedupeCallMessage(context.callSid);
    } catch (dedupeErr) {
      console.warn("[message-capture] final dedupe pass failed", {
        callSid: context.callSid,
        error: dedupeErr.message || String(dedupeErr),
      });
    }
    logLifecycle("ending Twilio call", {
      callSid: context.callSid,
      streamSid,
      reason,
    });
    try {
      if (!context.callSid)
        throw new Error(
          "Missing callSid; cannot complete Twilio call via REST",
        );
      await endTwilioCall(context.callSid);
      callEnded = true;
      logLifecycle("call ended successfully", {
        callSid: context.callSid,
        streamSid,
        reason,
      });
    } catch (err) {
      console.error("[twilio-media-stream] call end failed:", {
        callSid: context.callSid,
        streamSid,
        reason,
        error: err.message || String(err),
      });
      try {
        twilioWs.close(1000, "call end fallback");
      } catch (_) {}
    }
  }

  function schedulePendingHangup(fn, delayMs) {
    const timer = setTimeout(() => {
      pendingHangupTimers = pendingHangupTimers.filter((t) => t !== timer);
      fn();
    }, delayMs);
    pendingHangupTimers.push(timer);
    return timer;
  }

  function cancelPendingHangup(reason) {
    if (!closingResponseSent || callEndRequested || callEnded) return false;
    for (const timer of pendingHangupTimers) clearTimeout(timer);
    pendingHangupTimers = [];
    closingResponseSent = false;
    closingState = "hangup_cancelled_by_real_user_speech";
    logLifecycle("pending hangup cancelled", {
      callSid: context.callSid,
      streamSid,
      reason,
      previousClosingReason: closingReason,
    });
    closingReason = "";
    closingResponseStartedAt = 0;
    return true;
  }

  function requestClosingAndHangup(reason, closingMessage = CLOSING_MESSAGE) {
    if (closingResponseSent || callEndRequested || callEnded) return;
    closingResponseSent = true;
    closingState = "end_intent_detected";
    closingReason = reason;
    closingResponseStartedAt = Date.now();
    logLifecycle("end intent detected", {
      callSid: context.callSid,
      streamSid,
      reason,
      closingState,
    });
    const finishAfterDelay = () => {
      closingState = "hangup_scheduled";
      schedulePendingHangup(
        () => void requestTwilioCallEnd(reason),
        FINAL_AUDIO_HANGUP_DELAY_MS,
      );
    };
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      safeSend(openaiWs, buildGreetingResponse(closingMessage));
      closingState = "closing_response_requested";
      logLifecycle("closing response sent", {
        callSid: context.callSid,
        streamSid,
        reason,
        closingMessage,
        closingState,
      });
      schedulePendingHangup(
        () => {
          if (!callEndRequested && closingResponseSent) finishAfterDelay();
        },
        Math.max(3500, FINAL_AUDIO_HANGUP_DELAY_MS + 1200),
      );
    } else {
      closingState = "closing_response_requested";
      logLifecycle("closing response sent", {
        callSid: context.callSid,
        streamSid,
        reason,
        closingMessage,
        fallback: "OpenAI not open",
        closingState,
      });
      finishAfterDelay();
    }
  }

  function sendAudioToTwilio(base64Audio) {
    if (!streamSid) {
      console.warn(
        "[twilio-media-stream] OpenAI audio received before streamSid; dropping frame",
        {
          callSid: context.callSid,
        },
      );
      return false;
    }
    const sent = safeSend(twilioWs, {
      event: "media",
      streamSid,
      media: { payload: base64Audio },
    });
    if (sent) {
      counters.audioFramesSentToTwilio += 1;
      markActivity("twilio-output-audio");
      if (
        counters.audioFramesSentToTwilio === 1 ||
        counters.audioFramesSentToTwilio % 50 === 0
      ) {
        logLifecycle("audio frame sent to Twilio", {
          callSid: context.callSid,
          streamSid,
          audioFramesSentToTwilio: counters.audioFramesSentToTwilio,
        });
      }
    }
    return sent;
  }

  function flushPendingAudio() {
    if (
      !openaiWs ||
      !openaiSocketOpen ||
      openaiWs.readyState !== WebSocket.OPEN
    )
      return;
    while (pendingAudio.length) {
      const frame = pendingAudio.shift();
      if (safeSend(openaiWs, frame)) {
        counters.openaiInputAudioAppended += 1;
      }
    }
    if (counters.openaiInputAudioAppended > 0) {
      logLifecycle("pending input audio flushed to OpenAI", {
        callSid: context.callSid,
        openaiInputAudioAppended: counters.openaiInputAudioAppended,
      });
    }
  }

  function requestInitialGreeting(reason) {
    if (initialGreetingRequested) return;
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    initialGreetingRequested = true;
    safeSend(
      openaiWs,
      buildGreetingResponse(context.greeting || DEFAULT_GREETING),
    );
    logLifecycle("greeting sent", {
      callSid: context.callSid,
      streamSid,
      reason,
      greeting: context.greeting || DEFAULT_GREETING,
    });

    noAudioTimer = setTimeout(() => {
      if (counters.openaiAudioDeltasReceived === 0) {
        console.warn(
          "[twilio-media-stream] no OpenAI audio received within 3s",
          {
            callSid: context.callSid,
            streamSid,
            openaiSessionReady,
            openaiSocketOpen,
            initialGreetingRequested,
          },
        );
      }
    }, 3000);
  }

  async function handleCaptureInboundMessage(rawArgs, callId = "") {
    console.log("[message-capture] tool called", {
      callSid: context.callSid,
      streamSid,
      callId,
    });
    const args = parseToolArguments(rawArgs);
    captureState.detected = true;
    captureState.callerName = firstNonEmpty(
      args.caller_name,
      captureState.callerName,
    );
    captureState.callerPhone = normalizeCapturedPhone(
      firstNonEmpty(
        args.caller_phone,
        captureState.callerPhone,
        context.callerPhone,
      ),
      context.callerPhone,
    );
    captureState.callbackTime = firstNonEmpty(
      args.callback_time,
      captureState.callbackTime,
    );
    captureState.email = firstNonEmpty(args.email, captureState.email);
    captureState.message = firstNonEmpty(args.message, captureState.message);
    const result = await persistInboundCallMessage({
      context,
      transcriptLines,
      userTranscripts,
      assistantTranscripts,
      captureState,
      toolArgs: args,
      status: "new",
      mode: "tool",
    });
    captureState.saved = Boolean(result?.saved);
    captureState.saveResult = result;

    const okMessage = "I’ve saved your message and callback preference.";
    const failMessage =
      "I’ve taken note of that, but I may not have been able to save it automatically. A team member can still review this call.";
    const outputText = result?.saved ? okMessage : failMessage;
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      if (callId) {
        safeSend(openaiWs, {
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify({
              success: Boolean(result?.saved),
              message: outputText,
              lead_id: result?.lead?.id || null,
            }),
          },
        });
      }
      safeSend(openaiWs, {
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: outputText,
        },
      });
    }
    return result;
  }

  async function ensureOpenAI() {
    if (openaiWs) return;
    if (!apiKey) {
      console.error("[twilio-media-stream] OPENAI_API_KEY is not configured", {
        callSid: context.callSid,
      });
      return;
    }

    const {
      agent,
      systemPrompt,
      greeting,
      selectedVoice,
      language,
      voiceProfile,
      voiceContext,
    } = await loadAgentAndPrompt(context);
    if (agent?.id && !context.agentId) context.agentId = agent.id;
    context.greeting = greeting;
    context.sessionVoice = selectedVoice;
    context.sessionLanguage = language;

    openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    openaiWs.on("open", () => {
      openaiSocketOpen = true;
      logLifecycle("OpenAI websocket/session created", {
        callSid: context.callSid,
        streamSid,
        modelUrl: OPENAI_REALTIME_URL.replace(/api_key=[^&]+/i, "api_key=***"),
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
      });

      safeSend(openaiWs, realtimeSessionUpdate(systemPrompt, selectedVoice));
      logLifecycle("session voice", {
        callSid: context.callSid,
        streamSid,
        voice: selectedVoice,
      });
      logLifecycle("session language", {
        callSid: context.callSid,
        streamSid,
        language,
      });
      logLifecycle("OpenAI session.update sent", {
        callSid: context.callSid,
        streamSid,
        voice: selectedVoice || DEFAULT_VOICE,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
      });

      // If OpenAI does not echo session.created/session.updated quickly, still
      // trigger the greeting and allow queued caller audio to flow.
      setTimeout(() => {
        if (!openaiSessionReady && openaiWs?.readyState === WebSocket.OPEN) {
          openaiSessionReady = true;
          logLifecycle("OpenAI session ready by timeout fallback", {
            callSid: context.callSid,
            streamSid,
          });
          flushPendingAudio();
          requestInitialGreeting("session-ready-timeout");
        }
      }, 1200);
    });

    openaiWs.on("message", (data, isBinary) => {
      if (isBinary) return;
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        console.warn("[twilio-media-stream] non-json OpenAI message ignored");
        return;
      }

      const type = String(event?.type || "");

      if (
        type === "response.function_call_arguments.done" ||
        type === "response.output_item.done"
      ) {
        const item =
          event.item ||
          event.response?.output?.find?.(
            (entry) => entry?.type === "function_call",
          ) ||
          null;
        const name = firstNonEmpty(event.name, item?.name);
        const args = firstNonEmpty(event.arguments, item?.arguments);
        const callId = firstNonEmpty(
          event.call_id,
          event.callId,
          item?.call_id,
          item?.id,
        );
        if (name === "capture_inbound_message") {
          void handleCaptureInboundMessage(args, callId);
          return;
        }
      }

      if (type === "conversation.item.created") {
        const item = event.item || {};
        if (
          item.type === "function_call" &&
          item.name === "capture_inbound_message" &&
          item.arguments
        ) {
          void handleCaptureInboundMessage(
            item.arguments,
            item.call_id || item.id || "",
          );
          return;
        }
      }

      if (type === "session.updated" || type === "session.created") {
        openaiSessionReady = true;
        logLifecycle(`OpenAI ${type} event`, {
          callSid: context.callSid,
          streamSid,
        });
        flushPendingAudio();
        requestInitialGreeting(type);
        return;
      }

      if (type === "error") {
        counters.openaiErrors += 1;
        const errMsg = getOpenAiErrorMessage(event);
        console.error("[twilio-media-stream] OpenAI error event", {
          callSid: context.callSid,
          streamSid,
          error: event.error || event,
        });

        // Some deployments use the newer gpt-realtime session object shape. If
        // the legacy audio-format session update is rejected, send the current
        // shape once without closing the call.
        if (
          !openaiSessionFallbackSent &&
          /input_audio_format|output_audio_format|unknown parameter|invalid/i.test(
            errMsg,
          )
        ) {
          openaiSessionFallbackSent = true;
          safeSend(
            openaiWs,
            realtimeSessionUpdateCurrent(systemPrompt, selectedVoice),
          );
          safeSend(
            openaiWs,
            buildCurrentGreetingResponse(context.greeting || DEFAULT_GREETING),
          );
          initialGreetingRequested = true;
          logLifecycle("OpenAI current session fallback sent", {
            callSid: context.callSid,
            streamSid,
            error: errMsg,
          });
        }
        return;
      }

      if (type === "conversation.item.input_audio_transcription.completed") {
        const transcript = firstNonEmpty(
          event.transcript,
          event?.item?.content?.[0]?.transcript,
        );
        if (transcript) {
          userTranscripts.push(transcript);
          transcriptLines.push({
            role: "caller",
            text: transcript,
            ts: new Date().toISOString(),
          });
          console.log("[transcript] final user transcript", {
            callSid: context.callSid,
            text: transcript,
          });
          markActivity("caller-transcript");
          if (looksLikeMessageCapture(transcript)) {
            captureState.detected = true;
            captureState.callerName =
              captureState.callerName ||
              extractCallerNameFromTranscript(transcript);
            captureState.callerPhone =
              captureState.callerPhone ||
              extractPhoneFromTranscript(transcript, context.callerPhone);
            captureState.callbackTime =
              captureState.callbackTime ||
              extractCallbackTimeFromTranscript(transcript);
            captureState.message = [captureState.message, transcript]
              .filter(Boolean)
              .join("\n")
              .trim();
            console.log("[message-capture] detected", {
              callSid: context.callSid,
              streamSid,
            });
            console.log(
              "[message-capture] callerName",
              captureState.callerName || "",
            );
            console.log(
              "[message-capture] callbackTime",
              captureState.callbackTime || "",
            );
          }
          if (
            closingResponseSent &&
            !callEndRequested &&
            hasHangupCancelIntent(transcript)
          ) {
            cancelPendingHangup("caller-continued-after-close");
          } else if (
            hasEndIntent(transcript, {
              afterAnythingElsePrompt: lastAssistantAskedAnythingElse,
            })
          ) {
            requestClosingAndHangup("caller-end-intent", CLOSING_MESSAGE);
          }
        }
        return;
      }

      if (
        type === "response.audio_transcript.delta" ||
        type === "response.output_text.delta" ||
        type === "response.text.delta"
      ) {
        const delta = firstNonEmpty(event.delta, event.text);
        if (delta) {
          assistantTranscripts.push(delta);
          markActivity("assistant-transcript-delta");
        }
      }

      if (
        type === "response.audio_transcript.done" ||
        type === "response.text.done" ||
        type === "response.output_text.done"
      ) {
        const text = firstNonEmpty(
          event.transcript,
          event.text,
          assistantTranscripts.join(""),
        );
        if (text) {
          transcriptLines.push({
            role: "assistant",
            text,
            ts: new Date().toISOString(),
          });
          console.log("[transcript] final assistant transcript", {
            callSid: context.callSid,
            text,
          });
          lastAssistantAskedAnythingElse = assistantAskedAnythingElse(text);
          // Do not end the call just because the assistant says a goodbye-like
          // phrase. Some generated responses include polite sign-offs while the
          // caller still wants to continue or is speaking over the assistant.
          // Hangup is driven by explicit caller intent, idle timeout, or max
          // duration only.
        }
      }

      if (type === "response.created") {
        logLifecycle("OpenAI response.created", {
          callSid: context.callSid,
          streamSid,
          responseId: event?.response?.id || "",
        });
      }

      if (type === "response.done") {
        logLifecycle("OpenAI response.done", {
          callSid: context.callSid,
          streamSid,
          status: event?.response?.status || "",
          audioDeltas: counters.openaiAudioDeltasReceived,
          audioFramesSentToTwilio: counters.audioFramesSentToTwilio,
        });
        if (closingResponseSent && !callEndRequested) {
          closingState = "closing_audio_done";
          schedulePendingHangup(
            () => void requestTwilioCallEnd("closing-response-done"),
            FINAL_AUDIO_HANGUP_DELAY_MS,
          );
        }
      }

      if (type === "input_audio_buffer.speech_started" && streamSid) {
        // Do not cancel a pending goodbye on raw speech_started alone; Twilio/OpenAI
        // can emit this for noise, breath, or clipped audio after a clear goodbye.
        // Cancellation happens only after a finalized user transcript shows real
        // continuation intent, e.g. "wait" or "I am not done".
        safeSend(twilioWs, { event: "clear", streamSid });
        logLifecycle("Twilio clear sent after caller speech_started", {
          callSid: context.callSid,
          streamSid,
          closingState,
          hangupCancellationRequiresFinalTranscript: true,
        });
        return;
      }

      if (isAudioDeltaEvent(type)) {
        const audioDelta = extractOpenAiAudioDelta(event);
        if (!audioDelta) {
          console.warn(
            "[twilio-media-stream] OpenAI audio delta event had no payload",
            {
              type,
              callSid: context.callSid,
              streamSid,
            },
          );
          return;
        }
        counters.openaiAudioDeltasReceived += 1;
        if (
          counters.openaiAudioDeltasReceived === 1 ||
          counters.openaiAudioDeltasReceived % 50 === 0
        ) {
          logLifecycle("OpenAI audio delta received", {
            callSid: context.callSid,
            streamSid,
            openaiAudioDeltasReceived: counters.openaiAudioDeltasReceived,
          });
        }
        sendAudioToTwilio(audioDelta);
      }
    });

    openaiWs.on("error", (err) => {
      counters.openaiErrors += 1;
      console.error("[twilio-media-stream] OpenAI WS error:", {
        callSid: context.callSid,
        streamSid,
        message: err.message,
      });
    });

    openaiWs.on("close", (code, reason) => {
      openaiSocketOpen = false;
      openaiSessionReady = false;
      logLifecycle("OpenAI WS closed", {
        code,
        reason: reason?.toString?.() || "",
        callSid: context.callSid,
        streamSid,
        counters,
      });
    });
  }

  twilioWs.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      console.warn("[twilio-media-stream] non-json Twilio message ignored", {
        callSid: context.callSid,
      });
      return;
    }

    markActivity(message.event || "twilio-message");

    if (message.event === "connected") {
      logLifecycle("Twilio connected event", {
        callSid: context.callSid,
        protocol: message.protocol || "",
        version: message.version || "",
      });
      return;
    }

    if (message.event === "start") {
      streamSid = message.start?.streamSid || message.streamSid || streamSid;
      context = mergeStartParameters(context, message.start || {});
      const activeKey = sessionKeyFor(context, streamSid);
      if (activeTwilioSessions.has(activeKey)) {
        console.warn(
          "[twilio-media-stream] duplicate Twilio stream session blocked",
          { callSid: context.callSid, streamSid, activeKey },
        );
        twilioWs.close(1000, "duplicate stream");
        return;
      }
      activeTwilioSessions.add(activeKey);
      twilioWs.__twilioActiveKey = activeKey;
      logLifecycle("Twilio start event", {
        path: context.path,
        orgId: context.orgId,
        agentId: context.agentId,
        callRecordId: context.callRecordId,
        callSid: context.callSid,
        streamSid,
        customParameters: message.start?.customParameters || {},
      });
      await ensureOpenAI();
      return;
    }

    if (message.event === "media") {
      counters.twilioMediaFramesReceived += 1;
      const payload = message.media?.payload;
      if (!payload) {
        console.warn(
          "[twilio-media-stream] Twilio media frame missing payload",
          {
            callSid: context.callSid,
            streamSid,
            mediaFramesReceived: counters.twilioMediaFramesReceived,
          },
        );
        return;
      }

      if (
        counters.twilioMediaFramesReceived === 1 ||
        counters.twilioMediaFramesReceived % 100 === 0
      ) {
        logLifecycle("Twilio media frames received", {
          callSid: context.callSid,
          streamSid,
          mediaFramesReceived: counters.twilioMediaFramesReceived,
        });
      }

      const openAiAudio = {
        type: "input_audio_buffer.append",
        audio: payload,
      };

      if (
        openaiWs &&
        openaiSocketOpen &&
        openaiWs.readyState === WebSocket.OPEN
      ) {
        if (safeSend(openaiWs, openAiAudio)) {
          counters.openaiInputAudioAppended += 1;
          if (
            counters.openaiInputAudioAppended === 1 ||
            counters.openaiInputAudioAppended % 100 === 0
          ) {
            logLifecycle("OpenAI input audio appended", {
              callSid: context.callSid,
              streamSid,
              openaiInputAudioAppended: counters.openaiInputAudioAppended,
            });
          }
        } else {
          console.warn(
            "[twilio-media-stream] media frame received but input audio append failed",
            {
              callSid: context.callSid,
              streamSid,
              openaiSocketOpen,
              readyState: openaiWs?.readyState,
            },
          );
        }
      } else {
        pendingAudio.push(openAiAudio);
        if (pendingAudio.length > 250) pendingAudio.shift();
        if (pendingAudio.length === 1 || pendingAudio.length % 100 === 0) {
          console.warn(
            "[twilio-media-stream] media frame queued; OpenAI not ready yet",
            {
              callSid: context.callSid,
              streamSid,
              pendingAudio: pendingAudio.length,
              hasOpenAI: !!openaiWs,
              openaiSocketOpen,
            },
          );
        }
        if (!openaiWs) void ensureOpenAI();
      }
      return;
    }

    if (message.event === "stop") {
      logLifecycle("Twilio stop event", {
        callSid: context.callSid,
        streamSid,
        counters,
      });
      void (async () => {
        try {
          await finishMessageCapture();
        } catch (_) {}
        try {
          if (context.callSid) await dedupeCallMessage(context.callSid);
        } catch (dedupeErr) {
          console.warn("[message-capture] final dedupe pass failed", {
            callSid: context.callSid,
            error: dedupeErr.message || String(dedupeErr),
          });
        }
      })();
      closeOpenAI();
      return;
    }

    console.warn("[twilio-media-stream] unhandled Twilio event", {
      event: message.event,
      callSid: context.callSid,
      streamSid,
    });
  });

  twilioWs.on("close", (code, reason) => {
    if (twilioWs.__twilioActiveKey)
      activeTwilioSessions.delete(twilioWs.__twilioActiveKey);
    logLifecycle("closed", {
      code,
      reason: reason?.toString?.() || "",
      callSid: context.callSid,
      streamSid,
      counters,
    });
    if (
      counters.twilioMediaFramesReceived > 0 &&
      counters.openaiInputAudioAppended === 0
    ) {
      console.warn(
        "[twilio-media-stream] media received but no input audio appended to OpenAI",
        {
          callSid: context.callSid,
          streamSid,
          reason:
            "OpenAI websocket was not open or input append failed before call ended.",
          counters,
        },
      );
    }
    void (async () => {
      try {
        await finishMessageCapture();
      } catch (_) {}
      try {
        if (context.callSid) await dedupeCallMessage(context.callSid);
      } catch (dedupeErr) {
        console.warn("[message-capture] final dedupe pass failed", {
          callSid: context.callSid,
          error: dedupeErr.message || String(dedupeErr),
        });
      }
    })();
    closeOpenAI();
  });

  twilioWs.on("error", (err) => {
    console.error("[twilio-media-stream] socket error:", {
      callSid: context.callSid,
      streamSid,
      message: err.message,
    });
    closeOpenAI();
  });
}

module.exports = {
  handleTwilioMediaStreamWS,
  loadTwilioAgentContextForDebug,
  loadCallMessageDebug,
  dedupeCallMessage,
  mapVoiceProfileToOpenAi,
};
