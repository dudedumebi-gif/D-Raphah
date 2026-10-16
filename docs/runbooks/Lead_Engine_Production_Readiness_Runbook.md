# Lead Engine Production Readiness Runbook — RETIRED in LE v4

This runbook governed the original go-live readiness gate. That gate
**completed on 2026-10-11**: the 72-hour canary soak passed at 72/72,
all release-decision checks passed, and the owner approved production.

Its procedures are obsolete in LE v4 (2026-10-15):

- the hourly canary subsystem it provisions (including the
  `LEAD_ENGINE_CANARY_*` variables and the `/api/health/canary`
  endpoint) was retired once the gate had passed;
- the Postman collection it uses for inspection was removed from the
  repository;
- alert evaluation no longer runs on an independent schedule — the
  worker tick runs the alert/incident reconcile.

For current provisioning and operations, use:

- `apps/leads-engine/README.md` — runtime architecture, provisioning
  order, and the v4 upgrade step (migration
  `202610150001_disable_campaign_schedules.sql`);
- `docs/handover/env-checklist.md` — per-environment variable and
  schedule checklist;
- `apps/leads-engine/docs/runbooks/operations-alerting.md` — alert
  types and operator responses.

The pre-retirement text remains available in git history.
