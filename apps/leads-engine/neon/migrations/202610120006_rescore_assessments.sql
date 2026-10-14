-- Audited rescore capability (2026-10-13, revised to spec before
-- first run — this migration has never been applied).
--
-- Scoring happens once, at collection, inside persist_scrape_result —
-- so model and criteria improvements (the PRD scoring rebuild, the
-- Job Bank market bridge, slider retunes) never reached the clinics
-- already assessed. The rescore pass recomputes a score from STORED
-- evidence and signal observations (never a re-scrape) under current
-- criteria. Design decisions, per the operator's spec:
--
--  * IMMUTABLE assessments: a rescore INSERTS a new assessment row;
--    the original stays untouched as the audit record. The
--    unique(scrape_job_id) constraint from the one-shot era is
--    dropped; "latest" is the newest evaluated_at per job, and
--    opportunities.latest_assessment_id points at it.
--  * IDEMPOTENT passes: each rescored row carries
--    rescore_fingerprint = hash(criteria + market snapshot +
--    scoring version). A repeat pass with identical inputs finds
--    the latest row already fingerprinted and writes nothing.
--  * Opportunities are NEVER deleted (consent records and human /
--    delivery feedback hang off them with cascades). Unqualifying
--    marks status = 'unqualified'; the review-queue reads filter
--    status = 'active'. Requalifying restores 'active' and refreshes
--    routing (the routing refresh also repairs the same omission in
--    persist_scrape_result below).
--  * The market signal is the one NEW observation a rescore can
--    add: it replaces any previous job_bank_market_hiring row on
--    the evidence artifact (a scoring-time overlay, refreshed per
--    pass). The clinic's own observations are never rewritten.
--  * rescore_scrape_result is SECURITY DEFINER and callable only
--    through the admin connection: EXECUTE is revoked from public,
--    anonymous, and authenticated (the lease_scrape_jobs pattern),
--    so the route's role gate cannot be bypassed via the Data API.
--
-- Schema 3.3.10

alter table public.maturity_assessments
  drop constraint if exists maturity_assessments_scrape_job_id_key;

alter table public.maturity_assessments
  add column if not exists rescore_fingerprint text;

create index if not exists idx_assessments_job_latest
  on public.maturity_assessments (scrape_job_id, evaluated_at desc);

