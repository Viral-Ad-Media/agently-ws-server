/**
 * agently-ws-server/lib/scrape-worker.js   <-- NEW FILE
 *
 * PATCH 18 — P3. THE fix for the scraper. Everything else in the scraper
 * rework is scaffolding around this file.
 *
 * WHY THIS EXISTS
 *   api/routes/knowledge-bases.js:939 runs background scrapes with
 *   setImmediate(run) on Vercel serverless. The lambda is frozen the instant
 *   the 202 is flushed, so the callback usually never finishes. Sources are
 *   left stuck at scrape_status='scraping' forever, which is exactly what
 *   keeps the two frontend pollers alive and produces the "glitching /
 *   continuous reload" you described. The polling loops are a SYMPTOM.
 *
 *   Serverless cannot host a long-running job. This worker runs on Railway,
 *   which is already always-on and already runs lib/scheduler.js.
 *
 * DESIGN
 *   - Jobs live in knowledge_scrape_jobs. State is in the database, never in
 *     process memory, so a dyno restart resumes rather than loses work.
 *   - Claims are atomic via knowledge_claim_scrape_job() (FOR UPDATE SKIP
 *     LOCKED). Two replicas can never process the same job.
 *   - Leases expire. A crashed worker's job is reclaimed automatically after
 *     lease_expires_at, so nothing can get stuck the way it does today.
 *   - Progress is written per page, so the UI shows a real dial per card
 *     (issue 4d) and does not need to reload the page (issue 4e).
 *   - Cancel and pause are observed on every heartbeat (issue 4f).
 *   - Credit is checked before EVERY page, not once at the start, so a job
 *     cannot run a tenant deep into debt (issue 4k condition 1).
 */

"use strict";

const { getSupabase } = require("./supabase");

const WORKER_ID = `${process.env.RAILWAY_REPLICA_ID || "local"}-${process.pid}`;
const POLL_MS = Number(process.env.SCRAPE_WORKER_POLL_MS || 5000);
const LEASE_SECONDS = Number(process.env.SCRAPE_WORKER_LEASE_SECONDS || 120);
const PAGE_DELAY_MS = Number(process.env.SCRAPE_WORKER_PAGE_DELAY_MS || 750);
const MAX_CONSECUTIVE_FAILURES = 5;

let running = false;
let stopped = false;

