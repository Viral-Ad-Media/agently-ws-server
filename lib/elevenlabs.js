"use strict";

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";
const TWILIO_OUTPUT_FORMAT = "ulaw_8000";

function env(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function boolEnv(name, fallback = true) {
  const value = env(name, fallback ? "true" : "false").toLowerCase();
  return value !== "false" && value !== "0" && value !== "no";
}

function elevenLabsConfig() {
  return {
    apiKey: env("ELEVENLABS_API_KEY"),
    defaultModel: env("ELEVENLABS_DEFAULT_MODEL", "eleven_flash_v2_5"),
    fallbackModel: env("ELEVENLABS_FALLBACK_MODEL", "eleven_multilingual_v2"),
    twilioOutputFormat: env(
      "ELEVENLABS_TWILIO_OUTPUT_FORMAT",
      TWILIO_OUTPUT_FORMAT,
    ),
    stability: Number(env("ELEVENLABS_STABILITY", "0.65")),
    similarityBoost: Number(env("ELEVENLABS_SIMILARITY_BOOST", "0.8")),
    style: Number(env("ELEVENLABS_STYLE", "0.2")),
    speed: Number(env("ELEVENLABS_SPEED", "1.0")),
    useSpeakerBoost: boolEnv("ELEVENLABS_USE_SPEAKER_BOOST", true),
    maxCharsPerChunk: Math.max(
      80,
      Number(env("ELEVENLABS_MAX_CHARS_PER_CHUNK", "260")),
    ),
  };
}

function normalizeProvider(value, fallback = "openai") {
  const provider = env("", value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  if (provider === "elevenlabs" || provider === "openai") return provider;
  return fallback;
}

function isMissingTableError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  return (
    code === "42P01" ||
    message.includes("does not exist") ||
    message.includes("schema cache") ||
    message.includes("voice_catalog")
  );
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9_ -]/gi, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function cleanTextForSpeech(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/[•*#_`>]+/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/([.!?]){2,}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTextForSpeech(text, maxChars = 320) {
  const clean = cleanTextForSpeech(text);
  if (!clean) return [];
  const sentences = clean.match(/[^.!?;:]+[.!?;:]?/g) || [clean];
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    if ((current + " " + s).trim().length <= maxChars) {
      current = (current + " " + s).trim();
      continue;
    }
    if (current) chunks.push(current);
    if (s.length <= maxChars) {
      current = s;
    } else {
      for (let i = 0; i < s.length; i += maxChars)
        chunks.push(s.slice(i, i + maxChars).trim());
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks.slice(0, 8);
}

async function resolveElevenLabsVoiceForAgent(db, agent = {}) {
  const requestedCatalogId = env("", agent.voice_catalog_id || "");
  const requestedVoiceId = env("", agent.voice_id || "");
  const voiceProfile = env("", agent.voice || agent.voiceProfile || "");
  const config = elevenLabsConfig();

  if (!config.apiKey) {
    return { ok: false, reason: "missing_api_key", voice: null };
  }

  if (db) {
    try {
      let query = db
        .from("voice_catalog")
        .select("id,provider,display_name,voice_id,model_id,is_active,metadata")
        .eq("provider", "elevenlabs")
        .eq("is_active", true);

      if (requestedCatalogId) {
        const byId = await query.eq("id", requestedCatalogId).maybeSingle();
        if (byId?.data?.voice_id)
          return {
            ok: true,
            source: "voice_catalog_id",
            voice: serializeVoice(byId.data),
          };
        if (byId?.error && !isMissingTableError(byId.error)) throw byId.error;
      }

      if (requestedVoiceId) {
        const byVoice = await db
          .from("voice_catalog")
          .select(
            "id,provider,display_name,voice_id,model_id,is_active,metadata",
          )
          .eq("provider", "elevenlabs")
          .eq("is_active", true)
          .eq("voice_id", requestedVoiceId)
          .maybeSingle();
        if (byVoice?.data?.voice_id)
          return {
            ok: true,
            source: "voice_id",
            voice: serializeVoice(byVoice.data),
          };
        if (byVoice?.error && !isMissingTableError(byVoice.error))
          throw byVoice.error;
      }

      if (voiceProfile) {
        const rows = await db
          .from("voice_catalog")
          .select(
            "id,provider,display_name,voice_id,model_id,is_active,metadata",
          )
          .eq("provider", "elevenlabs")
          .eq("is_active", true)
          .limit(200);
        if (rows?.error && !isMissingTableError(rows.error)) throw rows.error;
        const normalized = normalizeName(voiceProfile);
        const match = (rows?.data || []).find(
          (row) =>
            normalizeName(row.display_name) === normalized ||
            normalizeName(row.voice_id) === normalized,
        );
        if (match?.voice_id)
          return {
            ok: true,
            source: "voice_profile_match",
            voice: serializeVoice(match),
          };
      }
    } catch (err) {
      if (!isMissingTableError(err))
        console.warn(
          "[voice-provider] voice_catalog lookup warning:",
          err.message || String(err),
        );
    }
  }

  if (requestedVoiceId) {
    return {
      ok: true,
      source: "agent_voice_id",
      voice: {
        id: requestedVoiceId,
        provider: "elevenlabs",
        displayName: requestedVoiceId,
        voiceId: requestedVoiceId,
        modelId: config.defaultModel,
        metadata: { source: "voice_agents.voice_id" },
      },
    };
  }

  return { ok: false, reason: "missing_voice_id", voice: null };
}

function serializeVoice(row) {
  const metadata =
    row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return {
    id: row.id || row.voice_id,
    provider: "elevenlabs",
    displayName: row.display_name || metadata.name || row.voice_id,
    voiceId: row.voice_id,
    modelId:
      row.model_id || metadata.model_id || elevenLabsConfig().defaultModel,
    metadata,
  };
}

async function synthesizeElevenLabsSpeech({
  voiceId,
  text,
  modelId,
  outputFormat,
} = {}) {
  const config = elevenLabsConfig();
  if (!config.apiKey) {
    const err = new Error("ELEVENLABS_API_KEY is not configured.");
    err.code = "missing_api_key";
    throw err;
  }
  if (!voiceId) {
    const err = new Error("ElevenLabs voice_id is missing.");
    err.code = "missing_voice_id";
    throw err;
  }
  const clean = cleanTextForSpeech(text);
  if (!clean) return Buffer.alloc(0);

  const selectedModel = String(modelId || config.defaultModel).trim();
  const selectedOutputFormat = String(
    outputFormat || config.twilioOutputFormat || TWILIO_OUTPUT_FORMAT,
  ).trim();
  const url = `${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${encodeURIComponent(selectedOutputFormat)}`;
  const body = {
    text: clean,
    model_id: selectedModel,
    voice_settings: {
      stability: config.stability,
      similarity_boost: config.similarityBoost,
      style: config.style,
      speed: config.speed,
      use_speaker_boost: config.useSpeakerBoost,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": config.apiKey,
      "Content-Type": "application/json",
      Accept:
        selectedOutputFormat === TWILIO_OUTPUT_FORMAT
          ? "audio/basic"
          : "audio/mpeg",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    let parsed;
    try {
      parsed = JSON.parse(errorText);
    } catch {
      parsed = { message: errorText };
    }
    const err = new Error(
      parsed?.detail?.message ||
        parsed?.message ||
        `ElevenLabs TTS failed: ${res.status}`,
    );
    err.status = res.status;
    err.code = parsed?.detail?.status || parsed?.status || `http_${res.status}`;
    err.raw = parsed;
    throw err;
  }

  return Buffer.from(await res.arrayBuffer());
}

module.exports = {
  TWILIO_OUTPUT_FORMAT,
  cleanTextForSpeech,
  elevenLabsConfig,
  normalizeProvider,
  resolveElevenLabsVoiceForAgent,
  splitTextForSpeech,
  synthesizeElevenLabsSpeech,
};
