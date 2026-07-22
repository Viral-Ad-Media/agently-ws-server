/**
 * PATCH 02 — agently-ws-server/lib/billing-tracker.js   (NEW FILE)
 * SEVERITY: P0 — live-call billing has been dead in production.
 *
 * PROOF (Railway production log, 2026-07-21T12:54:41Z):
 *   error | [WS] Billing tracker not available (copy billing-tracker.js to lib/):
 *           Cannot find module './lib/billing-tracker'
 *   error | Require stack:
 *   error | - /app/ws-server.js
 *
 * ROOT CAUSE
 *   ws-server.js:518   require("./lib/billing-tracker")   <- hyphen
 *   file on disk       lib/billing_tracker.js             <- underscore
 *   One character. The tracker never starts, so per-number call cost is never
 *   polled, never written, never deducted from the tenant wallet.
 *
 * WHY A SHIM AND NOT A RENAME
 *   Renaming billing_tracker.js would break anything that already requires the
 *   underscore path. This file is additive: it re-exports the existing module
 *   under the name ws-server.js actually asks for. Nothing else changes.
 *   Zero risk to the running voice path.
 *
 * APPLY
 *   Drop this file at agently-ws-server/lib/billing-tracker.js and redeploy.
 *   Expected boot log after deploy:
 *     [billing-tracker] Starting per-number billing tracker (every 30s)...
 *   If you instead see "Skipping — Twilio credentials not set", the tracker is
 *   loading correctly but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are absent
 *   from the Railway environment. That is a separate (also billing-fatal) fix.
 */

"use strict";

const tracker = require("./billing_tracker");

if (!tracker || typeof tracker.start !== "function") {
  console.error(
    "[billing-tracker] lib/billing_tracker.js loaded but exports no start(). " +
      "Live-call billing will NOT run. Do not ignore this line.",
  );
}

module.exports = tracker;
