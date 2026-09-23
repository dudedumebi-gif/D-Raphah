-- Lead Engine production data plane for Neon. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 202609220001_lead_engine_production.sql
create extension if not exists pgcrypto;

create type public.workspace_role as enum ('owner', 'administrator', 'analyst', 'reviewer', 'auditor');
create type public.job_status as enum ('queued', 'leased', 'running', 'retrying', 'completed', 'partial', 'failed', 'dead_letter', 'cancelled');

create table public.schema_versions (
  service text primary key,
  version text not null,
  applied_at timestamptz not null default now()
);
insert into public.schema_versions(service, version) values ('lead-engine', '3.0.0')
on conflict (service) do update set version = excluded.version, applied_at = now();

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_memberships (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id text not null,
  role public.workspace_role not null default 'analyst',
  status text not null default 'active' check (status in ('active', 'suspended', 'revoked')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create or replace function public.is_workspace_member(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.workspace_memberships m where m.workspace_id = p_workspace_id and m.user_id = auth.user_id() and m.status = 'active') $$;

create or replace function public.has_workspace_role(p_workspace_id uuid, p_roles public.workspace_role[])
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.workspace_memberships m where m.workspace_id = p_workspace_id and m.user_id = auth.user_id() and m.status = 'active' and m.role = any(p_roles)) $$;

create table public.source_definitions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  base_url text not null,
  collection_method text not null check (collection_method in ('api','rss','sitemap','static_html','rendered_html','pdf','csv','manual')),
  business_purpose text not null,
  status text not null default 'draft' check (status in ('draft','pending_approval','active','paused','rejected','retired')),
  active_policy_id uuid,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, name)
);

create table public.source_policy_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_id uuid not null references public.source_definitions(id) on delete cascade,
  version integer not null default 1,
  allowed_domains text[] not null,
  allowlist_paths text[] not null default array['/*'],
  denylist_paths text[] not null default '{}',
  daily_budget integer not null default 100 check (daily_budget > 0),
  monthly_budget integer not null default 2000 check (monthly_budget > 0),
  max_depth integer not null default 2 check (max_depth between 0 and 10),
  rate_limit_rps numeric not null default 1 check (rate_limit_rps > 0 and rate_limit_rps <= 10),
  retention_months integer not null default 12 check (retention_months between 1 and 84),
  user_agent text not null,
  contact_email text not null,
  max_bytes integer not null default 2000000 check (max_bytes between 1024 and 10000000),
  timeout_ms integer not null default 20000 check (timeout_ms between 1000 and 60000),
  respect_robots boolean not null default true,
  collection_method text not null,
  status text not null default 'pending_approval' check (status in ('pending_approval','approved','rejected','superseded')),
  approved_by text,
  approved_at timestamptz,
  approval_reason text,
  created_by text,
  created_at timestamptz not null default now(),
  unique(source_id, version)
);
alter table public.source_definitions add constraint source_active_policy_fk foreign key (active_policy_id) references public.source_policy_versions(id);

create table public.scrape_campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_id uuid not null references public.source_definitions(id) on delete cascade,
  name text not null,
  criteria jsonb not null default '{}'::jsonb,
  criteria_version text not null default '1.0.0',
  interval_minutes integer not null default 1440 check (interval_minutes between 5 and 43200),
  schedule_enabled boolean not null default false,
  next_run_at timestamptz,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, source_id)
);

create table public.canary_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  scheduled_at timestamptz not null,
  completed_at timestamptz,
  status text not null check (status in ('queued','running','completed','failed')),
  idempotency_key text not null unique,
  scrape_job_id uuid,
  failure_reason text,
  created_at timestamptz not null default now()
);

create table public.scrape_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_id uuid not null references public.source_definitions(id),
  campaign_id uuid references public.scrape_campaigns(id),
  canary_run_id uuid references public.canary_runs(id),
  target_url text not null,
  status public.job_status not null default 'queued',
  priority integer not null default 50,
  scheduled_for timestamptz not null default now(),
  next_attempt_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  result jsonb,
  criteria_snapshot jsonb not null default '{}'::jsonb,
  idempotency_key text not null unique,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.canary_runs add constraint canary_job_fk foreign key (scrape_job_id) references public.scrape_jobs(id);
