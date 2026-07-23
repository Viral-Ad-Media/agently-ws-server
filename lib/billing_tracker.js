/**
 * agently-ws-server/lib/billing-tracker.js
 *
 * THIS MISSING FILE IS WHY YOUR CONTAINER WAS CRASH-LOOPING.
 *
 * ws-server.js requires "./lib/billing-tracker" (hyphen).
 * The real module on disk is  lib/billing_tracker.js  (underscore).
 * The tracker therefore never loaded — and the boot assertion added last round
 * correctly refused to serve calls without billing, so the process exited 1 and
 * Railway restarted it forever.
 *
 * The assertion was right. The missing file was the bug. This is that file.
 * It resolves the real module under either spelling so this cannot recur.
 */

"use strict";

let tracker = null;

for (const candidate of ["./billing_tracker", "./billingTracker"]) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(candidate);
    if (mod && typeof mod.start === "function") {
      tracker = mod;
      break;
    }
  } catch (err) {
    if (err && err.code !== "MODULE_NOT_FOUND") throw err;
  }
}

if (!tracker) {
  throw new Error(
    "No billing tracker implementation found. Expected lib/billing_tracker.js " +
      "to exist and export start(). Live-call billing cannot run without it.",
  );
}

module.exports = tracker;
