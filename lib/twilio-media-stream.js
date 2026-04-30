"use strict";

/**
 * Twilio Media Streams <Connect><Stream> handler.
 *
 * This endpoint intentionally does not require the browser/widget JWT flow:
 * Twilio connects directly over WebSocket and sends call metadata in the
 * query string and/or in the `start.customParameters` payload.
 */

const WebSocket = require("ws");
const { getSupabase } = require("./supabase");
const { loadVoiceContext } = require("./context-builder");

const OPENAI_REALTIME_URL =
  process.env.OPENAI_REALTIME_URL ||
  "wss://api.openai.com/v1/realtime?model=gpt-realtime";

const DEFAULT_VOICE = process.env.OPENAI_REALTIME_VOICE || "alloy";

function safeSend(ws, payload) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
    }
  } catch (_) {}
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function queryContext(req) {
  const parsed = new URL(req.url || "", "http://localhost");
  const params = parsed.searchParams;
  return {
    path: parsed.pathname,
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
      start?.from,
      context.callerPhone,
    ),
  };
}

async function loadAgentAndPrompt(context) {
  const fallbackPrompt =
    "You are an AI phone assistant. Be concise, natural, and helpful.";

  try {
    const db = getSupabase();
    let agent = null;

    if (context.agentId && context.orgId) {
      const { data } = await db
        .from("voice_agents")
        .select("*")
        .eq("id", context.agentId)
        .eq("organization_id", context.orgId)
        .maybeSingle();
      agent = data || null;
    }

    if (!agent && context.orgId) {
      const { data: org } = await db
        .from("organizations")
        .select("active_voice_agent_id")
        .eq("id", context.orgId)
        .maybeSingle();
      if (org?.active_voice_agent_id) {
        const { data } = await db
          .from("voice_agents")
          .select("*")
          .eq("id", org.active_voice_agent_id)
          .maybeSingle();
        agent = data || null;
      }
    }

    if (!agent) return { agent: null, systemPrompt: fallbackPrompt };

    let systemPrompt = fallbackPrompt;
    try {
      const voiceContext = await loadVoiceContext(
        db,
        context.orgId,
        agent,
        "inbound phone call",
      );
      systemPrompt =
        voiceContext?.systemPrompt || agent.system_prompt || fallbackPrompt;
    } catch (contextErr) {
      systemPrompt = agent.system_prompt || agent.prompt || fallbackPrompt;
      console.warn(
        "[twilio-media-stream] context load warning:",
        contextErr.message,
      );
    }

    return { agent, systemPrompt };
  } catch (err) {
    console.warn("[twilio-media-stream] prompt load warning:", err.message);
    return { agent: null, systemPrompt: fallbackPrompt };
  }
}

function realtimeSessionUpdate(systemPrompt) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      model: "gpt-realtime",
      instructions: systemPrompt,
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcmu", rate: 8000 },
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
          voice: DEFAULT_VOICE,
        },
      },
    },
  };
}

function legacyRealtimeSessionUpdate(systemPrompt) {
  return {
    type: "session.update",
    session: {
      modalities: ["audio", "text"],
      instructions: systemPrompt,
      voice: DEFAULT_VOICE,
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
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

function handleOpenAIEvent(event, twilioWs, getStreamSid) {
  const type = event?.type || "";
  const streamSid = getStreamSid();

  const audioDelta =
    event.delta ||
    event.audio ||
    event?.response?.audio?.delta ||
    event?.item?.audio?.delta ||
    "";

  if (
    streamSid &&
    audioDelta &&
    (type === "response.audio.delta" ||
      type === "response.output_audio.delta" ||
      type === "output_audio.delta")
  ) {
    safeSend(twilioWs, {
      event: "media",
      streamSid,
      media: { payload: audioDelta },
    });
    return;
  }

  if (type === "input_audio_buffer.speech_started" && streamSid) {
    safeSend(twilioWs, { event: "clear", streamSid });
    return;
  }

  if (type === "error") {
    console.error(
      "[twilio-media-stream] OpenAI error:",
      JSON.stringify(event.error || event),
    );
  }
}

async function handleTwilioMediaStreamWS(twilioWs, req) {
  let context = queryContext(req);
  let streamSid = "";
  let openaiWs = null;
  let openaiReady = false;
  const pendingAudio = [];
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();

  console.log("[twilio-media-stream] connected", {
    path: context.path,
    orgId: context.orgId,
    agentId: context.agentId,
    callRecordId: context.callRecordId,
    callSid: context.callSid,
  });

  function closeOpenAI() {
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

  async function ensureOpenAI() {
    if (openaiWs || !apiKey) return;
    if (!apiKey) {
      console.error("[twilio-media-stream] OPENAI_API_KEY is not configured");
      return;
    }

    const { systemPrompt } = await loadAgentAndPrompt(context);
    openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    openaiWs.on("open", () => {
      openaiReady = true;
      console.log("[twilio-media-stream] OpenAI realtime connected", {
        callSid: context.callSid,
        streamSid,
      });

      // Send both current and legacy session shapes. Newer APIs accept the
      // first; older preview deployments accept the second. If one shape is
      // rejected, the error is logged but the websocket stays open when the
      // other shape is accepted.
      safeSend(openaiWs, realtimeSessionUpdate(systemPrompt));
      safeSend(openaiWs, legacyRealtimeSessionUpdate(systemPrompt));

      while (pendingAudio.length) safeSend(openaiWs, pendingAudio.shift());
    });

    openaiWs.on("message", (data, isBinary) => {
      if (isBinary) return;
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      handleOpenAIEvent(event, twilioWs, () => streamSid);
    });

    openaiWs.on("error", (err) => {
      console.error("[twilio-media-stream] OpenAI WS error:", err.message);
    });

    openaiWs.on("close", (code, reason) => {
      openaiReady = false;
      console.log(
        `[twilio-media-stream] OpenAI WS closed code=${code} reason=${reason}`,
      );
    });
  }

  twilioWs.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.event === "connected") return;

    if (message.event === "start") {
      streamSid = message.start?.streamSid || message.streamSid || streamSid;
      context = mergeStartParameters(context, message.start || {});
      console.log("[twilio-media-stream] start", {
        path: context.path,
        orgId: context.orgId,
        agentId: context.agentId,
        callRecordId: context.callRecordId,
        callSid: context.callSid,
        streamSid,
      });
      await ensureOpenAI();
      return;
    }

    if (message.event === "media") {
      const payload = message.media?.payload;
      if (!payload) return;
      const openAiAudio = {
        type: "input_audio_buffer.append",
        audio: payload,
      };
      if (openaiWs && openaiReady && openaiWs.readyState === WebSocket.OPEN) {
        safeSend(openaiWs, openAiAudio);
      } else {
        pendingAudio.push(openAiAudio);
        if (!openaiWs) void ensureOpenAI();
      }
      return;
    }

    if (message.event === "stop") {
      console.log("[twilio-media-stream] stop", {
        callSid: context.callSid,
        streamSid,
      });
      closeOpenAI();
      return;
    }
  });

  twilioWs.on("close", (code, reason) => {
    console.log(
      `[twilio-media-stream] closed code=${code} reason=${reason} callSid=${context.callSid}`,
    );
    closeOpenAI();
  });

  twilioWs.on("error", (err) => {
    console.error("[twilio-media-stream] socket error:", err.message);
    closeOpenAI();
  });
}

module.exports = {
  handleTwilioMediaStreamWS,
};
