FROM node:22-bookworm-slim AS console

WORKDIR /build
COPY web/ ./web/
# Source checkouts build the console. Release archives already contain web/dist.
RUN if [ -f web/package-lock.json ]; then \
      npm ci --prefix web && npm run build --prefix web; \
    else \
      test -f web/dist/index.html; \
    fi

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    PANEL_HOST=0.0.0.0 \
    PANEL_PORT=9002 \
    PANEL_DATA_DIR=/app/data

COPY src/ ./src/
COPY --from=console /build/web/dist/ ./web/dist/

EXPOSE 9002
# /health reports worker readiness. An empty pool still has a working console.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:9002/', { signal: AbortSignal.timeout(4000) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.mjs"]
