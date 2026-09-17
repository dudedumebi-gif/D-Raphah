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

type View =
  | "overview"
  | "opportunities"
  | "organizations"
  | "discovery"
  | "requirements"
  | "handoffs"
  | "audit"
  | "settings";
type Stage = "New" | "Discovery" | "Qualified" | "Handoff ready";

type Opportunity = {
  id: string;
  name: string;
  signal: string;
  source: string;
  score: number;
  stage: Stage;
  value: number;
};

type AuditEvent = { id: string; action: string; subject: string; at: string };
type Handoff = {
  id: string;
  opportunity: string;
  version: string;
  status: "Draft" | "Ready";
  createdAt: string;
};

const seedOpportunities: Opportunity[] = [
  {
    id: "opp-northstar",
    name: "Northstar Health",
    signal: "New digital intake programme",
    score: 92,
    stage: "Qualified",
    source: "Public tender",
    value: 86000,
  },
  {
    id: "opp-field-form",
    name: "Field & Form",
    signal: "Hiring for operations transformation",
    score: 84,
    stage: "Discovery",
    source: "Referral",
    value: 58000,
  },
  {
    id: "opp-atlas",
    name: "Atlas Civic Lab",
    signal: "Service redesign grant awarded",
    score: 77,
    stage: "New",
    source: "Approved feed",
    value: 42000,
  },
];

const navItems: Array<{ id: View; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "opportunities", label: "Opportunities" },
  { id: "organizations", label: "Organizations" },
  { id: "discovery", label: "Discovery sessions" },
  { id: "requirements", label: "Requirements" },
  { id: "handoffs", label: "Handoffs" },
];