create index scrape_jobs_claim_idx on public.scrape_jobs(status, next_attempt_at, scheduled_for, priority desc);
create index scrape_jobs_workspace_idx on public.scrape_jobs(workspace_id, created_at desc);

create table public.scrape_job_attempts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  scrape_job_id uuid not null references public.scrape_jobs(id) on delete cascade,
  attempt_number integer not null,
  worker_id text not null,
  status text not null check (status in ('running','completed','failed')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  response_status integer,
  bytes_downloaded integer,
  error_code text,
  error_message text,
  unique(scrape_job_id, attempt_number)
);

create table public.evidence_artifacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_id uuid not null references public.source_definitions(id),
  scrape_job_id uuid not null references public.scrape_jobs(id),
  policy_version_id uuid not null references public.source_policy_versions(id),
  canonical_url text not null,
  final_url text not null,
  content_hash text not null,
  content_type text not null,
  byte_length integer not null,
  storage_bucket text not null,
  storage_path text not null,
  raw_content text,
  raw_content_retained_until timestamptz not null,
  extracted_title text,
  extracted_organization text,
  extracted_text text not null,
  fetched_at timestamptz not null,
  parser_version text not null,
  robots_decision text not null,
  response_status integer not null,
  created_at timestamptz not null default now(),
  unique(scrape_job_id, canonical_url, content_hash)
);

create table public.signal_observations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  evidence_artifact_id uuid not null references public.evidence_artifacts(id) on delete cascade,
  source_id uuid not null references public.source_definitions(id),
  code text not null,
  category text not null,
  polarity text not null check (polarity in ('manual','automated','commercial')),
  strength numeric not null,
  confidence numeric not null check (confidence between 0 and 1),
  excerpt text not null,
  observed_at timestamptz not null,
  expires_at timestamptz,
  unique(evidence_artifact_id, code)
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  normalized_name text not null,
  normalized_domain text not null,
  website_url text,
  city text,
  region text,
  country text,
  latitude numeric,
  longitude numeric,
  last_observed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, normalized_domain)
);

create table public.maturity_assessments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  scrape_job_id uuid not null references public.scrape_jobs(id),
  evidence_artifact_id uuid not null references public.evidence_artifacts(id),
  automation_maturity_score integer not null check (automation_maturity_score between 0 and 100),
  opportunity_potential_score integer not null check (opportunity_potential_score between 0 and 100),
  confidence numeric not null check (confidence between 0 and 1),
  coverage_categories integer not null,
  components jsonb not null,
  explanation jsonb not null,
  criteria_snapshot jsonb not null,
  scoring_version text not null,
  qualified boolean not null,
  evaluated_at timestamptz not null default now(),
  unique(scrape_job_id)
);

create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  latest_assessment_id uuid references public.maturity_assessments(id),
  primary_evidence_id uuid references public.evidence_artifacts(id),
  title text not null,
  stage text not null default 'detected',
  routing text not null default 'standard_review',
  status text not null default 'active',
  automation_maturity_score integer not null,
  opportunity_potential_score integer not null,
  confidence numeric not null,
  last_refreshed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, organization_id)
);

create table public.lead_feedback (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  reviewer_id text not null,
  decision text not null,
  reason_code text not null,
  notes text,
  created_at timestamptz not null default now()
);

create table public.worker_nodes (
  id text primary key,
  runtime text not null,
  status text not null,
  capabilities text[] not null default '{}',
  concurrency_limit integer not null default 1,
  deployment_id text,
  last_heartbeat_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  actor_id text,
  action text not null,
  resource_type text not null,
  resource_id text,
  outcome text not null default 'success',
  reason text,
  correlation_id text,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);
create index audit_workspace_created_idx on public.audit_events(workspace_id, created_at desc);

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create or replace function public.capture_audit_event() returns trigger language plpgsql security definer set search_path = public as $$
declare old_row jsonb; new_row jsonb; ws uuid; rid text;
begin
  old_row := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end;
  new_row := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end;
  if tg_table_name='evidence_artifacts' then
    old_row := old_row - 'raw_content' - 'extracted_text';
    new_row := new_row - 'raw_content' - 'extracted_text';
  end if;
  ws := case when tg_table_name='workspaces' and tg_op='DELETE' then null else coalesce(
    (new_row->>'workspace_id')::uuid,
    (old_row->>'workspace_id')::uuid,
    case when tg_table_name = 'workspaces' then (new_row->>'id')::uuid end,
    case when tg_table_name = 'workspaces' then (old_row->>'id')::uuid end
  ) end;
  rid := coalesce(new_row->>'id', old_row->>'id', new_row->>'source_id', old_row->>'source_id');
  insert into public.audit_events(workspace_id, actor_id, action, resource_type, resource_id, before_state, after_state)
  values (ws, auth.user_id(), lower(tg_table_name || '.' || tg_op), tg_table_name, rid, old_row, new_row);
  return coalesce(new, old);
