-- Execute against a disposable Neon branch after applying the migration:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f neon/tests/job_lifecycle_v3.sql
-- This worker/durability test rolls back. Run `pnpm test:rls:neon` separately
-- with two genuine Neon Auth tokens to validate the Data API/RLS boundary.
--
-- Leasing model under test (202610120001 + 202610120002): up to 8 jobs
-- per source may be leased at once (live leases count against the cap),
-- and reservation pacing is per TARGET HOST — same-host jobs still
-- serialize on the policy rate window, different-host jobs reserve in
-- parallel.
begin;
create extension if not exists pgtap;
select plan(18);

-- Use one wall-clock instant for every scheduling and leasing assertion.
-- PostgreSQL's now() is transaction-scoped; making the due time explicitly
-- earlier keeps this test deterministic in the Neon SQL Editor and psql.
create temp table test_clock on commit drop as
select clock_timestamp() as test_now;

insert into public.workspaces(id,name,created_by)
values('20000000-0000-0000-0000-000000000003','Job fixture','neon-test-user');
insert into public.workspace_memberships(workspace_id,user_id,role)
values('20000000-0000-0000-0000-000000000003','neon-test-user','owner');
insert into public.source_definitions(id,workspace_id,name,base_url,collection_method,business_purpose,status)
values('30000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000003','Fixture','https://example.test','static_html','Controlled durability test','active');
insert into public.source_policy_versions(id,workspace_id,source_id,allowed_domains,user_agent,contact_email,collection_method,status,approved_by,approved_at)
values('40000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003',array['example.test'],'FixtureBot','ops@example.test','static_html','approved','neon-test-user',now());
update public.source_definitions set active_policy_id='40000000-0000-0000-0000-000000000003' where id='30000000-0000-0000-0000-000000000003';

insert into public.scrape_jobs(workspace_id,source_id,target_url,idempotency_key,max_attempts,scheduled_for)
values('20000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003','https://example.test/one','fixture-one',3,(select test_now from test_clock)-interval '5 seconds')
on conflict(idempotency_key) do nothing;
insert into public.scrape_jobs(workspace_id,source_id,target_url,idempotency_key,max_attempts,scheduled_for)
values('20000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003','https://example.test/one','fixture-one',3,(select test_now from test_clock)-interval '5 seconds')
on conflict(idempotency_key) do nothing;
select is((select count(*)::int from public.scrape_jobs where idempotency_key='fixture-one'),1,'duplicate schedule delivery creates one job');

insert into public.scrape_jobs(workspace_id,source_id,target_url,idempotency_key,max_attempts,scheduled_for)
values('20000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003','https://example.test/two','fixture-two',3,(select test_now from test_clock)-interval '5 seconds');

