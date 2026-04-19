'use strict';

const { getSupabase } = require('./supabase');
const { generateStreamingResponse, generateCallSummary } = require('./openai');
const { buildSystemPrompt } = require('./twilio');

const activeSessions = new Map();

function normalizeChunkRow(row) {
  return {
    content: String(row?.content || '').trim(),
    chatbotId: row?.chatbot_id || null,
    voiceAgentId: row?.voice_agent_id || null,
    sourceUrl: row?.source_url || '',
  };
}

function dedupeChunks(rows) {
  const seen = new Set();
  const output = [];
  for (const row of rows) {
    const normalized = normalizeChunkRow(row);
    if (!normalized.content) continue;
    const key = normalized.content.slice(0, 240);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function extractKeywords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 16);
}

function pickRelevantKnowledge(chunks, query, maxChunks = 4) {
  if (!Array.isArray(chunks) || chunks.length === 0) return '';
  const keywords = extractKeywords(query);
  if (keywords.length === 0) {
    return chunks.slice(0, Math.min(maxChunks, chunks.length)).map((chunk) => chunk.content).join('\n\n---\n\n');
  }

  const ranked = chunks
    .map((chunk) => {
      const haystack = chunk.content.toLowerCase();
      let score = 0;
      for (const keyword of keywords) {
        if (haystack.includes(keyword)) score += 1;
      }
      return { chunk, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxChunks)
    .map((entry) => entry.chunk.content);

  if (ranked.length === 0) return '';
  return ranked.join('\n\n---\n\n');
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
  const { data: org } = await db
    .from('organizations')
    .select('active_voice_agent_id')
    .eq('id', orgId)
    .single();
  if (!org?.active_voice_agent_id) return null;

  const { data: fallbackAgent } = await db
    .from('voice_agents')
    .select('*')
    .eq('id', org.active_voice_agent_id)
    .single();
  return fallbackAgent || null;
}

async function loadAgentContext(db, orgId, agentRow) {
  if (!agentRow) return { faqs: [], chunks: [] };

  const [faqRes, directChunkRes, linkedChatbotRes] = await Promise.allSettled([
    db.from('faqs').select('question,answer').eq('voice_agent_id', agentRow.id).limit(50),
    db.from('knowledge_chunks').select('content, chatbot_id, voice_agent_id, source_url').eq('voice_agent_id', agentRow.id).limit(80),
    db.from('chatbots').select('id').eq('organization_id', orgId).eq('voice_agent_id', agentRow.id),
  ]);

  const faqs = faqRes.status === 'fulfilled' ? faqRes.value.data || [] : [];
  const directChunks = directChunkRes.status === 'fulfilled' ? directChunkRes.value.data || [] : [];
  const linkedChatbotIds = linkedChatbotRes.status === 'fulfilled' ? (linkedChatbotRes.value.data || []).map((chatbot) => chatbot.id).filter(Boolean) : [];

  let linkedChunks = [];
  if (linkedChatbotIds.length > 0) {
    const { data } = await db
      .from('knowledge_chunks')
      .select('content, chatbot_id, voice_agent_id, source_url')
      .in('chatbot_id', linkedChatbotIds)
      .limit(80);
    linkedChunks = data || [];
  }

  return {
    faqs,
    chunks: dedupeChunks([...directChunks, ...linkedChunks]).slice(0, 80),
  };
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
      `This is an outbound call to an existing lead.`,
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
    messages.push({ role: 'system', content: `Campaign instructions for this call:\n${String(extraContext).trim()}` });
  }
  return messages;
}

function buildAiMessages(baseMessages, chunks, callerText) {
  const relevantKnowledge = pickRelevantKnowledge(chunks, callerText, 4);
  if (!relevantKnowledge) return baseMessages;

  const systemMessage = {
    role: 'system',
    content: `Use the following business knowledge only if it helps answer the caller accurately. If the knowledge is not relevant, ignore it.\n\n${relevantKnowledge}`,
  };

  if (baseMessages.length === 0) return [systemMessage];
  return [baseMessages[0], systemMessage, ...baseMessages.slice(1)];
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
  let chunks = [];
  let messages = [];
  let transcript = [];
  const startTime = Date.now();

  try {
    const db = getSupabase();
    agentRow = await loadAgentRow(db, orgId, agentId);
    const context = await loadAgentContext(db, orgId, agentRow);
    targetLead = await loadLeadRow(db, orgId, targetLeadId);
    if (targetLead?.name) callerName = targetLead.name;
    if (targetLead?.phone) callerPhone = targetLead.phone;
    chunks = context.chunks;
    messages = [{ role: 'system', content: buildSystemPrompt(agentRow || {}, context.faqs, chunks.slice(0, 12)) }];
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
      activeSessions.set(callSid, { orgId, agentId: agentRow?.id, messages, startTime, transcript, callerPhone, targetLeadId, scheduleId });
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
        let fullReply = '';
        const aiMessages = buildAiMessages(messages, chunks, callerText);
        await generateStreamingResponse(aiMessages, (token) => {
          fullReply += token;
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'text', token, last: false }));
          }
        });

        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'text', token: '', last: true }));
        }

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
        const fallback = "I'm sorry, I'm having some trouble right now. Please call back or leave a message.";
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
      const { data: existing } = await db.from('call_records').select('id').eq('vapi_call_id', callSid).maybeSingle();
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
      const leadUpdates = {
        updated_at: new Date().toISOString(),
        voice_agent_id: agentRow?.id || null,
      };
      if (capturedData.name) leadUpdates.name = capturedData.name;
      if (capturedData.phone) leadUpdates.phone = capturedData.phone;
      if (capturedData.email) leadUpdates.email = capturedData.email;
      if (capturedData.reason) leadUpdates.reason = capturedData.reason;
      if (['Lead Captured', 'Appointment Booked'].includes(outcome)) leadUpdates.status = 'contacted';
      await db.from('leads').update(leadUpdates).eq('id', leadId).eq('organization_id', orgId);
    } else if (['Lead Captured', 'Appointment Booked'].includes(outcome)) {
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
      vapi_call_id: callSid || '',
      timestamp: new Date().toISOString(),
    });

    const minutes = Math.max(1, Math.ceil(duration / 60));
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

function determineOutcome(transcript) {
  const text = transcript.map((message) => message.text).join(' ').toLowerCase();
  if (text.includes('appointment') || text.includes('book')) return 'Appointment Booked';
  if (text.includes('transfer') || text.includes('speak to a human') || text.includes('operator')) return 'Escalated';
  if (text.includes('voicemail') || text.includes('leave a message')) return 'Voicemail';
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
    reason: callerText.slice(0, 200),
  };
}

module.exports = { handleConversationRelayWS, activeSessions };
