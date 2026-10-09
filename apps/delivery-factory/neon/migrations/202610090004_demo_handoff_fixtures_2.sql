-- Demo handoff fixtures 2 (2026-10-09): Northgate Legal + TrueNorth.
--
-- Follow-up to 202610090003. The demo walkthrough gained two more cases
-- (Northgate Legal LLP — after-hours closing inquiry; TrueNorth Home
-- Services — job-completed review request), but only Harbourview had a
-- seeded handoff, so Monitoring's charter/KPI story existed for one
-- project only. This migration seeds the other two cases the same way:
-- contract-shaped v1 packages (their problem statements, current state,
-- and success measures are the walkthrough cases' own), through the
-- same rows a real intake creates — inbox (processed), delivery
-- project, seed milestones, stage history, charter KPIs.
--
-- Same honesty markers as 003: environment 'demo' only, signature
-- labeled as a fixture, manifest checksum genuinely computed over the
-- stored package text, idempotent per fixture, no schema-version
-- change (readiness stays at 1.3.0). Re-running after a demo reset
-- restores both fixtures.

-- ── Northgate Legal LLP ──────────────────────────────────────────────
do $$
declare
  pkg_text text := $pkg$
{
  "schemaVersion": "1.0.0",
  "packageId": "d0000000-0000-4000-8000-000000000101",
  "packageVersion": 1,
  "opportunityId": "d0000000-0000-4000-8000-000000000102",
  "organization": {
    "name": "Northgate Legal LLP",
    "domain": "northgatelegal.example.ca",
    "industry": "Law firm",
    "employeeCount": 18
  },
  "stakeholders": [
    { "name": "Sarah Whitfield", "role": "Office manager", "influence": "high" }
  ],
  "problemStatement": "Closing inquiries are deadline-driven, but after-hours submissions wait until the next business day and join the same callback queue as general questions. Callers with a closing date often sign with the first firm that responds.",
  "currentState": [
    { "processName": "After-hours intake", "owner": "Intake assistant", "painPoint": "Evening submissions are seen when the office opens the next business day — a wait of about 12 hours" },
    { "processName": "Response drafting", "owner": "Intake assistant", "painPoint": "Replies assembled from precedent files by hand, with the fee wording checked manually (about 20 minutes each)" },
    { "processName": "Intake logging", "owner": "Intake assistant", "painPoint": "Matter, deadline, and status typed into a spreadsheet by hand; no reliable audit trail" }
  ],
  "requirementBaseline": {
    "version": 1,
    "requirements": [
      {
        "id": "req-northgate-1",
        "opportunityId": "d0000000-0000-4000-8000-000000000102",
        "code": "REQ-1",
        "statement": "Every closing inquiry receives an email response draft within 5 minutes of submission, at any hour",
        "priority": "must",
        "status": "validated",
        "humanValidatorId": "chidumebi",
        "acceptanceCriteria": [
          "A draft exists in the workflow run record for the inquiry",
          "The draft is held for human approval; nothing auto-sends"
        ],
        "blockingQuestions": []
      },
      {
        "id": "req-northgate-2",
        "opportunityId": "d0000000-0000-4000-8000-000000000102",
        "code": "REQ-2",
        "statement": "Every response leaves a complete audit record",
        "priority": "must",
        "status": "validated",
        "humanValidatorId": "chidumebi",
        "acceptanceCriteria": [
          "Run steps are written to the workflow audit log",
          "Draft content is attributable to its run"
        ],
        "blockingQuestions": []
      },
      {
        "id": "req-northgate-3",
        "opportunityId": "d0000000-0000-4000-8000-000000000102",
        "code": "REQ-3",
        "statement": "Inquiries with a mobile number receive a short SMS acknowledgement once the email response is approved",
        "priority": "should",
        "status": "validated",
        "humanValidatorId": "chidumebi",
        "acceptanceCriteria": [
          "The SMS is drafted, never auto-sent",
          "Inquiries without a mobile number skip the SMS step and are logged"
        ],
        "blockingQuestions": []
      }
    ],
    "features": [
      {
        "id": "feat-northgate-1",
        "opportunityId": "d0000000-0000-4000-8000-000000000102",
        "code": "F-1",
        "name": "AI response drafting",
        "userOutcome": "Staff review a ready draft instead of assembling one from precedents",
        "relatedRequirementIds": ["req-northgate-1"],
        "excludedFromHandoff": false
      },
      {
        "id": "feat-northgate-2",
        "opportunityId": "d0000000-0000-4000-8000-000000000102",
        "code": "F-2",
        "name": "After-hours intake coverage",
        "userOutcome": "Evening inquiries are answered in minutes, not the next business day",
        "relatedRequirementIds": ["req-northgate-1"],
        "excludedFromHandoff": false
      },
      {
        "id": "feat-northgate-3",
        "opportunityId": "d0000000-0000-4000-8000-000000000102",
        "code": "F-3",
        "name": "Automatic audit logging",
        "userOutcome": "Every response can be evidenced after the fact",
        "relatedRequirementIds": ["req-northgate-2"],
        "excludedFromHandoff": false
      }
    ]
  },
  "constraints": [
    { "description": "Draft-first: no message sends without human approval", "category": "compliance" },
    { "description": "Fee wording in drafts must match the approved precedent", "category": "operational" }
  ],
  "risksAndAssumptions": [
    { "description": "Precedent fee wording stays current with the firm's fee schedule", "type": "assumption", "impact": "medium" },
    { "description": "No SMS provider is contracted yet; SMS steps record drafts until one is", "type": "risk", "impact": "low" }
  ],
  "successMeasures": [
    { "metric": "First response draft within 5 minutes", "target": "100% of inquiries, at any hour" },
    { "metric": "After-hours inquiries unanswered by 9 AM", "target": "0" },
    { "metric": "Responses with a complete audit record", "target": "100%" }
  ],
  "commercialScope": {
    "scopeSummary": "After-hours closing-inquiry response pilot for one firm office",
    "estimatedValueCad": 15000,
    "timelineWeeks": 3
  },
  "supportingArtifacts": [],
  "openItems": [
    { "description": "Confirm the current fee precedent wording for residential closings", "owner": "Managing partner" }
  ],
  "approvedBy": "chidumebi",
  "approvedAt": "2026-10-08T19:00:00.000Z",
  "consentBasis": {
    "basisType": "inquiry",
    "recordedAt": "2026-10-08T19:00:00.000Z",
    "recordedBy": "chidumebi",
    "notes": "Inquiries originate from the firm's own website contact form."
  },
  "manifestChecksum": "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"
}
$pkg$;
  checksum text := encode(sha256(pkg_text::bytea), 'hex');
  inbox_id uuid := 'd0000000-0000-4000-8000-000000000111';
  project_id uuid := 'd0000000-0000-4000-8000-000000000112';
begin
  if exists (
    select 1 from public.handoff_inbox
    where idempotency_key = 'demo-fixture-northgate-v1'
  ) then
    raise notice 'Northgate demo fixture already present — skipping.';
    return;
  end if;

  insert into public.handoff_inbox (
    id, idempotency_key, package, manifest_checksum, signature, status,
    environment, received_at, processed_at
  ) values (
    inbox_id,
    'demo-fixture-northgate-v1',
    pkg_text::jsonb,
    checksum,
    'demo-fixture (seeded sample package; not a signed LE handoff)',
    'processed',
    'demo',
    '2026-10-08T19:05:00.000Z',
    '2026-10-08T19:05:00.000Z'
  );

  insert into public.delivery_projects (
    id, inbox_id, package_id, package_version, opportunity_id,
    organization_name, name, status, current_stage, environment,
    baseline_version, requirements_count, features_count
  ) values (
    project_id,
    inbox_id,
    'd0000000-0000-4000-8000-000000000101',
    1,
    'd0000000-0000-4000-8000-000000000102',
    'Northgate Legal LLP',
    'Northgate Legal LLP',
    'active',
    'intake',
    'demo',
    1,
    3,
    3
  );

  insert into public.milestones (project_id, title) values
    (project_id, 'Client Onboarding & Access Verification'),
    (project_id, 'Architecture Blueprint Sign-off'),
    (project_id, 'Implementation & Integration Deployment'),
    (project_id, 'Client Handover & Acceptance Training');

  insert into public.stage_history (project_id, from_stage, to_stage, changed_by)
  values (project_id, 'intake', 'intake', 'system:intake');

  insert into public.project_kpis (project_id, metric, target, measurement) values
    (project_id,
     'First response draft within 5 minutes',
     '100% of inquiries, at any hour',
     'Verified by the operator against Delivery Factory workflow run history and the delivery audit log for this project.'),
    (project_id,
     'After-hours inquiries unanswered by 9 AM',
     '0',
     'Verified by the operator against Delivery Factory workflow run history and the delivery audit log for this project.'),
    (project_id,
     'Responses with a complete audit record',
     '100%',
     'Verified by the operator against Delivery Factory workflow run history and the delivery audit log for this project.');
end $$;

-- ── TrueNorth Home Services ──────────────────────────────────────────
do $$
declare
  pkg_text text := $pkg$
{
  "schemaVersion": "1.0.0",
  "packageId": "d0000000-0000-4000-8000-000000000201",
  "packageVersion": 1,
  "opportunityId": "d0000000-0000-4000-8000-000000000202",
  "organization": {
    "name": "TrueNorth Home Services",
    "domain": "truenorthhome.example.ca",
    "industry": "Home services",
    "employeeCount": 24
  },
  "stakeholders": [
    { "name": "Mike Tremblay", "role": "Operations manager", "influence": "high" }
  ],
  "problemStatement": "Review requests depend on technicians remembering to ask. Most completed jobs never get one, so the company's Google profile grows slowly despite happy customers — and nobody can say who was asked.",
  "currentState": [
    { "processName": "Completed-job review", "owner": "Office staff", "painPoint": "Completed jobs are reviewed in a weekly report — days after the visit, when the impression is cold" },
    { "processName": "Review requests", "owner": "Office staff", "painPoint": "Typed and sent one at a time from the office phone, only when someone remembers" },
    { "processName": "Request tracking", "owner": "Office staff", "painPoint": "A spreadsheet note if it happens at all; nobody can say who was asked" }
  ],
  "requirementBaseline": {
    "version": 1,
    "requirements": [
      {
        "id": "req-truenorth-1",
        "opportunityId": "d0000000-0000-4000-8000-000000000202",
        "code": "REQ-1",
        "statement": "A review request draft is created the same day a job is marked complete",
        "priority": "must",
        "status": "validated",
        "humanValidatorId": "chidumebi",
        "acceptanceCriteria": [
          "A draft exists in the workflow run record for the completed job",
          "The draft is held for human approval; nothing auto-sends"
        ],
        "blockingQuestions": []
      },
      {
        "id": "req-truenorth-2",
        "opportunityId": "d0000000-0000-4000-8000-000000000202",
        "code": "REQ-2",
        "statement": "Only completed jobs with a customer phone number receive a request; jobs without one are logged and skipped",
        "priority": "must",
        "status": "validated",
        "humanValidatorId": "chidumebi",
        "acceptanceCriteria": [
          "The routing check outcome is recorded on the run",
          "No request is drafted for a job without a phone number"
        ],
        "blockingQuestions": []
      },
      {
        "id": "req-truenorth-3",
        "opportunityId": "d0000000-0000-4000-8000-000000000202",
        "code": "REQ-3",
        "statement": "Every request and every skip is logged against its job",
        "priority": "should",
        "status": "validated",
        "humanValidatorId": "chidumebi",
        "acceptanceCriteria": [
          "The log names the job and the outcome (requested or skipped)"
        ],
        "blockingQuestions": []
      }
    ],
    "features": [
      {
        "id": "feat-truenorth-1",
        "opportunityId": "d0000000-0000-4000-8000-000000000202",
        "code": "F-1",
        "name": "Same-day review requests",
        "userOutcome": "Customers are asked while the visit is fresh, not days later",
        "relatedRequirementIds": ["req-truenorth-1"],
        "excludedFromHandoff": false
      },
      {
        "id": "feat-truenorth-2",
        "opportunityId": "d0000000-0000-4000-8000-000000000202",
        "code": "F-2",
        "name": "Phone routing check",
        "userOutcome": "Requests go only where they can be delivered; skips are explained",
        "relatedRequirementIds": ["req-truenorth-2"],
        "excludedFromHandoff": false
      },
      {
        "id": "feat-truenorth-3",
        "opportunityId": "d0000000-0000-4000-8000-000000000202",
        "code": "F-3",
        "name": "Request logging",
        "userOutcome": "Anyone can answer who was asked, per job",
        "relatedRequirementIds": ["req-truenorth-3"],
        "excludedFromHandoff": false
      }
    ]
  },
  "constraints": [
    { "description": "Draft-first: no message sends without human approval", "category": "compliance" },
    { "description": "Requests only to customers of completed jobs", "category": "operational" }
  ],
  "risksAndAssumptions": [
    { "description": "The field app marks jobs complete reliably at the visit", "type": "assumption", "impact": "medium" },
    { "description": "No SMS provider is contracted yet; SMS steps record drafts until one is", "type": "risk", "impact": "low" }
  ],
  "successMeasures": [
    { "metric": "Review request drafted the same day the job completes", "target": "100% of completed jobs" },
    { "metric": "Completed jobs with a phone number that receive a request", "target": "100%" },
    { "metric": "Requests logged", "target": "100%" }
  ],
  "commercialScope": {
    "scopeSummary": "Review request automation for completed jobs, one service region",
    "estimatedValueCad": 9000,
    "timelineWeeks": 3
  },
  "supportingArtifacts": [],
  "openItems": [
    { "description": "Confirm the Google review link is the current profile link", "owner": "Operations manager" }
  ],
  "approvedBy": "chidumebi",
  "approvedAt": "2026-10-08T19:30:00.000Z",
  "consentBasis": {
    "basisType": "inquiry",
    "recordedAt": "2026-10-08T19:30:00.000Z",
    "recordedBy": "chidumebi",
    "notes": "Customers provide their mobile number with the job booking."
  },
  "manifestChecksum": "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3"
}
$pkg$;
  checksum text := encode(sha256(pkg_text::bytea), 'hex');
  inbox_id uuid := 'd0000000-0000-4000-8000-000000000211';
  project_id uuid := 'd0000000-0000-4000-8000-000000000212';
begin
  if exists (
    select 1 from public.handoff_inbox
    where idempotency_key = 'demo-fixture-truenorth-v1'
  ) then
    raise notice 'TrueNorth demo fixture already present — skipping.';
    return;
  end if;

  insert into public.handoff_inbox (
    id, idempotency_key, package, manifest_checksum, signature, status,
    environment, received_at, processed_at
  ) values (
    inbox_id,
    'demo-fixture-truenorth-v1',
    pkg_text::jsonb,
    checksum,
    'demo-fixture (seeded sample package; not a signed LE handoff)',
    'processed',
    'demo',
    '2026-10-08T19:35:00.000Z',
    '2026-10-08T19:35:00.000Z'
  );

  insert into public.delivery_projects (
    id, inbox_id, package_id, package_version, opportunity_id,
    organization_name, name, status, current_stage, environment,
    baseline_version, requirements_count, features_count
  ) values (
    project_id,
    inbox_id,
    'd0000000-0000-4000-8000-000000000201',
    1,
    'd0000000-0000-4000-8000-000000000202',
    'TrueNorth Home Services',
    'TrueNorth Home Services',
    'active',
    'intake',
    'demo',
    1,
    3,
    3
  );

  insert into public.milestones (project_id, title) values
    (project_id, 'Client Onboarding & Access Verification'),
    (project_id, 'Architecture Blueprint Sign-off'),
    (project_id, 'Implementation & Integration Deployment'),
    (project_id, 'Client Handover & Acceptance Training');

  insert into public.stage_history (project_id, from_stage, to_stage, changed_by)
  values (project_id, 'intake', 'intake', 'system:intake');

  insert into public.project_kpis (project_id, metric, target, measurement) values
    (project_id,
     'Review request drafted the same day the job completes',
     '100% of completed jobs',
     'Verified by the operator against Delivery Factory workflow run history and the delivery audit log for this project.'),
    (project_id,
     'Completed jobs with a phone number that receive a request',
     '100%',
     'Verified by the operator against Delivery Factory workflow run history and the delivery audit log for this project.'),
    (project_id,
     'Requests logged',
     '100%',
     'Verified by the operator against Delivery Factory workflow run history and the delivery audit log for this project.');
end $$;
