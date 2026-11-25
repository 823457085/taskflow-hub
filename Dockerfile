# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM node:24-alpine AS web-builder
RUN apk add --no-cache tar
WORKDIR /src

COPY preview-app/package.json preview-app/package-lock.json ./preview-app/
RUN npm --prefix preview-app ci

COPY package.json ./
COPY preview-app ./preview-app
COPY platform-server ./platform-server
COPY shared ./shared
COPY local-bridge ./local-bridge
COPY scripts ./scripts
COPY deploy ./deploy

RUN npm --prefix preview-app run build && node scripts/pack-release.mjs

FROM node:24-alpine AS runtime
WORKDIR /app

COPY package.json ./
COPY platform-server ./platform-server
COPY shared ./shared
COPY local-bridge ./local-bridge
COPY deploy ./deploy
COPY --from=web-builder /src/preview-app/dist ./web

RUN find /app/platform-server /app/local-bridge -type f \( -name '*.test.mjs' -o -name '*.fixture.mjs' \) -delete \
    && rm -rf /app/local-bridge/node_modules /app/platform-server/.data \
    && mkdir -p /data \
    && chown -R node:node /app /data

ENV NODE_ENV=production \
    TASKFLOW_HOST=0.0.0.0 \
    TASKFLOW_PORT=5187 \
    TASKFLOW_DB_PATH=/data/platform.sqlite \
    TASKFLOW_DEPLOYMENT=server \
    TASKFLOW_TRUST_PROXY=1 \
    TASKFLOW_WEB_DIR=/app/web

USER node
VOLUME ["/data"]
EXPOSE 5187 5189

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.TASKFLOW_PORT || 5187) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "platform-server/server.mjs"]
