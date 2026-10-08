-- Toronto Open Data + Canada Job Bank discovery adapters and environment
-- isolation. Existing non-canary rows are deliberately classified as
-- `pilot`; nothing is promoted to `production` implicitly.

alter table public.source_definitions
  add column if not exists data_mode text not null default 'pilot'
  check (data_mode in ('demo','pilot','production'));
alter table public.source_policy_versions
  add column if not exists allow_discovered_domains boolean not null default false;
alter table public.scrape_campaigns
  add column if not exists data_mode text not null default 'pilot'
  check (data_mode in ('demo','pilot','production'));
alter table public.discovery_sources
  add column if not exists data_mode text not null default 'pilot'
  check (data_mode in ('demo','pilot','production')),
  add column if not exists adapter_config jsonb not null default '{}'::jsonb;
alter table public.discovery_runs
  add column if not exists data_mode text not null default 'pilot'
  check (data_mode in ('demo','pilot','production')),
  add column if not exists candidates_persisted integer not null default 0,
  add column if not exists candidates_unresolved integer not null default 0;
alter table public.scrape_jobs
  add column if not exists data_mode text not null default 'pilot'
  check (data_mode in ('demo','pilot','production'));
alter table public.evidence_artifacts
  add column if not exists data_mode text not null default 'pilot'
  check (data_mode in ('demo','pilot','production'));
alter table public.signal_observations
  add column if not exists data_mode text not null default 'pilot'
  check (data_mode in ('demo','pilot','production'));
alter table public.organizations
  add column if not exists data_mode text not null default 'pilot'
  check (data_mode in ('demo','pilot','production'));
alter table public.maturity_assessments
  add column if not exists data_mode text not null default 'pilot'
  check (data_mode in ('demo','pilot','production'));
alter table public.opportunities
  add column if not exists data_mode text not null default 'pilot'
  check (data_mode in ('demo','pilot','production'));
alter table public.lead_feedback
  add column if not exists data_mode text not null default 'pilot'
  check (data_mode in ('demo','pilot','production'));

update public.scrape_jobs set data_mode='demo' where canary_run_id is not null;
update public.evidence_artifacts e set data_mode=j.data_mode
from public.scrape_jobs j where j.id=e.scrape_job_id;
update public.maturity_assessments a set data_mode=j.data_mode
from public.scrape_jobs j where j.id=a.scrape_job_id;
update public.signal_observations s set data_mode=e.data_mode
from public.evidence_artifacts e where e.id=s.evidence_artifact_id;
update public.opportunities o set data_mode=a.data_mode
from public.maturity_assessments a where a.id=o.latest_assessment_id;
update public.lead_feedback f set data_mode=o.data_mode
from public.opportunities o where o.id=f.opportunity_id;

alter table public.organizations
  drop constraint if exists organizations_workspace_id_normalized_domain_key;
create unique index if not exists organizations_workspace_domain_mode_key
  on public.organizations(workspace_id, normalized_domain, data_mode);
alter table public.opportunities
  drop constraint if exists opportunities_workspace_id_organization_id_key;
create unique index if not exists opportunities_workspace_org_mode_key
  on public.opportunities(workspace_id, organization_id, data_mode);

create table if not exists public.discovery_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  discovery_source_id uuid not null references public.discovery_sources(id) on delete cascade,
  discovery_run_id uuid references public.discovery_runs(id) on delete set null,
  adapter_id text not null,
  external_id text not null,
  data_mode text not null check (data_mode in ('demo','pilot','production')),
  name text,
  normalized_name text,
  identity_key text not null,
  website text,
  resolved_website text,
  resolution_status text not null default 'unresolved'
    check (resolution_status in ('direct','matched','review_required','unresolved','rejected')),
  resolution_confidence numeric not null default 0
    check (resolution_confidence between 0 and 1),
  resolved_by text,
  resolved_at timestamptz,
  resolution_notes text,
  address text,
  latitude numeric,
  longitude numeric,
  category text,
  source_url text not null,
  source_observed_at timestamptz not null,
  evidence_text text not null default '',
  raw_record jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, adapter_id, external_id, data_mode)
);
create index if not exists discovery_candidates_identity_idx
  on public.discovery_candidates(workspace_id, data_mode, identity_key)
  where resolution_status <> 'rejected';
create index if not exists discovery_candidates_source_idx
  on public.discovery_candidates(discovery_source_id, last_seen_at desc);
create index if not exists discovery_candidates_workspace_mode_seen_idx
  on public.discovery_candidates(workspace_id, data_mode, last_seen_at desc);