end $$;

do $$ declare t text; begin
  foreach t in array array['workspaces','workspace_memberships','source_definitions','source_policy_versions','scrape_campaigns','scrape_jobs','scrape_job_attempts','evidence_artifacts','signal_observations','organizations','maturity_assessments','opportunities','lead_feedback','canary_runs'] loop
    execute format('create trigger audit_%I after insert or update or delete on public.%I for each row execute function public.capture_audit_event()', t, t);
  end loop;
end $$;
create trigger workspaces_updated before update on public.workspaces for each row execute function public.set_updated_at();
create trigger sources_updated before update on public.source_definitions for each row execute function public.set_updated_at();
create trigger campaigns_updated before update on public.scrape_campaigns for each row execute function public.set_updated_at();
create trigger jobs_updated before update on public.scrape_jobs for each row execute function public.set_updated_at();
create trigger organizations_updated before update on public.organizations for each row execute function public.set_updated_at();
create trigger opportunities_updated before update on public.opportunities for each row execute function public.set_updated_at();

create or replace function public.ensure_personal_workspace(p_name text default 'Raphah Lead Workspace')
returns uuid language plpgsql security definer set search_path = public as $$
declare uid text := auth.user_id(); ws uuid;
begin
  if uid is null then raise exception 'authentication required' using errcode='42501'; end if;
  select workspace_id into ws from public.workspace_memberships
    where user_id=uid and status='active' order by created_at limit 1;
  if ws is null then
    insert into public.workspaces(name,created_by) values(coalesce(nullif(trim(p_name),''),'Raphah Lead Workspace'),uid) returning id into ws;
    insert into public.workspace_memberships(workspace_id,user_id,role) values(ws,uid,'owner');
  end if;
  return ws;
end $$;
revoke execute on function public.ensure_personal_workspace(text) from public,anonymous;

