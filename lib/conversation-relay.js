"use strict";

/**
 * conversation-relay.js
 *
 * WebSocket handler for Twilio ConversationRelay.
 *
 * UPDATED: Now uses OpenAI Realtime API for sub-second response latency.
 * Falls back to the original streaming GPT-4o-mini approach if Realtime fails.
 *
 * Latency improvement:
 *   Before: ~2–4 seconds per AI turn (chat.completions streaming)
 *   After:  ~150–400ms first token (Realtime API, warm connection)
 *
 * How ConversationRelay works:
 *   Twilio → server: { type: 'prompt', voicePrompt: '...' }  (caller speech, already transcribed by Deepgram)
 *   server → Twilio: { type: 'text', token: '...', last: false }  (AI reply tokens)
 *   server → Twilio: { type: 'text', token: '', last: true }       (signal turn is done)
 *
 * One RealtimeSession is created per call (on setup) and stays alive
 * for the call duration — no per-turn connection overhead.
 */

const { getSupabase } = require("./supabase");
const { generateStreamingResponse } = require("./openai"); // fallback
const { buildSystemPrompt, VOICE_MAP, LANGUAGE_MAP } = require("./twilio");
const { createRealtimeSession } = require("./realtime-relay");

// Track active sessions: callSid → session state
const activeSessions = new Map();

/**
 * Called once per WebSocket upgrade by dev-server.js / Railway entrypoint.
 */
