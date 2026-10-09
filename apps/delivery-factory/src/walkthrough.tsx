import { useCallback, useEffect, useMemo, useState } from "react";
import { getAuthToken, notifyUnauthorized } from "./auth";
import "./walkthrough.css";

/* ── Demo walkthrough mode (Phase 3) ───────────────────────────────────
 * A client-presentable story, run live inside the demo environment:
 * a real-shaped case (the manual process a handoff package would carry
 * as currentState) is executed against a published demo workflow on the
 * real engine. The player then walks the recorded run step by step —
 * the manual way versus the automated way, the actual output produced,
 * and the human approval points (draft-first throughout, so nothing
 * sends in front of a client). It ends on the run's audit trail and a
 * time-saved summary tied to the case's success measures.
 */

interface RunStep {
  node_key: string;
  node_kind: string;
  node_label: string;
  status: string;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

interface WorkflowRun {
  id: string;
  status: string;
  trigger_type: string;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  steps?: RunStep[];
}

interface WorkflowSummary {
  id: string;
  name: string;
  status: string;
  environment: string;
  trigger_type: string;
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

/* The sample case: shaped like a handoff package's problem + currentState. */
const DEMO_CASE = {
  business: "Harbourview Dental Studio",
  location: "Toronto",
  leadName: "Maya Chen",
  channel: "Website contact form",
  inquiry:
    "Hi — do you have any hygiene appointments next week? I work weekdays, so an evening slot would be ideal. Thanks!",
  problem:
    "New-patient inquiries arrive by web form and email. The front desk checks twice a day, copies the details into a spreadsheet, and drafts every reply from scratch. Replies typically land the next day — and some inquiries are never answered at all.",
  input: {
    organization_name: "Harbourview Dental Studio",
    lead: { name: "Maya Chen", phone: "+1 416-555-0134", score: 87 },
  },
  manualSteps: [
    {
      title: "Notice the inquiry",
      minutes: 240,
      wait: true,
      text: "Waits in the inbox until the front desk's next check — twice a day. Average wait: about 4 hours, often overnight.",
    },
    {
      title: "Copy details into the tracker",
      minutes: 10,
      text: "Name, phone, and request re-keyed into a spreadsheet by hand.",
      eliminated: true,
    },
    {
      title: "Draft the reply from scratch",
      minutes: 15,
      text: "Staff write each response from a blank page, checking the schedule manually first.",
    },
    {
      title: "Chase approval, then send",
      minutes: 20,
      text: "The draft is forwarded to the office manager; it sends only after approval comes back.",
    },
    {
      title: "Log the follow-up",
      minutes: 5,
      text: "The spreadsheet is updated by hand — when someone remembers.",
    },
  ] as Array<{
    title: string;
    minutes: number;
    text: string;
    eliminated?: boolean;
    wait?: boolean;
  }>,
  successMeasures: [
    "First follow-up draft within 5 minutes of intake",
    "Zero inquiries left unanswered",
    "Every follow-up leaves an audit record",
  ],
};

const MANUAL_BY_KIND: Record<string, number> = {
  lead_handoff: 0,
  trigger: 0,
  condition: 1,
  ai_assist: 2,
  send_sms: 3,
  send_email: 3,
  log_database: 4,
};

const AUTOMATED_NARRATION: Record<string, string> = {
  lead_handoff:
    "The inquiry lands and the automation starts immediately — no inbox waiting, no twice-a-day checks.",
  trigger:
    "The event lands and the automation starts immediately — no inbox waiting.",
  condition:
    "The lead is routed on its data instantly — here, a qualification score of 87 against the workflow's threshold.",
  ai_assist:
    "The AI drafts the follow-up from the inquiry and the practice's context. It produces a draft only — drafting is its whole job.",
  send_sms:
    "The message is prepared as a send-ready draft and held. Nothing is sent: a human approves first, every time.",
  send_email:
    "The email is prepared as a send-ready draft and held for human approval — nothing auto-sends.",
  log_database:
    "The run writes its own audit record — what happened, when, and what it produced — with no spreadsheet to remember.",
};

const APPROVAL_KINDS = new Set(["ai_assist", "send_sms", "send_email"]);

function outputHighlights(
  output: Record<string, unknown> | null,
): Array<[string, string]> {
  if (!output) return [];
  const preferred = ["draft", "message", "text", "body", "subject", "status", "to", "channel"];
  const entries: Array<[string, string]> = [];
  const push = (key: string) => {
    const value = output[key];
    if (typeof value === "string" && value) entries.push([key, value]);
    else if (typeof value === "number" || typeof value === "boolean")
      entries.push([key, String(value)]);
  };
  for (const key of preferred) if (key in output) push(key);
  for (const key of Object.keys(output)) {
    if (entries.length >= 5) break;
    if (!preferred.includes(key)) push(key);
  }
  return entries;
}

function runSeconds(run: WorkflowRun): number | null {
  if (!run.completed_at) return null;
  const ms =
    new Date(run.completed_at).getTime() - new Date(run.started_at).getTime();
  return Number.isFinite(ms) ? Math.max(0, ms / 1000) : null;
}

export function WalkthroughView({ onClose }: { onClose: () => void }) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [showFinale, setShowFinale] = useState(false);

