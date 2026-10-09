-- Phase 1 follow-up: demo handoff fixture (2026-10-09).
--
-- Problem: Monitoring's charter/KPI story needs a handoff row, but no
-- real Lead Engine handoff has completed end-to-end yet — so in the demo
-- environment the handoff list was empty and the charter (problem,
-- requirements, KPIs) could not be shown at all.
--
-- Fix: seed ONE demo-environment handoff, shaped exactly like a real
-- accepted LeadEngineHandoffPackage/v1 (the same case the demo
-- walkthrough runs: Harbourview Dental Studio), through the same rows a
-- real intake creates — inbox (processed), delivery project, seed
-- milestones, stage history, and charter KPIs restated from the
-- package's successMeasures with the standard measurement method.
--
-- Honesty markers: environment is 'demo' (production is never touched),
-- the signature field is labeled as a fixture, and the manifest
-- checksum is genuinely computed over the stored package text.
-- Idempotent: re-running is a no-op while the fixture exists; after a
-- demo data reset (which deletes demo inbox/projects), re-running this
-- migration restores the fixture.

do $$
declare
  pkg_text text := $pkg$
{
  "schemaVersion": "1.0.0",
  "packageId": "d0000000-0000-4000-8000-000000000001",
  "packageVersion": 1,
  "opportunityId": "d0000000-0000-4000-8000-000000000002",
  "organization": {
    "name": "Harbourview Dental Studio",
    "domain": "harbourviewdental.example.ca",
    "industry": "Dental clinic",
    "employeeCount": 12
  },
  "stakeholders": [
    { "name": "Priya Nair", "role": "Front desk lead", "influence": "high" }
  ],
  "problemStatement": "New-patient inquiries arrive by web form and email but are answered the next day or not at all. The front desk checks the inbox twice a day, re-keys every inquiry into a spreadsheet, and drafts each reply from scratch, so follow-up is slow and some inquiries are lost entirely.",
  "currentState": [
    { "processName": "Inquiry intake", "owner": "Front desk", "painPoint": "Inbox checked twice a day; average wait about 4 hours, often overnight" },
    { "processName": "Follow-up drafting", "owner": "Front desk", "painPoint": "Every reply written from a blank page after checking the schedule by hand (about 15 minutes each)" },
    { "processName": "Follow-up logging", "owner": "Front desk", "painPoint": "Spreadsheet updated by hand when someone remembers; no reliable audit trail" }
  ],
  "requirementBaseline": {
    "version": 1,
    "requirements": [
      {
        "id": "req-harbourview-1",
        "opportunityId": "d0000000-0000-4000-8000-000000000002",
        "code": "REQ-1",
        "statement": "Every qualified inquiry receives a follow-up draft within 5 minutes of intake",
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
        "id": "req-harbourview-2",
        "opportunityId": "d0000000-0000-4000-8000-000000000002",
        "code": "REQ-2",
        "statement": "Every follow-up leaves a complete audit record",
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
        "id": "req-harbourview-3",
        "opportunityId": "d0000000-0000-4000-8000-000000000002",
        "code": "REQ-3",
        "statement": "Inquiries below the qualification threshold are routed to a weekly review list instead of receiving an immediate draft",
        "priority": "should",
        "status": "validated",
        "humanValidatorId": "chidumebi",
        "acceptanceCriteria": [
          "Unqualified inquiries do not receive an immediate follow-up draft"
        ],
        "blockingQuestions": []
      }
    ],
    "features": [
      {
        "id": "feat-harbourview-1",
        "opportunityId": "d0000000-0000-4000-8000-000000000002",
        "code": "F-1",
        "name": "AI follow-up drafting",
        "userOutcome": "Staff review a ready draft instead of writing from a blank page",
        "relatedRequirementIds": ["req-harbourview-1"],
        "excludedFromHandoff": false
      },
      {
        "id": "feat-harbourview-2",
        "opportunityId": "d0000000-0000-4000-8000-000000000002",
        "code": "F-2",
        "name": "Draft-first SMS follow-up",
        "userOutcome": "Patients get a timely text once a human approves the draft",
        "relatedRequirementIds": ["req-harbourview-1"],
        "excludedFromHandoff": false
      },
      {
        "id": "feat-harbourview-3",
        "opportunityId": "d0000000-0000-4000-8000-000000000002",
        "code": "F-3",
        "name": "Automatic audit logging",
        "userOutcome": "Every follow-up can be evidenced after the fact",
        "relatedRequirementIds": ["req-harbourview-2"],
        "excludedFromHandoff": false
      }
    ]
  },
  "constraints": [
    { "description": "Draft-first: no message sends without human approval", "category": "compliance" },
    { "description": "Patient data stays in the approved region", "category": "privacy" }
  ],
  "risksAndAssumptions": [
    { "description": "Evening slot availability must stay current in the booking system", "type": "assumption", "impact": "medium" },
    { "description": "No SMS provider is contracted yet; SMS steps record drafts until one is", "type": "risk", "impact": "low" }
  ],
  "successMeasures": [
    { "metric": "First follow-up draft within 5 minutes of intake", "target": "100% of qualified inquiries" },
    { "metric": "Inquiries left unanswered", "target": "0 per month" },
    { "metric": "Follow-ups with a complete audit record", "target": "100%" }
  ],
  "commercialScope": {
    "scopeSummary": "Intake follow-up automation pilot for one clinic location",
    "estimatedValueCad": 12000,
    "timelineWeeks": 4
  },
  "supportingArtifacts": [],
  "openItems": [
    { "description": "Confirm the evening-slot source of truth in the booking system", "owner": "Front desk lead" }
  ],
  "approvedBy": "chidumebi",
  "approvedAt": "2026-10-08T18:00:00.000Z",
  "consentBasis": {
    "basisType": "inquiry",
    "recordedAt": "2026-10-08T18:00:00.000Z",
    "recordedBy": "chidumebi",
    "notes": "Inquiries originate from the clinic's own website contact form."
  },
  "manifestChecksum": "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
}
$pkg$;
  checksum text := encode(sha256(pkg_text::bytea), 'hex');
  inbox_id uuid := 'd0000000-0000-4000-8000-000000000011';
  project_id uuid := 'd0000000-0000-4000-8000-000000000012';
