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

module.exports = { getOpenAI };