alter table public.scrape_jobs
  add column if not exists discovery_candidate_id uuid
  references public.discovery_candidates(id) on delete set null;
create index if not exists scrape_jobs_discovery_candidate_idx
  on public.scrape_jobs(discovery_candidate_id)
  where discovery_candidate_id is not null;
create index if not exists scrape_jobs_workspace_mode_created_idx
  on public.scrape_jobs(workspace_id, data_mode, created_at desc);
create index if not exists source_definitions_workspace_mode_status_idx
  on public.source_definitions(workspace_id, data_mode, status);
create index if not exists scrape_campaigns_workspace_mode_idx
  on public.scrape_campaigns(workspace_id, data_mode, created_at desc);
create index if not exists maturity_assessments_workspace_mode_evaluated_idx
  on public.maturity_assessments(workspace_id, data_mode, evaluated_at desc);
create index if not exists opportunities_workspace_mode_created_idx
  on public.opportunities(workspace_id, data_mode, created_at desc);

create table if not exists public.discovery_checkpoints (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  discovery_source_id uuid not null references public.discovery_sources(id) on delete cascade,
  data_mode text not null check (data_mode in ('demo','pilot','production')),
  cursor_value text,
  source_version text,
  source_modified_at timestamptz,
  content_checksum text,
  last_success_at timestamptz,
  record_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key(discovery_source_id, data_mode)
);

create table if not exists public.organization_source_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  discovery_candidate_id uuid not null references public.discovery_candidates(id) on delete cascade,
  data_mode text not null check (data_mode in ('demo','pilot','production')),
  match_method text not null,
  match_confidence numeric not null check (match_confidence between 0 and 1),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(organization_id, discovery_candidate_id, data_mode)
);
create index if not exists organization_source_links_workspace_mode_idx
  on public.organization_source_links(workspace_id, data_mode, created_at desc);
create index if not exists organization_source_links_candidate_idx
  on public.organization_source_links(discovery_candidate_id);

alter table public.discovery_candidates enable row level security;
alter table public.discovery_checkpoints enable row level security;
alter table public.organization_source_links enable row level security;
create policy discovery_candidates_member_select on public.discovery_candidates
  for select using (public.is_workspace_member(workspace_id));
create policy discovery_candidates_operator_write on public.discovery_candidates
  for all using (public.has_workspace_role(workspace_id,array['owner','administrator','analyst']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id,array['owner','administrator','analyst']::public.workspace_role[]));
create policy discovery_checkpoints_member_select on public.discovery_checkpoints
  for select using (public.is_workspace_member(workspace_id));
create policy discovery_checkpoints_operator_write on public.discovery_checkpoints
  for all using (public.has_workspace_role(workspace_id,array['owner','administrator','analyst']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id,array['owner','administrator','analyst']::public.workspace_role[]));
create policy organization_source_links_member_select on public.organization_source_links
  for select using (public.is_workspace_member(workspace_id));
create policy organization_source_links_operator_write on public.organization_source_links
  for all using (public.has_workspace_role(workspace_id,array['owner','administrator','analyst','reviewer']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id,array['owner','administrator','analyst','reviewer']::public.workspace_role[]));

grant select,insert,update on public.discovery_candidates to authenticated;
grant select,insert,update on public.discovery_checkpoints to authenticated;
grant select,insert,update on public.organization_source_links to authenticated;

drop trigger if exists audit_discovery_candidates on public.discovery_candidates;
create trigger audit_discovery_candidates after insert or update or delete on public.discovery_candidates
  for each row execute function public.capture_audit_event();
drop trigger if exists audit_discovery_checkpoints on public.discovery_checkpoints;
create trigger audit_discovery_checkpoints after insert or update or delete on public.discovery_checkpoints
  for each row execute function public.capture_audit_event();
drop trigger if exists audit_organization_source_links on public.organization_source_links;
create trigger audit_organization_source_links after insert or update or delete on public.organization_source_links
  for each row execute function public.capture_audit_event();

drop trigger if exists discovery_candidates_updated on public.discovery_candidates;
create trigger discovery_candidates_updated before update on public.discovery_candidates
  for each row execute function public.set_updated_at();
drop trigger if exists discovery_checkpoints_updated on public.discovery_checkpoints;
create trigger discovery_checkpoints_updated before update on public.discovery_checkpoints
  for each row execute function public.set_updated_at();

