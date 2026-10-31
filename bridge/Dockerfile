# Brother QL bridge — a small WebSocket-to-9100 relay.
#
# Two stages so the published image carries only production dependencies and
# the compiled JavaScript, not the TypeScript toolchain or the test suite.

# --- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install with the lockfile first, for a cached layer that survives source
# edits. The build needs the dev dependencies (TypeScript), so no --omit here.
COPY package.json package-lock.json ./
RUN npm ci

# The build is `tsc` and then the esbuild bundling of the admin page's copy of
# the printer library (scripts/bundle-admin-lib.mjs), so the script comes too.
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Re-resolve to production dependencies only, for copying into the runtime
# stage. `npm ci --omit=dev` into a clean tree gives exactly what ships.
RUN npm ci --omit=dev

# --- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

# The state file lives on a volume so tokens and the printer list outlive the
# container. It is written by the node user (uid 1000), which the base image
# already provides, so the process never runs as root.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 8080

# A plain Node health check: exit 0 when /healthz answers. Keeps the image free
# of curl or wget, whose presence in a printer-facing service is needless.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