create or replace function public.create_source_with_policy(p_workspace_id uuid, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare sid uuid; pid uuid; cid uuid;
begin
  if not public.has_workspace_role(p_workspace_id, array['owner','administrator','analyst']::public.workspace_role[]) then raise exception 'permission denied'; end if;
  insert into public.source_definitions(workspace_id,name,base_url,collection_method,business_purpose,status,created_by)
  values (p_workspace_id,p_input->>'name',p_input->>'baseUrl',p_input->>'collectionMethod',p_input->>'businessPurpose','pending_approval',auth.user_id()) returning id into sid;
  insert into public.source_policy_versions(workspace_id,source_id,allowed_domains,allowlist_paths,denylist_paths,daily_budget,monthly_budget,max_depth,rate_limit_rps,retention_months,user_agent,contact_email,collection_method,created_by)
  values (p_workspace_id,sid,array(select jsonb_array_elements_text(p_input->'allowedDomains')),array(select jsonb_array_elements_text(p_input->'allowlistPaths')),array(select jsonb_array_elements_text(p_input->'denylistPaths')),(p_input->>'dailyBudget')::int,(p_input->>'monthlyBudget')::int,(p_input->>'maxDepth')::int,(p_input->>'rateLimitRps')::numeric,(p_input->>'retentionMonths')::int,p_input->>'userAgent',p_input->>'contactEmail',p_input->>'collectionMethod',auth.user_id()) returning id into pid;
  insert into public.scrape_campaigns(workspace_id,source_id,name,interval_minutes,updated_by) values (p_workspace_id,sid,(p_input->>'name') || ' discovery',(p_input->>'intervalMinutes')::int,auth.user_id()) returning id into cid;
  return jsonb_build_object('sourceId',sid,'policyId',pid,'campaignId',cid,'status','pending_approval');
end $$;

create or replace function public.approve_source_policy(p_workspace_id uuid, p_source_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  if not public.has_workspace_role(p_workspace_id, array['owner','administrator']::public.workspace_role[]) then raise exception 'permission denied'; end if;
  select id into pid from public.source_policy_versions where workspace_id=p_workspace_id and source_id=p_source_id and status='pending_approval' order by version desc limit 1 for update;
  if pid is null then raise exception 'pending policy not found'; end if;
  update public.source_policy_versions set status='approved',approved_by=auth.user_id(),approved_at=now(),approval_reason=p_reason where id=pid;
  update public.source_definitions set status='active',active_policy_id=pid where id=p_source_id and workspace_id=p_workspace_id;
  return jsonb_build_object('sourceId',p_source_id,'policyId',pid,'status','active');
end $$;

create or replace function public.enqueue_due_scrape_jobs(p_now timestamptz)
returns integer language plpgsql security definer set search_path = public as $$
declare c record; inserted_count integer := 0;
begin
  for c in select sc.*, sd.base_url from public.scrape_campaigns sc join public.source_definitions sd on sd.id=sc.source_id where sc.schedule_enabled and sc.next_run_at <= p_now and sd.status='active' for update of sc skip locked loop
    insert into public.scrape_jobs(workspace_id,source_id,campaign_id,target_url,status,scheduled_for,idempotency_key,criteria_snapshot)
    values(c.workspace_id,c.source_id,c.id,c.base_url,'queued',c.next_run_at,'schedule:'||c.id||':'||to_char(c.next_run_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),c.criteria)
    on conflict(idempotency_key) do nothing;
    if found then inserted_count := inserted_count + 1; end if;
    update public.scrape_campaigns set next_run_at = greatest(c.next_run_at + make_interval(mins=>c.interval_minutes), p_now + make_interval(mins=>c.interval_minutes)), updated_at=now() where id=c.id;
  end loop;
  return inserted_count;
end $$;

create or replace function public.recover_expired_scrape_leases(p_now timestamptz)
returns integer language plpgsql security definer set search_path = public as $$
declare affected integer;
begin
  update public.scrape_job_attempts a set status='failed',ended_at=p_now,error_code='LEASE_EXPIRED',error_message='worker lease expired'
    from public.scrape_jobs j where a.scrape_job_id=j.id and a.status='running' and j.status in ('leased','running') and j.lease_expires_at<p_now;
  update public.scrape_jobs set status=case when attempt_count>=max_attempts then 'dead_letter'::public.job_status else 'retrying'::public.job_status end,next_attempt_at=case when attempt_count>=max_attempts then null else p_now end,lease_owner=null,lease_expires_at=null,last_error=coalesce(last_error,'worker lease expired') where status in ('leased','running') and lease_expires_at < p_now;
  get diagnostics affected = row_count; return affected;
end $$;

create or replace function public.compact_expired_evidence(p_now timestamptz)
returns integer language plpgsql security definer set search_path=public as $$
declare affected integer;
begin
  update public.evidence_artifacts
  set raw_content=null
  where raw_content is not null and raw_content_retained_until<=p_now;
  get diagnostics affected=row_count;
  return affected;
end $$;

create or replace function public.lease_scrape_jobs(p_worker_id text,p_batch_size integer,p_lease_seconds integer,p_now timestamptz)
returns setof public.scrape_jobs language plpgsql security definer set search_path = public as $$
begin
  -- Serialize claim transactions; SKIP LOCKED on jobs alone cannot exclude
  -- two concurrent claims for different jobs on the same source.
  perform pg_advisory_xact_lock(20260922, 1);
  return query with candidates as (
    select j.id
    from public.scrape_jobs j
    where j.status in ('queued','retrying')
      and j.scheduled_for<=p_now
      and (j.next_attempt_at is null or j.next_attempt_at<=p_now)
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
          and (earlier.priority>j.priority or (earlier.priority=j.priority and (earlier.scheduled_for<j.scheduled_for or (earlier.scheduled_for=j.scheduled_for and earlier.id<j.id))))
      )
    order by j.priority desc,j.scheduled_for,j.id
    for update of j skip locked
    limit least(p_batch_size,20)
  ) update public.scrape_jobs j set status='leased',lease_owner=p_worker_id,lease_expires_at=p_now+make_interval(secs=>p_lease_seconds) from candidates c where j.id=c.id returning j.*;
end $$;

create or replace function public.complete_scrape_job(p_job_id uuid,p_worker_id text,p_result jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.scrape_jobs set status='completed',completed_at=now(),result=p_result,lease_owner=null,lease_expires_at=null,last_error=null where id=p_job_id and lease_owner=p_worker_id and status in ('leased','running');
  if not found then raise exception 'job lease is not owned by worker'; end if;
end $$;

create or replace function public.fail_scrape_job(p_job_id uuid,p_worker_id text,p_status public.job_status,p_error_message text,p_next_attempt_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('retrying','dead_letter','failed') then raise exception 'invalid failure status'; end if;
  update public.scrape_jobs set status=p_status,last_error=p_error_message,next_attempt_at=p_next_attempt_at,completed_at=case when p_status in ('dead_letter','failed') then now() else null end,lease_owner=null,lease_expires_at=null where id=p_job_id and lease_owner=p_worker_id and status in ('leased','running') and lease_expires_at>now();
  if not found then raise exception 'job lease is not owned by worker'; end if;
  update public.scrape_job_attempts set status='failed',ended_at=now(),error_message=p_error_message
    where scrape_job_id=p_job_id and worker_id=p_worker_id and status='running';
  update public.canary_runs set status=case when p_status='retrying' then 'queued' else 'failed' end,
    completed_at=case when p_status='retrying' then null else now() end,failure_reason=p_error_message
    where scrape_job_id=p_job_id;
end $$;

create or replace function public.retry_scrape_job(p_workspace_id uuid,p_job_id uuid,p_reason text)
returns public.scrape_jobs language plpgsql security definer set search_path = public as $$
declare result public.scrape_jobs;
begin
  if not public.has_workspace_role(p_workspace_id,array['owner','administrator','analyst']::public.workspace_role[]) then raise exception 'permission denied'; end if;
  update public.scrape_jobs set status='queued',next_attempt_at=now(),completed_at=null,last_error=null,lease_owner=null,lease_expires_at=null where id=p_job_id and workspace_id=p_workspace_id and status in ('failed','dead_letter','cancelled') returning * into result;
  if result.id is null then raise exception 'job cannot be retried'; end if;
  insert into public.audit_events(workspace_id,actor_id,action,resource_type,resource_id,reason) values(p_workspace_id,auth.user_id(),'scrape_job.manual_retry','scrape_jobs',p_job_id::text,p_reason);
  return result;
end $$;

create or replace function public.cancel_scrape_job(p_workspace_id uuid,p_job_id uuid,p_reason text)
returns public.scrape_jobs language plpgsql security definer set search_path = public as $$
declare result public.scrape_jobs;
begin
  if not public.has_workspace_role(p_workspace_id,array['owner','administrator','analyst']::public.workspace_role[]) then raise exception 'permission denied'; end if;
  update public.scrape_jobs set status='cancelled',completed_at=now(),lease_owner=null,lease_expires_at=null where id=p_job_id and workspace_id=p_workspace_id and status in ('queued','retrying','leased') returning * into result;
  if result.id is null then raise exception 'job cannot be cancelled'; end if;
  insert into public.audit_events(workspace_id,actor_id,action,resource_type,resource_id,reason) values(p_workspace_id,auth.user_id(),'scrape_job.cancelled','scrape_jobs',p_job_id::text,p_reason);
  return result;
end $$;

alter table public.workspaces enable row level security;
alter table public.workspace_memberships enable row level security;
do $$ declare t text; begin
  foreach t in array array['source_definitions','source_policy_versions','scrape_campaigns','scrape_jobs','scrape_job_attempts','evidence_artifacts','signal_observations','organizations','maturity_assessments','opportunities','lead_feedback','canary_runs','audit_events'] loop execute format('alter table public.%I enable row level security',t); end loop;
end $$;

create policy workspace_select on public.workspaces for select using (public.is_workspace_member(id));
create policy membership_select on public.workspace_memberships for select using (user_id=auth.user_id() or public.has_workspace_role(workspace_id,array['owner','administrator']::public.workspace_role[]));
create policy membership_manage on public.workspace_memberships for all using (public.has_workspace_role(workspace_id,array['owner','administrator']::public.workspace_role[])) with check (public.has_workspace_role(workspace_id,array['owner','administrator']::public.workspace_role[]));

do $$ declare t text; begin
  foreach t in array array['source_definitions','source_policy_versions','scrape_campaigns','scrape_jobs','scrape_job_attempts','evidence_artifacts','signal_observations','organizations','maturity_assessments','opportunities','lead_feedback','canary_runs','audit_events'] loop
    execute format('create policy %I_member_select on public.%I for select using (public.is_workspace_member(workspace_id))',t,t);
  end loop;
  foreach t in array array['source_definitions','source_policy_versions','scrape_campaigns','scrape_jobs','organizations','opportunities'] loop
    execute format('create policy %I_operator_write on public.%I for all using (public.has_workspace_role(workspace_id,array[''owner'',''administrator'',''analyst'']::public.workspace_role[])) with check (public.has_workspace_role(workspace_id,array[''owner'',''administrator'',''analyst'']::public.workspace_role[]))',t,t);
  end loop;
end $$;
create policy lead_feedback_review on public.lead_feedback for all using (public.has_workspace_role(workspace_id,array['owner','administrator','analyst','reviewer']::public.workspace_role[])) with check (public.has_workspace_role(workspace_id,array['owner','administrator','analyst','reviewer']::public.workspace_role[]));

grant execute on function public.ensure_personal_workspace(text) to authenticated;
grant execute on function public.create_source_with_policy(uuid,jsonb) to authenticated;
grant execute on function public.approve_source_policy(uuid,uuid,text) to authenticated;
grant execute on function public.retry_scrape_job(uuid,uuid,text) to authenticated;
grant execute on function public.cancel_scrape_job(uuid,uuid,text) to authenticated;
revoke execute on function public.enqueue_due_scrape_jobs(timestamptz) from public,anonymous,authenticated;
revoke execute on function public.recover_expired_scrape_leases(timestamptz) from public,anonymous,authenticated;
revoke execute on function public.compact_expired_evidence(timestamptz) from public,anonymous,authenticated;
revoke execute on function public.lease_scrape_jobs(text,integer,integer,timestamptz) from public,anonymous,authenticated;
revoke execute on function public.complete_scrape_job(uuid,text,jsonb) from public,anonymous,authenticated;
revoke execute on function public.fail_scrape_job(uuid,text,public.job_status,text,timestamptz) from public,anonymous,authenticated;

-- Mutation authority lives in narrowly scoped RPCs, not browser table writes.
revoke insert,update,delete on public.source_definitions,public.source_policy_versions,
  public.scrape_jobs,public.scrape_job_attempts,public.evidence_artifacts,
  public.signal_observations,public.organizations,public.maturity_assessments,
  public.opportunities,public.canary_runs,public.audit_events from anonymous,authenticated;
revoke all on public.worker_nodes,public.schema_versions from anonymous,authenticated;
alter table public.worker_nodes enable row level security;
alter table public.schema_versions enable row level security;
revoke insert,update,delete on public.scrape_campaigns from anonymous,authenticated;
grant update(criteria,criteria_version,schedule_enabled,interval_minutes,next_run_at,updated_by)
  on public.scrape_campaigns to authenticated;
revoke insert,update,delete on public.lead_feedback from anonymous,authenticated;
grant insert on public.lead_feedback to authenticated;
drop policy lead_feedback_review on public.lead_feedback;
create policy lead_feedback_review on public.lead_feedback for insert to authenticated
  with check (reviewer_id=auth.user_id()
    and public.has_workspace_role(workspace_id,array['owner','administrator','analyst','reviewer']::public.workspace_role[])
    and exists(select 1 from public.opportunities o where o.id=opportunity_id and o.workspace_id=lead_feedback.workspace_id));

create or replace function public.queue_scrape_job(p_workspace_id uuid,p_source_id uuid,p_target_url text,p_key text,p_max_attempts integer)
returns public.scrape_jobs language plpgsql security definer set search_path = public as $$
declare result public.scrape_jobs; config jsonb; cid uuid;
begin
  if not public.has_workspace_role(p_workspace_id,array['owner','administrator','analyst']::public.workspace_role[]) then raise exception 'permission denied' using errcode='42501'; end if;
  if not exists(select 1 from public.source_definitions s join public.source_policy_versions p on p.id=s.active_policy_id
    where s.id=p_source_id and s.workspace_id=p_workspace_id and s.status='active'
      and p.status='approved' and p.approved_by is not null) then raise exception 'source must be approved'; end if;
  select criteria,id into config,cid from public.scrape_campaigns where source_id=p_source_id and workspace_id=p_workspace_id;
  insert into public.scrape_jobs(workspace_id,source_id,campaign_id,target_url,idempotency_key,criteria_snapshot,max_attempts,created_by)
    values(p_workspace_id,p_source_id,cid,p_target_url,p_key,coalesce(config,'{}'::jsonb),p_max_attempts,auth.user_id())
    on conflict(idempotency_key) do nothing;
  select * into result from public.scrape_jobs where idempotency_key=p_key and workspace_id=p_workspace_id;
  if result.id is null or result.source_id<>p_source_id or result.target_url<>p_target_url or result.max_attempts<>p_max_attempts then
    raise exception 'idempotency key already used for a different request';
  end if;
  return result;
end $$;
revoke execute on function public.queue_scrape_job(uuid,uuid,text,text,integer) from public,anonymous;
grant execute on function public.queue_scrape_job(uuid,uuid,text,text,integer) to authenticated;

create or replace function public.start_scrape_attempt(p_job_id uuid,p_worker_id text)
returns integer language plpgsql security definer set search_path=public as $$
declare job public.scrape_jobs;
begin
  select * into job from public.scrape_jobs where id=p_job_id for update;
  if job.id is null or job.status<>'leased' or job.lease_owner is distinct from p_worker_id or job.lease_expires_at<=now() then
    raise exception 'job lease is not owned by worker';
  end if;
  update public.scrape_jobs set status='running',started_at=coalesce(started_at,now()),attempt_count=attempt_count+1 where id=job.id;
  insert into public.scrape_job_attempts(workspace_id,scrape_job_id,attempt_number,worker_id,status)
    values(job.workspace_id,job.id,job.attempt_count+1,p_worker_id,'running');
  return job.attempt_count+1;
end $$;
revoke execute on function public.start_scrape_attempt(uuid,text) from public,anonymous,authenticated;

-- Commit all derived records and completion under one owned, unexpired lease.
-- A stale process may upload a content-addressed object, but cannot change records.
create or replace function public.persist_scrape_result(p_job_id uuid,p_worker_id text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  job public.scrape_jobs; source public.source_definitions;
  e jsonb:=p_payload->'evidence'; s jsonb:=p_payload->'score'; o jsonb:=p_payload->'organization';
  eid uuid; oid uuid; aid uuid; lid uuid; v_result jsonb;
begin
  select * into job from public.scrape_jobs where id=p_job_id for update;
  if job.id is null or job.status<>'running' or job.lease_owner is distinct from p_worker_id or job.lease_expires_at<=now() then
    raise exception 'job lease is not owned by worker';
  end if;
  select * into source from public.source_definitions where id=job.source_id for share;
  if source.status<>'active' or source.active_policy_id is distinct from (e->>'policy_version_id')::uuid then
    raise exception 'source policy is no longer active';
  end if;
  insert into public.evidence_artifacts(workspace_id,source_id,scrape_job_id,policy_version_id,canonical_url,final_url,content_hash,content_type,byte_length,storage_bucket,storage_path,raw_content,raw_content_retained_until,extracted_title,extracted_organization,extracted_text,fetched_at,parser_version,robots_decision,response_status)
    values(job.workspace_id,job.source_id,job.id,source.active_policy_id,e->>'canonical_url',e->>'final_url',e->>'content_hash',e->>'content_type',(e->>'byte_length')::int,'neon-postgres',e->>'storage_path',left(e->>'raw_content',250000),(e->>'fetched_at')::timestamptz+make_interval(months=>(select retention_months from public.source_policy_versions where id=source.active_policy_id)),e->>'extracted_title',e->>'extracted_organization',e->>'extracted_text',(e->>'fetched_at')::timestamptz,e->>'parser_version',e->>'robots_decision',(e->>'response_status')::int)
    returning id into eid;
  insert into public.signal_observations(workspace_id,evidence_artifact_id,source_id,code,category,polarity,strength,confidence,excerpt,observed_at,expires_at)
    select job.workspace_id,eid,job.source_id,x->>'code',x->>'category',x->>'polarity',(x->>'strength')::numeric,(x->>'confidence')::numeric,x->>'excerpt',(e->>'fetched_at')::timestamptz,(e->>'fetched_at')::timestamptz+interval '30 days'
      from jsonb_array_elements(p_payload->'signals') x;
  insert into public.organizations(workspace_id,name,normalized_name,normalized_domain,website_url,city,region,last_observed_at)
    values(job.workspace_id,o->>'name',lower(o->>'name'),o->>'domain',o->>'website',p_payload->'geography'->>'city',p_payload->'geography'->>'region',(e->>'fetched_at')::timestamptz)
    on conflict(workspace_id,normalized_domain) do update set
      name=excluded.name,normalized_name=excluded.normalized_name,last_observed_at=excluded.last_observed_at,
      city=coalesce(excluded.city,organizations.city),region=coalesce(excluded.region,organizations.region)
    returning id into oid;
  insert into public.maturity_assessments(workspace_id,organization_id,scrape_job_id,evidence_artifact_id,automation_maturity_score,opportunity_potential_score,confidence,coverage_categories,components,explanation,criteria_snapshot,scoring_version,qualified)
    values(job.workspace_id,oid,job.id,eid,(s->>'automationMaturity')::int,(s->>'opportunityPotential')::int,(s->>'confidence')::numeric,(s->>'coverageCategories')::int,s->'components',s->'explanation',p_payload->'criteria',s->>'scoringVersion',(s->>'qualified')::boolean)
    returning id into aid;
  if (s->>'qualified')::boolean then
    insert into public.opportunities(workspace_id,organization_id,latest_assessment_id,primary_evidence_id,title,routing,automation_maturity_score,opportunity_potential_score,confidence,last_refreshed_at)
      values(job.workspace_id,oid,aid,eid,(o->>'name')||' automation opportunity',case when (s->>'opportunityPotential')::int>=75 then 'priority_review' else 'standard_review' end,(s->>'automationMaturity')::int,(s->>'opportunityPotential')::int,(s->>'confidence')::numeric,(e->>'fetched_at')::timestamptz)
      on conflict(workspace_id,organization_id) do update set latest_assessment_id=excluded.latest_assessment_id,
        primary_evidence_id=excluded.primary_evidence_id,automation_maturity_score=excluded.automation_maturity_score,
        opportunity_potential_score=excluded.opportunity_potential_score,confidence=excluded.confidence,last_refreshed_at=excluded.last_refreshed_at
      returning id into lid;
  end if;
  v_result:=jsonb_build_object('evidenceId',eid,'assessmentId',aid,'opportunityId',lid,'signalCount',jsonb_array_length(p_payload->'signals'),'score',s,'geography',p_payload->'geography');
  update public.scrape_jobs set status='completed',completed_at=now(),result=v_result,lease_owner=null,lease_expires_at=null,last_error=null where id=job.id;
  update public.scrape_job_attempts set status='completed',ended_at=now(),response_status=(e->>'response_status')::int,bytes_downloaded=(e->>'byte_length')::int
    where scrape_job_id=job.id and attempt_number=job.attempt_count and worker_id=p_worker_id;
  update public.canary_runs set status='completed',completed_at=now(),failure_reason=null where id=job.canary_run_id;
  return v_result;
end $$;
revoke execute on function public.persist_scrape_result(uuid,text,jsonb) from public,anonymous,authenticated;

create or replace function public.campaign_qualified_counts(p_workspace_id uuid)
returns table(campaign_id uuid,qualified_count bigint) language sql stable security invoker set search_path=public as $$
  select j.campaign_id,count(distinct a.organization_id)
  from public.maturity_assessments a join public.scrape_jobs j on j.id=a.scrape_job_id
  where a.workspace_id=p_workspace_id and a.qualified and a.evaluated_at>=now()-interval '7 days'
    and j.canary_run_id is null
  group by j.campaign_id
$$;
revoke execute on function public.campaign_qualified_counts(uuid) from public,anonymous;
grant execute on function public.campaign_qualified_counts(uuid) to authenticated;

-- Neon Data API permissions are explicit; RLS remains the tenant boundary.
grant usage on schema public to authenticated,anonymous;
grant select on public.workspaces,public.workspace_memberships,public.source_definitions,
  public.source_policy_versions,public.scrape_campaigns,public.scrape_jobs,
  public.scrape_job_attempts,public.evidence_artifacts,public.signal_observations,
  public.organizations,public.maturity_assessments,public.opportunities,
  public.lead_feedback,public.canary_runs,public.audit_events to authenticated;
