# Lead Engine Product Requirements Document

**Multi-Source Opportunity Discovery and Revenue Pipeline for the Raphah.io AI and Business Systems Advisory**

| Field | Value |
|---|---|
| Version | 2.1 |
| Date | 2026-09-26 |
| Status | Living document — reflects the production system (Lead Engine v3) |
| Owner | Chidumebi (Raphah.io) |
| Stack | Neon Postgres + QStash + Vercel |

## Decision summary

Build the Lead Engine as a compliant business development operating system. It discovers public business opportunities, qualifies them against the advisory offer, supports human-reviewed outreach, and measures conversion to paid work. LinkedIn remains an important channel for authority and relationships, but the product will not scrape LinkedIn or automate prohibited activity.

**What changed in v2:** the v1 skeleton described intent; v2 documents what was actually built and shipped to production. The Lead Engine is now a live multi-workspace product with a source approval gate, durable scrape-job lifecycle, automation-maturity scoring, qualified-lead export, a criteria feedback loop, and a signed handoff into the Delivery Factory for fulfillment. Outreach remains draft-only in the MVP: the system drafts, a human approves and sends.

**What changed in v2.1:** an independent audit's "genuinely missing" items were implemented and the document synced to the code: numeric retry/dead-letter policy (§8.2), handoff outbox idempotency and retry design (§12–§13), CASL consent records (§11.1, §12), Overpass/OSM terms acceptance gate (§8.1, §20), scheduled Overpass discovery (§7), funnel-width diagnostics on Overview (§6), operator alerting and backup/restore + spend-gate runbooks (§14), and a Delivery Factory appendix (§22). The Vercel Hobby-tier commercial-use question was resolved 2026-09-27 (stay on Hobby through the pre-revenue canary; Pro at sign-off or first revenue, §18).

## 1 Executive Summary

The Lead Engine helps a solo entrepreneur build a repeatable pipeline for an AI and Business Systems Advisory practice. It collects opportunity signals from approved public sources, normalizes them into a common record, removes duplicates, scores fit and urgency, and places the strongest opportunities into a review queue. The user researches the organization, prepares a relevant outreach approach, manages the commercial pipeline, and tracks revenue.

The first release is an internal single-user product. It must prove that the opportunity discovery and conversion process can create qualified conversations and paid audits before the product is expanded into a software service. The system supports public web pages, sitemaps, APIs, RSS feeds, public documents, manual URLs, and a free business-discovery layer (Overpass, no API key). Every automated source must pass a source approval check covering access permissions, terms, robots rules, collection purpose, allowed fields, rate limits, retention, and review cadence.

### 1.1 Product Decision

Build an internal-first lead intelligence product before considering a commercial software service.

Use LinkedIn for profile authority, content, Service Page demand, relationship building, and manual opportunity capture.

Do not scrape LinkedIn, bypass access controls, automate account activity, or send mass messages.

Collect organization-level business signals by default. Collect personal information only when the source and intended use have been approved.

Keep outreach human-approved. The product may draft messages, but it may not send them automatically in the MVP.

### 1.2 Commercial Model

Raphah.io sells evidence-led AI and business-systems advisory to founder-led teams:

1. **Paid audits** — fixed-scope automation-maturity audits that score a business across operations, marketing, sales, and service, and produce a prioritized roadmap.
2. **Implementation engagements** — delivering the automations the audit recommends, fulfilled through the Delivery Factory's workflow automation (email/SMS sequences, AI-assisted response, review requests, monitoring alerts, scheduled digests).
3. **Continuous improvement** — recurring retainers that keep automations running and measured.

The Lead Engine feeds this ladder: it finds businesses showing low-automation signals, qualifies them against the ideal customer profile, and hands the commercial opportunity to the operator. The Delivery Factory converts the won engagement into delivered automation. Revenue is tracked from discovered signal to paid work inside the pipeline.

## 2 Product Context

### 2.1 Business Problem

A solo consulting venture cannot depend on irregular referrals or occasional high-performing posts. Opportunity discovery is fragmented across LinkedIn, business websites, procurement notices, directories, event pages, job postings, public reports, and inbound messages. Reviewing these sources manually consumes time, produces inconsistent qualification decisions, and makes it difficult to connect business development activity to revenue.

Existing lead generation tools often emphasize contact harvesting and volume. That approach creates legal, platform, privacy, and reputation risk. The Lead Engine instead identifies evidence of a business problem, explains why the signal is relevant, and helps the user choose a respectful route to a conversation.

