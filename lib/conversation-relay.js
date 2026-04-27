'use strict';

const { getSupabase } = require('./supabase');
const { generateStreamingResponse, generateCallSummary } = require('./openai');
const { loadVoiceContext } = require('./context-builder');

const activeSessions = new Map();
const UNANSWERED_PHRASES = [
  "i don't know",
  "i'm not sure",
  "i cannot",
  "i can't",
  "i do not have that information",
  "someone can follow up",
  "take a message",
  "unable to answer",
];

function isUnanswered(text) {
  const lowered = String(text || '').toLowerCase();
  return UNANSWERED_PHRASES.some((phrase) => lowered.includes(phrase));
}

async function loadAgentRow(db, orgId, agentId) {
  if (agentId) {
    const { data: agent } = await db
      .from('voice_agents')
      .select('*')
      .eq('id', agentId)
      .eq('organization_id', orgId)
      .single();
    if (agent) return agent;
  }

  if (!orgId) return null;
  const { data: org } = await db.from('organizations').select('active_voice_agent_id').eq('id', orgId).single();
  if (!org?.active_voice_agent_id) return null;

  const { data: fallbackAgent } = await db
    .from('voice_agents')
    .select('*')
    .eq('id', org.active_voice_agent_id)
    .single();
  return fallbackAgent || null;
}

async function loadLeadRow(db, orgId, leadId) {
  if (!leadId || !orgId) return null;
  const { data: lead } = await db
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .eq('organization_id', orgId)
    .maybeSingle();
  return lead || null;
}

function buildLeadContextMessages(leadRow, extraContext) {
  const messages = [];
  if (leadRow) {
    const details = [
      'This call is connected to an existing lead.',
      `Lead name: ${leadRow.name || 'Unknown'}`,
      `Lead phone: ${leadRow.phone || ''}`,
      `Lead email: ${leadRow.email || ''}`,
      `Lead reason: ${leadRow.reason || ''}`,
      `Lead tags: ${Array.isArray(leadRow.tags) ? leadRow.tags.join(', ') : ''}`,
      `Lead assignment context: ${leadRow.assignment_context || ''}`,
    ].filter(Boolean);
    messages.push({ role: 'system', content: details.join('\n') });
  }
  if (extraContext && String(extraContext).trim()) {
    messages.push({ role: 'system', content: `Campaign instructions:\n${String(extraContext).trim()}` });
  }
  return messages;
}

async function rebuildSystemMessage({ db, orgId, agentRow, leadRow, callerText, extraContext }) {
  const context = await loadVoiceContext(db, orgId, agentRow, callerText, {
    assignmentContext: leadRow?.assignment_context || extraContext || '',
  });
  return {
    systemPrompt: context?.systemPrompt || 'You are an AI receptionist. Be concise and helpful.',
    context,
  };
}

