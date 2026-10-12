-- Per-source lease concurrency (2026-10-12, clinic sprint follow-up).
--
-- 202609290002 enforced the invariant "at most one due job per source
-- per claim batch" and blocked leasing a source entirely while one of
-- its jobs was leased/running. That serialization protects a single
-- crawl front, but discovery-enqueued jobs each target a DIFFERENT
-- domain (one clinic website per job) and each job enforces its own
-- policy rate limit while crawling its target — so serializing them
-- bought no per-site politeness and capped a 100-job sprint batch at
-- roughly one job per 5-minute worker tick (~12/hour).
--
-- This version leases up to 4 jobs per source per batch, counting jobs
-- for the source that are already leased/running with a live lease
-- against the same cap of 4. Cross-source fairness is preserved: the
-- batch is still selected by priority/scheduled order across sources,
-- every other eligibility rule (due, source active, policy approved,
-- daily/monthly collection budgets) is unchanged, and the worker's
-- batch size bounds the total claimed per tick.

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
      greatest(0, 4 - coalesce(a.active_count, 0)) as source_slots
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

-- ---------------------------------------------------------------------
-- Reservation pacing: per target host (was: per source).
--
-- reserve_source_collection (202609270001) rejects any reservation made
-- within 1 / rate_limit_rps of the source's previous reservation. With
-- up to four same-source jobs starting concurrently, only the first
-- would be granted and the rest returned to retrying — nullifying the
-- parallel leasing above. The replacement below is the 202609270001
-- function verbatim except the pacing lookup, which now compares only
-- reservations whose jobs targeted the SAME host.
-- ---------------------------------------------------------------------

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
  -- Pace per TARGET HOST, not per source (PR #34 review fix): a source
  -- whose jobs crawl a single site (campaign fronts, manual jobs) keeps
  -- the exact serialized pacing it has always had, because all of its
  -- jobs share one host. Discovery fan-out jobs each target a different
  -- clinic domain, so each host gets its own rate window and parallel
  -- leases proceed instead of all-but-one being rejected back to
  -- retrying. Daily/monthly budgets above stay per policy, unchanged,
  -- and each job's crawl still enforces the policy rate limit against
  -- its own target while it runs.
  select max(r.reserved_at) into v_last
  from public.source_collection_reservations r
  join public.scrape_jobs pj on pj.id = r.scrape_job_id
  where r.source_id = v_source.id
    and lower(split_part(split_part(pj.target_url, '://', 2), '/', 1))
      = lower(split_part(split_part(v_job.target_url, '://', 2), '/', 1));
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

insert into public.schema_versions(service, version)
values ('lead-engine', '3.3.5')
on conflict (service) do update
set version = excluded.version, applied_at = now();