  useEffect(() => {
    api<{ workflows: WorkflowSummary[] }>("/api/workflows?environment=demo")
      .then((d) => {
        const published = d.workflows.filter((w) => w.status === "published");
        setWorkflows(published);
        const preferred =
          published.find((w) => /lead follow-up/i.test(w.name)) ?? published[0];
        if (preferred) setSelectedId(preferred.id);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load workflows"),
      )
      .finally(() => setLoading(false));
  }, []);

  const selected = workflows.find((w) => w.id === selectedId);
  const steps = useMemo(() => run?.steps ?? [], [run]);
  const manualTotal = DEMO_CASE.manualSteps.reduce(
    (sum, s) => sum + s.minutes,
    0,
  );
  const handsOn = DEMO_CASE.manualSteps
    .filter((s) => !("wait" in s && s.wait))
    .reduce((sum, s) => sum + s.minutes, 0);
  const seconds = run ? runSeconds(run) : null;

  const execute = useCallback(async () => {
    if (!selectedId) return;
    setRunning(true);
    setError(null);
    setRun(null);
    setShowFinale(false);
    setStepIndex(0);
    try {
      const started = await api<{ run: WorkflowRun }>(
        `/api/workflows/${selectedId}/execute`,
        {
          method: "POST",
          body: JSON.stringify({ input: DEMO_CASE.input }),
        },
      );
      const detail = await api<{ run: WorkflowRun }>(
        `/api/workflows/runs/${started.run.id}`,
      );
      setRun(detail.run);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }, [selectedId]);

  const step = steps[stepIndex];
  const manual =
    step != null
      ? DEMO_CASE.manualSteps[
          MANUAL_BY_KIND[step.node_kind] ?? Math.min(stepIndex, DEMO_CASE.manualSteps.length - 1)
        ]
      : null;

  return (
    <div className="wt">
      <div className="wt-head">
        <div>
          <p className="eyebrow accent">Demo walkthrough · Demo environment</p>
          <h2>The manual process, automated — live</h2>
          <p className="muted">
            A real case, executed on the real workflow engine. Everything is
            draft-first: nothing sends in front of a client.
          </p>
        </div>
        <button className="btn-ghost" onClick={onClose}>
          ← Back to workflows
        </button>
      </div>

      {error ? <p className="wf-error">{error}</p> : null}

      {!run ? (
        <>
          <section className="wt-case">
            <div className="wt-case-main">
              <h3>
                {DEMO_CASE.business} · {DEMO_CASE.location}
              </h3>
              <p>{DEMO_CASE.problem}</p>
              <blockquote className="wt-inquiry">
                “{DEMO_CASE.inquiry}”
                <footer>
                  — {DEMO_CASE.leadName}, via {DEMO_CASE.channel}
                </footer>
              </blockquote>
              <div className="wt-measures">
                <h4>What success looks like (the charter)</h4>
                <ul>
                  {DEMO_CASE.successMeasures.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="wt-manual">
              <h4>
                The manual way — ~{Math.round(manualTotal / 60)} hours end to
                end, {handsOn} min of it hands-on
              </h4>
              <ol className="wt-manual-list">
                {DEMO_CASE.manualSteps.map((s) => (
                  <li key={s.title} className={s.eliminated ? "eliminated" : ""}>
                    <b>
                      {s.title} · {s.minutes >= 60 ? `~${Math.round(s.minutes / 60)}h` : `${s.minutes} min`}
                      {s.eliminated ? " · eliminated by automation" : ""}
                    </b>
                    <span>{s.text}</span>
                  </li>
                ))}
              </ol>
            </div>
          </section>
          <section className="wt-runbar">
            <label>
              Automation to run
              <select
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                disabled={loading || workflows.length === 0}
              >
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.trigger_type})
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn-primary wt-run"
              onClick={() => void execute()}
              disabled={running || !selectedId}
            >
              {running ? "Running…" : "▶ Run the automation live"}
            </button>
            {!loading && workflows.length === 0 ? (
              <p className="muted">
                No published workflow exists in the demo environment yet —
                publish one in the builder and it will appear here.
              </p>
            ) : null}
            {selected ? (
              <p className="muted">
                Runs “{selected.name}” against the case above, on the real
                engine, in the demo environment.
              </p>
            ) : null}
          </section>
        </>
      ) : (
        <>
          <section className="wt-player">
            <div className="wt-player-head">
              <b>
                Run {run.id.slice(0, 8)} · {run.status}
                {seconds != null ? ` · ${seconds < 1 ? "<1" : seconds.toFixed(1)}s` : ""}
              </b>
              <span className="muted">
                Step {Math.min(stepIndex + 1, steps.length)} of {steps.length}
              </span>
            </div>
            <div className="wt-dots">
              {steps.map((s, i) => (
                <button
                  key={s.node_key + i}
                  className={`wt-dot ${i === stepIndex && !showFinale ? "active" : ""} ${s.status}`}
                  onClick={() => {
                    setStepIndex(i);
                    setShowFinale(false);
                  }}
                  aria-label={`Step ${i + 1}: ${s.node_label}`}
                />
              ))}
              <button
                className={`wt-dot finale ${showFinale ? "active" : ""}`}
                onClick={() => setShowFinale(true)}
                aria-label="Summary"
              />
            </div>

            {!showFinale && step ? (
              <div className="wt-step">
                <div className="wt-step-head">
                  <span className={`wf-badge wf-badge-${step.status === "completed" ? "published" : "draft"}`}>
                    {step.status}
                  </span>
                  <h3>
                    {step.node_label}{" "}
                    <small className="muted">({step.node_kind})</small>
                  </h3>
                  {APPROVAL_KINDS.has(step.node_kind) ? (
                    <span className="wt-approval">
                      Human approval point — draft-first
                    </span>
                  ) : null}
                </div>
                <div className="wt-versus">
                  <div className="wt-side manual">
                    <h4>The manual way</h4>
                    {manual ? (
                      <>
                        <b>
                          {manual.title} ·{" "}
                          {manual.minutes >= 60
                            ? `~${Math.round(manual.minutes / 60)}h`
                            : `${manual.minutes} min`}
                        </b>
                        <p>{manual.text}</p>
                      </>
                    ) : (
                      <p>Done by hand, unrecorded.</p>
                    )}
                  </div>
                  <div className="wt-side auto">
                    <h4>The automated way</h4>
                    <p>
                      {AUTOMATED_NARRATION[step.node_kind] ??
                        "Executes in the engine, recorded step by step."}
                    </p>
                    {step.error ? (
                      <p className="wt-step-error">
                        Recorded honestly: {step.error}
                      </p>
                    ) : null}
                    {outputHighlights(step.output).length ? (
                      <dl className="wt-output">
                        {outputHighlights(step.output).map(([k, v]) => (
                          <div key={k}>
                            <dt>{k}</dt>
                            <dd>{v}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                  </div>
                </div>
                <div className="wt-nav">
                  <button
                    className="btn-ghost"
                    disabled={stepIndex === 0}
                    onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
                  >
                    ← Previous step
                  </button>
                  <button
                    className="btn-primary"
                    onClick={() => {
                      if (stepIndex >= steps.length - 1) setShowFinale(true);
                      else setStepIndex((i) => i + 1);
                    }}
                  >
                    {stepIndex >= steps.length - 1
                      ? "See the outcome →"
                      : "Next step →"}
                  </button>
                </div>
              </div>
            ) : null}

            {showFinale ? (
              <div className="wt-step">
                <h3>The outcome</h3>
                <div className="wt-versus">
                  <div className="wt-side manual">
                    <h4>Manual</h4>
                    <p>
                      <b>{handsOn} minutes of staff effort</b> per inquiry,
                      and the patient typically waits hours — often until
                      the next day — for a reply. Some inquiries are never
                      answered.
                    </p>
                  </div>
                  <div className="wt-side auto">
                    <h4>Automated</h4>
                    <p>
                      <b>
                        Draft ready in{" "}
                        {seconds != null
                          ? seconds < 1
                            ? "under a second"
                            : `${seconds.toFixed(1)} seconds`
                          : "seconds"}
                      </b>
                      ; a person spends ~2 minutes reviewing the draft
                      before it sends. Roughly{" "}
                      <b>{handsOn - 2} minutes of staff time returned</b>{" "}
                      per inquiry — and no inquiry waits in an inbox.
                    </p>
                  </div>
                </div>
                <section className="wt-finale-block">
                  <h4>Audit trail — every step, recorded</h4>
                  <ul className="wt-audit">
                    {steps.map((s, i) => (
                      <li key={s.node_key + i}>
                        <code>{new Date(s.started_at).toLocaleTimeString()}</code>{" "}
                        {s.node_label} ({s.node_kind}) — <b>{s.status}</b>
                        {s.error ? ` · ${s.error}` : ""}
                      </li>
                    ))}
                  </ul>
                  <p className="muted">
                    This trail is the run's own record in the workflow
                    audit log — the same evidence a charter KPI is verified
                    against after go-live.
                  </p>
                </section>
                <section className="wt-finale-block">
                  <h4>Against the charter's success measures</h4>
                  <ul className="wt-measures-check">
                    <li>
                      ✓ <b>Draft within 5 minutes</b> — demonstrated by this
                      run ({seconds != null && seconds < 60 ? "under a minute" : "within the run"}).
                    </li>
                    <li>
                      ✓ <b>Audit record for every follow-up</b> — demonstrated:
                      the trail above is written automatically.
                    </li>
                    <li>
                      ◐ <b>Zero inquiries unanswered</b> — a process outcome,
                      verified over time as a charter KPI once live.
                    </li>
                  </ul>
                </section>
                <div className="wt-nav">
                  <button
                    className="btn-ghost"
                    onClick={() => {
                      setShowFinale(false);
                      setStepIndex(0);
                    }}
                  >
                    ← Walk the steps again
                  </button>
                  <button
                    className="btn-primary"
                    onClick={() => {
                      setRun(null);
                      setShowFinale(false);
                      setStepIndex(0);
                    }}
                  >
                    Run it again
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
