"use strict";
// On outbound calls callerPhone is our business line, not the customer's.
function customerPhone(context = {}) {
  return String(context.direction || "").toLowerCase().startsWith("outbound")
    ? context.recipientPhone || ""
    : context.callerPhone || context.recipientPhone || "";
}
module.exports = { customerPhone };
