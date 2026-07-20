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

function isOrgExempt(organizationId) {
  const orgId = String(organizationId || "").trim();
  if (!orgId) return false;
  return String(process.env.BILLING_CREDIT_EXEMPT_ORG_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(orgId);
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

async function getRuntimeCreditStatus({ organizationId, action = "voice_call" }) {
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

  if (isOrgExempt(orgId)) {
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
    const hasEnoughCredit = walletStatus === "active" && balanceUsd >= minimumRequiredUsd;
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
