import { useCallback, useEffect, useMemo, useState } from "react";
import { getAuthToken, notifyUnauthorized } from "./auth";
import "./walkthrough.css";

/* ── Demo walkthrough mode (Phase 3, upgraded) ─────────────────────────
 * Client-presentable E2E stories, run live inside the demo environment.
 * Three cases, each shaped like a handoff package (problem + current
 * state + success measures). The presenter sees the process map first —
 * event → draft → ADMIN APPROVAL → send → audit — then runs the
 * automation on the real engine and walks the recorded run stage by
 * stage. The approval stage is played by the presenter: nothing is
 * "sent" until they approve the draft, which is exactly DF's draft-
 * first contract. Ends on the run's audit trail and a time-saved
 * summary scored against the case's success measures.
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

interface WorkflowNodeLite {
  node_key: string;
  type: string;
  kind: string;
  label: string;
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

/* ── Cases ───────────────────────────────────────────────────────────── */

interface ManualStep {
  title: string;
  minutes: number;
  text: string;
  eliminated?: boolean;
  wait?: boolean;
}

type MeasureKind = "demonstrated" | "audit" | "process";

interface DemoCase {
  id: string;
  business: string;
  sector: string;
  location: string;
  workflowMatch: RegExp;
  eventTitle: string;
  eventChannel: string;
  formFields: Array<[string, string]>;
  eventText: string;
  problem: string;
  unit: string;
  input: Record<string, unknown>;
  manualSteps: ManualStep[];
  manualByKind: Record<string, number>;
  successMeasures: string[];
  measureKinds: MeasureKind[];
}

