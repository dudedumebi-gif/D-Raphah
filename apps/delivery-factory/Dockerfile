# Delivery Factory — portable container image.
#
# The same api/ handlers that run on Vercel run here through server/adapter.ts,
# so this image deploys unchanged to Google Cloud Run, a VM, or docker compose.
# Cloud Run: set PORT=8080 (default), STATIC_DIR=dist, and all env vars below.

FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo

# Workspace layout first for a cache-friendly install.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/handoff-contract ./packages/handoff-contract
COPY apps/delivery-factory/package.json ./apps/delivery-factory/package.json
RUN pnpm install --frozen-lockfile --filter @raphah/delivery-factory-app...

# Build the Vite SPA and typecheck the api.
COPY apps/delivery-factory ./apps/delivery-factory
RUN pnpm --filter @raphah/delivery-factory-app build
RUN pnpm --filter @raphah/delivery-factory-app typecheck

FROM node:24-slim AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=dist

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/handoff-contract ./packages/handoff-contract
COPY apps/delivery-factory/package.json ./apps/delivery-factory/package.json
RUN pnpm install --frozen-lockfile --prod --filter @raphah/delivery-factory-app...

COPY --from=build /repo/apps/delivery-factory/dist ./dist
COPY --from=build /repo/apps/delivery-factory/api ./api
COPY --from=build /repo/apps/delivery-factory/server ./server

# Required at runtime (same names as the Vercel project):
#   DELIVERY_DATABASE_URL, HANDOFF_* / FEEDBACK_* key material,
#   DELIVERY_FACTORY_CRON_SECRET, origins, APP_ENV.
EXPOSE 8080
CMD ["pnpm", "--filter", "@raphah/delivery-factory-app", "exec", "tsx", "server/adapter.ts"]
