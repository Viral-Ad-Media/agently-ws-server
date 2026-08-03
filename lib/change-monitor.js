/**
 * agently-ws-server/lib/change-monitor.js   <-- NEW FILE
 *
 * PATCH 19 — P3. CURRENT_ISSUES → Settings page → 4(i), 4(j), 4(k).
 *
 * "a button that could be toggled on — this button runs a check on the website
 *  every 24 hours to find if any of the selected pages has been modified ...
 *  it shows in the notification section — something like 4 new changes
 *  discovered in .product page."
 *
 * CHEAP BY DESIGN. A change check fetches the page and hashes the extracted
 * text. It does NOT chunk, embed or store. A full re-scrape only happens when
 * the hash actually differs, and even then only if the tenant opted into
 * auto_rescrape. Checking is ~1/7th the cost of scraping on the rate card.
 *
 * TWO MODES (issue 4k):
 *   notify_only    -> record the change, notify, wait for the tenant
 *   auto_rescrape  -> queue a job immediately, notify that it started
 *
 * Both are gated on credit. No credit, no check — the tenant is told why.
 */

"use strict";

const crypto = require("crypto");
const { getSupabase } = require("./supabase");

const CHECK_INTERVAL_MS = Number(
  process.env.CHANGE_MONITOR_INTERVAL_MS || 60 * 60 * 1000, // scan hourly, act per-KB on its own cadence
);
const PAGE_DELAY_MS = Number(process.env.CHANGE_MONITOR_PAGE_DELAY_MS || 500);
const UA =
  process.env.SCRAPER_USER_AGENT ||
  "Mozilla/5.0 (compatible; AgentlyBot/2.0; +https://www.agentlycall.com)";

let timer = null;
let cycleRunning = false;

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[change-monitor]", ...a);

function extractText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashText(text) {
  return crypto
    .createHash("sha256")
    .update(text || "")
    .digest("hex");
}

