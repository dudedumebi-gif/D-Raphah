import { afterEach, describe, expect, it, vi } from "vitest";
import {
  alertCooldownMinutes,
  alertsEnabled,
  checkOperationalAlerts,
  formatSlackAlert,
  reconcileAlert,
  recordQstashFailure,
  type AlertInput,
  type AlertSqlClient,
} from "../api/_lib/alerts";

const WS = "2e48593c-feb0-41e3-b0e5-0e42cf398a43";
const OLD_ENV = process.env;

const input = (overrides: Partial<AlertInput> = {}): AlertInput => ({
  workspaceId: WS,
  type: "worker_stale",
  severity: "critical",
  resourceType: "worker_nodes",
  resourceId: `${WS}:worker-heartbeat`,
  active: true,
  reason: "Heartbeat is stale",
  likelyCause: "QStash delivery stopped",
  nextAction: "Inspect QStash and Vercel logs",
  ...overrides,
});

function clientForTransition(transition: "opened"|"reminder"|"resolved"|"unchanged") {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const client = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?").toLowerCase();
    queries.push({ sql, values });
    if (sql.includes("insert into public.alert_log"))
      return transition === "opened" || transition === "reminder"
        ? [{ alert_id: "alert-1", transition }]
        : [];
    if (sql.includes("update public.alert_log"))
      return transition === "resolved"
        ? [{ alert_id: "alert-1", transition }]
        : [];
    if (sql.includes("insert into public.audit_events")) return [];
    throw new Error(`unexpected query: ${sql.slice(0, 100)}`);
  }) as AlertSqlClient;
  return { client, queries };
}

afterEach(() => {
  process.env = OLD_ENV;
  vi.restoreAllMocks();
});