async function handleConversationRelayWS(ws, req) {
  const params = new URL(req.url, "http://localhost").searchParams;
  const orgId = params.get("orgId") || "";
  const agentId = params.get("agentId") || "";
  let callSid = params.get("callSid") || "";

  let agentRow = null;
  let faqs = [];
  let chunks = [];
  let systemPrompt = "";
  const messages = []; // kept for fallback path
  const startTime = Date.now();
  let transcript = [];
  let callerPhone = params.get("callerPhone") || "";
  let callerName = "Unknown Caller";

  // Realtime session (null if unavailable → fallback path)
  let realtimeSession = null;
  // Per-turn promise resolver — resolves when the AI finishes one response
  let turnResolve = null;

  // ── Load agent data from Supabase ────────────────────────────
  try {
    const db = getSupabase();

    if (agentId) {
      const { data: agent } = await db
        .from("voice_agents")
        .select("*")
        .eq("id", agentId)
        .eq("organization_id", orgId)
        .single();
      agentRow = agent;
    }

    if (!agentRow && orgId) {
      const { data: org } = await db
        .from("organizations")
        .select("active_voice_agent_id")
        .eq("id", orgId)
        .single();
      if (org?.active_voice_agent_id) {
        const { data: agent } = await db
          .from("voice_agents")
          .select("*")
          .eq("id", org.active_voice_agent_id)
          .single();
        agentRow = agent;
      }
    }

    if (agentRow) {
      const [faqRes, chunkRes] = await Promise.allSettled([
        db
          .from("faqs")
          .select("question,answer")
          .eq("voice_agent_id", agentRow.id)
          .limit(50),
        db
          .from("knowledge_chunks")
          .select("content")
          .eq("voice_agent_id", agentRow.id)
          .limit(20),
      ]);
      faqs = faqRes.status === "fulfilled" ? faqRes.value.data || [] : [];
      chunks = chunkRes.status === "fulfilled" ? chunkRes.value.data || [] : [];
    }

    systemPrompt = buildSystemPrompt(agentRow || {}, faqs, chunks);
    messages.push({ role: "system", content: systemPrompt });
  } catch (err) {
    console.error("[CRelay WS] Failed to load agent:", err.message);
    messages.push({
      role: "system",
      content: "You are an AI receptionist. Be helpful and concise.",
    });
    systemPrompt = messages[0].content;
  }

  // ── Open Realtime session immediately (warm-up before first turn) ─
  // Fires in background so call setup isn't delayed.
  // By the time the caller speaks their first sentence, the connection is ready.
  createRealtimeSession({
    systemPrompt,
    // Called for each streaming token — forward directly to Twilio
    onText: (token) => {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(JSON.stringify({ type: "text", token, last: false }));
      }
    },
    // Called when the AI turn is fully complete
    onDone: (fullText) => {
      messages.push({ role: "assistant", content: fullText });
      transcript.push({ speaker: "Agent", text: fullText });

      // Send the "last" signal to Twilio so it starts speaking
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "text", token: "", last: true }));
      }

      // Handle transfer action
      if (
        fullText.includes('"action":"transfer"') &&
        agentRow?.escalation_phone
      ) {
        ws.send(
          JSON.stringify({
            type: "redirect",
            redirectCallTo: {
              number: agentRow.escalation_phone,
              greeting: "Please hold while I transfer your call.",
            },
          }),
        );
      }

      // Resolve the per-turn awaiter so the prompt handler can return
      if (turnResolve) {
        turnResolve(fullText);
        turnResolve = null;
      }
    },
    onError: (err) => {
      console.warn("[CRelay] Realtime session error:", err.message);
      // If a turn is in progress, resolve it with empty text so we can fall back
      if (turnResolve) {
        turnResolve(null);
        turnResolve = null;
      }
      realtimeSession = null; // triggers fallback on next turn
    },
  }).then((session) => {
    realtimeSession = session;
    if (session) {
      console.log(
        `[CRelay] Realtime session ready for callSid=${callSid || "pending"}`,
      );
    } else {
      console.log(
        `[CRelay] Using fallback (standard GPT streaming) for callSid=${callSid || "pending"}`,
      );
    }
  });

  // ── WebSocket message handler ────────────────────────────────
  ws.on("message", async (rawMsg) => {
    let msg;
    try {
      msg = JSON.parse(rawMsg.toString());
    } catch {
      return;
    }

    const { type } = msg;

    // ── 'setup' ─────────────────────────────────────────────────
    if (type === "setup") {
      callSid = msg.callSid || callSid;
      callerPhone = msg.from || callerPhone;
      activeSessions.set(callSid, {
        orgId,
        agentId: agentRow?.id,
        messages,
        startTime,
        transcript,
        callerPhone,
      });
      console.log(
        `[CRelay WS] Setup: callSid=${callSid} org=${orgId} realtime=${!!realtimeSession}`,
      );
      return;
    }

    // ── 'prompt' — caller finished speaking ─────────────────────
    if (type === "prompt") {
      const callerText = (msg.voicePrompt || "").trim();
      if (!callerText) return;

      transcript.push({ speaker: "Caller", text: callerText });
      messages.push({ role: "user", content: callerText });

      // Extract caller name if mentioned
      if (callerName === "Unknown Caller") {
        const m = callerText.match(
          /(?:my name is|i(?:'m| am)) ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i,
        );
        if (m) callerName = m[1];
      }

      // ── PATH A: OpenAI Realtime API ─────────────────────────
      if (realtimeSession) {
        try {
          await new Promise((resolve) => {
            // Set a 5-second safety timeout — if Realtime stalls, fall back
            const safetyTimer = setTimeout(() => {
              console.warn("[CRelay] Realtime turn timeout — falling back");
              resolve(null);
            }, 5000);

            turnResolve = (result) => {
              clearTimeout(safetyTimer);
              resolve(result);
            };

            realtimeSession.send(callerText);
          }).then((result) => {
            if (result !== null) return; // success — onDone already handled everything
            // null means timeout or error — fall back immediately
            realtimeSession = null;
            return fallbackResponse(
              ws,
              messages,
              transcript,
              agentRow,
              callerText,
            );
          });
        } catch (err) {
          console.warn("[CRelay] Realtime send failed:", err.message);
          realtimeSession = null;
          await fallbackResponse(
            ws,
            messages,
            transcript,
            agentRow,
            callerText,
          );
        }
        return;
      }

      // ── PATH B: Fallback to standard streaming ──────────────
      await fallbackResponse(ws, messages, transcript, agentRow, callerText);
      return;
    }

    // ── 'interrupt' — caller interrupted the agent ──────────────
    if (type === "interrupt") {
      // Drop the last AI turn from memory — it was cut off
      if (
        messages.length > 1 &&
        messages[messages.length - 1].role === "assistant"
      ) {
        messages.pop();
        transcript.pop();
      }
      // Also signal the Realtime session to stop generating (cancel response)
      if (realtimeSession && realtimeSession.ws) {
        try {
          realtimeSession._send({ type: "response.cancel" });
        } catch (_) {}
      }
      // Resolve any pending turn awaiter
      if (turnResolve) {
        turnResolve(null);
        turnResolve = null;
      }
      return;
    }

    // ── 'end' — call ended ──────────────────────────────────────
    if (type === "end") {
      const duration = Math.round((Date.now() - startTime) / 1000);
      console.log(`[CRelay WS] Call ended: ${callSid} duration=${duration}s`);
      activeSessions.delete(callSid);
      if (realtimeSession) {
        realtimeSession.close();
        realtimeSession = null;
      }
      await saveCallRecord({
        orgId,
        agentRow,
        callSid,
        callerPhone,
        callerName,
        duration,
        transcript,
      });
      return;
    }
  });

  ws.on("close", async () => {
    if (realtimeSession) {
      realtimeSession.close();
      realtimeSession = null;
    }
    if (activeSessions.has(callSid)) {
      const session = activeSessions.get(callSid);
      activeSessions.delete(callSid);
      const duration = Math.round((Date.now() - session.startTime) / 1000);
      await saveCallRecord({
        orgId,
        agentRow,
        callSid,
        callerPhone: session.callerPhone,
        callerName,
        duration,
        transcript: session.transcript,
      });
    }
  });

  ws.on("error", (err) => {
    console.error("[CRelay WS] Socket error:", err.message);
  });
}

// ─────────────────────────────────────────────────────────────
// Fallback: standard GPT-4o-mini streaming (original behavior)
// Used when Realtime API is unavailable or times out.
// ─────────────────────────────────────────────────────────────
async function fallbackResponse(
  ws,
  messages,
  transcript,
  agentRow,
  callerText,
) {
  const fallbackText =
    "I'm sorry, I'm having some trouble right now. Please call back or leave a message.";
  try {
    let fullReply = "";

    await generateStreamingResponse(messages, (token) => {
      fullReply += token;
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "text", token, last: false }));
      }
    });

    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "text", token: "", last: true }));
    }

    messages.push({ role: "assistant", content: fullReply });
    transcript.push({ speaker: "Agent", text: fullReply });

    if (
      fullReply.includes('"action":"transfer"') &&
      agentRow?.escalation_phone
    ) {
      ws.send(
        JSON.stringify({
          type: "redirect",
          redirectCallTo: {
            number: agentRow.escalation_phone,
            greeting: "Please hold while I transfer your call.",
          },
        }),
      );
    }
  } catch (aiErr) {
    console.error("[CRelay WS] Fallback AI error:", aiErr.message);
    if (ws.readyState === 1) {
      ws.send(
        JSON.stringify({ type: "text", token: fallbackText, last: false }),
      );
      ws.send(JSON.stringify({ type: "text", token: "", last: true }));
    }
    transcript.push({ speaker: "Agent", text: fallbackText });
  }
}