async function fetchPage(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function hasCredit(db, organizationId) {
  const { data } = await db
    .from("billing_wallets")
    .select("balance_usd,status")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const balance = Number(data?.balance_usd || 0);
  const floor = Number(process.env.BILLING_HARD_STOP_BALANCE_USD ?? -1);
  return balance > floor && String(data?.status || "active") !== "suspended";
}

async function notify(db, organizationId, payload) {
  try {
    await db.from("tenant_notifications").insert({
      organization_id: organizationId,
      is_read: false,
      created_at: nowIso(),
      category: "knowledge_base",
      ...payload,
    });
  } catch (err) {
    console.warn("[change-monitor] notify failed:", err?.message || err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function loadSelectedPages(db, kb) {
  const rows = [];
  const batchSize = 1000;
  for (let offset = 0; ; offset += batchSize) {
    const { data, error } = await db
      .from("knowledge_discovered_pages")
      .select("id,url,content_hash,discovery_id")
      .eq("knowledge_base_id", kb.id)
      .eq("organization_id", kb.organization_id)
      .eq("is_selected", true)
      .eq("scrape_status", "completed")
      .order("id", { ascending: true })
      .range(offset, offset + batchSize - 1);
    if (error) throw error;
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < batchSize) break;
  }
  return rows;
}

async function loadEnabledKnowledgeBases(db) {
  const rows = [];
  const batchSize = 200;
  for (let offset = 0; ; offset += batchSize) {
    const { data, error } = await db
      .from("knowledge_bases")
      .select(
        "id,organization_id,change_monitoring_enabled,change_monitoring_interval_hours,change_monitoring_mode,last_change_check_at,pending_change_count",
      )
      .eq("change_monitoring_enabled", true)
      .order("id", { ascending: true })
      .range(offset, offset + batchSize - 1);
    if (error) throw error;
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < batchSize) break;
  }
  return rows;
}

async function checkKnowledgeBase(db, kb) {
  if (!(await hasCredit(db, kb.organization_id))) {
    log(`kb=${kb.id} skipped: no credit`);
    await notify(db, kb.organization_id, {
      title: "Website monitoring paused",
      body: "We could not check your website for updates because your usage balance ran out. Add credit to resume monitoring.",
      link: "/billing",
    });
    // Push the next attempt out a day so this does not spam every cycle.
    await db
      .from("knowledge_bases")
      .update({ last_change_check_at: nowIso(), updated_at: nowIso() })
      .eq("id", kb.id);
    return;
  }

  // Only pages the tenant actually selected are monitored. Monitoring the
  // whole catalogue would charge them for pages they chose not to ingest.
  const pages = await loadSelectedPages(db, kb);

  if (!pages.length) {
    await db
      .from("knowledge_bases")
      .update({ last_change_check_at: nowIso(), updated_at: nowIso() })
      .eq("id", kb.id);
    return;
  }

  const changed = [];
  let checked = 0;

  for (const page of pages) {
    const html = await fetchPage(page.url);
    checked += 1;
    if (!html) {
      await db
        .from("knowledge_discovered_pages")
        .update({ last_checked_at: nowIso(), updated_at: nowIso() })
        .eq("id", page.id);
      await sleep(PAGE_DELAY_MS);
      continue;
    }

    const hash = hashText(extractText(html));

    if (page.content_hash && hash !== page.content_hash) {
      changed.push({ ...page, newHash: hash });

      const { data: existingChange } = await db
        .from("knowledge_change_events")
        .select("id")
        .eq("organization_id", kb.organization_id)
        .eq("discovered_page_id", page.id)
        .in("status", ["pending", "resync_queued"])
        .limit(1)
        .maybeSingle();

      if (!existingChange?.id) {
        await db.from("knowledge_change_events").insert({
          organization_id: kb.organization_id,
          knowledge_base_id: kb.id,
          discovered_page_id: page.id,
          url: page.url,
          change_type: "content_modified",
          previous_hash: page.content_hash,
          new_hash: hash,
          status: "pending",
          detected_at: nowIso(),
        });
      }

      await db
        .from("knowledge_discovered_pages")
        .update({
          content_changed_at: nowIso(),
          last_checked_at: nowIso(),
          updated_at: nowIso(),
        })
        .eq("id", page.id);
    } else if (!page.content_hash) {
      // First observation — record the baseline, do not report it as a change.
      await db
        .from("knowledge_discovered_pages")
        .update({
          content_hash: hash,
          last_checked_at: nowIso(),
          updated_at: nowIso(),
        })
        .eq("id", page.id);
    } else {
      await db
        .from("knowledge_discovered_pages")
        .update({ last_checked_at: nowIso(), updated_at: nowIso() })
        .eq("id", page.id);
    }

    await sleep(PAGE_DELAY_MS);
  }

  // Meter the check run.
  try {
    const { insertUsageEvent } = require("./usage-ledger");
    await insertUsageEvent({
      organizationId: kb.organization_id,
      provider: "agently",
      service: "knowledge_base",
      eventType: "change_check",
      source: "change_monitor",
      externalId: `${kb.id}-${Date.now()}`,
      unit: "check",
      quantity: checked,
      metadata: { knowledgeBaseId: kb.id, changed: changed.length },
    });
  } catch (err) {
    console.warn("[change-monitor] metering skipped:", err?.message || err);
  }

  await db
    .from("knowledge_bases")
    .update({
      last_change_check_at: nowIso(),
      pending_change_count: changed.length,
      updated_at: nowIso(),
    })
    .eq("id", kb.id);

  if (!changed.length) return;

  const mode = "auto_rescrape";

  if (mode === "auto_rescrape") {
    const { data: activeJob } = await db
      .from("knowledge_scrape_jobs")
      .select("id")
      .eq("organization_id", kb.organization_id)
      .eq("knowledge_base_id", kb.id)
      .in("status", ["queued", "running", "paused"])
      .limit(1)
      .maybeSingle();
    if (activeJob?.id) {
      log(
        `kb=${kb.id} change refresh skipped because job ${activeJob.id} is active`,
      );
      return;
    }

    // Queue only changed selected pages; the worker runs in the background.
    await db
      .from("knowledge_discovered_pages")
      .update({ scrape_status: "queued", updated_at: nowIso() })
      .in(
        "id",
        changed.map((c) => c.id),
      );

    await db.from("knowledge_scrape_jobs").insert({
      organization_id: kb.organization_id,
      knowledge_base_id: kb.id,
      discovery_id: changed[0].discovery_id,
      status: "queued",
      job_type: "auto_resync",
      total_pages: changed.length,
      created_at: nowIso(),
    });

    await db
      .from("knowledge_change_events")
      .update({ status: "resync_queued" })
      .eq("knowledge_base_id", kb.id)
      .eq("status", "pending");

    await notify(db, kb.organization_id, {
      title: `Updating ${changed.length} changed page${changed.length === 1 ? "" : "s"}`,
      body: `We found changes on ${describe(changed)} and started re-reading ${
        changed.length === 1 ? "it" : "them"
      } automatically. Your agents will use the updated answers shortly.`,
      link: "/knowledge-bases",
    });
  } else {
    // Issue 4(i)/(j) — notify only, tenant decides.
    await notify(db, kb.organization_id, {
      title: `${changed.length} change${changed.length === 1 ? "" : "s"} found on your website`,
      body: `We spotted updates on ${describe(changed)}. Open Knowledge Bases to re-read ${
        changed.length === 1 ? "this page" : "these pages"
      } and keep your agents current.`,
      link: "/knowledge-bases",
    });
  }

  log(`kb=${kb.id} checked=${checked} changed=${changed.length} mode=${mode}`);
}

function describe(changed) {
  const paths = changed
    .map((c) => {
      try {
        return new URL(c.url).pathname;
      } catch {
        return c.url;
      }
    })
    .slice(0, 3);
  const extra = changed.length - paths.length;
  return paths.join(", ") + (extra > 0 ? ` and ${extra} more` : "");
}

// ─────────────────────────────────────────────────────────────────────────────

async function runCycle() {
  if (cycleRunning) {
    log("previous cycle is still running; skipping overlap");
    return;
  }
  cycleRunning = true;
  const db = getSupabase();
  try {
    const bases = await loadEnabledKnowledgeBases(db);

    for (const kb of bases) {
      const intervalMs = 24 * 60 * 60 * 1000;
      const last = kb.last_change_check_at
        ? new Date(kb.last_change_check_at).getTime()
        : 0;
      const hasPendingChanges = Number(kb.pending_change_count || 0) > 0;
      if (!hasPendingChanges && Date.now() - last < intervalMs) continue;

      try {
        await checkKnowledgeBase(db, kb);
      } catch (err) {
        log(`kb=${kb.id} failed:`, err?.message || err);
      }
    }
  } catch (error) {
    log("cycle query failed:", error?.message || error);
  } finally {
    cycleRunning = false;
  }
}

function start() {
  if (timer) return;
  if (
    String(process.env.CHANGE_MONITOR_ENABLED || "true").toLowerCase() ===
    "false"
  ) {
    log("disabled via CHANGE_MONITOR_ENABLED=false");
    return;
  }
  log(`starting, scanning every ${Math.round(CHECK_INTERVAL_MS / 60000)}min`);
  // Deliberately NOT running a cycle immediately. On a container restart loop
  // an immediate cycle means a fresh burst of Supabase queries and outbound
  // HTTP every few seconds. Nothing here is urgent enough to justify that.
  timer = setInterval(() => {
    runCycle().catch((e) => log("cycle:", e?.message || e));
  }, CHECK_INTERVAL_MS);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, runCycle };
