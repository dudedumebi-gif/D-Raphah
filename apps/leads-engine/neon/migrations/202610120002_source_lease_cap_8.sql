-- Per-source lease concurrency, raised: 4 -> 8 (2026-10-12).
--
-- Follow-up to 202610120001. The first clinic sprint batch showed the
-- binding constraints are crawl latency and failure share on real
-- clinic sites, not politeness: each job still targets a distinct
-- domain and enforces its own policy rate limit, and reservations
-- pace per target host (202610120001). Raising the per-source cap to
-- 8 lets the worker keep more distinct-domain crawls in flight per
-- tick; the function body is 202610120001 verbatim except the cap.
-- The worker tick now requests a batch of 20 (the function's hard
-- batch cap), so other sources keep slots alongside a hot source.

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
  with active as materialized (
    select
      j.source_id,
      count(*)::integer as active_count
    from public.scrape_jobs j
    where j.status in ('leased', 'running')
      and j.lease_expires_at >= p_now
    group by j.source_id
  ), ranked as materialized (
    select
      j.id,
      j.source_id,
      j.priority,
      j.scheduled_for,
      row_number() over (
        partition by j.source_id
        order by j.priority desc, j.scheduled_for, j.id
      ) as source_rank,
      greatest(0, 8 - coalesce(a.active_count, 0)) as source_slots
    from public.scrape_jobs j
    join public.source_definitions s on s.id = j.source_id
    join public.source_policy_versions p on p.id = s.active_policy_id
    left join active a on a.source_id = j.source_id
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
  ), candidates as (
    select j.id
    from public.scrape_jobs j
    join ranked r on r.id = j.id
    where r.source_rank <= r.source_slots
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
values ('lead-engine', '3.3.6')
on conflict (service) do update
set version = excluded.version, applied_at = now();
