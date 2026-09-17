Lead Engine Technical Design Runbook

Opportunity Management Discovery and Delivery Handoff

Purpose

Define the architecture, controls, delivery sequence and operating procedures for a self sufficient Lead Engine that manages an opportunity from detection through client discovery, requirements definition and an approved handoff to the Delivery Factory.

Document Use and Technical Decision

This runbook defines the Lead Engine as an independent opportunity management product. It discovers leads, supports outreach, records client discovery and audit sessions, manages requirements and feature candidates, and produces a versioned package for the Delivery Factory. It is written for the founder acting as product owner, business analyst and release authority, and for coding agents or future engineers implementing the platform.

Primary outcome. Deliver a self sufficient system that preserves the full commercial and discovery record for each opportunity and hands delivery teams a complete, approved baseline.

Operating rule. Models may interpret evidence and suggest content. Code and human approvals control permissions, workflow state, requirement authority, package release and external communication.

Product boundary. The Lead Engine owns work through Delivery Factory acceptance. It does not generate, test, deploy or operate client applications.

Decision Summary

Runbook Navigation

1 Architecture Principles and Constraints

Hard Constraints

No automated LinkedIn scraping, login automation, CAPTCHA bypass or access control circumvention.

No automated outreach send in the MVP. The system drafts and records; the founder approves and sends.

No source runs until its source policy is approved and active.

No model output enters the opportunity pipeline until it passes schema validation and evidence checks.

No unbounded crawl depth, page count, execution time, retry count or model spend.

No customer multi tenancy or billing in the MVP unless the business model changes through an approved decision record.

No direct database access between the Lead Engine and Delivery Factory.

No requirement becomes validated and no handoff package is released solely from model generated content.

No Delivery Factory outage may prevent opportunity discovery review engagement or requirements capture.

Planning Assumptions

2 System Context

The Lead Engine discovers commercial signals and preserves their evidence. It then supports qualification, engagement, client discovery, requirements definition, solution and commercial assessment, and controlled handoff. Every opportunity has one workspace that connects its source, organization, stakeholders, meetings, requirements, features, decisions, commercial records and Delivery Factory package.

Actors and External Systems

Figure 1  Logical architecture with deterministic controls around the opportunity loops

3 Logical Architecture

Application Layers

Module Boundaries

Dependency Rules

Domain modules expose services and schemas; user interface code cannot query tables directly.

Collection cannot activate a source or alter its policy.

Intelligence cannot create outreach activities or approve an opportunity.

Discovery suggestions cannot become authoritative requirements without an identified human validator.

Handoff reads only approved snapshots and never exposes internal database tables to the Delivery Factory.

Delivery feedback is imported as an event and cannot rewrite the accepted handoff package.

Analytics reads events and views but does not mutate operational state.

Provider adapters implement interfaces owned by the domain, preventing provider specific types from spreading through the codebase.

4 Deployment Architecture

Figure 2  MVP deployment topology

Runtime Responsibilities

Environment Boundaries

5 Controlled Loop Architecture

Figure 3  Bounded lead management discovery and handoff loops

Loop Definitions

Universal Loop Contract

Every run has a globally unique run ID, workflow version and initiating identity.

Every task accepts an idempotency key and records attempt count, timestamps and terminal status.

Budgets cover maximum items, depth, runtime, retries, concurrency and estimated model cost.

A stop reason is mandatory for blocked, cancelled, partial and failed outcomes.

Retries apply only to retryable technical errors; policy failures and validation failures do not retry indefinitely.

Every state mutation emits an audit event and updates the applicable operational metric.

Every accepted handoff package is immutable; later changes are issued as versioned amendments.

A downstream outage cannot block local capture, review or requirements work; pending events remain in the outbox.

6 Workflow State Machines

Source Lifecycle

Crawl Run Lifecycle

Opportunity Lifecycle

7 Data Architecture

