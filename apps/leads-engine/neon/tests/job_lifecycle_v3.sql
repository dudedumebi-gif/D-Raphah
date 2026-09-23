-- Execute against a disposable Neon branch after applying the migration:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f neon/tests/job_lifecycle_v3.sql
-- This worker/durability test rolls back. Run `pnpm test:rls:neon` separately
-- with two genuine Neon Auth tokens to validate the Data API/RLS boundary.
begin;
create extension if not exists pgtap;
select no_plan();

insert into public.workspaces(id,name,created_by)
values('20000000-0000-0000-0000-000000000003','Job fixture','neon-test-user');
insert into public.workspace_memberships(workspace_id,user_id,role)
values('20000000-0000-0000-0000-000000000003','neon-test-user','owner');
insert into public.source_definitions(id,workspace_id,name,base_url,collection_method,business_purpose,status)
values('30000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000003','Fixture','https://example.test','static_html','Controlled durability test','active');
insert into public.source_policy_versions(id,workspace_id,source_id,allowed_domains,user_agent,contact_email,collection_method,status,approved_by,approved_at)
values('40000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003',array['example.test'],'FixtureBot','ops@example.test','static_html','approved','neon-test-user',now());
update public.source_definitions set active_policy_id='40000000-0000-0000-0000-000000000003' where id='30000000-0000-0000-0000-000000000003';

insert into public.scrape_jobs(workspace_id,source_id,target_url,idempotency_key,max_attempts)
values('20000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003','https://example.test/one','fixture-one',3)
on conflict(idempotency_key) do nothing;
insert into public.scrape_jobs(workspace_id,source_id,target_url,idempotency_key,max_attempts)
values('20000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003','https://example.test/one','fixture-one',3)
on conflict(idempotency_key) do nothing;
select is((select count(*)::int from public.scrape_jobs where idempotency_key='fixture-one'),1,'duplicate schedule delivery creates one job');

insert into public.scrape_jobs(workspace_id,source_id,target_url,idempotency_key,max_attempts)
values('20000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003','https://example.test/two','fixture-two',3);

select is((select count(*)::int from public.lease_scrape_jobs('worker-a',3,240,now())),1,'only one job per source is leased');
select is((select count(*)::int from public.lease_scrape_jobs('worker-b',3,240,now())),0,'another worker cannot overlap the active source');
select is(public.start_scrape_attempt((select id from public.scrape_jobs where lease_owner='worker-a'),'worker-a'),1,'start increments attempt atomically');
select throws_ok($$select public.start_scrape_attempt((select id from public.scrape_jobs where lease_owner='worker-a'),'worker-b')$$,'P0001','job lease is not owned by worker','wrong worker cannot start attempt');
update public.scrape_jobs set lease_expires_at=now()-interval '1 second' where lease_owner='worker-a';
select throws_ok($$select public.persist_scrape_result((select id from public.scrape_jobs where lease_owner='worker-a'),'worker-a','{}')$$,'P0001','job lease is not owned by worker','expired worker cannot commit results');
select is(public.recover_expired_scrape_leases(now()),1,'expired lease recovered');
select is((select count(*)::int from public.scrape_job_attempts where error_code='LEASE_EXPIRED'),1,'abandoned attempt is closed');
select is((select count(*)::int from public.scrape_jobs where status='retrying'),1,'recoverable job is retrying');

update public.scrape_jobs set status='completed',completed_at=now(),result='{"preserved":true}' where idempotency_key='fixture-one';
insert into public.scrape_jobs(workspace_id,source_id,target_url,idempotency_key,max_attempts)
values('20000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003','https://example.test/one','fixture-one',3)
on conflict(idempotency_key) do nothing;
select is((select status::text from public.scrape_jobs where idempotency_key='fixture-one'),'completed','replay does not reset completed state');
select ok((select (result->>'preserved')::boolean from public.scrape_jobs where idempotency_key='fixture-one'),'replay preserves result');
select ok((select count(*)>=8 from public.audit_events where workspace_id='20000000-0000-0000-0000-000000000003'),'state transitions emitted audit events');

select * from finish();
rollback;
