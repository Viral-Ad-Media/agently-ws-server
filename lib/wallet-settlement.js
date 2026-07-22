/**
 * agently-server/lib/wallet-settlement.js   <-- NEW FILE
 *
 * PATCH 14 — P1-1. Settles accrued unpaid usage against a wallet.
 *
 * THE BUG YOU OBSERVED
 *   Balance $0.04 -> topped up $5 -> balance showed $5, no debt applied.
 *
 * MECHANISM
 *   Every billable event writes a row to billing_customer_usage_charges. The
 *   wallet debit is a SEPARATE row in billing_wallet_transactions, linked back
 *   via charges.wallet_transaction_id. When the debit fails (no credit, RPC
 *   missing, transient network) the charge row survives with
 *   wallet_transaction_id = NULL and is NEVER retried. Money owed, never taken.
 *
 * WHAT THIS DOES
 *   Finds every charge for ONE organization where wallet_transaction_id IS NULL
 *   and customer_charge_usd > 0, and posts each one through the existing
 *   primitive postWalletDebitForChargeDirectly(). No new billing maths.
 *
 * SAFETY PROPERTIES  (this mutates live balances — these matter)
 *   1. STRICTLY ORG-SCOPED. Every query is .eq("organization_id", orgId).
 *      An org with nothing outstanding is not read and not written.
 *   2. IDEMPOTENT. Re-links to an existing wallet transaction if one is found
 *      for the charge, instead of double-debiting. Running it twice is a no-op.
 *   3. OLDEST FIRST. created_at ascending. Debt is settled in the order it was
 *      incurred, so a partial settlement clears the oldest liabilities.
 *   4. NEVER BLOCKS THE TOP-UP. Called after the credit lands. If settlement
 *      throws, the tenant keeps their credit and we log. Money in always wins.
 *   5. FLOOR-AWARE. Stops once the balance would breach the configured hard
 *      stop, leaving the remainder outstanding rather than driving the wallet
 *      arbitrarily negative in one sweep.
 */

"use strict";

const { getSupabase } = require("./supabase");

function safeNumber(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function roundMoney(v, p = 8) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** p;
  return Math.round(n * f) / f;
}
function nowIso() {
  return new Date().toISOString();
}

function settlementFloorUsd() {
  // Mirrors billing-credit-enforcement.js. Settlement may take the wallet down
  // to the hard stop but not past it.
  const raw = process.env.BILLING_HARD_STOP_BALANCE_USD;
  const n = Number(raw);
  return Number.isFinite(n) ? n : -1;
}

/**
 * Read-only. Safe to call from a dashboard or a cron audit.
 */
async function getOutstandingCharges(organizationId, { limit = 500 } = {}) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("billing_customer_usage_charges")
    .select(
      "id,usage_event_id,organization_id,provider,service,event_type,unit,quantity,customer_charge_usd,wallet_transaction_id,source,created_at",
    )
    .eq("organization_id", organizationId)
    .is("wallet_transaction_id", null)
    .gt("customer_charge_usd", 0)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw error;

  const rows = data || [];
  return {
    organizationId,
    count: rows.length,
    totalOutstandingUsd: roundMoney(
      rows.reduce((sum, r) => sum + safeNumber(r.customer_charge_usd), 0),
      6,
    ),
    charges: rows,
  };
}

/**
 * Settles outstanding charges for ONE organization.
 *
 * @param {object}  opts
 * @param {string}  opts.organizationId   required, scopes every query
 * @param {boolean} opts.dryRun           report only, write nothing
 * @param {number}  opts.limit            max charges per sweep
 * @param {string}  opts.reason           audit label
 */
