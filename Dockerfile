# ── dashboard build ──────────────────────────────────────────────────────────
FROM oven/bun:1.3 AS web
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

# ── server dependencies (production only) ────────────────────────────────────
FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ── runtime ──────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3333 \
    HOST=0.0.0.0 \
    P2M_DATA_DIR=/data \
    P2M_WEB_DIR=/app/web/dist

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY --from=web /app/web/dist ./web/dist

# State (accounts, API key hashes, custom tools, logs) lives in /data — mount
# a volume there to keep it across restarts.
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
USER bun
EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 3333) + '/api/health'); process.exit(r.ok ? 0 : 1)"

ENTRYPOINT ["bun", "src/bin.ts"]
CMD ["serve"]
