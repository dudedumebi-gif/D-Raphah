# Spend Gate & Billing Alerts — Lead Engine

The audit found no spend guardrails: a runaway discovery schedule or a
stuck retry loop could burn the monthly budget silently. This runbook is
the billing-alert process and the **CAD 150/month aggregate gate**.

## The gate

| Service | Budget line (CAD/month) | Alert at |
|---------|------------------------|----------|
| Neon (compute + storage) | 60 | 80% of line |
| Vercel (functions, bandwidth) | 50 | 80% of line |
| QStash (messages, schedules) | 40 | 80% of line |
| **Aggregate gate** | **150** | any single line at 100%, or aggregate at 80% |

Hitting a line's alert threshold is a warning: investigate before the
line is exhausted. Hitting the **aggregate gate** is a stop: pause the
daily discovery schedule and the canary until spend is understood.

## Setup (one-time, per service)

### Neon
1. Neon console → project `d-raphah-leads-engine` → **Settings → Billing**.
2. Set a **spend limit / budget alert** at 80% of the CAD 60 line.
3. Alert destination: the operator email on the Neon account.

### Vercel
1. Vercel dashboard → project `d-raphah-leads-engine` →
   **Settings → Usage & Billing**.
2. Enable **spend alerts** at 80% of the CAD 50 line.
3. The LE project must stay within the 12-serverless-function Hobby cap;
   the commercial-plan review (audit business item) is a separate
   account decision — this runbook only watches spend.

### QStash (Upstash console)
1. Upstash console → QStash → **Billing/Usage**.
2. Set the usage alert at 80% of the CAD 40 line.
3. The daily discovery schedule (`raphah-lead-discovery-v1`, 1 message/day)
   and the worker tick (288 messages/day) are the steady-state load; a
   spike here means a schedule was duplicated or a destination is
   retry-storming.

## Monthly check (first Monday)

- [ ] Record last month's actuals per service in the log below
- [ ] Confirm all three alert rules are still enabled
- [ ] Confirm no duplicate QStash schedules exist
       (`scripts/configure-qstash.mjs` uses stable schedule IDs — re-running
       it must not create duplicates)

## Breach response

1. **Identify the line**: which service crossed its alert threshold.
2. **Neon spike** → check `scrape_jobs` for retry storms (many jobs in
   `retrying` with high `attempt_count`); the dead-letter alert
   (`LEAD_ENGINE_DEAD_LETTER_ALERT_THRESHOLD`) usually fires first.
3. **Vercel spike** → check function invocations; a hot `/api/v1/worker/tick`
   means QStash is delivering more often than every 5 minutes.
4. **QStash spike** → list schedules; delete duplicates.
5. **Aggregate gate hit (CAD 150)** → pause the discovery schedule in the
   QStash dashboard and set the canary schedule to paused until the cause
   is fixed and the operator signs off. Discovery sources keep their
   24h cadence guard, so resuming is safe.
6. Record the incident in the log below.

### Spend log

| Month | Neon | Vercel | QStash | Total | Gate hit? | Notes |
|-------|------|--------|--------|-------|-----------|-------|
|       |      |        |        |       |           |       |

## What this runbook does NOT do

There is deliberately no live spend integration in the app: billing APIs
are account-scoped, not project-scoped, and polling them from a
serverless function adds the very spend it watches. Alerts come from the
providers' own billing notifications, and the monthly check keeps them
honest.
