# Lead Engine Product Requirements Document

**Multi-Source Opportunity Discovery and Revenue Pipeline for the Raphah.io AI and Business Systems Advisory**

| Field | Value |
|---|---|
| Version | 2.0 |
| Date | 2026-09-26 |
| Status | Living document — reflects the production system (Lead Engine v3) |
| Owner | Chidumebi (Raphah.io) |
| Stack | Neon Postgres + QStash + Vercel |

## Decision summary

Build the Lead Engine as a compliant business development operating system. It discovers public business opportunities, qualifies them against the advisory offer, supports human-reviewed outreach, and measures conversion to paid work. LinkedIn remains an important channel for authority and relationships, but the product will not scrape LinkedIn or automate prohibited activity.

**What changed in v2:** the v1 skeleton described intent; v2 documents what was actually built and shipped to production. The Lead Engine is now a live multi-workspace product with a source approval gate, durable scrape-job lifecycle, automation-maturity scoring, qualified-lead export, a criteria feedback loop, and a signed handoff into the Delivery Factory for fulfillment. Outreach remains draft-only in the MVP: the system drafts, a human approves and sends.

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
- No fully autonomous criteria changes: suggestions require operator apply/save.

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

The Lead Engine v3 web app is organized into eight views:

1. **Overview** — pipeline health at a glance: recent runs, lead counts, qualification funnel.
2. **Sources & policies** — create sources (name, base URL, collection method, purpose), edit them after creation, and move them through the approval gate: `pending approval` → `Approve` → `active`. Policies are versioned and immutable; budgets and rate limits cannot be silently changed.
3. **Scrape jobs** — pick an approved source, enter a public target URL, queue a scrape. Jobs show a durable lifecycle (queued, leased, retried, completed, dead-lettered) with per-attempt detail and a live progress window.
4. **Qualified leads** — the review queue. Each lead shows its score, confidence, geography eligibility, and the evidence behind it.
5. **Operations** — worker health, schedules, and the 72-hour canary status.
6. **Audit log** — every pipeline event, grouped into expandable run buckets with grandparent → parent → child hierarchy (job → attempts/evidence → signal observations → assessments → opportunities). Each entry carries an OMA business interpretation (Observation, Metric, Action) plus the full technical JSON.
7. **Criteria & schedule** — qualification thresholds (score, confidence, AI-enablement, geo-radius with city presets), auto-apply settings, and the engine's criteria suggestions, which the operator applies or saves manually. Applied suggestions are suppressed until fresh scrape output changes the qualified count.
8. **Help & guide** — in-app knowledge transfer: the full workflow from workspace to revenue, plus troubleshooting.

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
- Lead export (structured, CSV).
- Signed handoff to the Delivery Factory (SHA-256 manifest); feedback events back.
- In-app Help & guide.
- 72-hour production canary before launch sign-off.

### P1 — first expansion

- Multi-day drip follow-up orchestration (chained schedule-triggered workflows).
- Provider wiring for SMS (Twilio) and AI (OpenAI-compatible) in the Delivery Factory.
- Lead feedback loop auto-tuning criteria weights (partially built: `lead_feedback`).
- Discovery runs at city scale via Overpass with durable geocode cache.

### P2 — later productization

- Multi-user workspaces with fine-grained roles.
- Client-facing reporting views.
- Additional source adapters (procurement APIs, review platforms) pending terms review.

## 8 Web Collection Requirements

### 8.1 Source Approval Gate

No source runs until its policy is explicitly approved and active. Approval records: access permissions, terms review, robots rules, collection purpose, allowed fields, rate limits, retention window, and review cadence. Policies are versioned; budgets and rate limits are immutable once set. The UI enforces the gate: only `active` sources appear in the scrape-job source picker.

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

Before outreach begins on a qualified lead, the record must show: qualified score and confidence, an approved contact path, CASL basis (consent or existing relationship) with sender identification and unsubscribe mechanism, and operator approval of the draft message. Missing items block the outreach stage.

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
- `canary_runs` — 72-hour production canary
- `audit_events` — the complete audit trail
- Handoff: `handoff_outbox` (LE) → `handoff_inbox` (DF); `delivery_feedback` / `feedback_outbox` (DF → LE)

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
- **Runtime:** Vercel serverless functions (12-function Hobby limit respected via dispatcher consolidation), Neon Postgres over HTTPS data API, QStash for scheduled worker ticks and the hourly canary.
- **Auth:** Neon Auth (email/password + Google) with RLS; DF operator access additionally gated by an email allowlist.

## 14 Nonfunctional Requirements

