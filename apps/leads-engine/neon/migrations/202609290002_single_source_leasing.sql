-- Enforce the worker invariant that at most one due job per source can be
-- leased in a claim batch. The advisory lock serializes claim transactions;
-- row_number makes the per-source selection explicit and deterministic.

create or replace function public.lease_scrape_jobs(
  p_worker_id text,
  p_batch_size integer,
  p_lease_seconds integer,
  p_now timestamptz
) returns setof public.scrape_jobs
language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(20260922, 1);

  return query
  with ranked as materialized (
    select
      j.id,
      j.source_id,
      j.priority,
      j.scheduled_for,
      row_number() over (
        partition by j.source_id
        order by j.priority desc, j.scheduled_for, j.id
      ) as source_rank
    from public.scrape_jobs j
    join public.source_definitions s on s.id = j.source_id
    join public.source_policy_versions p on p.id = s.active_policy_id
    where j.status in ('queued', 'retrying')
      and j.scheduled_for <= p_now
      and (j.next_attempt_at is null or j.next_attempt_at <= p_now)
      and s.status = 'active'
      and p.status = 'approved'
      and p.approved_by is not null
      and p.approved_at is not null
      and (
        select count(*)
        from public.source_collection_reservations r
        where r.policy_version_id = p.id
          and r.reserved_at >= date_trunc('day', p_now)
      ) < p.daily_budget
      and (
        select count(*)
        from public.source_collection_reservations r
        where r.policy_version_id = p.id
          and r.reserved_at >= date_trunc('month', p_now)
      ) < p.monthly_budget
      and not exists (
        select 1
        from public.scrape_jobs active
        where active.source_id = j.source_id
          and active.status in ('leased', 'running')
          and active.lease_expires_at >= p_now
      )
  ), candidates as (
    select j.id
    from public.scrape_jobs j
    join ranked r on r.id = j.id
    where r.source_rank = 1
    order by r.priority desc, r.scheduled_for, r.id
    for update of j skip locked
    limit least(greatest(p_batch_size, 0), 20)
  )
  update public.scrape_jobs j
  set
    status = 'leased',
    lease_owner = p_worker_id,
    lease_expires_at = p_now + make_interval(secs => p_lease_seconds)
  from candidates c
  where j.id = c.id
  returning j.*;
end $$;

revoke execute on function public.lease_scrape_jobs(
  text,
  integer,
  integer,
  timestamptz
) from public, anonymous, authenticated;

insert into public.schema_versions(service, version)
values ('lead-engine', '3.3.1')
on conflict(service) do update
set version = excluded.version, applied_at = now();
