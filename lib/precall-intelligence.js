"use strict";

// Pre-call intelligence layer.
//
// Runs ONCE before an outbound call connects. It reads the tenant's raw call
// purpose / custom instructions / custom prompt (which may be grammatically
// broken or written in shorthand), understands the intent, and produces:
//   - openingLine:       a clean, grammatical, tone-aware first sentence the
//                        agent speaks, so it never blabs broken text on entry.
//   - interpretedIntent: a one-line plain-English restatement of what the call
//                        is actually for, injected into the system prompt.
//
// Results are cached per (purpose+tone+names) so a campaign that dials many
// leads with the same purpose only spends one generation — saving credits.

const { getOpenAI } = require("./openai-client");

const MODEL = process.env.PRECALL_INTELLIGENCE_MODEL || "gpt-4o-mini";
const ENABLED = String(
  process.env.PRECALL_INTELLIGENCE_ENABLED || "true",
).toLowerCase() !== "false";
const TIMEOUT_MS = Number(process.env.PRECALL_INTELLIGENCE_TIMEOUT_MS || 4000);
const CACHE_MAX = Number(process.env.PRECALL_INTELLIGENCE_CACHE_MAX || 500);

const _cache = new Map(); // key -> { openingLine, interpretedIntent }

function clean(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function cacheGet(key) {
  if (!_cache.has(key)) return null;
  const val = _cache.get(key);
  // refresh LRU order
  _cache.delete(key);
  _cache.set(key, val);
  return val;
}

function cacheSet(key, val) {
  _cache.set(key, val);
  if (_cache.size > CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

function toneGuidance(tone) {
  switch (clean(tone).toLowerCase()) {
    case "friendly":
      return "Warm, upbeat, and personable. Sound like a real person who is glad to talk. Contractions welcome.";
    case "empathetic":
      return "Gentle, caring, and unhurried. Acknowledge the person and sound genuinely considerate.";
    case "professional":
    default:
      return "Polished, clear, and courteous. Confident but not stiff, and never robotic.";
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("precall-intelligence timeout")), ms),
    ),
  ]);
}

// Returns { openingLine, interpretedIntent, source } or null on failure so the
// caller can fall back to its existing deterministic greeting builder.
async function buildPrecallOpening({
  direction = "outbound",
  tone = "Professional",
  agentName = "",
  businessName = "",
  recipientName = "",
  callPurpose = "",
  customInstructions = "",
  customPrompt = "",
  language = "English",
} = {}) {
  if (!ENABLED) return null;
  if (clean(direction).toLowerCase() !== "outbound") return null;

  const rawPurpose = clean(
    [callPurpose, customInstructions].filter(Boolean).join(". "),
  );
  // Nothing meaningful to interpret — let the deterministic builder handle it.
  if (!rawPurpose && !clean(customPrompt)) return null;

  const agent = clean(agentName) || "the assistant";
  const business = clean(businessName) || "the business";
  const recipient = clean(recipientName);
  const toneLabel = clean(tone) || "Professional";

  const key = JSON.stringify([
    MODEL,
    toneLabel.toLowerCase(),
    agent.toLowerCase(),
    business.toLowerCase(),
    recipient.toLowerCase(),
    rawPurpose.toLowerCase(),
    clean(customPrompt).slice(0, 400).toLowerCase(),
  ]);

  const cached = cacheGet(key);
  if (cached) return { ...cached, source: "cache" };

  const system = [
    "You prepare the very first thing an outbound phone agent will say, before the call connects.",
    "The operator's call purpose may be broken, shorthand, or ungrammatical. Understand the true intent and rewrite it into natural, correct human speech.",
    "You must return STRICT JSON only, no markdown, with exactly these keys:",
    '{ "interpreted_intent": string, "opening_line": string }',
    "",
    "Rules for opening_line:",
    `- Language: ${language}.`,
    `- Tone: ${toneLabel}. ${toneGuidance(toneLabel)}`,
    "- It is spoken aloud, so it must be one or two short, grammatically perfect sentences a person would actually say.",
    recipient
      ? `- Greet the recipient by first name naturally: ${recipient}.`
      : "- Do not invent a name. Use a simple 'Hello' or 'Hi there'.",
    agent !== "the assistant" && business !== "the business"
      ? `- Identify yourself once: you are ${agent} calling from ${business}.`
      : "- Identify yourself briefly and naturally.",
    "- State the reason for the call in one smooth, natural clause. NEVER paste the operator's raw words. NEVER produce phrases like 'I'm reaching out about welcome our new customer onboard'.",
    "- End the opening by checking if it's a good moment (e.g. 'Do you have a quick moment?').",
    "- No filler like 'um', no stage directions, no quotes around the text.",
    "",
    "Rules for interpreted_intent:",
    "- One plain sentence describing what this call is genuinely trying to achieve, so the agent stays on track. Not spoken to the recipient.",
  ].join("\n");

  const user = [
    `Business: ${business}`,
    `Agent name: ${agent}`,
    recipient ? `Recipient first name: ${recipient}` : "Recipient name: unknown",
    `Raw operator call purpose / instructions: ${rawPurpose || "(none)"}`,
    clean(customPrompt)
      ? `Additional custom prompt (reference only, may contain inbound sections to ignore): ${clean(customPrompt).slice(0, 800)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const openai = getOpenAI();
    const completion = await withTimeout(
      openai.chat.completions.create({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 220,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      TIMEOUT_MS,
    );

    const raw = completion?.choices?.[0]?.message?.content || "";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : {};
    }

    const openingLine = clean(parsed.opening_line);
    const interpretedIntent = clean(parsed.interpreted_intent);
    if (!openingLine) return null;

    const result = { openingLine, interpretedIntent };
    cacheSet(key, result);
    return { ...result, source: "model" };
  } catch (err) {
    console.warn("[precall-intelligence] fallback:", err.message);
    return null;
  }
}

module.exports = { buildPrecallOpening };