function nowIso() {
  return new Date().toISOString();
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function log(...args) {
  console.log("[scrape-worker]", ...args);
}

// ─────────────────────────────────────────────────────────────────────────────

async function claimJob(db) {
  const { data, error } = await db.rpc("knowledge_claim_scrape_job", {
    p_worker_id: WORKER_ID,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) {
    if (
      /does not exist|Could not find the function/i.test(error.message || "")
    ) {
      throw Object.assign(
        new Error(
          "knowledge_claim_scrape_job() is missing. Run 002_scraper_worker_and_settlement.sql.",
        ),
        { fatal: true },
      );
    }
    throw error;
  }
  return Array.isArray(data) ? data[0] || null : data || null;
}

/**
 * Renews the lease and reports whether the job should stop. This is the ONLY
 * place pause/cancel is observed, so a stop request is honoured within one
 * page rather than at the end of the run.
 */
async function heartbeat(db, jobId) {
  const { data, error } = await db.rpc("knowledge_heartbeat_scrape_job", {
    p_job_id: jobId,
    p_worker_id: WORKER_ID,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) return { shouldStop: false, status: "unknown" };
  const row = Array.isArray(data) ? data[0] : data;
  return {
    shouldStop: row?.should_stop === true,
    // The RPC returns job_status, not status: an OUT param named `status`
    // collides with the column of the same name inside RETURNING.
    status: row?.job_status || row?.status || "unknown",
  };
}

async function updateJob(db, jobId, patch) {
  await db
    .from("knowledge_scrape_jobs")
    .update({ ...patch, updated_at: nowIso() })
    .eq("id", jobId);
}

async function updatePage(db, pageId, patch) {
  await db
    .from("knowledge_discovered_pages")
    .update({ ...patch, updated_at: nowIso() })
    .eq("id", pageId);
}

/**
 * Issue 4(k) condition 1 — "provided the user has sufficient credit necessary
 * to run the scraper job". Checked per page so a long job stops the moment the
 * wallet runs dry instead of completing and invoicing into a negative balance.
 */
async function hasCredit(db, organizationId) {
  const { data: wallet } = await db
    .from("billing_wallets")
    .select("balance_usd,status")
    .eq("organization_id", organizationId)
    .maybeSingle();

  const balance = Number(wallet?.balance_usd || 0);
  const floor = Number(process.env.BILLING_HARD_STOP_BALANCE_USD ?? -1);
  return {
    ok: balance > floor && String(wallet?.status || "active") !== "suspended",
    balanceUsd: balance,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

async function processJob(db, job) {
  log(`claimed job ${job.id} kb=${job.knowledge_base_id} type=${job.job_type}`);

  const { data: discovery } = await db
    .from("knowledge_page_discoveries")
    .select("knowledge_source_id")
    .eq("id", job.discovery_id)
    .eq("organization_id", job.organization_id)
    .maybeSingle();
  const knowledgeSourceId = discovery?.knowledge_source_id || null;

  const { data: pages, error: pagesErr } = await db
    .from("knowledge_discovered_pages")
    .select("id,url,normalized_url,title,content_hash,scrape_status")
    .eq("discovery_id", job.discovery_id)
    .eq("organization_id", job.organization_id)
    .eq("is_selected", true) // issue 4(c): ONLY selected pages, discard the rest
    .in("scrape_status", ["pending", "queued", "failed"])
    .order("priority_score", { ascending: false });

  if (pagesErr) throw pagesErr;

  const queue = pages || [];
  if (!queue.length) {
    await finishJob(db, job, "completed", "No selected pages remaining.");
    return;
  }

  const total =
    job.total_pages && job.total_pages > 0 ? job.total_pages : queue.length;
  await updateJob(db, job.id, { total_pages: total });

  // scrapeAndStore is the EXISTING, proven extraction pipeline. The worker
  // changes WHERE it runs and HOW progress is reported — not how content is
  // parsed, chunked or embedded. That keeps the live call-time knowledge path
  // byte-identical to what your agents already read.
  const { scrapeAndStore } = require("./scraper.service");
  const crypto = require("crypto");

  let completed = job.completed_pages || 0;
  let failed = job.failed_pages || 0;
  let consecutiveFailures = 0;

  for (const page of queue) {
    // ---- stop conditions, checked before every page
    const beat = await heartbeat(db, job.id);
    if (beat.shouldStop) {
      log(`job ${job.id} stopping: status=${beat.status}`);
      await updateJob(db, job.id, {
        status: beat.status === "cancelled" ? "cancelled" : "paused",
        current_page_url: null,
        claimed_by: null,
        lease_expires_at: null,
      });
      return;
    }

    const credit = await hasCredit(db, job.organization_id);
    if (!credit.ok) {
      log(`job ${job.id} paused: insufficient credit ($${credit.balanceUsd})`);
      await updateJob(db, job.id, {
        status: "paused",
        last_error: "Paused automatically because the usage balance ran out.",
        current_page_url: null,
        claimed_by: null,
        lease_expires_at: null,
      });
      await notify(db, job.organization_id, {
        title: "Knowledge sync paused",
        body: "Your website scan paused because your usage balance ran out. Add credit to resume where it left off.",
        category: "knowledge_base",
      });
      return;
    }

    // ---- scrape one page
    await updateJob(db, job.id, { current_page_url: page.url });
    await updatePage(db, page.id, {
      scrape_status: "scraping",
      scrape_progress: 10,
    });

    try {
      await updatePage(db, page.id, { scrape_progress: 35 });

      const result = await scrapeAndStore({
        organizationId: job.organization_id,
        knowledgeBaseId: job.knowledge_base_id,
        knowledgeSourceId,
        url: page.url,
        singlePage: true, // exactly this selected page
        replaceExisting: job.job_type === "selective_scrape" && completed === 0, // rebuild only full manual selections
        deferFinalStatus: true, // only finishJob may finalize the whole KB/source
        usageGroupId: job.id,
        usageMetadata: {
          jobId: job.id,
          jobType: job.job_type,
          discoveryId: job.discovery_id,
        },
      });

      await updatePage(db, page.id, { scrape_progress: 80 });

      // Issue 4(i) — content hash is what makes 24h change detection possible.
      const text = String(result?.text || result?.content || "");
      const hash = text
        ? crypto.createHash("sha256").update(text).digest("hex")
        : null;

      const changed = Boolean(
        hash && page.content_hash && hash !== page.content_hash,
      );

      await updatePage(db, page.id, {
        scrape_status: "completed",
        scrape_progress: 100,
        chunks_created:
          result?.chunksStored || result?.chunksCreated || result?.chunks || 0,
        faqs_created: result?.faqsCreated || result?.faqs || 0,
        content_hash: hash,
        previous_content_hash: page.content_hash || null,
        content_changed_at: changed ? nowIso() : undefined,
        last_scraped_at: nowIso(),
        last_checked_at: nowIso(),
        last_error: null,
      });

      completed += 1;
      consecutiveFailures = 0;
    } catch (err) {
      failed += 1;
      consecutiveFailures += 1;
      await updatePage(db, page.id, {
        scrape_status: "failed",
        scrape_progress: 0,
        last_error: String(err?.message || err).slice(0, 400),
        last_checked_at: nowIso(),
      });
      log(`page failed ${page.url}: ${err?.message || err}`);

      // A run of failures means the site is blocking us or is down. Stop and
      // tell the tenant rather than burning credit on a wall.
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await finishJob(
          db,
          job,
          "failed",
          `Stopped after ${consecutiveFailures} consecutive page failures. The site may be blocking automated access.`,
          { completed, failed },
        );
        return;
      }
    }

    await updateJob(db, job.id, {
      completed_pages: completed,
      failed_pages: failed,
      progress_percent: Math.min(
        100,
        Math.round(((completed + failed) / total) * 100),
      ),
    });

    // Politeness delay. Prevents us tripping rate limits or WAFs.
    await sleep(PAGE_DELAY_MS);
  }

  await finishJob(db, job, "completed", null, { completed, failed });
}

async function countRows(query) {
  try {
    const { count, error } = await query;
    if (error) return 0;
    return Number(count || 0);
  } catch (_) {
    return 0;
  }
}

async function finalizeKnowledgeSource(db, job, status, message, counts) {
  if (!job.discovery_id) return;
  const { data: discovery } = await db
    .from("knowledge_page_discoveries")
    .select("knowledge_source_id")
    .eq("id", job.discovery_id)
    .eq("organization_id", job.organization_id)
    .maybeSingle();
  const sourceId = discovery?.knowledge_source_id;
  if (!sourceId) return;

  const [chunkCount, productCount, completedFromDb, failedFromDb, sourceRow] =
    await Promise.all([
      countRows(
        db
          .from("knowledge_chunks")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", job.organization_id)
          .eq("knowledge_base_id", job.knowledge_base_id)
          .eq("knowledge_source_id", sourceId),
      ),
      countRows(
        db
          .from("scraped_products")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", job.organization_id)
          .eq("knowledge_base_id", job.knowledge_base_id)
          .eq("knowledge_source_id", sourceId),
      ),
      countRows(
        db
          .from("knowledge_discovered_pages")
          .select("id", { count: "exact", head: true })
          .eq("discovery_id", job.discovery_id)
          .eq("organization_id", job.organization_id)
          .eq("is_selected", true)
          .eq("scrape_status", "completed"),
      ),
      countRows(
        db
          .from("knowledge_discovered_pages")
          .select("id", { count: "exact", head: true })
          .eq("discovery_id", job.discovery_id)
          .eq("organization_id", job.organization_id)
          .eq("is_selected", true)
          .eq("scrape_status", "failed"),
      ),
      db
        .from("knowledge_sources")
        .select("metadata")
        .eq("id", sourceId)
        .eq("organization_id", job.organization_id)
        .maybeSingle()
        .then(({ data }) => data || null)
        .catch(() => null),
    ]);

  const completed = Number(completedFromDb ?? counts?.completed ?? 0);
  const failed = Number(failedFromDb ?? counts?.failed ?? 0);
  const jobCompleted = Number(counts?.completed ?? job.completed_pages ?? 0);
  const jobFailed = Number(counts?.failed ?? job.failed_pages ?? 0);
  const existingMetadata =
    sourceRow?.metadata && typeof sourceRow.metadata === "object"
      ? sourceRow.metadata
      : {};
  await db
    .from("knowledge_sources")
    .update({
      scrape_status: status === "completed" ? "completed" : status,
      last_scraped_at: status === "completed" ? nowIso() : undefined,
      page_count: completed,
      chunk_count: chunkCount,
      product_count: productCount,
      last_error:
        message ||
        (failed ? `${failed} selected page(s) could not be read.` : null),
      metadata: {
        ...existingMetadata,
        workerFinalizedAt: nowIso(),
        selectedPagesCompleted: completed,
        selectedPagesFailed: failed,
        lastJobPagesCompleted: jobCompleted,
        lastJobPagesFailed: jobFailed,
        aggregateChunkCount: chunkCount,
        aggregateProductCount: productCount,
      },
      updated_at: nowIso(),
    })
    .eq("id", sourceId)
    .eq("organization_id", job.organization_id);
}

async function finishJob(db, job, status, message, counts = {}) {
  await updateJob(db, job.id, {
    status,
    progress_percent: status === "completed" ? 100 : undefined,
    completed_pages: counts.completed ?? job.completed_pages,
    failed_pages: counts.failed ?? job.failed_pages,
    current_page_url: null,
    last_error: message,
    completed_at: nowIso(),
    claimed_by: null,
    lease_expires_at: null,
  });

  await finalizeKnowledgeSource(db, job, status, message, counts);

  await db
    .from("knowledge_bases")
    .update({
      sync_status: status === "completed" ? "ready" : status,
      last_synced_at: status === "completed" ? nowIso() : undefined,
      pending_change_count:
        status === "completed" &&
        ["auto_resync", "change_rescan"].includes(job.job_type)
          ? 0
          : undefined,
      updated_at: nowIso(),
    })
    .eq("id", job.knowledge_base_id)
    .eq("organization_id", job.organization_id);

  if (
    status === "completed" &&
    ["auto_resync", "change_rescan"].includes(job.job_type)
  ) {
    await db
      .from("knowledge_change_events")
      .update({ status: "resolved", updated_at: nowIso() })
      .eq("organization_id", job.organization_id)
      .eq("knowledge_base_id", job.knowledge_base_id)
      .in("status", ["pending", "resync_queued"]);
  }

  // Issue 4(h) — in-app notification when the scrape finishes.
  if (status === "completed") {
    await notify(db, job.organization_id, {
      title: "Knowledge base is ready",
      body: `Your website scan finished. ${counts.completed || 0} page(s) were added${
        counts.failed ? `, ${counts.failed} could not be read` : ""
      }. Your agents are using the updated knowledge now.`,
      category: "knowledge_base",
      link: "/knowledge-bases",
    });
  } else if (status === "failed") {
    await notify(db, job.organization_id, {
      title: "Knowledge sync stopped",
      body: message || "The website scan could not be completed.",
      category: "knowledge_base",
      link: "/knowledge-bases",
    });
  }

  log(`job ${job.id} -> ${status}`);
}

async function notify(db, organizationId, { title, body, category, link }) {
  try {
    await db.from("tenant_notifications").insert({
      organization_id: organizationId,
      title,
      body,
      category: category || "system",
      link: link || null,
      is_read: false,
      created_at: nowIso(),
    });
  } catch (err) {
    console.warn("[scrape-worker] notify failed:", err?.message || err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function loop() {
  const db = getSupabase();
  let consecutiveErrors = 0;
  while (!stopped) {
    try {
      const job = await claimJob(db);
      consecutiveErrors = 0;
      if (!job) {
        await sleep(POLL_MS);
        continue;
      }
      await processJob(db, job).catch(async (err) => {
        log(`job ${job.id} crashed:`, err?.message || err);
        await finishJob(
          db,
          job,
          "failed",
          String(err?.message || err).slice(0, 400),
        );
      });
    } catch (err) {
      if (err?.fatal) {
        console.error("[scrape-worker] FATAL:", err.message);
        stopped = true;
        return;
      }
      // EXPONENTIAL BACKOFF. A tight retry against a database that is refusing
      // connections is how a single broken worker takes down the login API that
      // shares that database. Back off to 5 minutes rather than hammering.
      consecutiveErrors += 1;
      const backoff = Math.min(POLL_MS * 2 ** consecutiveErrors, 300000);
      log(
        `loop error (${consecutiveErrors}), backing off ${Math.round(backoff / 1000)}s:`,
        err?.message || err,
      );
      await sleep(backoff);
    }
  }
}

function start() {
  if (running) return;
  if (
    String(process.env.SCRAPE_WORKER_ENABLED || "true").toLowerCase() ===
    "false"
  ) {
    log("disabled via SCRAPE_WORKER_ENABLED=false");
    return;
  }
  running = true;
  stopped = false;
  log(`starting worker=${WORKER_ID} poll=${POLL_MS}ms lease=${LEASE_SECONDS}s`);
  loop().catch((err) => console.error("[scrape-worker] fatal:", err));
}

function stop() {
  stopped = true;
  running = false;
}

module.exports = { start, stop, WORKER_ID };
