# ---------------------------------------------------------------------------
# Stage 1 — build the React SPA
# ---------------------------------------------------------------------------
FROM node:22-slim AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — install backend production dependencies
# ---------------------------------------------------------------------------
FROM node:22-slim AS server-deps
WORKDIR /app/server
# better-sqlite3 ships prebuilt binaries; python/build tools are a safety net.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY server/package*.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Stage 3 — runtime image (backend serves the built SPA)
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY server/package*.json ./server/
COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server/src ./server/src
COPY --from=client-build /app/client/dist ./client/dist

# Persisted SQLite lives here; mount a volume to keep data across restarts.
RUN mkdir -p /app/server/data && chown -R node:node /app
ENV DB_PATH=/app/server/data/vlabs.sqlite
ENV PORT=4000
USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