async function handleConversationRelayWS(ws, req) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const orgId = params.get('orgId') || '';
  const agentId = params.get('agentId') || '';
  const targetLeadId = params.get('leadId') || '';
  const extraContext = params.get('extraContext') || '';
  const scheduleId = params.get('scheduleId') || '';
  let callSid = params.get('callSid') || '';
  let callerPhone = params.get('callerPhone') || '';
  let callerName = 'Unknown Caller';
  let agentRow = null;
  let targetLead = null;
  let messages = [];
  let transcript = [];
  const startTime = Date.now();

  try {
    const db = getSupabase();
    agentRow = await loadAgentRow(db, orgId, agentId);
    targetLead = await loadLeadRow(db, orgId, targetLeadId);
    if (targetLead?.name) callerName = targetLead.name;
    if (targetLead?.phone) callerPhone = targetLead.phone;
    const rebuilt = await rebuildSystemMessage({
      db,
      orgId,
      agentRow,
      leadRow: targetLead,
      callerText: targetLead?.reason || extraContext || 'general inquiry',
      extraContext,
    });
    messages = [{ role: 'system', content: rebuilt.systemPrompt }];
    messages.push(...buildLeadContextMessages(targetLead, extraContext));
  } catch (err) {
    console.error('[CRelay WS] load agent error:', err.message);
    messages = [{ role: 'system', content: 'You are an AI receptionist. Be helpful and concise.' }];
  }

  ws.on('message', async (rawMsg) => {
    let msg;
    try {
      msg = JSON.parse(rawMsg.toString());
    } catch {
      return;
    }

    const { type } = msg;

    if (type === 'setup') {
      callSid = msg.callSid || callSid;
      callerPhone = msg.from || callerPhone;
      activeSessions.set(callSid, {
        orgId,
        agentId: agentRow?.id,
        messages,
        startTime,
        transcript,
        callerPhone,
        targetLeadId,
        scheduleId,
      });
      return;
    }

    if (type === 'prompt') {
      const callerText = msg.voicePrompt || '';
      if (!callerText.trim()) return;

      transcript.push({ speaker: 'Caller', text: callerText });
      messages.push({ role: 'user', content: callerText });

      if (callerName === 'Unknown Caller') {
        const nameMatch = callerText.match(/(?:my name is|i(?:'m| am)) ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i);
        if (nameMatch) callerName = nameMatch[1];
      }

      try {
        const db = getSupabase();
        const rebuilt = await rebuildSystemMessage({
          db,
          orgId,
          agentRow,
          leadRow: targetLead,
          callerText,
          extraContext,
        });
        if (messages.length === 0 || messages[0].role !== 'system') messages.unshift({ role: 'system', content: rebuilt.systemPrompt });
        else messages[0] = { role: 'system', content: rebuilt.systemPrompt };

        let fullReply = '';
        await generateStreamingResponse(messages, (token) => {
          fullReply += token;
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'text', token, last: false }));
        });

        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'text', token: '', last: true }));

        messages.push({ role: 'assistant', content: fullReply });
        transcript.push({ speaker: 'Agent', text: fullReply });

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
        const fallback = "I'm sorry, I'm having some trouble right now. Please leave a message and someone will follow up.";
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'text', token: fallback, last: false }));
          ws.send(JSON.stringify({ type: 'text', token: '', last: true }));
        }
        transcript.push({ speaker: 'Agent', text: fallback });
      }
      return;
    }

    if (type === 'interrupt') {
      if (messages.length > 1 && messages[messages.length - 1].role === 'assistant') {
        messages.pop();
        transcript.pop();
      }
      return;
    }

    if (type === 'end') {
      const duration = Math.round((Date.now() - startTime) / 1000);
      activeSessions.delete(callSid);
      await saveCallRecord({ orgId, agentRow, callSid, callerPhone, callerName, duration, transcript, targetLeadId });
    }
  });

  ws.on('close', async () => {
    if (!activeSessions.has(callSid)) return;
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
      targetLeadId: session.targetLeadId,
      transcript: session.transcript,
    });
  });

  ws.on('error', (err) => {
    console.error('[CRelay WS] socket error:', err.message);
  });
}

