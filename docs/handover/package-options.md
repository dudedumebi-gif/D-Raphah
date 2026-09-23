# Client handover — package options

How the D-Raphah platform (Lead Engine + Delivery Factory) is handed over to
the client. The platform is two independent services behind a versioned HTTPS
contract (`POST /api/intake` + feedback events); that boundary is what makes
every option below deployable without cross-service rewrites.

## Option A — Managed handover (recommended for go-live)

**What the client gets:** their own Vercel team + Neon projects, deployed from
this repo, with a filled-in environment checklist.

- Lead Engine → Vercel project `d-raphah-leads-engine` (+ Neon `raphah-lead-engine`)
- Delivery Factory → Vercel project `d-raphah-delivery-factory` (+ Neon `raphah-delivery-factory`)
- Handover = Vercel/Neon team transfer + `docs/handover/env-checklist.md` + runbooks.

**Pros:** zero ops, scales to zero, previews per PR, Neon branching for safe
migrations, QStash schedules already specified. Fastest path to "live tomorrow".
**Cons:** usage-based cost at scale; vendor-specific (mitigated by Option B as
the exit ramp).
**Best for:** the current launch — the system is already live on this stack.

## Option B — Google Cloud Run (recommended portable target)

**What the client gets:** two container images + their Cloud SQL (Postgres)
instances, or one project with two databases.

- `apps/leads-engine/Dockerfile` and `apps/delivery-factory/Dockerfile`
  build self-contained images; `server/adapter.ts` runs the exact same `api/`
  handlers as Vercel, so behavior is identical.
- Deploy: `gcloud run deploy leads-engine --source apps/leads-engine` (and
  delivery-factory), Cloud SQL Postgres x2, Secret Manager for key material.
- Scheduler: Cloud Scheduler → `POST /api/v1/worker/tick` (replaces QStash).

**Pros:** client-owned GCP project, portable, predictable pricing, no
Vercel/Neon lock-in; the Dockerfiles are already in the repo.
**Cons:** client needs basic GCP ops (or a managed-services partner).
**Best for:** clients with a GCP footprint or data-residency requirements.

## Option C — Self-hosted single VM / on-prem

**What the client gets:** `deploy/docker-compose.yml` + `deploy/.env.example`.

- One `docker compose up --build -d` runs both services and both Postgres
  databases with separate volumes, credentials, and healthchecks.
- Handover = the compose file, the `.env` template, and the runbook.

**Pros:** simplest possible handover; works air-gapped; fixed cost (one VM).
**Cons:** single host = single point of failure; backups/updates are manual.
**Best for:** pilots, demos, and clients who want a button they can press.

## Option D — Source + runbooks (technical clients)

**What the client gets:** the repo, ADRs, runbooks, and migration history; they
choose the target.

**Best for:** clients with their own platform team.

## Recommendation

1. **Now (go-live): Option A.** It is already deployed and validated; hand over
   the Vercel/Neon projects with the env checklist and runbooks.
2. **In parallel: keep Option B warm.** The Dockerfiles and adapter exist and
   are cheap to maintain — every deploy to Vercel also `docker build`s in CI
   to prove the images stay working. When the client is ready, the move to
   Cloud Run is a redeploy, not a rewrite.
3. **Demos/pilots: Option C** for a one-command local stack.

## Handover checklist (all options)

- [ ] Fresh Ed25519 handoff + feedback keypairs generated for the client's environment
- [ ] Database passwords rotated; connection strings in the client's secret store only
- [ ] QStash token / Cloud Scheduler configured (3 schedules: worker tick, canary, feedback dispatch)
- [ ] `docs/handover/env-checklist.md` filled and signed off
- [ ] 72-hour canary observed green on the client's instance
- [ ] Runbooks walked through with the client's operator (`docs/runbooks/`)
- [ ] Backup/restore drill completed against the client's database
