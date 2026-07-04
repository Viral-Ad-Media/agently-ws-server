"use strict";

const PLACEHOLDER_PATTERNS = [
  /\(optional/i,
  /your-railway-app/i,
  /YOUR-DOMAIN/i,
  /placeholder/i,
  /example\.com/i,
];

function rawEnv(name) {
  return process.env[name] == null ? "" : String(process.env[name]);
}

function hasInlineGarbage(value) {
  return (
    /\s/.test(value) ||
    PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))
  );
}

function normalizeUrlEnv(
  name,
  { protocol, required = true, expectedExample } = {},
) {
  const original = rawEnv(name);
  const trimmed = original.trim().replace(/\/+$/, "");
  const errors = [];

  if (!trimmed) {
    if (required)
      errors.push(
        `${name} is required${expectedExample ? `; expected ${name}=${expectedExample}` : ""}.`,
      );
    return {
      name,
      value: "",
      valid: !required,
      errors,
      expectedExample: expectedExample || null,
    };
  }

  if (original !== original.trim())
    errors.push(`${name} has leading or trailing whitespace.`);
  if (hasInlineGarbage(trimmed)) {
    errors.push(`${name} contains spaces, comments, or placeholder text.`);
  }

  let parsed = null;
  try {
    parsed = new URL(trimmed);
  } catch (_) {
    errors.push(`${name} is not a valid URL.`);
  }

  if (parsed && protocol && parsed.protocol !== `${protocol}:`) {
    errors.push(`${name} must use ${protocol}://.`);
  }

  if (parsed && parsed.pathname && parsed.pathname !== "/") {
    // We allow pathless service roots only. Specific routes are added with new URL('/path', base).
    errors.push(`${name} should be a service root URL without a path.`);
  }

  return {
    name,
    value: trimmed,
    valid: errors.length === 0,
    errors,
    expectedExample: expectedExample || null,
  };
}

function requiredSecret(name) {
  const configured = Boolean(rawEnv(name).trim());
  return {
    name,
    configured,
    valid: configured,
    errors: configured ? [] : [`${name} is required.`],
  };
}

// If SUPABASE_URL is not directly set but SUPABASE_PROJECT_REF is, derive the
// canonical https://<ref>.supabase.co URL and inject it into the environment
// BEFORE anything validates or reads it. This is what keeps a Railway service
// that only carries the project ref (not the full URL) from failing config
// validation and disabling the scheduler + billing writes.
function ensureSupabaseUrlFromRef() {
  const existing = String(process.env.SUPABASE_URL || "").trim();
  if (existing) return existing;
  const ref = String(
    process.env.SUPABASE_PROJECT_REF ||
      process.env.SUPABASE_PROJECT_ID ||
      process.env.PROJECT_REF ||
      "",
  ).trim();
  if (!ref) return "";
  const derived = `https://${ref}.supabase.co`;
  process.env.SUPABASE_URL = derived;
  console.log("[config] SUPABASE_URL derived from project ref:", derived);
  return derived;
}

function validateRuntimeConfig() {
  ensureSupabaseUrlFromRef();
  const apiUrl = normalizeUrlEnv("API_URL", {
    protocol: "https",
    expectedExample: "https://agently-server-v1.vercel.app",
  });
  const twilioWsUrl = normalizeUrlEnv("TWILIO_WS_URL", {
    protocol: "wss",
    expectedExample: "wss://agently-ws-server-production.up.railway.app",
  });
  const supabaseUrl = normalizeUrlEnv("SUPABASE_URL", { protocol: "https" });
  const required = [
    requiredSecret("TWILIO_ACCOUNT_SID"),
    requiredSecret("TWILIO_AUTH_TOKEN"),
    requiredSecret("OPENAI_API_KEY"),
  ];

  const checks = [apiUrl, twilioWsUrl, supabaseUrl, ...required];
  const configErrors = checks.flatMap((check) => check.errors || []);
  const valid = configErrors.length === 0;

  return {
    valid,
    configErrors,
    apiUrl: apiUrl.value,
    apiUrlValid: apiUrl.valid,
    twilioWsUrl: twilioWsUrl.value,
    twilioWsUrlValid: twilioWsUrl.valid,
    supabaseUrl: supabaseUrl.value,
    supabaseUrlValid: supabaseUrl.valid,
    twilioAccountSidConfigured: required[0].configured,
    twilioAuthTokenConfigured: required[1].configured,
    openaiApiKeyConfigured: required[2].configured,
    schedulerEnabled:
      String(
        process.env.SCHEDULER_ENABLED ||
          process.env.ENABLE_LEAD_SCHEDULER ||
          "true",
      ).toLowerCase() !== "false",
  };
}

let lastLoggedSignature = "";
function logRuntimeConfigValidation(validation = validateRuntimeConfig()) {
  const signature = JSON.stringify({
    valid: validation.valid,
    errors: validation.configErrors,
    apiUrl: validation.apiUrl,
    twilioWsUrl: validation.twilioWsUrl,
  });
  if (signature === lastLoggedSignature) return validation;
  lastLoggedSignature = signature;

  if (validation.apiUrl)
    console.log("[config] API_URL normalized=", validation.apiUrl);
  if (validation.twilioWsUrl)
    console.log("[config] TWILIO_WS_URL normalized=", validation.twilioWsUrl);

  if (!validation.valid) {
    for (const err of validation.configErrors) {
      const name = err.split(" ")[0] || "config";
      if (
        /placeholder|spaces|comments|your-railway-app|YOUR-DOMAIN|optional/i.test(
          err,
        )
      ) {
        console.error("[config] invalid URL placeholder detected", err);
      } else if (name === "API_URL") {
        console.error("[config] invalid API_URL:", err);
        console.error(
          "[config] expected API_URL=https://agently-server-v1.vercel.app",
        );
      } else if (name === "TWILIO_WS_URL") {
        console.error("[config] invalid TWILIO_WS_URL:", err);
        console.error(
          "[config] expected TWILIO_WS_URL=wss://agently-ws-server-production.up.railway.app",
        );
      } else {
        console.error("[config] invalid runtime config:", err);
      }
    }
  } else {
    console.log("[scheduler] config ok");
  }
  return validation;
}

function requireValidRuntimeConfig() {
  const validation = logRuntimeConfigValidation(validateRuntimeConfig());
  if (!validation.valid) {
    const error = new Error(
      `Invalid runtime config: ${validation.configErrors.join(" ")}`,
    );
    error.code = "INVALID_RUNTIME_CONFIG";
    error.validation = validation;
    throw error;
  }
  return validation;
}

function buildUrl(base, pathname, params = {}) {
  const url = new URL(pathname, base);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function safeConfigForDebug() {
  const validation = validateRuntimeConfig();
  return {
    apiUrl: validation.apiUrl,
    apiUrlValid: validation.apiUrlValid,
    twilioWsUrl: validation.twilioWsUrl,
    twilioWsUrlValid: validation.twilioWsUrlValid,
    schedulerEnabled: validation.schedulerEnabled && validation.valid,
    rawSchedulerEnabled: validation.schedulerEnabled,
    supabaseUrlValid: validation.supabaseUrlValid,
    twilioAccountSidConfigured: validation.twilioAccountSidConfigured,
    twilioAuthTokenConfigured: validation.twilioAuthTokenConfigured,
    openaiApiKeyConfigured: validation.openaiApiKeyConfigured,
    configErrors: validation.configErrors,
  };
}

module.exports = {
  normalizeUrlEnv,
  validateRuntimeConfig,
  logRuntimeConfigValidation,
  requireValidRuntimeConfig,
  safeConfigForDebug,
  buildUrl,
};
