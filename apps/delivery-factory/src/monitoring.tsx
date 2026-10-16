import { useCallback, useEffect, useRef, useState } from "react";
import { getAuthToken, notifyUnauthorized } from "./auth";
import { CharterPanel } from "./charter";

/* ── Monitoring view ────────────────────────────────────────────────────
 * One status strip (Lead Engine alive · Delivery Factory ready ·
 * feedback outbox depth) over the handoff intake table. Polls every 30s.
 */

const LEAD_ENGINE_BASE_URL =
  (import.meta.env.VITE_LEAD_ENGINE_BASE_URL as string | undefined) ||
  "https://d-raphah-leads-engine.vercel.app";

const POLL_MS = 30_000;

type HealthState = "up" | "down" | "degraded" | "loading" | "unknown";

interface ServiceStatus {
  name: string;
  url: string;
  state: HealthState;
  detail: string;
  latencyMs: number | null;
  checkedAt: string | null;
}

interface HandoffRow {
  id: string;
  idempotencyKey: string;
  packageId: string;
  packageVersion: number;
  opportunityId: string;
  organizationName: string;
  status: string;
  environment: string;
  receivedAt: string;
  projectId: string | null;
  projectStage: string | null;
}

interface MonitoringSnapshot {
  recentHandoffs: HandoffRow[];
  feedbackOutbox: {
    pending: number;
    dispatching: number;
    failed: number;
    sent: number;
  };
  activeNonces: number;
  checkedAt: string;
}

async function fetchJson(
  url: string,
  timeoutMs = 12_000,
): Promise<{ ok: boolean; status: number; data: unknown; latencyMs: number }> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // Operator session token for same-origin DF API calls only; the Lead Engine
    // health endpoints are cross-origin and stay unauthenticated.
    const headers: Record<string, string> = {};
    const token = getAuthToken();
    if (token && url.startsWith("/api/")) {
      headers.authorization = `Bearer ${token}`;
    }
    const res = await fetch(url, { signal: ctrl.signal, headers });
    const data = await res.json().catch(() => ({}));
    if (
      !res.ok &&
      (res.status === 401 || res.status === 403) &&
      url.startsWith("/api/")
    ) {
      notifyUnauthorized(res.status);
    }
    return {
      ok: res.ok,
      status: res.status,
      data,
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

function stateDot(state: HealthState): string {
  switch (state) {
    case "up":
      return "mon-dot up";
    case "degraded":
      return "mon-dot degraded";
    case "down":
      return "mon-dot down";
    default:
      return "mon-dot unknown";
  }
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString([], { hour12: false });
  } catch {
    return iso;
  }
}

