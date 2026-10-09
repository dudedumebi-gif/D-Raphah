-- Project charter KPIs (DF full sequence, Phase 1).
--
-- A delivery project's charter is seeded from the LeadEngineHandoffPackage
-- it was accepted from: the package stays the source of truth (stored on
-- handoff_inbox), and the project's success measures — the package's
-- `successMeasures` (metric + target) — are restated here as testable KPI
-- rows at intake time. After the automation ships, an operator verifies
-- each KPI against real run/audit data and records the verdict (met /
-- missed, the measured value, and the evidence note) on the row. A miss
-- is a finding on the project, not a silent number.

create table if not exists public.project_kpis (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.delivery_projects(id) on delete cascade,
  metric text not null,
  target text not null,
  measurement text not null,
  status text not null default 'pending' check (status in ('pending', 'met', 'missed')),
  measured_value text,
  verify_note text,
  verified_by text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_kpis_project_idx
  on public.project_kpis(project_id);

-- KPI rows are business state: capture them in the delivery audit stream
-- like every other business table (see 202609270001_delivery_audit.sql).
do $$
begin
  if to_regclass('public.project_kpis') is not null then
    execute 'drop trigger if exists audit_project_kpis on public.project_kpis';
    execute 'create trigger audit_project_kpis after insert or update or delete on public.project_kpis for each row execute function public.capture_delivery_audit_event()';
  end if;
end $$;

-- Backfill: restate success measures as KPIs for projects accepted before
-- this migration (their packages already carry the measures).
insert into public.project_kpis (project_id, metric, target, measurement)
select
  p.id,
  m ->> 'metric',
  m ->> 'target',
  'Verified by the operator against Delivery Factory workflow run history and the delivery audit log for this project.'
from public.delivery_projects p
join public.handoff_inbox i on i.id = p.inbox_id
cross join lateral jsonb_array_elements(
  coalesce(i.package -> 'successMeasures', '[]'::jsonb)
) as m
where jsonb_typeof(coalesce(i.package -> 'successMeasures', '[]'::jsonb)) = 'array'
  and coalesce(m ->> 'metric', '') <> ''
  and not exists (
    select 1 from public.project_kpis k where k.project_id = p.id
  );

insert into public.schema_versions(service, version)
values ('delivery-factory', '1.3.0')
on conflict (service) do update set version = excluded.version, applied_at = now();
