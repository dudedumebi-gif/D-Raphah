# Raphah Lead Engine v3

Production-oriented web application for permitted-source discovery, evidence capture, automation-maturity scoring, durable scrape jobs, and human-reviewed lead qualification.

**Work in progress — not production approved.** See `docs/runbooks/Lead_Engine_Production_Readiness_Runbook.md` for verified checks, unexecuted database tests, and remaining discovery/lifecycle/security gates. The new console does not yet have full legacy discovery/requirements/handoff parity; do not promote it over the live UI.

## Runtime architecture

- **Vite/React UI** — Neon Auth, policy/source management, scrape job lifecycle, lead review, criteria, audit, and operational SLO views.
- **Vercel Hobby Functions** — authenticated API, collection worker, and canary endpoint. No Pro/Teams capability is required.
- **Neon Free** — PostgreSQL source of truth, Data API RLS tenant boundary, Auth, database audit triggers, and capped evidence payloads.
- **Upstash QStash Free** — signed five-minute worker dispatch and hourly canary dispatch with retries. This replaces Vercel Cron because Hobby Cron is limited to daily execution.
- **Local storage** — read-only last-known workspace mirror. It is never authoritative and never drives the worker.
- **Vercel + Sentry** — authoritative build/runtime and exception telemetry. Postman is an inspection client.

## Local checks

```bash
pnpm --filter @raphah/leads-engine-app typecheck
pnpm --filter @raphah/leads-engine-app test
pnpm --filter @raphah/leads-engine-app build
```

## Provisioning order

1. In the personal Vercel Hobby scope, add a Neon integration and an Upstash QStash integration to the Lead Engine project. Do not create or use a Vercel Team.
2. In Neon, enable Auth and the Data API. Apply `neon/migrations/202609220001_lead_engine_production.sql` with `psql` against a disposable branch first, then production.
3. Run `neon/tests/job_lifecycle_v3.sql` against the disposable branch, then run `pnpm test:rls:neon` with two genuine Neon Auth sessions through the Data API.
4. Configure the variables in `.env.example` in the Lead Engine Vercel project. Keep `DATABASE_URL`, QStash keys, and `WORKER_SECRET` server-only.
5. Deploy, create the first operator account, then approve one Raphah-controlled canary source.
6. Set the three `LEAD_ENGINE_CANARY_*` variables and redeploy.
7. From `apps/leads-engine`, run `pnpm qstash:configure` once with `QSTASH_TOKEN` and `LEAD_ENGINE_BASE_URL`. Re-running updates the stable schedule IDs instead of duplicating them.
8. Import the two files under `postman/`, paste a Neon Auth access token, and run the lifecycle collection. The optional worker diagnostic uses `WORKER_SECRET`; normal dispatch remains QStash-signed.
9. Begin the 72-hour release canary. Production promotion requires `>=99%` completion and scheduled-start p95 `<5 minutes`.

## Free-tier operating guardrails

- Raw evidence is capped at 250 KB per fetch and extracted text at 100 KB. The worker compacts raw bodies after the approved retention period; content hashes, provenance, signals, and scores remain durable. Large evidence bodies are redacted from audit snapshots.
- Start with a conservative source budget and retention policy; watch Neon storage/compute and QStash daily messages in their dashboards.
- The scheduler is idempotent at both schedule and job levels. QStash retries cannot create duplicate logical jobs or leads.
- Postman is a diagnostic client, not operational telemetry. Vercel runtime logs and Sentry remain authoritative.

## Compliance boundary

No automated LinkedIn scraping (public or authenticated), login automation, CAPTCHA bypass, access-control circumvention, or automated outreach sending is permitted. Sources remain blocked until an owner/administrator explicitly approves the policy.
