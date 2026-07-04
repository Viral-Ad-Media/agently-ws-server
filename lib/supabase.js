"use strict";

const { createClient } = require("@supabase/supabase-js");

let _client = null;
let _loggedStartup = false;

/**
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS THE WAY IT IS
 * ---------------------------------------------------------------------------
 * The live-call billing bug was NOT in the metering code. It was here.
 *
 * Every billing write from the WS runtime goes through getSupabase(). On the
 * Railway `agently-ws-server` deployment the environment was incomplete /
 * inconsistently named vs the local .env:
 *
 *   - the service-role KEY was present, but under SUPABASE_SERVICE_ROLE_KEY
 *     (not SUPABASE_SERVICE_KEY, the only name the old code read)
 *   - SUPABASE_URL was NOT SET AT ALL on that service (hasUrl: false in logs)
 *
 * So getSupabase() threw, the throw was swallowed by a try/catch inside the
 * billing insert, and every OpenAI / ElevenLabs / Railway usage row was
 * silently dropped -- while Twilio rows (written by a DIFFERENT process,
 * agently-server, which had a complete env) kept appearing. That is the
 * entire "only Twilio, every time" mystery.
 *
 * This version removes the single point of failure completely:
 *   1. Accept the service-role key under any known name.
 *   2. If SUPABASE_URL is missing, DERIVE it from SUPABASE_PROJECT_REF
 *      (the URL is always https://<ref>.supabase.co -- deterministic and
 *      documented by Supabase). The project ref is present in the env even
 *      when SUPABASE_URL is not.
 *   3. Log exactly what was resolved and from where, once, at startup.
 *   4. Only throw if -- after all fallbacks -- we genuinely cannot build a
 *      client, and the error names every var that could fix it.
 * ---------------------------------------------------------------------------
 */

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v && String(v).trim()) return String(v).trim();
  }
  return "";
}

function resolveServiceKey() {
  return {
    key: firstNonEmpty(
      process.env.SUPABASE_SERVICE_KEY,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      process.env.SUPABASE_SERVICE_ROLE,
      process.env.SUPABASE_KEY,
    ),
    source: process.env.SUPABASE_SERVICE_KEY
      ? "SUPABASE_SERVICE_KEY"
      : process.env.SUPABASE_SERVICE_ROLE_KEY
        ? "SUPABASE_SERVICE_ROLE_KEY"
        : process.env.SUPABASE_SERVICE_ROLE
          ? "SUPABASE_SERVICE_ROLE"
          : process.env.SUPABASE_KEY
            ? "SUPABASE_KEY"
            : "MISSING",
  };
}

function resolveProjectRef() {
  const explicit = firstNonEmpty(
    process.env.SUPABASE_PROJECT_REF,
    process.env.SUPABASE_PROJECT_ID,
    process.env.PROJECT_REF,
  );
  if (explicit) return explicit;

  const urlish = firstNonEmpty(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_PROJECT_URL,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.VITE_SUPABASE_URL,
  );
  const m = urlish.match(/https?:\/\/([a-z0-9]+)\.supabase\.(?:co|in|net)/i);
  return m ? m[1] : "";
}

function resolveUrl() {
  const direct = firstNonEmpty(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_PROJECT_URL,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.VITE_SUPABASE_URL,
  );
  if (direct) return { url: direct, source: "explicit_url_env" };

  const ref = resolveProjectRef();
  if (ref) {
    return {
      url: `https://${ref}.supabase.co`,
      source: "derived_from_project_ref",
    };
  }

  return { url: "", source: "MISSING" };
}

function getSupabase() {
  if (_client) return _client;

  const { url, source: urlSource } = resolveUrl();
  const { key, source: keySource } = resolveServiceKey();

  if (!_loggedStartup) {
    _loggedStartup = true;
    console.log("[supabase-client] init", {
      hasUrl: Boolean(url),
      urlSource,
      keySource,
      hasKey: Boolean(key),
    });
  }

  if (!url || !key) {
    const missing = [];
    if (!url) {
      missing.push(
        "a Supabase URL (set SUPABASE_URL, or SUPABASE_PROJECT_REF so the URL can be derived as https://<ref>.supabase.co)",
      );
    }
    if (!key) {
      missing.push(
        "a Supabase service-role key (set any of SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_ROLE / SUPABASE_KEY)",
      );
    }
    throw new Error(
      `Supabase client cannot start. Missing: ${missing.join(" AND ")}.`,
    );
  }

  _client = createClient(url, key, {
    auth: { persistSession: false },
  });

  return _client;
}

module.exports = { getSupabase };