PostgreSQL is the authoritative system of record. Object storage holds immutable evidence payloads. Operational tables use workspace identifiers from the beginning, even though the MVP has one workspace, so future separation does not require rewriting every key.

Core Data Entities

Required Constraints and Indexes

Unique source identity by workspace plus normalized base URL or external source key.

Unique artifact by workspace source canonical URL and content hash.

Unique task attempt by workflow task name and idempotency key.

Only one active source policy version per source.

Every opportunity requires at least one evidence relationship before human approval.

Every score stores its component values weight version and explanation.

Every validated requirement identifies a source and human validator and has either acceptance criteria or a recorded exception.

Every feature candidate traces to at least one validated requirement before handoff.

Only one current approved requirement baseline may be active for an opportunity.

Every handoff package stores its manifest checksum source versions approver and acceptance state.

An accepted package is immutable; amendments reference the accepted package version they change.

Audit events are insert only; correction is represented by a new event.

Indexes cover status plus updated time, next scheduled run, normalized organization domain and opportunity fingerprint.

Retention Baseline

8 API and Command Design

The application exposes authenticated command and query routes. Commands validate authorization, current state and idempotency before writing. Background tasks receive identifiers rather than large payloads and reload authoritative state at execution time.

Primary Endpoints

Command Envelope

{

  "commandId": "uuid",

  "workspaceId": "uuid",

  "actorId": "uuid",

  "idempotencyKey": "source-id:action:client-token",

  "expectedVersion": 7,

  "payload": {},

  "requestedAt": "ISO-8601 timestamp"

}

Error Contract

9 Task and Event Catalogue

Retry Policy

10 Web Collection Design

Source Approval Record

Collection Strategy

1. Prefer first party APIs, open data and RSS or Atom feeds.

2. Use sitemaps or stable index pages to identify candidate URLs.

3. Use static HTTP and Cheerio for normal pages.

4. Escalate to Playwright only when rendering is essential and approved.

5. Store immutable evidence before transformation.

6. Normalize text and metadata with a versioned parser.

7. Send only the minimum relevant evidence to the model.

Fetch Controls

Descriptive user agent with contact information when appropriate.

Per domain concurrency of one by default; higher values require explicit approval.

Minimum delay and request frequency stored in the source policy.

Redirect validation prevents leaving the approved domain set.

DNS and network protections block local private metadata and non HTTP destinations.

Response byte limit content type allowlist and download timeout.

Content hashing prevents repeat extraction when evidence has not changed.

Circuit breaker pauses a source after repeated denial, challenge or error signals.

LinkedIn Channel

LinkedIn is represented as a manual or approved interface source. The application may accept a user pasted URL, note, screenshot reference, approved export or native notification details. It must not contain a LinkedIn crawler, automated login, connection automation or hidden API integration.

11 AI Intelligence Design

Permitted AI Responsibilities

Extraction Contract

OpportunityCandidate {

  title: string

  organizationName: string | null

  opportunityType: enum

  problemStatement: string

  geography: string[]

  publishedAt: datetime | null

  closesAt: datetime | null

  commercialSignals: string[]

  contactHints: ContactHint[]

  evidenceClaims: EvidenceClaim[]

  confidence: number  // 0.0 to 1.0

}

Validation Pipeline

1. Preprocess and bound the evidence by characters or tokens.

2. Call the selected model with a versioned developer prompt and JSON schema.

3. Validate syntax and types with Zod.

4. Verify that required claims reference evidence locations.

5. Normalize dates currencies URLs and controlled vocabulary.

6. Apply confidence and risk routing rules.

7. Persist prompt version model usage latency raw response hash and validated result.

Quality Gates

Evaluation Set

Maintain a versioned golden set of at least 50 representative artifacts before broadening automation. Include positive opportunities, non opportunities, duplicate announcements, expired notices, sparse pages, PDFs, date ambiguity and organization ambiguity. Track field precision, field recall, false positive rate, review acceptance rate and cost per accepted opportunity.

12 Qualification and Deduplication

Score Model

