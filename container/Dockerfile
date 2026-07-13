FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.server.json tsconfig.public.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN npm run build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        jq \
        openssh-client \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && PI_VERSION="$(node -p "require('./package-lock.json').packages['node_modules/@earendil-works/pi-coding-agent'].version")" \
    && npm install --global --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}"

COPY --from=builder /app/bin ./bin
COPY --from=builder /app/public ./public
COPY --from=builder /app/src/pi-extension ./src/pi-extension
COPY container/entrypoint.sh /usr/local/bin/tau-entrypoint

RUN chmod 0755 /usr/local/bin/tau-entrypoint

ENV PATH="/app/node_modules/.bin:${PATH}" \
    NODE_ENV="production" \
    TAU_HOST="0.0.0.0" \
    TAU_PORT="3001" \
    TAU_STATIC_DIR="/app/public"

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl --fail --silent --show-error http://127.0.0.1:3001/api/health >/dev/null || exit 1

ENTRYPOINT ["tau-entrypoint"]
CMD ["node", "/app/bin/tau.js"]
