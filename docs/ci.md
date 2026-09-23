# CI

`.github/workflows/ci.yml` is the monorepo's path-aware pipeline. It triggers on
pushes to `feat/product-platform-design` and on pull requests. Concurrent runs on
the same branch cancel each other (`cancel-in-progress`).

## Path map

The `changes` job computes which areas changed; each job below only runs when its
paths changed. Changes to `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
or `.github/workflows/**` re-run everything.

| Changed paths | Jobs that run |
|---|---|
| `apps/leads-engine/**` | Lead Engine (test + typecheck), Contract compatibility (if contract usage files changed) |
| `apps/delivery-factory/**` | Delivery Factory (test + typecheck + build), Contract compatibility (if contract usage files changed) |
| `packages/handoff-contract/**` | Handoff contract (test + build), Lead Engine, Delivery Factory, Contract compatibility |
| `lead-engine/**`, `delivery-tool/**` | Legacy apps (tests only) |
| Contract usage: `apps/leads-engine/server/handoff.ts`, `apps/leads-engine/tests/handoff.test.ts`, `apps/delivery-factory/api/**`, `apps/delivery-factory/tests/intake.test.ts` | Contract compatibility |

Two jobs always run:

- **Repo hygiene** — `pnpm-lock.yaml` must exist; no `package-lock.json`/`yarn.lock`
  tracked; no `node_modules/`, `dist/`, or `build/` committed.
- **Frozen install** — every test job runs `pnpm install --frozen-lockfile`, which
  fails if the lockfile is stale relative to the manifests.

## Notes

- No deployment jobs and no secrets: CI is test/typecheck/build only.
- The Handoff contract package is a `workspace:*` dependency of both apps, so a
  contract change re-runs both apps' full suites, not just the compatibility job.
- Contract compatibility runs the contract package's schema-fixture tests plus the
  focused boundary tests: Lead Engine `tests/handoff.test.ts` (emission/signing)
  and Delivery Factory `tests/intake.test.ts` (verification).
