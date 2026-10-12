-- Scoring rebuilt to the PRD section 10 design (2026-10-12).
--
-- The PRD defines ONE Opportunity Score: a weighted sum of seven
-- factors (ICP fit, automation maturity inverse, signal strength,
-- evidence freshness, contactability, intent/trigger, confidence),
-- with qualification = score >= 60 + confidence >= 0.6 + geography.
-- Scoring 2.x instead persisted an "opportunity potential" from a
-- formula that appears in no design document, gated by four
-- independent thresholds; on the first real clinic sample its best
-- value was 49 against its own 60 gate.
--
-- This migration renames the persisted column to match the design
-- (values are preserved; each assessment row's scoring_version —
-- '2.1.0' vs '3.0.0' — records which model produced its number) and
-- replaces persist_scrape_result with the 202609290001 body verbatim
-- except that it reads score.opportunityScore and writes the renamed
-- column (the priority_review routing threshold is unchanged).

alter table public.maturity_assessments
  rename column opportunity_potential_score to opportunity_score;

alter table public.opportunities
  rename column opportunity_potential_score to opportunity_score;

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
  insert into public.maturity_assessments(workspace_id,organization_id,scrape_job_id,evidence_artifact_id,automation_maturity_score,opportunity_score,confidence,coverage_categories,components,explanation,criteria_snapshot,scoring_version,qualified,data_mode)
    values(job.workspace_id,oid,job.id,eid,(s->>'automationMaturity')::int,(s->>'opportunityScore')::int,(s->>'confidence')::numeric,(s->>'coverageCategories')::int,s->'components',s->'explanation',p_payload->'criteria',s->>'scoringVersion',(s->>'qualified')::boolean,job.data_mode) returning id into aid;
  if (s->>'qualified')::boolean then
    insert into public.opportunities(workspace_id,organization_id,latest_assessment_id,primary_evidence_id,title,routing,automation_maturity_score,opportunity_score,confidence,last_refreshed_at,data_mode)
      values(job.workspace_id,oid,aid,eid,(o->>'name')||' automation opportunity',case when (s->>'opportunityScore')::int>=75 then 'priority_review' else 'standard_review' end,(s->>'automationMaturity')::int,(s->>'opportunityScore')::int,(s->>'confidence')::numeric,(e->>'fetched_at')::timestamptz,job.data_mode)
      on conflict(workspace_id,organization_id,data_mode) do update set latest_assessment_id=excluded.latest_assessment_id,primary_evidence_id=excluded.primary_evidence_id,automation_maturity_score=excluded.automation_maturity_score,opportunity_score=excluded.opportunity_score,confidence=excluded.confidence,last_refreshed_at=excluded.last_refreshed_at returning id into lid;
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

insert into public.schema_versions(service, version)
values ('lead-engine', '3.3.7')
on conflict (service) do update
set version = excluded.version, applied_at = now();