const CASES: DemoCase[] = [
  {
    id: "harbourview",
    business: "Harbourview Dental Studio",
    sector: "Dental clinic",
    location: "Toronto",
    workflowMatch: /lead follow-up/i,
    eventTitle: "New patient inquiry",
    eventChannel: "Website contact form",
    formFields: [
      ["Name", "Maya Chen"],
      ["Phone", "+1 416-555-0134"],
      ["Service", "Hygiene appointment"],
      ["Preferred time", "Evenings"],
    ],
    eventText:
      "Hi — do you have any hygiene appointments next week? I work weekdays, so an evening slot would be ideal. Thanks!",
    problem:
      "New-patient inquiries arrive by web form and email. The front desk checks twice a day, copies the details into a spreadsheet, and drafts every reply from scratch. Replies typically land the next day — and some inquiries are never answered at all.",
    unit: "inquiry",
    input: {
      organization_name: "Harbourview Dental Studio",
      lead: { name: "Maya Chen", phone: "+1 416-555-0134", score: 87 },
    },
    manualSteps: [
      { title: "Notice the inquiry", minutes: 240, wait: true, text: "Waits in the inbox until the front desk's next check — twice a day. Average wait: about 4 hours, often overnight." },
      { title: "Copy details into the tracker", minutes: 10, eliminated: true, text: "Name, phone, and request re-keyed into a spreadsheet by hand." },
      { title: "Draft the reply from scratch", minutes: 15, text: "Staff write each response from a blank page, checking the schedule manually first." },
      { title: "Chase approval, then send", minutes: 20, text: "The draft is forwarded to the office manager; it sends only after approval comes back." },
      { title: "Log the follow-up", minutes: 5, text: "The spreadsheet is updated by hand — when someone remembers." },
    ],
    manualByKind: { lead_handoff: 0, webhook: 0, manual: 0, if_else: 1, ai_assist: 2, send_sms: 3, send_email: 3, log_database: 4 },
    successMeasures: [
      "First follow-up draft within 5 minutes of intake",
      "Zero inquiries left unanswered",
      "Every follow-up leaves an audit record",
    ],
    measureKinds: ["demonstrated", "process", "audit"],
  },
  {
    id: "northgate",
    business: "Northgate Legal LLP",
    sector: "Law firm",
    location: "Toronto",
    workflowMatch: /lead auto-response/i,
    eventTitle: "After-hours closing inquiry",
    eventChannel: "Website contact form · 9:47 PM",
    formFields: [
      ["Name", "Daniel Okafor"],
      ["Phone", "+1 416-555-0187"],
      ["Email", "daniel.okafor@example.com"],
      ["Matter", "Residential closing — Oct 28"],
    ],
    eventText:
      "We're closing on a house in Leslieville on the 28th and our lawyer just retired. Can your firm handle the closing, and what are your fees?",
    problem:
      "Closing inquiries are deadline-driven, but after-hours submissions wait until the next business day and join the same callback queue as general questions. Callers with a closing date often sign with the first firm that responds.",
    unit: "inquiry",
    input: {
      organization_name: "Northgate Legal LLP",
      lead: {
        name: "Daniel Okafor",
        phone: "+1 416-555-0187",
        email: "daniel.okafor@example.com",
        score: 82,
      },
    },
    manualSteps: [
      { title: "Notice the inquiry", minutes: 720, wait: true, text: "Submitted at 9:47 PM; seen when the office opens the next business day." },
      { title: "Call back and take notes", minutes: 15, text: "The intake assistant phones in queue order and hand-writes the matter details." },
      { title: "Draft the response from precedents", minutes: 20, text: "The reply is assembled from precedent files, with the fee wording checked manually." },
      { title: "Partner reviews the fee wording", minutes: 15, text: "The draft waits for a partner's approval before it can go out." },
      { title: "Log in the intake spreadsheet", minutes: 5, text: "Matter, deadline, and status typed in by hand." },
    ],
    manualByKind: { lead_handoff: 0, webhook: 0, manual: 0, if_else: 1, ai_assist: 2, send_email: 2, send_sms: 2, log_database: 4 },
    successMeasures: [
      "First response draft within 5 minutes, at any hour",
      "Zero after-hours inquiries unanswered by 9 AM",
      "Every response leaves an audit record",
    ],
    measureKinds: ["demonstrated", "process", "audit"],
  },
  {
    id: "truenorth",
    business: "TrueNorth Home Services",
    sector: "Home services",
    location: "Toronto",
    workflowMatch: /review request/i,
    eventTitle: "Job completed",
    eventChannel: "Field app webhook",
    formFields: [
      ["Customer", "Sarah Lindqvist"],
      ["Phone", "+1 416-555-0119"],
      ["Service", "Furnace tune-up"],
      ["Job", "JOB-2481 · marked complete"],
    ],
    eventText:
      "Job JOB-2481 marked complete in the field app. Technician note: “All checks passed — filter replaced, no issues found.”",
    problem:
      "Review requests depend on technicians remembering to ask. Most completed jobs never get one, so the company's Google profile grows slowly despite happy customers — and nobody can say who was asked.",
    unit: "completed job",
    input: {
      business_name: "TrueNorth Home Services",
      city: "Toronto",
      service: "Furnace tune-up",
      job_id: "JOB-2481",
      review_link: "https://g.page/truenorth.example/review",
      customer: { name: "Sarah Lindqvist", phone: "+1 416-555-0119" },
    },
    manualSteps: [
      { title: "Notice completed jobs", minutes: 2880, wait: true, text: "The office reviews completed jobs in a weekly report — days after the visit, when the impression is cold." },
      { title: "Check the job card for a phone", minutes: 5, text: "Someone opens each job card to find a mobile number." },
      { title: "Text the customer manually", minutes: 5, text: "A review request is typed and sent from the office phone, one job at a time." },
      { title: "Log who was asked", minutes: 3, text: "A spreadsheet note — if it happens at all." },
    ],
    manualByKind: { webhook: 0, lead_handoff: 0, manual: 0, if_else: 1, send_sms: 2, send_email: 2, ai_assist: 2, log_database: 3 },
    successMeasures: [
      "Review request drafted the same day the job completes",
      "Every completed job with a phone number gets a request",
      "Every request is logged",
    ],
    measureKinds: ["demonstrated", "demonstrated", "audit"],
  },
];

/* ── Narration ───────────────────────────────────────────────────────── */

