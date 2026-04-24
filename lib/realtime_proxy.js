'use strict';

/**
 * ============================================================
 * lib/realtime-proxy.js
 * ============================================================
 * OpenAI Realtime API proxy for the embedded chat widget.
 *
 * WHAT THIS SOLVES:
 *   The widget's voice mode previously did 3 sequential API calls:
 *     1. POST /transcribe (Whisper)     ~800ms
 *     2. POST /chat-stream (GPT)        ~1,500ms
 *     3. POST /speak (TTS tts-1)        ~600ms × N sentences
 *   Total per turn: ~3-5 seconds before user hears anything.
 *
 *   This proxy replaces all 3 with ONE persistent WebSocket to
 *   OpenAI Realtime API. The model handles VAD, STT, LLM, and
 *   TTS simultaneously. First audio back to browser: <500ms.
 *
 * ARCHITECTURE:
 *   Browser mic (PCM16 24kHz audio) → WebSocket to THIS SERVER
 *   THIS SERVER proxies ↔ wss://api.openai.com/v1/realtime
 *   THIS SERVER → WebSocket → Browser speaker (PCM16 24kHz audio)
 *
 *   The proxy sits between browser and OpenAI because:
 *   - Browsers can't connect directly to OpenAI (CORS + API key security)
 *   - We need to inject the system prompt (chatbot knowledge base)
 *   - We need to enforce language + lead capture rules
 *   - We want to log the session transcript to our DB
 *
 * BROWSER SIDE:
 *   - Browser gets mic audio via getUserMedia
 *   - Resamples to PCM16 24kHz (required by Realtime API)
 *   - Sends raw audio bytes via WebSocket
 *   - Receives audio bytes back, plays via AudioContext
 *   - NO Whisper, NO separate GPT call, NO separate TTS call
 *
 * HOW TO DEPLOY:
 *   This file is required by ws-server.js on Railway.
 *   The widget connects to:
 *   wss://agently-ws-server-production.up.railway.app/realtime?chatbotId=xxx
 * ============================================================
 */

const WebSocket  = require('ws');
const { getSupabase } = require('./supabase');

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

// ── Load chatbot config + knowledge from DB ───────────────────
async function loadChatbotContext(chatbotId) {
  if (!chatbotId) return null;
  try {
    const db = getSupabase();

    const { data: chatbot } = await db
      .from('chatbots')
      .select('id, organization_id, header_title, name, welcome_message, custom_prompt, faqs, chat_languages, voice_agent_id, collect_leads, chat_voice')
      .eq('id', chatbotId)
      .single();

    if (!chatbot) return null;

    // Load voice agent for tone + name
    let agentTone = 'Professional', agentName = chatbot.name || chatbot.header_title || 'Assistant';
    if (chatbot.voice_agent_id) {
      const { data: agent } = await db.from('voice_agents').select('name, tone').eq('id', chatbot.voice_agent_id).single();
      if (agent) { agentTone = agent.tone || 'Professional'; agentName = agent.name || agentName; }
    }

    // Load knowledge chunks (website scrape)
    const { data: chunks } = await db
      .from('knowledge_chunks')
      .select('content')
      .eq('chatbot_id', chatbotId)
      .order('chunk_index', { ascending: true })
      .limit(20);

    const faqs = Array.isArray(chatbot.faqs) ? chatbot.faqs : [];
    const faqText = faqs.length
      ? 'CURATED FAQs:\n' + faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')
      : '';

    const knowledgeText = (chunks || []).map(c => c.content).join('\n---\n').slice(0, 15000);

    const toneMap = {
      professional: 'Speak in a clear, courteous, professional manner.',
      friendly:     'Speak in a warm, conversational, friendly manner.',
      empathetic:   'Speak in an empathetic, patient, understanding manner.',
    };

    const allowedLanguages = Array.isArray(chatbot.chat_languages) && chatbot.chat_languages.length
      ? chatbot.chat_languages : ['en'];

    const langNames = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', ar: 'Arabic', zh: 'Chinese', ja: 'Japanese', ko: 'Korean' };
    const allowedLangNames = allowedLanguages.map(l => langNames[l] || l).join(' or ');

    // Map chatbot chat_voice to OpenAI Realtime API voice names
    const voiceMap = { alloy: 'alloy', echo: 'echo', fable: 'fable', onyx: 'onyx', nova: 'nova', shimmer: 'shimmer' };
    const realtimeVoice = voiceMap[chatbot.chat_voice] || 'alloy';

    const collectLeads = chatbot.collect_leads !== false;

    const leadRule = collectLeads
      ? `LEAD CAPTURE RULES (MANDATORY):
- After answering the visitor's first 1-2 questions, politely ask for their name and either a phone number or email address so you can follow up.
- Frame it as: "To serve you better, may I get your name and a way to contact you?"
- Once they provide their name AND contact info, repeat it back clearly to confirm accuracy: "Just to confirm, your name is [name] and I can reach you at [phone/email], is that correct?"
- Wait for their confirmation ("yes" or similar). Only after confirmation, say: "Thank you [name], I've noted your details."
- If they say no or decline, ask again gently after every 2-3 exchanges. Do not give up — politely re-ask. They must provide contact details at some point.
- If they provide incorrect or unclear info, ask them to repeat it slowly.`
      : '';

    const systemPrompt = [
      `You are ${agentName}, a voice AI assistant for ${chatbot.header_title || 'this business'}.`,
      toneMap[(agentTone || 'professional').toLowerCase()] || toneMap.professional,
      '',
      'CRITICAL LANGUAGE RULE: Respond ONLY in ' + allowedLangNames + '. Never switch languages, even if the visitor speaks in a different language.',
      '',
      'VOICE RULES:',
      '- Keep responses SHORT. 1-3 sentences maximum. This is voice, not text.',
      '- Speak naturally, as if talking to a person on the phone.',
      '- Never use bullet points, markdown, or lists. Speak in plain sentences only.',
      '- If you need to list things, say them conversationally: "We offer three services: web design, mobile apps, and consulting."',
      '',
      leadRule,
      '',
      faqText ? `${faqText}\n` : '',
      knowledgeText ? `KNOWLEDGE BASE (use this to answer questions about this business):\n${knowledgeText}` : '',
    ].filter(Boolean).join('\n');

    return { chatbot, systemPrompt, realtimeVoice, allowedLanguages, agentName, collectLeads };
  } catch (err) {
    console.error('[realtime-proxy] loadChatbotContext failed:', err.message);
    return null;
  }
}

