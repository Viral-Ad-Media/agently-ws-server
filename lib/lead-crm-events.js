'use strict';

const CRM_STAGES = [
  'new',
  'contacted',
  'qualified',
  'appointment_set',
  'proposal_sent',
  'won',
  'lost',
];

function normalizePhone(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return raw;
  return hasPlus ? `+${digits}` : digits;
}

function normalizeEmail(value) {
  if (!value) return null;
  const email = String(value).trim().toLowerCase();
  return email || null;
}

function clampScore(score) {
  return Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
}

function temperatureFromScore(score) {
  if (score >= 80) return 'hot';
  if (score >= 50) return 'warm';
  if (score >= 25) return 'cold';
  return 'unqualified';
}

function buildLeadText(lead, recentActivities = []) {
  const parts = [];
  for (const key of ['name', 'email', 'phone', 'source', 'source_detail', 'ai_summary', 'ai_intent', 'next_action']) {
    if (lead && lead[key]) parts.push(String(lead[key]));
  }
  for (const activity of recentActivities || []) {
    if (activity.title) parts.push(String(activity.title));
    if (activity.body) parts.push(String(activity.body));
  }
  return parts.join(' ').toLowerCase();
}

function scoreLeadHeuristically(lead, recentActivities = []) {
  const text = buildLeadText(lead, recentActivities);
  let score = 45;
  const reasons = [];

  const add = (points, reason) => {
    score += points;
    reasons.push(reason);
  };
  const subtract = (points, reason) => {
    score -= points;
    reasons.push(reason);
  };

  if (lead?.phone) add(8, 'phone captured');
  if (lead?.email) add(5, 'email captured');
  if (lead?.appointment_at || lead?.crm_stage === 'appointment_set') add(22, 'appointment requested or set');
  if (lead?.estimated_value_cents && Number(lead.estimated_value_cents) > 0) add(10, 'deal value attached');
  if (lead?.crm_stage === 'qualified') add(12, 'qualified stage');
  if (lead?.crm_stage === 'proposal_sent') add(14, 'proposal sent');
  if (lead?.crm_stage === 'won') add(55, 'won lead');
  if (lead?.crm_stage === 'lost') subtract(40, 'lost lead');

  if (/urgent|today|now|asap|emergency|immediately|same day|book|booking|appointment|schedule|available|availability/.test(text)) {
    add(18, 'urgent or booking intent');
  }
  if (/price|pricing|cost|quote|estimate|how much|budget|invoice|payment/.test(text)) {
    add(10, 'pricing or quote intent');
  }
  if (/call me|callback|call back|speak to someone|human|representative|agent/.test(text)) {
    add(8, 'requested human or callback');
  }
  if (/not interested|stop|wrong number|spam|unsubscribe|too expensive|competitor|already booked/.test(text)) {
    subtract(25, 'negative or disqualifying signal');
  }
  if (lead?.needs_human_review) subtract(3, 'needs human review');

  const finalScore = clampScore(score);
  const summary = lead?.ai_summary || buildDefaultSummary(lead, recentActivities, finalScore, reasons);
  const nextAction = lead?.next_action || recommendNextAction(lead, finalScore, text);

  return {
    ai_score: finalScore,
    lead_temperature: temperatureFromScore(finalScore),
    ai_summary: summary,
    ai_intent: detectIntent(text, lead),
    ai_confidence: reasons.length >= 3 ? 0.82 : 0.64,
    next_action: nextAction,
    reasons,
  };
}

function detectIntent(text, lead) {
  if (lead?.crm_stage === 'won') return 'won_customer';
  if (lead?.crm_stage === 'lost') return 'lost_or_disqualified';
  if (/appointment|schedule|book|booking|available|availability/.test(text)) return 'appointment_request';
  if (/price|pricing|cost|quote|estimate|how much/.test(text)) return 'pricing_or_quote';
  if (/urgent|emergency|today|asap|same day|immediately/.test(text)) return 'urgent_service_need';
  if (/call me|callback|call back|human|representative/.test(text)) return 'human_callback_request';
  return 'general_interest';
}

function recommendNextAction(lead, score, text) {
  if (lead?.crm_stage === 'won') return 'Send confirmation and onboarding details.';
  if (lead?.crm_stage === 'lost') return 'Review lost reason and add to nurture only if appropriate.';
  if (/appointment|schedule|book|booking/.test(text)) return 'Confirm appointment time and assign owner.';
  if (/quote|estimate|price|pricing|cost/.test(text)) return 'Send quote or pricing follow-up.';
  if (score >= 80) return 'Call this lead as soon as possible.';
  if (score >= 50) return 'Follow up today and qualify the need.';
  if (score >= 25) return 'Send a light follow-up and monitor response.';
  return 'Mark unqualified unless new information arrives.';
}

function buildDefaultSummary(lead, recentActivities, score, reasons) {
  const source = lead?.source || lead?.source_detail || 'unknown source';
  const stage = lead?.crm_stage || 'new';
  const reasonText = reasons && reasons.length ? reasons.slice(0, 3).join(', ') : 'limited activity data';
  return `Lead from ${source}. Current stage is ${stage}. AI score is ${score}/100 based on ${reasonText}.`;
}

