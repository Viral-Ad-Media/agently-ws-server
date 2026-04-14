'use strict';

const { getOpenAI } = require('./openai-client');

async function generateFaqsFromWebsite(website) {
  // Delegate to scraper which has multi-strategy scraping
  const { scrapeAndSave, getDefaultFaqs } = require('./scraper');
  try {
    const result = await scrapeAndSave(null, null, website);
    return result.faqs;
  } catch (e) {
    console.warn('generateFaqsFromWebsite fallback:', e.message);
    return getDefaultFaqs();
  }
}

async function generateChatResponse(userMessage, history = [], systemPrompt = '', orgId = null, chatbotId = null) {
  const openai = getOpenAI();

  // Inject knowledge context if orgId + chatbotId provided
  let contextBlock = '';
  if (orgId && chatbotId) {
    try {
      const { getKnowledgeContext } = require('./scraper');
      const context = await getKnowledgeContext(orgId, chatbotId, userMessage);
      if (context) {
        contextBlock = `\n\nRELEVANT WEBSITE KNOWLEDGE:\n${context}`;
      }
    } catch (e) {
      // Non-fatal
    }
  }

  const fullSystemPrompt = (systemPrompt || 'You are a helpful AI assistant. Be concise and friendly.') + contextBlock;

  const messages = [
    { role: 'system', content: fullSystemPrompt },
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
      { role: 'system', content: 'Summarize this call transcript in 1-2 sentences. Be factual and concise.' },
      { role: 'user', content: `Outcome: ${outcome || 'unknown'}\n\n${transcript}` },
    ],
    max_tokens: 120,
    temperature: 0.2,
  });
  return completion.choices[0]?.message?.content || 'Call completed.';
}

module.exports = { generateFaqsFromWebsite, generateChatResponse, generateCallSummary };