### 2.2 Target Customer for the Advisory Business

The initial ideal customer profile is a Canadian founder-led or owner-managed service business with approximately 5 to 50 employees. Priority segments include accounting, bookkeeping, real estate, mortgage services, consulting, training, recruitment, home services, commercial services, and small technology companies.

**Automation-maturity lens (added in production):** the engine specifically looks for businesses with low automation maturity — no online booking, no chat, no email capture, manual-looking operations — because those are the businesses the advisory can help most and the Delivery Factory can serve with standard automation templates.

### 2.3 Initial User

Chidumebi, founder of Raphah.io. Sole operator of the Lead Engine: creates sources, approves them, tunes criteria, runs scrape jobs, reviews qualified leads, and approves outreach. All product decisions optimize for one expert operator, not a team workflow.

## 3 Product Vision and Principles

### 3.1 Product Vision

Create a daily operating system that turns permitted public business signals and relationship activity into qualified consulting opportunities, structured follow-up, and measurable revenue.

### 3.2 Product Principles

1. **Evidence over volume.** Every lead must carry the evidence that produced it — scraped content, signal observations, maturity assessment — inspectable in the audit log. A lead without evidence is not a lead.
2. **Compliance is a feature.** Robots rules, source approval, and human-approved outreach are product requirements, not legal afterthoughts. The engine refuses to collect what it has not been permitted to collect.
3. **Human judgment stays in the loop.** Scoring proposes; the operator disposes. Criteria suggestions can be applied or ignored. Outreach is drafted, never sent, by the machine.
4. **One operator, zero babysitting.** Durable job lifecycles (queued → leased → retried → completed / dead-lettered), scheduled workers, and a 72-hour canary mean the pipeline runs while the operator does other work.
5. **Boring technology, exciting outcomes.** Neon Postgres, QStash schedules, and Vercel serverless — managed services with audit trails, no servers to nurse.

## 4 Goals and Scope

### 4.1 Business Goals

- Produce a repeatable weekly flow: new sources → scrape runs → qualified leads → conversations → paid audits.
- Reach the operating-economics gate: CAD 1,000 in recurring monthly revenue before infrastructure spend exceeds CAD 150/month.
- Prove one full loop: a business discovered by the engine becomes a paying advisory client fulfilled through the Delivery Factory.

### 4.2 Product Goals

- Maintain one searchable opportunity inbox across all supported sources.
- Show why each opportunity matches the ideal customer profile and offer ladder.
- Detect duplicates and combine evidence from several sources into one organization record.
- Support a complete path from discovered signal to revenue and referral.
- Provide source-level controls for frequency, rate, permitted data, retention, and suspension.

### 4.3 Non-Goals for the MVP

- No automated outreach sending (email, SMS, forms, or social). Drafts only.
- No LinkedIn scraping, login automation, CAPTCHA bypass, or access-control circumvention.
- No multi-user teams, roles beyond owner/admin/member, or client-facing portals.
- No real-time streaming; the engine polls on schedules (QStash) and scrapes on demand.
- No fully autonomous criteria changes by default: auto-apply is opt-in per campaign and limited to bounded low-risk numeric nudges (maturity ±5, opportunity ±5, confidence ±5 pts, evidence categories ±1, never overshooting the suggestion); geography changes, factor weights, and qualifying-signal definitions always require operator apply/save.

## 5 Opportunity Model

### 5.1 Opportunity Types

1. **Automation-maturity opportunity** — a business whose public web presence shows low automation (no booking, no chat, manual processes). Scored by the maturity assessment; the core type.
2. **Service-gap opportunity** — evidence of an unmet operational need (e.g., "call for quote" with no online intake, outdated contact paths).
3. **Trigger-event opportunity** — expansion, hiring, relocation, or new-service signals that create a window for advisory conversation.
4. **Referral / relationship opportunity** — manually captured from the operator's network and LinkedIn activity.

### 5.2 Approved Source Categories

- Public business websites (HTML pages, sitemaps)
- Public APIs and feeds (RSS/Atom, open data)
- Public documents (PDFs, reports, procurement notices)
- Business discovery directories via the Overpass adapter (geographic business search, no API key)
- Manual URLs submitted by the operator
- Email forwards and CSV imports (operator-provided)

Every source, regardless of category, passes the source approval gate (§8.1) before any collection run.

