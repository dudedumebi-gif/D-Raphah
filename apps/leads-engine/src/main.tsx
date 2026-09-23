import {
  FormEvent,
  StrictMode,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  apiRequest,
  cacheBootstrap,
  cachedBootstrap,
  isNeonConfigured,
  neonClient,
  type BootstrapData,
  type JobRecord,
  type LeadRecord,
  type Membership,
  type Session,
} from "./api";
import { Settings } from "./CriteriaSettings";
import { JobLiveWindow } from "./JobLiveWindow";
import "./styles.css";
import "./functionality.css";

type View =
  | "overview"
  | "sources"
  | "jobs"
  | "leads"
  | "operations"
  | "audit"
  | "settings";
type Mutate = <T>(
  path: string,
  init: RequestInit,
  success: string,
) => Promise<T | null>;
const views: Array<{ id: View; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "sources", label: "Sources & policies" },
  { id: "jobs", label: "Scrape jobs" },
  { id: "leads", label: "Qualified leads" },
  { id: "operations", label: "Operations" },
  { id: "audit", label: "Audit log" },
  { id: "settings", label: "Criteria & schedule" },
];

function workspaceName(membership: Membership): string {
  const value = membership.workspaces;
  return (
    (Array.isArray(value) ? value[0]?.name : value?.name) ?? "Lead workspace"
  );
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    if (!neonClient) {
      setChecking(false);
      return;
    }
    void neonClient.auth.getSession().then(({ data }) => {
      setSession(data.session as Session | null);
      setChecking(false);
    });
    const { data } = neonClient.auth.onAuthStateChange((_event, next) =>
      setSession(next as Session | null),
    );
    return () => data.subscription.unsubscribe();
  }, []);
  if (!isNeonConfigured) return <SetupRequired />;
  if (checking)
    return (
      <Centered
        title="Opening Lead Engine…"
        detail="Validating your secure session."
      />
    );
  if (!session) return <SignIn />;
  return <Workspace key={session.user.id} session={session} />;
}

function SetupRequired() {
  return (
    <Centered
      title="Production connection required"
      detail="Connect Neon and add the Data API/Auth environment variables to this Vercel project, then redeploy."
    >
      <div className="setup-list">
        <code>VITE_NEON_AUTH_URL</code>
        <code>VITE_NEON_DATA_API_URL</code>
        <code>DATABASE_URL</code>
        <code>QSTASH_TOKEN + signing keys</code>
      </div>
    </Centered>
  );
}

function SignIn() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    setBusy(true);
    setMessage("");
    const result =
      mode === "signin"
        ? await neonClient!.auth.signInWithPassword({ email, password })
        : await neonClient!.auth.signUp({
            email,
            password,
            options: { data: { workspace_name: "Raphah Lead Workspace" } },
          });
    setBusy(false);
    if (result.error) setMessage(result.error.message);
    else if (mode === "signup" && !result.data.session)
      setMessage("Check your email to confirm the account.");
  }
  return (
    <Centered
      title="Raphah Lead Engine"
      detail="Secure opportunity intelligence and evidence operations."
    >
      <form className="auth-form" onSubmit={submit}>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            minLength={8}
            autoComplete={
              mode === "signin" ? "current-password" : "new-password"
            }
            required
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy
            ? "Please wait…"
            : mode === "signin"
              ? "Sign in"
              : "Create workspace"}
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
        >
          {mode === "signin"
            ? "Create a new account"
            : "Use an existing account"}
        </button>
        {message ? <p className="form-message">{message}</p> : null}
      </form>
    </Centered>
  );
}

