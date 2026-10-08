# Raphah Lead Engine — Production README

Last updated: 2026-10-08

Target release: Lead Engine schema/API `3.3.4`

Status: **pilot release candidate deployed; production database migrated; telemetry and live soak gates remain**

This is the operational handover for the Lead Engine’s permitted-source discovery pipeline. It records what is implemented, what must remain human-controlled, and the exact gates for moving Pilot data into Production. Source authorization and Pilot-to-Production promotion remain explicit human decisions.

## Delivered in this release

- Toronto Open Data and Canada Job Bank adapters, in addition to OpenStreetMap/Overpass.
- Central adapter and terms registry; every adapter is blocked until its own terms record is accepted by an owner or administrator.
- Persistent `discovery_candidates`, including records without a website, provenance, original structured record, resolution state, and first/last-seen timestamps.
- Structured source evidence is joined with permitted website evidence before signal detection and automation-maturity scoring.
- Durable candidate-to-job and candidate-to-organization lineage.
- Mode-scoped source, campaign, discovery, job, evidence, signal, organization, assessment, opportunity, and feedback records.
- Visually separate **Demo**, **Pilot**, and **Production** views. The browser retains only a read-only bootstrap mirror; Neon remains authoritative.
- Mode-scoped idempotency and deduplication so retries and duplicate schedules do not create duplicate leads.
- Explicit `allow_discovered_domains` policy authorization. Discovery sources cannot be registered unless their linked collection source has an approved policy with this capability; the worker adds only the candidate's actual hostname and never a wildcard.
- Audit triggers for new candidate, checkpoint, and source-link records.
- Postman requests for terms, adapter registration, runs, candidates, and the mode-specific funnel.
- RLS verification extended to discovery candidates.
- Stateful production incidents for stale workers, stuck/failed canaries,
  dead-letter jobs, target mismatch, scheduled-start p95, exhausted QStash
  delivery, and the passed 72-hour soak. Neon persists and audits every
  transition; Slack receives opens, cooldown reminders, and recoveries.

## Source adapters

| Adapter                  | Registry ID         | Terms ID                    | Purpose                                                           | Default guardrails                                       |
| ------------------------ | ------------------- | --------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| OpenStreetMap / Overpass | `overpass`          | `overpass-osm`              | Discover public business places and websites by radius            | 200 candidates/run, 60-second upstream timeout           |
| Toronto Open Data        | `toronto_open_data` | `toronto-open-data`         | Discover Toronto businesses from municipal licence/permit records | Active records, category filters, bounded record count   |
| Canada Job Bank          | `job_bank`          | `canada-job-bank-open-data` | Detect employers with hiring/process/tooling signals              | City/region, keywords, posting age, bounded record count |

Official source catalogue pages:

- Toronto Open Data: <https://open.toronto.ca/catalogue/>
- Job Bank open dataset: <https://open.canada.ca/data/en/dataset/ea639e28-c0fc-48bf-b5dd-b8899bd43072>

The operator must review the current licence and source terms immediately before acceptance. The software records acceptance; it does not make the legal/commercial decision.

## Data environments

| Mode         | Intended use                                           |                      Live collection | Promotion rule                        |
| ------------ | ------------------------------------------------------ | -----------------------------------: | ------------------------------------- |
| `demo`       | Fixtures, demonstrations, deterministic canary records |             Controlled fixtures only | Never promoted automatically          |
| `pilot`      | Real adapter validation with bounded scope             | Only after terms and policy approval | Operator-reviewed migration/promotion |
| `production` | Approved revenue pipeline                              |    Yes, after all release gates pass | Explicit operator action only         |

Existing non-canary records are classified as `pilot`. Canary jobs become `demo`. The migration performs **no implicit production promotion**.

## Pipeline

1. A configured adapter reads an approved public dataset within its geographic and record limits.
2. Every discovered record is upserted into `discovery_candidates`; candidates without websites remain visible as `unresolved`.
3. Resolved websites are deduplicated by normalized URL and queued with a mode-scoped idempotency key. When an official dataset has no website, an operator uses the audited **Resolve website** action; resolution and enqueue occur atomically.
4. The linked collection source must be active, approved, mode-matched, and explicitly permit discovered public domains. This capability is human-approved and never implies wildcard collection.
5. QStash invokes the worker; Neon leases the job and safely recovers expired leases.
6. The worker adds only the candidate's hostname to the in-memory policy for that candidate-linked job, then enforces the usual HTTP(S), public-DNS, LinkedIn block, robots, path, rate, size, and budget controls before collection.
7. Evidence produces explainable signals, geography evaluation, maturity/opportunity scores, and—when qualified—a persistent opportunity.
8. The database links the candidate to the organization and emits audit records for state changes.
9. Human-reviewed leads may be emitted to Delivery Factory through the signed, versioned handoff outbox.