// ─────────────────────────────────────────────────────────────
// Save completed call to Supabase
// ─────────────────────────────────────────────────────────────
async function saveCallRecord({
  orgId,
  agentRow,
  callSid,
  callerPhone,
  callerName,
  duration,
  transcript,
}) {
  if (!orgId) return;
  try {
    const db = getSupabase();

    if (callSid) {
      const { data: existing } = await db
        .from("call_records")
        .select("id")
        .eq("vapi_call_id", callSid)
        .maybeSingle();
      if (existing) return;
    }

    const { generateCallSummary } = require("./openai");
    const transcriptStr = transcript
      .map((m) => `${m.speaker}: ${m.text}`)
      .join("\n");

    let summary = "Call completed.";
    try {
      summary = await generateCallSummary(transcriptStr, "completed");
    } catch (_) {}

    const outcome = determineOutcome(transcript);

    let leadId = null;
    if (["Lead Captured", "Appointment Booked"].includes(outcome)) {
      const capturedData = extractCapturedData(transcript);
      // Dedup by phone
      const { data: existingLead } = await db
        .from("leads")
        .select("id")
        .eq("organization_id", orgId)
        .eq("phone", capturedData.phone || callerPhone || "")
        .limit(1)
        .maybeSingle();
      if (!existingLead) {
        const { data: lead } = await db
          .from("leads")
          .insert({
            organization_id: orgId,
            name: capturedData.name || callerName || "Unknown",
            phone: capturedData.phone || callerPhone || "",
            email: capturedData.email || "",
            reason: capturedData.reason || "",
            status: "new",
            source: "call",
            tags: [],
          })
          .select()
          .single();
        leadId = lead?.id || null;
      }
    }

    await db.from("call_records").insert({
      organization_id: orgId,
      voice_agent_id: agentRow?.id || null,
      caller_name: callerName || "Unknown Caller",
      caller_phone: callerPhone || "",
      duration: duration || 0,
      outcome,
      summary,
      transcript,
      lead_id: leadId,
      vapi_call_id: callSid || "",
      timestamp: new Date().toISOString(),
    });

    const mins = Math.max(1, Math.ceil(duration / 60));
    await db
      .rpc("increment_usage", {
        org_id: orgId,
        calls_inc: 1,
        minutes_inc: mins,
      })
      .catch(async () => {
        const { data: org } = await db
          .from("organizations")
          .select("usage_calls,usage_minutes")
          .eq("id", orgId)
          .single();
        if (org) {
          await db
            .from("organizations")
            .update({
              usage_calls: (org.usage_calls || 0) + 1,
              usage_minutes: (org.usage_minutes || 0) + mins,
            })
            .eq("id", orgId);
        }
      });

    console.log(
      `[CRelay] ✅ Saved call ${callSid} | ${outcome} | org=${orgId}`,
    );
  } catch (err) {
    console.error("[CRelay] Failed to save call record:", err.message);
  }
}

