FROM node:22-bookworm-slim AS build

ENV COREPACK_HOME=/corepack
ENV PATH=$COREPACK_HOME:$PATH
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY companion/package.json companion/package.json
RUN corepack enable && corepack pnpm install --frozen-lockfile

COPY companion/tsconfig.json companion/tsconfig.build.json companion/vite.config.ts companion/vitest.config.ts companion/
COPY companion/ui companion/ui
COPY companion/src companion/src
RUN corepack pnpm --dir companion build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV SYNCANDRUN_DATA_DIR=/data
WORKDIR /app

COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/companion/node_modules /app/companion/node_modules
COPY --from=build /app/companion/package.json /app/companion/package.json
COPY --from=build /app/companion/dist /app/companion/dist

RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.SYNCANDRUN_PORT || '3000') + '/health/ready').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "companion/dist/main.js"]