## Required environment variables

Use `apps/leads-engine/.env.example` as the canonical list. Critical production secrets are server-only:

- `DATABASE_URL` (Neon pooled connection)
- `NEON_AUTH_URL`, `NEON_DATA_API_URL`
- `VITE_NEON_AUTH_URL`, `VITE_NEON_DATA_API_URL` (browser-safe endpoints only)
- `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`
- `HANDOFF_SIGNING_PRIVATE_KEY_PEM`, `HANDOFF_SIGNING_PUBLIC_KEY_PEM`
- `DELIVERY_INTAKE_URL`, `DELIVERY_FACTORY_PUBLIC_KEY_PEM`
- `WORKER_SECRET` (optional Postman/manual diagnostic only)
- `SENTRY_DSN`, `SENTRY_ENVIRONMENT`
- `LEAD_ENGINE_CANARY_URL`, `LEAD_ENGINE_CANARY_WORKSPACE_ID`, `LEAD_ENGINE_CANARY_SOURCE_ID`

Never place database URLs, signing keys, QStash credentials, or `WORKER_SECRET` in a `VITE_*` variable.

## Migration and promotion procedure

The user/operator will execute this after implementation review.

1. Create a disposable Neon branch from the target database.
2. Apply all migrations in timestamp order, ending with:
   `apps/leads-engine/neon/migrations/202610080001_canary_worker_recovery.sql`.
3. Run:

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
     -f apps/leads-engine/neon/tests/job_lifecycle_v3.sql
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
     -f apps/leads-engine/neon/tests/rls_behavior_v3.sql
   pnpm --filter @raphah/leads-engine-app test:rls:neon
   ```

4. Confirm schema version `3.3.4`, expected indexes, RLS policies, and audit triggers.
5. Deploy the application against the disposable branch and exercise both adapters in `pilot` mode.
6. Create the linked collection source with **Permit public domains discovered by approved adapters** selected, then approve its policy. Registering an adapter without this explicit permission must fail.
7. Review candidate provenance, unresolved candidates, deduplication, evidence, signals, score explanations, retries, and audit events.
8. Apply the migration to the production Neon database only after the branch rehearsal passes.
9. Keep all rows in `pilot`; explicitly create/approve new `production` sources and discovery configurations. Do not relabel pilot rows in bulk without a reviewed data migration.

## Human source acceptance

After reviewing the live terms, an owner/administrator can use the UI or:

```http
POST /api/v1/terms/accept
X-Workspace-ID: <workspace UUID>
Authorization: Bearer <Neon Auth token>
Content-Type: application/json

