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

function hasEndIntent(text) {
  const t = normalizeSpeechText(text);
  if (!t) return false;
  if (
    /\b(thank you|thanks)\b/.test(t) &&
    !/\b(bye|goodbye|that'?s all|that is all|end the call|talk to you later|have a nice day|nothing else|no more)\b/.test(
      t,
    )
  )
    return false;
  return (
    /\b(bye|goodbye|good bye|talk to you later|end the call|hang up|disconnect)\b/.test(
      t,
    ) ||
    /\b(that'?s all|that is all|nothing else|no more questions|no,? that'?s all|no,? that is all)\b/.test(
      t,
    ) ||
    /\b(thank you|thanks)\b.*\b(bye|goodbye|that'?s all|that is all|have a nice day)\b/.test(
      t,
    ) ||
    /\b(goodbye|bye)\b.*\b(have a nice day|wonderful day|thank you)\b/.test(t)
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
    .map((line) => `${line.role}: ${line.text}`)
    .join("\n")
    .trim();
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
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

async function persistInboundCallMessage({
  context,
  transcriptLines,
  userTranscripts,
  assistantTranscripts,
  captureState,
  status = "new",
}) {
  const db = getSupabase();
  const transcript = summarizeTranscript(transcriptLines, 12000);
  const userText = (userTranscripts || []).join("\n").trim();
  const assistantText = (assistantTranscripts || []).join("\n").trim();
  const messageText = captureState.message || userText || transcript;
  const callerName =
    captureState.callerName || extractCallerNameFromTranscript(userText);
  const callerPhone = extractPhoneFromTranscript(userText, context.callerPhone);
  const callbackTime =
    captureState.callbackTime || extractCallbackTimeFromTranscript(userText);
  const organizationId = context.orgId || context.organizationId || null;
  const voiceAgentId = context.agentId || null;
  const callRecordId = context.callRecordId || null;
  const twilioCallSid = context.callSid || null;
  const source = "inbound_call";
  if (!organizationId && !voiceAgentId && !twilioCallSid && !callRecordId)
    return { saved: false, reason: "missing context identifiers" };
  if (!messageText && !transcript)
    return { saved: false, reason: "empty transcript/message" };
  console.log("[message-capture] detected", {
    callSid: twilioCallSid,
    callRecordId,
    organizationId,
    voiceAgentId,
  });
  console.log("[message-capture] callerName", callerName || "");
  console.log("[message-capture] callbackTime", callbackTime || "");
  const metadata = {
    inbound_call_message: {
      organization_id: organizationId,
      voice_agent_id: voiceAgentId,
      call_record_id: callRecordId,
      twilio_call_sid: twilioCallSid,
      caller_phone: callerPhone,
      caller_name: callerName,
      message: messageText,
      requested_callback_time: callbackTime,
      status,
      source,
      created_at: new Date().toISOString(),
    },
  };
  const saved = { callRecord: null, lead: null, unansweredQuestion: null };
  if (callRecordId) {
    const update = await safeDbWrite("call_records update by id", () =>
      db
        .from("call_records")
        .update({ transcript, summary: messageText.slice(0, 1000), metadata })
        .eq("id", callRecordId)
        .select("id")
        .maybeSingle(),
    );
    saved.callRecord = update.data?.id || null;
  } else if (twilioCallSid) {
    const update = await safeDbWrite(
      "call_records update by twilio_call_sid",
      () =>
        db
          .from("call_records")
          .update({ transcript, summary: messageText.slice(0, 1000), metadata })
          .eq("twilio_call_sid", twilioCallSid)
          .select("id")
          .maybeSingle(),
    );
    saved.callRecord = update.data?.id || null;
  }
  const leadInsert = await safeDbWrite("leads insert", () =>
    db
      .from("leads")
      .insert({
        organization_id: organizationId,
        voice_agent_id: voiceAgentId,
        name: callerName || null,
        phone: callerPhone || null,
        reason: messageText.slice(0, 1000),
        source,
        assignment_context: {
          requested_callback_time: callbackTime || null,
          call_record_id: callRecordId,
          twilio_call_sid: twilioCallSid,
        },
        tags: ["inbound_call", "voice_agent"],
      })
      .select("id")
      .maybeSingle(),
  );
  saved.lead = leadInsert.data?.id || null;
  const unansweredInsert = await safeDbWrite(
    "unanswered_questions insert",
    () =>
      db
        .from("unanswered_questions")
        .insert({
          organization_id: organizationId,
          voice_agent_id: voiceAgentId,
          call_record_id: callRecordId,
          question: messageText.slice(0, 2000),
          bot_response: assistantText.slice(-2000),
          source,
          is_resolved: false,
        })
        .select("id")
        .maybeSingle(),
  );
  saved.unansweredQuestion = unansweredInsert.data?.id || null;
  const savedIds = Object.values(saved).filter(Boolean);
  if (savedIds.length) {
    console.log(`[message-capture] saved id=${savedIds.join(",")}`);
    return {
      saved: true,
      ...saved,
      callerName,
      callerPhone,
      callbackTime,
      message: messageText,
    };
  }
  console.warn("[message-capture] failed", {
    callSid: twilioCallSid,
    errors: "No existing table accepted the save.",
  });
  return {
    saved: false,
    ...saved,
    callerName,
    callerPhone,
    callbackTime,
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
  const leads = await safeDbRead(
    "debug leads by source",
    () => db.from("leads").select("*").eq("source", "inbound_call").limit(25),
    [],
  );
  let unanswered = { data: [], error: null };
  if (callRecordId)
    unanswered = await safeDbRead(
      "debug unanswered_questions by call_record_id",
      () =>
        db
          .from("unanswered_questions")
          .select("*")
          .eq("call_record_id", callRecordId)
          .limit(10),
      [],
    );
  const matchedLeads = (leads.data || []).filter((lead) => {
    const ctx = lead.assignment_context || {};
    return (
      ctx.twilio_call_sid === sid ||
      (callRecordId && ctx.call_record_id === callRecordId)
    );
  });
  return {
    ok: true,
    callSid: sid,
    saved: Boolean(
      callRecord.data || matchedLeads.length || (unanswered.data || []).length,
    ),
    callRecord: callRecord.data
      ? {
          id: callRecord.data.id,
          organization_id: callRecord.data.organization_id,
          voice_agent_id: callRecord.data.voice_agent_id,
          summary: callRecord.data.summary || "",
          hasTranscript: Boolean(callRecord.data.transcript),
          inboundCallMessage:
            callRecord.data.metadata?.inbound_call_message || null,
        }
      : null,
    leads: matchedLeads.map((lead) => ({
      id: lead.id,
      name: lead.name,
      phone: lead.phone,
      reason: lead.reason,
      source: lead.source,
      assignment_context: lead.assignment_context,
    })),
    unansweredQuestions: (unanswered.data || []).map((row) => ({
      id: row.id,
      question: row.question,
      source: row.source,
      is_resolved: row.is_resolved,
    })),
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
  };
  let closingResponseSent = false;
  let callEndRequested = false;
  let callEnded = false;
  let idleTimer = null;
  let maxCallTimer = null;

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
    if (captureState.saved) return captureState.saveResult;
    if (!captureState.detected && !transcriptLines.length) return null;
    const result = await persistInboundCallMessage({
      context,
      transcriptLines,
      userTranscripts,
      assistantTranscripts,
      captureState,
      status: "new",
    });
    captureState.saved = Boolean(result?.saved);
    captureState.saveResult = result;
    return result;
  }

  async function requestTwilioCallEnd(reason) {
    if (callEndRequested || callEnded) return;
    callEndRequested = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (maxCallTimer) clearTimeout(maxCallTimer);
    try {
      await finishMessageCapture();
    } catch (_) {}
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

  function requestClosingAndHangup(reason, closingMessage = CLOSING_MESSAGE) {
    if (closingResponseSent || callEndRequested || callEnded) return;
    closingResponseSent = true;
    logLifecycle("end intent detected", {
      callSid: context.callSid,
      streamSid,
      reason,
    });
    const finishAfterDelay = () =>
      setTimeout(
        () => void requestTwilioCallEnd(reason),
        FINAL_AUDIO_HANGUP_DELAY_MS,
      );
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      safeSend(openaiWs, buildGreetingResponse(closingMessage));
      logLifecycle("closing response sent", {
        callSid: context.callSid,
        streamSid,
        reason,
        closingMessage,
      });
      setTimeout(
        () => {
          if (!callEndRequested) finishAfterDelay();
        },
        Math.max(2500, FINAL_AUDIO_HANGUP_DELAY_MS + 700),
      );
    } else {
      logLifecycle("closing response sent", {
        callSid: context.callSid,
        streamSid,
        reason,
        closingMessage,
        fallback: "OpenAI not open",
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
          if (hasEndIntent(transcript))
            requestClosingAndHangup("caller-end-intent", CLOSING_MESSAGE);
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
          if (hasEndIntent(text) && !closingResponseSent)
            requestClosingAndHangup("assistant-end-intent", CLOSING_MESSAGE);
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
          setTimeout(
            () => void requestTwilioCallEnd("closing-response-done"),
            FINAL_AUDIO_HANGUP_DELAY_MS,
          );
        }
      }

      if (type === "input_audio_buffer.speech_started" && streamSid) {
        safeSend(twilioWs, { event: "clear", streamSid });
        logLifecycle("Twilio clear sent after caller speech_started", {
          callSid: context.callSid,
          streamSid,
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
      void finishMessageCapture();
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
    void finishMessageCapture();
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
  mapVoiceProfileToOpenAi,
};