async function saveCallRecord({ orgId, agentRow, callSid, callerPhone, callerName, duration, transcript, targetLeadId = '' }) {
  if (!orgId) return;

  try {
    const db = getSupabase();
    if (callSid) {
      const { data: existing } = await db.from('call_records').select('id').eq('twilio_call_sid', callSid).maybeSingle();
      if (existing) return;
    }

    const transcriptStr = transcript.map((message) => `${message.speaker}: ${message.text}`).join('\n');
    let summary = 'Call completed.';
    try {
      summary = await generateCallSummary(transcriptStr, 'completed');
    } catch {}

    const outcome = determineOutcome(transcript);
    let leadId = targetLeadId || null;
    const capturedData = extractCapturedData(transcript);

    if (leadId) {
      const leadUpdates = { updated_at: new Date().toISOString(), voice_agent_id: agentRow?.id || null };
      if (capturedData.name) leadUpdates.name = capturedData.name;
      if (capturedData.phone) leadUpdates.phone = capturedData.phone;
      if (capturedData.email) leadUpdates.email = capturedData.email;
      if (capturedData.reason) leadUpdates.reason = capturedData.reason;
      if (['Lead Captured', 'Appointment Booked'].includes(outcome)) leadUpdates.status = 'contacted';
      await db.from('leads').update(leadUpdates).eq('id', leadId).eq('organization_id', orgId);
    } else if (['Lead Captured', 'Appointment Booked', 'Message Captured'].includes(outcome)) {
      const { data: lead } = await db
        .from('leads')
        .insert({
          organization_id: orgId,
          name: capturedData.name || callerName || 'Unknown',
          phone: capturedData.phone || callerPhone || '',
          email: capturedData.email || '',
          reason: capturedData.reason || '',
          status: 'new',
          source: 'call',
          voice_agent_id: agentRow?.id || null,
        })
        .select()
        .single();
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
      timestamp: new Date().toISOString(),
      provider: 'twilio',
      twilio_call_sid: callSid || '',
      direction: agentRow?.direction || 'inbound',
      status: 'completed',
      started_at: new Date(Date.now() - ((duration || 0) * 1000)).toISOString(),
      ended_at: new Date().toISOString(),
      end_reason: outcome,
      metadata: { agentName: agentRow?.name || '', unanswered: containsUnansweredResponse(transcript) },
    });

    if (containsUnansweredResponse(transcript)) {
      await db.from('unanswered_questions').insert({
        organization_id: orgId,
        chatbot_id: null,
        question: transcript.filter((entry) => entry.speaker === 'Caller').map((entry) => entry.text).join(' ').slice(0, 2000),
        bot_response: transcript.filter((entry) => entry.speaker === 'Agent').slice(-1)[0]?.text || summary,
      }).catch(() => {});
    }

    const minutes = Math.max(1, Math.ceil((duration || 0) / 60));
    await db.rpc('increment_usage', { org_id: orgId, calls_inc: 1, minutes_inc: minutes }).catch(async () => {
      const { data: org } = await db.from('organizations').select('usage_calls,usage_minutes').eq('id', orgId).single();
      if (org) {
        await db.from('organizations').update({
          usage_calls: (org.usage_calls || 0) + 1,
          usage_minutes: (org.usage_minutes || 0) + minutes,
        }).eq('id', orgId);
      }
    });

    if (agentRow?.webhook_url && leadId) {
      try {
        await fetch(agentRow.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'lead_captured',
            callSid,
            outcome,
            organizationId: orgId,
            agentId: agentRow?.id,
            lead: { id: leadId },
            timestamp: new Date().toISOString(),
          }),
        });
      } catch (webhookErr) {
        console.warn('[CRelay] Webhook fire failed:', webhookErr.message);
      }
    }
  } catch (err) {
    console.error('[CRelay] Failed to save call record:', err.message);
  }
}

function containsUnansweredResponse(transcript) {
  return transcript.some((entry) => entry.speaker === 'Agent' && isUnanswered(entry.text));
}

function determineOutcome(transcript) {
  const text = transcript.map((message) => message.text).join(' ').toLowerCase();
  if (text.includes('appointment') || text.includes('book')) return 'Appointment Booked';
  if (text.includes('transfer') || text.includes('speak to a human') || text.includes('operator')) return 'Escalated';
  if (text.includes('voicemail') || text.includes('leave a message')) return 'Voicemail';
  if (containsUnansweredResponse(transcript)) return 'Message Captured';
  if (text.includes('my name is') || text.includes('my phone') || text.includes('my email')) return 'Lead Captured';
  return 'FAQ Answered';
}

function extractCapturedData(transcript) {
  const callerText = transcript.filter((message) => message.speaker === 'Caller').map((message) => message.text).join(' ');
  const agentTexts = transcript.filter((message) => message.speaker === 'Agent').map((message) => message.text);
  for (const text of agentTexts.reverse()) {
    const match = text.match(/\{"captured"\s*:\s*(\{[^}]+\})\}/);
    if (!match) continue;
    try {
      return JSON.parse(match[1]);
    } catch {}
  }

  const nameMatch = callerText.match(/(?:my name is|i(?:'m| am)) ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i);
  const phoneMatch = callerText.match(/(\+?[\d\s\-().]{7,})/);
  const emailMatch = callerText.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
  return {
    name: nameMatch?.[1] || '',
    phone: phoneMatch?.[1] || '',
    email: emailMatch?.[1] || '',
    reason: callerText.slice(0, 300),
  };
}

module.exports = { handleConversationRelayWS, activeSessions };