const AUTOMATED_NARRATION: Record<string, string> = {
  lead_handoff:
    "The inquiry lands and the automation starts immediately — no inbox waiting, no twice-a-day checks.",
  webhook:
    "The field app fires the event the second the job is marked complete — no weekly report, no delay.",
  manual: "The automation starts the moment the event lands.",
  trigger:
    "The event lands and the automation starts immediately — no inbox waiting.",
  if_else:
    "The record is checked automatically — here, a phone number is present, so the request goes out by text.",
  condition:
    "The record is routed on its data instantly.",
  ai_assist:
    "The AI drafts the message from the inquiry and the business's context. It produces a draft only — drafting is its whole job.",
  send_sms:
    "The text is prepared as a send-ready draft and held. Nothing is sent: a human approves first, every time.",
  send_email:
    "The email is prepared as a send-ready draft and held for human approval — nothing auto-sends.",
  log_database:
    "The run writes its own audit record — what happened, when, and what it produced — with no spreadsheet to remember.",
  assign_gate:
    "A review gate is assigned to a named human, who owns the decision from here.",
};

const SEND_KINDS = new Set(["send_sms", "send_email"]);

/* ── Stages ──────────────────────────────────────────────────────────── */

interface Stage {
  id: string;
  title: string;
  kind: "event" | "step" | "approval" | "outcome";
  step?: RunStep;
  nodeKind?: string;
}

function stageTitleForStep(step: RunStep, isFirst: boolean, c: DemoCase): string {
  if (isFirst) return c.eventTitle;
  if (step.node_kind === "ai_assist") return "Draft created";
  if (step.node_kind === "send_sms") return "Text message";
  if (step.node_kind === "send_email") return "Email";
  if (step.node_kind === "log_database") return "Logged & audited";
  if (step.node_kind === "assign_gate") return "Review gate assigned";
  if (step.node_kind === "if_else") return "Routing check";
  return step.node_label;
}

function buildRunStages(run: WorkflowRun, c: DemoCase): Stage[] {
  const steps = run.steps ?? [];
  const stages: Stage[] = [];
  let approvalInserted = false;
  steps.forEach((step, i) => {
    if (!approvalInserted && SEND_KINDS.has(step.node_kind)) {
      stages.push({
        id: "approval",
        title: "Admin approval",
        kind: "approval",
        nodeKind: step.node_kind,
      });
      approvalInserted = true;
    }
    stages.push({
      id: `step-${step.node_key}-${i}`,
      title: stageTitleForStep(step, i === 0, c),
      kind: i === 0 ? "event" : "step",
      step,
      nodeKind: step.node_kind,
    });
  });
  stages.push({ id: "outcome", title: "Outcome", kind: "outcome" });
  return stages;
}

function buildPlanStages(nodes: WorkflowNodeLite[], c: DemoCase): Stage[] {
  const stages: Stage[] = [];
  let approvalInserted = false;
  const body = nodes.filter((n) => n.type !== "trigger");
  stages.push({ id: "plan-event", title: c.eventTitle, kind: "event", nodeKind: nodes.find((n) => n.type === "trigger")?.kind });
  for (const node of body) {
    if (!approvalInserted && SEND_KINDS.has(node.kind)) {
      stages.push({ id: "plan-approval", title: "Admin approval", kind: "approval", nodeKind: node.kind });
      approvalInserted = true;
    }
    stages.push({
      id: `plan-${node.node_key}`,
      title:
        node.kind === "ai_assist"
          ? "Draft created"
          : node.kind === "send_sms"
            ? "Text message"
            : node.kind === "send_email"
              ? "Email"
              : node.kind === "log_database"
                ? "Logged & audited"
                : node.kind === "assign_gate"
                  ? "Review gate assigned"
                  : node.kind === "if_else"
                    ? "Routing check"
                    : node.label,
      kind: "step",
      nodeKind: node.kind,
    });
  }
  stages.push({ id: "plan-outcome", title: "Outcome", kind: "outcome" });
  return stages;
}

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

/**
 * The draft the admin reviews at the gate. Drafts are composed either
 * by an ai_assist step before the send (look backward) or by the send
 * step itself in draft-first mode (its recorded output IS the held
 * draft — look forward to the first send step after the gate).
 */