const viewTitles: Record<View, string> = {
  overview: "Opportunity command center",
  opportunities: "Opportunity pipeline",
  organizations: "Organizations",
  discovery: "Discovery sessions",
  requirements: "Requirements",
  handoffs: "Handoff packages",
  audit: "Audit & evidence",
  settings: "Workspace settings",
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
  const [view, setView] = useState<View>("overview");
  const [range, setRange] = useState<"30 days" | "90 days" | "All time">(
    "30 days",
  );
  const [showOpportunityForm, setShowOpportunityForm] = useState(false);
  const [notice, setNotice] = useState(
    "Workspace data is saved in this browser.",
  );
  const [opportunities, setOpportunities] = useStoredState(
    "raphah.lead.opportunities.v1",
    seedOpportunities,
  );
  const [handoffs, setHandoffs] = useStoredState<Handoff[]>(
    "raphah.lead.handoffs.v1",
    [],
  );
  const [audit, setAudit] = useStoredState<AuditEvent[]>(
    "raphah.lead.audit.v1",
    [
      {
        id: "audit-seed",
        action: "workspace.opened",
        subject: "Lead Engine preview workspace",
        at: new Date().toISOString(),
      },
    ],
  );

  const pipelineValue = useMemo(
    () =>
      opportunities
        .filter(
          (item) =>
            item.stage === "Qualified" || item.stage === "Handoff ready",
        )
        .reduce((total, item) => total + item.value, 0),
    [opportunities],
  );
  const qualifiedCount = opportunities.filter(
    (item) => item.stage === "Qualified" || item.stage === "Handoff ready",
  ).length;
  const handoffReady = opportunities.filter(
    (item) => item.stage === "Handoff ready",
  ).length;

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

  function changeView(nextView: View) {
    setView(nextView);
    setNotice(`${viewTitles[nextView]} loaded.`);
  }

  function addOpportunity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const opportunity: Opportunity = {
      id: crypto.randomUUID(),
      name: String(form.get("name") || "").trim(),
      signal: String(form.get("signal") || "").trim(),
      source: String(form.get("source") || "").trim(),
      value: Number(form.get("value") || 0),
      score: Number(form.get("score") || 50),
      stage: "New",
    };
    if (!opportunity.name || !opportunity.signal || !opportunity.source) return;
    setOpportunities((current) => [opportunity, ...current]);
    record("opportunity.created", opportunity.name);
    setShowOpportunityForm(false);
    setView("opportunities");
    setNotice(`${opportunity.name} was added to the pipeline.`);
  }

  function advanceOpportunity(opportunity: Opportunity) {
    const order: Stage[] = ["New", "Discovery", "Qualified", "Handoff ready"];
    const nextStage =
      order[Math.min(order.indexOf(opportunity.stage) + 1, order.length - 1)];
    setOpportunities((current) =>
      current.map((item) =>
        item.id === opportunity.id ? { ...item, stage: nextStage } : item,
      ),
    );
    record(
      "opportunity.stage_changed",
      `${opportunity.name}: ${opportunity.stage} → ${nextStage}`,
    );
    setNotice(`${opportunity.name} moved to ${nextStage}.`);
  }

  function createHandoff(opportunity: Opportunity) {
    const packageRecord: Handoff = {
      id: `handoff-${crypto.randomUUID()}`,
      opportunity: opportunity.name,
      version: "1.0.0",
      status: "Draft",
      createdAt: new Date().toISOString(),
    };
    setHandoffs((current) => [packageRecord, ...current]);
    record("handoff.draft_created", opportunity.name);
    setView("handoffs");
    setNotice(
      `Draft handoff created for ${opportunity.name}. Human approval is still required.`,
    );
  }

  function approveHandoff(handoff: Handoff) {
    setHandoffs((current) =>
      current.map((item) =>
        item.id === handoff.id ? { ...item, status: "Ready" } : item,
      ),
    );
    record("handoff.approved", `${handoff.opportunity} · ${handoff.version}`);
    setNotice(
      `${handoff.opportunity} handoff is ready for controlled delivery.`,
    );
  }

  return (
    <div className="app-shell lead-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">R</span>
          <span>Raphah</span>
        </div>
        <div className="product-label">
          LEAD ENGINE <span>v1</span>
        </div>
        <nav aria-label="Lead Engine navigation">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "nav-item active" : "nav-item"}
              onClick={() => changeView(item.id)}
              aria-pressed={view === item.id}
            >
              <span>{item.label}</span>
              {item.id === "opportunities" ? (
                <strong>{opportunities.length}</strong>
              ) : null}
              {item.id === "handoffs" && handoffs.length ? (
                <strong className="green">{handoffs.length}</strong>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={view === "audit" ? "nav-item active" : "nav-item"}
            onClick={() => changeView("audit")}
          >
            Audit & evidence
          </button>
          <button
            className={view === "settings" ? "nav-item active" : "nav-item"}
            onClick={() => changeView("settings")}
          >
            Settings
          </button>
          <div className="user">
            <span>DM</span>
            <div>
              <b>Dude D.</b>
              <small>Operator</small>
            </div>
            <i>•••</i>
          </div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">Workspace / Revenue pipeline</p>
            <h1>{viewTitles[view]}</h1>
          </div>
          <div className="top-actions">
            <button
              className="quiet"
              onClick={() =>
                setRange((current) =>
                  current === "30 days"
                    ? "90 days"
                    : current === "90 days"
                      ? "All time"
                      : "30 days",
                )
              }
            >
              {range}⌄
            </button>
            <button
              className="primary"
              onClick={() => setShowOpportunityForm(true)}
            >
              + New opportunity
            </button>
          </div>
        </header>
        <div className="status-bar" role="status">
          <span className="status-dot" />
          {notice}
        </div>
        {view === "overview" ? (
          <Overview
            opportunities={opportunities}
            pipelineValue={pipelineValue}
            qualifiedCount={qualifiedCount}
            handoffReady={handoffReady}
            onViewPipeline={() => changeView("opportunities")}
            onAdvance={advanceOpportunity}
            onCreateHandoff={createHandoff}
            onNavigate={changeView}
          />
        ) : (
          <WorkspaceView
            view={view}
            opportunities={opportunities}
            handoffs={handoffs}
            audit={audit}
            onAdvance={advanceOpportunity}
            onCreateHandoff={createHandoff}
            onApproveHandoff={approveHandoff}
          />
        )}
      </main>

      {showOpportunityForm ? (
        <OpportunityDialog
          onClose={() => setShowOpportunityForm(false)}
          onSubmit={addOpportunity}
        />
      ) : null}
    </div>
  );
}

