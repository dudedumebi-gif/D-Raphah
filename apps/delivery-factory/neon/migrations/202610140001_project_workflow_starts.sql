-- Project workflow starts (DF Intake begin, atomic reservation).
--
-- The manual begin on a project's Charter runs a published
-- lead_handoff workflow against the project's handoff package. The
-- first implementation adopted an existing run by reading
-- workflow_runs and then executing — a check-then-insert race: two
-- concurrent begins (or a begin racing the intake trigger) could
-- both observe "no run yet" and execute the workflow twice,
-- repeating its side effects. workflow_runs carries no uniqueness
-- guarantee for (workflow, environment, package), so the start
-- itself is reserved here instead: one row per (project, workflow),
-- claimed atomically with INSERT ... ON CONFLICT DO NOTHING.
--
-- State machine: 'reserved' (a claimant owns the start; run_id is
-- set once the run exists — for a run adopted from the intake
-- trigger it is set at claim time), 'completed' (the run finished
-- successfully; later begins adopt it), 'failed' (the run failed or
-- the start was abandoned; a later begin may claim the retry). A
-- 'reserved' row with no run_id whose claim is older than ten
-- minutes is a crashed claimant and may be reclaimed.

create table if not exists public.project_workflow_starts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.delivery_projects(id) on delete cascade,
  workflow_id uuid not null,
  package_id uuid not null,
  environment text not null,
  run_id uuid,
  state text not null check (state in ('reserved', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, workflow_id)
);
create index if not exists idx_project_workflow_starts_project
  on public.project_workflow_starts (project_id);

alter table public.project_workflow_starts enable row level security;

insert into public.schema_versions(service, version)
values ('delivery-factory', '1.4.0')
on conflict (service) do update set version = excluded.version, applied_at = now();