async function findExistingLead(supabase, { workspaceId, organizationId, phone, email }) {
  let query = supabase.from('leads').select('*').limit(1);

  if (workspaceId) query = query.eq('workspace_id', workspaceId);
  if (organizationId) query = query.eq('organization_id', organizationId);

  const filters = [];
  if (phone) filters.push(`phone.eq.${phone}`);
  if (email) filters.push(`email.eq.${email}`);
  if (!filters.length) return null;

  const { data, error } = await query.or(filters.join(','));
  if (error) throw error;
  return data && data.length ? data[0] : null;
}

async function upsertLeadFromContact(supabase, input) {
  const phone = normalizePhone(input.phone || input.to || input.from);
  const email = normalizeEmail(input.email);
  const existing = await findExistingLead(supabase, {
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    phone,
    email,
  });

  if (existing) {
    const patch = {
      last_activity_at: new Date().toISOString(),
    };
    if (!existing.name && input.name) patch.name = input.name;
    if (!existing.phone && phone) patch.phone = phone;
    if (!existing.email && email) patch.email = email;
    if (!existing.source_detail && input.sourceDetail) patch.source_detail = input.sourceDetail;
    if (!existing.source && input.source) patch.source = input.source;

    const { data, error } = await supabase.from('leads').update(patch).eq('id', existing.id).select('*').single();
    if (error) throw error;
    return data;
  }

  const payload = {
    workspace_id: input.workspaceId || null,
    organization_id: input.organizationId || null,
    name: input.name || input.displayName || null,
    phone,
    email,
    source: input.source || 'crm',
    source_detail: input.sourceDetail || null,
    crm_stage: input.crmStage || 'new',
    lead_temperature: 'warm',
    ai_score: 50,
    last_activity_at: new Date().toISOString(),
    crm_metadata: input.metadata || {},
  };

  const { data, error } = await supabase.from('leads').insert(payload).select('*').single();
  if (error) throw error;
  return data;
}

async function recordLeadActivity(supabase, activity) {
  const payload = {
    lead_id: activity.leadId,
    workspace_id: activity.workspaceId || null,
    organization_id: activity.organizationId || null,
    activity_type: activity.activityType || 'note',
    title: activity.title || 'Lead activity',
    body: activity.body || null,
    channel: activity.channel || null,
    direction: activity.direction || null,
    provider: activity.provider || null,
    provider_event_id: activity.providerEventId || null,
    call_id: activity.callId || null,
    chatbot_id: activity.chatbotId || null,
    voice_agent_id: activity.voiceAgentId || null,
    created_by: activity.createdBy || null,
    metadata: activity.metadata || {},
    occurred_at: activity.occurredAt || new Date().toISOString(),
  };

  const { data, error } = await supabase.from('lead_activities').insert(payload).select('*').single();
  if (error) throw error;
  return data;
}

async function attachCallToLead(supabase, input) {
  const lead = input.leadId
    ? { id: input.leadId }
    : await upsertLeadFromContact(supabase, {
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        name: input.name,
        phone: input.customerPhone || input.from || input.to,
        email: input.email,
        source: input.direction === 'outbound' ? 'outbound_call' : 'inbound_call',
        sourceDetail: input.provider || 'voice_call',
        metadata: input.leadMetadata || {},
      });

  const title = input.direction === 'outbound' ? 'Outbound call completed' : 'Inbound call captured';
  const bodyParts = [];
  if (input.summary) bodyParts.push(input.summary);
  if (input.transcript) bodyParts.push(`Transcript: ${input.transcript}`);
  if (input.durationSeconds != null) bodyParts.push(`Duration: ${input.durationSeconds}s`);

  return recordLeadActivity(supabase, {
    leadId: lead.id,
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    activityType: 'call',
    title,
    body: bodyParts.join('\n\n') || null,
    channel: 'voice',
    direction: input.direction || 'inbound',
    provider: input.provider || 'twilio',
    providerEventId: input.providerEventId || input.callSid || null,
    callId: input.callId || null,
    voiceAgentId: input.voiceAgentId || null,
    metadata: {
      call_sid: input.callSid || null,
      status: input.status || null,
      duration_seconds: input.durationSeconds || null,
      recording_url: input.recordingUrl || null,
      disposition: input.disposition || null,
    },
    occurredAt: input.occurredAt,
  });
}

async function attachChatToLead(supabase, input) {
  const lead = input.leadId
    ? { id: input.leadId }
    : await upsertLeadFromContact(supabase, {
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        name: input.name,
        phone: input.phone,
        email: input.email,
        source: 'chatbot',
        sourceDetail: input.chatbotId || 'website_chat',
        metadata: input.leadMetadata || {},
      });

  return recordLeadActivity(supabase, {
    leadId: lead.id,
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    activityType: 'chat',
    title: 'Chatbot conversation captured',
    body: input.summary || input.transcript || null,
    channel: 'chat',
    direction: 'inbound',
    provider: 'agently_chatbot',
    providerEventId: input.conversationId || null,
    chatbotId: input.chatbotId || null,
    metadata: {
      conversation_id: input.conversationId || null,
      transcript: input.transcript || null,
      url: input.url || null,
    },
    occurredAt: input.occurredAt,
  });
}

module.exports = {
  CRM_STAGES,
  normalizePhone,
  normalizeEmail,
  scoreLeadHeuristically,
  temperatureFromScore,
  upsertLeadFromContact,
  recordLeadActivity,
  attachCallToLead,
  attachChatToLead,
};
