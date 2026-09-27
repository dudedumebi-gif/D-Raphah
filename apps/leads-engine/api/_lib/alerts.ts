/**
 * Operator alerting (audit gap 4).
 *
 * The pipeline promises "zero babysitting", so a canary failure or a
 * dead-letter pile-up must reach the operator without them watching the
 * dashboard. This module is the single emission point:
 *
 *   - emitAlert() inserts one row into public.alert_log. The
 *     (alert_type, resource_id) unique constraint is the dedupe key: a
 *     canary failure alerts exactly once; a dead-letter threshold breach
 *     alerts at most once per workspace per hour.
 *   - Every emission also writes an audit event (action `alert.<type>`) and
 *     a structured log line, regardless of webhook configuration.
 *   - When LEAD_ENGINE_ALERT_WEBHOOK_URL is set, the alert is also POSTed as
 *     JSON {type, workspaceId, resourceType, resourceId, reason, payload, at}.
 *     Webhook delivery never throws: a failed webhook is logged, the
 *     alert_log row and audit event are the durable record.
 *
 * The worker tick calls checkCanaryAlerts() and checkDeadLetterAlerts() at
 * the end of each tick, failure-isolated so alerting can never fail the tick.
 */

import { log, reportError } from "./telemetry.js";

export const ALERT_WEBHOOK_URL_ENV = "LEAD_ENGINE_ALERT_WEBHOOK_URL";
export const DEAD_LETTER_THRESHOLD_ENV =
  "LEAD_ENGINE_DEAD_LETTER_ALERT_THRESHOLD";
export const DEFAULT_DEAD_LETTER_THRESHOLD = 5;
const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Minimal SQL client shape, matching the neon tagged-template used across
 * api/_lib. Kept structural so alerting is unit-testable with a stub.
 */
export type AlertSqlClient = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

export type AlertType = "canary_failed" | "dead_letter_threshold";

export interface AlertInput {
  workspaceId: string;
  type: AlertType;
  /** e.g. "canary_runs" or "scrape_jobs". */
  resourceType: string;
  /**
   * Stable dedupe key: the canary run id for canary_failed, or
   * `${workspaceId}:${hourBucket}` for dead_letter_threshold.
   */
  resourceId: string;
  reason: string;
  payload?: Record<string, unknown>;
}

interface AlertLogRow {
  id: string;
}

function webhookUrl(): string | null {
  const url = process.env[ALERT_WEBHOOK_URL_ENV]?.trim();
  return url ? url : null;
}

export function deadLetterThreshold(): number {
  const raw = Number(process.env[DEAD_LETTER_THRESHOLD_ENV]);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_DEAD_LETTER_THRESHOLD;
}

