# Backup & Restore Drill — Lead Engine

Cadence: **quarterly**. Owner: the operator on call. Goal: prove we can
recover the Lead Engine database from a Neon point-in-time backup before
we ever need to.

## What Neon gives us

- **Automated backups** of every branch, retained per the project plan.
- **Point-in-time restore (PITR)**: create a new branch from any retained
  recovery point, then promote it. The primary database is never touched
  by a restore — the restored branch is a separate copy.
- Restores happen in the Neon console: **Project → Branches → Restore**.

No CLI or agent step performs a restore in production; this runbook is a
human console procedure plus verification queries.

## Drill procedure

1. **Pick a recovery point.** In the Neon console (project
   `d-raphah-leads-engine`), open the primary branch and choose a point
   at least 1 hour in the past (so in-flight worker writes have settled).
2. **Restore to a new branch** named `restore-drill-YYYY-MM-DD`. Do not
   restore over the primary branch.
3. **Connect the drill branch** with a read-only or ephemeral connection
   (Neon SQL editor is enough — no app reconfiguration).
4. **Run the verification queries** below against the drill branch.
5. **Compare row counts** against the primary branch for the same
   tables. Counts should match the recovery point (within the lag between
   the point and now — recent worker ticks only).
6. **Delete the drill branch** when verification passes. A drill branch
   left alive consumes storage quota.

## Verification queries

```sql
-- Schema version the app expects
select version from public.schema_versions where service = 'lead-engine';

-- Core tables exist and are populated
select
  (select count(*) from public.workspaces) as workspaces,
  (select count(*) from public.source_definitions) as sources,
  (select count(*) from public.scrape_jobs) as jobs,
  (select count(*) from public.opportunities) as opportunities,
  (select count(*) from public.audit_events) as audit_events,
  (select count(*) from public.consent_records) as consent_records,
  (select count(*) from public.alert_log) as alert_log,
  (select count(*) from public.terms_acceptances) as terms_acceptances;

-- RLS is enabled where the app depends on it
select tablename
from pg_tables
where schemaname = 'public'
  and tablename in (
    'workspaces', 'source_definitions', 'scrape_jobs', 'opportunities',
    'audit_events', 'consent_records', 'alert_log', 'terms_acceptances',
    'discovery_sources', 'discovery_runs'
  )
  and rowsecurity = false;
-- Expect zero rows.
```

## Real-incident restore (not a drill)

1. Restore to a new branch from the last known-good recovery point.
2. Verify with the queries above.
3. Point the app at the restored branch by updating `DATABASE_URL` on the
   Vercel project and triggering a **fresh deployment** (a redeploy does
   not pick up changed env vars).
4. Re-run the three QStash schedules' first tick manually and confirm the
   worker heartbeat is fresh on `/api/health/ready`.
5. File a post-incident note: what was lost (writes between the recovery
   point and the cutover are gone — the outbox and idempotency keys make
   re-running safe).

## Operator checklist (sign after each drill)

- [ ] Drill branch created from a recovery point ≥ 1h old
- [ ] Verification queries run against the drill branch
- [ ] Row counts reconciled with the primary branch
- [ ] RLS-enabled table check returned zero rows
- [ ] Drill branch deleted
- [ ] Date, operator, and recovery-point timestamp recorded below

### Drill log

| Date | Operator | Recovery point (UTC) | Result |
|------|----------|----------------------|--------|
|      |          |                      |        |
