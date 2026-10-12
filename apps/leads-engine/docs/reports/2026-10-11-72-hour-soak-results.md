# Lead Engine 72-Hour Production Soak Results

Decision date: 2026-10-11 (America/Toronto)  
Publication snapshot: 2026-10-12 00:59–01:13 UTC  
Decision: **PASS — approved for Production by the product owner**

## Executive result

The Lead Engine completed the required 72-hour canary soak and passed all five
release-decision checks. The production readiness endpoint reported the
database and worker as ready. The product owner then explicitly approved the
Lead Engine for Production.

Production approval changes the release classification only. No Pilot or demo
row was relabelled. Production source definitions, policies, campaigns, and
discovery configurations remain separately controlled.

## Soak measurements

| Measurement | Result | Requirement | Outcome |
| --- | ---: | ---: | --- |
| Observation window | 2026-10-09 02:00 UTC to 2026-10-12 01:00 UTC | 72 hourly observations | PASS |
| Observed canary runs | 72 | 72 | PASS |
| Completed canary runs | 72 | At least 99% | PASS — 100% |
| Missing or non-completed runs | 0 | No material gap | PASS |
| Completion p95, publication window | 242.388 seconds | Operational observation | PASS |
| Scheduled-start p95 | 241.209 seconds | Below 300 seconds | PASS |
| Open critical alerts | 0 | 0 | PASS |
| Dead-letter jobs, rolling 72 hours | 0 | 0 | PASS |

The production readiness response independently returned `hoursCovered: 72`,
`observed: 72`, `missing: 0`, `completed: 72`, `completionRate: 1`, and
`passed: true`. Its snapshot completion p95 was 242.824 seconds.

## Five-check release decision

1. **Canary coverage:** 72/72 hourly observations completed (100%).
2. **Scheduler latency:** scheduled-run start p95 was 241.209 seconds, below the
   five-minute threshold.
3. **Operational health:** the worker heartbeat was current and no critical
   incident was open.
4. **Recovery safety:** durable retry/recovery evidence was present and no
   dead-letter job occurred in the rolling 72-hour window.
5. **Tenant and audit controls:** required tables retained RLS, required
   mutation tables retained audit triggers, and durable RLS behavioural
   evidence was present.

## Durable evidence

- Production-gate alert: `c7e663f1-e80b-4470-a4f7-6ba4066beba5`
- Owner-approval audit event: `6bb49fcd-b07e-4592-af28-1673ee30da27`
- Approval correlation: `lead-engine-production-approval-2026-10-11`
- Evaluated production deployment: `dpl_4fHbnHiVGB7xo2EZ2Z1stu6g44jD`
- Evaluated commit: `640aa4f29c7797eef7fad5940218116c9ae9f836`
- Public readiness endpoint: <https://d-raphah-leads-engine.vercel.app/api/health/ready>

The production-gate alert payload recorded all five checks as true and was
itself written to the audit log. The approval event records the product
owner's decision and explicitly records `pilot_data_relabelled: false`.

## Deployment observation

The evaluated Vercel deployment was in `READY` state and targeted Production.
The public readiness endpoint returned HTTP 200 with `database: ready` and
`worker: ready`.

Vercel's grouped runtime-error API was not available to the connected operator
scope during publication (HTTP 403). This does not alter the five-check result,
which is based on the public readiness response, production Neon evidence, and
the audited gate evaluator. Vercel project access should be adjusted before a
future review if grouped runtime-error inspection is required from this
workspace.

## Approval and operating boundary

The product owner approved: “promote Lead Engine from Pilot to Production.”
The approval is now durable in Neon and this report is the repository handoff.
Source terms and source policies remain human-controlled. The release does not
authorize LinkedIn scraping, authenticated scraping, CAPTCHA bypass,
access-control circumvention, automated outreach, or bulk conversion of Pilot
records.