function Overview({
  opportunities,
  pipelineValue,
  qualifiedCount,
  handoffReady,
  onViewPipeline,
  onAdvance,
  onCreateHandoff,
  onNavigate,
}: {
  opportunities: Opportunity[];
  pipelineValue: number;
  qualifiedCount: number;
  handoffReady: number;
  onViewPipeline: () => void;
  onAdvance: (opportunity: Opportunity) => void;
  onCreateHandoff: (opportunity: Opportunity) => void;
  onNavigate: (view: View) => void;
}) {
  return (
    <div className="content">
      <section className="hero-row">
        <div>
          <p className="eyebrow accent">
            {new Intl.DateTimeFormat("en-GB", { dateStyle: "full" }).format(
              new Date(),
            )}
          </p>
          <h2>Good morning, Dude.</h2>
          <p className="muted">
            Your pipeline is moving. Review evidence before advancing any
            opportunity.
          </p>
        </div>
        <button className="signal-box" onClick={() => onNavigate("audit")}>
          <span className="pulse" />
          <span>
            <b>Source health</b>
            <small>Approved-source preview data</small>
          </span>
          <span className="arrow">↗</span>
        </button>
      </section>
      <section className="metrics">
        <Metric
          label="Qualified pipeline"
          value={formatCurrency(pipelineValue)}
          change={`${qualifiedCount} qualified`}
        />
        <Metric
          label="Open opportunities"
          value={String(opportunities.length)}
          change="Browser workspace"
        />
        <Metric
          label="Discovery sessions"
          value={String(
            opportunities.filter((item) => item.stage === "Discovery").length,
          )}
          change="Human notes required"
          warn
        />
        <Metric
          label="Handoff readiness"
          value={String(handoffReady)}
          change="Approved baseline required"
        />
      </section>
      <div className="grid-main">
        <section className="panel opportunities">
          <div className="panel-head">
            <div>
              <h3>Priority opportunities</h3>
              <p>Ranked by fit, evidence, and recency</p>
            </div>
            <button className="text-button" onClick={onViewPipeline}>
              View pipeline →
            </button>
          </div>
          <OpportunityTable
            opportunities={opportunities.slice(0, 4)}
            onAdvance={onAdvance}
            onCreateHandoff={onCreateHandoff}
          />
        </section>
        <section className="panel activity">
          <div className="panel-head">
            <div>
              <h3>Today’s focus</h3>
              <p>Human actions keep the system honest</p>
            </div>
          </div>
          <button className="focus-item" onClick={() => onNavigate("audit")}>
            <span className="icon amber">!</span>
            <span>
              <b>Validate source findings</b>
              <small>Review evidence before promotion</small>
            </span>
            <span>›</span>
          </button>
          <button
            className="focus-item"
            onClick={() => onNavigate("discovery")}
          >
            <span className="icon blue">◷</span>
            <span>
              <b>Complete discovery notes</b>
              <small>Sessions need human validation</small>
            </span>
            <span>›</span>
          </button>
          <button className="focus-item" onClick={() => onNavigate("handoffs")}>
            <span className="icon green">✓</span>
            <span>
              <b>Approve handoff baseline</b>
              <small>{handoffReady} package candidates</small>
            </span>
            <span>›</span>
          </button>
        </section>
      </div>
    </div>
  );
}

function WorkspaceView({
  view,
  opportunities,
  handoffs,
  audit,
  onAdvance,
  onCreateHandoff,
  onApproveHandoff,
}: {
  view: View;
  opportunities: Opportunity[];
  handoffs: Handoff[];
  audit: AuditEvent[];
  onAdvance: (opportunity: Opportunity) => void;
  onCreateHandoff: (opportunity: Opportunity) => void;
  onApproveHandoff: (handoff: Handoff) => void;
}) {
  if (view === "opportunities")
    return (
      <div className="content">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>All opportunities</h3>
              <p>Progress requires an explicit operator action</p>
            </div>
          </div>
          <OpportunityTable
            opportunities={opportunities}
            onAdvance={onAdvance}
            onCreateHandoff={onCreateHandoff}
          />
        </section>
      </div>
    );
  if (view === "organizations")
    return (
      <SimpleList
        title="Organizations"
        items={opportunities.map((item) => ({
          title: item.name,
          detail: `${item.source} · ${item.signal}`,
          badge: `${item.score} fit`,
        }))}
      />
    );
  if (view === "discovery")
    return (
      <SimpleList
        title="Discovery sessions"
        items={opportunities
          .filter((item) => item.stage !== "New")
          .map((item) => ({
            title: `${item.name} discovery`,
            detail: "Notes remain editable until human approval.",
            badge: item.stage,
          }))}
        empty="Advance an opportunity to Discovery to create a session."
      />
    );
  if (view === "requirements")
    return (
      <SimpleList
        title="Requirements workspace"
        items={opportunities
          .filter(
            (item) =>
              item.stage === "Qualified" || item.stage === "Handoff ready",
          )
          .map((item) => ({
            title: `${item.name} baseline`,
            detail: "Must items require a named human validator.",
            badge: "Validation required",
          }))}
        empty="Qualified opportunities will appear here."
      />
    );
  if (view === "handoffs")
    return (
      <div className="content">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Versioned handoff packages</h3>
              <p>Drafts remain inside Lead Engine until approved</p>
            </div>
          </div>
          <div className="record-list">
            {handoffs.length ? (
              handoffs.map((item) => (
                <div className="record-row" key={item.id}>
                  <div>
                    <b>{item.opportunity}</b>
                    <small>
                      Contract v{item.version} ·{" "}
                      {new Date(item.createdAt).toLocaleString()}
                    </small>
                  </div>
                  <span
                    className={`badge ${item.status === "Ready" ? "qualified" : "discovery"}`}
                  >
                    {item.status}
                  </span>
                  {item.status === "Draft" ? (
                    <button
                      className="row-action"
                      onClick={() => onApproveHandoff(item)}
                    >
                      Approve
                    </button>
                  ) : (
                    <span className="verified">Human approved</span>
                  )}
                </div>
              ))
            ) : (
              <p className="empty-state">
                Create a package from a qualified opportunity in the pipeline.
              </p>
            )}
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
              <p>Operator actions captured in this browser workspace</p>
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
      title="Workspace configuration"
      items={[
        {
          title: "Persistence mode",
          detail:
            "Browser-local preview until Supabase environment variables are provisioned.",
          badge: "Preview",
        },
        {
          title: "Automation policy",
          detail:
            "Human approval remains required for source, outreach, baseline, and handoff decisions.",
          badge: "Enforced",
        },
      ]}
    />
  );
}

