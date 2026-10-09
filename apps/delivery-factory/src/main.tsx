import React, {
  FormEvent,
  StrictMode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./functionality.css";
import "./workflows.css";
import "./monitoring.css";
import "./ux-fixes.css";
import { WorkflowsSection } from "./workflows";
import { MonitoringSection } from "./monitoring";
import { ReviewDrawer, type ReviewState } from "./review";
import { AuthProvider, LoginScreen, getAuthToken, useAuth } from "./auth";
import type { DeliveryEnvironment } from "./environment";

type View =
  | "portfolio"
  | "projects"
  | "plans"
  | "gates"
  | "evidence"
  | "clients"
  | "workflows"
  | "monitoring"
  | "audit"
  | "operations";
export type ProjectStage =
  "Discovery" | "Plan" | "Build" | "Ready for release" | "Complete";

/**
 * The demo workspace's local charter: the same shape the Lead Engine
 * handoff package gives a production project (Phase 1) — problem,
 * objective, success criteria, risks — so every demo decision can be
 * reviewed against an intended purpose.
 */
export type ProjectCharter = {
  problemStatement: string;
  objective: string;
  successCriteria: string[];
  risks: string[];
};

export type Project = {
  id: string;
  name: string;
  client: string;
  stage: ProjectStage;
  owner: string;
  due: string;
  tone: "violet" | "amber" | "green";
  charter: ProjectCharter;
};

export type Gate = {
  id: string;
  projectId: string;
  label: string;
  status: "Needs reviewer" | "Client response" | "Ready to review" | "Approved";
  /** Why this gate exists — the rationale shown before anyone approves. */
  purpose: string;
  /** Acceptance criteria (from the project charter) this gate validates. */
  criteria: string[];
  /** The stage this gate guards: it must clear before leaving that stage. */
  stage: ProjectStage;
};

/**
 * A real evidence record (Phase 2). Coverage is derived from records —
 * a criterion counts as covered when at least one record supports it.
 */
export type EvidenceRecord = {
  id: string;
  projectId: string;
  gateId: string | null;
  title: string;
  checkpointType: "test-run" | "review" | "document" | "metric" | "sign-off";
  note: string;
  criteria: string[];
  capturedBy: string;
  at: string;
};

export type AuditEvent = {
  id: string;
  action: string;
  subject: string;
  /** Business reading of the decision (rationale, quantified context). */
  detail?: string;
  at: string;
};

const seedProjects: Project[] = [
  {
    id: "project-northstar",
    name: "Northstar Health",
    client: "Northstar Health · NHS",
    stage: "Build",
    owner: "AM",
    due: "Sep 26",
    tone: "violet",
    charter: {
      problemStatement:
        "Referral letters and discharge summaries are re-keyed by hand between systems; the delays stall patient flow and bury clinicians in admin.",
      objective:
        "Automate referral intake and discharge-summary drafting across Northstar clinics, with clinicians approving every draft.",
      successCriteria: [
        "Referral intake runs without manual re-keying",
        "Discharge drafts are produced for clinician approval within 15 minutes",
        "Every automated step leaves an audit record",
        "No patient data leaves the approved region",
      ],
      risks: [
        "Integration access to the legacy EHR is unconfirmed",
        "Clinician review capacity at go-live",
      ],
    },
  },
  {
    id: "project-field-form",
    name: "Field & Form",
    client: "Field & Form · Retail",
    stage: "Discovery",
    owner: "JT",
    due: "Oct 04",
    tone: "amber",
    charter: {
      problemStatement:
        "Store teams report stock exceptions on paper forms; head office sees them days later, after the shelf has already lost sales.",
      objective:
        "Digitize stock-exception capture with automated triage to the right team.",
      successCriteria: [
        "Exceptions are captured digitally at the store",
        "Triage routes exceptions to the right team automatically",
        "Weekly exception summary is generated without manual collation",
      ],
      risks: ["Store Wi-Fi coverage is uneven across locations"],
    },
  },
  {
    id: "project-atlas",
    name: "Atlas Civic Lab",
    client: "Atlas Civic Lab · Public",
    stage: "Ready for release",
    owner: "SK",
    due: "Sep 20",
    tone: "green",
    charter: {
      problemStatement:
        "Permit applications arrive by email and are tracked in spreadsheets; applicants cannot see their status and phone the office instead.",
      objective:
        "Automate permit intake, status tracking, and applicant notifications — notifications drafted for staff approval, never sent automatically.",
      successCriteria: [
        "Applications are registered automatically on receipt",
        "Applicants can see live status without contacting the office",
        "Notifications are drafted for staff approval, never sent automatically",
        "Status history is fully auditable",
      ],
      risks: ["Peak-season application volume is untested"],
    },
  },
];

const seedGates: Gate[] = [
  {
    id: "gate-release",
    projectId: "project-atlas",
    label: "Release readiness",
    status: "Ready to review",
    purpose:
      "Final check that every acceptance criterion has evidence before the automation goes public.",
    criteria: [
      "Applications are registered automatically on receipt",
      "Applicants can see live status without contacting the office",
      "Notifications are drafted for staff approval, never sent automatically",
      "Status history is fully auditable",
    ],
    stage: "Ready for release",
  },
  {
    id: "gate-scope",
    projectId: "project-northstar",
    label: "Scope clarification",
    status: "Client response",
    purpose:
      "Confirms the automation scope still matches the validated requirements before build proceeds further.",
    criteria: [
      "Referral intake runs without manual re-keying",
      "Every automated step leaves an audit record",
    ],
    stage: "Build",
  },
  {
    id: "gate-architecture",
    projectId: "project-field-form",
    label: "Architecture baseline",
    status: "Needs reviewer",
    purpose:
      "Confirms the capture architecture and data model can deliver the charter before build starts.",
    criteria: [
      "Exceptions are captured digitally at the store",
      "Triage routes exceptions to the right team automatically",
    ],
    stage: "Discovery",
  },
  {
    id: "gate-evidence",
    projectId: "project-northstar",
    label: "Test evidence",
    status: "Needs reviewer",
    purpose:
      "Verifies the test evidence covers the acceptance criteria before the project can leave Build.",
    criteria: [
      "Discharge drafts are produced for clinician approval within 15 minutes",
      "Every automated step leaves an audit record",
    ],
    stage: "Build",
  },
];

const seedEvidence: EvidenceRecord[] = [
  {
    id: "evidence-northstar-intake",
    projectId: "project-northstar",
    gateId: "gate-scope",
    title: "Referral intake test run — 24 synthetic referrals",
    checkpointType: "test-run",
    note: "All 24 referrals registered without manual re-keying; timings logged.",
    criteria: ["Referral intake runs without manual re-keying"],
    capturedBy: "AM",
    at: "2026-09-24T14:00:00.000Z",
  },
  {
    id: "evidence-northstar-audit",
    projectId: "project-northstar",
    gateId: "gate-evidence",
    title: "Audit extract — intake run trail",
    checkpointType: "document",
    note: "Every automated step in the test run produced an audit record.",
    criteria: ["Every automated step leaves an audit record"],
    capturedBy: "AM",
    at: "2026-09-24T15:30:00.000Z",
  },
  {
    id: "evidence-northstar-draft",
    projectId: "project-northstar",
    gateId: "gate-evidence",
    title: "Discharge draft timing measurement",
    checkpointType: "metric",
    note: "Median draft production 11 minutes across the test cohort.",
    criteria: [
      "Discharge drafts are produced for clinician approval within 15 minutes",
    ],
    capturedBy: "AM",
    at: "2026-09-25T09:15:00.000Z",
  },
  {
    id: "evidence-field-capture",
    projectId: "project-field-form",
    gateId: "gate-architecture",
    title: "Store capture prototype review",
    checkpointType: "review",
    note: "Prototype captures an exception digitally in under a minute per item.",
    criteria: ["Exceptions are captured digitally at the store"],
    capturedBy: "JT",
    at: "2026-09-23T11:00:00.000Z",
  },
  {
    id: "evidence-atlas-intake",
    projectId: "project-atlas",
    gateId: "gate-release",
    title: "Intake registration test — 40 emailed applications",
    checkpointType: "test-run",
    note: "All applications registered automatically on receipt.",
    criteria: ["Applications are registered automatically on receipt"],
    capturedBy: "SK",
    at: "2026-09-18T10:00:00.000Z",
  },
  {
    id: "evidence-atlas-status",
    projectId: "project-atlas",
    gateId: "gate-release",
    title: "Applicant status page walkthrough",
    checkpointType: "review",
    note: "Status visible end to end without contacting the office.",
    criteria: ["Applicants can see live status without contacting the office"],
    capturedBy: "SK",
    at: "2026-09-18T13:00:00.000Z",
  },
  {
    id: "evidence-atlas-drafts",
    projectId: "project-atlas",
    gateId: "gate-release",
    title: "Notification draft samples",
    checkpointType: "document",
    note: "Notifications produced as drafts; nothing sent automatically.",
    criteria: [
      "Notifications are drafted for staff approval, never sent automatically",
    ],
    capturedBy: "SK",
    at: "2026-09-19T09:00:00.000Z",
  },
  {
    id: "evidence-atlas-audit",
    projectId: "project-atlas",
    gateId: "gate-release",
    title: "Status history audit extract",
    checkpointType: "document",
    note: "Full status history reconstructable from the audit trail.",
    criteria: ["Status history is fully auditable"],
    capturedBy: "SK",
    at: "2026-09-19T10:30:00.000Z",
  },
];

/** Criteria (by exact text) covered by at least one evidence record. */
export function coveredCriteria(
  projectId: string,
  records: EvidenceRecord[],
): Set<string> {
  const covered = new Set<string>();
  for (const record of records) {
    if (record.projectId !== projectId) continue;
    for (const criterion of record.criteria) covered.add(criterion);
  }
  return covered;
}

/** Evidence coverage % for a project: charter criteria with evidence. */
export function evidenceCoverage(
  project: Project,
  records: EvidenceRecord[],
): number {
  const criteria = project.charter.successCriteria;
  if (criteria.length === 0) return 0;
  const covered = coveredCriteria(project.id, records);
  const hit = criteria.filter((criterion) => covered.has(criterion)).length;
  return Math.round((hit / criteria.length) * 100);
}

export const STAGE_ORDER: ProjectStage[] = [
  "Discovery",
  "Plan",
  "Build",
  "Ready for release",
  "Complete",
];

/**
 * Progress is calculated, never typed in: the stage contributes its base
 * (20 points per stage), and the remaining span is earned half by the
 * current stage's gates being approved and half by evidence coverage.
 */
export function projectProgress(
  project: Project,
  gates: Gate[],
  records: EvidenceRecord[],
): number {
  const index = STAGE_ORDER.indexOf(project.stage);
  if (project.stage === "Complete") return 100;
  const stageGates = gates.filter(
    (gate) => gate.projectId === project.id && gate.stage === project.stage,
  );
  const gateFraction = stageGates.length
    ? stageGates.filter((gate) => gate.status === "Approved").length /
      stageGates.length
    : 1;
  const completion =
    (gateFraction + evidenceCoverage(project, records) / 100) / 2;
  return Math.round(index * 20 + completion * 20);
}

const navItems: Array<{ id: View; label: string }> = [
  { id: "portfolio", label: "Portfolio" },
  { id: "projects", label: "Projects" },
  { id: "plans", label: "Plans & baselines" },
  { id: "gates", label: "Delivery gates" },
  { id: "evidence", label: "Evidence library" },
  { id: "clients", label: "Client views" },
  { id: "workflows", label: "Automations" },
  { id: "monitoring", label: "Monitoring" },
];

const viewTitles: Record<View, string> = {
  portfolio: "Delivery Factory",
  projects: "Projects",
  plans: "Plans & baselines",
  gates: "Delivery gates",
  evidence: "Evidence library",
  clients: "Client views",
  workflows: "Automation workflows",
  monitoring: "Service monitoring",
  audit: "Audit explorer",
  operations: "Operations",
};

function useStoredState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? (JSON.parse(stored) as T) : initialValue;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue] as const;
}