function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…` : id;
}

export function MonitoringSection() {
  const [services, setServices] = useState<ServiceStatus[]>([
    {
      name: "Lead Engine",
      url: `${LEAD_ENGINE_BASE_URL}/api/health/live`,
      state: "loading",
      detail: "Checking…",
      latencyMs: null,
      checkedAt: null,
    },
    {
      name: "Delivery Factory",
      url: "/api/health",
      state: "loading",
      detail: "Checking…",
      latencyMs: null,
      checkedAt: null,
    },
  ]);
  const [readyState, setReadyState] = useState<HealthState>("loading");
  const [readyDetail, setReadyDetail] = useState("Checking…");
  const [snapshot, setSnapshot] = useState<MonitoringSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [charterProjectId, setCharterProjectId] = useState<string | null>(null);
  const [lastPoll, setLastPoll] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const poll = useCallback(async () => {
    const now = new Date().toISOString();

    // 1. Liveness probes (both services, in parallel).
    const [leLive, dfHealth] = await Promise.all([
      fetchJson(`${LEAD_ENGINE_BASE_URL}/api/health/live`).catch(() => null),
      fetchJson("/api/health").catch(() => null),
    ]);

    const nextServices: ServiceStatus[] = [
      {
        name: "Lead Engine",
        url: `${LEAD_ENGINE_BASE_URL}/api/health/live`,
        state: !leLive ? "down" : leLive.ok ? "up" : "down",
        detail: !leLive
          ? "Unreachable"
          : leLive.ok
            ? `Live · HTTP ${leLive.status}`
            : `HTTP ${leLive.status}`,
        latencyMs: leLive?.latencyMs ?? null,
        checkedAt: now,
      },
      {
        name: "Delivery Factory",
        url: "/api/health",
        state: !dfHealth ? "down" : dfHealth.ok ? "up" : "down",
        detail: !dfHealth
          ? "Unreachable"
          : dfHealth.ok
            ? `Healthy · HTTP ${dfHealth.status}`
            : `HTTP ${dfHealth.status}`,
        latencyMs: dfHealth?.latencyMs ?? null,
        checkedAt: now,
      },
    ];
    setServices(nextServices);

    // 2. Independent readiness probes for both products.
    try {
      const [leadReady, deliveryReady] = await Promise.all([
        fetchJson(`${LEAD_ENGINE_BASE_URL}/api/health/ready`),
        fetchJson("/api/ready"),
      ]);
      const normalize = (
        prefix: string,
        payload: unknown,
      ): Array<{ name: string; ok: boolean }> => {
        const data = (payload ?? {}) as Record<string, unknown>;
        const rows = Array.isArray(data.checks) ? data.checks : [];
        return rows.map((c) => {
          const r = c as Record<string, unknown>;
          return {
            name: `${prefix}: ${String(r.name ?? r.check ?? "check")}`,
            ok: r.ok === true || r.status === "ok" || r.status === "pass",
            detail:
              typeof r.detail === "string"
                ? r.detail
                : typeof r.error === "string"
                  ? r.error
                  : undefined,
          };
        });
      };
      const checks = [
        ...normalize("Lead Engine", leadReady.data),
        ...normalize("Delivery Factory", deliveryReady.data),
      ];
      if (
        leadReady.ok &&
        deliveryReady.ok &&
        checks.every((check) => check.ok)
      ) {
        setReadyState("up");
        setReadyDetail("Both products ready — all configuration checks pass");
      } else {
        setReadyState("degraded");
        const missing = checks.filter((c) => !c.ok).map((c) => c.name);
        setReadyDetail(
          missing.length > 0
            ? `Not ready: ${missing.join(", ")}`
            : `Readiness HTTP ${leadReady.status}/${deliveryReady.status}`,
        );
      }
    } catch {
      setReadyState("down");
      setReadyDetail("Unreachable");
    }

    // 3. Delivery Factory monitoring snapshot (handoffs, outbox).
    try {
      const snap = await fetchJson("/api/monitoring");
      if (snap.ok) {
        setSnapshot(snap.data as MonitoringSnapshot);
        setSnapshotError(null);
      } else {
        setSnapshotError(`HTTP ${snap.status}`);
      }
    } catch (err) {
      setSnapshotError(err instanceof Error ? err.message : "Unreachable");
    }

    setLastPoll(now);
  }, []);

  useEffect(() => {
    poll();
    timerRef.current = window.setInterval(poll, POLL_MS);
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, [poll]);

  const outbox = snapshot?.feedbackOutbox;
  const outboxTotal = outbox
    ? outbox.pending + outbox.dispatching + outbox.failed
    : 0;

  return (
    <div className="mon-section">
      <div className="mon-head">
        <div>
          <h2>Service monitoring</h2>
          <p>
            Service status and handoff pipeline health across the Lead
            Engine and Delivery Factory. Polls every 30s.
          </p>
        </div>
        <div className="mon-head-right">
          <span className="mon-poll">
            Last poll: {lastPoll ? formatTime(lastPoll) : "—"}
          </span>
          <button className="mon-refresh" onClick={poll}>
            Refresh now
          </button>
        </div>
      </div>

      {/* Status strip: LE alive · DF ready · feedback outbox depth */}
      <div className="mon-strip">
        <div className="mon-strip-item">
          <span className={stateDot(services[0]?.state ?? "loading")} />
          <strong>Lead Engine</strong>
          <span className="mon-state">
            {services[0]?.state === "up"
              ? "ALIVE"
              : (services[0]?.state ?? "loading").toUpperCase()}
          </span>
          <span className="mon-strip-detail">
            {services[0]?.latencyMs != null
              ? `${services[0].latencyMs} ms`
              : (services[0]?.detail ?? "Checking…")}
          </span>
        </div>
        <div className="mon-strip-item">
          <span className={stateDot(readyState)} />
          <strong>Delivery Factory</strong>
          <span className="mon-state">
            {readyState === "up"
              ? "READY"
              : readyState.toUpperCase()}
          </span>
          <span className="mon-strip-detail">{readyDetail}</span>
        </div>
        <div className="mon-strip-item">
          <span
            className={stateDot(
              snapshot
                ? outboxTotal > 0 || (outbox?.failed ?? 0) > 0
                  ? "degraded"
                  : "up"
                : "unknown",
            )}
          />
          <strong>Feedback outbox</strong>
          <span className="mon-state">
            {snapshot ? `${outboxTotal} QUEUED` : "UNKNOWN"}
          </span>
          <span className="mon-strip-detail">
            {snapshot && outbox
              ? `${outbox.pending} pending · ${outbox.dispatching} dispatching · ${outbox.failed} failed · ${outbox.sent} sent · ${snapshot.activeNonces} active nonces`
              : (snapshotError ?? "Loading…")}
          </span>
        </div>
      </div>

      {/* Recent handoffs */}
      <div className="mon-panel">
        <div className="mon-panel-head">
          <h3>Intake — handoff packages received</h3>
          {snapshot ? (
            <span className="mon-poll">
              as of {formatTime(snapshot.checkedAt)}
            </span>
          ) : null}
        </div>
        <p className="mon-explainer">
          Packages the Lead Engine sent and this Delivery Factory accepted.
          Open a project's <b>Charter</b> to review its baseline and verify
          its KPIs after build.
        </p>
        {snapshotError && !snapshot ? (
          <div className="mon-empty">
            Could not load handoff activity: {snapshotError}
          </div>
        ) : !snapshot || snapshot.recentHandoffs.length === 0 ? (
          <div className="mon-empty">
            No handoff packages received yet. Packages sent by the Lead Engine
            appear here once accepted by <code>/api/intake</code>.
          </div>
        ) : (
          <table className="mon-table">
            <thead>
              <tr>
                <th>Received</th>
                <th>Organization</th>
                <th>Package</th>
                <th>Status</th>
                <th>Project</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.recentHandoffs.map((h) => (
                <tr key={h.id}>
                  <td>{formatTime(h.receivedAt)}</td>
                  <td>{h.organizationName || "—"}</td>
                  <td>
                    <code>{shortId(h.packageId)}</code>
                    <small> v{h.packageVersion}</small>
                  </td>
                  <td>
                    <span className={`mon-pill ${h.status}`}>{h.status}</span>
                    <small> · {h.environment}</small>
                  </td>
                  <td>
                    {h.projectId ? (
                      <span>
                        <code>{shortId(h.projectId)}</code>
                        {h.projectStage ? (
                          <small> · {h.projectStage}</small>
                        ) : null}
                        <button
                          type="button"
                          className="mon-charter-btn"
                          onClick={() => setCharterProjectId(h.projectId)}
                        >
                          Charter
                        </button>
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {charterProjectId ? (
        <CharterPanel
          projectId={charterProjectId}
          onClose={() => setCharterProjectId(null)}
        />
      ) : null}
    </div>
  );
}
