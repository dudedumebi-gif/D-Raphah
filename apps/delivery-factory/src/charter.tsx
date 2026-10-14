import { useCallback, useEffect, useState } from "react";
import { getAuthToken, notifyUnauthorized } from "./auth";
import "./charter.css";

/* ── Project charter (Phase 1) ─────────────────────────────────────────
 * The charter is the handoff package presented as the project's founding
 * document — problem statement, current state and pain points, the
 * requirement baseline with acceptance criteria, feature outcomes,
 * commercial scope, constraints, risks, open items, and LE provenance —
 * plus the KPIs restated from the package's success measures, with
 * post-build verification. DF renders what LE shipped; it authors
 * nothing here except verification verdicts.
 */

interface CharterKpi {
  id: string;
  metric: string;
  target: string;
  measurement: string;
  status: "pending" | "met" | "missed";
  measured_value: string | null;
  verify_note: string | null;
  verified_by: string | null;
  verified_at: string | null;
}

interface CharterData {
  project: {
    id: string;
    name: string | null;
    organizationName: string;
    status: string;
    currentStage: string;
    environment: string;
    createdAt: string;
  };
  provenance: {
    packageId: string;
    packageVersion: number;
    opportunityId: string;
    approvedBy: string | null;
    approvedAt: string | null;
    manifestChecksum: string | null;
    receivedAt: string | null;
  };
  problemStatement: string | null;
  currentState: Array<{
    processName: string;
    owner?: string;
    painPoint: string;
  }>;
  requirements: Array<{
    id: string;
    code: string;
    statement: string;
    priority: string;
    status: string;
    acceptanceCriteria: string[];
  }>;
  features: Array<{
    id: string;
    code: string;
    name: string;
    userOutcome: string;
  }>;
  constraints: Array<{ description: string; category: string }>;
  risksAndAssumptions: Array<{
    description: string;
    type: string;
    impact: string;
  }>;
  openItems: Array<{ description: string; owner: string; dueDate?: string }>;
  commercialScope: {
    scopeSummary: string;
    estimatedValueCad?: number;
    timelineWeeks?: number;
  } | null;
  consentBasis: {
    basisType: string;
    recordedAt: string;
    recordedBy: string;
    notes?: string;
  } | null;
  kpis: CharterKpi[];
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const token = getAuthToken();
  if (token && path.startsWith("/api/")) {
    headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(path, { ...init, headers });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) notifyUnauthorized(res.status);
    throw new Error(
      typeof data.error === "string" ? data.error : `Request failed (${res.status})`,
    );
  }
  return data as T;
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="charter-section">
      <h4>{props.title}</h4>
      {props.children}
    </section>
  );
}

function Empty() {
  return <p className="muted">Not in the handoff package.</p>;
}

function KpiCard(props: {
  kpi: CharterKpi;
  projectId: string;
  onVerified: (kpi: CharterKpi) => void;
}) {
  const { kpi } = props;
  const [open, setOpen] = useState(false);
  const [measuredValue, setMeasuredValue] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (status: "met" | "missed") => {
    setBusy(true);
    setError(null);
    try {
      const d = await api<{ kpi: CharterKpi }>(
        `/api/projects/${props.projectId}/kpis/${kpi.id}/verify`,
        {
          method: "POST",
          body: JSON.stringify({
            status,
            measuredValue: measuredValue.trim() || undefined,
            note: note.trim() || undefined,
          }),
        },
      );
      props.onVerified(d.kpi);
      setOpen(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kpi-card">
      <div className="kpi-head">
        <b>{kpi.metric}</b>
        <span className={`kpi-status kpi-${kpi.status}`}>{kpi.status}</span>
      </div>
      <p className="kpi-target">Target: {kpi.target}</p>
      <p className="muted kpi-measurement">{kpi.measurement}</p>
      {kpi.status !== "pending" ? (
        <p className="kpi-verdict">
          Measured: {kpi.measured_value ?? "—"}
          {kpi.verify_note ? <> · {kpi.verify_note}</> : null}
          <br />
          <small>
            Verified by {kpi.verified_by ?? "—"}
            {kpi.verified_at
              ? ` · ${new Date(kpi.verified_at).toLocaleString()}`
              : ""}
          </small>
        </p>
      ) : null}
      {error ? <p className="wf-error">{error}</p> : null}
      {open ? (
        <div className="kpi-form">
          <label>
            Measured value
            <input
              value={measuredValue}
              onChange={(e) => setMeasuredValue(e.target.value)}
              placeholder="e.g. Median draft time 3.8 minutes over 42 runs"
            />
          </label>
          <label>
            Evidence note
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Where the measurement came from"
            />
          </label>
          <div className="kpi-form-actions">
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => void submit("met")}
            >
              Mark met
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => void submit("missed")}
            >
              Mark missed
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setOpen(true)}
        >
          {kpi.status === "pending" ? "Verify KPI" : "Re-verify"}
        </button>
      )}
    </div>
  );
}

