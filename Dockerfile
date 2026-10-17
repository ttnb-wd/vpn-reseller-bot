# Registry-verified linux/amd64 manifest; full Linux image validation is still required.
ARG NODE_IMAGE=node:24.19.0-bookworm-slim@sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
# The audited runtime is JavaScript-only; do not execute dependency install hooks.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=3000 NODE_OPTIONS=--max-old-space-size=192
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node prisma/contract.json ./prisma/contract.json
COPY --chown=node:node src ./src
COPY --chown=node:node assets ./assets
COPY --chown=node:node deploy/healthcheck.cjs ./deploy/healthcheck.cjs
LABEL com.centurylinklabs.watchtower.enable="false"
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["node", "deploy/healthcheck.cjs"]
STOPSIGNAL SIGTERM
CMD ["node", "src/bot.js"]
