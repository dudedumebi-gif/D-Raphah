import { log, reportError } from "./telemetry.js";

export const SLACK_WEBHOOK_URL_ENV = "SLACK_OPS_ALERT_WEBHOOK_URL";
export const LEGACY_ALERT_WEBHOOK_URL_ENV = "LEAD_ENGINE_ALERT_WEBHOOK_URL";
export const ALERTS_ENABLED_ENV = "SLACK_ALERTS_ENABLED";
export const ALERT_COOLDOWN_ENV = "SLACK_ALERT_COOLDOWN_MINUTES";
export const DEFAULT_ALERT_COOLDOWN_MINUTES = 30;
const WEBHOOK_TIMEOUT_MS = 10_000;
const STALE_AFTER_MS = 10 * 60_000;
const START_P95_LIMIT_MS = 300_000;

export type AlertSqlClient = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

export type AlertType =
  | "worker_stale"
  | "dead_letter"
  | "scheduled_start_p95_breach"
  | "qstash_delivery_failed";
export type AlertSeverity = "critical" | "warning" | "info";
export type AlertTransition = "opened" | "reminder" | "resolved" | "unchanged";

export interface AlertInput {
  workspaceId: string;
  type: AlertType;
  severity: AlertSeverity;
  resourceType: string;
  resourceId: string;
  active: boolean;
  reason: string;
  likelyCause: string;
  nextAction: string;
  payload?: Record<string, unknown>;
  allowReminder?: boolean;
}

interface AlertTransitionRow {
  alert_id: string | null;
  transition: AlertTransition;
}

function webhookUrl(): string | null {
  const url =
    process.env[SLACK_WEBHOOK_URL_ENV]?.trim() ||
    process.env[LEGACY_ALERT_WEBHOOK_URL_ENV]?.trim();
  return url || null;
}

export function alertsEnabled(): boolean {
  const configured = process.env[ALERTS_ENABLED_ENV]?.trim().toLowerCase();
  if (configured === "false" || configured === "0") return false;
  return Boolean(webhookUrl());
}

export function alertCooldownMinutes(): number {
  const raw = Number(process.env[ALERT_COOLDOWN_ENV]);
  return Number.isFinite(raw) && raw >= 1
    ? Math.floor(raw)
    : DEFAULT_ALERT_COOLDOWN_MINUTES;
}

function productUrl(): string {
  const configured = process.env.LEAD_ENGINE_BASE_URL?.replace(/\/$/, "");
  if (configured) return configured;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return host ? `https://${host}` : "https://d-raphah-leads-engine.vercel.app";
}

function alertTitle(alert: AlertInput, transition: AlertTransition): string {
  const state = transition === "resolved" ? "RECOVERED" : alert.severity.toUpperCase();
  const names: Record<AlertType, string> = {
    worker_stale: "Worker heartbeat stale",
    dead_letter: "Scrape job dead-lettered",
    scheduled_start_p95_breach: "Scheduled-start p95 breached",
    qstash_delivery_failed: "QStash delivery exhausted retries",
  };
  return `${state}: ${names[alert.type]}`;
}

export function formatSlackAlert(
  alert: AlertInput,
  transition: Exclude<AlertTransition, "unchanged">,
  at: string,
): string {
  const icon = transition === "resolved" ? ":white_check_mark:" :
    alert.severity === "critical" ? ":rotating_light:" :
      alert.severity === "warning" ? ":warning:" : ":large_blue_circle:";
  return [
    `${icon} *${alertTitle(alert, transition)}*`,
    "*Product / environment:* Lead Engine / production",
    `*Condition:* ${alert.reason}`,
    `*Likely cause:* ${alert.likelyCause}`,
    `*Next action:* ${alert.nextAction}`,
    `*Resource:* ${alert.resourceType} \`${alert.resourceId}\``,
    `*Workspace:* \`${alert.workspaceId}\``,
    `*Observed:* ${at}`,
    `*Lead Engine:* ${productUrl()}/`,
  ].join("\n");
}

