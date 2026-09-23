# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
  && apt-get install --yes --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.15.1 --activate
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/authorization/package.json packages/authorization/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/observability/package.json packages/observability/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
COPY . .
ARG SERVICE
ENV NEXT_OUTPUT_MODE=standalone
RUN pnpm turbo run build --filter=@incidentbase/${SERVICE}...

FROM base AS service-production-dependencies
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/authorization/package.json packages/authorization/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/observability/package.json packages/observability/package.json
RUN pnpm install --prod --frozen-lockfile

FROM dependencies AS migrate
COPY packages/database ./packages/database
CMD ["sh", "-c", "pnpm --filter @incidentbase/database db:migrate:deploy && pnpm --filter @incidentbase/database db:provision:runtime"]

FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
USER node
COPY --chown=node:node --from=service-production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=service-production-dependencies /app/apps/api/node_modules ./apps/api/node_modules
COPY --chown=node:node --from=service-production-dependencies /app/packages ./packages
COPY --chown=node:node --from=builder /app/apps/api/dist ./apps/api/dist
COPY --chown=node:node --from=builder /app/packages/auth/dist ./packages/auth/dist
COPY --chown=node:node --from=builder /app/packages/authorization/dist ./packages/authorization/dist
COPY --chown=node:node --from=builder /app/packages/config/dist ./packages/config/dist
COPY --chown=node:node --from=builder /app/packages/contracts/dist ./packages/contracts/dist
COPY --chown=node:node --from=builder /app/packages/database/dist ./packages/database/dist
COPY --chown=node:node --from=builder /app/packages/observability/dist ./packages/observability/dist
COPY --chown=node:node apps/api/package.json ./apps/api/package.json
EXPOSE 4000
CMD ["node", "--enable-source-maps", "apps/api/dist/index.js"]

FROM node:22-bookworm-slim AS worker
ENV NODE_ENV=production
WORKDIR /app
USER node
COPY --chown=node:node --from=service-production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=service-production-dependencies /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --chown=node:node --from=service-production-dependencies /app/packages ./packages
COPY --chown=node:node --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --chown=node:node --from=builder /app/packages/config/dist ./packages/config/dist
COPY --chown=node:node --from=builder /app/packages/contracts/dist ./packages/contracts/dist
COPY --chown=node:node --from=builder /app/packages/database/dist ./packages/database/dist
COPY --chown=node:node --from=builder /app/packages/observability/dist ./packages/observability/dist
COPY --chown=node:node apps/worker/package.json ./apps/worker/package.json
CMD ["node", "--enable-source-maps", "apps/worker/dist/index.js"]

FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app
USER node
COPY --chown=node:node --from=builder /app/apps/web/.next/standalone ./
COPY --chown=node:node --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --chown=node:node --from=builder /app/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