Risk flags are separate from the 0 to 100 opportunity score. A strong commercial score does not cancel a policy, privacy, conflict, expiry or evidence risk. Blocking flags prevent advancement until reviewed.

Deduplication Sequence

1. Canonicalize URL and remove known tracking parameters.

2. Match exact external identifiers where available.

3. Match content hashes and normalized title organization date combinations.

4. Calculate fuzzy similarity only for unresolved candidates.

5. Use AI only to explain ambiguous candidate matches; do not auto merge above a defined risk threshold.

6. Preserve all evidence under the selected canonical opportunity.

Initial Routing Thresholds

13 Client Discovery and Audit Management

The opportunity workspace is the authoritative pre delivery record. A discovery or audit session is a structured business event tied to one opportunity. It may be captured live or completed immediately after the meeting, but its approved version must preserve who participated, what was learned, what was decided and which follow up actions remain open.

Opportunity Workspace Composition

Discovery Session Workflow

1. Create the session from an engaged opportunity and record the purpose agenda date and participants.

2. Use the structured workspace during the meeting to capture current state processes systems data pain points constraints decisions and actions.

3. Attach authorized documents screenshots diagrams or transcript references and classify their sensitivity.

4. Generate a bounded AI summary suggested requirements feature candidates open questions and possible contradictions.

5. Review every suggestion against the notes and evidence; accept edit or reject it explicitly.

6. Ask a named human participant or the founder to validate material statements and decisions.

7. Complete the session only when actions have owners and dates and the record has an approval status.

Discovery Capture Schema

Live Meeting Experience

Autosave locally entered fields without marking them validated.

Show the opportunity summary prior sessions open actions and known systems without leaving the workspace.

Allow rapid note capture first and structured classification second so the meeting is not slowed by form completion.

Display the source and validation state beside every requirement or decision created from the session.

Require explicit consent and an approved storage location before retaining a transcript or recording reference.

Record edits with actor timestamp prior value new value and reason when an approved session changes.

14 Requirements and Feature Management

Requirements and feature candidates are separate records. A requirement describes a verified business or user need. A feature candidate proposes how a solution may satisfy one or more requirements. This distinction allows the Delivery Factory to reconsider implementation without losing the client need or its evidence.

Requirement Contract

Requirement Lifecycle

Feature Candidate Contract

Baseline and Quality Rules

A baseline contains explicit versions of requirements features constraints risks and success measures.

The baseline process reports missing sources acceptance criteria validators dependencies owners and unresolved contradictions.

A Must requirement with a blocking question or unresolved conflict prevents handoff readiness.

Feature candidates may be excluded from handoff when the underlying requirement remains included and the exclusion reason is recorded.

Changes after baseline approval create a new baseline or amendment; they never rewrite the approved snapshot.

AI may suggest wording classification trace links and gaps but cannot validate prioritize or withdraw a requirement.

Traceability Model

15 Commercial Qualification and Handoff

The handoff is a controlled business transaction between independent products. The Lead Engine releases a complete snapshot. The Delivery Factory either accepts that version and returns a project identifier or rejects it with structured reasons. A transport failure is retried; a business rejection is reviewed by a person.

Handoff Readiness Gates

Handoff Package Contract

LeadEngineHandoffPackage {

  schemaVersion: string

  packageId: uuid

  packageVersion: integer

  opportunityId: uuid

  organization: OrganizationSnapshot

  stakeholders: StakeholderSnapshot[]

  problemStatement: string

  currentState: CurrentStateSnapshot[]

  requirementBaseline: RequirementBaselineSnapshot

  constraints: ConstraintSnapshot[]

  risksAndAssumptions: RiskAssumptionSnapshot[]

  successMeasures: SuccessMeasureSnapshot[]

  commercialScope: CommercialSnapshot

  supportingArtifacts: ArtifactManifestItem[]

  openItems: OpenItemSnapshot[]

  approvedBy: uuid

  approvedAt: datetime

  manifestChecksum: string

}

