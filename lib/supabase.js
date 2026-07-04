"use strict";

const { createClient } = require("@supabase/supabase-js");

let _client = null;
let _loggedStartup = false;

// IMPORTANT: agently-server, agently-ws-server, and various local .env files
// have historically used different names for the same Supabase service-role
// key (SUPABASE_SERVICE_KEY vs SUPABASE_SERVICE_ROLE_KEY vs SUPABASE_KEY).
// A production deploy that only sets one of these while this file only
// checked another is the single most likely reason live-call billing writes
// (OpenAI/ElevenLabs/Railway) silently fail while everything else looks
// fine: getSupabase() throws inside a try/catch deep in the WS runtime and
// the event is just dropped with a one-line console.warn.
// Accept every known variant so a naming mismatch can never be the reason
// this function throws.
function resolveServiceKey() {
  return (
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.SUPABASE_KEY ||
    ""
  ).trim();
}

function getSupabase() {
  if (_client) return _client;

  const url = (process.env.SUPABASE_URL || "").trim();
  const key = resolveServiceKey();

  if (!_loggedStartup) {
    _loggedStartup = true;
    console.log("[supabase-client] init", {
      hasUrl: Boolean(url),
      keySource: process.env.SUPABASE_SERVICE_KEY
        ? "SUPABASE_SERVICE_KEY"
        : process.env.SUPABASE_SERVICE_ROLE_KEY
          ? "SUPABASE_SERVICE_ROLE_KEY"
          : process.env.SUPABASE_SERVICE_ROLE
            ? "SUPABASE_SERVICE_ROLE"
            : process.env.SUPABASE_KEY
              ? "SUPABASE_KEY"
              : "MISSING",
      hasKey: Boolean(key),
    });
  }

  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and a Supabase service-role key (SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_ROLE / SUPABASE_KEY) are required.",
    );
  }

  _client = createClient(url, key, {
    auth: { persistSession: false },
  });

  return _client;
}

module.exports = { getSupabase };
