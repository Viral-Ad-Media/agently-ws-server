"use strict";

/**
 * ============================================================
 * lib/knowledge-ingest-worker.js
 * ============================================================
 * Always-on Railway worker that parses uploaded Knowledge Base files
 * (PDF/DOCX/EPUB/TXT), chunks them, and writes into the EXISTING
 * knowledge_chunks table in the exact shape scraper.service.js already
 * writes — so search_knowledge_chunks / knowledge-retrieval.js need no
 * changes to serve this content on the next phone call or webcall.
 *
 * Claiming follows the same FOR UPDATE SKIP LOCKED pattern as
 * scrape-worker.js's knowledge_claim_scrape_job(), via
 * knowledge_claim_ingest_job(). No heartbeat/lease-renewal RPC here: a
 * single file parse+chunk+insert is seconds, not minutes, so one lease
 * from claim time is enough — a crashed worker's job is simply reclaimed
 * once the lease expires.
 * ============================================================
 */

const crypto = require("crypto");
const { getSupabase } = require("./supabase");
const { logKnowledgeSyncUsage } = require("./usage-ledger");

const WORKER_ID = `${process.env.RAILWAY_REPLICA_ID || "local"}-${process.pid}`;
const POLL_MS = Number(process.env.INGEST_WORKER_POLL_MS || 4000);
const LEASE_SECONDS = Number(process.env.INGEST_WORKER_LEASE_SECONDS || 180);
const MAX_ATTEMPTS = Number(process.env.INGEST_WORKER_MAX_ATTEMPTS || 3);
const BUCKET = process.env.KNOWLEDGE_UPLOADS_BUCKET || "knowledge-uploads";

// Same sizing as scraper.service.js's chunkText() — word-count based, not
// naive fixed-character splitting, ~13% overlap.
const CHUNK_SIZE = Number(process.env.SCRAPER_CHUNK_SIZE || 420);
const CHUNK_OVERLAP = Number(process.env.SCRAPER_CHUNK_OVERLAP || 55);
const MAX_CHUNKS = Number(process.env.SCRAPER_MAX_CHUNKS || 260);
const MIN_USABLE_CHARS = 200;

let running = false;
let stopped = false;

