# Operations Alerting — Lead Engine

Lead Engine evaluates operational health at the end of every signed worker
tick and through an independent five-minute QStash monitor schedule. The
independent schedule can detect a stale worker even when no worker tick is
running. Incidents are persisted in Neon, audited, and delivered to the Slack
Incoming Webhook for `#ops-alert`. Slack delivery is best-effort and can never
fail a worker tick, scrape result, or canary.

## Alert conditions

| Type | Severity | Opens when | Recovers when |
|---|---|---|---|
| `worker_stale` | Critical | latest heartbeat is missing or older than 10 minutes | a current heartbeat is observed |
| `canary_stuck` | Critical | queued/running canary exceeds 10 minutes | that run leaves queued/running |
| `canary_failed` | Critical | latest terminal canary failed | a later canary completes |
| `dead_letter` | Critical | any scrape job enters `dead_letter` | that job succeeds after controlled retry |
| `canary_target_mismatch` | Critical | latest completed canary target differs from `LEAD_ENGINE_CANARY_URL` | a later canary completes against the configured target |
| `scheduled_start_p95_breach` | Warning | 72-hour scheduled-start p95 is at least 300,000 ms | p95 falls below 300,000 ms |
| `qstash_delivery_failed` | Critical | signed failure callback reports retries exhausted | the same schedule next delivers successfully |
| `soak_passed` | Info | 72-hour canary reaches the promotion gate | one-time release evidence; no reminders |

## State, dedupe, and reminders

`public.alert_log` is the durable incident record. The existing
`(alert_type, resource_id)` unique key is used as the incident identity.
`reconcile_operational_alert` atomically records one of four transitions:

- `opened` — send Slack and write `alert.<type>.opened` audit event.
- `reminder` — still open after the cooldown; send Slack and audit it.
- `resolved` — send a recovery message and write a recovery audit event.
- `unchanged` — update observation state without notifying.

The default reminder cooldown is 30 minutes. Concurrent worker calls serialize
on the incident row, preventing duplicate transition notifications.

## Vercel variables

| Variable | Type | Scope | Required |
|---|---|---|---|
| `SLACK_OPS_ALERT_WEBHOOK_URL` | Secret | Production | Yes for Slack delivery |
| `SLACK_ALERTS_ENABLED` | Config | Production | No; defaults to enabled when the webhook exists |
| `SLACK_ALERT_COOLDOWN_MINUTES` | Config | Production | No; defaults to `30` |

`LEAD_ENGINE_ALERT_WEBHOOK_URL` remains a temporary compatibility fallback.
Do not expose either webhook variable with a `VITE_` prefix and never print it
in logs, Slack messages, test output, or Postman.

## QStash setup

Run `pnpm qstash:configure` from `apps/leads-engine` after the deployment. The
script configures:

- worker every four minutes;
- independent operational evaluator every five minutes;
- canary hourly;
- discovery daily;
- three retries and a signed failure callback to
  `/api/v1/qstash/failure` for every schedule.

The callback accepts QStash's documented final-failure payload only after
`Upstash-Signature` verification. It records the source message ID, schedule,
HTTP status, and DLQ ID but never stores a webhook secret or raw evidence.

## Verification

1. Apply schema `3.3.4` on a disposable Neon branch and run regression/RLS
   tests before production migration.
2. Deploy the code and confirm `/api/health/ready` returns `200`.
3. Re-run `pnpm qstash:configure`; confirm worker cron is `*/4 * * * *`, the
   monitor cron is `*/5 * * * *`, and each schedule has the failure callback.
4. Use a disposable signed test delivery that returns non-2xx until retries
   exhaust. Confirm one `qstash_delivery_failed` incident, audit event, and
   Slack message. Restore delivery and confirm one recovery message.
5. Query `alert_log` and `audit_events`; confirm reminders do not occur before
   the configured cooldown and no duplicate transition is emitted.
6. Confirm Vercel runtime logs remain authoritative if Slack delivery fails.

Do not deliberately stop the production worker or corrupt production canary
data to test alerts. Use a disposable QStash message or rehearsal branch.
