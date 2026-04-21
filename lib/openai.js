'use strict';

let _openai = null;

function getOpenAI() {
  if (_openai) return _openai;
  const { OpenAI } = require('openai');
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured.');
  _openai = new OpenAI({ apiKey: key, timeout: 25000, maxRetries: 2 });
  return _openai;
}

// Use native fetch (Node 18+) with a timeout helper
async function fetchWithTimeout(url, options, ms = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function generateFaqsFromWebsite(website) {
  const openai = getOpenAI();

  // Normalise URL
  let url = website.trim();
  if (!url.startsWith('http')) url = 'https://' + url;

  let siteContent = '';
  try {
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentlyBot/1.0)' },
    }, 10000);
    const html = await res.text();
    siteContent = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 5000);
  } catch (err) {
    console.warn('Website scrape failed:', err.message);
    siteContent = `Business website: ${url}`;
  }

  const prompt = `You are helping set up an AI phone receptionist.
Based on this website content, generate exactly 8 FAQ entries a customer might ask when calling.
Return ONLY valid JSON: {"faqs":[{"question":"...","answer":"..."}]}
No markdown. No explanation. Just the JSON object.

Website content:
${siteContent}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1200,
    temperature: 0.3,
    response_format: { type: 'json_object' },
  });

  let parsed;
  try {
    parsed = JSON.parse(completion.choices[0].message.content || '{}');
  } catch {
    return getDefaultFaqs();
  }

  const faqs = parsed.faqs || parsed.items || (Array.isArray(parsed) ? parsed : []);
  if (!Array.isArray(faqs) || faqs.length === 0) return getDefaultFaqs();

  return faqs.slice(0, 10).map((f, i) => ({
    id: `faq-${Date.now()}-${i}`,
    question: String(f.question || 'How can I help you?'),
    answer: String(f.answer || 'Please contact us for more information.'),
  }));
}

async function generateChatResponse(userMessage, history = [], systemPrompt = '') {
  const openai = getOpenAI();

  const messages = [
    { role: 'system', content: systemPrompt || 'You are a helpful AI assistant. Be concise and friendly.' },
    ...history.slice(-16).map(m => ({
      role: m.role === 'model' ? 'assistant' : 'user',
      content: m.text || m.content || '',
    })),
    { role: 'user', content: userMessage },
  ];

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    max_tokens: 250,
    temperature: 0.65,
  });

  return completion.choices[0]?.message?.content
    || "I'm here to help! Could you please clarify your question?";
}

async function generateCallSummary(transcript, outcome) {
  const openai = getOpenAI();

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Summarize this customer service call transcript in 1-2 sentences. Be factual and concise.' },
      { role: 'user', content: `Call outcome: ${outcome || 'unknown'}\n\nTranscript:\n${transcript}` },
    ],
    max_tokens: 120,
    temperature: 0.2,
  });

  return completion.choices[0]?.message?.content || 'Call completed.';
}

function getDefaultFaqs() {
  return [
    { id: 'faq-1', question: 'What are your operating hours?', answer: 'We are open Monday to Friday, 9 AM to 6 PM.' },
    { id: 'faq-2', question: 'How can I book an appointment?', answer: 'You can book by calling us or using our online booking system.' },
    { id: 'faq-3', question: 'Where are you located?', answer: 'Please visit our website for our full address and directions.' },
    { id: 'faq-4', question: 'What services do you offer?', answer: 'We offer a wide range of professional services. Please contact us for details.' },
    { id: 'faq-5', question: 'How much do your services cost?', answer: 'Pricing varies by service. We can provide a quote upon request.' },
    { id: 'faq-6', question: 'Do you offer emergency services?', answer: 'Yes, please call our main line for urgent assistance.' },
    { id: 'faq-7', question: 'How do I cancel or reschedule an appointment?', answer: 'Please call us at least 24 hours in advance to reschedule.' },
    { id: 'faq-8', question: 'What payment methods do you accept?', answer: 'We accept cash, credit cards, and online payments.' },
  ];
}

/**
 * Stream an OpenAI chat completion token by token.
 * onToken(token: string) is called for each text chunk.
 * Used by the ConversationRelay WebSocket handler.
 */
async function generateStreamingResponse(messages, onToken) {
  const openai = getOpenAI();

  const stream = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    max_tokens: 200,
    temperature: 0.55,
    stream: true,
  });

  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content || '';
    if (token) onToken(token);
  }
}

module.exports = { generateFaqsFromWebsite, generateChatResponse, generateCallSummary, generateStreamingResponse };
