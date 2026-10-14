-- rescore_scrape_result: guard the market-overlay insert against
-- an explicit JSON null. payload->'marketSignal' over JSON null
-- yields jsonb 'null', which is not SQL NULL, so the original
-- `m is not null` check passed and the insert wrote a NULL code
-- into signal_observations (not-null violation). The TS caller no
-- longer serializes a null marketSignal (buildRescorePayload);
-- this recreation — the 202610120006 body with only the guard
-- changed — makes the function itself immune for any caller.
--
-- Schema 3.3.18

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
  if m is not null and m <> 'null'::jsonb then
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

insert into public.schema_versions(service, version)
values ('lead-engine', '3.3.18')
on conflict (service) do update
set version = excluded.version, applied_at = now();
