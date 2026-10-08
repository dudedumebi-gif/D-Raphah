# Raphah Lead Engine v3

Production-oriented web application for permitted-source discovery, evidence capture, automation-maturity scoring, durable scrape jobs, and human-reviewed lead qualification.

**Implementation complete — not production approved.** See the repository-level `PRODUCTION_README.md` and `docs/runbooks/Lead_Engine_Production_Readiness_Runbook.md` for migration, source-licence acceptance, live proof, and canary gates. Do not promote Pilot data until those gates pass.

## Runtime architecture

- **Vite/React UI** — Neon Auth, policy/source management, Toronto/Job Bank/Overpass discovery, persistent candidates, scrape lifecycle, lead review, criteria, audit, operational SLOs, and visibly separate Demo/Pilot/Production views.
- **Vercel Hobby Functions** — authenticated API, collection worker, and canary endpoint. No Pro/Teams capability is required.
- **Neon Free** — PostgreSQL source of truth, Data API RLS tenant boundary, Auth, database audit triggers, and capped evidence payloads.
- **Upstash QStash Free** — signed four-minute worker dispatch, independent five-minute alert evaluation, hourly canary dispatch, retries, and signed final-failure callbacks. This replaces Vercel Cron because Hobby Cron is limited to daily execution.
- **Local storage** — read-only last-known workspace mirror. It is never authoritative and never drives the worker.
- **Vercel + Sentry** — authoritative build/runtime and exception telemetry. Slack receives transition-based operational alerts; Postman is an inspection client.

## Local checks

```bash
pnpm --filter @raphah/leads-engine-app typecheck
pnpm --filter @raphah/leads-engine-app test
pnpm --filter @raphah/leads-engine-app build
```

## Provisioning order

1. In the personal Vercel Hobby scope, add a Neon integration and an Upstash QStash integration to the Lead Engine project. Do not create or use a Vercel Team.
2. In Neon, enable Auth and the Data API. Apply every migration under `neon/migrations/` in timestamp order against a disposable branch first, ending with schema `3.3.3`; apply to production only after rehearsal.
3. Run `neon/tests/job_lifecycle_v3.sql` and `neon/tests/rls_behavior_v3.sql` against the disposable branch, then run `pnpm test:rls:neon` with two genuine Neon Auth sessions through the Data API. CI can obtain fresh sessions from two dedicated synthetic users through protected email/password secrets; short-lived tokens are also accepted for ad hoc local runs.
4. Configure the variables in `.env.example` in the Lead Engine Vercel project. Keep `DATABASE_URL`, QStash keys, and `WORKER_SECRET` server-only.
5. Deploy, create the first operator account, then approve the Raphah-controlled `/canary-source.html` fixture as a static-HTML source. Never substitute a third-party page for this deterministic production probe.
6. Set the three `LEAD_ENGINE_CANARY_*` variables and redeploy.
7. From `apps/leads-engine`, run `pnpm qstash:configure` once with `QSTASH_TOKEN` and `LEAD_ENGINE_BASE_URL`. Re-running updates the stable schedule IDs instead of duplicating them.
8. Import the two files under `postman/`, paste a Neon Auth access token, and run the lifecycle collection. The optional worker diagnostic uses `WORKER_SECRET`; normal dispatch remains QStash-signed.
9. Begin the 72-hour release canary. Production promotion requires `>=99%` completion and scheduled-start p95 `<5 minutes`.
10. Add `SLACK_OPS_ALERT_WEBHOOK_URL` as a Production Secret. Optional Config variables are `SLACK_ALERTS_ENABLED=true` and `SLACK_ALERT_COOLDOWN_MINUTES=30`. Reconfigure QStash so every schedule includes the signed final-failure callback.

## Free-tier operating guardrails

- Raw evidence is capped at 250 KB per fetch and extracted text at 100 KB. The worker compacts raw bodies after the approved retention period; content hashes, provenance, signals, and scores remain durable. Large evidence bodies are redacted from audit snapshots.
- Start with a conservative source budget and retention policy; watch Neon storage/compute and QStash daily messages in their dashboards.
- The scheduler is idempotent at both schedule and job levels. QStash retries cannot create duplicate logical jobs or leads.
- Postman is a diagnostic client, not operational telemetry. Vercel runtime logs and Sentry remain authoritative.

## Compliance boundary

No automated LinkedIn scraping (public or authenticated), login automation, CAPTCHA bypass, access-control circumvention, or automated outreach sending is permitted. Sources remain blocked until an owner/administrator explicitly approves the policy.
