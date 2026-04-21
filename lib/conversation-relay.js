'use strict';

/**
 * conversation-relay.js
 *
 * WebSocket handler for Twilio ConversationRelay.
 *
 * Twilio opens a WebSocket to this server when a call hits <ConversationRelay>.
 * Messages flow:
 *   Twilio → server: { type: 'prompt', voicePrompt: '...' }  (caller speech)
 *   server → Twilio: { type: 'text', token: '...', last: true }  (AI reply chunks)
 *
 * This module exports a function that attaches the WS handler to an Express app.
 * Since Vercel serverless doesn't support long-lived WebSockets natively, we use
 * a lightweight in-process WebSocket server that Vercel's Node runtime CAN handle
 * within a single request for short calls. For production scale, upgrade to a
 * separate WebSocket service (Railway, Render, Fly.io).
 *
 * The handler:
 *  1. Receives the call setup event with metadata (orgId, agentId, callSid)
 *  2. Loads the agent config + FAQs + knowledge chunks from Supabase
 *  3. Opens an OpenAI streaming chat session
 *  4. Streams AI reply tokens back to Twilio as { type: 'text', token, last }
 *  5. On 'end' event: saves call record to Supabase
 */

const { getSupabase } = require('./supabase');
const { generateStreamingResponse } = require('./openai');
const { buildSystemPrompt, VOICE_MAP, LANGUAGE_MAP } = require('./twilio');

// Track active sessions: callSid → { orgId, agentId, messages, startTime, metadata }
const activeSessions = new Map();

/**
 * Called once per WebSocket upgrade.
 * ws    – the WebSocket object (from 'ws' package or express-ws)
 * req   – the HTTP request (contains query params set by our /api/twilio/voice-inbound handler)
 */