describe("stateful Slack alerts", () => {
  it("uses the new Slack secret and defaults to a 30-minute cooldown", () => {
    process.env = { ...OLD_ENV, SLACK_OPS_ALERT_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/X" };
    expect(alertsEnabled()).toBe(true);
    expect(alertCooldownMinutes()).toBe(30);
    process.env.SLACK_ALERT_COOLDOWN_MINUTES = "45";
    expect(alertCooldownMinutes()).toBe(45);
  });

  it("can explicitly disable delivery without deleting the secret", () => {
    process.env = {
      ...OLD_ENV,
      SLACK_OPS_ALERT_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/X",
      SLACK_ALERTS_ENABLED: "false",
    };
    expect(alertsEnabled()).toBe(false);
  });

  it("persists, audits, and posts an opened incident", async () => {
    process.env = { ...OLD_ENV, SLACK_OPS_ALERT_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/X" };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const { client, queries } = clientForTransition("opened");
    expect(await reconcileAlert(client, input(), new Date("2026-10-08T10:00:00Z"))).toBe("opened");
    expect(queries.some((query) => query.sql.includes("insert into public.audit_events"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.text).toContain("CRITICAL: Worker heartbeat stale");
    expect(body.text).toContain("Likely cause");
    expect(body.text).not.toContain("hooks.slack.com");
  });

  it("sends a recovery and stays silent for unchanged state", async () => {
    process.env = { ...OLD_ENV, SLACK_OPS_ALERT_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/X" };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const recovered = clientForTransition("resolved");
    await reconcileAlert(recovered.client, input({ active: false }));
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).text).toContain("RECOVERED");
    fetchMock.mockClear();
    const unchanged = clientForTransition("unchanged");
    await reconcileAlert(unchanged.client, input());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("formats production context and operator action", () => {
    const text = formatSlackAlert(input(), "reminder", "2026-10-08T10:00:00Z");
    expect(text).toContain("Lead Engine / production");
    expect(text).toContain("Inspect QStash and Vercel logs");
  });
});

describe("operational evaluator", () => {
  it("opens all seven database-observable conditions", async () => {
    process.env = {
      ...OLD_ENV,
      SLACK_ALERTS_ENABLED: "false",
      LEAD_ENGINE_CANARY_URL: "https://expected.example/canary-source.html",
    };
    const now = new Date("2026-10-08T12:00:00Z");
    const old = "2026-10-08T11:30:00Z";
    const sampleStart = now.getTime() - 72 * 3_600_000;
    const soak = Array.from({ length: 72 }, (_, index) => ({
      workspace_id: WS,
      scheduled_at: new Date(sampleStart + index * 3_600_000).toISOString(),
      completed_at: new Date(sampleStart + index * 3_600_000 + 60_000).toISOString(),
      status: "completed",
    }));
    const client = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?").toLowerCase();
      if (sql.includes("select id from public.workspaces")) return [{ id: WS }];
      if (sql.includes("from public.worker_nodes")) return [{ id: "worker-a", last_heartbeat_at: old }];
      if (sql.includes("distinct on (cr.workspace_id)")) return [{
        id: "run-terminal", workspace_id: WS, status: "failed",
        scheduled_at: old, completed_at: old, failure_reason: "no persistent lead",
        target_url: "https://wrong.example",
      }];
      if (sql.includes("cr.status in ('queued','running')")) return [{
        id: "run-stuck", workspace_id: WS, status: "running",
        scheduled_at: old, completed_at: null, failure_reason: null,
      }];
      if (sql.includes("from public.scrape_jobs sj")) return [{
        id: "job-dead", workspace_id: WS, status: "dead_letter", last_error: "robots denied",
      }];
      if (sql.includes("percentile_cont")) return [{ workspace_id: WS, p95_ms: 301_000 }];
      if (sql.includes("select workspace_id, scheduled_at")) return soak;
      if (sql.includes("insert into public.alert_log"))
        return [{ alert_id: "alert", transition: "opened" }];
      if (sql.includes("update public.alert_log")) return [];
      if (sql.includes("insert into public.audit_events")) return [];
      throw new Error(`unexpected query: ${sql.slice(0, 100)}`);
    }) as AlertSqlClient;
    // A failed terminal canary cannot simultaneously be a completed target
    // mismatch; the six active conditions here plus the separate target test
    // cover all seven database-observable rules.
    expect(await checkOperationalAlerts(client, now)).toBe(6);
  });

  it("detects a completed canary that used the wrong target", async () => {
    process.env = {
      ...OLD_ENV,
      SLACK_ALERTS_ENABLED: "false",
      LEAD_ENGINE_CANARY_URL: "https://expected.example/canary-source.html",
    };
    const now = new Date("2026-10-08T12:00:00Z");
    const client = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?").toLowerCase();
      if (sql.includes("select id from public.workspaces")) return [{ id: WS }];
      if (sql.includes("from public.worker_nodes")) return [{ id: "worker-a", last_heartbeat_at: now.toISOString() }];
      if (sql.includes("distinct on (cr.workspace_id)")) return [{
        id: "run-complete", workspace_id: WS, status: "completed",
        scheduled_at: now.toISOString(), completed_at: now.toISOString(),
        failure_reason: null, target_url: "https://wrong.example",
      }];
      if (sql.includes("cr.status in ('queued','running')")) return [];
      if (sql.includes("from public.scrape_jobs sj")) return [];
      if (sql.includes("percentile_cont")) return [];
      if (sql.includes("select workspace_id, scheduled_at")) return [];
      if (sql.includes("insert into public.alert_log")) {
        const isMismatch = values[1] === "canary_target_mismatch";
        return isMismatch ? [{ alert_id: "alert", transition: "opened" }] : [];
      }
      if (sql.includes("update public.alert_log")) return [];
      if (sql.includes("insert into public.audit_events")) return [];
      throw new Error(`unexpected query: ${sql.slice(0, 100)}`);
    }) as AlertSqlClient;
    expect(await checkOperationalAlerts(client, now)).toBe(1);
  });

  it("records a signed QStash final-delivery failure as the eighth condition", async () => {
    process.env = { ...OLD_ENV, SLACK_ALERTS_ENABLED: "false" };
    const { client, queries } = clientForTransition("opened");
    const sourceBody = Buffer.from(JSON.stringify({ schedule: "raphah-lead-worker-v1" })).toString("base64");
    expect(await recordQstashFailure(client, WS, {
      status: 503, retried: 3, maxRetries: 3, sourceMessageId: "msg_1",
      dlqId: "dlq_1", sourceBody,
    })).toBe("opened");
    const values = queries.find((query) => query.sql.includes("insert into public.alert_log"))?.values ?? [];
    expect(values[3]).toBe(`${WS}:qstash:raphah-lead-worker-v1`);
  });
});
