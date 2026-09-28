-- Durable source pacing, budget enforcement, retention, and complete audit
-- coverage for tables added after the Lead Engine production baseline.

create table if not exists public.source_collection_reservations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_id uuid not null references public.source_definitions(id) on delete cascade,
  policy_version_id uuid not null references public.source_policy_versions(id),
  scrape_job_id uuid not null unique references public.scrape_jobs(id) on delete cascade,
  worker_id text not null,
  reserved_at timestamptz not null default now()
);

create index if not exists source_reservations_policy_time_idx
  on public.source_collection_reservations(policy_version_id, reserved_at desc);
create index if not exists source_reservations_source_time_idx
  on public.source_collection_reservations(source_id, reserved_at desc);
create index if not exists scrape_jobs_workspace_scheduled_idx
  on public.scrape_jobs(workspace_id, scheduled_for desc, status);
create index if not exists canary_runs_workspace_scheduled_idx
  on public.canary_runs(workspace_id, scheduled_at desc);
create index if not exists assessments_workspace_evaluated_idx
  on public.maturity_assessments(workspace_id, evaluated_at desc);

alter table public.source_collection_reservations enable row level security;
revoke all on public.source_collection_reservations from public, anonymous, authenticated;

create or replace function public.reserve_source_collection(
  p_job_id uuid,
  p_worker_id text,
  p_now timestamptz
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_job public.scrape_jobs;
  v_source public.source_definitions;
  v_policy public.source_policy_versions;
  v_daily bigint;
  v_monthly bigint;
  v_last timestamptz;
begin
  select * into v_job from public.scrape_jobs where id = p_job_id for update;
  if v_job.id is null or v_job.status <> 'leased'
     or v_job.lease_owner is distinct from p_worker_id
     or v_job.lease_expires_at <= p_now then
    raise exception 'job lease is not owned by worker';
  end if;
  if exists(select 1 from public.source_collection_reservations where scrape_job_id=p_job_id) then
    return true;
  end if;

  select * into v_source from public.source_definitions where id=v_job.source_id for share;
  if v_source.status <> 'active' or v_source.active_policy_id is null then
    raise exception 'source is not active with an approved policy';
  end if;
  select * into v_policy from public.source_policy_versions
    where id=v_source.active_policy_id and source_id=v_source.id for share;
  if v_policy.id is null or v_policy.status <> 'approved'
     or v_policy.approved_by is null or v_policy.approved_at is null then
    raise exception 'source policy is not approved';
  end if;

  -- Serialize reservations for this source across every worker/node.
  perform pg_advisory_xact_lock(hashtext(v_source.id::text));
  select count(*) into v_daily from public.source_collection_reservations
    where policy_version_id=v_policy.id and reserved_at >= date_trunc('day', p_now);
  select count(*) into v_monthly from public.source_collection_reservations
    where policy_version_id=v_policy.id and reserved_at >= date_trunc('month', p_now);
  if v_daily >= v_policy.daily_budget then raise exception 'source daily budget exhausted'; end if;
  if v_monthly >= v_policy.monthly_budget then raise exception 'source monthly budget exhausted'; end if;
  select max(reserved_at) into v_last from public.source_collection_reservations
    where source_id=v_source.id;
  if v_last is not null and v_last + make_interval(secs => 1.0/v_policy.rate_limit_rps) > p_now then
    raise exception 'source rate window has not elapsed';
  end if;

  insert into public.source_collection_reservations(
    workspace_id, source_id, policy_version_id, scrape_job_id, worker_id, reserved_at
  ) values (
    v_job.workspace_id, v_source.id, v_policy.id, v_job.id, p_worker_id, p_now
  ) on conflict(scrape_job_id) do nothing;
  return true;
end $$;

revoke execute on function public.reserve_source_collection(uuid,text,timestamptz)
  from public, anonymous, authenticated;

create or replace function public.lease_scrape_jobs(
  p_worker_id text,p_batch_size integer,p_lease_seconds integer,p_now timestamptz
) returns setof public.scrape_jobs
language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(20260922, 1);
  return query with candidates as (
    select j.id
    from public.scrape_jobs j
    join public.source_definitions s on s.id=j.source_id
    join public.source_policy_versions p on p.id=s.active_policy_id
    where j.status in ('queued','retrying')
      and j.scheduled_for<=p_now
      and (j.next_attempt_at is null or j.next_attempt_at<=p_now)
      and s.status='active' and p.status='approved'
      and p.approved_by is not null and p.approved_at is not null
      and (select count(*) from public.source_collection_reservations r
           where r.policy_version_id=p.id and r.reserved_at>=date_trunc('day',p_now)) < p.daily_budget
      and (select count(*) from public.source_collection_reservations r
           where r.policy_version_id=p.id and r.reserved_at>=date_trunc('month',p_now)) < p.monthly_budget
      and not exists (
        select 1 from public.scrape_jobs active
        where active.source_id=j.source_id
          and active.status in ('leased','running')
          and active.lease_expires_at>=p_now
      )
      and not exists (
        select 1 from public.scrape_jobs earlier
        where earlier.source_id=j.source_id
          and earlier.status in ('queued','retrying')
          and earlier.scheduled_for<=p_now
          and (earlier.next_attempt_at is null or earlier.next_attempt_at<=p_now)
          and (earlier.priority>j.priority or
               (earlier.priority=j.priority and
                (earlier.scheduled_for<j.scheduled_for or
                 (earlier.scheduled_for=j.scheduled_for and earlier.id<j.id))))
      )
    order by j.priority desc,j.scheduled_for,j.id
    for update of j skip locked
    limit least(p_batch_size,20)
  ) update public.scrape_jobs j
    set status='leased', lease_owner=p_worker_id,
        lease_expires_at=p_now+make_interval(secs=>p_lease_seconds)
    from candidates c where j.id=c.id returning j.*;
end $$;

revoke execute on function public.lease_scrape_jobs(text,integer,integer,timestamptz)
  from public, anonymous, authenticated;

create or replace function public.prune_operational_history(p_now timestamptz)
returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer:=0; v_rows integer:=0;
begin
  delete from public.source_collection_reservations
    where reserved_at < p_now - interval '14 months';
  get diagnostics v_rows=row_count; v_count:=v_count+v_rows;
  delete from public.geocode_cache where updated_at < p_now - interval '90 days';
  get diagnostics v_rows=row_count; v_count:=v_count+v_rows;
  delete from public.feedback_nonces where expires_at < p_now;
  get diagnostics v_rows=row_count; v_count:=v_count+v_rows;
  return v_count;
end $$;
revoke execute on function public.prune_operational_history(timestamptz)
  from public, anonymous, authenticated;

-- Later migrations introduced business-state tables after the baseline audit
-- trigger loop. Attach the same immutable audit pipeline to every mutation.
do $$ declare t text; begin
  foreach t in array array[
    'source_collection_reservations',
    'handoff_outbox','delivery_feedback_events','discovery_sources',
    'discovery_runs','terms_acceptances','consent_records'
  ] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop trigger if exists audit_%I on public.%I',t,t);
      execute format('create trigger audit_%I after insert or update or delete on public.%I for each row execute function public.capture_audit_event()',t,t);
    end if;
  end loop;
end $$;

insert into public.schema_versions(service,version)
values('lead-engine','3.2.0')
on conflict(service) do update set version=excluded.version,applied_at=now();