create or replace function public.create_source_with_policy(p_workspace_id uuid, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare sid uuid; pid uuid; cid uuid; mode text:=coalesce(p_input->>'dataMode','pilot');
begin
  if mode not in ('demo','pilot','production') then raise exception 'invalid data mode'; end if;
  if not public.has_workspace_role(p_workspace_id, array['owner','administrator','analyst']::public.workspace_role[]) then raise exception 'permission denied'; end if;
  insert into public.source_definitions(workspace_id,name,base_url,collection_method,business_purpose,status,created_by,data_mode)
  values (p_workspace_id,p_input->>'name',p_input->>'baseUrl',p_input->>'collectionMethod',p_input->>'businessPurpose','pending_approval',auth.user_id(),mode) returning id into sid;
  insert into public.source_policy_versions(workspace_id,source_id,allowed_domains,allowlist_paths,denylist_paths,daily_budget,monthly_budget,max_depth,rate_limit_rps,retention_months,user_agent,contact_email,collection_method,created_by,allow_discovered_domains)
  values (p_workspace_id,sid,array(select jsonb_array_elements_text(p_input->'allowedDomains')),array(select jsonb_array_elements_text(p_input->'allowlistPaths')),array(select jsonb_array_elements_text(p_input->'denylistPaths')),(p_input->>'dailyBudget')::int,(p_input->>'monthlyBudget')::int,(p_input->>'maxDepth')::int,(p_input->>'rateLimitRps')::numeric,(p_input->>'retentionMonths')::int,p_input->>'userAgent',p_input->>'contactEmail',p_input->>'collectionMethod',auth.user_id(),coalesce((p_input->>'allowDiscoveredDomains')::boolean,false)) returning id into pid;
  insert into public.scrape_campaigns(workspace_id,source_id,name,interval_minutes,updated_by,data_mode)
  values (p_workspace_id,sid,(p_input->>'name') || ' discovery',(p_input->>'intervalMinutes')::int,auth.user_id(),mode) returning id into cid;
  return jsonb_build_object('sourceId',sid,'policyId',pid,'campaignId',cid,'status','pending_approval','dataMode',mode);
end $$;

create or replace function public.enqueue_due_scrape_jobs(p_now timestamptz)
returns integer language plpgsql security definer set search_path = public as $$
declare c record; inserted_count integer := 0;
begin
  for c in select sc.*,sd.base_url,sd.data_mode as source_data_mode from public.scrape_campaigns sc join public.source_definitions sd on sd.id=sc.source_id where sc.schedule_enabled and sc.next_run_at<=p_now and sd.status='active' for update of sc skip locked loop
    insert into public.scrape_jobs(workspace_id,source_id,campaign_id,target_url,status,scheduled_for,idempotency_key,criteria_snapshot,data_mode)
    values(c.workspace_id,c.source_id,c.id,c.base_url,'queued',c.next_run_at,'schedule:'||c.source_data_mode||':'||c.id||':'||to_char(c.next_run_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),c.criteria,c.source_data_mode)
    on conflict(idempotency_key) do nothing;
    if found then inserted_count:=inserted_count+1; end if;
    update public.scrape_campaigns set next_run_at=greatest(c.next_run_at+make_interval(mins=>c.interval_minutes),p_now+make_interval(mins=>c.interval_minutes)),updated_at=now() where id=c.id;
  end loop;
  return inserted_count;
end $$;

create or replace function public.queue_scrape_job(p_workspace_id uuid,p_source_id uuid,p_target_url text,p_key text,p_max_attempts integer)
returns public.scrape_jobs language plpgsql security definer set search_path = public as $$
declare result public.scrape_jobs; config jsonb; cid uuid; mode text;
begin
  if not public.has_workspace_role(p_workspace_id,array['owner','administrator','analyst']::public.workspace_role[]) then raise exception 'permission denied' using errcode='42501'; end if;
  select s.data_mode into mode from public.source_definitions s join public.source_policy_versions p on p.id=s.active_policy_id
    where s.id=p_source_id and s.workspace_id=p_workspace_id and s.status='active' and p.status='approved' and p.approved_by is not null;
  if mode is null then raise exception 'source must be approved'; end if;
  select criteria,id into config,cid from public.scrape_campaigns where source_id=p_source_id and workspace_id=p_workspace_id;
  insert into public.scrape_jobs(workspace_id,source_id,campaign_id,target_url,idempotency_key,criteria_snapshot,max_attempts,created_by,data_mode)
    values(p_workspace_id,p_source_id,cid,p_target_url,p_key,coalesce(config,'{}'::jsonb),p_max_attempts,auth.user_id(),mode)
    on conflict(idempotency_key) do nothing;
  select * into result from public.scrape_jobs where idempotency_key=p_key and workspace_id=p_workspace_id;
  if result.id is null or result.source_id<>p_source_id or result.target_url<>p_target_url or result.max_attempts<>p_max_attempts or result.data_mode<>mode then
    raise exception 'idempotency key already used for a different request';
  end if;
  return result;
end $$;

create or replace function public.resolve_discovery_candidate(
  p_workspace_id uuid,
  p_candidate_id uuid,
  p_website text,
  p_domain text,
  p_key text,
  p_notes text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare candidate public.discovery_candidates; discovery public.discovery_sources; job public.scrape_jobs; policy public.source_policy_versions;
begin
  if not public.has_workspace_role(p_workspace_id,array['owner','administrator','analyst']::public.workspace_role[]) then
    raise exception 'permission denied' using errcode='42501';
  end if;
  if p_website !~ '^https?://' then raise exception 'resolved website must use HTTP(S)'; end if;
  select * into candidate from public.discovery_candidates
    where id=p_candidate_id and workspace_id=p_workspace_id for update;
  if candidate.id is null then raise exception 'discovery candidate not found'; end if;
  select * into discovery from public.discovery_sources
    where id=candidate.discovery_source_id and workspace_id=p_workspace_id;
  if discovery.id is null or discovery.data_mode<>candidate.data_mode then
    raise exception 'candidate discovery source is invalid';
  end if;
  select p.* into policy from public.source_definitions s
    join public.source_policy_versions p on p.id=s.active_policy_id
    where s.id=discovery.source_id and s.workspace_id=p_workspace_id
      and s.status='active' and p.status='approved' and p.approved_by is not null;
  if policy.id is null then raise exception 'collection source is not approved'; end if;
  if not policy.allow_discovered_domains and not exists (
    select 1 from unnest(policy.allowed_domains) as permitted(domain)
    where lower(p_domain)=lower(permitted.domain)
      or lower(p_domain) like '%.' || lower(permitted.domain)
  ) then
    raise exception 'collection policy does not permit discovered domains';
  end if;
  update public.discovery_candidates set
    resolved_website=p_website,
    resolution_status='matched',
    resolution_confidence=1,
    resolved_by=auth.user_id(),
    resolved_at=now(),
    resolution_notes=p_notes
  where id=candidate.id;
  select * into job from public.queue_scrape_job(
    p_workspace_id,discovery.source_id,p_website,p_key,3
  );
  update public.scrape_jobs set
    discovery_candidate_id=coalesce(discovery_candidate_id,candidate.id)
  where id=job.id;
  return jsonb_build_object(
    'candidateId',candidate.id,
    'jobId',job.id,
    'dataMode',candidate.data_mode,
    'status',job.status
  );
end $$;

grant execute on function public.resolve_discovery_candidate(uuid,uuid,text,text,text,text) to authenticated;
revoke execute on function public.resolve_discovery_candidate(uuid,uuid,text,text,text,text) from public,anonymous;

create or replace function public.persist_scrape_result(p_job_id uuid,p_worker_id text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  job public.scrape_jobs; source public.source_definitions;
  e jsonb:=p_payload->'evidence'; s jsonb:=p_payload->'score'; o jsonb:=p_payload->'organization';
  eid uuid; oid uuid; aid uuid; lid uuid; v_result jsonb;
begin
  select * into job from public.scrape_jobs where id=p_job_id for update;
  if job.id is null or job.status<>'running' or job.lease_owner is distinct from p_worker_id or job.lease_expires_at<=now() then raise exception 'job lease is not owned by worker'; end if;
  select * into source from public.source_definitions where id=job.source_id for share;
  if source.status<>'active' or source.active_policy_id is distinct from (e->>'policy_version_id')::uuid then raise exception 'source policy is no longer active'; end if;
  if source.data_mode<>job.data_mode then raise exception 'source and job data modes do not match'; end if;
  insert into public.evidence_artifacts(workspace_id,source_id,scrape_job_id,policy_version_id,canonical_url,final_url,content_hash,content_type,byte_length,storage_bucket,storage_path,raw_content,raw_content_retained_until,extracted_title,extracted_organization,extracted_text,fetched_at,parser_version,robots_decision,response_status,data_mode)
    values(job.workspace_id,job.source_id,job.id,source.active_policy_id,e->>'canonical_url',e->>'final_url',e->>'content_hash',e->>'content_type',(e->>'byte_length')::int,'neon-postgres',e->>'storage_path',left(e->>'raw_content',250000),(e->>'fetched_at')::timestamptz+make_interval(months=>(select retention_months from public.source_policy_versions where id=source.active_policy_id)),e->>'extracted_title',e->>'extracted_organization',e->>'extracted_text',(e->>'fetched_at')::timestamptz,e->>'parser_version',e->>'robots_decision',(e->>'response_status')::int,job.data_mode) returning id into eid;
  insert into public.signal_observations(workspace_id,evidence_artifact_id,source_id,code,category,polarity,strength,confidence,excerpt,observed_at,expires_at,data_mode)
    select job.workspace_id,eid,job.source_id,x->>'code',x->>'category',x->>'polarity',(x->>'strength')::numeric,(x->>'confidence')::numeric,x->>'excerpt',(e->>'fetched_at')::timestamptz,(e->>'fetched_at')::timestamptz+interval '30 days',job.data_mode from jsonb_array_elements(p_payload->'signals') x;
  insert into public.organizations(workspace_id,name,normalized_name,normalized_domain,website_url,city,region,last_observed_at,data_mode)
    values(job.workspace_id,o->>'name',lower(o->>'name'),o->>'domain',o->>'website',p_payload->'geography'->>'city',p_payload->'geography'->>'region',(e->>'fetched_at')::timestamptz,job.data_mode)
    on conflict(workspace_id,normalized_domain,data_mode) do update set name=excluded.name,normalized_name=excluded.normalized_name,last_observed_at=excluded.last_observed_at,city=coalesce(excluded.city,organizations.city),region=coalesce(excluded.region,organizations.region) returning id into oid;
  insert into public.maturity_assessments(workspace_id,organization_id,scrape_job_id,evidence_artifact_id,automation_maturity_score,opportunity_potential_score,confidence,coverage_categories,components,explanation,criteria_snapshot,scoring_version,qualified,data_mode)
    values(job.workspace_id,oid,job.id,eid,(s->>'automationMaturity')::int,(s->>'opportunityPotential')::int,(s->>'confidence')::numeric,(s->>'coverageCategories')::int,s->'components',s->'explanation',p_payload->'criteria',s->>'scoringVersion',(s->>'qualified')::boolean,job.data_mode) returning id into aid;
  if (s->>'qualified')::boolean then
    insert into public.opportunities(workspace_id,organization_id,latest_assessment_id,primary_evidence_id,title,routing,automation_maturity_score,opportunity_potential_score,confidence,last_refreshed_at,data_mode)
      values(job.workspace_id,oid,aid,eid,(o->>'name')||' automation opportunity',case when (s->>'opportunityPotential')::int>=75 then 'priority_review' else 'standard_review' end,(s->>'automationMaturity')::int,(s->>'opportunityPotential')::int,(s->>'confidence')::numeric,(e->>'fetched_at')::timestamptz,job.data_mode)
      on conflict(workspace_id,organization_id,data_mode) do update set latest_assessment_id=excluded.latest_assessment_id,primary_evidence_id=excluded.primary_evidence_id,automation_maturity_score=excluded.automation_maturity_score,opportunity_potential_score=excluded.opportunity_potential_score,confidence=excluded.confidence,last_refreshed_at=excluded.last_refreshed_at returning id into lid;
  end if;
  if job.discovery_candidate_id is not null then
    insert into public.organization_source_links(workspace_id,organization_id,discovery_candidate_id,data_mode,match_method,match_confidence)
    values(job.workspace_id,oid,job.discovery_candidate_id,job.data_mode,'resolved_website',1)
    on conflict(organization_id,discovery_candidate_id,data_mode) do nothing;
  end if;
  v_result:=jsonb_build_object('evidenceId',eid,'assessmentId',aid,'opportunityId',lid,'signalCount',jsonb_array_length(p_payload->'signals'),'score',s,'geography',p_payload->'geography','dataMode',job.data_mode);
  update public.scrape_jobs set status='completed',completed_at=now(),result=v_result,lease_owner=null,lease_expires_at=null,last_error=null where id=job.id;
  update public.scrape_job_attempts set status='completed',ended_at=now(),response_status=(e->>'response_status')::int,bytes_downloaded=(e->>'byte_length')::int where scrape_job_id=job.id and attempt_number=job.attempt_count and worker_id=p_worker_id;
  update public.canary_runs set status='completed',completed_at=now(),failure_reason=null where id=job.canary_run_id;
  return v_result;
end $$;

update public.schema_versions set version='3.3.0', applied_at=now()
where service='lead-engine';