Delivery Factory Integration Protocol

1. Create the package from approved immutable snapshots and calculate the manifest checksum.

2. Record founder approval and write a handoff release event to the transactional outbox in the same database transaction.

3. Deliver the event to the versioned Delivery Factory endpoint with package ID version correlation ID and replay protection.

4. Retry transport failures within the bounded policy without creating a new package version.

5. Record acceptance with the downstream project ID or record rejection with machine readable reasons and human readable detail.

6. Route clarification requests to the opportunity workspace and assign an owner and due date.

7. Create and approve an amendment when accepted scope changes; never mutate the previously accepted package.

Product Independence Rules

Each product owns its database authentication deployment secrets telemetry backups and incident response.

The Lead Engine remains fully usable when the Delivery Factory is unavailable or not installed.

The integration exposes contracts and identifiers only; it never exposes tables credentials or internal provider types.

Delivery status returns as signed versioned events and may update the timeline and metrics but not the accepted package.

Contract tests run against supported schema versions before either product releases a breaking change.

A package export remains available for authorized manual transfer when the integration is disabled.

16 Security Privacy and Compliance Controls

Security Baseline

Personal Information Controls

Prefer organization level information and role based business contact paths over personal profiles.

Store a contact only when connected to a legitimate opportunity and a recorded purpose.

Record the public source and date for every contact hint.

Support suppression so removed or opted out contacts are not recreated by future collection.

Exclude sensitive personal data and unrelated profile content from collection and model prompts.

Require human review before any outbound use of contact information.

Threat Scenarios

17 Reliability and Performance Targets

Cost Guardrails

18 Observability and Analytics

Telemetry Model

Operational Dashboards

Source health: last success, next run, status distribution, block reasons and freshness.

Opportunity funnel: detected, qualified, engaged, discovery, requirements defined, proposal, won and handed off.

Engagement: response rate, next action compliance, stage age, meeting volume and stalled opportunities.

Discovery: sessions completed, open questions, overdue actions and approval cycle time.

Requirements quality: missing sources, missing acceptance criteria, unresolved contradictions, change rate and validation age.

Handoff: readiness failures, pending outbox events, acceptance rate, rejection reasons, acknowledgement time and amendments.

Quality: review acceptance, corrections by field, duplicate rate and false positive reasons.

Economics: cost per run, qualified lead, discovery session, won opportunity and accepted handoff with revenue attribution.

Reliability: failure rate, retry rate, task latency, queue delay and dependency errors.

Initial Alerts

19 Repository and Engineering Harness

Repository Structure

lead-engine/

  apps/

    web/                 # Next.js application

  packages/

    domain/              # entities rules and service interfaces

    db/                  # schema migrations repositories and views

    source-adapters/     # RSS API HTML PDF CSV manual

    workflows/           # Trigger.dev tasks and orchestration

    intelligence/        # model adapter prompts schemas and evals

    engagement/          # stakeholders activities meetings and actions

    discovery/           # session capture current state and decisions

    requirements/        # requirements features baselines and trace links

    handoff/              # package manifests outbox and contracts

    integrations/        # Delivery Factory client callbacks and contract tests

    observability/       # logging tracing and usage ledger

    ui/                  # shared user interface components

  docs/

    architecture/        # system design and diagrams

    decisions/           # architecture decision records

    runbooks/            # operating procedures

  evals/                 # golden cases rubrics and reports

  fixtures/              # saved crawler and parser fixtures

  tests/                 # cross module integration and security tests

  AGENTS.md

  README.md

  package.json

  pnpm-workspace.yaml

Minimum Viable Harness

Agent Work Contract

1. Select one bounded backlog item with explicit acceptance criteria.

2. Read the relevant architecture decision and module contract before editing.

3. Add or update a failing test before implementation when practical.

4. Run the smallest relevant verification loop during development and the full required gate before completion.

5. Do not change architecture policy data retention or source permissions without an approved decision record.

