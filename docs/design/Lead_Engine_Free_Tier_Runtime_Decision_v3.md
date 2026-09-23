# Lead Engine Free-Tier Runtime Decision v3

## Decision

Run the Lead Engine in the owner's personal Vercel Hobby scope. Do not create or require a Vercel Team or Pro plan. Use Neon Free for PostgreSQL, Auth, and the Data API; use Upstash QStash Free for durable signed schedule delivery.

This decision replaces Supabase and sub-daily Vercel Cron in the Lead Engine runtime only. Delivery Factory remains independently deployable and may change its persistence architecture through a separate decision.

> **Update (2026-09-23):** the separate Delivery Factory decision has been made — see [ADR 0001 — Delivery Factory runtime](../adr/0001-delivery-factory-runtime.md) (Neon + QStash + Vercel, independent instances).

## Runtime mapping

| Capability                         | Selected service       | Boundary                                          |
| ---------------------------------- | ---------------------- | ------------------------------------------------- |
| Web UI and API                     | Vercel Hobby           | One independent Lead Engine project               |
| Authentication                     | Neon Auth              | Browser sessions; separate from Delivery Factory  |
| Browser data access                | Neon Data API          | JWT validation plus PostgreSQL RLS                |
| Worker data access                 | Neon serverless driver | Server-only pooled `DATABASE_URL`                 |
| Durable jobs, leases, leads, audit | Neon PostgreSQL        | Transactional source of truth                     |
| Schedule delivery and retries      | Upstash QStash         | Signed five-minute worker and hourly canary calls |
| Local continuity                   | Browser localStorage   | Read-only cache; never authoritative              |
| Operational telemetry              | Vercel logs and Sentry | Postman is inspection only                        |

## Why QStash is required

Vercel Hobby Cron cannot provide a reliable five-minute scheduler. QStash owns delivery timing and retry; PostgreSQL owns job truth, lease recovery, idempotency, and dead-letter state. A duplicate QStash delivery is safe because schedule IDs and database idempotency keys are stable.

## Free-tier guardrails

- Raw source bodies are capped at 250 KB, extracted text at 100 KB, and raw bodies are compacted after the approved source retention period.
- Audit snapshots omit raw and extracted evidence bodies while retaining hashes and provenance.
- QStash creates no per-lead fan-out by default: one tick leases a bounded batch of three jobs.
- Collection budgets, rate limits, robots decisions, source approval, and one-active-job-per-source controls remain enforced.
- Usage dashboards for Neon compute/storage, QStash messages, and Vercel Functions are release evidence. Exceeding a free quota pauses schedules; it does not authorize an automatic paid upgrade.

## Production gates

The architecture is accepted, but production approval remains evidence-based. The Neon migration and genuine-token RLS test, QStash signed callback, permitted-source pipeline, retry/dead-letter recovery, restart/lease recovery, Postman lifecycle, 72-hour canary, and scheduled-start p95 target must all pass. No paid plan is assumed by any gate.