{"termsId":"toronto-open-data","notes":"Human-reviewed acceptance reference"}
```

Repeat with `canada-job-bank-open-data`. Terms acceptance is workspace-specific, versioned, and audited. Do not accept terms from a scheduler, migration, or CI job.

## Verification commands

```bash
pnpm --filter @raphah/leads-engine-app typecheck
pnpm --filter @raphah/leads-engine-app test
pnpm --filter @raphah/leads-engine-app build
pnpm test
pnpm build
pnpm release:verify
```

Postman artifacts:

- `apps/leads-engine/postman/Lead_Engine_Production.postman_collection.json`
- `apps/leads-engine/postman/Lead_Engine_Production.postman_environment.json`

Postman is an inspection client. Vercel logs/traces and Sentry are the authoritative operational telemetry.

### Verified Neon rehearsal evidence — 2026-09-30

- Schema `3.3.1`, the complete migration footprint, RLS enablement, policies, and audit triggers were verified on the `lead-engine-adapters-rehearsal` branch.
- `job_lifecycle_v3.sql` passed all **15/15** assertions, including source-scoped leasing, duplicate schedule idempotency, ownership fencing, expired-lease recovery, retry, and dead-letter behavior.
- `rls_behavior_v3.sql` passed all **13/13** assertions using PostgreSQL's `authenticated` role and JWT-claim context, including tenant read/write isolation, fail-closed missing claims, audit visibility, queue idempotency, and denial of worker lease RPCs.
- Neon Auth and the Data API are enabled on the rehearsal branch. The separate two-genuine-session Data API test remains mandatory because it proves the HTTP/Auth integration in addition to the database policies.
- Production is at schema `3.3.4`; schema migration does not promote Pilot rows into Production mode.

For the genuine-session CI run, configure protected secrets `NEON_RLS_DATABASE_URL`, `NEON_AUTH_URL`, `NEON_DATA_API_URL`, `NEON_RLS_TEST_USER_A_EMAIL`, `NEON_RLS_TEST_USER_A_PASSWORD`, `NEON_RLS_TEST_USER_B_EMAIL`, and `NEON_RLS_TEST_USER_B_PASSWORD`. The two accounts must be dedicated synthetic users with different identities. Short-lived JWT inputs remain supported for one-off local runs but should not be stored as durable CI secrets.

### Genuine-session UI evidence — 2026-10-07

- Synthetic Account A authenticated through Neon Auth and loaded only workspace `890cbeb9-84c7-49a4-bb4b-df14e3b087ec`.
- Synthetic Account B authenticated through Neon Auth and loaded only workspace `77fc4cef-b628-4a1d-a0c5-6a3d75db33ea`.
- Both accounts received successful Preview bootstrap responses against the rehearsal database.
- This proves independent positive-session initialization. The release gate remains open until the automated Data API test also proves that each genuine session is denied access to the other account's workspace.

### Production cutover evidence — 2026-10-08

- Toronto Open Data `ogl-toronto-1.0@2026-09-29` and Canada Job Bank `ogl-canada-2.0@2026-09-29` were accepted by `dudedumebi@gmail.com` for the production workspace and are stored in the audited `terms_acceptances` table.
- Neon production migrated from schema `3.1.0` through `3.3.4`, including canary worker recovery, stateful operational incidents, and the audited legacy-alert correction. Required tables, RLS enablement, policies, audit triggers, function privileges, and acceptance records passed post-migration inspection.
- Recovery points are snapshot `snap-curly-dust-avqzu2b4` (pre-3.3.1) and no-compute branch `br-bold-mountain-av2njseg` (pre-3.3.2).
- PR #16 delivered the adapters and reviewed acceptance dialog; PR #17 repaired the schema compatibility guard; PR #18 repaired retention and demo-mode canary isolation; PR #20 added stateful Slack operations alerts. Each merged only after green CI and green Lead Engine Preview deployment.
- Production Lead Engine deployment `7bf334cc64213588bd8d695c8eafcdb940e49930` is live. The repaired worker completed a previously stuck canary, and stale pre-soak work remains failed/dead-letter history with audit events rather than active incidents.
- The 72-hour soak is in progress. At the 2026-10-08 verification snapshot it had 4/72 completed runs (5.56%) with p95 completion near 303 seconds, so the release correctly remains Pilot.

## Production release gates

- [x] Toronto Open Data terms reviewed and accepted by a human operator.
- [x] Canada Job Bank terms reviewed and accepted by a human operator.
- [x] Migration rehearsed on a disposable Neon branch.
- [x] Production Neon migrated and verified at schema `3.3.4`.
- [x] Rehearse and apply operational-incident migrations through `3.3.4`.
- [ ] Reconfigure all QStash schedules with the signed final-failure callback and four-minute worker cadence.
- [ ] Verify one disposable Slack incident open and recovery in `#ops-alert` without exposing secrets.
- [x] Database-role RLS behavior passes all 13 assertions.
- [ ] Two-user Data API RLS isolation test passes.
- [ ] One permitted source completes discovery → candidate → evidence → signals → score → persistent lead.
- [ ] Restart test proves jobs/results survive process replacement.
- [x] Expired lease recovery is demonstrated in the transactional lifecycle suite.
- [ ] Duplicate schedule delivery produces no duplicate candidate, job, organization, or opportunity.
- [ ] Retry and dead-letter recovery are demonstrated and audited.
- [ ] Signed versioned Delivery Factory handoff and replay protection pass.
- [ ] 72-hour canary completion is at least 99%.
- [ ] Scheduled-run start p95 is below five minutes.
- [x] Vercel production deployment is Ready with no material build/runtime errors.
- [ ] Sentry shows no unresolved release-blocking exceptions.

Until every box is checked, the release remains Pilot and must not be represented as production-ready.

## Rollback

Application rollback: promote the last known-good Vercel deployment.

Scheduler rollback: pause the QStash discovery/worker schedules; do not delete job or audit rows.

Database rollback: restore or switch back to the pre-migration Neon branch. Because the migration creates data-mode columns and lineage tables, prefer branch rollback/restore over destructive down migrations.

## Compliance boundary

No automated LinkedIn scraping, authenticated scraping, CAPTCHA bypass, access-control circumvention, or automated outreach sending is included. Collection is restricted to approved public sources and approved policies, with rate, path, record-count, retention, evidence, audit, and human-review controls.
