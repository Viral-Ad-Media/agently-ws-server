"use strict";

const { getSupabase } = require("./supabase");

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function minimumForAction(action = "voice_call") {
  const key = String(action || "voice_call").toLowerCase();
  if (key === "chatbot_message") {
    return safeNumber(process.env.BILLING_MIN_CHAT_CREDIT_USD, 0.05);
  }
  if (key === "knowledge_sync") {
    return safeNumber(process.env.BILLING_MIN_KNOWLEDGE_SYNC_CREDIT_USD, 0.25);
  }
  if (key === "voice_preview") {
    return safeNumber(process.env.BILLING_MIN_VOICE_PREVIEW_CREDIT_USD, 0.05);
  }
  return safeNumber(
    process.env.BILLING_MIN_ACTIVE_CREDIT_USD ||
      process.env.BILLING_MIN_CALL_CREDIT_USD ||
      process.env.BILLING_MIN_USAGE_CREDIT_USD,
    1,
  );
}

function isOrgExemptByEnv(organizationId) {
  const orgId = String(organizationId || "").trim();
  if (!orgId) return false;
  return String(process.env.BILLING_CREDIT_EXEMPT_ORG_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(orgId);
}

/*
 * PLATFORM ORGANIZATION EXEMPTION
 *
 * Mirrors agently-server/lib/billing-credit-enforcement.js. The WS server has
 * its own copy because it runs on Railway with an independent environment, and
 * the two must not be allowed to disagree about whether a call is billable —
 * a split decision here is exactly how the earlier wallet contamination
 * happened.
 *
 * Env allow-list first (no round-trip, works pre-migration), then the durable
 * organizations.is_platform_org / billing_exempt flag. Cached for 60s so a
 * long inbound call does not re-query on every credit checkpoint.
 */
const platformOrgCache = new Map();
const PLATFORM_CACHE_TTL_MS = 60_000;

async function isPlatformOrganization(orgId) {
  const hit = platformOrgCache.get(orgId);
  if (hit && Date.now() < hit.expiresAt) return hit.value;

  let value = false;
  try {
    const { data } = await getSupabase()
      .from("organizations")
      .select("is_platform_org,billing_exempt")
      .eq("id", orgId)
      .maybeSingle();
    value = Boolean(data?.is_platform_org || data?.billing_exempt);
  } catch (_) {
    value = false;
  }

  platformOrgCache.set(orgId, {
    value,
    expiresAt: Date.now() + PLATFORM_CACHE_TTL_MS,
  });
  return value;
}

async function isOrgExempt(organizationId) {
  const orgId = String(organizationId || "").trim();
  if (!orgId) return false;
  if (isOrgExemptByEnv(orgId)) return true;
  return isPlatformOrganization(orgId);
}

async function getOrCreateWallet(organizationId) {
  const orgId = String(organizationId || "").trim();
  if (!orgId) return null;
  const db = getSupabase();

  try {
    const { data, error } = await db.rpc("billing_admin_get_or_create_wallet", {
      p_organization_id: orgId,
      p_minimum_recharge_usd: safeNumber(
        process.env.BILLING_DEFAULT_MINIMUM_RECHARGE_USD,
        30,
      ),
    });
    if (!error && data) return Array.isArray(data) ? data[0] || null : data;
  } catch (_) {
    // Fallback below supports deployments where the helper RPC is not present.
  }

  const { data, error } = await db
    .from("billing_wallets")
    .select("id, organization_id, balance_usd, status")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getRuntimeCreditStatus({
  organizationId,
  action = "voice_call",
}) {
  const orgId = String(organizationId || "").trim();
  const minimumRequiredUsd = minimumForAction(action);

  if (!orgId) {
    return {
      ok: false,
      shouldBlock: true,
      decision: "block_unresolved_organization",
      organizationId: null,
      action,
      balanceUsd: 0,
      minimumRequiredUsd,
      walletStatus: "missing",
    };
  }

  if (await isOrgExempt(orgId)) {
    return {
      ok: true,
      shouldBlock: false,
      decision: "allow_exempt",
      organizationId: orgId,
      action,
      balanceUsd: null,
      minimumRequiredUsd,
      walletStatus: "exempt",
    };
  }

  try {
    const wallet = await getOrCreateWallet(orgId);
    const balanceUsd = safeNumber(wallet?.balance_usd, 0);
    const walletStatus = wallet?.status || (wallet ? "active" : "missing");
    const hasEnoughCredit =
      walletStatus === "active" && balanceUsd >= minimumRequiredUsd;
    return {
      ok: hasEnoughCredit,
      shouldBlock: !hasEnoughCredit,
      decision: hasEnoughCredit ? "allow" : "block_insufficient_credit",
      organizationId: orgId,
      action,
      balanceUsd,
      minimumRequiredUsd,
      walletStatus,
      walletId: wallet?.id || null,
    };
  } catch (err) {
    // Do not drop an active production call because of a transient wallet read
    // error. Entry-point API enforcement still blocks new usage.
    return {
      ok: true,
      shouldBlock: false,
      decision: "allow_credit_check_error",
      organizationId: orgId,
      action,
      balanceUsd: null,
      minimumRequiredUsd,
      walletStatus: "unknown",
      warning: err?.message || String(err),
    };
  }
}

function runtimeCreditStopMessage(status = {}) {
  const balance = safeNumber(status.balanceUsd, 0).toFixed(2);
  const required = safeNumber(status.minimumRequiredUsd, 1).toFixed(2);
  return `Usage credit is required to continue this call. Current balance is $${balance}; minimum required is $${required}.`;
}

module.exports = {
  getRuntimeCreditStatus,
  runtimeCreditStopMessage,
  minimumForAction,
};
