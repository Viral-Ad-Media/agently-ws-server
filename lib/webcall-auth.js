"use strict";

/**
 * ============================================================
 * lib/webcall-auth.js
 * ============================================================
 * Verifies the short-lived webcall session token issued by
 * agently-server's POST /api/webcall/token.
 *
 * Uses the SAME JWT_SECRET as agently-server (lib/auth.js). This
 * is a shared-secret verification pattern: agently-server signs,
 * this service only ever verifies. It never signs webcall tokens
 * itself.
 *
 * Does not touch any other auth path in this service — additive,
 * isolated module.
 * ============================================================
 */

const jwt = require("jsonwebtoken");

function getJwtSecret() {
  const secret = (process.env.JWT_SECRET || "").trim();
  if (!secret) return "";
  return secret;
}

/**
 * Verifies a webcall session token.
 * Returns the decoded payload ({ orgId, agentId, userId, purpose, ... })
 * on success, or null on any failure (missing secret, expired,
 * malformed, wrong purpose).
 */
function verifyWebcallToken(token) {
  const secret = getJwtSecret();
  if (!secret || !token) return null;
  try {
    const decoded = jwt.verify(String(token).trim(), secret);
    if (!decoded || decoded.purpose !== "webcall") return null;
    if (!decoded.orgId || !decoded.agentId) return null;
    return decoded;
  } catch (_) {
    return null;
  }
}

module.exports = { verifyWebcallToken };
