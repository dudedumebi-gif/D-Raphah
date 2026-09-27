# Operations Alerting — Lead Engine

The pipeline promises "zero babysitting", so canary failures and
dead-letter pile-ups reach the operator without dashboard-watching.
Alerting is emitted at the end of every worker tick
(`POST /api/v1/worker/tick`, every 5 minutes via QStash).

## What alerts

| Alert type | Trigger | Dedupe |
|------------|---------|--------|
| `canary_failed` | a `canary_runs` row with `status = 'failed'` | once per canary run id |
| `dead_letter_threshold` | ≥ N jobs dead-lettered in the last hour in a workspace | once per workspace per UTC hour |

N defaults to **5** and is set with `LEAD_ENGINE_DEAD_LETTER_ALERT_THRESHOLD`.

## Delivery

Every alert always does two things, even with no webhook configured:

1. Inserts a row into `public.alert_log` (the durable record).
2. Writes an `audit_events` entry with action `alert.<type>` (actor: system).

When `LEAD_ENGINE_ALERT_WEBHOOK_URL` is set (Vercel env var, production),
the alert is also POSTed as JSON:

```json
{
  "type": "canary_failed",
  "workspaceId": "…",
  "resourceType": "canary_runs",
  "resourceId": "…",
  "reason": "…",
  "payload": {},
  "at": "2026-09-26T…Z",
  "service": "lead-engine"
}
```

Webhook delivery is best-effort: a failed POST is logged
(`alert_webhook_failed`) but never throws, so alerting can never fail the
worker tick. Dedupe is enforced by the `(alert_type, resource_id)` unique
constraint — repeat ticks never re-alert.

## Operator setup

1. Create an incoming webhook (Slack, PagerDuty, or a simple HTTPS
   endpoint that pages you).
2. Set `LEAD_ENGINE_ALERT_WEBHOOK_URL` on the Vercel project
   (`d-raphah-leads-engine`, production).
3. Trigger a **fresh deployment** — redeploying an old deployment does
   not pick up changed env vars.
4. Test: the next failed canary run produces one alert row, one audit
   event, and one webhook POST.

## Tuning

- Threshold too noisy → raise `LEAD_ENGINE_DEAD_LETTER_ALERT_THRESHOLD`.
- A canary that fails every hour alerts once per failed run — fix the
  canary target (see the canary runbook), don't silence the alert.
- `alert_log` is readable by workspace members; operators manage it.
