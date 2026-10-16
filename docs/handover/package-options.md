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

## Option B — Google Cloud Run (portable target, Delivery Factory only)

**What the client gets:** the Delivery Factory container image + its Cloud
SQL (Postgres) instance. The Lead Engine is **not** part of this option:
its container runtime (`apps/leads-engine/Dockerfile` + `server/adapter.ts`)
was retired in LE v4 (2026-10-15) as unused — the Lead Engine runs on
Vercel + Neon (Option A), and a portable Lead Engine target would first
need that runtime rebuilt.

- `apps/delivery-factory/Dockerfile` builds a self-contained image; its
  `server/adapter.ts` runs the exact same `api/` handlers as Vercel, so
  behavior is identical.
- Deploy: `gcloud run deploy delivery-factory --source apps/delivery-factory`,
  Cloud SQL Postgres, Secret Manager for key material.
- The Lead Engine stays on Option A and keeps posting handoffs to the
  Delivery Factory's public intake URL.

**Pros:** client-owned GCP project for the delivery side, portable,
predictable pricing.
**Cons:** split operations (DF on GCP, LE managed); client needs basic GCP
ops (or a managed-services partner).
**Best for:** clients with a GCP footprint or data-residency requirements
for the delivery workload.

## Option C — Self-hosted single VM / on-prem

**What the client gets:** `deploy/docker-compose.yml` + `deploy/.env.example`.

- One `docker compose up --build -d` runs the Delivery Factory and its
  Postgres database (separate volume, credentials, and healthcheck). The
  Lead Engine is not in the stack since LE v4 — it runs on Vercel + Neon
  and posts handoffs to the factory's intake URL.
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
2. **Portable target: Option B covers the Delivery Factory.** The Lead
   Engine's container runtime was retired in LE v4; if a client needs the
   Lead Engine off Vercel/Neon, that runtime must be rebuilt first — it is
   a project, not a redeploy.
3. **Demos/pilots: Option C** for a one-command local Delivery Factory stack
   against the managed Lead Engine.

## Handover checklist (all options)

- [ ] Fresh Ed25519 handoff + feedback keypairs generated for the client's environment
- [ ] Database passwords rotated; connection strings in the client's secret store only
- [ ] QStash token configured (Lead Engine worker tick + Delivery Factory feedback dispatch schedules)
- [ ] `docs/handover/env-checklist.md` filled and signed off
- [ ] Worker tick delivering and `/api/health/ready` green on the client's instance
- [ ] Runbooks walked through with the client's operator (`docs/runbooks/`)
- [ ] Backup/restore drill completed against the client's database
