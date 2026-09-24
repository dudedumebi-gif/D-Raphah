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
import { WorkflowsSection } from "./workflows";
import { MonitoringSection } from "./monitoring";
import { AuthProvider, LoginScreen, useAuth } from "./auth";

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
type ProjectStage =
  "Discovery" | "Plan" | "Build" | "Ready for release" | "Complete";

type Project = {
  id: string;
  name: string;
  client: string;
  stage: ProjectStage;
  progress: number;
  owner: string;
  due: string;
  tone: "violet" | "amber" | "green";
  evidence: number;
};

type Gate = {
  id: string;
  projectId: string;
  label: string;
  status: "Needs reviewer" | "Client response" | "Ready to review" | "Approved";
};
type AuditEvent = { id: string; action: string; subject: string; at: string };

const seedProjects: Project[] = [
  {
    id: "project-northstar",
    name: "Northstar Health",
    client: "Northstar Health · NHS",
    stage: "Build",
    progress: 72,
    owner: "AM",
    due: "Sep 26",
    tone: "violet",
    evidence: 86,
  },
  {
    id: "project-field-form",
    name: "Field & Form",
    client: "Field & Form · Retail",
    stage: "Discovery",
    progress: 34,
    owner: "JT",
    due: "Oct 04",
    tone: "amber",
    evidence: 54,
  },
  {
    id: "project-atlas",
    name: "Atlas Civic Lab",
    client: "Atlas Civic Lab · Public",
    stage: "Ready for release",
    progress: 94,
    owner: "SK",
    due: "Sep 20",
    tone: "green",
    evidence: 100,
  },
];

const seedGates: Gate[] = [
  {
    id: "gate-release",
    projectId: "project-atlas",
    label: "Release readiness",
    status: "Ready to review",
  },
  {
    id: "gate-scope",
    projectId: "project-northstar",
    label: "Scope clarification",
    status: "Client response",
  },
  {
    id: "gate-architecture",
    projectId: "project-field-form",
    label: "Architecture baseline",
    status: "Needs reviewer",
  },
  {
    id: "gate-evidence",
    projectId: "project-northstar",
    label: "Test evidence",
    status: "Needs reviewer",
  },
];

