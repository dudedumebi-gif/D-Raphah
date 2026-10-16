# Raphah Lead Engine v4

Production-oriented web application for permitted-source discovery, evidence capture, automation-maturity scoring, durable scrape jobs, and human-reviewed lead qualification.

**Production approved and live** (owner approval 2026-10-11, after the 72-hour soak and release-decision checks passed; see the repository-level `PRODUCTION_README.md`). v4 (2026-10-15) is the simplification release: the canary subsystem that guarded the original promotion was retired once its gate had passed, demo/pilot data modes were collapsed into a single production view, and the criteria automation trio (suggestion engine, auto-apply, campaign schedules) was cut in favour of manual, human-reviewed criteria.

## Runtime architecture

- **Vite/React UI** — Neon Auth, policy/source management, Overpass/Job Bank discovery, persistent candidates, scrape lifecycle, lead review, criteria, audit, and operational SLOs.
- **Vercel Hobby Functions** — authenticated API and the collection worker. No Pro/Teams capability is required.
- **Neon Free** — PostgreSQL source of truth, Data API RLS tenant boundary, Auth, database audit triggers, and capped evidence payloads.
- **Upstash QStash Free** — one signed four-minute worker schedule (`raphah-lead-worker-v1`), retries, and signed final-failure callbacks. The worker tick also runs the alert/incident reconcile (worker-stale, dead-letter, scheduled-start p95, QStash delivery failure; Slack receives the transitions). This replaces Vercel Cron because Hobby Cron is limited to daily execution.
- **Local storage** — read-only last-known workspace mirror. It is never authoritative and never drives the worker.
- **Vercel + Sentry** — authoritative build/runtime and exception telemetry.

Retired one-release stubs: `POST /api/v1/canary/run` and `POST /api/v1/operations/evaluate` answer `200 {retired: true}` until their leftover QStash schedules are paused in the Upstash console; both are removed next release.

## Local checks

```bash
pnpm --filter @raphah/leads-engine-app typecheck
pnpm --filter @raphah/leads-engine-app test
pnpm --filter @raphah/leads-engine-app build
```

## Provisioning order

1. In the personal Vercel Hobby scope, add a Neon integration and an Upstash QStash integration to the Lead Engine project. Do not create or use a Vercel Team.
2. In Neon, enable Auth and the Data API. Apply every migration under `neon/migrations/` in timestamp order against a disposable branch first; apply to production only after rehearsal.
3. Run `neon/tests/job_lifecycle_v3.sql` and `neon/tests/rls_behavior_v3.sql` against the disposable branch, then run `pnpm test:rls:neon` with two genuine Neon Auth sessions through the Data API. CI can obtain fresh sessions from two dedicated synthetic users through protected email/password secrets; short-lived tokens are also accepted for ad hoc local runs.
4. Configure the variables in `.env.example` in the Lead Engine Vercel project, including `LEAD_ENGINE_SCHEDULER_WORKSPACE_ID` (the workspace the scheduler routes act on). Keep `DATABASE_URL`, QStash keys, and `WORKER_SECRET` server-only.
5. Deploy and create the first operator account.
6. From `apps/leads-engine`, run `pnpm qstash:configure` once with `QSTASH_TOKEN` and `LEAD_ENGINE_BASE_URL`. It manages only the worker-tick schedule. Re-running updates the stable schedule ID instead of duplicating it.
7. Add `SLACK_OPS_ALERT_WEBHOOK_URL` as a Production Secret. Optional Config variables are `SLACK_ALERTS_ENABLED=true` and `SLACK_ALERT_COOLDOWN_MINUTES=30`. Ensure the worker schedule includes the signed final-failure callback.
8. When upgrading to v4, run `neon/migrations/202610150001_disable_campaign_schedules.sql` (schema 3.3.19) in the production Neon project: campaign schedule controls were removed, and the migration disables any persisted campaign schedules so nothing keeps collecting without an operator control.

## Free-tier operating guardrails

- Raw evidence is capped at 250 KB per fetch and extracted text at 100 KB. The worker compacts raw bodies after the approved retention period; content hashes, provenance, signals, and scores remain durable. Large evidence bodies are redacted from audit snapshots.
- Start with a conservative source budget and retention policy; watch Neon storage/compute and QStash daily messages in their dashboards.
- The scheduler is idempotent at both schedule and job levels. QStash retries cannot create duplicate logical jobs or leads.
- Vercel runtime logs and Sentry remain authoritative for operations; the in-app Operations section (on Overview) is the application control view.

## Compliance boundary

No automated LinkedIn scraping (public or authenticated), login automation, CAPTCHA bypass, access-control circumvention, or automated outreach sending is permitted. Sources remain blocked until an owner/administrator explicitly approves the policy.