- **Availability:** pipeline degrades gracefully — worker tick failures are retried via QStash; the UI shows last-known state with a staleness banner.
- **Durability:** jobs are never lost: queued → leased → retried → completed or dead-lettered, all queryable.
- **Auditability:** every state change writes an audit event with before/after state; runs are reconstructible.
- **Security:** RLS on all tenant tables; secrets in Vercel env / Secure Vault, never in code or logs; credential-bearing URLs are never stored or reproduced.
- **Performance:** scrape attempts time out at 15s; long waits are clamped in serverless; multi-day sequences chain scheduled workflows.
- **Portability:** the same API handlers run on Vercel or in Docker/Compose via the Node adapter (handover options documented).

## 15 Success Metrics

### 15.1 North Star Metric

Qualified opportunities reviewed that produce a substantive prospect conversation. This metric connects discovery quality to real commercial engagement and avoids rewarding raw lead volume.

### 15.2 Operating Economics

Until the business has produced at least CAD 1,000 in recurring monthly revenue, recurring software and infrastructure spend should remain below CAD 150 per month unless a documented experiment has a defined payback test. Labour time must also be tracked because a low cash cost can still conceal an inefficient workflow.

## 16 Release Plan

### 16.1 MVP Launch Acceptance

- [x] Production stack live (Neon + QStash + Vercel), health checks green
- [x] Source approval gate enforced end to end
- [x] Scrape → evidence → score → qualify loop demonstrated on real sites
- [x] Audit log with OMA interpretation and technical drill-down
- [x] Signed LE → DF handoff verified (synthetic E2E 9/9)
- [x] Lead export
- [ ] 72-hour canary: clock starts on first successful canary run; no final sign-off before it completes
- [ ] First real qualified lead reviewed by the operator

Bulk-release policy: changes ship in batched releases to conserve the Vercel API deployment quota; UI look-and-feel is verified locally before release.

## 17 Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Source terms/robots change mid-campaign | Per-attempt robots check; stop conditions dead-letter the job and audit the reason |
| Low lead quality wastes operator time | Evidence-backed scoring, tunable thresholds, feedback loop |
| Automated-outreach legal exposure (CASL) | Draft-only MVP; outreach readiness checklist; human sends |
| Platform dependence (Vercel/Neon/QStash) | Docker/Compose handover path kept warm; 12-function limit respected |
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

**Open:**

- SMS/AI provider selection and cost envelope for Delivery Factory automation at scale.
- Whether the product ever becomes a multi-tenant SaaS, and on what pricing.
- Additional source categories pending terms review (procurement APIs, review platforms).

## 19 Delivery Backlog

Shipped (Phase 0–3): production stack, source approval gate, durable scrape jobs, maturity scoring, qualified-lead queue, criteria suggestions, hierarchical audit log, lead export, signed LE→DF handoff, DF workflow automation (15 node kinds), DF automation templates, in-app help, operator auth.

Next: 72-hour canary completion, first real qualified lead, SMS/AI provider wiring, multi-day drip orchestration, discovery at city scale, alerting/rollback/credential-rotation runbooks, backup/restore drill.

## 20 Compliance References

These sources inform the product guardrails. They are not a substitute for legal advice or a source-specific terms review.

1. **LinkedIn User Agreement** — prohibits software, scripts, robots, crawlers, plugins, or other processes used to scrape or copy LinkedIn services and data. The product therefore blocks LinkedIn crawling and automated account activity. https://www.linkedin.com/legal/user-agreement
2. **Robots Exclusion Protocol RFC 9309** — the crawler implements the standardized robots.txt protocol and records the rule set used for each collection decision. https://www.rfc-editor.org/rfc/rfc9309.html
3. **CRTC Canada Anti-Spam Legislation FAQ** — commercial electronic messages generally require consent, sender identification, and an unsubscribe mechanism. Outreach readiness records these elements where applicable. https://crtc.gc.ca/eng/com500/faq500.htm
4. **Office of the Privacy Commissioner of Canada — Data Scraping Statement** — publicly accessible personal information remains subject to privacy and data protection laws. The product defaults to organization-level signals and minimizes personal information. https://www.priv.gc.ca/en/opc-news/speeches-and-statements/2024/js-dc_20241028/
5. **Office of the Privacy Commissioner of Canada — E-Marketing Guidance** — warns against address harvesting and explains organizational accountability for consent and third-party marketing lists. https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/r_o_p/canadas-anti-spam-legislation/casl-compliance-help-for-businesses/casl_guide/

## 21 Definition of Done

A change is done when: business criteria pass and the behavior is demonstrated; unit, integration, and contract test coverage is updated; hard compliance constraints (policy checks, human approval, checksum verification) are enforced; and the build is clean with zero TypeScript or lint errors. Production changes additionally require: migration applied, bulk release deployed, and production verification of the affected user-visible behavior.

---

*End of document*