### 5.3 Opportunity Lifecycle

`discovered` → `scored` → `qualified` → `in outreach` → `conversation` → `proposal` → `won` / `lost`

- `discovered`: evidence artifacts and signal observations stored; organization record created or matched.
- `scored`: maturity assessment complete; opportunity score computed.
- `qualified`: score meets the campaign thresholds (score, confidence, geography); appears in Qualified leads.
- `in outreach`: operator has approved a draft and begun human outreach.
- `conversation` / `proposal` / `won` / `lost`: commercial pipeline stages tracked against the opportunity.

Deduplication: organizations are matched by normalized domain/URL; repeat evidence merges into the existing organization record rather than creating a new opportunity.

## 6 End to End User Experience

The Lead Engine v3 web app is organized into nine views:

1. **Overview** — pipeline health at a glance: recent runs, lead counts, and a funnel-width strip (Active sources → Candidates evaluated → Scored → Qualified, 7-day window) with diagnostics that distinguish a discovery-volume problem ("nothing entered the funnel") from a calibration problem ("scored but none qualified — check score distribution before loosening thresholds").
2. **Sources & policies** — create sources (name, base URL, collection method, purpose), edit them after creation, and move them through the approval gate: `pending approval` → `Approve` → `active`. Policies are versioned and immutable; budgets and rate limits cannot be silently changed.
3. **Scrape jobs** — pick an approved source, enter a public target URL, queue a scrape. Jobs show a durable lifecycle (queued, leased, retried, completed, dead-lettered) with per-attempt detail and a live progress window.
4. **Qualified leads** — the review queue. Each lead shows its score, confidence, geography eligibility, and the evidence behind it. **Export CSV / Export JSON** buttons download the qualified set; each row has a **Send to DF** action that builds the signed handoff package and queues it for the Delivery Factory.
5. **Operations** — worker health, schedules, the 72-hour canary status, and a **Spend-gate card** (CAD 150/month until CAD 1,000 MRR) linking the billing-alert runbook.
6. **Audit log** — every pipeline event, grouped into expandable run buckets with grandparent → parent → child hierarchy (job → attempts/evidence → signal observations → assessments → opportunities). Each entry carries an OMA business interpretation (Observation, Metric, Action) plus the full technical JSON.
7. **Criteria & schedule** — qualification thresholds (score, confidence, AI-enablement, geo-radius with city presets), auto-apply settings labeled by tier (automatic: bounded numeric nudges; always manual: geography, weights, signals), and the engine's criteria suggestions, which the operator applies or saves manually. Applying a suggestion keeps the operator on the page; a per-campaign **Re-queue scrape** button sends the source straight back into the scrape queue with the saved criteria. Applied suggestions are suppressed until fresh scrape output changes the qualified count.
8. **Discovery** — the Overpass discovery layer: registered discovery sources with **Run now**, a register form (city presets Toronto/Ottawa/Montreal or custom centre coordinates, 1–500 km radius, approved collection source, optional campaign), and run history (candidates found vs. enqueued, errors). Discovery runs are subject to the Overpass/OSM terms-acceptance gate.
9. **Help & guide** — in-app knowledge transfer: the full workflow from workspace to revenue, plus troubleshooting.

**Source-created confirmation:** adding a source produces a prominent success notification only after the record is persisted; failures are reported, not swallowed.

## 7 Functional Requirements

Priorities use P0 for MVP launch requirements, P1 for the first expansion, and P2 for later productization.

### P0 — MVP (shipped)

- Workspaces with membership; personal workspace bootstrap with retry on auth propagation delay.
- Source CRUD with approval gate; source editing after creation; versioned policies.
- Scrape job queue with durable lifecycle, retries, dead-lettering, robots.txt enforcement per attempt.
- Evidence artifacts, signal observations, organization records with URL dedupe.
- Maturity assessments and opportunity scoring with configurable thresholds.
- Qualified-leads review queue with evidence drill-down.
- Criteria suggestions with apply/save and suppression of repeat recommendations.
- Audit log with run-bucket hierarchy and OMA interpretation.
- Lead export (CSV and JSON) with per-row Send-to-DF handoff action.
- Signed handoff to the Delivery Factory (SHA-256 manifest) with outbox idempotency and bounded retry; feedback events back.
- Overpass discovery layer shipped: sources, runs, register form, Run now, daily scheduled runs, Overpass/OSM terms-acceptance gate.
- Funnel-width diagnostics on Overview; re-queue scrape from Criteria & schedule.
- Operator alerting on canary failure and dead-letter threshold breach (webhook); CASL consent records; backup/restore and spend-gate runbooks.
- In-app Help & guide.
- 72-hour production canary before launch sign-off.

