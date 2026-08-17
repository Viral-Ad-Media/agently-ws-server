"use strict";

/**
 * lib/billing-tracker.js  (hyphen)
 *
 * ws-server.js requires "./lib/billing-tracker" (hyphen); the implementation
 * lives in "./lib/billing_tracker.js" (underscore). This is the alias that
 * bridges the two spellings.
 *
 * History worth knowing before editing: two earlier attempts to fix this
 * mismatch were written INTO the underscore file, each overwriting the real
 * 330-line tracker with a shim that then tried to require the file it had
 * just destroyed. The implementation was recovered from commit 4f458b1.
 *
 * So: keep the implementation in billing_tracker.js. Keep this file a pure
 * re-export. Never write a resolver into the underscore file.
 */

module.exports = require("./billing_tracker");