6. Leave the repository in a mergeable state and record remaining work clearly.

20 Test Strategy

Critical Acceptance Scenarios

An unapproved source cannot start through the UI API scheduler or direct task invocation.

A repeated task invocation cannot create duplicate artifacts opportunities scores or activities.

A redirect to an unapproved host is blocked and audited.

A CAPTCHA access challenge or explicit denial stops the run without bypass behavior.

An invalid model response is repaired once and then terminates predictably.

A low confidence record reaches review with its evidence and explanation intact.

An opportunity cannot be approved without evidence.

An outreach draft cannot become approved when a suppression entry applies.

A model suggested requirement cannot become validated without a named human validator.

A requirement baseline cannot freeze when a Must item has a blocking question or missing source.

An accepted handoff package cannot change; a later scope change creates an amendment.

A repeated handoff release cannot create duplicate Delivery Factory projects.

A Delivery Factory outage leaves the package pending while normal Lead Engine work continues.

A callback with an invalid signature or repeated event ID is rejected and audited.

A model or prompt change cannot deploy when golden evaluation regression exceeds the approved tolerance.

A failed deployment can roll back without an incompatible database state.

21 CI CD and Release Process

Pull Request Pipeline

1. Install from the lockfile and verify generated artifacts are current.

2. Run formatting, linting and TypeScript type checks.

3. Run unit and architecture boundary tests.

4. Start isolated dependencies and run database migrations and integration tests.

5. Run affected crawler fixture suites and AI evaluations.

6. Run discovery requirement baseline and Delivery Factory contract suites.

7. Run dependency, secret and static security scans.

8. Build the application and create a preview deployment.

9. Require human review for schema, policy, security or workflow changes.

Production Release

Rollback Strategy

Application and task deployments must remain compatible with the immediately preceding database version. Use expand and contract migrations: add new structures first, deploy compatible code, migrate data, then remove obsolete structures in a later release. Roll back code immediately for severe defects; disable the affected feature or source adapter when rollback is unsafe; restore data only for confirmed corruption.

22 Sixteen Week Delivery Plan

The plan assumes 10 to 15 founder hours per week with coding agent support and production capable increments. The expanded product boundary requires sixteen weeks so discovery, requirements and handoff controls are implemented as first class capabilities rather than compressed into the pipeline. Each week ends with demonstrable behavior and evidence against its exit gate.

Milestone Gates

23 Prioritized Delivery Backlog

MVP Epics

Explicitly Deferred

Change Control

A proposed change requires an architecture decision record when it changes a product boundary, trust boundary, data retention, provider, workflow engine, autonomous capability, external communication path, source policy, requirement authority, handoff contract or module boundary. The record states context, decision, alternatives, consequences, rollback and review date.

24 Operating Runbooks

Onboard a New Source

1. Record the source owner, business purpose, method, domains, expected opportunity signals and data classes.

2. Review public accessibility, applicable terms, robots behavior, personal information and contact usage.

3. Define allowlisted paths, exclusions, budgets, schedule, user agent and stop conditions.

4. Capture representative fixtures and implement or configure the adapter.

5. Run parser, policy, idempotency and extraction evaluation suites.

6. Complete human approval and activate initially at conservative frequency.

7. Review the first three runs for errors, false positives, cost and unexpected content.

Conduct a Client Discovery or Audit Session

1. Open the opportunity workspace and review known evidence stakeholders prior sessions open questions and next actions.

2. Create the session with purpose agenda participants and the intended decisions.

3. Capture current processes systems data sources pain points constraints decisions and actions during the discussion.

4. Attach only authorized materials and classify sensitivity and permitted use.

5. Generate AI suggestions only after the source notes are saved; review every suggestion before acceptance.

6. Assign owners and dates to actions and blocking questions.

7. Approve the session record and notify affected requirement or commercial owners.

Freeze a Requirement Baseline

1. Run the baseline quality report for missing sources validators acceptance criteria dependencies and contradictions.