### P1 — first expansion

- Multi-day drip follow-up orchestration (chained schedule-triggered workflows).
- Provider wiring for SMS (Twilio) and AI (OpenAI-compatible) in the Delivery Factory.
- Lead feedback loop auto-tuning criteria weights (partially built: `lead_feedback`).
- Durable geocode cache for discovery.

### P2 — later productization

- Multi-user workspaces with fine-grained roles.
- Client-facing reporting views.
- Additional source adapters (procurement APIs, review platforms) pending terms review.

## 8 Web Collection Requirements

### 8.1 Source Approval Gate

No source runs until its policy is explicitly approved and active. Approval records: access permissions, terms review, robots rules, collection purpose, allowed fields, rate limits, retention window, and review cadence. Policies are versioned; budgets and rate limits are immutable once set. The UI enforces the gate: only `active` sources appear in the scrape-job source picker. Discovery runs have an additional gate: the workspace must record acceptance of the Overpass API usage policy and OSM ODbL attribution terms (owner/admin, `POST /api/v1/terms/accept`) before any discovery run executes, and each scheduled run re-verifies that the borrowed collection source is still approved and active.

### 8.2 Crawler Behaviour

- Fetch robots.txt before the first crawl and refresh it on a configurable schedule.
- Use a descriptive user agent and provide a contact URL or email where appropriate.
- Crawl only the approved scheme, hostname, and path patterns. Reject redirects to unapproved domains.
- Limit request rate and concurrency per domain. Apply exponential backoff for 429 and transient server errors.
- Stop collection when a site requires authentication, presents a CAPTCHA, blocks the user agent, or changes its terms or technical controls.
- Prefer feeds, APIs, sitemaps, conditional requests, and incremental updates over repeated full-page retrieval.
- Store the source URL, retrieval time, response status, content type, content hash, parser version, and policy decision.
- Do not execute untrusted page scripts unless a source-specific approval requires a browser renderer and the security review permits it.
- Do not download executables or unsupported archives. Enforce file size, MIME type, and timeout limits.

**Retry and dead-letter policy (enforced in code):** `max_attempts` defaults to 3 per job (configurable 1–10). Retry delay is `30 · 2^(n−1)` seconds capped at 3600s with ~20% jitter. A job is dead-lettered when `attempt_count ≥ max_attempts`; otherwise it returns to `retrying`. These numbers are the testable defaults behind the lifecycle described above.

### 8.3 Extraction and Provenance

Every scrape attempt stores: the raw evidence artifact (content hash, MIME type, retrieval metadata), extracted signal observations (typed, e.g., "has online booking: false"), and the parser version that produced them. Downstream records (assessments, opportunities, leads) reference their evidence; the audit log preserves the full chain so any lead can be traced back to the exact bytes it came from.

### 8.4 Source Stop Conditions

Collection stops and the job is dead-lettered when: the source returns repeated 4xx/5xx, robots.txt newly disallows the path, the site requires authentication or presents a CAPTCHA, terms change, or the campaign's budget/rate limits are exhausted. Stop events are audit-logged with the reason.

## 9 LinkedIn Requirements

LinkedIn supports authority building, inbound demand, relationship development, and manual opportunity capture. The Lead Engine respects the platform boundary and will not depend on unauthorized data collection: no scraping, no login automation, no automated account activity, no mass messaging. LinkedIn-sourced opportunities enter the pipeline only as manually captured relationship records.

## 10 Qualification and Intelligence

### 10.1 Opportunity Score

The total score is a weighted sum of fit factors. Risk flags do not silently alter the score; they appear separately and may block qualification or outreach.

Factors (weights tunable per campaign):

| Factor | What it measures |
|---|---|
| ICP fit | Employee band, segment, Canadian geography |
| Automation maturity (inverse) | Lower maturity → higher opportunity |
| Signal strength | Count and quality of signal observations |
| Evidence freshness | Recency of the scrape that produced the evidence |
| Contactability | Reachable, permitted contact path exists |
| Intent / trigger | Expansion, hiring, or service-gap signals |
| Confidence | Parser and extraction confidence |

### 10.2 Default Thresholds

