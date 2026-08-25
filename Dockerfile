# Voice WebSocket server.
#
# Long-lived connections: a call holds one socket for up to
# MAX_INBOUND_CALL_SECONDS (900s). This must run as a persistent container,
# never a serverless function.
FROM node:20-alpine

WORKDIR /app

# Lockfile first so dependency layers cache across code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

# Documents are parsed in-process (pdf-parse/mammoth/epub2) alongside live
# audio, so headroom here is not optional.
ENV NODE_OPTIONS="--max-old-space-size=1536"
ENV PORT=8080
EXPOSE 8080

# Give in-flight calls a chance to finish before the process dies.
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null 2>&1 || exit 1

CMD ["node", "ws-server.js"]