const navItems: Array<{ id: View; label: string }> = [
  { id: "portfolio", label: "Portfolio" },
  { id: "projects", label: "Projects" },
  { id: "plans", label: "Plans & baselines" },
  { id: "gates", label: "Delivery gates" },
  { id: "evidence", label: "Evidence library" },
  { id: "clients", label: "Client views" },
  { id: "workflows", label: "⚙️ Automations" },
  { id: "monitoring", label: "📡 Monitoring" },
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

function App() {
  const auth = useAuth();
  const [view, setView] = useState<View>("portfolio");
  const [workspace, setWorkspace] = useState<"All workspaces" | "Active only">(
    "All workspaces",
  );
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [notice, setNotice] = useState(
    "Portfolio data is sample data saved in this browser. Workflows & Monitoring reflect the live backend.",
  );
  const [projects, setProjects] = useStoredState(
    "raphah.delivery.projects.v1",
    seedProjects,
  );
  const [gates, setGates] = useStoredState(
    "raphah.delivery.gates.v1",
    seedGates,
  );
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
            projects.reduce((sum, project) => sum + project.progress, 0) /
              projects.length,
          )
        : 0,
    [projects],
  );
  const evidenceHealth = useMemo(
    () =>
      projects.length
        ? Math.round(
            projects.reduce((sum, project) => sum + project.evidence, 0) /
              projects.length,
          )
        : 0,
    [projects],
  );
  const openGates = gates.filter((gate) => gate.status !== "Approved");

  function record(action: string, subject: string) {
    setAudit((current) =>
      [
        {
          id: crypto.randomUUID(),
          action,
          subject,
          at: new Date().toISOString(),
        },
        ...current,
      ].slice(0, 50),
    );
  }

  function resetDemoWorkspace() {
    for (const key of [
      "raphah.delivery.projects.v1",
      "raphah.delivery.gates.v1",
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

  function changeView(nextView: View) {
    setView(nextView);
    setNotice(`${viewTitles[nextView]} loaded.`);
  }

  function addProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") || "").trim();
    const client = String(form.get("client") || "").trim();
    if (!name || !client) return;
    const project: Project = {
      id: crypto.randomUUID(),
      name,
      client,
      stage: "Discovery",
      progress: 10,
      owner: String(form.get("owner") || "DD")
        .trim()
        .slice(0, 2)
        .toUpperCase(),
      due: String(form.get("due") || "TBD"),
      tone: "violet",
      evidence: 0,
    };
    setProjects((current) => [project, ...current]);
    setGates((current) => [
      {
        id: crypto.randomUUID(),
        projectId: project.id,
        label: "Discovery baseline",
        status: "Needs reviewer",
      },
      ...current,
    ]);
    record("project.created", project.name);
    setShowProjectForm(false);
    setView("projects");
    setNotice(`${project.name} was added to the delivery portfolio.`);
  }

  function advanceProject(project: Project) {
    const order: ProjectStage[] = [
      "Discovery",
      "Plan",
      "Build",
      "Ready for release",
      "Complete",
    ];
    const nextStage =
      order[Math.min(order.indexOf(project.stage) + 1, order.length - 1)];
    const progress =
      nextStage === "Complete" ? 100 : Math.min(95, project.progress + 20);
    setProjects((current) =>
      current.map((item) =>
        item.id === project.id ? { ...item, stage: nextStage, progress } : item,
      ),
    );
    record(
      "project.stage_changed",
      `${project.name}: ${project.stage} → ${nextStage}`,
    );
    setNotice(`${project.name} moved to ${nextStage}.`);
  }

  function approveGate(gate: Gate) {
    setGates((current) =>
      current.map((item) =>
        item.id === gate.id ? { ...item, status: "Approved" } : item,
      ),
    );
    const project = projects.find((item) => item.id === gate.projectId);
    record("gate.approved", `${project?.name || "Project"} · ${gate.label}`);
    setNotice(
      `${gate.label} approved. The decision is recorded in the local audit trail.`,
    );
  }

  function captureEvidence(project: Project) {
    setProjects((current) =>
      current.map((item) =>
        item.id === project.id
          ? { ...item, evidence: Math.min(100, item.evidence + 10) }
          : item,
      ),
    );
    record("evidence.captured", project.name);
    setNotice(`Evidence coverage for ${project.name} increased by 10%.`);
  }

  return (
    <div className="app-shell factory-shell">
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
              onClick={() => changeView(item.id)}
              aria-pressed={view === item.id}
            >
              <span>{item.label}</span>
              {item.id === "projects" ? (
                <strong>{projects.length}</strong>
              ) : null}
              {item.id === "gates" ? <strong>{openGates.length}</strong> : null}
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
          <div>
            <p className="eyebrow">Delivery operations / {viewTitles[view]}</p>
            <h1>{viewTitles[view]}</h1>
          </div>
          <div className="top-actions">
            <button
              className="quiet"
              onClick={() =>
                setWorkspace((current) =>
                  current === "All workspaces"
                    ? "Active only"
                    : "All workspaces",
                )
              }
            >
              {workspace}⌄
            </button>
            <button
              className="primary"
              onClick={() => setShowProjectForm(true)}
            >
              + New project
            </button>
          </div>
        </header>
        <div className="status-bar" role="status">
          <span className="status-dot" />
          <span className="pilot-badge">Pilot demo</span>
          <span>{notice}</span>
          <button
            type="button"
            className="status-action"
            onClick={resetDemoWorkspace}
            title="Clear the sample portfolio data from this browser and restore the seed data"
          >
            Reset demo workspace
          </button>
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
        </div>
        {view === "portfolio" ? (
          <Portfolio
            projects={projects}
            gates={gates}
            deliveryHealth={deliveryHealth}
            evidenceHealth={evidenceHealth}
            onNavigate={changeView}
            onAdvance={advanceProject}
            onApproveGate={approveGate}
          />
        ) : view === "workflows" ? (
          <WorkflowsSection />
        ) : view === "monitoring" ? (
          <MonitoringSection />
        ) : (
          <WorkspaceView
            view={view}
            projects={projects}
            gates={gates}
            audit={audit}
            onAdvance={advanceProject}
            onApproveGate={approveGate}
            onCaptureEvidence={captureEvidence}
          />
        )}
      </main>

      {showProjectForm ? (
        <ProjectDialog
          onClose={() => setShowProjectForm(false)}
          onSubmit={addProject}
        />
      ) : null}
    </div>
  );
}

function Portfolio({
  projects,
  gates,
  deliveryHealth,
  evidenceHealth,
  onNavigate,
  onAdvance,
  onApproveGate,
}: {
  projects: Project[];
  gates: Gate[];
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
          <ProjectList projects={projects.slice(0, 4)} onAdvance={onAdvance} />
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
  audit,
  onAdvance,
  onApproveGate,
  onCaptureEvidence,
}: {
  view: View;
  projects: Project[];
  gates: Gate[];
  audit: AuditEvent[];
  onAdvance: (project: Project) => void;
  onApproveGate: (gate: Gate) => void;
  onCaptureEvidence: (project: Project) => void;
}) {
  if (view === "projects")
    return (
      <div className="content">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Delivery projects</h3>
              <p>Stage changes are explicit and audited</p>
            </div>
          </div>
          <ProjectList projects={projects} onAdvance={onAdvance} />
        </section>
      </div>
    );
  if (view === "plans")
    return (
      <SimpleList
        title="Plans & baselines"
        items={projects.map((item) => ({
          title: `${item.name} implementation plan`,
          detail: `${item.stage} · ${item.progress}% complete`,
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
              <p>Capture a new evidence checkpoint for a project</p>
            </div>
          </div>
          <div className="record-list">
            {projects.map((project) => (
              <div className="record-row" key={project.id}>
                <div>
                  <b>{project.name}</b>
                  <small>{project.evidence}% of critical gates covered</small>
                </div>
                <div className="coverage">
                  <i style={{ width: `${project.evidence}%` }} />
                </div>
                <button
                  className="row-action"
                  onClick={() => onCaptureEvidence(project)}
                >
                  Capture +10%
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>
    );
  if (view === "clients")
    return (
      <SimpleList
        title="Client views"
        items={projects.map((item) => ({
          title: item.client,
          detail: `${item.name} · ${item.progress}% delivery progress`,
          badge: "Preview",
        }))}
      />
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
            "Browser-local preview until the dedicated Delivery Supabase project is provisioned.",
          badge: "Preview",
        },
        {
          title: "Handoff receiver",
          detail:
            "Versioned contract exists; authenticated production endpoint is not configured.",
          badge: "Pending env",
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
  onAdvance,
}: {
  projects: Project[];
  onAdvance: (project: Project) => void;
}) {
  return (
    <div className="project-list">
      {projects.map((project) => (
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
              <i style={{ width: `${project.progress}%` }} />
            </div>
            <small>{project.progress}% complete</small>
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
            {project.stage === "Complete" ? "Complete" : "Advance"}
          </button>
        </div>
      ))}
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
                Approve
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