- **Qualification score:** ≥ 60/100 (campaign-configurable)
- **Confidence:** ≥ 0.6
- **Geography:** inside the campaign's geo-radius (city presets: Toronto, Ottawa, Montreal, + custom centre)
- **AI-enablement threshold:** the maturity score below which a business counts as "low automation" and worth pursuing

Thresholds live in Criteria & schedule; the engine suggests adjustments as scrape output accumulates, and the operator applies or saves them.

### 10.3 Artificial Intelligence Controls

- AI assists drafting (replies, content, summaries); it never sends, publishes, or auto-applies criteria.
- No model-suggested requirement becomes authoritative without an identified human validator.
- AI outputs are labeled as drafts in the audit trail.

## 11 Outreach and Conversion

### 11.1 Outreach Readiness Checklist

Before outreach begins on a qualified lead, the record must show: qualified score and confidence, an approved contact path, CASL basis (consent or existing relationship) with sender identification and unsubscribe mechanism, and operator approval of the draft message. Missing items block the outreach stage. The CASL basis is a structured record, not a memory: the `consent_records` table captures basis type (`consent` | `existing_relationship` | `inquiry`), the evidence reference supporting it, and the timestamp, wired into the audit log like evidence artifacts — so outreach readiness is a query. The recorded basis travels with the lead inside the signed handoff package to the Delivery Factory.

### 11.2 Draft Types

- Contextual connection request
- Referral introduction request
- Response to an explicit service request or procurement notice
- Website contact form response
- Permission-based business email
- Discovery call agenda and follow-up
- Audit proposal and next-step reminder

### 11.3 Pipeline Requirements

The pipeline tracks each qualified lead through `in outreach → conversation → proposal → won/lost`, with revenue recorded at `won`. Conversion is measured per source and per campaign so the operator can see which discovery bets produce paid work. Delivery Factory feedback events (engagement delivered, outcome) flow back into the lead record.

## 12 Data Model

Core tables (Neon Postgres, `public` schema):

- `workspaces`, `workspace_memberships` — tenancy
- `source_definitions`, `source_policy_versions` — sources and immutable policies
- `scrape_campaigns` — campaign configuration, thresholds, suggestion state
- `scrape_jobs`, `scrape_job_attempts` — durable job lifecycle
- `evidence_artifacts`, `signal_observations` — provenance chain
- `organizations` — deduped business records
- `maturity_assessments`, `opportunities` — scoring
- `lead_feedback` — operator feedback for criteria tuning
- `consent_records` — CASL consent basis per organization/opportunity (basis type, evidence reference, timestamp), audit-logged
- `alert_log` — stateful operator incidents with atomic dedupe, cooldown reminders, and recovery transitions
- `terms_acceptances` — workspace acceptance of third-party terms (Overpass/OSM), owner/admin recorded
- `canary_runs` — 72-hour production canary
- `audit_events` — the complete audit trail
- Handoff: `handoff_outbox` (LE) → `handoff_inbox` (DF); `delivery_feedback` / `feedback_outbox` (DF → LE). `handoff_outbox.idempotency_key` is unique with `ON CONFLICT DO NOTHING`, so retried enqueues never duplicate.

## 13 Conceptual Architecture

```
Public web ──robots.txt──▶ Scrape workers (Vercel serverless, QStash-scheduled)
        │ evidence + signals
        ▼
Lead Engine (Neon Postgres) ──signed handoff──▶ Delivery Factory (Neon Postgres)
  scoring, qualification, audit                    projects, workflow automation,
  criteria feedback loop                           monitoring, feedback events
```

- **Lead Engine** and **Delivery Factory** are separate products with independent data boundaries: no direct database access between them. Integration is exclusively through versioned HTTPS contracts (`LeadEngineHandoffPackage/v1`, `DeliveryFeedbackEvent/v1`), each handoff package verified by SHA-256 manifest checksum.
- **Handoff delivery:** the outbox holds signed packages with a stable idempotency key per opportunity (`ON CONFLICT DO NOTHING` on enqueue; `idempotency-key` dispatch header). Dispatch retries with exponential backoff (`2^attempts` minutes, capped at 6h, with jitter), a 15s dispatch timeout, and a 10-attempt ceiling; the Delivery Factory dedupes at intake, so a lost response after acceptance cannot create a duplicate engagement. Webhook delivery never throws — the outbox row is the durable record.
- **Discovery loop:** a daily QStash schedule (`raphah-lead-discovery-v1`, 06:10 UTC) runs each active discovery source at most once per 24h — Overpass sweep → URL-dedupe against already-enqueued targets → auto-enqueue of scrape jobs (capped at 200 candidates/run) — converting sourcing from operator pull to system push.
- **Runtime:** Vercel serverless functions (12-function Hobby limit respected via dispatcher consolidation), Neon Postgres over HTTPS data API, QStash for scheduled worker ticks, the hourly canary, and daily discovery.
- **Auth:** Neon Auth (email/password + Google) with RLS; DF operator access additionally gated by an email allowlist.