interface BeginState {
  stage: string;
  environment: string;
  publishedWorkflows: Array<{ id: string; name: string }>;
}

interface BeginResult {
  workflowId: string;
  workflowName: string;
  runId: string;
  stage: string;
  alreadyStarted: boolean;
}

/* ── Delivery workflow (manual begin) ────────────────────────────────
 * Packages are offered to published lead-handoff workflows at intake;
 * when none was published in this environment then, nothing started
 * and the project waits at 'intake'. This section is the manual
 * start: pick the published lead-handoff workflow and run it against
 * the project's package. Runs stay draft-first — viewing a run lives
 * under Workflows, where each workflow's Runs tab lists its runs.
 */
function BeginWorkflowSection(props: {
  projectId: string;
  onBegan: () => void;
}) {
  const [state, setState] = useState<BeginState | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<BeginResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<BeginState>(`/api/projects/${props.projectId}/begin`)
      .then((d) => {
        if (cancelled) return;
        setState(d);
        setSelected(d.publishedWorkflows[0]?.id ?? "");
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(
            e instanceof Error ? e.message : "Failed to load workflow state",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [props.projectId]);

  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<BeginResult>(
        `/api/projects/${props.projectId}/begin`,
        {
          method: "POST",
          body: JSON.stringify(selected ? { workflowId: selected } : {}),
        },
      );
      setDone(result);
      setState((current) =>
        current ? { ...current, stage: result.stage } : current,
      );
      props.onBegan();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to begin workflow");
    } finally {
      setBusy(false);
    }
  };

  const workflows = state?.publishedWorkflows ?? [];
  const stage = state?.stage ?? "…";

  return (
    <div className="charter-section charter-wide">
      <h4>Delivery workflow</h4>
      {error ? <p className="wf-error">{error}</p> : null}
      {!state && !error ? <p className="muted">Loading…</p> : null}
      {state ? (
        <>
          <p>
            Project stage: <b>{stage}</b> · {state.environment} environment
          </p>
          {done ? (
            <p className="begin-done">
              ✓ Workflow “{done.workflowName}”{" "}
              {done.alreadyStarted
                ? "was already started when this package arrived"
                : "started"}{" "}
              — run <code>{done.runId.slice(0, 8)}…</code>. View the run
              under Workflows → {done.workflowName} → Runs. The project
              advanced to stage <b>{done.stage}</b>.
            </p>
          ) : workflows.length === 0 ? (
            <p className="muted">
              No lead-handoff workflow is published in this environment
              yet, so nothing started when this package arrived. Publish
              one under Workflows / Automations — new packages will then
              be offered to it automatically at intake, and it can be
              started here manually.
            </p>
          ) : (
            <>
              <div className="begin-row">
                {workflows.length > 1 ? (
                  <select
                    className="begin-select"
                    value={selected}
                    onChange={(e) => setSelected(e.target.value)}
                    disabled={busy || stage !== "intake"}
                  >
                    {workflows.map((wf) => (
                      <option key={wf.id} value={wf.id}>
                        {wf.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span>
                    Workflow: <b>{workflows[0].name}</b>
                  </span>
                )}
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy || stage !== "intake"}
                  onClick={() => void begin()}
                >
                  {busy ? "Starting…" : "Begin workflow"}
                </button>
              </div>
              {stage !== "intake" ? (
                <p className="muted">
                  Beginning is available while the project is at the
                  intake stage; this project has already moved on.
                </p>
              ) : (
                <p className="muted">
                  Runs the workflow against this project's handoff
                  package, draft-first — sends are recorded as drafts
                  for human approval. The project advances to onboarding.
                </p>
              )}
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

export function CharterPanel(props: {
  projectId: string;
  onClose: () => void;
}) {
  const [charter, setCharter] = useState<CharterData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<{ charter: CharterData }>(
        `/api/projects/${props.projectId}/charter`,
      );
      setCharter(d.charter);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load charter");
    }
  }, [props.projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onVerified = useCallback((updated: CharterKpi) => {
    setCharter((current) =>
      current
        ? {
            ...current,
            kpis: current.kpis.map((k) => (k.id === updated.id ? updated : k)),
          }
        : current,
    );
  }, []);

  return (
    <div className="charter-panel">
      <div className="charter-head">
        <div>
          <p className="eyebrow accent">Project charter</p>
          <h3>
            {charter
              ? `${charter.project.organizationName} — ${charter.project.name ?? "Delivery project"}`
              : "Loading charter…"}
          </h3>
          {charter ? (
            <p className="muted">
              Stage {charter.project.currentStage} ·{" "}
              {charter.project.environment} environment · Package v
              {charter.provenance.packageVersion}
              {charter.provenance.approvedBy
                ? ` · Approved in Lead Engine by ${charter.provenance.approvedBy}`
                : ""}
              {charter.provenance.approvedAt
                ? ` on ${new Date(charter.provenance.approvedAt).toLocaleDateString()}`
                : ""}
              {charter.provenance.manifestChecksum
                ? ` · Checksum ${charter.provenance.manifestChecksum.slice(0, 12)}…`
                : ""}
            </p>
          ) : null}
        </div>
        <button type="button" className="btn-ghost" onClick={props.onClose}>
          Close
        </button>
      </div>
      {error ? <p className="wf-error">{error}</p> : null}
      {charter ? (
        <div className="charter-grid">
          <BeginWorkflowSection
            projectId={props.projectId}
            onBegan={() => void load()}
          />
          <Section title="Problem / opportunity">
            {charter.problemStatement ? (
              <p>{charter.problemStatement}</p>
            ) : (
              <Empty />
            )}
          </Section>
          <Section title="Current state — the manual process">
            {charter.currentState.length ? (
              <ul className="charter-list">
                {charter.currentState.map((cs, i) => (
                  <li key={i}>
                    <b>{cs.processName}</b>
                    {cs.owner ? <span className="muted"> · {cs.owner}</span> : null}
                    <br />
                    <span className="muted">Pain point: {cs.painPoint}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty />
            )}
          </Section>
          <Section title="Requirements & acceptance criteria">
            {charter.requirements.length ? (
              <ul className="charter-list">
                {charter.requirements.map((r) => (
                  <li key={r.id}>
                    <b>
                      {r.code} · {r.priority} · {r.status}
                    </b>
                    <br />
                    {r.statement}
                    {r.acceptanceCriteria.length ? (
                      <ul className="charter-sublist">
                        {r.acceptanceCriteria.map((c, i) => (
                          <li key={i}>✓ {c}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty />
            )}
          </Section>
          <Section title="What is being built">
            {charter.features.length ? (
              <ul className="charter-list">
                {charter.features.map((f) => (
                  <li key={f.id}>
                    <b>
                      {f.code} · {f.name}
                    </b>
                    <br />
                    <span className="muted">Outcome: {f.userOutcome}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty />
            )}
          </Section>
          <div className="charter-section charter-wide">
            <h4>Success measures — KPIs to verify after build</h4>
            {charter.kpis.length ? (
              <div className="kpi-grid">
                {charter.kpis.map((kpi) => (
                  <KpiCard
                    key={kpi.id}
                    kpi={kpi}
                    projectId={props.projectId}
                    onVerified={onVerified}
                  />
                ))}
              </div>
            ) : (
              <Empty />
            )}
          </div>
          <Section title="Constraints">
            {charter.constraints.length ? (
              <ul className="charter-list">
                {charter.constraints.map((c, i) => (
                  <li key={i}>
                    {c.description}{" "}
                    <span className="muted">({c.category})</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty />
            )}
          </Section>
          <Section title="Risks & assumptions">
            {charter.risksAndAssumptions.length ? (
              <ul className="charter-list">
                {charter.risksAndAssumptions.map((r, i) => (
                  <li key={i}>
                    <b>{r.type}</b> · {r.description}{" "}
                    <span className="muted">(impact: {r.impact})</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty />
            )}
          </Section>
          <Section title="Open items">
            {charter.openItems.length ? (
              <ul className="charter-list">
                {charter.openItems.map((o, i) => (
                  <li key={i}>
                    {o.description} <span className="muted">· {o.owner}</span>
                    {o.dueDate ? (
                      <span className="muted"> · due {o.dueDate}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty />
            )}
          </Section>
          <Section title="Commercial scope">
            {charter.commercialScope ? (
              <p>
                {charter.commercialScope.scopeSummary}
                {charter.commercialScope.estimatedValueCad != null ? (
                  <>
                    <br />
                    <span className="muted">
                      Estimated value: CAD{" "}
                      {charter.commercialScope.estimatedValueCad.toLocaleString()}
                    </span>
                  </>
                ) : null}
                {charter.commercialScope.timelineWeeks != null ? (
                  <>
                    <br />
                    <span className="muted">
                      Timeline: {charter.commercialScope.timelineWeeks} weeks
                    </span>
                  </>
                ) : null}
              </p>
            ) : (
              <Empty />
            )}
            {charter.consentBasis ? (
              <p className="muted">
                Outreach basis (CASL): {charter.consentBasis.basisType},
                recorded by {charter.consentBasis.recordedBy} on{" "}
                {new Date(charter.consentBasis.recordedAt).toLocaleDateString()}
                . Recording a basis never authorizes sending — outreach
                stays draft-first.
              </p>
            ) : null}
          </Section>
        </div>
      ) : null}
    </div>
  );
}
