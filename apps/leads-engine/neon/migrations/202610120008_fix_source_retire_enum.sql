-- Fix set_source_retired: the in-flight guard compared the
-- job_status ENUM column against a text array
-- (an = any(...) comparison over a text array), which PostgreSQL rejects
-- with "operator does not exist: job_status = text" (SQLSTATE
-- 42883) — every source retire failed with a masked 500 while the
-- function itself was present and correct otherwise. The codebase's
-- own pattern for enum comparisons is bare literals, which coerce
-- to the enum type; the guard now uses an IN list of literals.
-- Found in production 2026-10-13 from the operator's SQL-editor
-- probe (the pg_proc check had confirmed the function existed).
--
-- Schema 3.3.12

create or replace function public.set_source_retired(
  p_workspace_id uuid, p_source_id uuid, p_retire boolean
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  src public.source_definitions;
  in_flight integer;
  restored text;
begin
  select * into src from public.source_definitions
    where workspace_id = p_workspace_id and id = p_source_id
    for update;
  if src.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if p_retire then
    if src.status = 'retired' then
      return jsonb_build_object('outcome', 'already_retired', 'name', src.name);
    end if;
    select count(*) into in_flight from public.scrape_jobs
      where workspace_id = p_workspace_id
        and source_id = p_source_id
        and status in ('queued', 'leased', 'running', 'retrying');
    if in_flight > 0 then
      return jsonb_build_object('outcome', 'blocked', 'name', src.name, 'in_flight', in_flight);
    end if;
    update public.source_definitions
      set status = 'retired', retired_at = now(),
          retired_from_status = src.status, updated_at = now()
      where id = src.id;
    return jsonb_build_object('outcome', 'retired', 'name', src.name, 'from_status', src.status);
  end if;
  if src.status <> 'retired' then
    return jsonb_build_object('outcome', 'not_retired', 'name', src.name);
  end if;
  restored := case
    when src.retired_from_status is not null and src.retired_from_status <> 'retired'
      then src.retired_from_status
    else 'active'
  end;
  update public.source_definitions
    set status = restored, retired_at = null,
        retired_from_status = null, updated_at = now()
    where id = src.id;
  return jsonb_build_object('outcome', 'restored', 'name', src.name, 'to_status', restored);
end $$;

revoke execute on function public.set_source_retired(uuid, uuid, boolean)
  from public, anonymous, authenticated;

insert into public.schema_versions(service, version)
values ('lead-engine', '3.3.12')
on conflict (service) do update
set version = excluded.version, applied_at = now();