## 14 Nonfunctional Requirements

- **Availability:** pipeline degrades gracefully — worker tick failures are retried via QStash; the UI shows last-known state with a staleness banner.
- **Durability:** jobs are never lost: queued → leased → retried → completed or dead-lettered, all queryable.
- **Auditability:** every state change writes an audit event with before/after state; runs are reconstructible.
- **Security:** RLS on all tenant tables; secrets in Vercel env / Secure Vault, never in code or logs; credential-bearing URLs are never stored or reproduced.
- **Performance:** scrape attempts time out at 15s; long waits are clamped in serverless; multi-day sequences chain scheduled workflows.
- **Operability (alerting):** stale workers, stuck/failed canaries, dead-letter jobs, canary target mismatch, scheduled-start p95 breaches, exhausted QStash deliveries, and a passed 72-hour soak emit state-transition alerts — durable `alert_log` + audit entries plus Slack delivery through `SLACK_OPS_ALERT_WEBHOOK_URL`. Opens, 30-minute reminders, and recoveries are atomically deduplicated. Alert checks run failure-isolated inside the worker tick so a broken alerter can never break the pipeline.
- **Recoverability:** backup/restore drill runbook (`docs/runbooks/backup-restore-drill.md`) covers the Neon point-in-time restore path with verification queries and an operator drill log.
- **Cost governance:** the CAD 150/month spend gate is backed by a billing-alert runbook (`docs/runbooks/spend-gate-billing-alerts.md`) with per-service (Neon/Vercel/QStash) alert setup and breach response, surfaced in the Operations view.
- **Portability:** the same API handlers run on Vercel or in Docker/Compose via the Node adapter (handover options documented).

## 15 Success Metrics

### 15.1 North Star Metric

Qualified opportunities reviewed that produce a substantive prospect conversation. This metric connects discovery quality to real commercial engagement and avoids rewarding raw lead volume.

### 15.2 Operating Economics

Until the business has produced at least CAD 1,000 in recurring monthly revenue, recurring software and infrastructure spend should remain below CAD 150 per month unless a documented experiment has a defined payback test. Labour time must also be tracked because a low cash cost can still conceal an inefficient workflow. The gate has operational teeth: billing alerts on Neon, Vercel, and QStash per the spend-gate runbook, with status surfaced on the Operations view's Spend-gate card. Any per-candidate LLM step (e.g., discovery classification) must be costed against this gate before it ships.

## 16 Release Plan

### 16.1 MVP Launch Acceptance

- [x] Production stack live (Neon + QStash + Vercel), health checks green
- [x] Source approval gate enforced end to end
- [x] Scrape → evidence → score → qualify loop demonstrated on real sites
- [x] Audit log with OMA interpretation and technical drill-down
- [x] Signed LE → DF handoff verified (synthetic E2E 9/9); outbox idempotency + bounded retry documented and tested
- [x] Lead export (CSV + JSON) with per-row Send-to-DF action
- [x] Overpass discovery layer: sources, runs, register form, Run now, daily scheduled runs, terms-acceptance gate
- [x] Funnel-width diagnostics on Overview; re-queue scrape from Criteria & schedule
- [x] Operator alerting (canary failure, dead-letter threshold) via webhook; backup/restore and spend-gate runbooks written
- [x] CASL consent records in the data model, wired to the handoff package
- [ ] 72-hour canary: clock starts on first successful canary run; no final sign-off before it completes
- [ ] First real qualified lead reviewed by the operator
- [x] Vercel plan decision: stay on Hobby through the pre-revenue canary; upgrade to Pro ($20/seat/mo) at canary sign-off or first revenue, whichever comes first (owner decision 2026-09-27)

Bulk-release policy: changes ship in batched releases to conserve the Vercel API deployment quota; UI look-and-feel is verified locally before release.

