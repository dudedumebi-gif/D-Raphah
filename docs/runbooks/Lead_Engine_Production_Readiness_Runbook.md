# Lead Engine Production Readiness Runbook

## Purpose

This runbook moves Lead Engine v3 from a buildable release candidate to a production-approved service on Vercel Hobby, Neon Free, and Upstash QStash Free. Passing local tests is necessary but does not replace the database isolation test, live collection test, or 72-hour canary.

## Verified checkpoint — 2026-09-28

**Status: release candidate implemented; live gates pending; do not promote.** Code readiness does not replace disposable-Neon execution, genuine-token RLS proof, the deployed Postman lifecycle, or the 72-hour canary.

- Lead Engine and Delivery Factory typechecks and Vite production builds pass.
- The frozen-lockfile release regression has **364 passing tests**: Lead Engine 213, Delivery Factory 117, shared handoff contract 22, and legacy compatibility suites 12.
- The complete monorepo typecheck and build pass, and the static production-readiness verifier confirms CI builds, source budgets/pacing, audit coverage, scoring v2.1, readiness, and the Postman handoff lifecycle.
- Lead Engine schema `3.2.0`, Delivery Factory schema `1.1.0`, a genuine-token Data API/RLS harness, and job-lifecycle SQL assertions are prepared but **not executed against Neon in this release session**.
- `VERCEL_TOKEN` authentication and access to `d-raphah`, `d-raphah-leads-engine`, and `d-raphah-delivery-factory` were verified through the Vercel REST API using IPv4. The OAuth connector remains incorrectly scoped to an inaccessible team, so it is not accepted as deployment evidence. No environment mutation or production telemetry review has been performed.
- No 72-hour soak, persistent restart experiment, concurrent database integration test, or live Postman lifecycle has passed yet.

### Implemented hardening awaiting integration validation

- Source approval cannot be bypassed with direct authenticated table writes. Worker RPCs are server-role-only.
- Manual job replay preserves completed state and rejects a different request using the same key.
- Claim transactions serialize source selection; attempts start atomically under an owned lease. Worker invocation IDs are unique.
- Evidence, signals, organization, assessment, lead refresh, attempt completion, canary completion, and job completion commit in one lease-fenced Neon transaction. Raw evidence is content-addressed and capped at 250 KB in Postgres; extracted text is capped at 100 KB. Refresh does not reset commercial stage/status.
- Named-city criteria narrow region targeting. Radius calculations require unambiguous structured coordinates; missing coordinates fail closed. Named-place matching remains a heuristic, not a verified address.
- Weekly recommendations count distinct organizations per campaign and exclude canaries. Recommendations are volume-based and human-applied; outcome-quality calibration is not implemented yet.
- Canary evaluation requires 72 elapsed hourly slots, counts missing slots against completion, and rejects duplicate-only and future-completed evidence. At hourly cadence, one failed slot out of 72 is below 99%.
- The local mirror is versioned, actor-checked, and non-authoritative, following the React review guidance.

### Remaining live-evidence gates

1. Apply Lead Engine schema `3.2.0` and Delivery Factory schema `1.1.0` to disposable Neon branches, then production after SQL assertions pass.
2. Run database concurrency, restart, tenant-isolation, retry/DLQ, source-budget, and full-pipeline tests against the disposable branches.
3. Run Postman through qualified lead → human acceptance → signed Delivery Factory handoff and verify both audit streams.
4. Review deployed Vercel runtime logs and Sentry releases for both independent products.
5. Run the owned `/canary-source.html` hourly for 72 elapsed hours; require completion `>=99%` and scheduled-start p95 `<300,000 ms`.
6. Record the first genuine production lead and Delivery Factory receipt as release evidence.

These are code and integration gates, not merely missing credentials. A working Neon/QStash/Vercel connection does not by itself make this release production-ready.

## Architecture

```mermaid
flowchart TD
  UI["Authenticated React console"] --> API["Vercel API functions"]
  API --> DB["Neon Postgres + Data API RLS"]
  QSTASH["QStash signed schedules"] --> WORKER["Durable job worker"]
  WORKER --> WEB["Approved public sources"]
  WORKER --> DB
  API --> OBS["Vercel logs + Sentry"]
  POSTMAN["Postman inspection"] --> API
```

The job queue, attempts, leases, evidence metadata, signals, assessments, opportunities, and audit events are PostgreSQL records. A browser or worker restart therefore cannot erase work. The frontend's local storage contains only a last-known read mirror.

