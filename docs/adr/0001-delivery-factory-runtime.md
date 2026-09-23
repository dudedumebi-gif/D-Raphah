# ADR 0001 — Delivery Factory runtime: Neon + QStash + Vercel

- **Status:** Accepted
- **Date:** 2026-09-23
- **Approved by:** repo owner
- **Supersedes:** the Supabase/Trigger.dev runtime choices in
  `docs/design/Delivery_Factory_Technical_Design_v1.md` (and the corresponding
  runtime rows in `docs/design/Platform_Integration_and_Operations_Design_v1.md`)

## Context

The Lead Engine already runs on Neon (PostgreSQL) + QStash (queues/schedules) +
Vercel (hosting/functions) per `docs/design/Lead_Engine_Free_Tier_Runtime_Decision_v3.md`.
The Delivery Factory's earlier design documents specified a dedicated Supabase
project (PostgreSQL, Auth, Storage) with Trigger.dev for durable orchestration.
Running a second, different stack would double the provider surface, credential
inventory, and operational runbooks. The Delivery Factory also needed a real
backend: the existing `delivery-tool` is a standalone Express reference
implementation with an in-memory store and a known verification-ordering bug
(tampered replays risked being accepted as idempotent).

## Decision

1. **Runtime.** The Delivery Factory runs on **Neon** (dedicated database) +
   **QStash** (queues/schedules) + **Vercel** (hosting/functions) — the same
   stack as the Lead Engine, but fully independent instances.
2. **Canonical implementation.** Rebuild `apps/delivery-factory` with a real
   backend: Vercel serverless functions, its own Neon persistence, and the
   useful receiver/domain behavior ported out of `delivery-tool`. The existing
   `delivery-tool` package stays **untouched as a behavior reference** until the
   new implementation reaches parity; it is then deprecated, not fixed.
3. **Product independence is non-negotiable.** Lead Engine and Delivery Factory
   are independent products with separate Neon projects/databases, separate
   credentials, separate QStash schedules, separate sessions, and separate
   storage. The **only** integration surface is the versioned
   `LeadEngineHandoffPackage` contract (v1.0.0) delivered over HTTPS:
   Ed25519 signature, SHA-256 manifest checksum, timestamp freshness (±5 min),
   and nonce replay protection. No direct database access, no shared tables,
   no shared credentials.

## Alternatives considered

- **Supabase (dedicated project) for PostgreSQL/Auth/Storage.** Rejected:
  the Lead Engine's persistence, auth, and migration story is already built on
  Neon; a second database provider adds credential and runbook overhead with
  no capability the Delivery Factory needs.
- **Trigger.dev for durable orchestration.** Rejected: QStash already provides
  the durable scheduling and signed callbacks the Lead Engine uses; one queue
  provider keeps the verification model (timestamp/nonce/signature) uniform
  across both products.

Both were rejected on stack consolidation, not on technical merit — the driver
was the Neon + QStash + Vercel decision already made for the Lead Engine plus
the product-independence boundary in `AGENTS.md`.

## Consequences

- **New Vercel projects.** The Delivery Factory gets its own Vercel project
  rooted at `apps/delivery-factory`; no Lead Engine env var, session, or
  secret may appear in its configuration, and vice versa.
- **New Neon projects.** Each product provisions and migrates its own Neon
  project (`apps/leads-engine/neon/migrations/`,
  `apps/delivery-factory/neon/migrations/`).
- **Separate QStash schedules.** Each product creates its own schedules
  against its own endpoints; signing keys are per product.
- **Env var inventory (server-only unless noted).**

  Lead Engine (`apps/leads-engine`, see `.env.example`):
  `DATABASE_URL`, `NEON_AUTH_URL`, `NEON_DATA_API_URL`, `QSTASH_TOKEN`,
  `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `WORKER_SECRET`,
  `HANDOFF_SIGNING_PRIVATE_KEY_PEM`, `HANDOFF_SIGNING_PUBLIC_KEY_PEM`,
  `DELIVERY_INTAKE_URL`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`,
  `LEAD_ENGINE_ORIGIN`, `LEAD_ENGINE_CANARY_URL`,
  `LEAD_ENGINE_CANARY_WORKSPACE_ID`, `LEAD_ENGINE_CANARY_SOURCE_ID`.

  Delivery Factory (`apps/delivery-factory`):
  `DELIVERY_DATABASE_URL`, `LEAD_ENGINE_PUBLIC_KEY_PEM`
  (the Lead Engine's `HANDOFF_SIGNING_PUBLIC_KEY_PEM`, distributed out of
  band — never inside the package), `DELIVERY_ALLOWED_ORIGINS` (restricted
  CORS allowlist, no wildcard), `QSTASH_TOKEN` plus signing keys when the
  Delivery Factory gains its own worker/schedules, `SENTRY_DSN`.

- **Intake verification order (delivery side)** is fixed as: timestamp →
  nonce replay check → Ed25519 signature + checksum verification → schema
  validation → idempotency lookup. A tampered replay is rejected with 401,
  never idempotent-accepted.
- **Migration risk:** none to the Lead Engine; the Delivery Factory migration
  is additive and its database starts empty.
