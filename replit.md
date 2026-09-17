# Raphah.io

Raphah.io is a client-facing advisory website that helps founder-led teams turn operational friction into clear AI and business-systems improvements, with a consultation request flow.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/raphah-site/` — public Raphah.io website and consultation experience.
- `artifacts/api-server/` — shared API server, including consultation intake.
- `lib/api-spec/openapi.yaml` — source of truth for the consultation API contract.
- `lib/db/src/schema/consultations.ts` — Drizzle schema for consultation requests.
- `website/`, `lead-engine/`, `delivery-tool/` — repository boundary docs mirrored into GitHub `D-Raphah`.

## Architecture decisions

- The public website is deliberately separate from the internal Lead Engine and Delivery Tool boundaries.
- Consultation requests are human-facing, evidence-first intake records; package prices are not shown publicly.
- The client form posts through the shared API and stores requests in PostgreSQL rather than relying on browser-only state.

## Product

- Explains Raphah.io's advisory positioning and evidence-led working model.
- Describes how the approach applies across professional services, finance and fintech, technology, sales, and marketing.
- Captures validated consultation requests with context, timing, and company details.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- The public form requires the API server workflow to be running for submissions to persist.
- Regenerate API clients with `pnpm --filter @workspace/api-spec run codegen` after changing the consultation contract.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