## Release gates

| Gate               | Verification                                                  | Required result                                            |
| ------------------ | ------------------------------------------------------------- | ---------------------------------------------------------- |
| Build integrity    | Typecheck, Vitest, Vite build                                 | All pass                                                   |
| Policy enforcement | Create source, try job before and after approval              | Pre-approval blocked; approved public source runs          |
| Full pipeline      | Source → evidence → signals → score → lead                    | Evidence and assessment persisted; qualifying lead appears |
| Restart durability | Queue job, interrupt worker, invoke next tick                 | Job remains and resumes/retries                            |
| Lease recovery     | Expire a leased fixture, invoke tick                          | Requeued or dead-lettered by attempt count                 |
| Idempotency        | Submit same `Idempotency-Key` twice                           | One job and one lead per workspace/organization            |
| RLS                | Run `pnpm test:rls:neon` with two genuine Auth tokens         | Isolation, denial, audit, worker-RPC denial pass           |
| Job transactions   | Run `job_lifecycle_v3.sql` and concurrent/restart experiments | Replay, lease ownership, expiry and durability verified    |
| Audit              | Mutate source, campaign, job, feedback                        | Trigger-generated audit event for each persisted mutation  |
| Retry/DLQ          | Use a controlled transient failure, then a permanent failure  | Backoff retry and manual DLQ recovery demonstrated         |
| Canary             | Hourly controlled scrape for 72 hours                         | At least 72 runs and completion `>=99%`                    |
| Scheduler SLO      | `/api/v1/operations`                                          | Start p95 `<300,000 ms`                                    |
| Telemetry          | Vercel errors plus Sentry release                             | No material unhandled runtime error                        |
| API inspection     | Postman production collection                                 | Auth, job lifecycle, SSE, audit, leads, SLO requests pass  |

## Provision Neon and QStash

1. In the personal Vercel Hobby scope, attach Neon and Upstash QStash Marketplace integrations to the Lead Engine project. Do not create a Vercel Team.
2. Enable Neon Auth and Data API, then apply every Lead Engine migration through `202609270001_source_budget_and_audit.sql` to a disposable branch in filename order.
3. Run `job_lifecycle_v3.sql` on that branch and `pnpm test:rls:neon` using two real Neon Auth sessions. Apply the migration to production only after both pass.
4. Set `LEAD_ENGINE_BASE_URL` and `QSTASH_TOKEN`, then run `pnpm qstash:configure`. Stable schedule IDs make the command safely repeatable.
5. Confirm QStash shows the five-minute worker schedule and hourly canary schedule, with signed delivery and three retries.

## Configure Vercel

Set these variables on the **Lead Engine project only**:

- `VITE_NEON_AUTH_URL`
- `VITE_NEON_DATA_API_URL`
- `NEON_AUTH_URL`
- `NEON_DATA_API_URL`
- `DATABASE_URL` (sensitive, server-only)
- `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` (sensitive, server-only)
- `HANDOFF_SIGNING_PRIVATE_KEY_PEM`, `HANDOFF_SIGNING_PUBLIC_KEY_PEM` (sensitive, server-only; Ed25519 key pair for signing handoff packages)
- `DELIVERY_INTAKE_URL` (Delivery Factory intake endpoint; when unset, signed handoffs queue in the outbox until it is set)
- `WORKER_SECRET` (optional sensitive key for Postman/manual diagnostics)
- `SENTRY_DSN` and `SENTRY_ENVIRONMENT=production`
- `LEAD_ENGINE_ORIGIN=https://d-raphah-leads-engine.vercel.app`

After the first approved canary source exists, add:

- `LEAD_ENGINE_CANARY_URL`
- `LEAD_ENGINE_CANARY_WORKSPACE_ID`
- `LEAD_ENGINE_CANARY_SOURCE_ID`

Redeploy after environment changes. Verify `/api/health/live` first. `/api/health/ready` intentionally returns `503` until the database is migrated and a worker heartbeat exists.

## Liveness and full-pipeline test

