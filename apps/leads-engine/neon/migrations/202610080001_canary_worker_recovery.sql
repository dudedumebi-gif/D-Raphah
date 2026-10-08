-- Repair production worker maintenance and enforce demo-mode canary isolation.

create or replace function public.prune_operational_history(p_now timestamptz)
returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer:=0; v_rows integer:=0;
begin
  delete from public.source_collection_reservations
    where reserved_at < p_now - interval '14 months';
  get diagnostics v_rows=row_count; v_count:=v_count+v_rows;
  delete from public.geocode_cache
    where resolved_at < p_now - interval '90 days';
  get diagnostics v_rows=row_count; v_count:=v_count+v_rows;
  delete from public.feedback_nonces where expires_at < p_now;
  get diagnostics v_rows=row_count; v_count:=v_count+v_rows;
  return v_count;
end $$;

-- Only reclassify sources used exclusively by canary jobs. A mixed-purpose
-- source requires explicit operator review instead of an implicit mode change.
update public.source_definitions s
set data_mode='demo'
where exists (
  select 1 from public.scrape_jobs j
  where j.source_id=s.id and j.canary_run_id is not null
)
and not exists (
  select 1 from public.scrape_jobs j
  where j.source_id=s.id and j.canary_run_id is null
);

update public.scrape_jobs
set data_mode='demo'
where canary_run_id is not null;

insert into public.schema_versions(service,version)
values('lead-engine','3.3.2')
on conflict(service) do update set version=excluded.version,applied_at=now();