function log(...args) {
  console.log("[knowledge-ingest-worker]", ...args);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function tokenCount(value) {
  return String(value || "").split(/\s+/).filter(Boolean).length;
}

function compactSummary(value, maxChars = 420) {
  const text = cleanText(value);
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  return `${cut.slice(0, Math.max(cut.lastIndexOf("."), cut.lastIndexOf(" "), 260)).trim()}...`;
}

/**
 * Paragraph-aware chunking: packs whole paragraphs into ~CHUNK_SIZE-word
 * chunks so a chunk boundary lands on a paragraph break wherever the
 * document has one, instead of mid-sentence. A single paragraph longer than
 * the budget falls back to the same sliding-word-window scraper.service.js
 * uses. Overlap is carried across chunk boundaries by re-including the
 * tail words of the previous chunk.
 */
function chunkDocumentText(text) {
  const paragraphs = String(text || "")
    .split(/\n\s*\n+/)
    .map((p) => cleanText(p))
    .filter((p) => p.length > 0);

  const chunks = [];
  let currentWords = [];

  const flush = () => {
    if (!currentWords.length) return;
    const content = currentWords.join(" ").trim();
    if (content.length > 40) chunks.push(content);
    currentWords = [];
  };

  const overlapTail = (words) =>
    words.length > CHUNK_OVERLAP ? words.slice(-CHUNK_OVERLAP) : words.slice();

  for (const paragraph of paragraphs) {
    if (chunks.length >= MAX_CHUNKS) break;
    const paraWords = paragraph.split(/\s+/).filter(Boolean);

    if (paraWords.length > CHUNK_SIZE) {
      // Oversized paragraph: flush what we have, then sliding-window this
      // paragraph on its own.
      flush();
      let i = 0;
      while (i < paraWords.length && chunks.length < MAX_CHUNKS) {
        const slice = paraWords.slice(i, i + CHUNK_SIZE).join(" ").trim();
        if (slice.length > 40) chunks.push(slice);
        i += Math.max(60, CHUNK_SIZE - CHUNK_OVERLAP);
      }
      currentWords = [];
      continue;
    }

    if (currentWords.length + paraWords.length > CHUNK_SIZE) {
      flush();
      currentWords = overlapTail(currentWords.length ? currentWords : []);
    }
    currentWords = currentWords.concat(paraWords);
  }
  flush();

  return chunks.slice(0, MAX_CHUNKS);
}

// ── file-type parsers ────────────────────────────────────────────────────

async function parsePdf(buffer) {
  // pdf-parse v2 exports a PDFParse class, not the callable-function API of
  // v1 (`require('pdf-parse')(buffer)`), which would silently throw
  // "pdfParse is not a function" — verified against the actually-installed
  // version rather than assumed from the (much more common) v1 API.
  const { PDFParse } = require("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return String(result?.text || "");
  } finally {
    await parser.destroy();
  }
}

async function parseDocx(buffer) {
  const mammoth = require("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return String(result?.value || "");
}

async function parseEpub(buffer, tmpPath) {
  const fs = require("fs/promises");
  const os = require("os");
  const path = require("path");
  const EPub = require("epub2").EPub;

  // epub2 reads from a file path, not a buffer — write to a scratch file.
  const scratchPath =
    tmpPath || path.join(os.tmpdir(), `kb-upload-${crypto.randomUUID()}.epub`);
  await fs.writeFile(scratchPath, buffer);
  try {
    const epub = await EPub.createAsync(scratchPath);
    const texts = [];
    for (const chapter of epub.flow) {
      if (!chapter.id) continue;
      try {
        const html = await epub.getChapterRawAsync(chapter.id);
        const text = String(html || "").replace(/<[^>]+>/g, " ");
        if (text.trim()) texts.push(text);
      } catch (_) {
        // one unreadable chapter should not fail the whole book
      }
    }
    return texts.join("\n\n");
  } finally {
    await fs.unlink(scratchPath).catch(() => {});
  }
}

async function parseTxt(buffer) {
  return buffer.toString("utf8");
}

async function extractText(fileType, buffer) {
  switch (fileType) {
    case "pdf":
      return parsePdf(buffer);
    case "docx":
      return parseDocx(buffer);
    case "epub":
      return parseEpub(buffer);
    case "txt":
      return parseTxt(buffer);
    default:
      throw new Error(`Unsupported file type: ${fileType}`);
  }
}

function friendlyFailureReason(fileType, error, extractedChars) {
  const message = String(error?.message || error || "").toLowerCase();
  if (extractedChars !== undefined && extractedChars < MIN_USABLE_CHARS) {
    if (fileType === "pdf") {
      return "This PDF appears to be scanned or image-only and has no extractable text.";
    }
    return "This file has too little extractable text to be useful.";
  }
  if (/password|encrypted/.test(message)) {
    return "This file is password-protected and could not be read.";
  }
  if (/invalid|corrupt|malformed/.test(message)) {
    return "This file could not be parsed — it may be corrupted.";
  }
  return cleanText(error?.message || error || "Could not process this file.").slice(
    0,
    300,
  );
}

// ── job lifecycle ────────────────────────────────────────────────────────

async function claimJob(db) {
  const { data, error } = await db.rpc("knowledge_claim_ingest_job", {
    p_worker_id: WORKER_ID,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) {
    if (/does not exist|Could not find the function/i.test(error.message || "")) {
      throw Object.assign(
        new Error(
          "knowledge_claim_ingest_job() is missing. Run migrations/knowledge_file_uploads.sql.",
        ),
        { fatal: true },
      );
    }
    throw error;
  }
  return Array.isArray(data) ? data[0] || null : data || null;
}

async function markFileStatus(db, sourceFileId, patch) {
  await db
    .from("knowledge_source_files")
    .update({ ...patch, updated_at: nowIso() })
    .eq("id", sourceFileId);
}

async function markSourceStatus(db, knowledgeSourceId, patch) {
  if (!knowledgeSourceId) return;
  await db
    .from("knowledge_sources")
    .update({ ...patch, updated_at: nowIso() })
    .eq("id", knowledgeSourceId);
}

async function failJob(db, job, reason) {
  const willRetry = job.attempts < MAX_ATTEMPTS;
  await db
    .from("knowledge_ingest_jobs")
    .update({
      status: willRetry ? "queued" : "failed",
      last_error: reason,
      claimed_by: null,
      lease_expires_at: null,
      updated_at: nowIso(),
    })
    .eq("id", job.id);

  if (!willRetry) {
    await markFileStatus(db, job.source_file_id, {
      status: "failed",
      status_reason: reason,
    });
  }
}

// Same shape as scrape-worker.js's hasCredit() / change-monitor.js's
// hasCredit() — a tenant with no usage credit should not be able to keep
// growing their knowledge base for free.
async function hasCredit(db, organizationId) {
  const { data: wallet } = await db
    .from("billing_wallets")
    .select("balance_usd,status")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const balance = Number(wallet?.balance_usd || 0);
  const floor = Number(process.env.BILLING_HARD_STOP_BALANCE_USD ?? -1);
  return balance > floor && String(wallet?.status || "active") !== "suspended";
}

async function processJob(db, job) {
  log(`claimed job ${job.id} file=${job.source_file_id} attempt=${job.attempts}`);

  if (!(await hasCredit(db, job.organization_id))) {
    log(`job ${job.id} deferred: insufficient credit`);
    // Not a real failure, so it deliberately does not go through failJob's
    // attempts counter. Left "running" with a short lease instead of
    // "queued": knowledge_claim_ingest_job() only reclaims a running job
    // once its lease expires, which throttles re-checks to once per lease
    // window instead of reclaiming on every poll tick while the tenant has
    // no credit.
    await db
      .from("knowledge_ingest_jobs")
      .update({
        status: "running",
        last_error: "Waiting for usage credit.",
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        updated_at: nowIso(),
      })
      .eq("id", job.id);
    return;
  }

  const { data: fileRow, error: fileErr } = await db
    .from("knowledge_source_files")
    .select("*")
    .eq("id", job.source_file_id)
    .eq("organization_id", job.organization_id)
    .maybeSingle();
  if (fileErr) throw fileErr;
  if (!fileRow) {
    await db.from("knowledge_ingest_jobs").update({
      status: "failed",
      last_error: "Source file record no longer exists.",
      claimed_by: null,
      lease_expires_at: null,
      updated_at: nowIso(),
    }).eq("id", job.id);
    return;
  }

  await markFileStatus(db, fileRow.id, { status: "processing" });

  const { data: fileBlob, error: downloadErr } = await db.storage
    .from(BUCKET)
    .download(fileRow.storage_path);
  if (downloadErr) {
    await failJob(db, job, `Could not read the uploaded file: ${downloadErr.message}`);
    return;
  }
  const buffer = Buffer.from(await fileBlob.arrayBuffer());

  let rawText = "";
  try {
    rawText = await extractText(fileRow.file_type, buffer);
  } catch (err) {
    const reason = friendlyFailureReason(fileRow.file_type, err);
    log(`parse failed for ${fileRow.id}:`, err?.message || err);
    await failJob(db, job, reason);
    await markSourceStatus(db, fileRow.knowledge_source_id, {
      scrape_status: "failed",
      last_error: reason,
    });
    return;
  }

  const cleaned = cleanText(rawText);
  if (cleaned.length < MIN_USABLE_CHARS) {
    const reason = friendlyFailureReason(fileRow.file_type, null, cleaned.length);
    await failJob(db, job, reason);
    await markSourceStatus(db, fileRow.knowledge_source_id, {
      scrape_status: "failed",
      last_error: reason,
    });
    return;
  }

  const chunkTexts = chunkDocumentText(rawText);
  if (!chunkTexts.length) {
    const reason = "No usable content could be extracted from this file.";
    await failJob(db, job, reason);
    await markSourceStatus(db, fileRow.knowledge_source_id, {
      scrape_status: "failed",
      last_error: reason,
    });
    return;
  }

  // Replace any prior chunks for this exact file (a retry/re-upload should
  // not duplicate content) — same delete-then-insert shape scraper.service.js
  // uses, scoped to this file's source_url.
  const sourceUrl = `upload://${fileRow.storage_path}`;
  await db
    .from("knowledge_chunks")
    .delete()
    .eq("organization_id", job.organization_id)
    .eq("knowledge_base_id", job.knowledge_base_id)
    .eq("source_url", sourceUrl);

  const rows = chunkTexts.map((content, index) => {
    const trimmed = content.slice(0, 8000);
    return {
      organization_id: job.organization_id,
      knowledge_base_id: job.knowledge_base_id,
      knowledge_source_id: fileRow.knowledge_source_id,
      source_url: sourceUrl,
      source_title: fileRow.filename,
      content: trimmed,
      chunk_index: index,
      content_hash: hashText(trimmed),
      token_count: tokenCount(trimmed),
      compact_summary: compactSummary(trimmed),
      metadata: {
        ingestVersion: "file-upload-v1",
        contentKind: "document",
        fileType: fileRow.file_type,
      },
    };
  });

  const BATCH = 25;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await db.from("knowledge_chunks").insert(rows.slice(i, i + BATCH));
    if (error) {
      await failJob(db, job, `Failed to save extracted content: ${error.message}`);
      return;
    }
  }

  await markFileStatus(db, fileRow.id, {
    status: "indexed",
    status_reason: null,
    indexed_at: nowIso(),
  });
  await markSourceStatus(db, fileRow.knowledge_source_id, {
    scrape_status: "completed",
    last_scraped_at: nowIso(),
    page_count: 1,
    chunk_count: rows.length,
    last_error: null,
  });

  // Same billing pattern scraping already uses (lib/usage-ledger.js's
  // logKnowledgeSyncUsage, cost + the platform's existing 70%-margin rate
  // card) — a file upload is metered as one "page" with no OpenAI/embedding
  // cost, since parsing here is local, not a paid vendor API call.
  await logKnowledgeSyncUsage({
    organizationId: job.organization_id,
    knowledgeBaseId: job.knowledge_base_id,
    knowledgeSourceId: fileRow.knowledge_source_id,
    pagesAttempted: 1,
    pagesScraped: 1,
    pagesFailed: 0,
    chunksStored: rows.length,
    storageBytes: fileRow.file_size_bytes || buffer.length,
    openaiTokens: 0,
    externalId: `upload:${fileRow.id}`,
    metadata: { fileType: fileRow.file_type, filename: fileRow.filename },
  }).catch((err) =>
    log(`billing log failed for ${fileRow.id}:`, err?.message || err),
  );
  await db
    .from("knowledge_ingest_jobs")
    .update({
      status: "completed",
      completed_at: nowIso(),
      claimed_by: null,
      lease_expires_at: null,
      updated_at: nowIso(),
    })
    .eq("id", job.id);

  log(`job ${job.id} indexed file=${fileRow.filename} chunks=${rows.length}`);
}

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
        await failJob(db, job, String(err?.message || err).slice(0, 300));
      });
    } catch (err) {
      if (err?.fatal) {
        console.error("[knowledge-ingest-worker] FATAL:", err.message);
        stopped = true;
        return;
      }
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
  if (String(process.env.INGEST_WORKER_ENABLED || "true").toLowerCase() === "false") {
    log("disabled via INGEST_WORKER_ENABLED=false");
    return;
  }
  running = true;
  stopped = false;
  log(`starting worker=${WORKER_ID} poll=${POLL_MS}ms lease=${LEASE_SECONDS}s`);
  loop().catch((err) => console.error("[knowledge-ingest-worker] fatal:", err));
}

function stop() {
  stopped = true;
  running = false;
}

module.exports = { start, stop, WORKER_ID, chunkDocumentText };