function Workspace({ session }: { session: Session }) {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [workspaceId, setWorkspaceId] = useState(
    localStorage.getItem("raphah.lead.workspace") ?? "",
  );
  const [data, setData] = useState<BootstrapData | null>(() =>
    workspaceId ? cachedBootstrap(workspaceId, session.user.id) : null,
  );
  const [view, setView] = useState<View>("overview");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(
    "Connecting to the production data plane…",
  );

  useEffect(() => {
    void (async () => {
      const bootstrap = await neonClient!.rpc("ensure_personal_workspace", {
        p_name: "Raphah Lead Workspace",
      });
      if (bootstrap.error) {
        setNotice(bootstrap.error.message);
        return;
      }
      const result = await neonClient!
        .from("workspace_memberships")
        .select("workspace_id,role,workspaces(name)")
        .eq("user_id", session.user.id)
        .eq("status", "active");
      if (result.error) {
        setNotice(result.error.message);
        return;
      }
      const rows = (result.data ?? []) as unknown as Membership[];
      setMemberships(rows);
      setWorkspaceId((current) => current || rows[0]?.workspace_id || "");
    })();
  }, [session.user.id]);

  const refresh = useCallback(
    async (quiet = false) => {
      if (!workspaceId) return;
      if (!quiet) setBusy(true);
      try {
        const result = await apiRequest<BootstrapData>(
          session,
          workspaceId,
          "/api/v1/bootstrap",
        );
        setData(result);
        cacheBootstrap(workspaceId, result);
        setNotice(
          `Live data synchronized at ${new Date().toLocaleTimeString()}.`,
        );
      } catch (error) {
        setNotice(
          `${error instanceof Error ? error.message : String(error)}${cachedBootstrap(workspaceId, session.user.id) ? " — showing the last local mirror." : ""}`,
        );
      } finally {
        setBusy(false);
      }
    },
    [session, workspaceId],
  );

  useEffect(() => {
    if (!workspaceId) return;
    localStorage.setItem("raphah.lead.workspace", workspaceId);
    setData(cachedBootstrap(workspaceId, session.user.id));
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(true);
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [workspaceId, refresh]);

  async function mutate<T>(
    path: string,
    init: RequestInit,
    success: string,
  ): Promise<T | null> {
    setBusy(true);
    try {
      const result = await apiRequest<T>(session, workspaceId, path, init);
      setNotice(success);
      await refresh(true);
      return result;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (!memberships.length && !data)
    return (
      <Centered
        title="Workspace initializing"
        detail="No active workspace membership was found. Confirm the Neon migration, Auth, and Data API are enabled."
      />
    );
  const activeMembership =
    memberships.find((item) => item.workspace_id === workspaceId) ??
    memberships[0];
  return (
    <div className="app-shell lead-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">R</span>
          <span>Raphah</span>
        </div>
        <div className="product-label">
          LEAD ENGINE <span>v3</span>
        </div>
        <nav>
          {views.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "nav-item active" : "nav-item"}
              onClick={() => setView(item.id)}
            >
              <span>{item.label}</span>
              {item.id === "jobs" && data ? (
                <strong>{data.jobs.length}</strong>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <select
            className="workspace-select"
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            {memberships.map((item) => (
              <option value={item.workspace_id} key={item.workspace_id}>
                {workspaceName(item)}
              </option>
            ))}
          </select>
          <div className="user">
            <span>{session.user.email?.slice(0, 2).toUpperCase()}</span>
            <div>
              <b>{session.user.email}</b>
              <small>{activeMembership?.role ?? data?.actor.role}</small>
            </div>
          </div>
          <button
            className="nav-item"
            onClick={() => void neonClient!.auth.signOut()}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">Workspace / Automation intelligence</p>
            <h1>{views.find((item) => item.id === view)?.label}</h1>
          </div>
          <div className="top-actions">
            <button
              className="quiet"
              disabled={busy}
              onClick={() => void refresh()}
            >
              {busy ? "Working…" : "Refresh"}
            </button>
          </div>
        </header>
        <div className="status-bar" role="status">
          <span className="status-dot" />
          {notice}
        </div>
        {!data ? (
          <Centered
            title="Loading workspace"
            detail="Fetching sources, jobs, leads, and telemetry."
          />
        ) : (
          <DashboardView
            view={view}
            data={data}
            mutate={mutate}
            session={session}
            workspaceId={workspaceId}
          />
        )}
      </main>
    </div>
  );
}

function DashboardView({
  view,
  data,
  mutate,
  session,
  workspaceId,
}: {
  view: View;
  data: BootstrapData;
  mutate: Mutate;
  session: Session;
  workspaceId: string;
}) {
  if (view === "sources") return <Sources data={data} mutate={mutate} />;
  if (view === "jobs")
    return (
      <Jobs data={data} mutate={mutate} session={session} workspaceId={workspaceId} />
    );
  if (view === "leads") return <Leads data={data} mutate={mutate} />;
  if (view === "operations") return <Operations data={data} />;
  if (view === "audit") return <Audit data={data} />;
  if (view === "settings") return <Settings data={data} mutate={mutate} />;
  const complete = data.jobs.filter((job) => job.status === "completed").length;
  const active = data.jobs.filter((job) =>
    ["queued", "leased", "running", "retrying"].includes(job.status),
  ).length;
  return (
    <div className="content">
      <section className="hero-row">
        <div>
          <p className="eyebrow accent">Production workspace</p>
          <h2>Find the businesses ready for meaningful automation.</h2>
          <p className="muted">
            Permitted evidence becomes explainable signals, maturity scores, and
            reviewable leads.
          </p>
        </div>
        <HealthBadge data={data} />
      </section>
      <section className="metrics">
        <Metric
          label="Approved sources"
          value={String(
            data.sources.filter((s) => s.status === "active").length,
          )}
          detail={`${data.sources.length} configured`}
        />
        <Metric
          label="Active jobs"
          value={String(active)}
          detail={`${complete} completed`}
        />
        <Metric
          label="Qualified leads"
          value={String(data.leads.length)}
          detail="Persistent and deduplicated"
        />
        <Metric
          label="72-hour canary"
          value={`${Math.round(data.operations.canary.completionRate * 100)}%`}
          detail={
            data.operations.canary.passed
              ? "Release gate passed"
              : `${data.operations.canary.hoursCovered.toFixed(0)}h observed`
          }
        />
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Latest qualified leads</h3>
            <p>Ranked by opportunity potential</p>
          </div>
        </div>
        <LeadTable leads={data.leads.slice(0, 8)} />
      </section>
    </div>
  );
}

function Sources({ data, mutate }: { data: BootstrapData; mutate: Mutate }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const baseUrl = String(form.get("baseUrl"));
    const host = new URL(baseUrl).hostname;
    const result = await mutate(
      "/api/v1/sources",
      {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          baseUrl,
          collectionMethod: form.get("method"),
          businessPurpose: form.get("purpose"),
          allowedDomains: [host],
          allowlistPaths: ["/*"],
          denylistPaths: ["/login*", "/account*", "/admin*"],
          dailyBudget: 100,
          monthlyBudget: 2000,
          maxDepth: 2,
          rateLimitRps: 1,
          retentionMonths: 12,
          intervalMinutes: Number(form.get("interval")),
          userAgent: "RaphahLeadEngineBot/2.0",
          contactEmail: form.get("contactEmail"),
        }),
      },
      "Source submitted for policy approval.",
    );
    if (result) formElement.reset();
  }
  return (
    <div className="content split-layout">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Permitted sources</h3>
            <p>No collection begins before explicit policy approval.</p>
          </div>
        </div>
        <div className="record-list">
          {data.sources.map((source) => (
            <div className="record-row" key={source.id}>
              <div>
                <b>{source.name}</b>
                <small>
                  {source.base_url} · {source.collection_method}
                </small>
              </div>
              <Status value={source.status} />
              {source.status === "pending_approval" ? (
                <button
                  className="row-action"
                  onClick={() =>
                    void mutate(
                      `/api/v1/sources/${source.id}/approve`,
                      {
                        method: "POST",
                        body: JSON.stringify({
                          reason:
                            "Reviewed for permitted public collection and business purpose.",
                        }),
                      },
                      `${source.name} approved.`,
                    )
                  }
                >
                  Approve
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </section>
      <section className="panel form-panel">
        <div className="panel-head">
          <div>
            <h3>Add source</h3>
            <p>Register policy before scheduling.</p>
          </div>
        </div>
        <form className="inline-form" onSubmit={submit}>
          <label>
            Name
            <input name="name" required />
          </label>
          <label>
            Base URL
            <input name="baseUrl" type="url" required />
          </label>
          <label>
            Collection method
            <select name="method" defaultValue="static_html">
              <option value="static_html">Static HTML</option>
              <option value="rss">RSS</option>
              <option value="sitemap">Sitemap</option>
              <option value="api">Public API</option>
            </select>
          </label>
          <label>
            Purpose
            <textarea
              name="purpose"
              defaultValue="Identify public evidence of manual processes and automation opportunity."
              required
            />
          </label>
          <label>
            Contact email
            <input name="contactEmail" type="email" required />
          </label>
          <label>
            Refresh interval (minutes)
            <input
              name="interval"
              type="number"
              min="5"
              defaultValue="1440"
              required
            />
          </label>
          <button className="primary">Create source policy</button>
        </form>
      </section>
    </div>
  );
}

function Jobs({
  data,
  mutate,
  session,
  workspaceId,
}: {
  data: BootstrapData;
  mutate: Mutate;
  session: Session;
  workspaceId: string;
}) {
  const activeSources = data.sources.filter(
    (source) => source.status === "active",
  );
  const [liveJob, setLiveJob] = useState<JobRecord | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const created = await mutate<{ data: JobRecord }>(
      "/api/v1/scrape-jobs",
      {
        method: "POST",
        headers: {
          "idempotency-key": `manual:${form.get("sourceId")}:${form.get("targetUrl")}:${new Date().toISOString().slice(0, 13)}`,
        },
        body: JSON.stringify({
          sourceId: form.get("sourceId"),
          targetUrl: form.get("targetUrl"),
          maxAttempts: 3,
        }),
      },
      "Persistent scrape job queued.",
    );
    if (created?.data?.id) setLiveJob(created.data);
  }
  return (
    <div className="content">
      <section className="panel form-strip">
        <form className="horizontal-form" onSubmit={submit}>
          <label>
            Approved source
            <select name="sourceId" required>
              {activeSources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Public target URL
            <input
              name="targetUrl"
              type="url"
              required
              placeholder="https://example.com/process"
            />
          </label>
          <button className="primary" disabled={!activeSources.length}>
            Queue scrape
          </button>
        </form>
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Durable job lifecycle</h3>
            <p>
              Queued, leased, retried, completed, and dead-lettered work remains
              queryable.
            </p>
          </div>
        </div>
        <div className="table job-table">
          <div className="table-head">
            <span>Target</span>
            <span>Status</span>
            <span>Attempts</span>
            <span>Scheduled / action</span>
          </div>
          {data.jobs.map((job) => (
            <div className="table-row" key={job.id}>
              <div className="op-name">
                <span className="avatar">J</span>
                <div>
                  <b>{new URL(job.target_url).hostname}</b>
                  <small>
                    {job.id.slice(0, 8)} · {job.target_url}
                  </small>
                </div>
              </div>
              <Status value={job.status} />
              <span>
                {job.attempt_count}/{job.max_attempts}
                {job.last_error ? (
                  <small className="error-text">{job.last_error}</small>
                ) : null}
              </span>
              <span className="stage-action">
                <time>{new Date(job.scheduled_for).toLocaleString()}</time>
                <button
                  className="row-action"
                  onClick={() => setLiveJob(job)}
                  title="Watch live scrape progress"
                >
                  Live
                </button>
                {["failed", "dead_letter", "cancelled"].includes(job.status) ? (
                  <button
                    className="row-action"
                    onClick={() => void jobAction(job, "retry", mutate)}
                  >
                    Retry
                  </button>
                ) : null}
                {["queued", "retrying", "leased"].includes(job.status) ? (
                  <button
                    className="row-action danger"
                    onClick={() => void jobAction(job, "cancel", mutate)}
                  >
                    Cancel
                  </button>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      </section>
      {liveJob ? (
        <JobLiveWindow
          job={liveJob}
          session={session}
          workspaceId={workspaceId}
          onClose={() => setLiveJob(null)}
        />
      ) : null}
    </div>
  );
}

async function jobAction(
  job: JobRecord,
  action: "retry" | "cancel",
  mutate: Mutate,
) {
  await mutate(
    `/api/v1/scrape-jobs/${job.id}/${action}`,
    {
      method: "POST",
      body: JSON.stringify({
        reason: `Operator requested ${action} from the production console.`,
      }),
    },
    `Job ${action} accepted.`,
  );
}

function Leads({ data, mutate }: { data: BootstrapData; mutate: Mutate }) {
  async function feedback(lead: LeadRecord, decision: "accepted" | "rejected") {
    await mutate(
      `/api/v1/leads/${lead.id}/feedback`,
      {
        method: "POST",
        body: JSON.stringify({
          decision,
          reasonCode:
            decision === "accepted"
              ? "VALID_AUTOMATION_FIT"
              : "NOT_CURRENT_FIT",
          notes: "Reviewed in Lead Engine console.",
        }),
      },
      `${lead.title} marked ${decision}.`,
    );
  }
  return (
    <div className="content">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Automation opportunity pipeline</h3>
            <p>Each lead is backed by stored evidence and a versioned score.</p>
          </div>
        </div>
        <LeadTable
          leads={data.leads}
          actions={(lead) => (
            <>
              <button
                className="row-action"
                onClick={() => void feedback(lead, "accepted")}
              >
                Accept
              </button>
              <button
                className="row-action danger"
                onClick={() => void feedback(lead, "rejected")}
              >
                Reject
              </button>
            </>
          )}
        />
      </section>
    </div>
  );
}

function LeadTable({
  leads,
  actions,
}: {
  leads: LeadRecord[];
  actions?: (lead: LeadRecord) => ReactNode;
}) {
  return (
    <div className="table">
      <div className="table-head">
        <span>Organization</span>
        <span>AI maturity</span>
        <span>Opportunity</span>
        <span>Confidence / review</span>
      </div>
      {leads.length ? (
        leads.map((lead) => {
          const org = Array.isArray(lead.organizations)
            ? lead.organizations[0]
            : lead.organizations;
          return (
            <div className="table-row" key={lead.id}>
              <div className="op-name">
                <span className="avatar">
                  {(org?.name ?? lead.title).slice(0, 2).toUpperCase()}
                </span>
                <div>
                  <b>{org?.name ?? lead.title}</b>
                  <small>{org?.normalized_domain ?? lead.routing}</small>
                </div>
              </div>
              <Score value={lead.automation_maturity_score} inverse />
              <Score value={lead.opportunity_potential_score} />
              <span className="stage-action">
                <b>{Math.round(lead.confidence * 100)}%</b>
                {actions?.(lead)}
              </span>
            </div>
          );
        })
      ) : (
        <p className="empty-state">
          No lead has met the current evidence, confidence, maturity, and
          geography gates.
        </p>
      )}
    </div>
  );
}

function Operations({ data }: { data: BootstrapData }) {
  const { operations } = data;
  return (
    <div className="content">
      <section className="metrics">
        <Metric
          label="72h completion"
          value={`${Math.round(operations.canary.completionRate * 100)}%`}
          detail={`${operations.canary.completed}/${operations.canary.total} canaries`}
        />
        <Metric
          label="Coverage"
          value={`${operations.canary.hoursCovered.toFixed(0)}h`}
          detail="72 hours required"
        />
        <Metric
          label="Run start p95"
          value={
            operations.jobs.scheduledStartP95Ms === null
              ? "—"
              : `${Math.round(operations.jobs.scheduledStartP95Ms / 1000)}s`
          }
          detail="Target < 300s"
        />
        <Metric
          label="Workers"
          value={String(operations.workers.length)}
          detail={operations.workers[0]?.status ?? "No heartbeat"}
        />
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Worker nodes</h3>
            <p>
              Vercel and Sentry remain authoritative; this is the application
              control view.
            </p>
          </div>
        </div>
        <div className="record-list">
          {operations.workers.map((worker) => (
            <div className="record-row" key={worker.id}>
              <div>
                <b>{worker.id}</b>
                <small>
                  {worker.runtime} · {worker.capabilities.join(", ")}
                </small>
              </div>
              <Status value={worker.status} />
              <time>{new Date(worker.last_heartbeat_at).toLocaleString()}</time>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Audit({ data }: { data: BootstrapData }) {
  return (
    <div className="content">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Immutable application audit trail</h3>
            <p>
              Every persisted state change is captured by database triggers.
            </p>
          </div>
        </div>
        <div className="record-list">
          {data.audit.map((event) => (
            <div className="record-row" key={event.id}>
              <div>
                <b>{event.action}</b>
                <small>
                  {event.resource_type} · {event.resource_id ?? "workspace"}
                </small>
              </div>
              <Status value={event.outcome} />
              <time>{new Date(event.created_at).toLocaleString()}</time>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="metric">
      <p>{label}</p>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
function Score({
  value,
  inverse = false,
}: {
  value: number;
  inverse?: boolean;
}) {
  return (
    <span className="score">
      <i style={{ width: `${Math.min(value, 100) / 2.4}px` }} />
      {value}
      {inverse ? " / 100 maturity" : " / 100"}
    </span>
  );
}
function Status({ value }: { value: string }) {
  return (
    <span className={`badge status-${value.replace(/_/g, "-")}`}>
      {value.replace(/_/g, " ")}
    </span>
  );
}
function HealthBadge({ data }: { data: BootstrapData }) {
  const healthy =
    data.operations.workers.length > 0 &&
    data.operations.jobs.scheduledStartTargetMet;
  return (
    <div className="signal-box">
      <span className={`pulse ${healthy ? "" : "pulse-warn"}`} />
      <span>
        <b>{healthy ? "Operational" : "Release gate pending"}</b>
        <small>
          {data.sources.filter((source) => source.status === "active").length}{" "}
          approved sources · {data.operations.workers.length} workers
        </small>
      </span>
    </div>
  );
}
function Centered({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <div className="centered">
      <section className="center-card">
        <div className="brand centered-brand">
          <span className="brand-mark">R</span>
          <span>Raphah</span>
        </div>
        <h1>{title}</h1>
        <p>{detail}</p>
        {children}
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
