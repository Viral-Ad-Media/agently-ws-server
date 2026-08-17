"use strict";

/**
 * Webcall token verifier.
 *
 * Fast path: verify locally with Railway's JWT_SECRET when it matches the
 * Vercel backend.
 *
 * Drift-safe fallback: if JWT_SECRET is missing or does not match, ask the
 * canonical API (API_URL) to verify the purpose-scoped token it issued.
 * This prevents a healthy WS deployment from rejecting every fresh webcall
 * just because the two deployment environments drifted.
 */

const jwt = require("jsonwebtoken");
const fetch = require("node-fetch");

function localJwtSecret() {
  return String(process.env.JWT_SECRET || "").trim();
}

function normalizeApiBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function validClaims(decoded) {
  return Boolean(
    decoded &&
      decoded.purpose === "webcall" &&
      decoded.orgId &&
      decoded.agentId,
  );
}

function verifyLocally(token) {
  const secret = localJwtSecret();
  if (!secret || !token) return null;
  try {
    const decoded = jwt.verify(String(token).trim(), secret, {
      algorithms: ["HS256"],
    });
    return validClaims(decoded) ? decoded : null;
  } catch (_) {
    return null;
  }
}

async function verifyWithApi(token) {
  const apiBase = normalizeApiBase(process.env.API_URL);
  if (!apiBase || !token) return null;

  // The backend gates /verify-token on this shared secret so it cannot be
  // used as a public token oracle. Without it the fallback cannot run.
  const verifyKey = String(process.env.WEBCALL_VERIFY_SECRET || "").trim();
  if (!verifyKey) {
    console.warn(
      "[webcall-auth] WEBCALL_VERIFY_SECRET is not set; API verification fallback is disabled. Set a matching JWT_SECRET (preferred) or WEBCALL_VERIFY_SECRET.",
    );
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${apiBase}/api/webcall/verify-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webcall-verify-key": verifyKey,
      },
      body: JSON.stringify({ token: String(token).trim() }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(
        `[webcall-auth] API verification returned ${response.status}${
          response.status === 403
            ? " — WEBCALL_VERIFY_SECRET does not match the backend"
            : response.status === 503
              ? " — WEBCALL_VERIFY_SECRET is not set on the backend"
              : ""
        }`,
      );
      return null;
    }
    const data = await response.json().catch(() => null);
    return data?.valid && validClaims(data?.claims) ? data.claims : null;
  } catch (err) {
    console.warn(
      "[webcall-auth] API verification fallback failed:",
      err?.name === "AbortError" ? "timeout" : err?.message || err,
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Returns decoded webcall claims or null.
 * Never logs or exposes the JWT itself.
 */
async function verifyWebcallToken(token) {
  if (!token) return null;

  const local = verifyLocally(token);
  if (local) return local;

  // A missing/mismatched Railway JWT_SECRET used to make every fresh token
  // look "expired". The backend is the source of truth for tokens it issued,
  // so fall back to server-side verification before rejecting the session.
  return verifyWithApi(token);
}

module.exports = { verifyWebcallToken };
