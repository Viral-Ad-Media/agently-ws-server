#!/usr/bin/env node
"use strict";

/**
 * verify-billing-path.js  (agently-ws-server)
 *
 * Proves the live-call billing write path works WITHOUT making a phone call.
 * It uses the SAME lib/supabase.js the runtime uses, then writes one
 * synthetic row for every provider a real call produces, then reads them
 * back and prints a pass/fail table.
 *
 * Run this on the SAME machine/service that runs ws-server.js (i.e. with the
 * same environment) — ideally via `railway run` or an SSH/one-off on the
 * deployed service — so it reads the exact env the live runtime sees.
 *
 *   node verify-billing-path.js [--org <organization_id>]
 *
 * If --org is omitted it uses a fixed diagnostic org id and writes
 * non-billable probe rows you can safely delete afterwards.
 *
 * Exit code 0 = all providers wrote and read back. Non-zero = something is
 * still wrong, and the reason is printed.
 */

try {
  require("dotenv").config();
} catch (_) {}

const { getSupabase } = require("./lib/supabase");
const crypto = require("crypto");

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const ORG_ID = arg("org", "747cf733-dd0d-42ba-87ab-bfea84590142");
const RUN_TAG = `verify:${new Date().toISOString()}:${crypto.randomBytes(4).toString("hex")}`;

// One synthetic row per provider a real call produces.
const PROBES = [
  {
    provider: "railway",
    service: "runtime",
    event_type: "websocket_runtime",
    unit: "seconds",
    quantity: 12,
  },
  {
    provider: "openai",
    service: "realtime",
    event_type: "openai_realtime_tokens",
    unit: "tokens",
    quantity: 1500,
  },
  {
    provider: "elevenlabs",
    service: "voice",
    event_type: "tts_or_agent_voice",
    unit: "characters",
    quantity: 240,
  },
  {
    provider: "twilio",
    service: "voice",
    event_type: "twilio_call",
    unit: "minutes",
    quantity: 1,
  },
];

async function main() {
  console.log("=".repeat(70));
  console.log("Agently WS billing path verifier");
  console.log("org:", ORG_ID);
  console.log("run tag:", RUN_TAG);
  console.log("=".repeat(70));

  let db;
  try {
    db = getSupabase();
  } catch (e) {
    console.error("\n❌ getSupabase() threw — the client cannot even start.");
    console.error("   reason:", e.message);
    console.error(
      "   Fix the SUPABASE env on THIS service and re-run. See README_FIX.md.\n",
    );
    process.exit(2);
  }

  const results = [];
  for (const p of PROBES) {
    const externalId = `${RUN_TAG}:${p.provider}`;
    const idempotencyKey = crypto
      .createHash("sha256")
      .update(
        [p.provider, p.service, p.event_type, externalId, ORG_ID].join("|"),
      )
      .digest("hex");

    const payload = {
      organization_id: ORG_ID,
      provider: p.provider,
      service: p.service,
      event_type: p.event_type,
      source: "verify_billing_path_probe",
      external_id: externalId,
      idempotency_key: idempotencyKey,
      unit: p.unit,
      quantity: p.quantity,
      billable: false, // probes are non-billable; safe to delete
      occurred_at: new Date().toISOString(),
      metadata: {
        note: "verify-billing-path.js probe; safe to delete",
        run_tag: RUN_TAG,
      },
    };

    try {
      const { error } = await db
        .from("billing_usage_events")
        .upsert(payload, { onConflict: "idempotency_key" })
        .select("id");
      if (error) throw error;
      results.push({ ...p, wrote: true, error: null });
    } catch (e) {
      results.push({ ...p, wrote: false, error: e.message || String(e) });
    }
  }

  // Read back what we just wrote.
  const { data: readback, error: readErr } = await db
    .from("billing_usage_events")
    .select("provider,service,event_type,unit,quantity")
    .eq("organization_id", ORG_ID)
    .like("external_id", `${RUN_TAG}%`);

  console.log("\nRESULTS");
  console.log("-".repeat(70));
  let allOk = true;
  for (const r of results) {
    const readOk =
      !readErr &&
      (readback || []).some(
        (row) => row.provider === r.provider && row.event_type === r.event_type,
      );
    const status = r.wrote && readOk ? "PASS" : "FAIL";
    if (status === "FAIL") allOk = false;
    console.log(
      `${status.padEnd(5)} ${r.provider.padEnd(11)} ${r.event_type.padEnd(26)} ${
        r.error ? "-> " + r.error : ""
      }`,
    );
  }
  console.log("-".repeat(70));

  if (readErr) {
    console.error("readback query error:", readErr.message);
  }

  if (allOk) {
    console.log(
      "\n✅ ALL PROVIDERS WROTE AND READ BACK. The live-call billing path works.",
    );
    console.log(
      "   Make a 10-20s real call next; the same rows will appear with billable=true.\n",
    );
    console.log(
      "   Cleanup probes anytime:\n   delete from public.billing_usage_events where source = 'verify_billing_path_probe';\n",
    );
    process.exit(0);
  } else {
    console.error(
      "\n❌ SOME PROVIDERS FAILED. The client started but writes/reads did not all succeed.",
    );
    console.error(
      "   Most likely: RLS on billing_usage_events, or the service-role key is actually an anon key.\n",
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("fatal:", e.message || e);
  process.exit(3);
});