async function handleConversationRelayWS(ws, req) {
  const params   = new URL(req.url, 'http://localhost').searchParams;
  const orgId    = params.get('orgId')   || '';
  const agentId  = params.get('agentId') || '';
  let   callSid  = params.get('callSid') || '';

  let agentRow     = null;
  let faqs         = [];
  let chunks       = [];
  let systemPrompt = '';
  const messages   = []; // OpenAI message history
  const startTime  = Date.now();
  let transcript   = []; // { speaker, text }
  let callerPhone  = params.get('callerPhone') || '';
  let callerName   = 'Unknown Caller';

  // ── Load agent data ──────────────────────────────────────────
  try {
    const db = getSupabase();

    if (agentId) {
      const { data: agent } = await db
        .from('voice_agents')
        .select('*')
        .eq('id', agentId)
        .eq('organization_id', orgId)
        .single();
      agentRow = agent;
    }

    if (!agentRow && orgId) {
      // Fallback to active agent for org
      const { data: org } = await db
        .from('organizations')
        .select('active_voice_agent_id')
        .eq('id', orgId)
        .single();
      if (org?.active_voice_agent_id) {
        const { data: agent } = await db
          .from('voice_agents')
          .select('*')
          .eq('id', org.active_voice_agent_id)
          .single();
        agentRow = agent;
      }
    }

    if (agentRow) {
      const [faqRes, chunkRes] = await Promise.allSettled([
        db.from('faqs').select('question,answer').eq('voice_agent_id', agentRow.id).limit(50),
        db.from('knowledge_chunks').select('content').eq('voice_agent_id', agentRow.id).limit(20),
      ]);
      faqs   = faqRes.status   === 'fulfilled' ? (faqRes.value.data   || []) : [];
      chunks = chunkRes.status === 'fulfilled' ? (chunkRes.value.data || []) : [];
    }

    systemPrompt = buildSystemPrompt(agentRow || {}, faqs, chunks);
    messages.push({ role: 'system', content: systemPrompt });

  } catch (err) {
    console.error('[CRelay WS] Failed to load agent:', err.message);
    // Continue anyway with empty prompt so call doesn't fail
    messages.push({ role: 'system', content: 'You are an AI receptionist. Be helpful and concise.' });
  }

  // ── WebSocket message handler ────────────────────────────────
  ws.on('message', async (rawMsg) => {
    let msg;
    try { msg = JSON.parse(rawMsg.toString()); }
    catch { return; }

    const { type } = msg;

    // ── 'setup' – Twilio sends this once at start of call ──────
    if (type === 'setup') {
      callSid     = msg.callSid     || callSid;
      callerPhone = msg.from        || callerPhone;
      activeSessions.set(callSid, { orgId, agentId: agentRow?.id, messages, startTime, transcript, callerPhone });
      console.log(`[CRelay WS] Setup: callSid=${callSid} org=${orgId}`);
      return;
    }

    // ── 'prompt' – caller just finished speaking ────────────────
    if (type === 'prompt') {
      const callerText = msg.voicePrompt || '';
      if (!callerText.trim()) return;

      transcript.push({ speaker: 'Caller', text: callerText });
      messages.push({ role: 'user', content: callerText });

      // Detect name from first message
      if (callerName === 'Unknown Caller') {
        const nameMatch = callerText.match(/(?:my name is|i(?:'m| am)) ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i);
        if (nameMatch) callerName = nameMatch[1];
      }

      // Stream AI response token by token back to Twilio
      try {
        let fullReply = '';

        await generateStreamingResponse(
          messages,
          (token) => {
            fullReply += token;
            // Send token to Twilio (ConversationRelay expects these messages)
            if (ws.readyState === 1 /* OPEN */) {
              ws.send(JSON.stringify({ type: 'text', token, last: false }));
            }
          }
        );

        // Send the "last" signal so Twilio knows the turn is complete
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'text', token: '', last: true }));
        }

        messages.push({ role: 'assistant', content: fullReply });
        transcript.push({ speaker: 'Agent', text: fullReply });

        // Check for transfer action in reply
        if (fullReply.includes('"action":"transfer"') && agentRow?.escalation_phone) {
          ws.send(JSON.stringify({
            type: 'redirect',
            redirectCallTo: {
              number: agentRow.escalation_phone,
              greeting: 'Please hold while I transfer your call.',
            },
          }));
        }

      } catch (aiErr) {
        console.error('[CRelay WS] AI error:', aiErr.message);
        const fallback = "I'm sorry, I'm having some trouble right now. Please call back or leave a message.";
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'text', token: fallback, last: false }));
          ws.send(JSON.stringify({ type: 'text', token: '', last: true }));
        }
        transcript.push({ speaker: 'Agent', text: fallback });
      }
      return;
    }

    // ── 'interrupt' – caller interrupted the agent ──────────────
    if (type === 'interrupt') {
      // Drop the last AI message from history if it was interrupted
      if (messages.length > 1 && messages[messages.length - 1].role === 'assistant') {
        messages.pop();
        transcript.pop();
      }
      return;
    }

    // ── 'end' – call ended ──────────────────────────────────────
    if (type === 'end') {
      const duration = Math.round((Date.now() - startTime) / 1000);
      console.log(`[CRelay WS] Call ended: ${callSid} duration=${duration}s`);
      activeSessions.delete(callSid);
      await saveCallRecord({ orgId, agentRow, callSid, callerPhone, callerName, duration, transcript });
      return;
    }
  });

  ws.on('close', async () => {
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

  ws.on('error', (err) => {
    console.error('[CRelay WS] Socket error:', err.message);
  });
}

// ─────────────────────────────────────────────────────────────
// Save a completed call to Supabase
// ─────────────────────────────────────────────────────────────
async function saveCallRecord({ orgId, agentRow, callSid, callerPhone, callerName, duration, transcript }) {
  if (!orgId) return;

  try {
    const db = getSupabase();

    // Dedup
    if (callSid) {
      const { data: existing } = await db
        .from('call_records')
        .select('id')
        .eq('vapi_call_id', callSid)  // reusing this field for Twilio SID
        .maybeSingle();
      if (existing) return;
    }

    const { generateCallSummary } = require('./openai');
    const transcriptStr = transcript.map(m => `${m.speaker}: ${m.text}`).join('\n');

    let summary = 'Call completed.';
    try { summary = await generateCallSummary(transcriptStr, 'completed'); } catch {}

    const outcome = determineOutcome(transcript);

    // Try to capture lead
    let leadId = null;
    if (['Lead Captured', 'Appointment Booked'].includes(outcome)) {
      const capturedData = extractCapturedData(transcript);
      const { data: lead } = await db.from('leads').insert({
        organization_id: orgId,
        name: capturedData.name || callerName || 'Unknown',
        phone: capturedData.phone || callerPhone || '',
        email: capturedData.email || '',
        reason: capturedData.reason || '',
        status: 'new',
        source: 'call',
      }).select().single();
      leadId = lead?.id || null;
    }

    await db.from('call_records').insert({
      organization_id: orgId,
      voice_agent_id: agentRow?.id || null,
      caller_name: callerName || 'Unknown Caller',
      caller_phone: callerPhone || '',
      duration: duration || 0,
      outcome,
      summary,
      transcript,
      lead_id: leadId,
      vapi_call_id: callSid || '',
      timestamp: new Date().toISOString(),
    });

    const mins = Math.max(1, Math.ceil(duration / 60));
    await db.rpc('increment_usage', { org_id: orgId, calls_inc: 1, minutes_inc: mins })
      .catch(async () => {
        const { data: org } = await db.from('organizations').select('usage_calls,usage_minutes').eq('id', orgId).single();
        if (org) {
          await db.from('organizations').update({
            usage_calls: (org.usage_calls || 0) + 1,
            usage_minutes: (org.usage_minutes || 0) + mins,
          }).eq('id', orgId);
        }
      });

    console.log(`[CRelay] ✅ Saved call ${callSid} | ${outcome} | org=${orgId}`);
  } catch (err) {
    console.error('[CRelay] Failed to save call record:', err.message);
  }
}

function determineOutcome(transcript) {
  const text = transcript.map(m => m.text).join(' ').toLowerCase();
  if (text.includes('appointment') || text.includes('book')) return 'Appointment Booked';
  if (text.includes('transfer') || text.includes('speak to a human') || text.includes('operator')) return 'Escalated';
  if (text.includes('voicemail') || text.includes('leave a message')) return 'Voicemail';
  if (text.includes('my name is') || text.includes('my phone') || text.includes('my email')) return 'Lead Captured';
  return 'FAQ Answered';
}

function extractCapturedData(transcript) {
  const fullText = transcript.filter(m => m.speaker === 'Caller').map(m => m.text).join(' ');

  // Try to find JSON block in agent last reply
  const agentTexts = transcript.filter(m => m.speaker === 'Agent').map(m => m.text);
  for (const t of agentTexts.reverse()) {
    const jsonMatch = t.match(/\{"captured"\s*:\s*(\{[^}]+\})\}/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[1]); } catch {}
    }
  }

  // Fallback: regex extraction
  const nameMatch  = fullText.match(/(?:my name is|i(?:'m| am)) ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i);
  const phoneMatch = fullText.match(/(\+?[\d\s\-().]{7,})/);
  const emailMatch = fullText.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);

  return {
    name:  nameMatch?.[1]  || '',
    phone: phoneMatch?.[1] || '',
    email: emailMatch?.[1] || '',
    reason: fullText.slice(0, 200),
  };
}

module.exports = { handleConversationRelayWS, activeSessions };