function determineOutcome(transcript) {
  const text = transcript
    .map((m) => m.text)
    .join(" ")
    .toLowerCase();
  if (text.includes("appointment") || text.includes("book"))
    return "Appointment Booked";
  if (
    text.includes("transfer") ||
    text.includes("speak to a human") ||
    text.includes("operator")
  )
    return "Escalated";
  if (text.includes("voicemail") || text.includes("leave a message"))
    return "Voicemail";
  if (
    text.includes("my name is") ||
    text.includes("my phone") ||
    text.includes("my email")
  )
    return "Lead Captured";
  return "FAQ Answered";
}

function extractCapturedData(transcript) {
  const fullText = transcript
    .filter((m) => m.speaker === "Caller")
    .map((m) => m.text)
    .join(" ");
  const agentTexts = transcript
    .filter((m) => m.speaker === "Agent")
    .map((m) => m.text);
  for (const t of agentTexts.reverse()) {
    const jsonMatch = t.match(/\{"captured"\s*:\s*(\{[^}]+\})\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch (_) {}
    }
  }
  return {
    name:
      fullText.match(
        /(?:my name is|i(?:'m| am)) ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i,
      )?.[1] || "",
    phone: fullText.match(/(\+?[\d\s\-().]{7,})/)?.[1] || "",
    email:
      fullText.match(
        /([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/,
      )?.[1] || "",
    reason: fullText.slice(0, 200),
  };
}

module.exports = { handleConversationRelayWS, activeSessions };
