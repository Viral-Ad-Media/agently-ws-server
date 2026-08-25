"use strict";

/**
 * Standalone entrypoint for the knowledge-base document ingest worker.
 *
 * pdf-parse/mammoth/epub2 run here. They used to run inside ws-server.js —
 * the same process relaying live call audio — which meant a large PDF
 * upload could spike memory or block the event loop while a tenant's call
 * was in progress. This process does nothing else, so a bad document can
 * only ever cost this worker, never a live call.
 *
 * The job queue itself (lib/knowledge-ingest-worker.js) already claims work
 * with an atomic Supabase lease (claimed_by/lease_expires_at), so running
 * this on its own instance is safe even if a ws-server node still has
 * INGEST_WORKER_ENABLED unset — jobs cannot be double-processed.
 */

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const http = require("http");

// Lightsail's container health check needs an HTTP response; this worker
// has no other reason to open a port.
const PORT = process.env.PORT || 8080;
http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "knowledge-ingest-worker" }));
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(PORT, () => {
    console.log(`[ingest-worker-entrypoint] health endpoint on :${PORT}`);
  });

require("./lib/knowledge-ingest-worker").start();
