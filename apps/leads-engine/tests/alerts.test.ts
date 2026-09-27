import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkCanaryAlerts,
  checkDeadLetterAlerts,
  deadLetterThreshold,
  emitAlert,
  type AlertInput,
  type AlertSqlClient,
} from "../api/_lib/alerts";

const WS = "2e48593c-feb0-41e3-b0e5-0e42cf398a43";

/** Minimal tagged-template stub keyed on recognizable SQL fragments. */
function makeClient(
  handlers: Record<string, (values: unknown[]) => unknown[]>,
): AlertSqlClient {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?").toLowerCase();
    for (const [fragment, handler] of Object.entries(handlers))
      if (sql.includes(fragment)) return handler(values);
    throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
  }) as AlertSqlClient;
}

const alertInput = (overrides: Partial<AlertInput> = {}): AlertInput => ({
  workspaceId: WS,
  type: "canary_failed",
  resourceType: "canary_runs",
  resourceId: "run-1",
  reason: "boom",
  payload: { attempt: 3 },
  ...overrides,
});

describe("emitAlert", () => {
  const OLD_ENV = process.env;
  afterEach(() => {
    process.env = OLD_ENV;
    vi.restoreAllMocks();
  });

  it("inserts the alert row and writes an audit event, returning true", async () => {
    const seen: string[] = [];
    const client = makeClient({
      "insert into public.alert_log": () => [{ id: "alert-1" }],
      "insert into public.audit_events": (values) => {
        // values: workspaceId, action, resourceType, resourceId, reason, payload
        seen.push(String(values[1]));
        return [];
      },
    });
    process.env = { ...OLD_ENV, LEAD_ENGINE_ALERT_WEBHOOK_URL: "" };
    const created = await emitAlert(client, alertInput());
    expect(created).toBe(true);
    expect(seen).toContain("alert.canary_failed");
  });

  it("dedupes on the unique (alert_type, resource_id) key", async () => {
    const client = makeClient({
      "insert into public.alert_log": () => [],
    });
    process.env = { ...OLD_ENV };
    delete process.env.LEAD_ENGINE_ALERT_WEBHOOK_URL;
    const created = await emitAlert(client, alertInput());
    expect(created).toBe(false);
  });

  it("POSTs the webhook payload when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const client = makeClient({
      "insert into public.alert_log": () => [{ id: "alert-1" }],
      "insert into public.audit_events": () => [],
    });
    process.env = {
      ...OLD_ENV,
      LEAD_ENGINE_ALERT_WEBHOOK_URL: "https://hooks.example.com/le",
    };
    const created = await emitAlert(client, alertInput({ reason: "r" }));
    expect(created).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.example.com/le");
    const body = JSON.parse(String(init.body));
    expect(body.type).toBe("canary_failed");
    expect(body.workspaceId).toBe(WS);
    expect(body.reason).toBe("r");
    expect(body.at).toBeTruthy();
  });

  it("survives a failed webhook without throwing", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const client = makeClient({
      "insert into public.alert_log": () => [{ id: "alert-1" }],
      "insert into public.audit_events": () => [],
    });
    process.env = {
      ...OLD_ENV,
      LEAD_ENGINE_ALERT_WEBHOOK_URL: "https://hooks.example.com/le",
    };
    await expect(emitAlert(client, alertInput())).resolves.toBe(true);
  });
});

describe("checkCanaryAlerts", () => {
  it("alerts once per un-alerted failed canary run", async () => {
    const alerted = new Set<string>();
    const client = makeClient({
      "from public.canary_runs": () => [
        {
          id: "run-1",
          workspace_id: WS,
          failure_reason: "no qualified lead",
          completed_at: "2026-09-26T10:00:00Z",
        },
        {
          id: "run-2",
          workspace_id: WS,
          failure_reason: null,
          completed_at: null,
        },
      ],
      "insert into public.alert_log": (values) => {
        const type = String(values[1]);
        const resourceId = String(values[3]);
        const key = `${type}:${resourceId}`;
        if (alerted.has(key)) return [];
        alerted.add(key);
        return [{ id: `alert-${resourceId}` }];
      },
      "insert into public.audit_events": () => [],
    });
    const emitted = await checkCanaryAlerts(client);
    expect(emitted).toBe(2);
    // Second tick: both already alerted.
    const emittedAgain = await checkCanaryAlerts(client);
    expect(emittedAgain).toBe(0);
  });
});

describe("checkDeadLetterAlerts", () => {
  const OLD_ENV = process.env;
  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("alerts when the workspace breaches the threshold", async () => {
    process.env = {
      ...OLD_ENV,
      LEAD_ENGINE_DEAD_LETTER_ALERT_THRESHOLD: "2",
    };
    const client = makeClient({
      // Mirrors the SQL: the having clause filters before rows reach code.
      "from public.scrape_jobs": (values) =>
        3 >= Number(values[0]) ? [{ workspace_id: WS, recent_dead_letters: 3 }] : [],
      "insert into public.alert_log": () => [{ id: "alert-dl" }],
      "insert into public.audit_events": () => [],
    });
    const emitted = await checkDeadLetterAlerts(client);
    expect(emitted).toBe(1);
  });

  it("stays silent below the threshold", async () => {
    process.env = {
      ...OLD_ENV,
      LEAD_ENGINE_DEAD_LETTER_ALERT_THRESHOLD: "5",
    };
    // Mirrors the SQL: the having clause filters before rows reach code.
    const client = makeClient({
      "from public.scrape_jobs": (values) =>
        4 >= Number(values[0]) ? [{ workspace_id: WS, recent_dead_letters: 4 }] : [],
      "insert into public.alert_log": () => [{ id: "alert-dl" }],
      "insert into public.audit_events": () => [],
    });
    expect(await checkDeadLetterAlerts(client)).toBe(0);
  });

  it("defaults the threshold to 5 when unset or invalid", () => {
    process.env = { ...OLD_ENV };
    delete process.env.LEAD_ENGINE_DEAD_LETTER_ALERT_THRESHOLD;
    expect(deadLetterThreshold()).toBe(5);
    process.env = { ...OLD_ENV, LEAD_ENGINE_DEAD_LETTER_ALERT_THRESHOLD: "x" };
    expect(deadLetterThreshold()).toBe(5);
    process.env = { ...OLD_ENV, LEAD_ENGINE_DEAD_LETTER_ALERT_THRESHOLD: "0" };
    expect(deadLetterThreshold()).toBe(5);
  });
});