create or replace function public.rescore_scrape_result(p_prior_assessment_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  a public.maturity_assessments;
  e public.evidence_artifacts;
  j public.scrape_jobs;
  org public.organizations;
  s jsonb := p_payload->'score';
  m jsonb := p_payload->'marketSignal';
  aid uuid; lid uuid;
begin
  select * into a from public.maturity_assessments where id = p_prior_assessment_id;
  if a.id is null then raise exception 'assessment not found'; end if;
  -- Serialize concurrent rescoring of the same job.
  perform pg_advisory_xact_lock(hashtextextended(a.scrape_job_id::text, 0));
  select * into e from public.evidence_artifacts where id = a.evidence_artifact_id;
  select * into j from public.scrape_jobs where id = a.scrape_job_id;
  select * into org from public.organizations where id = a.organization_id;

  -- The market overlay on this evidence is refreshed, never stacked.
  delete from public.signal_observations
    where evidence_artifact_id = a.evidence_artifact_id
      and code = 'job_bank_market_hiring';
  if m is not null then
    insert into public.signal_observations(workspace_id, evidence_artifact_id, source_id, code, category, polarity, strength, confidence, excerpt, observed_at, expires_at, data_mode)
      values(a.workspace_id, a.evidence_artifact_id, j.source_id, m->>'code', m->>'category', m->>'polarity', (m->>'strength')::numeric, (m->>'confidence')::numeric, m->>'excerpt', now(), now() + interval '30 days', a.data_mode);
  end if;

  -- The new, immutable assessment.
  insert into public.maturity_assessments(workspace_id, organization_id, scrape_job_id, evidence_artifact_id, automation_maturity_score, opportunity_score, confidence, coverage_categories, components, explanation, criteria_snapshot, scoring_version, qualified, data_mode, rescore_fingerprint)
    values(a.workspace_id, a.organization_id, a.scrape_job_id, a.evidence_artifact_id, (s->>'automationMaturity')::int, (s->>'opportunityScore')::int, (s->>'confidence')::numeric, (s->>'coverageCategories')::int, s->'components', s->'explanation', p_payload->'criteria', s->>'scoringVersion', (s->>'qualified')::boolean, a.data_mode, p_payload->>'fingerprint')
    returning id into aid;

  if (s->>'qualified')::boolean then
    insert into public.opportunities(workspace_id, organization_id, latest_assessment_id, primary_evidence_id, title, routing, status, automation_maturity_score, opportunity_score, confidence, last_refreshed_at, data_mode)
      values(a.workspace_id, a.organization_id, aid, a.evidence_artifact_id, (org.name)||' automation opportunity', case when (s->>'opportunityScore')::int >= 75 then 'priority_review' else 'standard_review' end, 'active', (s->>'automationMaturity')::int, (s->>'opportunityScore')::int, (s->>'confidence')::numeric, now(), a.data_mode)
      on conflict(workspace_id, organization_id, data_mode) do update set latest_assessment_id = excluded.latest_assessment_id, primary_evidence_id = excluded.primary_evidence_id, routing = excluded.routing, status = 'active', automation_maturity_score = excluded.automation_maturity_score, opportunity_score = excluded.opportunity_score, confidence = excluded.confidence, last_refreshed_at = excluded.last_refreshed_at
      returning id into lid;
  else
    -- Never delete: mark unqualified, and only when the opportunity
    -- currently points at THIS job's assessment chain (another job's
    -- newer assessment of the same org keeps its standing).
    update public.opportunities set
      status = 'unqualified',
      latest_assessment_id = aid,
      automation_maturity_score = (s->>'automationMaturity')::int,
      opportunity_score = (s->>'opportunityScore')::int,
      confidence = (s->>'confidence')::numeric,
      last_refreshed_at = now()
      where workspace_id = a.workspace_id
        and organization_id = a.organization_id
        and data_mode = a.data_mode
        and latest_assessment_id = a.id
      returning id into lid;
  end if;

  return jsonb_build_object(
    'assessmentId', aid,
    'priorAssessmentId', a.id,
    'opportunityId', lid,
    'qualified', (s->>'qualified')::boolean,
    'opportunityScore', (s->>'opportunityScore')::int
  );
end $$;

revoke execute on function public.rescore_scrape_result(uuid, jsonb)
  from public, anonymous, authenticated;

-- persist_scrape_result: the 202610120003 body verbatim except the
-- opportunity upsert now refreshes routing and status on conflict
-- (a re-collection crossing the 75 line, or requalifying an org an
-- earlier rescore marked unqualified, must not leave stale routing
-- or a stale 'unqualified' standing).
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
    insert into public.opportunities(workspace_id,organization_id,latest_assessment_id,primary_evidence_id,title,routing,status,automation_maturity_score,opportunity_score,confidence,last_refreshed_at,data_mode)
      values(job.workspace_id,oid,aid,eid,(o->>'name')||' automation opportunity',case when (s->>'opportunityScore')::int>=75 then 'priority_review' else 'standard_review' end,'active',(s->>'automationMaturity')::int,(s->>'opportunityScore')::int,(s->>'confidence')::numeric,(e->>'fetched_at')::timestamptz,job.data_mode)
      on conflict(workspace_id,organization_id,data_mode) do update set latest_assessment_id=excluded.latest_assessment_id,primary_evidence_id=excluded.primary_evidence_id,routing=excluded.routing,status='active',automation_maturity_score=excluded.automation_maturity_score,opportunity_score=excluded.opportunity_score,confidence=excluded.confidence,last_refreshed_at=excluded.last_refreshed_at returning id into lid;
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
values ('lead-engine', '3.3.10')
on conflict (service) do update
set version = excluded.version, applied_at = now();
