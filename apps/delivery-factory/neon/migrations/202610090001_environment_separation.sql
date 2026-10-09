-- Environment separation (DF full sequence, Phase 0).
--
-- Delivery Factory records gain a real environment dimension —
-- 'demo' | 'production' — replacing the cosmetic "Pilot demo" label: until
-- now the demo workspace's workflows were the same global backend rows as
-- everything else, separated only by a badge and browser-local sample data.
--
-- * workflows / workflow_runs / delivery_projects / handoff_inbox gain an
--   `environment` column defaulting to 'production', so every existing row
--   keeps its current (real) meaning.
-- * The pilot's seeded demo workflows (created_by = 'seed') are
--   reclassified as demo fixtures.
-- * Intake stamps each accepted package with the environment scope derived
--   from the intake deployment environment (api/_lib/verify.ts): production
--   deployments accept into 'production'; local/preview/test deployments
--   accept into 'demo'. lead_handoff automation only fires inside the
--   matching scope, so a test handoff can never trigger production
--   automation and a production handoff never lands in the demo scope.

alter table public.workflows
  add column if not exists environment text not null default 'production';
alter table public.workflow_runs
  add column if not exists environment text not null default 'production';
alter table public.delivery_projects
  add column if not exists environment text not null default 'production';
alter table public.handoff_inbox
  add column if not exists environment text not null default 'production';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'workflows_environment_check') then
    alter table public.workflows
      add constraint workflows_environment_check
      check (environment in ('demo', 'production'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workflow_runs_environment_check') then
    alter table public.workflow_runs
      add constraint workflow_runs_environment_check
      check (environment in ('demo', 'production'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'delivery_projects_environment_check') then
    alter table public.delivery_projects
      add constraint delivery_projects_environment_check
      check (environment in ('demo', 'production'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'handoff_inbox_environment_check') then
    alter table public.handoff_inbox
      add constraint handoff_inbox_environment_check
      check (environment in ('demo', 'production'));
  end if;
end $$;

-- The seeded pilot workflows are demo fixtures, not production automations.
update public.workflows set environment = 'demo' where created_by = 'seed';

create index if not exists workflows_environment_idx
  on public.workflows(environment);
create index if not exists workflow_runs_environment_idx
  on public.workflow_runs(environment);
create index if not exists delivery_projects_environment_idx
  on public.delivery_projects(environment);
create index if not exists handoff_inbox_environment_idx
  on public.handoff_inbox(environment);

insert into public.schema_versions(service, version)
values ('delivery-factory', '1.2.0')
on conflict (service) do update set version = excluded.version, applied_at = now();