// ── Main handler: one call per browser WebSocket upgrade ──────
async function handleRealtimeProxy(browserWs, req) {
  const params = new URL(req.url || '', 'http://localhost').searchParams;
  const chatbotId = params.get('chatbotId') || '';

  console.log(`[realtime-proxy] New session for chatbotId=${chatbotId}`);

  // ── 1. Load chatbot config from DB ─────────────────────────
  const ctx = await loadChatbotContext(chatbotId);
  if (!ctx) {
    console.warn('[realtime-proxy] Chatbot not found:', chatbotId);
    try { browserWs.send(JSON.stringify({ type: 'error', message: 'Chatbot not found.' })); } catch (_) {}
    browserWs.close(1008, 'Chatbot not found');
    return;
  }

  const { systemPrompt, realtimeVoice } = ctx;
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    try { browserWs.send(JSON.stringify({ type: 'error', message: 'Server configuration error.' })); } catch (_) {}
    browserWs.close(1011, 'Server error');
    return;
  }

  // ── 2. Open OpenAI Realtime WebSocket ──────────────────────
  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  let openaiReady = false;
  let pendingFromBrowser = []; // queued while OpenAI WS is connecting
  const sessionTranscript = [];

  // ── 3. Configure the Realtime session once connected ───────
  openaiWs.on('open', () => {
    openaiReady = true;
    console.log('[realtime-proxy] OpenAI Realtime connected');

    // Configure: audio mode, voice, system prompt, VAD
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        voice: realtimeVoice,
        instructions: systemPrompt,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 700, // shorter = snappier turn detection
        },
        temperature: 0.65,
        max_response_output_tokens: 200,
      },
    }));

    // Notify browser that session is ready
    try { browserWs.send(JSON.stringify({ type: 'session.ready', voice: realtimeVoice })); } catch (_) {}

    // Drain any audio queued while we were connecting
    pendingFromBrowser.forEach(msg => {
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(msg);
    });
    pendingFromBrowser = [];
  });

  // ── 4. Relay OpenAI → Browser ────────────────────────────────
  openaiWs.on('message', (rawMsg) => {
    // Relay ALL messages to the browser (audio deltas, transcripts, etc.)
    // The browser JavaScript handles each event type.
    try { browserWs.send(rawMsg); } catch (_) {}

    // Also parse for our own logging/lead-capture purposes
    let event;
    try { event = JSON.parse(rawMsg.toString()); } catch { return; }

    // Log transcript for debugging
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const text = event.transcript || '';
      if (text) sessionTranscript.push({ role: 'user', text });
    }
    if (event.type === 'response.audio_transcript.done') {
      const text = event.transcript || '';
      if (text) sessionTranscript.push({ role: 'assistant', text });
    }
  });

  openaiWs.on('error', (err) => {
    console.error('[realtime-proxy] OpenAI WS error:', err.message);
    try { browserWs.send(JSON.stringify({ type: 'error', message: 'AI connection error. Please try again.' })); } catch (_) {}
    try { browserWs.close(); } catch (_) {}
  });

  openaiWs.on('close', (code) => {
    console.log(`[realtime-proxy] OpenAI WS closed: ${code}`);
    try { browserWs.close(); } catch (_) {}
  });

  // ── 5. Relay Browser → OpenAI ────────────────────────────────
  browserWs.on('message', (data) => {
    // Browser sends either:
    //   - Raw binary audio bytes (Int16 PCM 24kHz)
    //   - JSON text events (e.g. { type: 'session.end' })
    if (!openaiReady) {
      pendingFromBrowser.push(data);
      return;
    }
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(data);
    }
  });

  browserWs.on('close', () => {
    console.log('[realtime-proxy] Browser disconnected');
    try { openaiWs.close(); } catch (_) {}
    // Log session transcript to console (could save to DB here if needed)
    if (sessionTranscript.length > 0) {
      console.log('[realtime-proxy] Session transcript:', sessionTranscript.slice(0, 4).map(m => `${m.role}: ${m.text.slice(0, 60)}`).join(' | '));
    }
  });

  browserWs.on('error', (err) => {
    console.error('[realtime-proxy] Browser WS error:', err.message);
    try { openaiWs.close(); } catch (_) {}
  });
}

module.exports = { handleRealtimeProxy };