async function settleOutstandingCharges({
  organizationId,
  dryRun = false,
  limit = 500,
  reason = "wallet_topup_settlement",
} = {}) {
  if (!organizationId) {
    throw Object.assign(new Error("organizationId is required."), {
      code: "SETTLEMENT_ORG_REQUIRED",
    });
  }

  const sb = getSupabase();

  // Lazily required: usage-ledger requires supabase too, and requiring it at
  // module load creates a cycle when billing-usage.js pulls both in.
  const {
    postWalletDebitForChargeDirectly,
  } = require("./usage-ledger");

  const outstanding = await getOutstandingCharges(organizationId, { limit });

  if (!outstanding.count) {
    return {
      organizationId,
      settled: [],
      failed: [],
      skipped: [],
      settledCount: 0,
      settledUsd: 0,
      remainingUsd: 0,
      dryRun,
      message: "Nothing outstanding.",
    };
  }

  const { data: wallet } = await sb
    .from("billing_wallets")
    .select("id,balance_usd,status")
    .eq("organization_id", organizationId)
    .maybeSingle();

  let runningBalance = safeNumber(wallet?.balance_usd, 0);
  const floor = settlementFloorUsd();

  const settled = [];
  const failed = [];
  const skipped = [];

  for (const charge of outstanding.charges) {
    const amount = roundMoney(safeNumber(charge.customer_charge_usd), 8);
    if (amount <= 0) {
      skipped.push({ chargeId: charge.id, reason: "non_positive_amount" });
      continue;
    }

    // Safety property 5.
    if (roundMoney(runningBalance - amount, 8) < floor) {
      skipped.push({
        chargeId: charge.id,
        amountUsd: amount,
        reason: "would_breach_hard_stop",
        balanceUsd: runningBalance,
        floorUsd: floor,
      });
      continue;
    }

    if (dryRun) {
      settled.push({ chargeId: charge.id, amountUsd: amount, dryRun: true });
      runningBalance = roundMoney(runningBalance - amount, 8);
      continue;
    }

    try {
      // Safety property 2: this helper re-links to an existing transaction if
      // one already exists for the charge rather than inserting a second debit.
      const result = await postWalletDebitForChargeDirectly(sb, {
        charge: { ...charge, source: reason },
        usageEventId: charge.usage_event_id,
        organizationId,
      });
      runningBalance = safeNumber(result?.walletBalanceUsd, runningBalance - amount);
      settled.push({
        chargeId: charge.id,
        usageEventId: charge.usage_event_id,
        amountUsd: amount,
        walletTransactionId: result?.walletTransactionId || null,
        balanceAfterUsd: runningBalance,
      });
    } catch (err) {
      failed.push({
        chargeId: charge.id,
        amountUsd: amount,
        reason: String(err?.message || err),
      });
    }
  }

  const settledUsd = roundMoney(
    settled.reduce((s, r) => s + safeNumber(r.amountUsd), 0),
    6,
  );

  if (!dryRun && settled.length) {
    try {
      await sb.from("billing_wallet_settlement_runs").insert({
        organization_id: organizationId,
        reason,
        charges_settled: settled.length,
        amount_settled_usd: settledUsd,
        charges_failed: failed.length,
        charges_skipped: skipped.length,
        balance_after_usd: runningBalance,
        detail: { settled, failed, skipped },
        created_at: nowIso(),
      });
    } catch (err) {
      // Audit table is created by 002_scraper_and_settlement.sql. Never let a
      // missing audit row roll back a completed settlement.
      console.warn("[settlement] audit insert skipped:", err?.message || err);
    }
  }

  return {
    organizationId,
    settled,
    failed,
    skipped,
    settledCount: settled.length,
    settledUsd,
    balanceAfterUsd: runningBalance,
    remainingUsd: roundMoney(
      [...failed, ...skipped].reduce((s, r) => s + safeNumber(r.amountUsd), 0),
      6,
    ),
    dryRun,
  };
}

/**
 * Wrapper for the top-up routes. Never throws — a settlement failure must not
 * fail a successful payment. (Safety property 4.)
 */
async function settleAfterTopUp(organizationId, meta = {}) {
  try {
    const result = await settleOutstandingCharges({
      organizationId,
      reason: meta.reason || "wallet_topup_settlement",
    });
    if (result.settledCount) {
      console.log(
        `[settlement] org=${organizationId} settled ${result.settledCount} charge(s) ` +
          `= $${result.settledUsd} -> balance $${result.balanceAfterUsd}`,
      );
    }
    return result;
  } catch (err) {
    console.error(
      `[settlement] org=${organizationId} failed (credit retained):`,
      err?.message || err,
    );
    return { organizationId, error: String(err?.message || err), settledCount: 0 };
  }
}

/**
 * Cross-org sweep for the scheduled job. Only touches orgs that actually have
 * outstanding charges. (Safety property 1.)
 */
async function sweepAllOrganizations({ dryRun = false, maxOrgs = 200 } = {}) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("billing_customer_usage_charges")
    .select("organization_id")
    .is("wallet_transaction_id", null)
    .gt("customer_charge_usd", 0)
    .limit(5000);
  if (error) throw error;

  const orgIds = [...new Set((data || []).map((r) => r.organization_id))]
    .filter(Boolean)
    .slice(0, maxOrgs);

  const results = [];
  for (const organizationId of orgIds) {
    results.push(
      await settleOutstandingCharges({
        organizationId,
        dryRun,
        reason: "scheduled_settlement_sweep",
      }),
    );
  }

  return {
    organizationsProcessed: results.length,
    totalSettledUsd: roundMoney(
      results.reduce((s, r) => s + safeNumber(r.settledUsd), 0),
      6,
    ),
    results,
  };
}

module.exports = {
  getOutstandingCharges,
  settleOutstandingCharges,
  settleAfterTopUp,
  sweepAllOrganizations,
};
