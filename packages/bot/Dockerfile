# Multi-stage: the build needs TypeScript and dev dependencies, the runtime does
# not. Shipping the compiler to production is a larger attack surface for no gain.

FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first so a dependency install is cached independently of source.
COPY package.json package-lock.json ./
COPY packages/state/package.json packages/state/
COPY packages/bot/package.json packages/bot/
RUN npm ci --no-audit --no-fund

COPY packages/state packages/state
COPY packages/bot packages/bot
RUN npm run build --workspaces --if-present

# Drop dev dependencies now that dist/ exists.
RUN npm prune --omit=dev


FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/state/package.json packages/state/package.json
COPY --from=build /app/packages/state/dist packages/state/dist
COPY --from=build /app/packages/bot/package.json packages/bot/package.json
COPY --from=build /app/packages/bot/dist packages/bot/dist

# node:alpine ships an unprivileged `node` user. The bot opens an outbound
# websocket and needs no ingress, no filesystem writes, and no root.
USER node

# No HEALTHCHECK: the process holds a gateway websocket rather than serving a
# port, so liveness is "the process is up" — which the orchestrator already knows.
CMD ["node", "packages/bot/dist/index.js"]
