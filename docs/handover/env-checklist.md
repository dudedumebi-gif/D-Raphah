# Environment checklist — client handover

Fill one copy per environment (staging / production). Every value comes from
the client's own secret store; none are ever pasted into chat or tickets.

## Lead Engine (`d-raphah-leads-engine`)

| Variable | Set | Notes |
|---|---|---|
| `DATABASE_URL` | ☐ | Neon `raphah-lead-engine`, pooled |
| `HANDOFF_PRIVATE_KEY_PEM` | ☐ | Ed25519, signs handoff packages |
| `LEAD_ENGINE_PUBLIC_KEY_PEM` | ☐ | Published to Delivery Factory |
| `FEEDBACK_PRIVATE_KEY_PEM` | ☐ | Signs feedback events |
| `DELIVERY_FACTORY_PUBLIC_KEY_PEM` | ☐ | Verifies feedback acks |
| `DELIVERY_INTAKE_URL` | ☐ | `https://<df-host>/api/intake` |
| `WORKER_SECRET` | ☐ | Bearer for `/api/v1/worker/tick` |
| `NEON_DATA_API_URL` / `NEON_AUTH_URL` | ☐ | Required for `/api/health/ready` |
| `ALLOWED_ORIGINS` | ☐ | Comma-separated HTTPS origins |
| `APP_ENV` | ☐ | `production` |

## Delivery Factory (`d-raphah-delivery-factory`)

| Variable | Set | Notes |
|---|---|---|
| `DELIVERY_DATABASE_URL` | ☐ | Neon `raphah-delivery-factory`, pooled |
| `LEAD_ENGINE_PUBLIC_KEY_PEM` | ☐ | Verifies handoff signatures |
| `DELIVERY_FACTORY_PUBLIC_KEY_PEM` | ☐ | Published to Lead Engine |
| `FEEDBACK_PRIVATE_KEY_PEM` | ☐ | Signs feedback events |
| `DELIVERY_FACTORY_CRON_SECRET` | ☐ | Bearer for internal dispatch |
| `ALLOWED_ORIGINS` | ☐ | Comma-separated HTTPS origins |
| `APP_ENV` | ☐ | `production` |

## Schedules (QStash or Cloud Scheduler)

| Schedule | Target | Cadence | Set |
|---|---|---|---|
| Worker tick | LE `POST /api/v1/worker/tick` | every 5 min | ☐ |
| Canary | LE `POST /api/v1/canary/run` | hourly | ☐ |
| Feedback dispatch | DF `POST /api/internal/dispatch-feedback` | every 5 min | ☐ |

## Sign-off

- [ ] `/api/health/live` → `ok` on both services
- [ ] `/api/health/ready` → `ready` on both services
- [ ] Synthetic handoff accepted end-to-end (intake → project → feedback)
- [ ] 72-hour canary green
- Operator: ______________________ Date: __________