/** Views backed by the demo workspace's browser-local sample data. */
const LOCAL_DATA_VIEWS: View[] = [
  "portfolio",
  "projects",
  "plans",
  "gates",
  "evidence",
  "clients",
  "audit",
];

function EnvironmentScopeNotice(props: {
  onSwitchToDemo: () => void;
  onNavigate: (view: View) => void;
}) {
  return (
    <div className="content">
      <section className="panel env-scope-notice">
        <p className="eyebrow accent">Production environment</p>
        <h3>This view holds demo sample data</h3>
        <p className="muted">
          The portfolio, projects, plans, gates, evidence, client views, and
          audit explorer are the demo workspace's browser-local sample data,
          so they live in the demo environment. Production delivery projects
          are created from Lead Engine handoffs — watch them arrive in
          Monitoring, and run production automations from the production
          workflow list. The two environments never mix.
        </p>
        <div className="env-scope-actions">
          <button className="primary" onClick={props.onSwitchToDemo}>
            Open the demo environment
          </button>
          <button className="quiet" onClick={() => props.onNavigate("monitoring")}>
            Go to monitoring
          </button>
        </div>
      </section>
    </div>
  );
}

function App() {
  const auth = useAuth();
  const [view, setView] = useState<View>("portfolio");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [environment, setEnvironmentState] =
    useStoredState<DeliveryEnvironment>("raphah.delivery.environment.v1", "demo");
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [notice, setNotice] = useState(
    "Demo and production are separate environments. The demo portfolio is sample data in this browser; workflows & monitoring reflect the live backend for the selected environment.",
  );
  const [projects, setProjects] = useStoredState(
    "raphah.delivery.projects.v2",
    seedProjects,
  );
  const [gates, setGates] = useStoredState(
    "raphah.delivery.gates.v2",
    seedGates,
  );
  const [evidenceRecords, setEvidenceRecords] = useStoredState<
    EvidenceRecord[]
  >("raphah.delivery.evidence.v1", seedEvidence);
  const [reviewTarget, setReviewTarget] = useState<ReviewState | null>(null);
  const [audit, setAudit] = useStoredState<AuditEvent[]>(
    "raphah.delivery.audit.v1",
    [
      {
        id: "audit-seed",
        action: "workspace.opened",
        subject: "Delivery Factory preview workspace",
        at: new Date().toISOString(),
      },
    ],
  );

  const deliveryHealth = useMemo(
    () =>
      projects.length
        ? Math.round(
            projects.reduce(
              (sum, project) =>
                sum + projectProgress(project, gates, evidenceRecords),
              0,
            ) / projects.length,
          )
        : 0,
    [projects, gates, evidenceRecords],
  );
  const evidenceHealth = useMemo(
    () =>
      projects.length
        ? Math.round(
            projects.reduce(
              (sum, project) =>
                sum + evidenceCoverage(project, evidenceRecords),
              0,
            ) / projects.length,
          )
        : 0,
    [projects, evidenceRecords],
  );
  const openGates = gates.filter((gate) => gate.status !== "Approved");

  function record(action: string, subject: string, detail?: string) {
    setAudit((current) =>
      [
        {
          id: crypto.randomUUID(),
          action,
          subject,
          detail,
          at: new Date().toISOString(),
        },
        ...current,
      ].slice(0, 50),
    );
  }

  function resetDemoWorkspace() {
    if (!window.confirm("Reset the demo workspace? This removes local projects, gates, and audit events from this browser.")) return;
    for (const key of [
      "raphah.delivery.projects.v2",
      "raphah.delivery.gates.v2",
      "raphah.delivery.evidence.v1",
      "raphah.delivery.audit.v1",
    ]) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Reload restores the seed data even if removal fails.
      }
    }
    window.location.reload();
  }

  function switchEnvironment(next: DeliveryEnvironment) {
    if (next === environment) return;
    setEnvironmentState(next);
    record("environment.switched", next);
    setNotice(
      next === "demo"
        ? "Demo environment: sample portfolio data and demo-scoped workflows. Nothing here touches production."
        : "Production environment: live workflows and client delivery data. Demo data stays in the demo environment.",
    );
  }

  async function resetDemoData() {
    if (!window.confirm("Reset the demo environment on the server? This clears demo workflow runs, demo projects, and demo handoff records. Demo workflow definitions are kept. Production is never touched.")) return;
    try {
      const token = getAuthToken();
      const res = await fetch("/api/workflows/environments/demo/reset", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      const data = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : `Reset failed (${res.status})`,
        );
      }
      setNotice(
        `Demo environment reset on the server: cleared ${String(data.workflowRuns ?? 0)} workflow runs, ${String(data.projects ?? 0)} projects, ${String(data.inbox ?? 0)} handoff records.`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Demo reset failed");
    }
  }

  function changeView(nextView: View) {
    setView(nextView);
    setNotice(`${viewTitles[nextView]} loaded.`);
  }

  function addProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") || "").trim();
    const client = String(form.get("client") || "").trim();
    if (!name || !client) {
      setNotice("Project name and client are required before creating a project.");
      return;
    }
    const project: Project = {
      id: crypto.randomUUID(),
      name,
      client,
      stage: "Discovery",
      owner: String(form.get("owner") || "DD")
        .trim()
        .slice(0, 2)
        .toUpperCase(),
      due: String(form.get("due") || "TBD"),
      tone: "violet",
      charter: {
        problemStatement:
          "Charter not yet written for this locally created project. Production projects receive their charter from the Lead Engine handoff package.",
        objective: "To be defined with the client before the baseline gate.",
        successCriteria: [],
        risks: [],
      },
    };
    setProjects((current) => [project, ...current]);
    setGates((current) => [
      {
        id: crypto.randomUUID(),
        projectId: project.id,
        label: "Discovery baseline",
        status: "Needs reviewer",
        purpose:
          "Confirms the problem, objective, and success criteria are agreed before the project leaves Discovery.",
        criteria: [],
        stage: "Discovery",
      },
      ...current,
    ]);
    record("project.created", project.name);
    setShowProjectForm(false);
    setView("projects");
    setNotice(`${project.name} was added to the delivery portfolio.`);
  }

  /* ── Review-first actions (Phase 2) ────────────────────────────────
   * Nothing approves, advances, or captures blind anymore: every action
   * opens the review drawer first, and the decision lands here with its
   * rationale written into the audit trail. */

  function openGateReview(gate: Gate) {
    setReviewTarget({ kind: "gate", projectId: gate.projectId, gateId: gate.id });
  }

  function openAdvanceReview(project: Project) {
    if (project.stage === "Complete") return;
    setReviewTarget({ kind: "advance", projectId: project.id });
  }

  function openCaptureReview(project: Project) {
    setReviewTarget({ kind: "evidence", projectId: project.id });
  }

  function openPreview(project: Project) {
    setReviewTarget({ kind: "preview", projectId: project.id });
  }

  function approveGate(gate: Gate, note: string) {
    setGates((current) =>
      current.map((item) =>
        item.id === gate.id ? { ...item, status: "Approved" as const } : item,
      ),
    );
    const project = projects.find((item) => item.id === gate.projectId);
    const covered = coveredCriteria(gate.projectId, evidenceRecords);
    const met = gate.criteria.filter((c) => covered.has(c)).length;
    record(
      "gate.approved",
      `${project?.name || "Project"} · ${gate.label}`,
      `Criteria with evidence: ${met}/${gate.criteria.length}.` +
        (note ? ` Decision note: ${note}` : " No decision note recorded."),
    );
    setNotice(
      `${gate.label} approved after review. The decision and its rationale are in the audit trail.`,
    );
    setReviewTarget(null);
  }

  function advanceProject(project: Project, note: string) {
    if (project.stage === "Complete") return;
    const nextStage =
      STAGE_ORDER[
        Math.min(STAGE_ORDER.indexOf(project.stage) + 1, STAGE_ORDER.length - 1)
      ];
    const blockers = gates.filter(
      (gate) =>
        gate.projectId === project.id &&
        gate.stage === project.stage &&
        gate.status !== "Approved",
    );
    setProjects((current) =>
      current.map((item) =>
        item.id === project.id ? { ...item, stage: nextStage } : item,
      ),
    );
    record(
      "project.stage_changed",
      `${project.name}: ${project.stage} → ${nextStage}`,
      (blockers.length
        ? `Advanced with ${blockers.length} unapproved gate(s) for ${project.stage}: ${blockers.map((g) => g.label).join(", ")}. `
        : `All gates for ${project.stage} were approved. `) +
        (note ? `Decision note: ${note}` : "No decision note recorded."),
    );
    setNotice(
      blockers.length
        ? `${project.name} moved to ${nextStage} with unapproved gates — the override rationale is in the audit trail.`
        : `${project.name} moved to ${nextStage}.`,
    );
    setReviewTarget(null);
  }

  function captureEvidence(
    project: Project,
    draft: {
      title: string;
      checkpointType: EvidenceRecord["checkpointType"];
      gateId: string | null;
      note: string;
      criteria: string[];
    },
  ) {
    const record_: EvidenceRecord = {
      id: crypto.randomUUID(),
      projectId: project.id,
      gateId: draft.gateId,
      title: draft.title,
      checkpointType: draft.checkpointType,
      note: draft.note,
      criteria: draft.criteria,
      capturedBy: "DD",
      at: new Date().toISOString(),
    };
    const nextRecords = [record_, ...evidenceRecords];
    setEvidenceRecords(nextRecords);
    const coverage = evidenceCoverage(project, nextRecords);
    record(
      "evidence.captured",
      `${project.name} · ${draft.title}`,
      `Checkpoint (${draft.checkpointType}) supports ${draft.criteria.length} criteria; coverage is now ${coverage}%.` +
        (draft.note ? ` Note: ${draft.note}` : ""),
    );
    setNotice(
      `Evidence captured for ${project.name}. Coverage is now ${coverage}% — derived from evidence records, not a typed-in number.`,
    );
    setReviewTarget(null);
  }

  return (
    <div className={`app-shell factory-shell env-${environment}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">R</span>
          <span>Raphah</span>
        </div>
        <div className="product-label">
          DELIVERY FACTORY <span>v1</span>
        </div>
        <nav aria-label="Delivery Factory navigation">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "nav-item active" : "nav-item"}
              onClick={() => { changeView(item.id); setMobileNavOpen(false); }}
              aria-current={view === item.id ? "page" : undefined}
            >
              <span>{item.label}</span>
              {environment === "demo" && item.id === "projects" ? (
                <strong>{projects.length}</strong>
              ) : null}
              {environment === "demo" && item.id === "gates" ? (
                <strong>{openGates.length}</strong>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={view === "audit" ? "nav-item active" : "nav-item"}
            onClick={() => changeView("audit")}
          >
            Audit explorer
          </button>
          <button
            className={view === "operations" ? "nav-item active" : "nav-item"}
            onClick={() => changeView("operations")}
          >
            Operations
          </button>
          <div className="user">
            <span>DM</span>
            <div>
              <b>Dude D.</b>
              <small>Delivery lead</small>
            </div>
            <i>•••</i>
          </div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div className="mobile-topbar-row">
            <button className="mobile-menu-button" aria-label="Open navigation" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(true)}>Menu</button>
            <span className="mobile-view-label">{viewTitles[view]}</span>
          </div>
          <div>
            <p className="eyebrow">Delivery operations / {viewTitles[view]}</p>
            <h1>{viewTitles[view]}</h1>
          </div>
          <div className="top-actions">
            <div className="env-switch" role="group" aria-label="Environment">
              <button
                type="button"
                className={environment === "demo" ? "active" : ""}
                aria-pressed={environment === "demo"}
                onClick={() => switchEnvironment("demo")}
              >
                Demo
              </button>
              <button
                type="button"
                className={environment === "production" ? "active" : ""}
                aria-pressed={environment === "production"}
                onClick={() => switchEnvironment("production")}
              >
                Production
              </button>
            </div>
            {environment === "demo" ? (
              <button
                className="primary"
                onClick={() => setShowProjectForm(true)}
              >
                + New project
              </button>
            ) : null}
          </div>
        </header>
        {mobileNavOpen ? (
          <div className="mobile-nav-backdrop" role="presentation" onClick={() => setMobileNavOpen(false)}>
            <nav className="mobile-nav" aria-label="Delivery Factory navigation" onClick={(event) => event.stopPropagation()}>
              <div className="mobile-nav-head"><b>Navigate</b><button className="icon-button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}>×</button></div>
              {[...navItems, { id: "audit" as View, label: "Audit explorer" }, { id: "operations" as View, label: "Operations" }].map((item) => <button key={item.id} className={view === item.id ? "nav-item active" : "nav-item"} aria-current={view === item.id ? "page" : undefined} onClick={() => { changeView(item.id); setMobileNavOpen(false); }}>{item.label}</button>)}
            </nav>
          </div>
        ) : null}
        <div className="status-bar" role="status" aria-live="polite">
          <span className="status-dot" />
          <span className={`pilot-badge env-badge-${environment}`}>
            {environment === "production" ? "Production" : "Demo environment"}
          </span>
          <span>{notice}</span>
          {environment === "demo" ? (
            <>
              <button
                type="button"
                className="status-action"
                onClick={resetDemoWorkspace}
                title="Clear the sample portfolio data from this browser and restore the seed data"
              >
                Reset demo workspace
              </button>
              <button
                type="button"
                className="status-action"
                onClick={() => void resetDemoData()}
                title="Clear demo workflow runs, demo projects, and demo handoff records on the server. Demo workflow definitions are kept; production is never touched"
              >
                Reset demo data
              </button>
            </>
          ) : null}
          <span className="auth-email" title="Signed-in operator">
            {auth.email}
          </span>
          <button
            type="button"
            className="status-action"
            onClick={() => void auth.signOut()}
            title="Sign out of the operator account"
          >
            Sign out
          </button>
          {auth.error ? (
            <span className="auth-error" role="alert">
              {auth.error}
            </span>
          ) : null}
        </div>
        <div className="view-scroll">
        {environment === "demo" && (projects.length === 0 || openGates.length === 0) ? (
          <section className="setup-checklist panel" aria-labelledby="df-setup-heading">
            <div><p className="eyebrow accent">Recommended next steps</p><h2 id="df-setup-heading">Prepare a delivery workspace</h2><p className="muted">Create the project, establish a baseline, then collect evidence before release.</p></div>
            <div className="checklist-grid">
              <button className="checklist-step" onClick={() => setShowProjectForm(true)}><b>1. Create a project</b><span>Give the delivery team a shared record</span></button>
              <button className="checklist-step" onClick={() => changeView("gates")}><b>2. Review delivery gates</b><span>Assign human approval before progression</span></button>
              <button className="checklist-step" onClick={() => changeView("evidence")}><b>3. Capture evidence</b><span>Make release readiness visible</span></button>
            </div>
          </section>
        ) : null}
        {environment === "production" && LOCAL_DATA_VIEWS.includes(view) ? (
          <EnvironmentScopeNotice
            onSwitchToDemo={() => switchEnvironment("demo")}
            onNavigate={changeView}
          />
        ) : view === "portfolio" ? (
          <Portfolio
            projects={projects}
            gates={gates}
            evidenceRecords={evidenceRecords}
            deliveryHealth={deliveryHealth}
            evidenceHealth={evidenceHealth}
            onNavigate={changeView}
            onAdvance={openAdvanceReview}
            onApproveGate={openGateReview}
          />
        ) : view === "workflows" ? (
          <WorkflowsSection environment={environment} />
        ) : view === "monitoring" ? (
          <MonitoringSection />
        ) : (
          <WorkspaceView
            view={view}
            projects={projects}
            gates={gates}
            evidenceRecords={evidenceRecords}
            audit={audit}
            onAdvance={openAdvanceReview}
            onApproveGate={openGateReview}
            onCaptureEvidence={openCaptureReview}
            onPreview={openPreview}
          />
        )}
        </div>
      </main>

      {showProjectForm ? (
        <ProjectDialog
          onClose={() => setShowProjectForm(false)}
          onSubmit={addProject}
        />
      ) : null}
      {reviewTarget ? (
        <ReviewDrawer
          target={reviewTarget}
          projects={projects}
          gates={gates}
          evidenceRecords={evidenceRecords}
          audit={audit}
          onClose={() => setReviewTarget(null)}
          onApproveGate={approveGate}
          onAdvanceProject={advanceProject}
          onCaptureEvidence={captureEvidence}
        />
      ) : null}
    </div>
  );
}

function Portfolio({
  projects,
  gates,
  evidenceRecords,
  deliveryHealth,
  evidenceHealth,
  onNavigate,
  onAdvance,
  onApproveGate,
}: {
  projects: Project[];
  gates: Gate[];
  evidenceRecords: EvidenceRecord[];
  deliveryHealth: number;
  evidenceHealth: number;
  onNavigate: (view: View) => void;
  onAdvance: (project: Project) => void;
  onApproveGate: (gate: Gate) => void;
}) {
  const openGates = gates.filter((gate) => gate.status !== "Approved");
  const readyGate = openGates.find((gate) => gate.status === "Ready to review");
  const readyProject = readyGate
    ? projects.find((project) => project.id === readyGate.projectId)
    : undefined;
  return (
    <div className="content">
      <section className="hero-row">
        <div>
          <p className="eyebrow accent">Portfolio pulse · Browser workspace</p>
          <h2>Make progress visible.</h2>
          <p className="muted">
            {projects.length} active projects. {openGates.length} gates need
            attention.
          </p>
        </div>
        {readyGate ? (
          <button className="release-card" onClick={() => onNavigate("gates")}>
            <span className="release-dot" />
            <span>
              <b>{readyGate.label}</b>
              <small>{readyProject?.name} is ready to review</small>
            </span>
            <span className="release-link">Open gate →</span>
          </button>
        ) : null}
      </section>
      <section className="metrics">
        <Metric
          label="Active projects"
          value={String(projects.length)}
          detail="Independent workspace"
        />
        <Metric
          label="Portfolio progress"
          value={`${deliveryHealth}%`}
          detail="Calculated from projects"
        />
        <Metric
          label="Open decisions"
          value={String(openGates.length)}
          detail="Human approval required"
          warn
        />
        <Metric
          label="Evidence captured"
          value={`${evidenceHealth}%`}
          detail="Across active projects"
        />
      </section>
      <div className="grid-main">
        <section className="panel projects">
          <div className="panel-head">
            <div>
              <h3>Active delivery portfolio</h3>
              <p>Stage, ownership, and next gate</p>
            </div>
            <button
              className="text-button"
              onClick={() => onNavigate("projects")}
            >
              View all projects →
            </button>
          </div>
          <ProjectList
            projects={projects.slice(0, 4)}
            gates={gates}
            evidenceRecords={evidenceRecords}
            onAdvance={onAdvance}
          />
        </section>
        <section className="panel gates">
          <div className="panel-head">
            <div>
              <h3>Gate queue</h3>
              <p>Human approval is required</p>
            </div>
            <span className="queue-count">{openGates.length}</span>
          </div>
          <GateList
            gates={openGates.slice(0, 4)}
            projects={projects}
            onApprove={onApproveGate}
          />
        </section>
      </div>
      <section className="panel bottom-panel">
        <div>
          <p className="eyebrow">Integration health</p>
          <h3>Lead Engine handoff stream</h3>
          <p className="muted">
            Signed Lead Engine handoffs arrive at POST /api/intake (Ed25519 +
            SHA-256 manifest). Product data remains isolated.
          </p>
        </div>
        <div className="stream">
          <span>Contract boundary</span>
          <b>LeadEngineHandoffPackage · v1</b>
          <small>Checksum verification required</small>
        </div>
        <button className="row-action" onClick={() => onNavigate("operations")}>
          Inspect boundary
        </button>
      </section>
    </div>
  );
}

function WorkspaceView({
  view,
  projects,
  gates,
  evidenceRecords,
  audit,
  onAdvance,
  onApproveGate,
  onCaptureEvidence,
  onPreview,
}: {
  view: View;
  projects: Project[];
  gates: Gate[];
  evidenceRecords: EvidenceRecord[];
  audit: AuditEvent[];
  onAdvance: (project: Project) => void;
  onApproveGate: (gate: Gate) => void;
  onCaptureEvidence: (project: Project) => void;
  onPreview: (project: Project) => void;
}) {
  if (view === "projects")
    return (
      <div className="content">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Delivery projects</h3>
              <p>Stage changes are reviewed before they happen, and audited</p>
            </div>
          </div>
          <ProjectList
            projects={projects}
            gates={gates}
            evidenceRecords={evidenceRecords}
            onAdvance={onAdvance}
          />
        </section>
      </div>
    );
  if (view === "plans")
    return (
      <SimpleList
        title="Plans & baselines"
        items={projects.map((item) => ({
          title: `${item.name} implementation plan`,
          detail: `${item.charter.objective} · ${item.stage} · ${projectProgress(item, gates, evidenceRecords)}% complete (calculated)`,
          badge: item.stage,
        }))}
      />
    );
  if (view === "gates")
    return (
      <div className="content">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Delivery gate queue</h3>
              <p>Review decisions are recorded before progression</p>
            </div>
          </div>
          <GateList
            gates={gates}
            projects={projects}
            onApprove={onApproveGate}
          />
        </section>
      </div>
    );
  if (view === "evidence")
    return (
      <div className="content">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Evidence coverage</h3>
              <p>
                Coverage is derived from evidence records against each
                project's charter criteria — capture creates a record, never
                a typed-in percentage
              </p>
            </div>
          </div>
          <div className="record-list">
            {projects.map((project) => {
              const coverage = evidenceCoverage(project, evidenceRecords);
              const records = evidenceRecords.filter(
                (item) => item.projectId === project.id,
              );
              return (
                <div className="record-row" key={project.id}>
                  <div>
                    <b>{project.name}</b>
                    <small>
                      {coverage}% of charter criteria covered ·{" "}
                      {records.length} record{records.length === 1 ? "" : "s"}
                      {records[0] ? ` · latest: ${records[0].title}` : ""}
                    </small>
                  </div>
                  <div className="coverage">
                    <i style={{ width: `${coverage}%` }} />
                  </div>
                  <button
                    className="row-action"
                    onClick={() => onCaptureEvidence(project)}
                  >
                    Capture evidence
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    );
  if (view === "clients")
    return (
      <div className="content">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Client views</h3>
              <p>Preview renders exactly what the client sees</p>
            </div>
          </div>
          <div className="record-list">
            {projects.map((item) => (
              <div className="record-row" key={item.id}>
                <div>
                  <b>{item.client}</b>
                  <small>
                    {item.name} · {projectProgress(item, gates, evidenceRecords)}
                    % delivery progress (calculated)
                  </small>
                </div>
                <button
                  className="row-action"
                  onClick={() => onPreview(item)}
                >
                  Preview
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>
    );
  if (view === "audit")
    return (
      <div className="content">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Local audit trail</h3>
              <p>Delivery decisions captured in this browser workspace</p>
            </div>
          </div>
          <div className="record-list">
            {audit.map((item) => (
              <div className="record-row" key={item.id}>
                <div>
                  <b>{item.action}</b>
                  <small>{item.subject}</small>
                  {item.detail ? (
                    <small className="audit-detail">{item.detail}</small>
                  ) : null}
                </div>
                <time>{new Date(item.at).toLocaleString()}</time>
              </div>
            ))}
          </div>
        </section>
      </div>
    );
  return (
    <SimpleList
      title="Operations status"
      items={[
        {
          title: "Persistence mode",
          detail:
            "Neon-backed Delivery Factory database. Demo and production records are environment-scoped and never mix; only this portfolio's sample data is browser-local.",
          badge: "Live",
        },
        {
          title: "Handoff receiver",
          detail:
            "LeadEngineHandoffPackage/v1 intake is live: signature-verified accepts are stamped with their environment scope, and automation fires only inside that scope.",
          badge: "Live",
        },
        {
          title: "Release authority",
          detail:
            "Human approval remains mandatory for client-impacting actions.",
          badge: "Enforced",
        },
      ]}
    />
  );
}

function ProjectList({
  projects,
  gates,
  evidenceRecords,
  onAdvance,
}: {
  projects: Project[];
  gates: Gate[];
  evidenceRecords: EvidenceRecord[];
  onAdvance: (project: Project) => void;
}) {
  return (
    <div className="project-list">
      {projects.map((project) => {
        const progress = projectProgress(project, gates, evidenceRecords);
        return (
          <div className="project-row" key={project.id}>
            <div className="project-title">
              <span className={`project-icon ${project.tone}`}>
                {project.name.slice(0, 1)}
              </span>
              <div>
                <b>{project.name}</b>
                <small>{project.client}</small>
              </div>
            </div>
            <div className="stage">
              <span>{project.stage}</span>
              <div className="progress">
                <i style={{ width: `${progress}%` }} />
              </div>
              <small>{progress}% complete · calculated</small>
            </div>
            <div className="owner">
              <span>{project.owner}</span>
              <small>Owner</small>
            </div>
            <div className="due">
              <b>{project.due}</b>
              <small>Next gate</small>
            </div>
            <button
              className="row-action project-action"
              onClick={() => onAdvance(project)}
              disabled={project.stage === "Complete"}
            >
              {project.stage === "Complete" ? "Complete" : "Review advance"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function GateList({
  gates,
  projects,
  onApprove,
}: {
  gates: Gate[];
  projects: Project[];
  onApprove: (gate: Gate) => void;
}) {
  return (
    <div>
      {gates.map((gate) => {
        const project = projects.find((item) => item.id === gate.projectId);
        const approved = gate.status === "Approved";
        return (
          <div className="gate" key={gate.id}>
            <span className={`gate-mark ${approved ? "good" : ""}`}>
              {approved ? "✓" : "!"}
            </span>
            <div>
              <b>{gate.label}</b>
              <small>{project?.name || "Unassigned project"}</small>
            </div>
            <span className="gate-status">{gate.status}</span>
            {approved ? (
              <span className="verified">Recorded</span>
            ) : (
              <button className="row-action" onClick={() => onApprove(gate)}>
                Review
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SimpleList({
  title,
  items,
}: {
  title: string;
  items: Array<{ title: string; detail: string; badge: string }>;
}) {
  return (
    <div className="content">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>{title}</h3>
            <p>Current Delivery Factory workspace</p>
          </div>
        </div>
        <div className="record-list">
          {items.map((item) => (
            <div className="record-row" key={item.title}>
              <div>
                <b>{item.title}</b>
                <small>{item.detail}</small>
              </div>
              <span className="queue-count">{item.badge}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ProjectDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">Human-created project</p>
            <h2 id="new-project-title">Create delivery project</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            ×
          </button>
        </div>
        <form onSubmit={onSubmit}>
          <label>
            Project name
            <input
              name="name"
              required
              autoFocus
              placeholder="Northstar implementation"
            />
          </label>
          <label>
            Client
            <input
              name="client"
              required
              placeholder="Northstar Health · NHS"
            />
          </label>
          <div className="form-grid">
            <label>
              Owner initials
              <input name="owner" maxLength={2} defaultValue="DD" />
            </label>
            <label>
              Next gate date
              <input name="due" type="date" />
            </label>
          </div>
          <div className="modal-actions">
            <button type="button" className="quiet" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" type="submit">
              Create project
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  warn = false,
}: {
  label: string;
  value: string;
  detail: string;
  warn?: boolean;
}) {
  return (
    <div className="metric">
      <p>{label}</p>
      <strong>{value}</strong>
      <small className={warn ? "warn" : "up"}>
        {warn ? "• " : "↗ "}
        {detail}
      </small>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <GatedApp />
    </AuthProvider>
  </StrictMode>,
);

/** Operator login gate: the dashboard renders only with a live session. */
function GatedApp() {
  const auth = useAuth();
  if (auth.status === "loading") {
    return (
      <div className="auth-screen">
        <p className="muted">Checking operator session…</p>
      </div>
    );
  }
  if (auth.status === "signed-out") {
    return <LoginScreen />;
  }
  return <App />;
}
