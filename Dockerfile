# syntax=docker/dockerfile:1
# Hephaestus (heph) — single image serving the UI/REST port and the agent (MCP/hooks) port.

ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false

# Workspace manifests only, so dependency layers are cached across source changes.
FROM base AS manifests
COPY package.json package-lock.json ./
COPY packages/schema/package.json packages/schema/
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

# All dependencies, for building.
FROM manifests AS deps
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

# Production dependencies only (native modules ship prebuilt binaries for linux-x64/arm64).
FROM manifests AS prod-deps
RUN npm ci --omit=dev

FROM base AS runtime
# CalVer release version (set by the Release workflow; "dev" for local builds).
ARG HEPH_VERSION=dev
ENV HEPH_VERSION=$HEPH_VERSION \
    NODE_ENV=production \
    HEPH_DB_DIR=/data/db \
    HEPH_FILES_DIR=/data/files \
    HEPH_WEB_DIR=/app/web \
    HEPH_MIGRATIONS_DIR=/app/migrations \
    HEPH_UI_PORT=8080 \
    HEPH_AGENT_PORT=8081
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/web/dist ./web
COPY --from=build /app/packages/core/drizzle ./migrations
RUN printf '#!/bin/sh\nexec node /app/dist/cli.mjs "$@"\n' > /usr/local/bin/heph \
 && chmod +x /usr/local/bin/heph \
 && mkdir -p /data/db /data/files \
 && chown -R node:node /data
USER node
VOLUME ["/data/db", "/data/files"]
# 8080: UI + REST (publish through the tunnel). 8081: MCP + hooks + agent uploads (LAN only).
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.HEPH_UI_PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "/app/dist/main.mjs"]
