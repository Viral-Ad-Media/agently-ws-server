"use strict";

/**
 * ============================================================
 * lib/billing-tracker.js
 * ============================================================
 * Per-number Twilio billing tracker for Agently SaaS.
 *
 * PURPOSE:
 *   This module runs a background job every 30 seconds.
 *   For every voice_agent row in the DB that has a Twilio
 *   phone number (twilio_phone_number + twilio_phone_sid),
 *   it fetches the cost of all calls on that number for the
 *   current billing period from Twilio's Calls API, sums them
 *   with the monthly rental cost, and writes the total back
 *   to voice_agents.twilio_billing_usd.
 *
 * WHY THIS MATTERS:
 *   The master Twilio account is shared across all orgs.
 *   fetchMonthlyBilling() only returns account-wide totals —
 *   it cannot break costs down by number or by org.
 *   This tracker isolates costs PER NUMBER so the app owner
 *   can later use twilio_billing_usd to calculate what to
 *   charge each tenant for their subscription.
 *
 * WHAT IS TRACKED:
 *   1. Monthly rental cost (set once at purchase, rare to change)
 *   2. Inbound call costs  (GET /Calls.json?To={number})
 *   3. Outbound call costs (GET /Calls.json?From={number})
 *
 * WHAT IS NEVER EXPOSED:
 *   These columns are backend-only. No route returns them.
 *   No frontend component reads them. They are internal cost
 *   data for the app owner's billing calculations ONLY.
 *
 * HOW IT IS STARTED:
 *   Called once from api/index.js on server boot:
 *     require('./lib/billing-tracker').start();
 *
 * VERCEL SERVERLESS NOTE:
 *   Vercel serverless functions are stateless and short-lived.
 *   setInterval will only run while a function invocation is
 *   active. For true background polling on Vercel, you would
 *   use a Vercel Cron Job (vercel.json "crons" config) that
 *   hits a dedicated /api/internal/billing-sync route.
 *   This file provides both:
 *     - start()    → setInterval for local dev / always-on servers
 *     - runOnce()  → called by the Vercel Cron route
 * ============================================================
 */

const { getSupabase } = require("./supabase");

// ── Twilio API helper (inline — does NOT import from lib/twilio
//   to avoid circular deps; uses the same Basic-Auth pattern) ─────────
const TWILIO_BASE = "https://api.twilio.com/2010-04-01";

