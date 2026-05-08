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

function numberEnv(name, fallback, min = null, max = null) {
  let value = Number(env(name, String(fallback)));
  if (!Number.isFinite(value)) value = Number(fallback);
  if (min !== null) value = Math.max(min, value);
  if (max !== null) value = Math.min(max, value);
  return value;
}

function clampNumber(value, fallback, min = null, max = null) {
  let n = Number(value);
  if (!Number.isFinite(n)) n = Number(fallback);
  if (min !== null) n = Math.max(min, n);
  if (max !== null) n = Math.min(max, n);
  return n;
}

function parseJsonMaybe(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (_) {
    return {};
  }
}

function elevenLabsConfig(overrides = {}) {
  const settings = parseJsonMaybe(overrides);
  const outputFormat = env(
    "ELEVENLABS_TWILIO_OUTPUT_FORMAT",
    TWILIO_OUTPUT_FORMAT,
  );
  return {
    apiKey: env("ELEVENLABS_API_KEY"),
    defaultModel: env("ELEVENLABS_DEFAULT_MODEL", "eleven_flash_v2_5"),
    fallbackModel: env("ELEVENLABS_FALLBACK_MODEL", "eleven_multilingual_v2"),
    twilioOutputFormat: String(
      settings.outputFormat ||
        settings.output_format ||
        outputFormat ||
        TWILIO_OUTPUT_FORMAT,
    ).trim(),
    stability: clampNumber(
      settings.stability,
      numberEnv("ELEVENLABS_STABILITY", 0.65, 0, 1),
      0,
      1,
    ),
    similarityBoost: clampNumber(
      settings.similarityBoost ?? settings.similarity_boost,
      numberEnv("ELEVENLABS_SIMILARITY_BOOST", 0.8, 0, 1),
      0,
      1,
    ),
    style: clampNumber(
      settings.style,
      numberEnv("ELEVENLABS_STYLE", 0.15, 0, 1),
      0,
      1,
    ),
    speed: clampNumber(
      settings.speed,
      numberEnv("ELEVENLABS_SPEED", 0.92, 0.7, 1.2),
      0.7,
      1.2,
    ),
    useSpeakerBoost:
      settings.useSpeakerBoost ??
      settings.use_speaker_boost ??
      boolEnv("ELEVENLABS_USE_SPEAKER_BOOST", true),
    optimizeStreamingLatency: clampNumber(
      settings.optimizeStreamingLatency ?? settings.optimize_streaming_latency,
      numberEnv("ELEVENLABS_OPTIMIZE_STREAMING_LATENCY", 3, 0, 4),
      0,
      4,
    ),
    maxCharsPerChunk: Math.max(
      60,
      Math.min(
        320,
        Number(
          settings.maxCharsPerChunk ||
            settings.max_chars_per_chunk ||
            env("ELEVENLABS_MAX_CHARS_PER_CHUNK", "240"),
        ),
      ),
    ),
  };
}

function voiceSettingsFromAgent(agent = {}) {
  return parseJsonMaybe(
    agent.voice_settings ||
      agent.voiceSettings ||
      agent.metadata?.voice_settings,
  );
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

function splitTextForSpeech(text, maxChars = 180) {
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
  const requestedVoiceId = env(
    "",
    agent.elevenlabs_voice_id || agent.voice_id || "",
  );
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
        metadata: {
          source: agent.elevenlabs_voice_id
            ? "voice_agents.elevenlabs_voice_id"
            : "voice_agents.voice_id",
        },
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

async function fetchElevenLabsTtsResponse({
  voiceId,
  text,
  modelId,
  outputFormat,
  settings,
} = {}) {
  const config = elevenLabsConfig(settings);
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
  if (!clean) return null;

  const selectedModel = String(modelId || config.defaultModel).trim();
  const selectedOutputFormat = String(
    outputFormat || config.twilioOutputFormat || TWILIO_OUTPUT_FORMAT,
  ).trim();
  const query = new URLSearchParams({ output_format: selectedOutputFormat });
  if (
    Number.isFinite(config.optimizeStreamingLatency) &&
    config.optimizeStreamingLatency > 0
  ) {
    query.set(
      "optimize_streaming_latency",
      String(config.optimizeStreamingLatency),
    );
  }
  const url = `${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(voiceId)}/stream?${query.toString()}`;
  const body = {
    text: clean,
    model_id: selectedModel,
    voice_settings: {
      stability: config.stability,
      similarity_boost: config.similarityBoost,
      style: config.style,
      speed: config.speed,
      use_speaker_boost: Boolean(config.useSpeakerBoost),
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

  return { res, config, selectedModel, selectedOutputFormat, clean };
}

async function synthesizeElevenLabsSpeech({
  voiceId,
  text,
  modelId,
  outputFormat,
  settings,
} = {}) {
  const response = await fetchElevenLabsTtsResponse({
    voiceId,
    text,
    modelId,
    outputFormat,
    settings,
  });
  if (!response) return Buffer.alloc(0);
  return Buffer.from(await response.res.arrayBuffer());
}

async function streamElevenLabsSpeech({
  voiceId,
  text,
  modelId,
  outputFormat,
  settings,
  onAudioChunk,
} = {}) {
  const response = await fetchElevenLabsTtsResponse({
    voiceId,
    text,
    modelId,
    outputFormat,
    settings,
  });
  if (!response)
    return {
      bytes: 0,
      chunks: 0,
      timeToFirstByteMs: null,
      modelId,
      outputFormat,
    };

  const startedAt = Date.now();
  let firstByteAt = null;
  let bytes = 0;
  let chunks = 0;

  if (response.res.body && typeof response.res.body.getReader === "function") {
    const reader = response.res.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;
      if (!firstByteAt) firstByteAt = Date.now();
      const buffer = Buffer.from(value);
      bytes += buffer.length;
      chunks += 1;
      if (typeof onAudioChunk === "function")
        await onAudioChunk(buffer, { chunks, bytes });
    }
  } else {
    const buffer = Buffer.from(await response.res.arrayBuffer());
    firstByteAt = Date.now();
    bytes = buffer.length;
    chunks = buffer.length ? 1 : 0;
    if (buffer.length && typeof onAudioChunk === "function")
      await onAudioChunk(buffer, { chunks, bytes });
  }

  return {
    bytes,
    chunks,
    timeToFirstByteMs: firstByteAt ? firstByteAt - startedAt : null,
    modelId: response.selectedModel,
    outputFormat: response.selectedOutputFormat,
  };
}

module.exports = {
  TWILIO_OUTPUT_FORMAT,
  cleanTextForSpeech,
  elevenLabsConfig,
  normalizeProvider,
  resolveElevenLabsVoiceForAgent,
  splitTextForSpeech,
  synthesizeElevenLabsSpeech,
  streamElevenLabsSpeech,
  voiceSettingsFromAgent,
};