async function postWebhook(alert: AlertInput): Promise<void> {
  const url = webhookUrl();
  if (!url) return;
  const body = JSON.stringify({
    type: alert.type,
    workspaceId: alert.workspaceId,
    resourceType: alert.resourceType,
    resourceId: alert.resourceId,
    reason: alert.reason,
    payload: alert.payload ?? {},
    at: new Date().toISOString(),
    service: "lead-engine",
  });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!response.ok) {
      log("warn", "alert_webhook_non_ok", {
        workspaceId: alert.workspaceId,
        alertType: alert.type,
        status: response.status,
      });
    }
  } catch (error) {
    // Webhook delivery is best-effort; the alert_log row is the record.
    log("warn", "alert_webhook_failed", {
      workspaceId: alert.workspaceId,
      alertType: alert.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Emit one alert. Returns true when this call created the alert (i.e. it
 * was not a duplicate). Never throws: persistence failures are reported via
 * reportError so a broken alert path is itself visible in telemetry.
 */
export async function emitAlert(
  client: AlertSqlClient,
  alert: AlertInput,
): Promise<boolean> {
  try {
    const rows = (await client`
      insert into public.alert_log(
        workspace_id, alert_type, resource_type, resource_id, reason, payload
      ) values (
        ${alert.workspaceId}::uuid, ${alert.type}, ${alert.resourceType},
        ${alert.resourceId}, ${alert.reason},
        ${JSON.stringify(alert.payload ?? {})}::jsonb
      )
      on conflict (alert_type, resource_id) do nothing
      returning id
    `) as unknown as AlertLogRow[];
    if (rows.length === 0) return false; // duplicate: already alerted
    // Companion audit entry: alerts are operator-visible decisions. Written
    // by direct insert because log_workspace_event() requires a human JWT
    // session (is_workspace_member) and the worker runs as the service role.
    // actor_id is null = system emission, which is the honest attribution.
    await client`
      insert into public.audit_events(
        workspace_id, actor_id, action, resource_type, resource_id,
        outcome, reason, after_state
      ) values (
        ${alert.workspaceId}::uuid, null, ${`alert.${alert.type}`}::text,
        ${alert.resourceType}::text, ${alert.resourceId}::text,
        'success', ${alert.reason}::text,
        ${JSON.stringify(alert.payload ?? {})}::jsonb
      )
    `;
    log("warn", `alert_emitted:${alert.type}`, {
      workspaceId: alert.workspaceId,
      resourceType: alert.resourceType,
      resourceId: alert.resourceId,
      reason: alert.reason,
    });
    await postWebhook(alert);
    return true;
  } catch (error) {
    await reportError(error, {
      workspaceId: alert.workspaceId,
      alertType: alert.type,
    });
    return false;
  }
}

interface FailedCanaryRow {
  id: string;
  workspace_id: string;
  failure_reason: string | null;
  completed_at: string | null;
}

/**
 * Alert once per failed canary run. A canary run that already has an
 * alert_log entry is skipped, so re-runs of the tick never re-alert.
 */
export async function checkCanaryAlerts(
  client: AlertSqlClient,
): Promise<number> {
  const rows = (await client`
    select cr.id, cr.workspace_id, cr.failure_reason, cr.completed_at
    from public.canary_runs cr
    where cr.status = 'failed'
      and not exists (
        select 1 from public.alert_log al
        where al.alert_type = 'canary_failed'
          and al.resource_id = cr.id::text
      )
  `) as unknown as FailedCanaryRow[];
  let emitted = 0;
  for (const row of rows) {
    const created = await emitAlert(client, {
      workspaceId: row.workspace_id,
      type: "canary_failed",
      resourceType: "canary_runs",
      resourceId: row.id,
      reason: row.failure_reason ?? "Canary run failed",
      payload: { completedAt: row.completed_at },
    });
    if (created) emitted += 1;
  }
  return emitted;
}

interface DeadLetterCountRow {
  workspace_id: string;
  recent_dead_letters: number;
}

/**
 * Alert when a workspace's recently dead-lettered jobs breach the threshold
 * (LEAD_ENGINE_DEAD_LETTER_ALERT_THRESHOLD, default 5). One alert per
 * workspace per UTC hour: the resource id embeds the hour bucket, so the
 * unique constraint naturally rate-limits repeat alerts while the queue
 * stays backed up.
 */
export async function checkDeadLetterAlerts(
  client: AlertSqlClient,
): Promise<number> {
  const threshold = deadLetterThreshold();
  const hourBucket = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const rows = (await client`
    select workspace_id, count(*)::int as recent_dead_letters
    from public.scrape_jobs
    where status = 'dead_letter'
      and completed_at > now() - interval '1 hour'
    group by workspace_id
    having count(*) >= ${threshold}
  `) as unknown as DeadLetterCountRow[];
  let emitted = 0;
  for (const row of rows) {
    const created = await emitAlert(client, {
      workspaceId: row.workspace_id,
      type: "dead_letter_threshold",
      resourceType: "scrape_jobs",
      resourceId: `${row.workspace_id}:${hourBucket}`,
      reason:
        `${row.recent_dead_letters} scrape jobs dead-lettered in the last ` +
        `hour (threshold ${threshold})`,
      payload: {
        recentDeadLetters: row.recent_dead_letters,
        threshold,
        hourBucket,
      },
    });
    if (created) emitted += 1;
  }
  return emitted;
}