## 17 Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Source terms/robots change mid-campaign | Per-attempt robots check; stop conditions dead-letter the job and audit the reason |
| Low lead quality wastes operator time | Evidence-backed scoring, tunable thresholds, feedback loop |
| Automated-outreach legal exposure (CASL) | Draft-only MVP; outreach readiness checklist; human sends |
| Platform dependence (Vercel/Neon/QStash) | Docker/Compose handover path kept warm; 12-function limit respected |
| Vercel Hobby-tier commercial use | Owner decision pending: confirm time-boxed exception or budget paid plan before 72h canary sign-off |
| Silent pipeline failure | Slack transition alerting across worker, canary, queue, target, p95, QStash, and soak gates; alert_log + audit trail |
| Spend overrun against CAD 150/mo gate | Billing alerts per spend-gate runbook; Operations Spend-gate card |
| Credential exposure | Vault storage, rotation runbooks, no secrets in code/logs/chat |
| Single-operator bottleneck | Durable jobs + schedules + canary; the pipeline runs unattended |

## 18 Decisions and Open Questions

**Decided:**

- Neon + QStash + Vercel as the production stack (2026-09-23).
- No LinkedIn scraping, ever; LinkedIn is a manual/relationship channel.
- Draft-only outreach in the MVP.
- Bulk releases to conserve deployment quota.
- Overpass (free, no key) for geographic business discovery.
- LE and DF integrate only through versioned HTTPS contracts.
- Numeric retry/dead-letter policy is code, not prose: max_attempts 3 (1–10), backoff 30·2^(n−1)s capped at 1h with jitter (2026-09-26).
- Handoff outbox uses stable idempotency keys with bounded retry (10 attempts, 6h backoff cap) and DF-side intake dedupe (2026-09-26).
- CASL consent basis is a structured `consent_records` row carried in the handoff package; required before first outreach (2026-09-26).
- Overpass/OSM terms acceptance is a workspace-level gate on discovery runs (2026-09-26).
- Scheduled discovery runs daily per active source; auto-apply stays limited to bounded numeric nudges (2026-09-26).
- Vercel Hobby tier for pre-revenue production: stay on Hobby through the 72-hour canary, upgrade to Pro ($20/seat/month) at canary sign-off or first revenue, whichever comes first (owner decision 2026-09-27). Hobby's Fair Use policy restricts it to non-commercial use, so this is a bounded pre-revenue window, not a permanent posture.

**Open:**

- SMS/AI provider selection and cost envelope for Delivery Factory automation at scale.
**Resolved (2026-09-27):** stay on Hobby through the pre-revenue 72-hour canary; upgrade to Vercel Pro ($20/seat/month) at canary sign-off or first revenue, whichever comes first. Rationale: Hobby's Fair Use policy ("intended for personal, non-commercial use") prohibits commercial production workloads and Vercel suspends without warning, so the compliant posture at revenue is Pro. Trigger owner: Chidumebi. Reminder: re-check at canary verdict.
- Whether the product ever becomes a multi-tenant SaaS, and on what pricing.
- Additional source categories pending terms review (procurement APIs, review platforms).

## 19 Delivery Backlog

Shipped (Phase 0–3): production stack, source approval gate, durable scrape jobs, maturity scoring, qualified-lead queue, criteria suggestions, hierarchical audit log, lead export (CSV/JSON) with Send-to-DF, signed LE→DF handoff with outbox idempotency and bounded retry, DF workflow automation (15 node kinds), DF automation templates, in-app help, operator auth, Overpass discovery layer (sources, runs, register form, Run now, daily scheduled runs, terms-acceptance gate), discovery-funnel width metric, re-queue scrape from Criteria & schedule, DF lead follow-up (SMS, draft-first) demo workflow, operator alerting (canary failure, dead-letter threshold) via webhook, CASL consent records, backup/restore and spend-gate runbooks.

Next: 72-hour canary completion, first real qualified lead, SMS/AI provider wiring, multi-day drip orchestration, rollback/credential-rotation runbooks, backup/restore drill execution, Vercel Pro upgrade at canary sign-off or first revenue (decided 2026-09-27), multi-ICP parallel campaign scoring, PIPEDA access/deletion runbook once personal data accumulates, North Star instrumentation once volume exists.

## 20 Compliance References

These sources inform the product guardrails. They are not a substitute for legal advice or a source-specific terms review.