1. Create an operator account in the UI.
2. Register a public page controlled by Raphah. Use static HTML that contains deterministic manual-process and commercial-urgency phrases.
3. Confirm a job cannot be queued while the policy is pending.
4. Approve the policy as an owner/administrator.
5. Queue the target with a fixed `Idempotency-Key` in Postman.
6. Wait for the signed QStash tick or invoke the worker tick with the optional bearer `WORKER_SECRET` from Postman.
7. Inspect the job until it reaches `completed`.
8. Confirm: capped raw evidence, evidence row, signal rows, versioned maturity assessment, one organization, and—when thresholds are met—one opportunity.
9. Resubmit the same key and confirm the job and opportunity counts do not increase.

## Retry, dead letter, and lease recovery

- **Transient fixture:** return HTTP 429 or 503. Confirm `retrying`, a future `next_attempt_at`, and increasing attempt history.
- **Permanent fixture:** use a robots-denied path or unsupported policy method. Confirm `dead_letter` without uncontrolled retry.
- **Manual recovery:** correct the fixture, call `/api/v1/scrape-jobs/{id}/retry`, and confirm completion.
- **Expired lease:** in the test database set a leased job's `lease_expires_at` to the past, run the worker tick, and confirm `recover_expired_scrape_leases` moves it to `retrying` or `dead_letter`.

## 72-hour canary

The hourly QStash schedule inserts one canary and one scrape job per workspace/source/UTC hour with conflict-ignore semantics. Replays never reset existing results. Do not backfill missing hours to manufacture a pass. Include a configured location and sufficient manual-process evidence in the controlled fixture; a fetch without a qualified persistent lead is a failed canary.

Monitor:

- `/api/health/canary`
- `/api/v1/operations`
- Vercel runtime error clusters and function logs
- Sentry issues for the deployed release

Promotion is allowed only when `canary.passed=true`, completion is at least `0.99`, at least 72 hourly observations exist, and `jobs.scheduledStartTargetMet=true`.

## Rollback

1. Pause all campaigns (`schedule_enabled=false`).
2. Roll back the Vercel production deployment to the last known-good build.
3. Do not reverse a migration that would delete evidence, jobs, audit events, or assessments.
4. Apply a forward-fix migration for schema defects.
5. Preserve failed jobs and audit history for the incident review.

## Production decision

The release status remains **NOT PRODUCTION READY** until the remaining implementation gates, Neon/QStash provisioning, RLS execution, live pipeline evidence, Postman lifecycle execution, Vercel/Sentry review, and the 72-hour canary all pass. Do not replace the deployed UI with this unfinished parity implementation.

## Delivery feedback loop (Delivery Factory -> Lead Engine)

Delivery lifecycle events (`delivery.handoff.accepted`, `delivery.clarification.requested`,
`delivery.release.completed`, `delivery.project.closed`, ...) are enqueued in the Delivery
Factory's `feedback_outbox` and dispatched to the Lead Engine machine route
`POST /api/v1/feedback/events`. Authentication is Ed25519, the mirror image of handoff
signing: the factory signs `{ event, nonce, issuedAt }`; the Lead Engine verifies with the
factory's public key. The two products share no database and no credentials.

Set these variables on the **Delivery Factory project only**:

- `FEEDBACK_SIGNING_PRIVATE_KEY_PEM` (sensitive, server-only; factory Ed25519 private key)
- `LEAD_ENGINE_BASE_URL` (e.g. `https://d-raphah-leads-engine.vercel.app`)
- `DELIVERY_FACTORY_CRON_SECRET` (sensitive; bearer secret for the internal dispatch endpoint)

Set this variable on the **Lead Engine project only**:

- `DELIVERY_FACTORY_PUBLIC_KEY_PEM` (the factory public key below, `\n` escapes for single-line values)

```
-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAtCKCkpzUCBRA4DmIDWzBf0kamljtBlUus7sIvTzD3pI=\n-----END PUBLIC KEY-----
```

Create the dispatcher schedule once the QStash credential is valid:

```
qstash schedule create \
  --cron "*/5 * * * *" \
  --header "Authorization: Bearer $DELIVERY_FACTORY_CRON_SECRET" \
  https://<delivery-factory-app>/api/internal/dispatch-feedback
```

The dispatcher claims due rows with `FOR UPDATE SKIP LOCKED`, posts signed envelopes with a
15s timeout, and applies exponential backoff with jitter (6h cap, 10 attempts). Terminal
client errors (400/401/409/422) fail the row immediately; 5xx/429/network errors reschedule.
Event inserts on the Lead Engine are idempotent on the contract's `eventId`, so a retried
dispatch after a lost response is acknowledged as a duplicate, not stored twice.
