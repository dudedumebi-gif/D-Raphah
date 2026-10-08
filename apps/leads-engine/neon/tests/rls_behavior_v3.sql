-- Transactional RLS policy test for the Lead Engine schema.
-- Run on a disposable Neon branch after all migrations through schema 3.3.1.
-- This validates PostgreSQL policy behaviour by assuming the same
-- `authenticated` role and request.jwt.claims context used by the Data API.
-- Run verify-neon-rls.mjs separately for genuine Neon Auth/Data API proof.
begin;
create extension if not exists pgtap;
select plan(13);

insert into public.workspaces(id,name,created_by) values
  ('21000000-0000-0000-0000-000000000001','RLS fixture A','rls-user-a'),
  ('21000000-0000-0000-0000-000000000002','RLS fixture B','rls-user-b');
insert into public.workspace_memberships(workspace_id,user_id,role) values
  ('21000000-0000-0000-0000-000000000001','rls-user-a','owner'),
  ('21000000-0000-0000-0000-000000000002','rls-user-b','owner');
insert into public.source_definitions(
  id,workspace_id,name,base_url,collection_method,business_purpose,status,created_by
) values (
  '31000000-0000-0000-0000-000000000001',
  '21000000-0000-0000-0000-000000000001',
  'RLS source A','https://example.test','static_html','RLS policy fixture','active','rls-user-a'
);
insert into public.source_policy_versions(
  id,workspace_id,source_id,allowed_domains,user_agent,contact_email,
  collection_method,status,approved_by,approved_at
) values (
  '41000000-0000-0000-0000-000000000001',
  '21000000-0000-0000-0000-000000000001',
  '31000000-0000-0000-0000-000000000001',
  array['example.test'],'RaphahRlsTest/1.0','ops@example.test',
  'static_html','approved','rls-user-a',now()
);
update public.source_definitions
set active_policy_id='41000000-0000-0000-0000-000000000001'
where id='31000000-0000-0000-0000-000000000001';
insert into public.scrape_campaigns(
  id,workspace_id,source_id,name,criteria,interval_minutes,updated_by
) values (
  '51000000-0000-0000-0000-000000000001',
  '21000000-0000-0000-0000-000000000001',
  '31000000-0000-0000-0000-000000000001',
  'RLS campaign A','{}',1440,'rls-user-a'
);
insert into public.discovery_sources(
  id,workspace_id,name,adapter_id,geo_params,source_id,campaign_id,data_mode
) values (
  '61000000-0000-0000-0000-000000000001',
  '21000000-0000-0000-0000-000000000001',
  'RLS discovery A','toronto_open_data',
  '{"city":"Toronto","region":"Ontario","centreLatitude":43.6532,"centreLongitude":-79.3832,"radiusKm":50}',
  '31000000-0000-0000-0000-000000000001',
  '51000000-0000-0000-0000-000000000001','pilot'
);
insert into public.discovery_candidates(
  id,workspace_id,discovery_source_id,adapter_id,external_id,data_mode,
  name,identity_key,source_url,source_observed_at,evidence_text
) values (
  '71000000-0000-0000-0000-000000000001',
  '21000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000001',
  'toronto_open_data','RLS-SQL-1','pilot','Tenant A candidate','tenant-a:toronto',
  'https://open.toronto.ca',now(),'Municipal licence category: fixture'
);

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"rls-user-a","role":"authenticated"}',true);
select is((select count(*)::int from public.source_definitions where id='31000000-0000-0000-0000-000000000001'),1,'tenant A sees its source');
select is((select count(*)::int from public.discovery_candidates where id='71000000-0000-0000-0000-000000000001'),1,'tenant A sees its discovery candidate');
select ok((select count(*)>=7 from public.audit_events where workspace_id='21000000-0000-0000-0000-000000000001'),'tenant A sees audit evidence');

select set_config('request.jwt.claims','{"sub":"rls-user-b","role":"authenticated"}',true);
select is((select count(*)::int from public.source_definitions where id='31000000-0000-0000-0000-000000000001'),0,'tenant B cannot see tenant A source');
select is((select count(*)::int from public.discovery_candidates where id='71000000-0000-0000-0000-000000000001'),0,'tenant B cannot see tenant A candidate');
select is((select count(*)::int from public.audit_events where workspace_id='21000000-0000-0000-0000-000000000001'),0,'tenant B cannot see tenant A audit events');
select throws_ok(
  $$insert into public.source_definitions(workspace_id,name,base_url,collection_method,business_purpose,status)
    values('21000000-0000-0000-0000-000000000001','Cross tenant','https://other.example','static_html','RLS denial fixture','draft')$$,
  '42501','new row violates row-level security policy for table "source_definitions"','tenant B cannot write into tenant A workspace'
);

select set_config('request.jwt.claims','{"sub":"rls-user-a","role":"authenticated"}',true);
select lives_ok(
  $$select public.queue_scrape_job(
    '21000000-0000-0000-0000-000000000001',
    '31000000-0000-0000-0000-000000000001',
    'https://example.test','rls-sql-idempotency',3
  )$$,
  'tenant A can queue through the approved RPC'
);
select is(
  (select count(*)::int from public.scrape_jobs where idempotency_key='rls-sql-idempotency'),
  1,'queue RPC creates one job'
);
select lives_ok(
  $$select public.queue_scrape_job(
    '21000000-0000-0000-0000-000000000001',
    '31000000-0000-0000-0000-000000000001',
    'https://example.test','rls-sql-idempotency',3
  )$$,
  'queue RPC replay succeeds'
);
select is(
  (select count(*)::int from public.scrape_jobs where idempotency_key='rls-sql-idempotency'),
  1,'queue RPC replay remains idempotent'
);
select throws_ok(
  $$select public.lease_scrape_jobs('browser',1,240,now())$$,
  '42501','permission denied for function lease_scrape_jobs','browser role cannot lease worker jobs'
);

select set_config('request.jwt.claims','',true);
select is((select count(*)::int from public.workspaces),0,'authenticated role without JWT claims fails closed');

reset role;
select * from finish();
rollback;