function draftForApproval(stages: Stage[], idx: number): string | null {
  const from = (s: Stage): string | null => {
    const out = s.step?.output;
    if (!out) return null;
    for (const key of ["draft", "message", "text", "body"]) {
      if (typeof out[key] === "string" && out[key]) return out[key] as string;
    }
    return null;
  };
  for (let i = idx - 1; i >= 0; i--) {
    const t = from(stages[i]);
    if (t) return t;
  }
  for (let i = idx + 1; i < stages.length; i++) {
    const s = stages[i];
    if (s.kind === "step" && s.step && SEND_KINDS.has(s.step.node_kind)) {
      const t = from(s);
      if (t) return t;
    }
  }
  return null;
}

interface DraftVersion {
  text: string;
  /** The admin note that produced this version (null for the engine's). */
  note: string | null;
  provider: "engine" | "llm" | "stub";
}

function runSeconds(run: WorkflowRun): number | null {
  if (!run.completed_at) return null;
  const ms =
    new Date(run.completed_at).getTime() - new Date(run.started_at).getTime();
  return Number.isFinite(ms) ? Math.max(0, ms / 1000) : null;
}

/* ── Components ──────────────────────────────────────────────────────── */

function ProcessMap({
  stages,
  current,
  approval,
}: {
  stages: Stage[];
  current: number | null;
  approval: "pending" | "approved" | "changes" | null;
}) {
  return (
    <ol className="wt-map" aria-label="Process map">
      {stages.map((stage, i) => {
        const state =
          current == null
            ? "plan"
            : i < current
              ? "done"
              : i === current
                ? "current"
                : "todo";
        return (
          <li key={stage.id} className={`wt-map-node ${state} ${stage.kind}`}>
            <span className="wt-map-dot">
              {stage.kind === "approval"
                ? "✋"
                : state === "done"
                  ? "✓"
                  : i + 1}
            </span>
            <span className="wt-map-label">
              {stage.title}
              {stage.kind === "approval" && approval === "approved" ? (
                <small> · approved</small>
              ) : null}
              {stage.kind === "approval" && approval === "changes" ? (
                <small> · changes requested</small>
              ) : null}
            </span>
            {i < stages.length - 1 ? <span className="wt-map-link" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function EventCard({ c }: { c: DemoCase }) {
  return (
    <div className="wt-form">
      <div className="wt-form-head">
        <b>{c.eventTitle}</b>
        <span>{c.eventChannel}</span>
      </div>
      <dl className="wt-form-fields">
        {c.formFields.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <blockquote className="wt-form-msg">“{c.eventText}”</blockquote>
    </div>
  );
}

export function WalkthroughView({ onClose }: { onClose: () => void }) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [caseId, setCaseId] = useState(CASES[0].id);
  const [selectedId, setSelectedId] = useState<string>("");
  const [planNodes, setPlanNodes] = useState<WorkflowNodeLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [stageIndex, setStageIndex] = useState(0);
  const [approval, setApproval] = useState<
    "pending" | "approved" | "changes" | null
  >(null);
  const [draftVersions, setDraftVersions] = useState<DraftVersion[]>([]);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [revising, setRevising] = useState(false);
  const [reviseError, setReviseError] = useState<string | null>(null);
  const [gateLog, setGateLog] = useState<string[]>([]);

  const demoCase = CASES.find((c) => c.id === caseId) ?? CASES[0];

  useEffect(() => {
    api<{ workflows: WorkflowSummary[] }>("/api/workflows?environment=demo")
      .then((d) => {
        const published = d.workflows.filter((w) => w.status === "published");
        setWorkflows(published);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load workflows"),
      )
      .finally(() => setLoading(false));
  }, []);

  // Keep the workflow selection matched to the chosen case.
  useEffect(() => {
    const preferred =
      workflows.find((w) => demoCase.workflowMatch.test(w.name)) ?? workflows[0];
    if (preferred) setSelectedId(preferred.id);
  }, [demoCase, workflows]);

  // Load the selected workflow's nodes for the plan map.
  useEffect(() => {
    if (!selectedId) {
      setPlanNodes([]);
      return;
    }
    api<{ workflow: { nodes: WorkflowNodeLite[] } }>(
      `/api/workflows/${selectedId}`,
    )
      .then((d) => setPlanNodes(d.workflow.nodes))
      .catch(() => setPlanNodes([]));
  }, [selectedId]);

  const selected = workflows.find((w) => w.id === selectedId);
  const stages = useMemo(
    () => (run ? buildRunStages(run, demoCase) : []),
    [run, demoCase],
  );
  const planStages = useMemo(
    () => buildPlanStages(planNodes, demoCase),
    [planNodes, demoCase],
  );
  const manualTotal = demoCase.manualSteps.reduce((s, x) => s + x.minutes, 0);
  const handsOn = demoCase.manualSteps
    .filter((s) => !s.wait)
    .reduce((s, x) => s + x.minutes, 0);
  const seconds = run ? runSeconds(run) : null;
  const stage = stages[stageIndex];
  const isOutcome = stage?.kind === "outcome";
  const stageStep = stage?.step;
  const manual =
    stageStep != null
      ? demoCase.manualSteps[
          demoCase.manualByKind[stageStep.node_kind] ??
            Math.min(stageIndex, demoCase.manualSteps.length - 1)
        ]
      : null;
  const currentDraft: DraftVersion | null =
    draftVersions[draftVersions.length - 1] ?? null;
  const draftVersionNo = draftVersions.length;

  // Seed the gate with the draft the engine recorded for this run.
  useEffect(() => {
    if (!run) return;
    const idx = stages.findIndex((s) => s.kind === "approval");
    const text = idx >= 0 ? draftForApproval(stages, idx) : null;
    setDraftVersions(
      text ? [{ text, note: null, provider: "engine" }] : [],
    );
    setGateLog([]);
    setFeedbackOpen(false);
    setFeedbackText("");
    setReviseError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  const submitRevision = useCallback(async () => {
    const note = feedbackText.trim();
    if (!note || !currentDraft || !run) return;
    setRevising(true);
    setReviseError(null);
    try {
      const r = await api<{
        revision: {
          revisedDraft: string | null;
          provider: "llm" | "stub";
          note: string;
        };
      }>("/api/workflows/drafts/revise", {
        method: "POST",
        body: JSON.stringify({
          draft: currentDraft.text,
          feedback: note,
          runId: run.id,
          workflowId: selectedId,
        }),
      });
      const nextNo = draftVersions.length + 1;
      setDraftVersions((v) => [
        ...v,
        {
          text: r.revision.revisedDraft ?? currentDraft.text,
          note,
          provider: r.revision.provider,
        },
      ]);
      setGateLog((l) => [
        ...l,
        r.revision.provider === "llm"
          ? `Admin requested changes: “${note}” — the AI redrafted it (draft v${nextNo}).`
          : `Admin requested changes: “${note}” — no AI provider is configured, so the note is recorded with the draft and the text is unchanged.`,
      ]);
      setFeedbackText("");
      setFeedbackOpen(false);
    } catch (e: unknown) {
      setReviseError(
        e instanceof Error ? e.message : "The redraft request failed",
      );
    } finally {
      setRevising(false);
    }
  }, [feedbackText, currentDraft, run, selectedId, draftVersions.length]);

  const execute = useCallback(async () => {
    if (!selectedId) return;
    setRunning(true);
    setError(null);
    setRun(null);
    setStageIndex(0);
    setApproval(null);
    setDraftVersions([]);
    setGateLog([]);
    try {
      const started = await api<{ run: WorkflowRun }>(
        `/api/workflows/${selectedId}/execute`,
        {
          method: "POST",
          body: JSON.stringify({ input: demoCase.input }),
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
  }, [selectedId, demoCase]);

  const reset = () => {
    setRun(null);
    setStageIndex(0);
    setApproval(null);
    setDraftVersions([]);
    setGateLog([]);
    setFeedbackOpen(false);
    setFeedbackText("");
  };

  return (
    <div className="wt">
      <div className="wt-head">
        <div>
          <p className="eyebrow accent">Demo walkthrough · Demo environment</p>
          <h2>Watch a manual process become an automation — live</h2>
          <p className="muted">
            Pick a case, see the flow, run it on the real engine, and play
            the admin at the approval gate. Nothing sends without approval.
          </p>
        </div>
        <button className="btn-ghost" onClick={onClose}>
          ← Back to workflows
        </button>
      </div>

      {error ? <p className="wf-error">{error}</p> : null}

      {!run ? (
        <>
          <div className="wt-cases" role="radiogroup" aria-label="Demo case">
            {CASES.map((c) => (
              <button
                key={c.id}
                role="radio"
                aria-checked={c.id === caseId}
                className={`wt-case-card ${c.id === caseId ? "active" : ""}`}
                onClick={() => setCaseId(c.id)}
              >
                <b>{c.business}</b>
                <span>
                  {c.sector} · {c.location}
                </span>
                <small>{c.eventTitle}</small>
              </button>
            ))}
          </div>

          <section className="wt-case">
            <div className="wt-case-main">
              <h3>
                {demoCase.business} · {demoCase.location}
              </h3>
              <p>{demoCase.problem}</p>
              <EventCard c={demoCase} />
              <div className="wt-measures">
                <h4>What success looks like (the charter)</h4>
                <ul>
                  {demoCase.successMeasures.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="wt-manual">
              <h4>
                The manual way — ~{Math.round(manualTotal / 60)}h end to end,{" "}
                {handsOn} min of it hands-on
              </h4>
              <ol className="wt-manual-list">
                {demoCase.manualSteps.map((s) => (
                  <li key={s.title} className={s.eliminated ? "eliminated" : ""}>
                    <b>
                      {s.title} ·{" "}
                      {s.minutes >= 60
                        ? `~${Math.round(s.minutes / 60)}h`
                        : `${s.minutes} min`}
                      {s.eliminated ? " · eliminated by automation" : ""}
                    </b>
                    <span>{s.text}</span>
                  </li>
                ))}
              </ol>
            </div>
          </section>

          <section className="wt-plan">
            <h4>The automated flow</h4>
            <ProcessMap stages={planStages} current={null} approval={null} />
            <p className="muted">
              The admin approval stage is the draft-first gate: the engine
              records the draft, and a human releases it — or sends it
              back with a note for the AI to redraft. You will play the
              admin during the run.
            </p>
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
              {running ? "Running…" : "▶ Run Automation"}
            </button>
            {!loading && workflows.length === 0 ? (
              <p className="muted">
                No published workflow exists in the demo environment yet —
                publish one in the builder and it will appear here.
              </p>
            ) : null}
            {selected ? (
              <p className="muted">
                Runs “{selected.name}” against the {demoCase.business} case,
                on the real engine, in the demo environment.
              </p>
            ) : null}
          </section>
        </>
      ) : (
        <section className="wt-player">
          <div className="wt-player-head">
            <b>
              {demoCase.business} · Run {run.id.slice(0, 8)} · {run.status}
              {seconds != null
                ? ` · ${seconds < 1 ? "<1" : seconds.toFixed(1)}s`
                : ""}
            </b>
            <span className="muted">
              Stage {Math.min(stageIndex + 1, stages.length)} of {stages.length}
            </span>
          </div>
          <ProcessMap stages={stages} current={stageIndex} approval={approval} />

          {!isOutcome && stage ? (
            <div className="wt-step">
              <div className="wt-step-head">
                <h3>{stage.title}</h3>
                {stage.kind === "approval" ? (
                  <span className="wt-approval">
                    Human approval point — draft-first
                  </span>
                ) : null}
                {stageStep ? (
                  <span
                    className={`wf-badge wf-badge-${stageStep.status === "completed" ? "published" : "draft"}`}
                  >
                    {stageStep.status}
                  </span>
                ) : null}
              </div>

              {stage.kind === "event" ? (
                <>
                  <p className="wt-stage-lead">
                    This is what arrives. The moment it lands, the automation
                    is already running — no inbox, no waiting.
                  </p>
                  <EventCard c={demoCase} />
                </>
              ) : stage.kind === "approval" ? (
                <>
                  <p className="wt-stage-lead">
                    The engine has recorded this draft and is holding it.
                    In live operation an admin approves it here —{" "}
                    <b>you are the admin now</b>. Read the draft: approving
                    releases the message step. If it needs work, send it
                    back with a note — the AI redrafts it with your note
                    and you decide again. Holding the send means nothing
                    goes out.
                  </p>
                  {currentDraft ? (
                    <div className="wt-draft-wrap">
                      <div className="wt-draft-label">
                        {currentDraft.provider === "engine"
                          ? "The draft under review — exactly as the engine recorded it"
                          : currentDraft.provider === "llm"
                            ? `Revised draft v${draftVersionNo} — redrafted with your note`
                            : `Draft v${draftVersionNo} — redraft pending a provider`}
                      </div>
                      <blockquote className="wt-draft-card">
                        “{currentDraft.text}”
                      </blockquote>
                      {currentDraft.note ? (
                        <p className="wt-draft-note">
                          Your note: “{currentDraft.note}”
                          {currentDraft.provider === "stub"
                            ? " — recorded with the draft. No AI provider is configured in this environment, so the text above is unchanged; with a provider connected, the AI returns a revised draft here."
                            : " — applied in the revision above."}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="muted">
                      The engine did not record draft text for this run.
                    </p>
                  )}
                  {approval == null ? (
                    !feedbackOpen ? (
                      <div className="wt-approval-actions">
                        <button
                          className="btn-primary"
                          onClick={() => setApproval("approved")}
                        >
                          ✓ Approve draft
                          {draftVersionNo > 1 ? ` v${draftVersionNo}` : ""}
                        </button>
                        <button
                          className="btn-ghost"
                          onClick={() => setFeedbackOpen(true)}
                        >
                          Request changes…
                        </button>
                      </div>
                    ) : (
                      <div className="wt-feedback">
                        <label htmlFor="wt-feedback-text">
                          What should the AI change? Your note goes to the
                          model with the draft, and the revised draft
                          comes back here for your decision.
                        </label>
                        <textarea
                          id="wt-feedback-text"
                          rows={3}
                          value={feedbackText}
                          onChange={(e) => setFeedbackText(e.target.value)}
                          placeholder="e.g. Make it warmer, mention the Oct 28 closing date, and drop the fee estimate."
                        />
                        {reviseError ? (
                          <p className="wf-error">{reviseError}</p>
                        ) : null}
                        <div className="wt-approval-actions">
                          <button
                            className="btn-primary"
                            disabled={
                              revising || !feedbackText.trim() || !currentDraft
                            }
                            onClick={() => void submitRevision()}
                          >
                            {revising ? "Redrafting…" : "↻ Redraft with my note"}
                          </button>
                          <button
                            className="btn-ghost"
                            onClick={() => setApproval("changes")}
                          >
                            Hold the send instead
                          </button>
                          <button
                            className="btn-ghost"
                            onClick={() => setFeedbackOpen(false)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )
                  ) : (
                    <p className="wt-decision">
                      {approval === "approved"
                        ? `✓ Approved — draft v${draftVersionNo} is released to the message step.`
                        : "✎ The send is held. Nothing goes out; the draft and your notes stay on the record for rework."}
                    </p>
                  )}
                </>
              ) : (
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
                      {stageStep
                        ? (AUTOMATED_NARRATION[stageStep.node_kind] ??
                          "Executes in the engine, recorded step by step.")
                        : ""}
                    </p>
                    {stage?.kind === "step" &&
                    stageStep &&
                    SEND_KINDS.has(stageStep.node_kind) &&
                    approval === "changes" ? (
                      <p className="wt-step-error">
                        Held by the admin — this step did not release. The
                        draft stays recorded for rework.
                      </p>
                    ) : null}
                    {stage?.kind === "step" &&
                    stageStep &&
                    SEND_KINDS.has(stageStep.node_kind) &&
                    approval === "approved" &&
                    draftVersionNo > 1 &&
                    currentDraft ? (
                      <p>
                        Released: draft v{draftVersionNo}
                        {currentDraft.provider === "llm"
                          ? " — the revision the admin approved at the gate."
                          : " — approved at the gate with the admin's note attached."}
                      </p>
                    ) : null}
                    {stageStep?.error ? (
                      <p className="wt-step-error">
                        Recorded honestly: {stageStep.error}
                      </p>
                    ) : null}
                    {stageStep && outputHighlights(stageStep.output).length ? (
                      <dl className="wt-output">
                        {outputHighlights(stageStep.output).map(([k, v]) => (
                          <div key={k}>
                            <dt>{k}</dt>
                            <dd>{v}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                  </div>
                </div>
              )}

              <div className="wt-nav">
                <button
                  className="btn-ghost"
                  disabled={stageIndex === 0}
                  onClick={() => setStageIndex((i) => Math.max(0, i - 1))}
                >
                  ← Previous stage
                </button>
                <button
                  className="btn-primary"
                  disabled={stage.kind === "approval" && approval == null}
                  onClick={() =>
                    setStageIndex((i) => Math.min(stages.length - 1, i + 1))
                  }
                >
                  {stage.kind === "approval" && approval == null
                    ? "Decide to continue"
                    : stageIndex >= stages.length - 2
                      ? "See the outcome →"
                      : "Next stage →"}
                </button>
              </div>
            </div>
          ) : (
            <div className="wt-step">
              <h3>The outcome</h3>
              <p className="wt-decision">
                {approval === "changes"
                  ? "Outcome: the draft was held at the approval gate — nothing was sent. The automation still did its job: drafted in seconds, gated by a human, fully logged."
                  : draftVersionNo > 1
                    ? `Outcome: drafted, sent back and revised at the gate (v${draftVersionNo}), approved by a human, released, and logged — end to end.`
                    : "Outcome: drafted, approved by a human, released, and logged — end to end."}
              </p>
              <div className="wt-versus">
                <div className="wt-side manual">
                  <h4>Manual</h4>
                  <p>
                    <b>{handsOn} minutes of staff effort</b> per{" "}
                    {demoCase.unit}, and the other party typically waits
                    hours — often until the next day. Some are never
                    answered at all.
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
                    ; a person spends ~2 minutes reviewing at the approval
                    gate. Roughly{" "}
                    <b>{handsOn - 2} minutes of staff time returned</b> per{" "}
                    {demoCase.unit}.
                  </p>
                </div>
              </div>
              <section className="wt-finale-block">
                <h4>Audit trail — every step, recorded</h4>
                <ul className="wt-audit">
                  {(run.steps ?? []).map((s, i) => (
                    <li key={s.node_key + i}>
                      <code>{new Date(s.started_at).toLocaleTimeString()}</code>{" "}
                      {s.node_label} ({s.node_kind}) — <b>{s.status}</b>
                      {s.error ? ` · ${s.error}` : ""}
                    </li>
                  ))}
                  {gateLog.map((line, i) => (
                    <li key={`gate-${i}`}>
                      <code>gate</code> {line}
                    </li>
                  ))}
                  {approval ? (
                    <li>
                      <code>gate</code> Admin approval (played by you) —{" "}
                      <b>
                        {approval === "approved"
                          ? `approved (draft v${draftVersionNo})`
                          : "send held"}
                      </b>
                    </li>
                  ) : null}
                </ul>
                <p className="muted">
                  This trail is the run's own record in the workflow audit
                  log — the same evidence a charter KPI is verified against
                  after go-live.
                </p>
              </section>
              <section className="wt-finale-block">
                <h4>Against the charter's success measures</h4>
                <ul className="wt-measures-check">
                  {demoCase.successMeasures.map((m, i) => {
                    const kind = demoCase.measureKinds[i];
                    return (
                      <li key={m}>
                        {kind === "process" ? "◐" : "✓"} <b>{m}</b> —{" "}
                        {kind === "demonstrated"
                          ? "demonstrated by this run."
                          : kind === "audit"
                            ? "demonstrated: the trail above is written automatically."
                            : "a process outcome, verified over time as a charter KPI once live."}
                      </li>
                    );
                  })}
                </ul>
              </section>
              <div className="wt-nav">
                <button
                  className="btn-ghost"
                  onClick={() => setStageIndex(0)}
                >
                  ← Walk the stages again
                </button>
                <button className="btn-primary" onClick={reset}>
                  Run it again
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