1. **LinkedIn User Agreement** — prohibits software, scripts, robots, crawlers, plugins, or other processes used to scrape or copy LinkedIn services and data. The product therefore blocks LinkedIn crawling and automated account activity. https://www.linkedin.com/legal/user-agreement
2. **Robots Exclusion Protocol RFC 9309** — the crawler implements the standardized robots.txt protocol and records the rule set used for each collection decision. https://www.rfc-editor.org/rfc/rfc9309.html
3. **CRTC Canada Anti-Spam Legislation FAQ** — commercial electronic messages generally require consent, sender identification, and an unsubscribe mechanism. Outreach readiness records these elements where applicable. https://crtc.gc.ca/eng/com500/faq500.htm
4. **Office of the Privacy Commissioner of Canada — Data Scraping Statement** — publicly accessible personal information remains subject to privacy and data protection laws. The product defaults to organization-level signals and minimizes personal information. https://www.priv.gc.ca/en/opc-news/speeches-and-statements/2024/js-dc_20241028/
5. **Office of the Privacy Commissioner of Canada — E-Marketing Guidance** — warns against address harvesting and explains organizational accountability for consent and third-party marketing lists. https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/r_o_p/canadas-anti-spam-legislation/casl-compliance-help-for-businesses/casl_guide/
6. **Overpass API Usage Policy (OSM Foundation)** — the Overpass engine behind city-scale discovery is a shared community resource: queries must be bounded and fair-use, with an identified user agent. The discovery layer issues one bounded query per run (60s cap, 200-candidate cap) and identifies itself accordingly. https://operations.osmfoundation.org/policies/api/
7. **OpenStreetMap copyright and ODbL attribution** — OpenStreetMap geodata is published under the Open Database License; any OSM-derived data surfaced by the product must carry © OpenStreetMap contributors attribution. https://www.openstreetmap.org/copyright

## 21 Definition of Done

A change is done when: business criteria pass and the behavior is demonstrated; unit, integration, and contract test coverage is updated; hard compliance constraints (policy checks, human approval, checksum verification) are enforced; and the build is clean with zero TypeScript or lint errors. Production changes additionally require: migration applied, bulk release deployed, production verification of the affected user-visible behavior, and runbook updates wherever the change creates a new operator action (migrations to run, env vars to set, schedules to configure, terms to accept).

---

## 22 Delivery Factory Appendix

The Delivery Factory is the fulfillment product: it receives signed handoff packages from the Lead Engine and runs workflow automations for won engagements. It keeps separate data, credentials, queues, storage, and sessions; integration with the Lead Engine is exclusively through the versioned HTTPS contracts (`LeadEngineHandoffPackage/v1`, `DeliveryFeedbackEvent/v1`).

**Seeded automation templates (4):** the three original templates plus **"Lead follow-up (SMS, draft-first)"** (2026-09-26) — a live, runnable demo of the capability matrix: `lead_handoff` trigger → `ai_assist` drafts a sub-160-character follow-up SMS from the lead context → `send_sms` records the message as a draft → `log_database` writes the audit entry. Draft-first throughout per the no-automated-outreach rule: with no SMS/AI provider configured, both nodes record drafts for human approval; nothing sends. Wiring a provider later upgrades the draft to a real personalized message automatically. The template ships as a Neon seed migration run in the DF SQL editor.

**Engine note (2026-09-26):** `renderTemplate` now accepts hyphens in `{{...}}` paths, so node outputs are reachable via `{{node_<node_key>...}}` for standard hyphenated keys (previously such references silently leaked through as literal text).

**Intake dedupe:** the DF dedupes handoff intake on the idempotency key, so a retried LE dispatch can never create a duplicate engagement even if the original response was lost.

**Intake auto-trigger (2026-09-26):** a fresh 201 intake accept immediately executes every published `lead_handoff` workflow with the handoff package as trigger payload (`{lead: {name, phone, score}, organization_name}`), honoring each workflow's `trigger_config.minScore` gate (a positive gate with unknown score does not auto-run; the operator can run it manually). Execution is failure-isolated from intake — a workflow failure is recorded as a `delivery.handoff.trigger_failed` feedback event and never turns an accepted intake into an error. Replays never re-execute. Note: the v1 contract carries no phone number or numeric score, so the demo template's SMS step fails loudly with a missing-recipient reason until stakeholder contact data is captured; the AI draft and the exact missing-data reason remain fully audited.

---

*End of document*
