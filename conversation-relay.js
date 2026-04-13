"use strict";

const { getSupabase } = require("./supabase");
const { generateStreamingResponse } = require("./openai");
const { buildSystemPrompt } = require("./twilio");

const activeSessions = new Map();

async function handleConversationRelayWS(ws, req) {
  const params = new URL(req.url, "http://localhost").searchParams;
  const orgId = params.get("orgId") || "";
  const agentId = params.get("agentId") || "";
  let callSid = params.get("callSid") || "";
  let callerPhone = params.get("callerPhone") || "";
  let callerName = "Unknown Caller";
  let agentRow = null;
  let faqs = [];
  let chunks = [];
  let messages = [];
  let transcript = [];
  const startTime = Date.now();

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
    const systemPrompt = buildSystemPrompt(agentRow || {}, faqs, chunks);
    messages.push({ role: "system", content: systemPrompt });
  } catch (err) {
    console.error("[CRelay WS] load agent error:", err.message);
    messages.push({
      role: "system",
      content: "You are an AI receptionist. Be helpful and concise.",
    });
  }

  ws.on("message", async (rawMsg) => {
    let msg;
    try {
      msg = JSON.parse(rawMsg.toString());
    } catch {
      return;
    }
    const { type } = msg;

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
      return;
    }

    if (type === "prompt") {
      const callerText = msg.voicePrompt || "";
      if (!callerText.trim()) return;

      transcript.push({ speaker: "Caller", text: callerText });
      messages.push({ role: "user", content: callerText });

      if (callerName === "Unknown Caller") {
        const nameMatch = callerText.match(
          /(?:my name is|i(?:'m| am)) ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i,
        );
        if (nameMatch) callerName = nameMatch[1];
      }

      try {
        let fullReply = "";
        await generateStreamingResponse(messages, (token) => {
          fullReply += token;
          if (ws.readyState === 1)
            ws.send(JSON.stringify({ type: "text", token, last: false }));
        });
        if (ws.readyState === 1)
          ws.send(JSON.stringify({ type: "text", token: "", last: true }));

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
        console.error("[CRelay WS] AI error:", aiErr.message);
        const fallback =
          "I'm sorry, I'm having some trouble right now. Please call back or leave a message.";
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({ type: "text", token: fallback, last: false }),
          );
          ws.send(JSON.stringify({ type: "text", token: "", last: true }));
        }
        transcript.push({ speaker: "Agent", text: fallback });
      }
      return;
    }

    if (type === "interrupt") {
      if (
        messages.length > 1 &&
        messages[messages.length - 1].role === "assistant"
      ) {
        messages.pop();
        transcript.pop();
      }
      return;
    }

    if (type === "end") {
      const duration = Math.round((Date.now() - startTime) / 1000);
      activeSessions.delete(callSid);
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
    if (activeSessions.has(callSid)) {
      const session = activeSessions.get(callSid);
      activeSessions.delete(callSid);
      const duration = Math.round((Date.now() - session.startTime) / 1000);
      await saveCallRecord({
        orgId: session.orgId,
        agentRow,
        callSid,
        callerPhone: session.callerPhone,
        callerName,
        duration,
        transcript: session.transcript,
      });
    }
  });

  ws.on("error", (err) =>
    console.error("[CRelay WS] socket error:", err.message),
  );
}

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
    const { data: existing } = await db
      .from("call_records")
      .select("id")
      .eq("vapi_call_id", callSid)
      .maybeSingle();
    if (existing) return;

    const { generateCallSummary } = require("./openai");
    const transcriptStr = transcript
      .map((m) => `${m.speaker}: ${m.text}`)
      .join("\n");
    let summary = "Call completed.";
    try {
      summary = await generateCallSummary(transcriptStr, "completed");
    } catch {}

    const outcome = determineOutcome(transcript);
    let leadId = null;
    if (["Lead Captured", "Appointment Booked"].includes(outcome)) {
      const captured = extractCapturedData(transcript);
      const { data: lead } = await db
        .from("leads")
        .insert({
          organization_id: orgId,
          name: captured.name || callerName || "Unknown",
          phone: captured.phone || callerPhone || "",
          email: captured.email || "",
          reason: captured.reason || "",
          status: "new",
          source: "call",
        })
        .select()
        .single();
      leadId = lead?.id || null;
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
  } catch (err) {
    console.error("[CRelay] save call failed:", err.message);
  }
}

function determineOutcome(transcript) {
  const text = transcript
    .map((m) => m.text)
    .join(" ")
    .toLowerCase();
  if (text.includes("appointment") || text.includes("book"))
    return "Appointment Booked";
  if (text.includes("transfer") || text.includes("speak to a human"))
    return "Escalated";
  if (text.includes("voicemail")) return "Voicemail";
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
  const nameMatch = fullText.match(
    /(?:my name is|i(?:'m| am)) ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i,
  );
  const phoneMatch = fullText.match(/(\+?[\d\s\-().]{7,})/);
  const emailMatch = fullText.match(
    /([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/,
  );
  return {
    name: nameMatch?.[1] || "",
    phone: phoneMatch?.[1] || "",
    email: emailMatch?.[1] || "",
    reason: fullText.slice(0, 200),
  };
}

module.exports = { handleConversationRelayWS, activeSessions };
