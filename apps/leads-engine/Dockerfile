# Lead Engine — portable container image.
#
# The same api/ handlers that run on Vercel run here through server/adapter.ts,
# so this image deploys unchanged to Google Cloud Run, a VM, or docker compose.
# API-only service (no static frontend): STATIC_DIR is left empty.

FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/handoff-contract ./packages/handoff-contract
COPY apps/leads-engine/package.json ./apps/leads-engine/package.json
RUN pnpm install --frozen-lockfile --filter @raphah/leads-engine-app...

COPY apps/leads-engine ./apps/leads-engine
RUN pnpm --filter @raphah/leads-engine-app typecheck

FROM node:24-slim AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/handoff-contract ./packages/handoff-contract
COPY apps/leads-engine/package.json ./apps/leads-engine/package.json
RUN pnpm install --frozen-lockfile --prod --filter @raphah/leads-engine-app...

COPY --from=build /repo/apps/leads-engine/api ./api
COPY --from=build /repo/apps/leads-engine/server ./server

# Required at runtime (same names as the Vercel project):
#   DATABASE_URL, HANDOFF_PRIVATE_KEY_PEM, FEEDBACK_* key material,
#   WORKER_SECRET, QSTASH_* (if the worker tick is invoked via HTTP),
#   NEON_DATA_API_URL / NEON_AUTH_URL, origins, APP_ENV.
EXPOSE 8080
CMD ["pnpm", "--filter", "@raphah/leads-engine-app", "exec", "tsx", "server/adapter.ts"]