-- Both due jobs lease in one call: the per-source cap is 4, not 1.
with leased as materialized (
  select * from public.lease_scrape_jobs('worker-a',20,240,(select test_now from test_clock))
)
select is((select count(*)::int from leased where source_id='30000000-0000-0000-0000-000000000003'),2,'first lease returns both due jobs (per-source cap 8)');
select ok(public.reserve_source_collection((select id from public.scrape_jobs where idempotency_key='fixture-one'),'worker-a',(select test_now from test_clock)),'source capacity is reserved durably');
select ok(public.reserve_source_collection((select id from public.scrape_jobs where idempotency_key='fixture-one'),'worker-a',(select test_now from test_clock)),'reservation replay is idempotent');
select is((select count(*)::int from public.source_collection_reservations where source_id='30000000-0000-0000-0000-000000000003' and worker_id='worker-a'),1,'reservation replay does not consume budget twice');
-- Fixture two targets the SAME host as fixture one: its reservation inside
-- the rate window (1s at the fixture policy's default 1 rps) is rejected...
select throws_ok($$select public.reserve_source_collection((select id from public.scrape_jobs where idempotency_key='fixture-two'),'worker-a',(select test_now from test_clock))$$,'P0001','source rate window has not elapsed','same-host reservation inside the rate window is rejected');
-- ...and succeeds once the window has elapsed (its lease is still live).
select ok(public.reserve_source_collection((select id from public.scrape_jobs where idempotency_key='fixture-two'),'worker-a',(select test_now from test_clock)+interval '2 seconds'),'same-host reservation succeeds after the rate window');

-- Seven more due jobs: two live leases leave exactly 6 of the 8 slots.
insert into public.scrape_jobs(workspace_id,source_id,target_url,idempotency_key,max_attempts,scheduled_for)
values('20000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003','https://example.test/three','fixture-three',3,(select test_now from test_clock)-interval '5 seconds');
insert into public.scrape_jobs(workspace_id,source_id,target_url,idempotency_key,max_attempts,scheduled_for)
values('20000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003','https://example.test/four','fixture-four',3,(select test_now from test_clock)-interval '5 seconds');
insert into public.scrape_jobs(workspace_id,source_id,target_url,idempotency_key,max_attempts,scheduled_for)
values('20000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003','https://example.test/five','fixture-five',3,(select test_now from test_clock)-interval '5 seconds');
insert into public.scrape_jobs(workspace_id,source_id,target_url,idempotency_key,max_attempts,scheduled_for)
values('20000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003','https://example.test/six','fixture-six',3,(select test_now from test_clock)-interval '5 seconds');
insert into public.scrape_jobs(workspace_id,source_id,target_url,idempotency_key,max_attempts,scheduled_for)
values('20000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003','https://example.test/seven','fixture-seven',3,(select test_now from test_clock)-interval '5 seconds');
insert into public.scrape_jobs(workspace_id,source_id,target_url,idempotency_key,max_attempts,scheduled_for)
values('20000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003','https://example.test/eight','fixture-eight',3,(select test_now from test_clock)-interval '5 seconds');
insert into public.scrape_jobs(workspace_id,source_id,target_url,idempotency_key,max_attempts,scheduled_for)
values('20000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003','https://example.test/nine','fixture-nine',3,(select test_now from test_clock)-interval '5 seconds');
with leased as materialized (
  select * from public.lease_scrape_jobs('worker-b',20,240,(select test_now from test_clock))
)
select is((select count(*)::int from leased where source_id='30000000-0000-0000-0000-000000000003'),6,'remaining slots lease six more jobs (cap 8 with 2 active)');
with leased as materialized (
  select * from public.lease_scrape_jobs('worker-c',20,240,(select test_now from test_clock))
)
select is((select count(*)::int from leased where source_id='30000000-0000-0000-0000-000000000003'),0,'cap reached: another worker receives none for the source');

select is(public.start_scrape_attempt((select id from public.scrape_jobs where idempotency_key='fixture-one'),'worker-a'),1,'start increments attempt atomically');
select throws_ok($$select public.start_scrape_attempt((select id from public.scrape_jobs where idempotency_key='fixture-one'),'worker-b')$$,'P0001','job lease is not owned by worker','wrong worker cannot start attempt');
create temp table expired_before on commit drop as
select count(*)::int as lease_count
from public.scrape_jobs
where status in ('leased','running')
  and lease_expires_at < (select test_now from test_clock);
update public.scrape_jobs set lease_expires_at=(select test_now from test_clock)-interval '1 second' where source_id='30000000-0000-0000-0000-000000000003' and lease_owner='worker-a';
select throws_ok($$select public.persist_scrape_result((select id from public.scrape_jobs where idempotency_key='fixture-one'),'worker-a','{}')$$,'P0001','job lease is not owned by worker','expired worker cannot commit results');
select is(
  public.recover_expired_scrape_leases((select test_now from test_clock)),
  (select lease_count + 2 from expired_before),
  'expired leases recovered, including both fixture leases'
);
select is((select count(*)::int from public.scrape_job_attempts where workspace_id='20000000-0000-0000-0000-000000000003' and error_code='LEASE_EXPIRED'),1,'abandoned attempt is closed');
select is((select count(*)::int from public.scrape_jobs where workspace_id='20000000-0000-0000-0000-000000000003' and status='retrying'),2,'both recoverable jobs are retrying');

update public.scrape_jobs set status='completed',completed_at=now(),result='{"preserved":true}' where idempotency_key='fixture-one';
insert into public.scrape_jobs(workspace_id,source_id,target_url,idempotency_key,max_attempts,scheduled_for)
values('20000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003','https://example.test/one','fixture-one',3,(select test_now from test_clock)-interval '5 seconds')
on conflict(idempotency_key) do nothing;
select is((select status::text from public.scrape_jobs where idempotency_key='fixture-one'),'completed','replay does not reset completed state');
select ok((select (result->>'preserved')::boolean from public.scrape_jobs where idempotency_key='fixture-one'),'replay preserves result');
select ok((select count(*)>=8 from public.audit_events where workspace_id='20000000-0000-0000-0000-000000000003'),'state transitions emitted audit events');

select * from finish();
rollback;
