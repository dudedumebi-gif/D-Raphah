-- Archive / History: retire sources and campaigns without deleting
-- them (2026-10-13; revised after Codex review of PR #44, before
-- first run — this migration has never been applied).
--
-- Deleting a source or campaign would take its jobs, assessments,
-- and audit trail with it (cascades). Retirement is the auditable
-- alternative the schema already half-anticipated:
-- source_definitions.status has carried 'retired' since the first
-- migration, and every collection path (worker lease/persist,
-- scheduler, discovery gates) already keys off status = 'active',
-- so a retired source stops collecting everywhere at once. This
-- migration adds the missing bookkeeping:
--
--  * retired_at / retired_from_status on source_definitions, so a
--    restore returns the source to exactly the status it held
--    (restoring must never become an approval bypass);
--  * a status column on scrape_campaigns (which had none) with the
--    same bookkeeping, so unused criteria can retire too;
--  * enqueue_due_scrape_jobs learns to skip retired campaigns (it
--    already required an active source; the campaign predicate is
--    new because the column is);
--  * set_source_retired / set_campaign_retired: the lifecycle
--    transitions as SECURITY DEFINER functions. The authenticated
--    role has NO update grant on source_definitions and only
--    column-scoped grants on scrape_campaigns, so the routes cannot
--    write these columns directly; the functions run the transition
--    atomically (the source in-flight guard counts and flips in one
--    transaction, row locked) and EXECUTE is revoked from the API
--    roles — the only way in is the admin connection behind the
--    routes' owner/administrator check (the rescore pattern).
--
-- Schema 3.3.11

alter table public.source_definitions
  add column if not exists retired_at timestamptz,
  add column if not exists retired_from_status text;

alter table public.scrape_campaigns
  add column if not exists status text not null default 'active'
    check (status in ('active', 'retired')),
  add column if not exists retired_at timestamptz,
  add column if not exists retired_from_status text;

create or replace function public.enqueue_due_scrape_jobs(p_now timestamptz)
returns integer language plpgsql security definer set search_path = public as $$
declare c record; inserted_count integer := 0;
begin
  for c in select sc.*,sd.base_url,sd.data_mode as source_data_mode from public.scrape_campaigns sc join public.source_definitions sd on sd.id=sc.source_id where sc.schedule_enabled and sc.next_run_at<=p_now and sd.status='active' and sc.status='active' for update of sc skip locked loop
    insert into public.scrape_jobs(workspace_id,source_id,campaign_id,target_url,status,scheduled_for,idempotency_key,criteria_snapshot,data_mode)
    values(c.workspace_id,c.source_id,c.id,c.base_url,'queued',c.next_run_at,'schedule:'||c.source_data_mode||':'||c.id||':'||to_char(c.next_run_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'),c.criteria,c.source_data_mode)
    on conflict(idempotency_key) do nothing;
    if found then inserted_count:=inserted_count+1; end if;
    update public.scrape_campaigns set next_run_at=greatest(c.next_run_at+make_interval(mins=>c.interval_minutes),p_now+make_interval(mins=>c.interval_minutes)),updated_at=now() where id=c.id;
  end loop;
  return inserted_count;
end $$;

-- Atomic retire/restore for a source. The in-flight guard counts
-- jobs whose collection is still live (queued, leased, running,
-- retrying); terminal work is history and never blocks. The count
-- and the status flip happen in this one transaction with the
-- source row locked, so the guard cannot be raced by a scheduler
-- landing between a check and a write in application code.
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
        and status = any(array['queued', 'leased', 'running', 'retrying']);
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

-- Atomic retire/restore for a campaign. Campaigns carry no in-flight
-- guard: their queued jobs are the scheduler's concern, and
-- enqueue_due_scrape_jobs / the worker both skip retired campaigns.
create or replace function public.set_campaign_retired(
  p_workspace_id uuid, p_campaign_id uuid, p_retire boolean
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c public.scrape_campaigns;
  restored text;
begin
  select * into c from public.scrape_campaigns
    where workspace_id = p_workspace_id and id = p_campaign_id
    for update;
  if c.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if p_retire then
    if c.status = 'retired' then
      return jsonb_build_object('outcome', 'already_retired', 'name', c.name);
    end if;
    update public.scrape_campaigns
      set status = 'retired', retired_at = now(),
          retired_from_status = c.status, updated_at = now()
      where id = c.id;
    return jsonb_build_object('outcome', 'retired', 'name', c.name, 'from_status', c.status);
  end if;
  if c.status <> 'retired' then
    return jsonb_build_object('outcome', 'not_retired', 'name', c.name);
  end if;
  restored := case
    when c.retired_from_status is not null and c.retired_from_status <> 'retired'
      then c.retired_from_status
    else 'active'
  end;
  update public.scrape_campaigns
    set status = restored, retired_at = null,
        retired_from_status = null, updated_at = now()
    where id = c.id;
  return jsonb_build_object('outcome', 'restored', 'name', c.name, 'to_status', restored);
end $$;

revoke execute on function public.set_campaign_retired(uuid, uuid, boolean)
  from public, anonymous, authenticated;

insert into public.schema_versions(service, version)
values ('lead-engine', '3.3.11')
on conflict (service) do update
set version = excluded.version, applied_at = now();