async function twilioGet(path, params = {}) {
  const sid = (process.env.TWILIO_ACCOUNT_SID || "").trim();
  const token = (process.env.TWILIO_AUTH_TOKEN || "").trim();
  if (!sid || !token) throw new Error("Twilio credentials not set");

  const qs = new URLSearchParams(params).toString();
  const url = `${TWILIO_BASE}/Accounts/${sid}${path}${qs ? "?" + qs : ""}`;
  const auth = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");

  const res = await fetch(url, { headers: { Authorization: auth } });
  if (res.status === 404) return null; // number may have been released
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Twilio ${res.status} on ${path}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Fetch the total call cost for a phone number in a date range ──────
// We query both To= and From= to get inbound + outbound costs.
// Twilio's Calls API can filter by specific number.
// Each call record has a `price` field (negative for Twilio's convention).
async function fetchCallCostForNumber(phoneNumber, startDate) {
  let totalCost = 0;
  const pageSize = "100";

  for (const direction of ["To", "From"]) {
    let nextPage = `/Calls.json`;
    let params = {
      [direction]: phoneNumber,
      StartTime: startDate, // YYYY-MM-DD — calls on/after this date
      Status: "completed", // only count completed calls (have a price)
      PageSize: pageSize,
    };

    // Page through all results (Twilio paginates at PageSize)
    let iterations = 0;
    while (nextPage && iterations < 20) {
      iterations++;
      let data;
      try {
        // If nextPage already has the full path from next_page_uri, use it
        data = await twilioGet(nextPage, iterations === 1 ? params : {});
      } catch (err) {
        console.warn(
          `[billing-tracker] Calls API error (${direction}=${phoneNumber}):`,
          err.message,
        );
        break;
      }
      if (!data) break;

      const calls = data.calls || [];
      for (const call of calls) {
        // Twilio returns price as a negative number (cost to you) or null for in-progress
        const price = parseFloat(call.price || "0");
        if (!isNaN(price)) {
          totalCost += Math.abs(price); // store as positive USD
        }
      }

      // Follow pagination
      nextPage = data.next_page_uri
        ? data.next_page_uri.replace(
            `/2010-04-01/Accounts/${(process.env.TWILIO_ACCOUNT_SID || "").trim()}`,
            "",
          )
        : null;
    }
  }

  return totalCost;
}

// ── Fetch the monthly rental cost for a phone number SID ─────────────
// IncomingPhoneNumbers (PN...) have a monthly rental.
// OutgoingCallerIds (CA...) and SMS_VERIFIED have NO rental — they're free to own.
async function fetchNumberRentalCost(phoneSid) {
  // Only IncomingPhoneNumbers (purchased Twilio numbers) have rental fees
  if (!phoneSid || !phoneSid.startsWith("PN")) return 0;
  try {
    // Rental cost is not directly in the IncomingPhoneNumbers API.
    // We estimate it via Usage Records category=phonenumbers for this month.
    // This is an account-level approximation; see fetchRentalCostFromPricing below.
    return 0;
  } catch {
    return 0;
  }
}

// ── Fetch phone number rental cost from Twilio Pricing API ───────────
// Endpoint: GET https://pricing.twilio.com/v1/PhoneNumbers/Countries/{isoCountry}
// This gives us the monthly price for the number type.
// Since this is expensive to call repeatedly, we only call it once and cache it.
async function fetchRentalCostFromPricing(phoneNumber) {
  try {
    // Use Usage Records with category=phone-numbers for this month to get rental cost
    const now = new Date();
    const firstOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const data = await twilioGet("/Usage/Records.json", {
      Category: "phonenumbers",
      StartDate: firstOfMonth,
    });
    if (!data || !data.usage_records || data.usage_records.length === 0)
      return 0;
    // Sum the price across all phone-number usage records this month
    const total = data.usage_records.reduce(
      (sum, r) => sum + Math.abs(parseFloat(r.price || "0")),
      0,
    );
    // Divide by number of phone numbers to get per-number estimate
    // (this is approximate — exact per-number rental is not available via Usage API)
    const numNumbers = parseInt(data.usage_records[0]?.count || "1", 10) || 1;
    return total / numNumbers;
  } catch {
    return 0;
  }
}

// ── Main billing sync: update one voice_agent row ────────────────────
async function syncAgentBilling(agent, db) {
  if (!agent.twilio_phone_number || !agent.twilio_phone_sid) return;

  // SMS_VERIFIED numbers have no Twilio billing — they're external numbers
  // that were verified via our Verify service. No rental, no Twilio call routing.
  if (agent.twilio_phone_sid.startsWith("SMS_VERIFIED_")) {
    // Mark as $0 cost but still record the period start
    const now = new Date();
    await db
      .from("voice_agents")
      .update({
        twilio_billing_usd: "0.0000",
        twilio_monthly_rental_usd: "0.0000",
        twilio_billing_period_start: now.toISOString().split("T")[0],
        twilio_billing_updated_at: now.toISOString(),
      })
      .eq("id", agent.id);
    return;
  }

  const now = new Date();

  // Determine billing period start
  let periodStart = agent.twilio_billing_period_start;
  if (!periodStart) {
    periodStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  }

  // Roll over billing period every 30 days
  const periodStartDate = new Date(periodStart);
  const daysSincePeriodStart = Math.floor(
    (now - periodStartDate) / (1000 * 60 * 60 * 24),
  );
  if (daysSincePeriodStart >= 30) {
    periodStart = now.toISOString().split("T")[0];
  }

  // Fetch call costs (works for BOTH IncomingPhoneNumbers and OutgoingCallerIds)
  // Verification calls to the number also show up in From/To filtering
  let callCost = 0;
  try {
    callCost = await fetchCallCostForNumber(
      agent.twilio_phone_number,
      periodStart,
    );
  } catch (err) {
    console.warn(
      `[billing-tracker] fetchCallCost failed for ${agent.twilio_phone_number}:`,
      err.message,
    );
    return;
  }

  // Rental cost: only IncomingPhoneNumbers (PN...) have monthly rental
  // OutgoingCallerIds (CA...) are free to own — no monthly rental
  let rentalCost = parseFloat(agent.twilio_monthly_rental_usd || "0");
  if (rentalCost === 0 && agent.twilio_phone_sid.startsWith("PN")) {
    rentalCost = await fetchRentalCostFromPricing(agent.twilio_phone_number);
  }

  const totalBilling = callCost + rentalCost;

  const { error } = await db
    .from("voice_agents")
    .update({
      twilio_billing_usd: totalBilling.toFixed(4),
      twilio_monthly_rental_usd: rentalCost.toFixed(4),
      twilio_billing_period_start: periodStart,
      twilio_billing_updated_at: now.toISOString(),
    })
    .eq("id", agent.id);

  if (error) {
    console.warn(
      `[billing-tracker] DB update failed for agent ${agent.id}:`,
      error.message,
    );
  } else {
    const src = agent.twilio_phone_sid.startsWith("PN")
      ? "purchased"
      : "imported";
    console.log(
      `[billing-tracker] ${agent.twilio_phone_number} (${src}): calls=$${callCost.toFixed(4)} ` +
        `rental=$${rentalCost.toFixed(4)} total=$${totalBilling.toFixed(4)}`,
    );
  }
}

// ── runOnce: sync billing for ALL voice agents with a number ──────────
// Called by the Vercel Cron route AND by the setInterval in start().
async function runOnce() {
  const db = getSupabase();

  const { data: agents, error } = await db
    .from("voice_agents")
    .select(
      "id, twilio_phone_number, twilio_phone_sid, twilio_billing_usd, twilio_monthly_rental_usd, twilio_billing_period_start, twilio_billing_updated_at",
    )
    .neq("twilio_phone_number", "")
    .not("twilio_phone_number", "is", null)
    .neq("twilio_phone_sid", "")
    .not("twilio_phone_sid", "is", null);

  if (error) {
    console.error("[billing-tracker] DB query failed:", error.message);
    return;
  }

  if (!agents || agents.length === 0) return;

  // Process agents sequentially to avoid hammering Twilio API rate limits
  // Twilio rate limit: ~100 reads/sec for most resources, but be conservative
  for (const agent of agents) {
    await syncAgentBilling(agent, db);
    // Small delay between agents to be a good API citizen
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ── start: kick off the interval loop (local dev / always-on servers) ─
let _interval = null;

function start() {
  if (_interval) return; // already running

  // Only run in environments where Twilio is configured
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.log("[billing-tracker] Skipping — Twilio credentials not set.");
    return;
  }

  console.log(
    "[billing-tracker] Starting per-number billing tracker (every 30s)...",
  );

  // Run immediately on start, then every 30 seconds
  void runOnce();
  _interval = setInterval(() => {
    void runOnce();
  }, 30 * 1000);

  // Prevent the interval from keeping the process alive unnecessarily
  if (_interval.unref) _interval.unref();
}

function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

module.exports = { start, stop, runOnce };