async function postSlack(
  alert: AlertInput,
  transition: Exclude<AlertTransition, "unchanged">,
): Promise<void> {
  if (!alertsEnabled()) return;
  const url = webhookUrl();
  if (!url) return;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: formatSlackAlert(alert, transition, new Date().toISOString()),
      }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!response.ok) {
      log("warn", "slack_alert_non_ok", {
        alertType: alert.type,
        status: response.status,
        workspaceId: alert.workspaceId,
      });
    }
  } catch (error) {
    log("warn", "slack_alert_failed", {
      alertType: alert.type,
      workspaceId: alert.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function reconcileAlert(
  client: AlertSqlClient,
  alert: AlertInput,
  now = new Date(),
): Promise<AlertTransition> {
  try {
    const payload = {
      ...(alert.payload ?? {}),
      likelyCause: alert.likelyCause,
      nextAction: alert.nextAction,
    };
    const cooldown = alertCooldownMinutes();
    const allowReminder = alert.allowReminder ?? true;
    const observedAt = now.toISOString();
    const rows = alert.active
      ? (await client`
          insert into public.alert_log(
            workspace_id, alert_type, resource_type, resource_id, severity,
            status, reason, payload, first_observed_at, last_observed_at,
            last_notified_at, resolved_at, last_transition, occurrence_count
          ) values (
            ${alert.workspaceId}::uuid, ${alert.type}::text,
            ${alert.resourceType}::text, ${alert.resourceId}::text,
            ${alert.severity}::text, 'open', ${alert.reason}::text,
            ${JSON.stringify(payload)}::jsonb, ${observedAt}::timestamptz,
            ${observedAt}::timestamptz, ${observedAt}::timestamptz,
            null, 'opened', 1
          )
          on conflict (alert_type, resource_id) do update set
            workspace_id = excluded.workspace_id,
            resource_type = excluded.resource_type,
            severity = excluded.severity,
            status = 'open',
            reason = excluded.reason,
            payload = excluded.payload,
            first_observed_at = case
              when public.alert_log.status='resolved' then excluded.first_observed_at
              else public.alert_log.first_observed_at end,
            last_observed_at = excluded.last_observed_at,
            last_notified_at = excluded.last_notified_at,
            resolved_at = null,
            last_transition = case
              when public.alert_log.status='resolved' then 'opened'
              else 'reminder' end,
            occurrence_count = public.alert_log.occurrence_count + 1
          where public.alert_log.status='resolved'
             or (${allowReminder}::boolean and (
               public.alert_log.last_notified_at is null or
               public.alert_log.last_notified_at <=
                 ${observedAt}::timestamptz - make_interval(mins => ${cooldown}::integer)
             ))
          returning id as alert_id, last_transition as transition
        `)
      : (await client`
          update public.alert_log set
            status = 'resolved',
            reason = ${alert.reason}::text,
            payload = ${JSON.stringify(payload)}::jsonb,
            last_observed_at = ${observedAt}::timestamptz,
            last_notified_at = ${observedAt}::timestamptz,
            resolved_at = ${observedAt}::timestamptz,
            last_transition = 'resolved'
          where alert_type = ${alert.type}::text
            and resource_id = ${alert.resourceId}::text
            and status = 'open'
          returning id as alert_id, last_transition as transition
        `);
    const transitionRows = rows as unknown as AlertTransitionRow[];
    const transition = transitionRows[0]?.transition ?? "unchanged";
    if (transition === "unchanged") return transition;
    await client`
      insert into public.audit_events(
        workspace_id, actor_id, action, resource_type, resource_id,
        outcome, reason, after_state
      ) values (
        ${alert.workspaceId}::uuid, null,
        ${`alert.${alert.type}.${transition}`}::text,
        ${alert.resourceType}::text, ${alert.resourceId}::text,
        'success', ${alert.reason}::text,
        ${JSON.stringify(payload)}::jsonb
      )
    `;
    log(transition === "resolved" ? "info" : "warn", "operational_alert", {
      alertType: alert.type,
      transition,
      workspaceId: alert.workspaceId,
      resourceId: alert.resourceId,
    });
    await postSlack(alert, transition);
    return transition;
  } catch (error) {
    await reportError(error, {
      alertType: alert.type,
      workspaceId: alert.workspaceId,
      resourceId: alert.resourceId,
    });
    return "unchanged";
  }
}

interface WorkspaceRow { id: string }
interface WorkerRow { id: string; last_heartbeat_at: string }

export async function checkOperationalAlerts(
  client: AlertSqlClient,
  now = new Date(),
): Promise<number> {
  const cutoff72h = new Date(now.getTime() - 72 * 3_600_000).toISOString();
  const [workspaces, workers, deadLetters, p95Rows] =
    (await Promise.all([
      client`select id from public.workspaces order by id`,
      client`select id, last_heartbeat_at from public.worker_nodes order by last_heartbeat_at desc limit 1`,
      client`
        select sj.id, sj.workspace_id, sj.status, sj.last_error
        from public.scrape_jobs sj
        where (sj.status='dead_letter'
              and coalesce(sj.completed_at,sj.updated_at,sj.created_at)
                  >= ${new Date(now.getTime() - 15 * 60_000).toISOString()}::timestamptz)
           or exists (
             select 1 from public.alert_log al
             where al.alert_type='dead_letter'
               and al.resource_id=sj.id::text and al.status='open'
           )
      `,
      client`
        select workspace_id,
          percentile_cont(0.95) within group (
            order by extract(epoch from (started_at-scheduled_for))*1000
          )::float8 as p95_ms
        from public.scrape_jobs
        where scheduled_for >= ${cutoff72h}::timestamptz
          and started_at is not null
        group by workspace_id
      `,
    ])) as unknown as [
      WorkspaceRow[], WorkerRow[],
      Array<{id:string;workspace_id:string;status:string;last_error:string|null}>,
      Array<{workspace_id:string;p95_ms:number}>,
    ];

  let notified = 0;
  const count = (transition: AlertTransition) => {
    if (transition !== "unchanged") notified += 1;
  };
  const latestWorker = workers[0];
  for (const workspace of workspaces) {
    const ageMs = latestWorker
      ? now.getTime() - new Date(latestWorker.last_heartbeat_at).getTime()
      : Number.POSITIVE_INFINITY;
    count(await reconcileAlert(client, {
      workspaceId: workspace.id,
      type: "worker_stale",
      severity: "critical",
      resourceType: "worker_nodes",
      resourceId: `${workspace.id}:worker-heartbeat`,
      active: ageMs > STALE_AFTER_MS,
      reason: latestWorker
        ? `Latest worker heartbeat is ${Math.round(ageMs/60_000)} minutes old`
        : "No worker heartbeat is registered",
      likelyCause: "The QStash worker schedule is delayed, disabled, or returning a non-success response.",
      nextAction: "Inspect the QStash worker schedule and Vercel function logs, then restore signed deliveries.",
      payload: { workerId: latestWorker?.id ?? null, ageMs: Number.isFinite(ageMs) ? ageMs : null },
    }, now));
  }

  for (const job of deadLetters) {
    count(await reconcileAlert(client, {
      workspaceId: job.workspace_id,
      type: "dead_letter",
      severity: "critical",
      resourceType: "scrape_jobs",
      resourceId: job.id,
      active: job.status === "dead_letter",
      reason: job.status === "dead_letter" ? job.last_error ?? "Scrape job exhausted retries" : "The dead-lettered job completed after retry",
      likelyCause: "The source remained unreachable, policy-denied, or invalid through all configured attempts.",
      nextAction: "Inspect the final attempt, correct the source or policy, then use the controlled retry action.",
      payload: { status: job.status },
    }, now));
  }

  for (const row of p95Rows) {
    const p95 = Number(row.p95_ms);
    count(await reconcileAlert(client, {
      workspaceId: row.workspace_id,
      type: "scheduled_start_p95_breach",
      severity: "warning",
      resourceType: "scrape_jobs",
      resourceId: `${row.workspace_id}:scheduled-start-p95`,
      active: p95 >= START_P95_LIMIT_MS,
      reason: `72-hour scheduled-start p95 is ${Math.round(p95)} ms (limit <300000 ms)`,
      likelyCause: "Worker cadence, delivery delay, or queue contention is delaying scheduled work.",
      nextAction: "Inspect QStash delivery latency and worker capacity; keep the worker cadence below five minutes.",
      payload: { p95Ms: p95, limitMs: START_P95_LIMIT_MS },
    }, now));
  }

  return notified;
}

export interface QstashFailurePayload {
  status?: number;
  retried?: number;
  maxRetries?: number;
  sourceMessageId?: string;
  scheduleId?: string;
  dlqId?: string;
  url?: string;
  sourceBody?: string;
}

function scheduleName(payload: QstashFailurePayload): string {
  if (payload.sourceBody) {
    try {
      const parsed = JSON.parse(Buffer.from(payload.sourceBody, "base64").toString("utf8")) as { schedule?: unknown };
      if (typeof parsed.schedule === "string" && parsed.schedule) return parsed.schedule;
    } catch { /* fall through to QStash identifiers */ }
  }
  return payload.scheduleId || payload.sourceMessageId || "unknown-schedule";
}

export async function recordQstashFailure(
  client: AlertSqlClient,
  workspaceId: string,
  payload: QstashFailurePayload,
): Promise<AlertTransition> {
  const schedule = scheduleName(payload);
  return reconcileAlert(client, {
    workspaceId,
    type: "qstash_delivery_failed",
    severity: "critical",
    resourceType: "qstash_schedules",
    resourceId: `${workspaceId}:qstash:${schedule}`,
    active: true,
    reason: `QStash exhausted ${payload.retried ?? payload.maxRetries ?? "all"} retries with HTTP ${payload.status ?? "unknown"}`,
    likelyCause: "The scheduled destination remained unavailable or returned non-success responses through the retry window.",
    nextAction: "Inspect the QStash DLQ and Vercel function logs, correct the endpoint, then republish the failed message.",
    payload: {
      schedule,
      sourceMessageId: payload.sourceMessageId ?? null,
      dlqId: payload.dlqId ?? null,
      status: payload.status ?? null,
      destination: payload.url ?? null,
    },
  });
}

export async function recordQstashSuccess(
  client: AlertSqlClient,
  workspaceId: string,
  schedule: string | undefined,
): Promise<AlertTransition> {
  if (!schedule) return "unchanged";
  return reconcileAlert(client, {
    workspaceId,
    type: "qstash_delivery_failed",
    severity: "critical",
    resourceType: "qstash_schedules",
    resourceId: `${workspaceId}:qstash:${schedule}`,
    active: false,
    reason: "The QStash schedule delivered successfully after the incident",
    likelyCause: "The destination or delivery path recovered.",
    nextAction: "No action required; continue monitoring subsequent scheduled deliveries.",
    payload: { schedule },
  });
}