begin
  if exists (
    select 1 from public.handoff_inbox
    where idempotency_key = 'demo-fixture-harbourview-v1'
  ) then
    raise notice 'Demo handoff fixture already present — skipping.';
    return;
  end if;

  insert into public.handoff_inbox (
    id, idempotency_key, package, manifest_checksum, signature, status,
    environment, received_at, processed_at
  ) values (
    inbox_id,
    'demo-fixture-harbourview-v1',
    pkg_text::jsonb,
    checksum,
    'demo-fixture (seeded sample package; not a signed LE handoff)',
    'processed',
    'demo',
    '2026-10-08T18:05:00.000Z',
    '2026-10-08T18:05:00.000Z'
  );

  insert into public.delivery_projects (
    id, inbox_id, package_id, package_version, opportunity_id,
    organization_name, name, status, current_stage, environment,
    baseline_version, requirements_count, features_count
  ) values (
    project_id,
    inbox_id,
    'd0000000-0000-4000-8000-000000000001',
    1,
    'd0000000-0000-4000-8000-000000000002',
    'Harbourview Dental Studio',
    'Harbourview Dental Studio',
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
     'First follow-up draft within 5 minutes of intake',
     '100% of qualified inquiries',
     'Verified by the operator against Delivery Factory workflow run history and the delivery audit log for this project.'),
    (project_id,
     'Inquiries left unanswered',
     '0 per month',
     'Verified by the operator against Delivery Factory workflow run history and the delivery audit log for this project.'),
    (project_id,
     'Follow-ups with a complete audit record',
     '100%',
     'Verified by the operator against Delivery Factory workflow run history and the delivery audit log for this project.');
end $$;