2. Resolve every blocking Must requirement or record an approved exception.

3. Confirm feature links constraints risks assumptions success measures and explicit exclusions.

4. Review the full baseline diff against the previously approved version when one exists.

5. Record approver decision rationale and timestamp and freeze the selected item versions.

6. Publish the baseline checksum and prevent direct edits to the frozen snapshot.

Release a Delivery Factory Handoff

1. Confirm the opportunity is won handoff ready and every readiness gate passes.

2. Generate the package manifest from approved discovery requirement commercial and evidence snapshots.

3. Review exclusions open items data constraints and supporting artifact permissions.

4. Approve the package and calculate its manifest checksum.

5. Release through the outbox or authorized export and monitor acknowledgement.

6. Record the Delivery Factory project ID on acceptance or assign rejection reasons for correction.

7. Issue an amendment rather than editing the accepted package when scope later changes.

Respond to a Block or Access Challenge

1. Stop the source automatically; do not retry through the challenge.

2. Record status, URL class, time, response metadata and the last successful run.

3. Confirm that no policy, robots, path or authentication assumption changed.

4. Prefer an approved feed, API, email alert or manual workflow.

5. Resume only after a new policy review and explicit approval.

Respond to Extraction Quality Regression

1. Pause the affected prompt or model version and route new items to manual review.

2. Compare recent failures with the last passing golden evaluation report.

3. Separate source layout changes, preprocessing defects, schema changes and model behavior.

4. Add representative failures to the evaluation set without leaking unnecessary personal data.

5. Fix the smallest responsible layer and rerun the full affected evaluation suite.

6. Release through canary and monitor acceptance rate before restoring normal routing.

Respond to AI Cost Anomaly

1. Enforce the hard budget and stop non priority model work.

2. Identify the source, task, prompt version, model and retry pattern driving spend.

3. Check content hashing, token bounds, duplicate suppression and repair attempts.

4. Reduce evidence size or approved model tier only after quality evaluation.

5. Document the correction and update alert thresholds if the change is intentional.

Respond to Handoff Failure

1. Classify the failure as transport schema integrity authentication or business rejection.

2. Keep transport failures pending in the outbox and verify the Delivery Factory health endpoint.

3. Stop retries on schema integrity or authentication failures and alert the owner.

4. Route business rejection reasons to the opportunity workspace without changing the released package.

5. Correct source records create a new package version and obtain approval before release.

6. Reconcile package attempts acknowledgements and downstream project IDs after recovery.

25 Incident and Recovery Runbook

Severity Model

Incident Procedure

1. Contain by disabling the feature, source, task queue or credentials involved.

2. Preserve relevant logs, audit events, deployment IDs and correlation IDs.

3. Assess affected records, users, sources, costs and external communications.

4. Recover through rollback, replay, correction event or restore as appropriate.

5. Verify normal behavior with focused tests and monitored canary activity.

6. Document cause, timeline, impact, corrective actions and harness improvements.

Recovery Procedures

26 Launch Readiness and Definition of Done

MVP Launch Checklist

Definition of Done for Each Backlog Item

Acceptance criteria pass and the intended business behavior is demonstrated.

Unit, integration, contract, security, fixture or evaluation coverage is updated as applicable.

Authorization, privacy, policy, audit and cost effects are addressed.

Database changes include forward migration, compatibility plan and rollback or correction approach.

Logs, metrics and actionable failure messages support production diagnosis.

Documentation, runbooks and architecture decisions are updated where behavior changed.

The deployed change passes smoke testing and does not create unresolved critical alerts.

Founder Operating Cadence

Success Decision

The MVP is technically successful when it can run approved sources repeatedly, maintain a complete opportunity workspace, capture an approved client discovery session, freeze a traceable requirement baseline and deliver an immutable package through the independent Delivery Factory contract. It is commercially successful when this process produces enough won work or credible pipeline value to justify continued operation. Additional scale follows measured demand and delivery outcomes.

Selected Technology References

End of runbook