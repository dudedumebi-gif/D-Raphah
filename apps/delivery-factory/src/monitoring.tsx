import { useCallback, useEffect, useRef, useState } from "react";
import { getAuthToken, notifyUnauthorized } from "./auth";

/* ── Monitoring view ────────────────────────────────────────────────────
 * Service liveness, readiness, handoff intake activity, feedback outbox
 * depth, and QStash schedule status. Polls every 30s.
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

interface ReadyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

interface HandoffRow {
  id: string;
  idempotencyKey: string;
  packageId: string;
  packageVersion: number;
  opportunityId: string;
  organizationName: string;
  status: string;
  receivedAt: string;
  projectId: string | null;
  projectStage: string | null;
}

interface MonitoringSnapshot {
  recentHandoffs: HandoffRow[];
  feedbackOutbox: { pending: number; dispatching: number; failed: number; sent: number };
  activeNonces: number;
  qstash: {
    configured: boolean;
    schedules: Array<{ name: string; cadence: string; route: string; status: string }>;
  };
  checkedAt: string;
}

async function fetchJson(url: string, timeoutMs = 12_000): Promise<{ ok: boolean; status: number; data: unknown; latencyMs: number }> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // Operator JWT for same-origin DF API calls only; the Lead Engine
    // health endpoints are cross-origin and stay unauthenticated.
    const headers: Record<string, string> = {};
    const token = getAuthToken();
    if (token && url.startsWith("/api/")) {
      headers.authorization = `Bearer ${token}`;
    }
    const res = await fetch(url, { signal: ctrl.signal, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && (res.status === 401 || res.status === 403) && url.startsWith("/api/")) {
      notifyUnauthorized();
    }
    return { ok: res.ok, status: res.status, data, latencyMs: Date.now() - started };
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
    { name: "Lead Engine", url: `${LEAD_ENGINE_BASE_URL}/api/health/live`, state: "loading", detail: "Checking…", latencyMs: null, checkedAt: null },
    { name: "Delivery Factory", url: "/api/health", state: "loading", detail: "Checking…", latencyMs: null, checkedAt: null },
  ]);
  const [readyChecks, setReadyChecks] = useState<ReadyCheck[] | null>(null);
  const [readyState, setReadyState] = useState<HealthState>("loading");
  const [readyDetail, setReadyDetail] = useState("Checking…");
  const [snapshot, setSnapshot] = useState<MonitoringSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
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

    // 2. Lead Engine readiness (configuration status).
    try {
      const ready = await fetchJson(`${LEAD_ENGINE_BASE_URL}/api/health/ready`);
      const data = (ready.data ?? {}) as Record<string, unknown>;
      const status = typeof data.status === "string" ? data.status : "unknown";
      const checksRaw = Array.isArray(data.checks) ? data.checks : [];
      const checks: ReadyCheck[] = checksRaw.map((c) => {
        const r = c as Record<string, unknown>;
        return {
          name: String(r.name ?? r.check ?? "check"),
          ok: r.ok === true || r.status === "ok" || r.status === "pass",
          detail: typeof r.detail === "string" ? r.detail : typeof r.error === "string" ? r.error : undefined,
        };
      });
      setReadyChecks(checks.length > 0 ? checks : null);
      if (status === "ready" || status === "ok") {
        setReadyState("up");
        setReadyDetail("Ready — all configuration checks pass");
      } else if (status === "not_ready" || status === "degraded") {
        setReadyState("degraded");
        const missing = checks.filter((c) => !c.ok).map((c) => c.name);
        setReadyDetail(
          missing.length > 0 ? `Not ready: ${missing.join(", ")}` : `Not ready (HTTP ${ready.status})`,
        );
      } else {
        setReadyState(ready.ok ? "up" : "down");
        setReadyDetail(`HTTP ${ready.status}`);
      }
    } catch {
      setReadyState("down");
      setReadyDetail("Unreachable");
      setReadyChecks(null);
    }

    // 3. Delivery Factory monitoring snapshot (handoffs, outbox, qstash).
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
  const outboxTotal = outbox ? outbox.pending + outbox.dispatching + outbox.failed : 0;

  return (
    <div className="mon-section">
      <div className="mon-head">
        <div>
          <h2>Service monitoring</h2>
          <p>
            Liveness, readiness, and handoff pipeline health across the Lead
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

      {/* Service liveness */}
      <div className="mon-grid">
        {services.map((s) => (
          <div className="mon-card" key={s.name}>
            <div className="mon-card-top">
              <span className={stateDot(s.state)} />
              <strong>{s.name}</strong>
              <span className="mon-state">{s.state.toUpperCase()}</span>
            </div>
            <div className="mon-detail">{s.detail}</div>
            <div className="mon-meta">
              <span>{s.latencyMs !== null ? `${s.latencyMs} ms` : "—"}</span>
              <span>checked {formatTime(s.checkedAt)}</span>
            </div>
            <div className="mon-url">{s.url}</div>
          </div>
        ))}

        {/* Lead Engine readiness */}
        <div className="mon-card">
          <div className="mon-card-top">
            <span className={stateDot(readyState)} />
            <strong>Lead Engine readiness</strong>
            <span className="mon-state">{readyState.toUpperCase()}</span>
          </div>
          <div className="mon-detail">{readyDetail}</div>
          {readyChecks && readyChecks.length > 0 ? (
            <ul className="mon-checks">
              {readyChecks.map((c) => (
                <li key={c.name} className={c.ok ? "ok" : "bad"}>
                  <span>{c.ok ? "✓" : "✗"}</span> {c.name}
                  {c.detail ? <small> — {c.detail}</small> : null}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mon-url">{LEAD_ENGINE_BASE_URL}/api/health/ready</div>
        </div>

        {/* Feedback outbox */}
        <div className="mon-card">
          <div className="mon-card-top">
            <span className={stateDot(snapshot ? (outboxTotal > 0 || (outbox?.failed ?? 0) > 0 ? "degraded" : "up") : "unknown")} />
            <strong>Feedback outbox</strong>
            <span className="mon-state">
              {snapshot ? `${outboxTotal} QUEUED` : "UNKNOWN"}
            </span>
          </div>
          {snapshot && outbox ? (
            <div className="mon-queue">
              <div><b>{outbox.pending}</b><span>pending</span></div>
              <div><b>{outbox.dispatching}</b><span>dispatching</span></div>
              <div className={outbox.failed > 0 ? "bad" : ""}><b>{outbox.failed}</b><span>failed</span></div>
              <div><b>{outbox.sent}</b><span>sent</span></div>
            </div>
          ) : (
            <div className="mon-detail">{snapshotError ?? "Loading…"}</div>
          )}
          <div className="mon-meta">
            <span>active nonces: {snapshot ? snapshot.activeNonces : "—"}</span>
          </div>
        </div>

        {/* QStash schedules */}
        <div className="mon-card">
          <div className="mon-card-top">
            <span className={stateDot(snapshot ? (snapshot.qstash.configured ? "up" : "degraded") : "unknown")} />
            <strong>QStash schedules</strong>
            <span className="mon-state">
              {snapshot ? (snapshot.qstash.configured ? "CONFIGURED" : "NOT CONFIGURED") : "UNKNOWN"}
            </span>
          </div>
          {snapshot ? (
            <ul className="mon-checks">
              {snapshot.qstash.schedules.map((s) => (
                <li key={s.name} className={s.status === "configured" ? "ok" : "bad"}>
                  <span>{s.status === "configured" ? "✓" : "✗"}</span> {s.name}
                  <small> — {s.cadence} · {s.route}</small>
                </li>
              ))}
              <li className="note">
                Lead Engine schedules (worker tick, canary) are managed on the
                Lead Engine side.
              </li>
            </ul>
          ) : (
            <div className="mon-detail">{snapshotError ?? "Loading…"}</div>
          )}
        </div>
      </div>

      {/* Recent handoffs */}
      <div className="mon-panel">
        <div className="mon-panel-head">
          <h3>Recent handoff packages received</h3>
          {snapshot ? (
            <span className="mon-poll">as of {formatTime(snapshot.checkedAt)}</span>
          ) : null}
        </div>
        {snapshotError && !snapshot ? (
          <div className="mon-empty">Could not load handoff activity: {snapshotError}</div>
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
                  </td>
                  <td>
                    {h.projectId ? (
                      <span>
                        <code>{shortId(h.projectId)}</code>
                        {h.projectStage ? <small> · {h.projectStage}</small> : null}
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
    </div>
  );
}