function OpportunityTable({
  opportunities,
  onAdvance,
  onCreateHandoff,
}: {
  opportunities: Opportunity[];
  onAdvance: (item: Opportunity) => void;
  onCreateHandoff: (item: Opportunity) => void;
}) {
  return (
    <div className="table">
      <div className="table-head">
        <span>Opportunity</span>
        <span>Signal</span>
        <span>Fit score</span>
        <span>Stage / action</span>
      </div>
      {opportunities.map((item) => (
        <div className="table-row" key={item.id}>
          <div className="op-name">
            <span className="avatar">
              {item.name.slice(0, 2).toUpperCase()}
            </span>
            <div>
              <b>{item.name}</b>
              <small>
                {item.source} · {formatCurrency(item.value)}
              </small>
            </div>
          </div>
          <span className="signal">{item.signal}</span>
          <span className="score">
            <i style={{ width: `${Math.min(item.score, 100) / 2.4}px` }} />
            {item.score}
          </span>
          <span className="stage-action">
            <span
              className={`badge ${item.stage.toLowerCase().replace(" ", "-")}`}
            >
              {item.stage}
            </span>
            {item.stage === "Qualified" || item.stage === "Handoff ready" ? (
              <button
                className="row-action"
                onClick={() => onCreateHandoff(item)}
              >
                Handoff
              </button>
            ) : (
              <button className="row-action" onClick={() => onAdvance(item)}>
                Advance
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function SimpleList({
  title,
  items,
  empty = "No records yet.",
}: {
  title: string;
  items: Array<{ title: string; detail: string; badge: string }>;
  empty?: string;
}) {
  return (
    <div className="content">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>{title}</h3>
            <p>Current Lead Engine workspace</p>
          </div>
        </div>
        <div className="record-list">
          {items.length ? (
            items.map((item) => (
              <div className="record-row" key={item.title}>
                <div>
                  <b>{item.title}</b>
                  <small>{item.detail}</small>
                </div>
                <span className="badge discovery">{item.badge}</span>
              </div>
            ))
          ) : (
            <p className="empty-state">{empty}</p>
          )}
        </div>
      </section>
    </div>
  );
}

function OpportunityDialog({
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
        aria-labelledby="new-opportunity-title"
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">Human-entered opportunity</p>
            <h2 id="new-opportunity-title">Add opportunity</h2>
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
            Organization
            <input
              name="name"
              required
              autoFocus
              placeholder="Northstar Health"
            />
          </label>
          <label>
            Opportunity signal
            <textarea
              name="signal"
              required
              placeholder="What changed, and why now?"
            />
          </label>
          <div className="form-grid">
            <label>
              Source
              <input
                name="source"
                required
                placeholder="Approved public source"
              />
            </label>
            <label>
              Estimated value (£)
              <input
                name="value"
                type="number"
                min="0"
                step="1000"
                defaultValue="25000"
              />
            </label>
          </div>
          <label>
            Initial fit score
            <input
              name="score"
              type="number"
              min="0"
              max="100"
              defaultValue="60"
            />
          </label>
          <div className="modal-actions">
            <button type="button" className="quiet" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" type="submit">
              Create opportunity
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
  change,
  warn = false,
}: {
  label: string;
  value: string;
  change: string;
  warn?: boolean;
}) {
  return (
    <div className="metric">
      <p>{label}</p>
      <strong>{value}</strong>
      <small className={warn ? "warn" : "up"}>
        {warn ? "• " : "↗ "}
        {change}
      </small>
    </div>
  );
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
    notation: value >= 1_000_000 ? "compact" : "standard",
  }).format(value);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
