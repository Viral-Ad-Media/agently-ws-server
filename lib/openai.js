"use strict";

let _openai = null;

function getOpenAI() {
  if (_openai) return _openai;
  const { OpenAI } = require("openai");
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not configured.");
  _openai = new OpenAI({ apiKey: key, timeout: 25000, maxRetries: 2 });
  return _openai;
}

async function generateCallSummary(transcript, outcome) {
  const openai = getOpenAI();
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Summarize this customer service call transcript in 1-2 sentences. Be factual and concise.",
      },
      {
        role: "user",
        content: `Call outcome: ${outcome || "unknown"}\n\nTranscript:\n${transcript}`,
      },
    ],
    max_tokens: 120,
    temperature: 0.2,
  });

  return completion.choices[0]?.message?.content || "Call completed.";
}

async function generateStreamingResponse(messages, onToken) {
  const openai = getOpenAI();
  const stream = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    max_tokens: 220,
    temperature: 0.55,
    stream: true,
  });

  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content || "";
    if (token) onToken(token);
  }
}

module.exports = {
  generateCallSummary,
  generateStreamingResponse,
  getOpenAI,
};
