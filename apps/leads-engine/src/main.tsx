import {
  FormEvent,
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  apiRequest,
  cacheBootstrap,
  cachedBootstrap,
  isNeonConfigured,
  neonClient,
  type AuditRecord,
  type BootstrapData,
  type DataMode,
  type DiscoveryCandidateRecord,
  type DiscoveryRunRecord,
  type DiscoverySourceRecord,
  type FunnelStats,
  type JobRecord,
  type LeadRecord,
  type Membership,
  type Session,
} from "./api";
import {
  derivePipelineStage,
  pipelineCardStatus,
  PIPELINE_STAGES,
  type PipelineStageId,
  type PipelineStageInputs,
} from "./pipeline-stage";
import { Settings } from "./CriteriaSettings";
import { JobBankMarket } from "./JobBankMarket";
import { JobLiveWindow } from "./JobLiveWindow";
import {
  normalizeSourceUrl,
  parseSourceCsv,
  type SourceImportRow,
} from "../api/_lib/source-import";
import { DISCOVERY_TERMS } from "../api/_lib/discovery/terms";
import "./styles.css";
import "./functionality.css";

type View =
  | "overview"
  | "sources"
  | "discovery"
  | "jobs"
  | "leads"
  | "jobbank"
  | "operations"
  | "audit"
  | "settings"
  | "help";
type Mutate = <T>(
  path: string,
  init: RequestInit,
  success: string,
) => Promise<T | null>;
const views: Array<{ id: View; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "sources", label: "Sources & policies" },
  { id: "discovery", label: "Discovery" },
  { id: "jobs", label: "Scrape jobs" },
  { id: "leads", label: "Qualified leads" },
  { id: "jobbank", label: "Job Bank market" },
  { id: "operations", label: "Operations" },
  { id: "audit", label: "Audit log" },
  { id: "settings", label: "Criteria & schedule" },
  { id: "help", label: "Help & guide" },
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
  // Explicitly re-read the session (used after sign-in completes, since the
  // auth-state event can lag behind the persisted session).
  const refreshSession = useCallback(async () => {
    if (!neonClient) return;
    const { data } = await neonClient.auth.getSession();
    setSession(data.session as Session | null);
  }, []);
  useEffect(() => {
    if (!neonClient) {
      setChecking(false);
      return;
    }
    void refreshSession().finally(() => setChecking(false));
    const { data } = neonClient.auth.onAuthStateChange((_event, next) =>
      setSession(next as Session | null),
    );
    return () => data.subscription.unsubscribe();
  }, [refreshSession]);
  if (!isNeonConfigured) return <SetupRequired />;
  if (checking)
    return (
      <Centered
        title="Opening Lead Engine…"
        detail="Validating your secure session."
      />
    );
  if (!session) return <SignIn onAuthenticated={refreshSession} />;
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

function SignIn({ onAuthenticated }: { onAuthenticated: () => Promise<void> }) {
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
    else {
      // Sign-in succeeded — explicitly pick up the session instead of waiting
      // for the auth-state event, so the workspace loads without a refresh.
      await onAuthenticated();
    }
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
  const [dataMode, setDataMode] = useState<DataMode>(() => {
    const stored = localStorage.getItem("raphah.lead.data-mode");
    return stored === "demo" || stored === "production" ? stored : "pilot";
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(
    "Connecting to the production data plane…",
  );
  // Action-result toasts live separately from the status bar: the
  // status bar is overwritten by the 15s sync refresh within a
  // second or two, which made success/failure messages a "bleep"
  // (operator feedback, 2026-10-14). A toast stays at least 5
  // seconds (8 for errors) and can be dismissed manually.
  const [toast, setToast] = useState<{
    message: string;
    kind: "success" | "error";
    id: number;
  } | null>(null);
  const showToast = useCallback(
    (message: string, kind: "success" | "error") => {
      setToast({ message, kind, id: Date.now() });
    },
    [],
  );
  useEffect(() => {
    if (!toast) return;
    const ms = toast.kind === "error" ? 8000 : 5000;
    const timer = window.setTimeout(() => {
      setToast((current) =>
        current && current.id === toast.id ? null : current,
      );
    }, ms);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const signOut = useCallback(async () => {
    localStorage.removeItem("raphah.lead.workspace");
    await neonClient!.auth.signOut();
    window.location.replace("/");
  }, []);

  useEffect(() => {
    void (async () => {
      // Retry the bootstrap RPC — the session JWT can take a moment to
      // propagate to the Data API after sign-in, causing a transient failure
      // on the first attempt. Retry with backoff instead of giving up.
      let bootstrap: { error: { message: string } | null } | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0)
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        bootstrap = await neonClient!.rpc("ensure_personal_workspace", {
          p_name: "Raphah Lead Workspace",
        });
        if (!bootstrap.error) break;
        setNotice(
          `Connecting… (attempt ${attempt + 1}/3: ${bootstrap.error.message})`,
        );
      }
      if (!bootstrap || bootstrap.error) {
        setNotice(
          bootstrap?.error?.message ??
            "Workspace bootstrap failed after 3 attempts.",
        );
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
      // localStorage is shared by every account in this browser. Keep the
      // stored workspace only when the newly authenticated user is actually a
      // member; otherwise select that user's first active workspace.
      setWorkspaceId((current) =>
        rows.some((row) => row.workspace_id === current)
          ? current
          : rows[0]?.workspace_id || "",
      );
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
      showToast(success, "success");
      await refresh(true);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice(message);
      showToast(message, "error");
      return null;
    } finally {
      setBusy(false);
    }
  }

  const activeMembership =
    memberships.find((item) => item.workspace_id === workspaceId) ??
    memberships[0];
  const visibleData = useMemo<BootstrapData | null>(() => {
    if (!data) return null;
    return {
      ...data,
      sources: data.sources.filter(
        (row) => (row.data_mode ?? "pilot") === dataMode,
      ),
      campaigns: data.campaigns.filter(
        (row) => (row.data_mode ?? "pilot") === dataMode,
      ),
      jobs: data.jobs.filter((row) => (row.data_mode ?? "pilot") === dataMode),
      leads: data.leads.filter(
        (row) => (row.data_mode ?? "pilot") === dataMode,
      ),
    };
  }, [data, dataMode]);
  useEffect(() => {
    localStorage.setItem("raphah.lead.data-mode", dataMode);
  }, [dataMode]);

  // Keep every hook above this conditional render. Membership bootstrap is
  // asynchronous, so placing hooks below this return causes React to render a
  // different number of hooks once the membership arrives and crashes the UI.
  if (!memberships.length && !data)
    return (
      <Centered title="Workspace initializing" detail={notice}>
        <div className="setup-list">
          <button className="primary" onClick={() => window.location.reload()}>
            Retry initialization
          </button>
          <button className="text-button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </Centered>
    );

  return (
    <div className={`app-shell lead-shell mode-${dataMode}`}>
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
                <strong>
                  {data.jobCounts?.[dataMode]
                    ? ["queued", "leased", "running", "retrying"].reduce(
                        (total, status) =>
                          total + (data.jobCounts![dataMode]![status] ?? 0),
                        0,
                      )
                    : (visibleData?.jobs.length ?? 0)}
                </strong>
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
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main>
        <div className="sticky-header">
          <header className="topbar">
            <div>
              <p className="eyebrow">Workspace / Automation intelligence</p>
              <h1>{views.find((item) => item.id === view)?.label}</h1>
            </div>
            <div className="top-actions">
              <label className="mode-selector">
                <span>Data environment</span>
                <select
                  value={dataMode}
                  onChange={(event) =>
                    setDataMode(event.target.value as DataMode)
                  }
                  aria-label="Data environment"
                >
                  <option value="demo">Demo data</option>
                  <option value="pilot">Pilot data</option>
                  <option value="production">Production data</option>
                </select>
              </label>
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
            <strong>{dataMode.toUpperCase()}</strong> · {notice}
          </div>
          {toast ? (
            <div className={`toast toast-${toast.kind}`} role="status">
              <span>{toast.message}</span>
              <button
                type="button"
                className="text-button"
                onClick={() => setToast(null)}
              >
                Dismiss
              </button>
            </div>
          ) : null}
        </div>
        {!visibleData ? (
          <Centered
            title="Loading workspace"
            detail="Fetching sources, jobs, leads, and telemetry."
          />
        ) : (
          <DashboardView
            view={view}
            setView={setView}
            data={visibleData}
            dataMode={dataMode}
            mutate={mutate}
            session={session}
            workspaceId={workspaceId}
          />
        )}
      </main>
    </div>
  );
}

function funnelDiagnosis(stats: FunnelStats): string | null {
  if (stats.candidatesEvaluated === 0)
    return "Volume check: nothing entered the funnel in this window — register a discovery source or queue scrapes.";
  if (stats.qualified === 0 && stats.scored > 0)
    return `Calibration check: ${stats.scored} scored but 0 qualified — the bar may be tighter than the market supports. Review the score distribution before loosening anything.`;
  if (stats.qualified === 0)
    return "No qualified leads yet — widen the top of the funnel before touching thresholds.";
  return null;
}

/** Discovery-funnel strip: active sources → candidates evaluated → scored →
 * qualified. Answers the operator's key diagnostic — is zero leads a volume
 * problem or a calibration problem — before any threshold is touched.
 * Prefers GET /api/v1/funnel; falls back to bootstrap job history (7-day
 * window, completed jobs ≈ scored since each completed job yields exactly
 * one maturity assessment) when the endpoint is not present. */
function FunnelStrip({
  data,
  session,
  workspaceId,
  dataMode,
}: {
  data: BootstrapData;
  session: Session;
  workspaceId: string;
  dataMode: DataMode;
}) {
  const [live, setLive] = useState<FunnelStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiRequest<{ data?: FunnelStats }>(
      session,
      workspaceId,
      `/api/v1/funnel?mode=${dataMode}`,
    )
      .then((payload) => {
        if (cancelled) return;
        const stats = payload?.data;
        if (stats && typeof stats.activeSources === "number") setLive(stats);
      })
      .catch(() => {
        // Endpoint not present — the bootstrap fallback below takes over.
      });
    return () => {
      cancelled = true;
    };
  }, [session, workspaceId, dataMode]);

  const stats: FunnelStats = live ?? fallbackFunnelStats(data);
  const stages = [
    {
      label: "Active sources",
      value: stats.activeSources,
      detail: "approved & collecting",
    },
    {
      label: "Candidates evaluated",
      value: stats.candidatesEvaluated,
      detail: `scrape jobs · ${stats.windowDays}d`,
    },
    { label: "Scored", value: stats.scored, detail: "maturity assessed" },
    { label: "Qualified", value: stats.qualified, detail: "met criteria" },
  ];
  const nodes: ReactNode[] = [];
  stages.forEach((stage, index) => {
    if (index > 0)
      nodes.push(
        <span
          key={`arrow-${index}`}
          className="funnel-arrow"
          aria-hidden="true"
        >
          →
        </span>,
      );
    nodes.push(
      <div key={stage.label} className="metric funnel-stage">
        <p>{stage.label}</p>
        <strong>{stage.value}</strong>
        <small>{stage.detail}</small>
      </div>,
    );
  });
  const diagnosis = funnelDiagnosis(stats);
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h3>Discovery funnel</h3>
          <p>
            Last {stats.windowDays} days
            {live ? "" : " · estimated from job history"} — volume vs
            calibration at a glance
          </p>
        </div>
      </div>
      <div className="funnel-strip">{nodes}</div>
      {diagnosis ? <p className="muted funnel-diagnosis">{diagnosis}</p> : null}
    </section>
  );
}

function fallbackFunnelStats(data: BootstrapData): FunnelStats {
  const windowDays = 7;
  const cutoff = Date.now() - windowDays * 24 * 3600 * 1000;
  const recentCompleted = data.jobs.filter(
    (job) =>
      job.status === "completed" &&
      new Date(job.created_at).getTime() >= cutoff,
  ).length;
  const recentQualified = data.leads.filter(
    (lead) => new Date(lead.last_refreshed_at).getTime() >= cutoff,
  ).length;
  return {
    activeSources: data.sources.filter((s) => s.status === "active").length,
    candidatesEvaluated: recentCompleted,
    // Each completed scrape job yields exactly one maturity assessment, so
    // completed jobs ≈ scored candidates in the fallback.
    scored: recentCompleted,
    qualified: recentQualified,
    windowDays,
  };
}

function DashboardView({
  view,
  setView,
  data,
  mutate,
  session,
  workspaceId,
  dataMode,
}: {
  view: View;
  setView: (view: View) => void;
  data: BootstrapData;
  mutate: Mutate;
  session: Session;
  workspaceId: string;
  dataMode: DataMode;
}) {
  if (view === "sources")
    return <Sources data={data} mutate={mutate} dataMode={dataMode} />;
  if (view === "discovery")
    return (
      <Discovery
        data={data}
        mutate={mutate}
        session={session}
        workspaceId={workspaceId}
        dataMode={dataMode}
      />
    );
  if (view === "jobs")
    return (
      <Jobs
        data={data}
        mutate={mutate}
        session={session}
        workspaceId={workspaceId}
      />
    );
  if (view === "leads")
    return (
      <Leads
        data={data}
        mutate={mutate}
        session={session}
        workspaceId={workspaceId}
      />
    );
  if (view === "jobbank")
    return <JobBankMarket session={session} workspaceId={workspaceId} />;
  if (view === "operations") return <Operations data={data} />;
  if (view === "audit")
    return <Audit data={data} session={session} workspaceId={workspaceId} />;
  if (view === "settings") return <Settings data={data} mutate={mutate} />;
  if (view === "help") return <HelpGuide />;
  // Prefer the bootstrap's full-table counts for the current mode;
  // data.jobs is only a 100-row window, so counting it hides
  // completions once more than 100 jobs exist.
  const modeJobCounts = data.jobCounts?.[dataMode];
  const complete =
    modeJobCounts?.completed ??
    data.jobs.filter((job) => job.status === "completed").length;
  const active = modeJobCounts
    ? ["queued", "leased", "running", "retrying"].reduce(
        (total, status) => total + (modeJobCounts[status] ?? 0),
        0,
      )
    : data.jobs.filter((job) =>
        ["queued", "leased", "running", "retrying"].includes(job.status),
      ).length;
  return (
    <div className="content">
      <section className="hero-row">
        <div>
          <p className="eyebrow accent">{dataMode} data environment</p>
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
      <FunnelStrip
        data={data}
        session={session}
        workspaceId={workspaceId}
        dataMode={dataMode}
      />
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

const SOURCE_IMPORT_TEMPLATE =
  "name,website,collection_method,business_purpose,allow_discovered_domains\n" +
  '"Example Business",https://example.com,static_html,"Identify public evidence of manual processes and automation opportunity.",false\n';

const MAX_IMPORT_ROWS = 200;

type ImportPreviewStatus = "new" | "duplicate" | "invalid";

interface ImportPreviewRow {
  key: number;
  name: string;
  website: string;
  domain: string;
  status: ImportPreviewStatus;
  detail: string;
}

interface ImportSummary {
  created: number;
  skipped: number;
  errors: number;
  approved: number;
}

function ImportSources({
  data,
  mutate,
  dataMode,
}: {
  data: BootstrapData;
  mutate: Mutate;
  dataMode: DataMode;
}) {
  const [fileName, setFileName] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [rows, setRows] = useState<SourceImportRow[]>([]);
  const [contactEmail, setContactEmail] = useState(data.actor.email ?? "");
  const [approveAll, setApproveAll] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const existingUrls = useMemo(() => {
    const urls = new Set<string>();
    for (const source of data.sources) {
      try {
        urls.add(normalizeSourceUrl(source.base_url));
      } catch {
        // Legacy rows that no longer normalize cannot collide.
      }
    }
    return urls;
  }, [data.sources]);

  const preview = useMemo<ImportPreviewRow[]>(() => {
    const seen = new Set<string>();
    return rows.map((row, key) => {
      const name = row.name.trim();
      const website = row.website.trim();
      const label = name || `Row ${key + 1}`;
      try {
        const normalized = normalizeSourceUrl(website);
        const domain = new URL(normalized).hostname;
        if (!name) {
          return {
            key,
            name: label,
            website,
            domain,
            status: "invalid",
            detail: "Name is required.",
          };
        }
        if (existingUrls.has(normalized)) {
          return {
            key,
            name,
            website,
            domain,
            status: "duplicate",
            detail: "A source with this website already exists.",
          };
        }
        if (seen.has(normalized)) {
          return {
            key,
            name,
            website,
            domain,
            status: "duplicate",
            detail: "Website is repeated in this file.",
          };
        }
        seen.add(normalized);
        return {
          key,
          name,
          website,
          domain,
          status: "new",
          detail: "Will be created.",
        };
      } catch {
        return {
          key,
          name: label,
          website,
          domain: "—",
          status: "invalid",
          detail: "Website is not a valid HTTP(S) URL.",
        };
      }
    });
  }, [rows, existingUrls]);

  const newRows = preview.filter((row) => row.status === "new");

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setSummary(null);
    setFileName(file.name);
    const parsed = parseSourceCsv(await file.text());
    if (parsed.error) {
      setParseError(parsed.error);
      setRows([]);
      return;
    }
    if (parsed.rows.length > MAX_IMPORT_ROWS) {
      setParseError(
        `The file has ${parsed.rows.length} rows; the import limit is ${MAX_IMPORT_ROWS}. Split it and import in batches.`,
      );
      setRows([]);
      return;
    }
    setParseError(null);
    setRows(parsed.rows);
  }

  function downloadTemplate() {
    const blob = new Blob([SOURCE_IMPORT_TEMPLATE], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "source-import-template.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function handleImport() {
    const payload = {
      rows: newRows.map(({ key }) => rows[key]),
      contactEmail,
      approveAll,
      dataMode,
    };
    const result = await mutate<{
      data: {
        created: Array<{ id: string; name: string }>;
        skipped: Array<{ name: string; website: string; reason: string }>;
        errors: Array<{ index: number; name: string; error: string }>;
        approved: number;
      };
    }>(
      "/api/v1/sources/import",
      { method: "POST", body: JSON.stringify(payload) },
      "Source import finished.",
    );
    if (result?.data) {
      setSummary({
        created: result.data.created.length,
        skipped: result.data.skipped.length,
        errors: result.data.errors.length,
        approved: result.data.approved,
      });
      setRows([]);
      setFileName("");
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h3>Import sources</h3>
          <p>
            Bulk-add sources from a CSV lead list. Each row becomes one source
            with its own policy.
          </p>
        </div>
        <button type="button" className="row-action" onClick={downloadTemplate}>
          Download CSV template
        </button>
      </div>
      <form
        className="inline-form"
        onSubmit={(event) => event.preventDefault()}
      >
        <label>
          CSV file
          <input type="file" accept=".csv" onChange={handleFile} />
          {fileName ? (
            <small>
              {fileName} · {rows.length} data rows
            </small>
          ) : null}
        </label>
        <label>
          Contact email
          <input
            type="email"
            required
            value={contactEmail}
            onChange={(event) => setContactEmail(event.target.value)}
          />
        </label>
        <label>
          <span>
            <input
              type="checkbox"
              checked={approveAll}
              onChange={(event) => setApproveAll(event.target.checked)}
            />{" "}
            Approve all on import
          </span>
          <small>
            Approved sources become active immediately and appear in the Scrape
            jobs dropdown.
          </small>
        </label>
      </form>
      {parseError ? (
        <p style={{ color: "#b3261e", padding: "0 20px" }}>{parseError}</p>
      ) : null}
      {preview.length > 0 ? (
        <div>
          <div className="table-head">
            <span>Name</span>
            <span>Website</span>
            <span>Domain</span>
            <span>Status</span>
          </div>
          {preview.map((row) => (
            <div className="table-row" key={row.key}>
              <span>
                <b>{row.name}</b>
              </span>
              <span>
                <small>{row.website}</small>
              </span>
              <span>
                <small>{row.domain}</small>
              </span>
              <span>
                <Status value={row.status} /> <small>{row.detail}</small>
              </span>
            </div>
          ))}
          <div style={{ padding: "16px 20px" }}>
            <button
              type="button"
              className="primary"
              onClick={handleImport}
              disabled={newRows.length === 0 || !contactEmail}
            >
              Import {newRows.length} source{newRows.length === 1 ? "" : "s"}
            </button>{" "}
            {summary ? (
              <small>
                Last import: {summary.created} created · {summary.skipped}{" "}
                skipped · {summary.errors} errors · {summary.approved} approved.
              </small>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Sources({
  data,
  mutate,
  dataMode,
}: {
  data: BootstrapData;
  mutate: Mutate;
  dataMode: DataMode;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
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
          allowDiscoveredDomains: form.get("allowDiscoveredDomains") === "on",
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
          dataMode,
        }),
      },
      "Source submitted for policy approval.",
    );
    if (result) formElement.reset();
  }
  return (
    <>
      <div className="content split-layout">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Permitted sources · {dataMode}</h3>
              <p>No collection begins before explicit policy approval.</p>
            </div>
          </div>
          <div className="record-list">
            {data.sources
              .filter((source) => source.status !== "retired")
              .map((source) => (
              <div className="record-row" key={source.id}>
                <div>
                  <b>{source.name}</b>
                  <small>
                    {source.base_url} · {source.collection_method}
                  </small>
                </div>
                <Status value={source.status} />
                <button
                  className="row-action"
                  onClick={() =>
                    setEditingId(editingId === source.id ? null : source.id)
                  }
                >
                  {editingId === source.id ? "Cancel" : "Edit"}
                </button>
                <button
                  className="row-action"
                  onClick={() =>
                    void mutate(
                      `/api/v1/sources/${source.id}/retire`,
                      { method: "POST", body: JSON.stringify({}) },
                      `${source.name} retired to History.`,
                    )
                  }
                >
                  Retire
                </button>
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
                {editingId === source.id ? (
                  <form
                    className="inline-form edit-form"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      const form = new FormData(event.currentTarget);
                      const result = await mutate(
                        `/api/v1/sources/${source.id}`,
                        {
                          method: "PATCH",
                          body: JSON.stringify({
                            name: String(form.get("name")),
                            baseUrl: String(form.get("baseUrl")),
                            collectionMethod: String(form.get("method")),
                            businessPurpose: String(form.get("purpose")),
                          }),
                        },
                        `${String(form.get("name"))} updated.`,
                      );
                      if (result) setEditingId(null);
                    }}
                  >
                    <label>
                      Name
                      <input name="name" defaultValue={source.name} required />
                    </label>
                    <label>
                      Base URL
                      <input
                        name="baseUrl"
                        type="url"
                        defaultValue={source.base_url}
                        required
                      />
                    </label>
                    <label>
                      Collection method
                      <select
                        name="method"
                        defaultValue={source.collection_method}
                      >
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
                        defaultValue={source.business_purpose}
                        required
                      />
                    </label>
                    <button type="submit" className="primary">
                      Save changes
                    </button>
                  </form>
                ) : null}
              </div>
            ))}
          </div>
          {data.sources.some((source) => source.status === "retired") ? (
            <div className="history-block">
              <h4>History — retired sources</h4>
              {data.sources
                .filter((source) => source.status === "retired")
                .map((source) => (
                  <div className="record-row" key={source.id}>
                    <div>
                      <b>{source.name}</b>
                      <small>
                        {source.base_url} · retired{" "}
                        {source.retired_at
                          ? new Date(source.retired_at).toLocaleDateString()
                          : ""}
                      </small>
                    </div>
                    <Status value={source.status} />
                    <button
                      className="row-action"
                      onClick={() =>
                        void mutate(
                          `/api/v1/sources/${source.id}/restore`,
                          { method: "POST", body: JSON.stringify({}) },
                          `${source.name} restored.`,
                        )
                      }
                    >
                      Restore
                    </button>
                  </div>
                ))}
            </div>
          ) : null}
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
            <label className="check-label">
              <input name="allowDiscoveredDomains" type="checkbox" />
              <span>
                Permit public domains discovered by approved adapters. Each
                target still passes HTTPS/public-host, robots, path, rate, and
                budget controls.
              </span>
            </label>
            <button className="primary">Create source policy</button>
          </form>
        </section>
      </div>
      <div className="content">
        <ImportSources data={data} mutate={mutate} dataMode={dataMode} />
      </div>
    </>
  );
}

const DISCOVERY_CITIES = ["Toronto", "Ottawa", "Montreal", "Custom"];
const DISCOVERY_ADAPTERS = {
  overpass: {
    label: "OpenStreetMap / Overpass",
    terms: DISCOVERY_TERMS.overpass,
    detail: "Business place discovery with public websites and coordinates.",
  },
  toronto_open_data: {
    label: "Toronto Open Data",
    terms: DISCOVERY_TERMS.toronto_open_data,
    detail: "Municipal business licence and permit records from Toronto CKAN.",
  },
  job_bank: {
    label: "Canada Job Bank",
    terms: DISCOVERY_TERMS.job_bank,
    detail:
      "Employer and hiring signals from the Government of Canada catalogue.",
  },
} as const;
type DiscoveryAdapterId = keyof typeof DISCOVERY_ADAPTERS;

function geoSummary(geo: DiscoverySourceRecord["geo_params"]): string {
  if (!geo) return "—";
  const parts = [geo.city ?? "Custom area"];
  if (geo.radiusKm) parts.push(`${geo.radiusKm} km radius`);
  if (geo.centreLatitude !== undefined && geo.centreLongitude !== undefined)
    parts.push(
      `${geo.centreLatitude.toFixed(3)}, ${geo.centreLongitude.toFixed(3)}`,
    );
  return parts.join(" · ");
}

export function Discovery({
  data,
  mutate,
  session,
  workspaceId,
  dataMode,
}: {
  data: BootstrapData;
  mutate: Mutate;
  session: Session;
  workspaceId: string;
  dataMode: DataMode;
}) {
  const [sources, setSources] = useState<DiscoverySourceRecord[] | null>(null);
  const [runs, setRuns] = useState<DiscoveryRunRecord[] | null>(null);
  const [candidates, setCandidates] = useState<
    DiscoveryCandidateRecord[] | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [city, setCity] = useState("Toronto");
  const [runningId, setRunningId] = useState<string | null>(null);
  const [adapterId, setAdapterId] = useState<DiscoveryAdapterId>("overpass");
  const [acceptedTerms, setAcceptedTerms] = useState<Set<string>>(new Set());
  const [termsDialogAdapterId, setTermsDialogAdapterId] =
    useState<DiscoveryAdapterId | null>(null);
  const [termsAcknowledged, setTermsAcknowledged] = useState(false);
  const [termsNotes, setTermsNotes] = useState("");
  const [resolvingCandidateId, setResolvingCandidateId] = useState<
    string | null
  >(null);
  const [resolutionUrl, setResolutionUrl] = useState("");
  const [resolutionNotes, setResolutionNotes] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [sourceResult, runResult, candidateResult, termsResult] =
        await Promise.all([
          apiRequest<{ data: DiscoverySourceRecord[] }>(
            session,
            workspaceId,
            "/api/v1/discovery/sources",
          ),
          apiRequest<{ data: DiscoveryRunRecord[] }>(
            session,
            workspaceId,
            "/api/v1/discovery/runs",
          ),
          apiRequest<{ data: DiscoveryCandidateRecord[] }>(
            session,
            workspaceId,
            `/api/v1/discovery/candidates?mode=${dataMode}`,
          ),
          apiRequest<{ data: Array<{ terms_id: string }> }>(
            session,
            workspaceId,
            "/api/v1/terms",
          ),
        ]);
      setSources(sourceResult.data.filter((row) => row.data_mode === dataMode));
      setRuns(runResult.data.filter((row) => row.data_mode === dataMode));
      setCandidates(candidateResult.data);
      setAcceptedTerms(new Set(termsResult.data.map((t) => t.terms_id)));
    } catch {
      // mutate() surfaces request errors; the lists simply stay stale.
    } finally {
      setLoading(false);
    }
  }, [session, workspaceId, dataMode]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const role = data.actor.role ?? "";
  const canAcceptTerms = role === "owner" || role === "administrator";

  function closeTermsDialog() {
    setTermsDialogAdapterId(null);
    setTermsAcknowledged(false);
    setTermsNotes("");
  }

  async function acceptTerms(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!termsDialogAdapterId || !termsAcknowledged) return;
    const adapter = DISCOVERY_ADAPTERS[termsDialogAdapterId];
    const result = await mutate(
      "/api/v1/terms/accept",
      {
        method: "POST",
        body: JSON.stringify({
          termsId: adapter.terms.id,
          ...(termsNotes.trim() ? { notes: termsNotes.trim() } : {}),
        }),
      },
      `${adapter.label} terms accepted — its discovery runs are unblocked.`,
    );
    if (result) {
      closeTermsDialog();
      await refresh();
    }
  }

  const approvedSources = data.sources.filter((s) => s.status === "active");
  const sourceName = (id: string) =>
    sources?.find((s) => s.id === id)?.name ?? id.slice(0, 8);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const cityValue = String(form.get("city"));
    const custom = cityValue === "Custom";
    const geo: Record<string, unknown> = {
      city: custom ? String(form.get("customCity") || "Custom") : cityValue,
      radiusKm: Number(form.get("radiusKm")) || 50,
    };
    if (custom) {
      geo.centreLatitude = Number(form.get("latitude"));
      geo.centreLongitude = Number(form.get("longitude"));
    }
    const adapterConfig: Record<string, unknown> = {};
    if (adapterId === "overpass") {
      adapterConfig.categoryPreset = String(
        form.get("categoryPreset") ?? "all",
      );
    } else if (adapterId === "toronto_open_data") {
      adapterConfig.categories = String(form.get("categories") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      adapterConfig.activeOnly = form.get("activeOnly") === "on";
      adapterConfig.maxRecords = Number(form.get("maxRecords")) || 200;
    } else if (adapterId === "job_bank") {
      adapterConfig.keywords = String(form.get("keywords") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      adapterConfig.postedWithinDays =
        Number(form.get("postedWithinDays")) || 30;
      adapterConfig.maxRecords = Number(form.get("maxRecords")) || 200;
    }
    const campaignId = String(form.get("campaignId") ?? "");
    const result = await mutate(
      "/api/v1/discovery/sources",
      {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          adapterId,
          adapterConfig,
          dataMode,
          geo,
          sourceId: form.get("sourceId"),
          ...(campaignId ? { campaignId } : {}),
        }),
      },
      "Discovery source registered.",
    );
    if (result) {
      formElement.reset();
      setCity("Toronto");
      setAdapterId("overpass");
      await refresh();
    }
  }

  async function runSource(id: string, name: string) {
    setRunningId(id);
    await mutate(
      `/api/v1/discovery/sources/${id}/run`,
      { method: "POST" },
      `Discovery run finished for ${name}.`,
    );
    setRunningId(null);
    await refresh();
  }

  async function resolveCandidate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resolvingCandidateId) return;
    const result = await mutate(
      `/api/v1/discovery/candidates/${resolvingCandidateId}/resolve`,
      {
        method: "POST",
        body: JSON.stringify({
          website: resolutionUrl,
          notes: resolutionNotes,
        }),
      },
      "Candidate website resolved and persistent scrape job queued.",
    );
    if (result) {
      setResolvingCandidateId(null);
      setResolutionUrl("");
      setResolutionNotes("");
      await refresh();
    }
  }

  return (
    <>
      <div className="content split-layout">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Discovery sources</h3>
              <p>
                Permitted public-data adapters persist every candidate, resolve
                websites, and enqueue approved collection jobs. Showing only
                <b> {dataMode}</b> records.
              </p>
            </div>
          </div>
          {!acceptedTerms.has(DISCOVERY_ADAPTERS[adapterId].terms.id) ? (
            <div className="notice">
              <div>
                <b>
                  {DISCOVERY_ADAPTERS[adapterId].label} terms not yet accepted.
                </b>{" "}
                <span className="muted">
                  Registration is available, but runs stay blocked until an
                  owner or administrator records human acceptance.
                </span>
              </div>
              {canAcceptTerms ? (
                <button
                  type="button"
                  className="row-action"
                  onClick={() => setTermsDialogAdapterId(adapterId)}
                >
                  Review and accept terms
                </button>
              ) : (
                <span className="muted">
                  Ask a workspace owner to accept them.
                </span>
              )}
            </div>
          ) : null}
          {loading ? (
            <p className="muted">Loading discovery sources…</p>
          ) : (
            <div className="record-list">
              {(sources ?? []).map((source) => (
                <div className="record-row" key={source.id}>
                  <div>
                    <b>{source.name}</b>
                    <small>
                      {DISCOVERY_ADAPTERS[
                        source.adapter_id as DiscoveryAdapterId
                      ]?.label ?? source.adapter_id}{" "}
                      · {geoSummary(source.geo_params)} ·{" "}
                      {source.active ? "active" : "paused"}
                    </small>
                  </div>
                  <button
                    className="row-action"
                    disabled={runningId !== null}
                    onClick={() => void runSource(source.id, source.name)}
                  >
                    {runningId === source.id ? "Running…" : "Run now"}
                  </button>
                </div>
              ))}
              {(sources ?? []).length === 0 ? (
                <p className="muted">
                  No discovery sources yet — register one to start finding
                  businesses.
                </p>
              ) : null}
            </div>
          )}
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Register discovery source</h3>
              <p>
                Choose an adapter and configure its bounded discovery scope.
                Human terms acceptance remains a separate release gate.
              </p>
            </div>
          </div>
          <form className="inline-form" onSubmit={(e) => void submit(e)}>
            <label>
              Name
              <input name="name" minLength={2} maxLength={160} required />
            </label>
            <label>
              Adapter
              <select
                name="adapterId"
                value={adapterId}
                onChange={(event) =>
                  setAdapterId(event.target.value as DiscoveryAdapterId)
                }
              >
                {Object.entries(DISCOVERY_ADAPTERS).map(([id, adapter]) => (
                  <option key={id} value={id}>
                    {adapter.label}
                  </option>
                ))}
              </select>
              <small>{DISCOVERY_ADAPTERS[adapterId].detail}</small>
            </label>
            <label>
              City
              <select
                name="city"
                value={city}
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  setCity(event.target.value)
                }
              >
                {DISCOVERY_CITIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            {city === "Custom" ? (
              <>
                <label>
                  Area label
                  <input name="customCity" placeholder="e.g. Downtown core" />
                </label>
                <label>
                  Centre latitude
                  <input
                    name="latitude"
                    type="number"
                    step="0.0001"
                    min={-90}
                    max={90}
                    required
                  />
                </label>
                <label>
                  Centre longitude
                  <input
                    name="longitude"
                    type="number"
                    step="0.0001"
                    min={-180}
                    max={180}
                    required
                  />
                </label>
              </>
            ) : null}
            <label>
              Radius (km)
              <input
                name="radiusKm"
                type="number"
                min={1}
                max={500}
                defaultValue={50}
                required
              />
            </label>
            {adapterId === "overpass" ? (
              <>
                <label>
                  Category
                  <select name="categoryPreset" defaultValue="all">
                    <option value="all">All businesses</option>
                    <option value="clinics">
                      Clinics only (dental / medical / wellness)
                    </option>
                    <option value="field_service">
                      Field service trades (plumbing / HVAC / electrical)
                    </option>
                  </select>
                </label>
              </>
            ) : null}
            {adapterId === "toronto_open_data" ? (
              <>
                <label>
                  Licence categories (comma-separated, optional)
                  <input
                    name="categories"
                    placeholder="Restaurant, Contractor"
                  />
                </label>
                <label>
                  Maximum records
                  <input
                    name="maxRecords"
                    type="number"
                    min={1}
                    max={200}
                    defaultValue={200}
                  />
                </label>
                <label>
                  <span>
                    <input name="activeOnly" type="checkbox" defaultChecked />{" "}
                    Active licences only
                  </span>
                </label>
              </>
            ) : null}
            {adapterId === "job_bank" ? (
              <>
                <label>
                  Hiring keywords (comma-separated)
                  <input
                    name="keywords"
                    defaultValue="administrative, data entry, coordinator"
                  />
                </label>
                <label>
                  Posted within (days)
                  <input
                    name="postedWithinDays"
                    type="number"
                    min={1}
                    max={365}
                    defaultValue={30}
                  />
                </label>
                <label>
                  Maximum records
                  <input
                    name="maxRecords"
                    type="number"
                    min={1}
                    max={200}
                    defaultValue={200}
                  />
                </label>
              </>
            ) : null}
            <label>
              Collection source (approved)
              <select name="sourceId" required>
                {approvedSources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Campaign (optional)
              <select name="campaignId" defaultValue="">
                <option value="">None</option>
                {data.campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary">Register source</button>
          </form>
        </section>
      </div>
      {termsDialogAdapterId ? (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="terms-dialog-title"
          >
            <div className="modal-head">
              <div>
                <h2 id="terms-dialog-title">Review source terms</h2>
                <p className="muted">
                  {DISCOVERY_ADAPTERS[termsDialogAdapterId].label}
                </p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close terms acceptance"
                onClick={closeTermsDialog}
              >
                ×
              </button>
            </div>
            <form onSubmit={(event) => void acceptTerms(event)}>
              <div className="terms-review">
                <b>
                  {DISCOVERY_ADAPTERS[termsDialogAdapterId].terms.label}
                </b>
                <span>
                  Recorded version: {" "}
                  <code>
                    {DISCOVERY_ADAPTERS[termsDialogAdapterId].terms.version}
                  </code>
                </span>
                <p>
                  {DISCOVERY_ADAPTERS[termsDialogAdapterId].terms.summary}
                </p>
                <div className="terms-links">
                  {DISCOVERY_ADAPTERS[
                    termsDialogAdapterId
                  ].terms.reviewLinks.map((link) => (
                    <a
                      key={link.href}
                      href={link.href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {link.label} ↗
                    </a>
                  ))}
                </div>
              </div>
              <label className="terms-acknowledgement">
                <input
                  type="checkbox"
                  checked={termsAcknowledged}
                  onChange={(event) =>
                    setTermsAcknowledged(event.target.checked)
                  }
                />
                <span>
                  I confirm that I am authorized to accept this version for
                  the workspace and have reviewed the linked terms.
                </span>
              </label>
              <label>
                Acceptance notes (optional)
                <textarea
                  value={termsNotes}
                  maxLength={2000}
                  onChange={(event) => setTermsNotes(event.target.value)}
                  placeholder="Review reference, approver context, or operational constraints"
                />
              </label>
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={closeTermsDialog}
                >
                  Cancel
                </button>
                <button className="primary" disabled={!termsAcknowledged}>
                  Record acceptance
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
      <div className="content">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Discovery runs</h3>
              <p>Most recent passes first, deduplicated by website URL.</p>
            </div>
          </div>
          <div className="table discovery-runs-table">
            <div className="table-head">
              <span>Started</span>
              <span>Source</span>
              <span>Status</span>
              <span>Candidates</span>
              <span>Persisted / unresolved</span>
              <span>Enqueued</span>
            </div>
            {(runs ?? []).map((run) => (
              <div className="table-row" key={run.id}>
                <span>{new Date(run.started_at).toLocaleString()}</span>
                <span>{sourceName(run.discovery_source_id)}</span>
                <span>
                  {run.status}
                  {run.error ? (
                    <>
                      <br />
                      <small className="muted">{run.error}</small>
                    </>
                  ) : null}
                </span>
                <span>{run.candidates_found ?? "—"}</span>
                <span>
                  {run.candidates_persisted ?? "—"} /{" "}
                  {run.candidates_unresolved ?? "—"}
                </span>
                <span>{run.candidates_enqueued ?? "—"}</span>
              </div>
            ))}
          </div>
          {(runs ?? []).length === 0 && !loading ? (
            <p className="muted">No discovery runs yet.</p>
          ) : null}
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Persistent discovery candidates</h3>
              <p>
                All {dataMode} candidates are retained, including records that
                need website resolution before collection.
              </p>
            </div>
          </div>
          <div className="table candidate-table">
            <div className="table-head">
              <span>Business</span>
              <span>Adapter</span>
              <span>Resolution</span>
              <span>Observed</span>
            </div>
            {(candidates ?? []).slice(0, 100).map((candidate) => (
              <div className="table-row" key={candidate.id}>
                <span>
                  <b>{candidate.name}</b>
                  <small>
                    {candidate.address ?? candidate.category ?? "—"}
                  </small>
                </span>
                <span>{candidate.adapter_id}</span>
                <span className="resolution-cell">
                  <Status value={candidate.resolution_status} />
                  <small>
                    {candidate.resolved_website ?? "Review required"}
                  </small>
                  {!candidate.resolved_website ? (
                    <button
                      type="button"
                      className="row-action"
                      onClick={() => {
                        setResolvingCandidateId(candidate.id);
                        setResolutionUrl(candidate.website ?? "");
                        setResolutionNotes("");
                      }}
                    >
                      Resolve website
                    </button>
                  ) : null}
                </span>
                <span>
                  {new Date(candidate.source_observed_at).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
          {resolvingCandidateId ? (
            <form
              className="horizontal-form resolution-form"
              onSubmit={resolveCandidate}
            >
              <label>
                Human-validated website
                <input
                  type="url"
                  value={resolutionUrl}
                  onChange={(event) => setResolutionUrl(event.target.value)}
                  placeholder="https://business.example"
                  required
                />
              </label>
              <label>
                Validation note
                <input
                  value={resolutionNotes}
                  onChange={(event) => setResolutionNotes(event.target.value)}
                  placeholder="Where and how the website was verified"
                  minLength={3}
                  required
                />
              </label>
              <p className="muted">
                This audited action links the candidate to an approved source
                policy and queues its mode-scoped collection job.
              </p>
              <div>
                <button className="primary">Resolve and queue</button>{" "}
                <button
                  type="button"
                  className="quiet"
                  onClick={() => setResolvingCandidateId(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : null}
          {(candidates ?? []).length === 0 && !loading ? (
            <p className="muted">No {dataMode} candidates persisted yet.</p>
          ) : null}
        </section>
      </div>
    </>
  );
}

/**
 * Hostname for display, tolerant of legacy rows whose target_url is
 * not an absolute URL (discovery once enqueued raw adapter website
 * strings, some without a scheme). Rendering must never throw on a
 * stored value — a single bad row blanked the whole app.
 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
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
                  <b>{hostnameOf(job.target_url)}</b>
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

interface UseCaseRow {
  id: string;
  title: string;
  statement: string;
  rationale: string;
  acceptance_criteria: string[];
  status: string;
  generation_source?: string;
  success_metric?: string | null;
  success_target?: string | null;
}

interface ProposalRow {
  id: string;
  draft_text: string;
  status: string;
  drafted_by: string;
  model: string | null;
  approved_by: string | null;
  evidence_quotes: string[];
}

interface ProposalData {
  proposal: ProposalRow | null;
  consentRecorded: boolean;
  approvedUseCases: number;
}

interface HandoffStatusRow {
  id: string;
  idempotency_key: string;
  opportunity_id: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  dispatched_at: string | null;
}

/** Per-lead pipeline state from GET /api/v1/leads/pipeline: the raw
 *  inputs the board derives a stage from (src/pipeline-stage.ts). */
interface PipelineLeadState {
  opportunityId: string;
  proposalStatus: string | null;
  latestDecision: string | null;
  handoffStatus: string | null;
}

export function Leads({
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
  const [exporting, setExporting] = useState<"csv" | "json" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  // Reviewer-validated use cases (the DF baseline flow).
  const [useCaseLead, setUseCaseLead] = useState<LeadRecord | null>(null);
  const [useCaseRows, setUseCaseRows] = useState<UseCaseRow[] | null>(null);
  const [useCaseSelected, setUseCaseSelected] = useState<string[]>([]);
  const [useCaseMeasures, setUseCaseMeasures] = useState<
    Record<string, { metric: string; target: string }>
  >({});
  const [useCaseError, setUseCaseError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  // DF delivery truth from the handoff outbox, keyed by opportunity id.
  const [handoffByLead, setHandoffByLead] = useState<
    Record<string, HandoffStatusRow>
  >({});
  const [deliveryBanner, setDeliveryBanner] = useState<{
    leadId: string;
    title: string;
    outcome: "sending" | "landed" | "failed";
    detail: string;
  } | null>(null);
  // Pipeline board state: per-lead proposal + outcome inputs, and
  // the List | Board view toggle.
  const [pipelineByLead, setPipelineByLead] = useState<
    Record<string, PipelineLeadState>
  >({});
  const [leadView, setLeadView] = useState<"list" | "board">("list");
  // Pipeline load health: a failed load must never masquerade as
  // "every lead is Qualified" — the board discloses it and keeps
  // the last successful state.
  const [pipelineStatus, setPipelineStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const loadPipelineStates = useCallback(async () => {
    try {
      const result = await apiRequest<{ data: PipelineLeadState[] }>(
        session,
        workspaceId,
        "/api/v1/leads/pipeline",
      );
      const map: Record<string, PipelineLeadState> = {};
      for (const row of result.data ?? []) map[row.opportunityId] = row;
      setPipelineByLead(map);
      setPipelineStatus("ready");
    } catch {
      setPipelineStatus("error");
    }
  }, [session, workspaceId]);
  useEffect(() => {
    void loadPipelineStates();
    const interval = window.setInterval(
      () => void loadPipelineStates(),
      15_000,
    );
    return () => window.clearInterval(interval);
  }, [loadPipelineStates]);

  const loadHandoffStatuses = useCallback(async () => {
    try {
      const result = await apiRequest<{ data: HandoffStatusRow[] }>(
        session,
        workspaceId,
        "/api/v1/handoffs",
      );
      const map: Record<string, HandoffStatusRow> = {};
      for (const row of result.data ?? []) {
        // The server derives opportunity_id from the stored
        // package; the key text is caller-controlled and is only a
        // legacy fallback for rows that predate the derivation.
        const opportunityId =
          row.opportunity_id ?? row.idempotency_key.split(":").pop() ?? "";
        // Rows arrive newest-first; the first per opportunity wins.
        if (opportunityId && !map[opportunityId]) map[opportunityId] = row;
      }
      setHandoffByLead(map);
      return map;
    } catch {
      return null;
    }
  }, [session, workspaceId]);
  useEffect(() => {
    void loadHandoffStatuses();
    const interval = window.setInterval(
      () => void loadHandoffStatuses(),
      15_000,
    );
    return () => window.clearInterval(interval);
  }, [loadHandoffStatuses]);
  async function toggleUseCases(lead: LeadRecord) {
    if (useCaseLead?.id === lead.id) {
      setUseCaseLead(null);
      return;
    }
    setUseCaseLead(lead);
    setUseCaseRows(null);
    setUseCaseError(null);
    try {
      const result = await apiRequest<{ data: UseCaseRow[] }>(
        session,
        workspaceId,
        `/api/v1/opportunities/${lead.id}/use-cases`,
      );
      const rows = result.data ?? [];
      setUseCaseRows(rows);
      setUseCaseSelected(
        rows.filter((row) => row.status === "approved").map((row) => row.id),
      );
      setUseCaseMeasures(
        Object.fromEntries(
          rows.map((row) => [
            row.id,
            {
              metric: row.success_metric ?? "",
              target: row.success_target ?? "",
            },
          ]),
        ),
      );
    } catch (error) {
      setUseCaseError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  async function approveUseCases() {
    if (!useCaseLead) return;
    setApproving(true);
    const result = await mutate(
      `/api/v1/opportunities/${useCaseLead.id}/use-cases/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          useCaseIds: useCaseSelected,
          measures: Object.fromEntries(
            useCaseSelected
              .filter(
                (id) =>
                  useCaseMeasures[id]?.metric && useCaseMeasures[id]?.target,
              )
              .map((id) => [id, useCaseMeasures[id]]),
          ),
        }),
      },
      `${useCaseSelected.length} use case(s) approved for ${useCaseLead.title} — they ship to the Delivery Factory as validated Must requirements.`,
    );
    setApproving(false);
    if (result) {
      const refreshed = await apiRequest<{ data: UseCaseRow[] }>(
        session,
        workspaceId,
        `/api/v1/opportunities/${useCaseLead.id}/use-cases`,
      ).catch(() => null);
      if (refreshed?.data) setUseCaseRows(refreshed.data);
    }
  }
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
  async function handoff(lead: LeadRecord) {
    setDeliveryBanner({
      leadId: lead.id,
      title: lead.title,
      outcome: "sending",
      detail: "Package queued — confirming delivery at the Delivery Factory…",
    });
    const result = await mutate(
      "/api/v1/handoffs",
      {
        method: "POST",
        body: JSON.stringify({ opportunityId: lead.id }),
      },
      `Sending ${lead.title} to the Delivery Factory — confirming delivery…`,
    );
    if (!result) {
      setDeliveryBanner({
        leadId: lead.id,
        title: lead.title,
        outcome: "failed",
        detail:
          "The send request itself failed — the message above says why (a common cause: no approved use cases yet).",
      });
      return;
    }
    // TCP-style confirmation: poll the outbox until the Delivery
    // Factory accepts (status "sent") or the row terminally fails.
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const map = await loadHandoffStatuses();
      const row = map?.[lead.id];
      if (row?.status === "sent") {
        setDeliveryBanner({
          leadId: lead.id,
          title: lead.title,
          outcome: "landed",
          detail: `Landed — the Delivery Factory accepted the package${
            row.dispatched_at
              ? ` at ${new Date(row.dispatched_at).toLocaleTimeString()}`
              : ""
          }. It now appears in DF intake.`,
        });
        return;
      }
      if (row?.status === "failed") {
        setDeliveryBanner({
          leadId: lead.id,
          title: lead.title,
          outcome: "failed",
          detail: `Delivery to the Delivery Factory failed: ${
            row.last_error ?? "unknown error"
          }`,
        });
        return;
      }
    }
    setDeliveryBanner({
      leadId: lead.id,
      title: lead.title,
      outcome: "sending",
      detail:
        "Still delivering — the worker retries automatically with backoff; the delivery chip on this lead shows its live status.",
    });
  }
  // Lead proposal (outreach drafting lives in LE).
  const [proposalLead, setProposalLead] = useState<LeadRecord | null>(null);
  const [proposalData, setProposalData] = useState<ProposalData | null>(null);
  const [proposalText, setProposalText] = useState("");
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [consentBasis, setConsentBasis] = useState("existing_relationship");
  const [consentReference, setConsentReference] = useState("");
  async function loadProposal(lead: LeadRecord) {
    try {
      const result = await apiRequest<{ data: ProposalData }>(
        session,
        workspaceId,
        `/api/v1/opportunities/${lead.id}/proposal`,
      );
      setProposalData(result.data);
      setProposalText(result.data.proposal?.draft_text ?? "");
      return result.data;
    } catch (error) {
      setProposalError(
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }
  async function toggleProposal(lead: LeadRecord) {
    if (proposalLead?.id === lead.id) {
      setProposalLead(null);
      return;
    }
    setProposalLead(lead);
    setProposalData(null);
    setProposalError(null);
    await loadProposal(lead);
  }
  async function draftProposal() {
    if (!proposalLead) return;
    setProposalBusy(true);
    const result = await mutate(
      `/api/v1/opportunities/${proposalLead.id}/proposal/draft`,
      { method: "POST", body: JSON.stringify({}) },
      `Proposal drafted for ${proposalLead.title} — review and approve it before sending.`,
    );
    setProposalBusy(false);
    if (result) await loadProposal(proposalLead);
  }
  async function approveProposal() {
    if (!proposalLead || !proposalData?.proposal) return;
    setProposalBusy(true);
    const result = await mutate(
      `/api/v1/opportunities/${proposalLead.id}/proposal/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          proposalId: proposalData.proposal.id,
          text: proposalText,
        }),
      },
      `Proposal for ${proposalLead.title} approved — ready for you to send.`,
    );
    setProposalBusy(false);
    if (result) await loadProposal(proposalLead);
  }
  async function markProposalSent() {
    if (!proposalLead || !proposalData?.proposal) return;
    setProposalBusy(true);
    const result = await mutate(
      `/api/v1/opportunities/${proposalLead.id}/proposal/sent`,
      {
        method: "POST",
        body: JSON.stringify({ proposalId: proposalData.proposal.id }),
      },
      `${proposalLead.title} marked as contacted — the sent proposal is recorded on the lead.`,
    );
    setProposalBusy(false);
    if (result) await loadProposal(proposalLead);
  }
  async function recordConsent() {
    if (!proposalLead) return;
    setProposalBusy(true);
    const result = await mutate(
      "/api/v1/consent",
      {
        method: "POST",
        body: JSON.stringify({
          opportunityId: proposalLead.id,
          basisType: consentBasis,
          evidenceReference: consentReference || undefined,
        }),
      },
      `CASL consent basis recorded for ${proposalLead.title}.`,
    );
    setProposalBusy(false);
    if (result) await loadProposal(proposalLead);
  }
  function handoffChip(lead: LeadRecord) {
    const row = handoffByLead[lead.id];
    if (!row) return null;
    if (row.status === "sent")
      return <span className="badge status-success">At DF ✓</span>;
    if (row.status === "failed")
      return (
        <span className="badge danger" title={row.last_error ?? undefined}>
          DF delivery failed
        </span>
      );
    return (
      <span className="badge status-queued">
        Sending to DF… (attempt {row.attempts + 1})
      </span>
    );
  }
  async function exportLeads(format: "csv" | "json") {
    setExporting(format);
    setExportError(null);
    try {
      const headers = new Headers();
      headers.set("authorization", `Bearer ${session.access_token}`);
      headers.set("x-workspace-id", workspaceId);
      headers.set("x-correlation-id", crypto.randomUUID());
      const response = await fetch(`/api/v1/leads/export?format=${format}`, {
        headers,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          (payload as { error?: { message?: string } }).error?.message ??
            `Export failed (${response.status})`,
        );
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `leads-export.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setExporting(null);
    }
  }
  return (
    <div className="content">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Automation opportunity pipeline</h3>
            <p>Each lead is backed by stored evidence and a versioned score.</p>
          </div>
          <div className="top-actions">
            <button
              className="row-action view-toggle"
              aria-pressed={leadView === "list"}
              onClick={() => setLeadView("list")}
            >
              List
            </button>
            <button
              className="row-action view-toggle"
              aria-pressed={leadView === "board"}
              onClick={() => setLeadView("board")}
            >
              Board
            </button>
            <button
              className="row-action"
              disabled={exporting !== null || data.leads.length === 0}
              onClick={() => void exportLeads("csv")}
            >
              {exporting === "csv" ? "Exporting…" : "Export CSV"}
            </button>
            <button
              className="row-action"
              disabled={exporting !== null || data.leads.length === 0}
              onClick={() => void exportLeads("json")}
            >
              {exporting === "json" ? "Exporting…" : "Export JSON"}
            </button>
          </div>
        </div>
        {exportError ? <p className="error-text">{exportError}</p> : null}
        {leadView === "list" ? (
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
              <button
                className="row-action"
                title="Review the automation use cases the engine identified for this lead and approve the ones to ship"
                onClick={() => void toggleUseCases(lead)}
              >
                Use cases
              </button>
              <button
                className="row-action"
                title="Draft the outreach proposal for this lead from its evidence and approved use cases"
                onClick={() => void toggleProposal(lead)}
              >
                Proposal
              </button>
              <button
                className="row-action"
                title="Build a signed handoff package and queue it for the Delivery Factory (requires at least one approved use case)"
                onClick={() => void handoff(lead)}
              >
                Send to DF
              </button>
              {handoffChip(lead)}
            </>
          )}
        />
        ) : (
          <>
          {pipelineStatus === "loading" ? (
            <p className="pipeline-notice">Loading pipeline state…</p>
          ) : null}
          {pipelineStatus === "error" ? (
            <p className="pipeline-notice pipeline-notice-error">
              Pipeline state could not be loaded
              {Object.keys(pipelineByLead).length > 0
                ? " — showing the last known state"
                : ""}
              . Stages may be incomplete; retrying automatically.
            </p>
          ) : null}
          <PipelineBoard
            leads={data.leads}
            handoffByLead={handoffByLead}
            pipelineByLead={pipelineByLead}
            onUseCases={(lead) => void toggleUseCases(lead)}
            onProposal={(lead) => void toggleProposal(lead)}
          />
          </>
        )}
        {deliveryBanner ? (
          <div
            className={`delivery-banner delivery-${deliveryBanner.outcome}`}
          >
            <span>
              {deliveryBanner.outcome === "landed"
                ? "✓ "
                : deliveryBanner.outcome === "failed"
                  ? "✗ "
                  : "… "}
              <b>{deliveryBanner.title}</b> — {deliveryBanner.detail}
            </span>
            <button
              type="button"
              className="text-button"
              onClick={() => setDeliveryBanner(null)}
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {useCaseLead ? (
          <div className="usecases-panel">
            <div className="usecases-head">
              <h4>Automation use cases — {useCaseLead.title}</h4>
              <button
                type="button"
                className="row-action"
                onClick={() => setUseCaseLead(null)}
              >
                Close
              </button>
            </div>
            <p className="muted">
              The engine identified these use cases from this lead&apos;s
              stored evidence — at least three for every qualified lead.
              Select the ones that fit and approve them: approved use
              cases ship to the Delivery Factory as human-validated Must
              requirements, with you recorded as the validator. Send to
              DF stays blocked until at least one is approved.
            </p>
            {useCaseRows?.some((row) => row.generation_source === "llm") ? (
              <p className="muted">
                Rows marked <b>AI-identified</b> were drafted by the AI
                from this lead&apos;s full stored evidence; each one is
                backed by a quote from the business&apos;s own pages
                that the system verified before showing it here.
              </p>
            ) : null}
            {useCaseError ? (
              <p className="error-text">{useCaseError}</p>
            ) : null}
            {!useCaseRows ? (
              <p className="muted">Loading use cases…</p>
            ) : (
              useCaseRows.map((row) => (
                <label key={row.id} className="usecase-row">
                  <input
                    type="checkbox"
                    checked={useCaseSelected.includes(row.id)}
                    onChange={() =>
                      setUseCaseSelected((current) =>
                        current.includes(row.id)
                          ? current.filter((id) => id !== row.id)
                          : [...current, row.id],
                      )
                    }
                  />
                  <span className="usecase-body">
                    <span className="usecase-title">
                      <b>{row.title}</b>
                      {row.generation_source === "llm" ? (
                        <span className="badge status-queued">
                          AI-identified
                        </span>
                      ) : null}
                      {row.status === "approved" ? (
                        <span className="badge status-success">
                          Approved — ships to DF
                        </span>
                      ) : null}
                    </span>
                    <small>{row.statement}</small>
                    <small className="usecase-rationale">
                      {row.rationale}
                    </small>
                    <small className="muted">
                      {row.acceptance_criteria.length} acceptance criteria
                      ship with the requirement.
                    </small>
                    {useCaseSelected.includes(row.id) ? (
                      <span className="usecase-measure">
                        <small>
                          <b>Success measure (the OKR promised to the lead):</b>
                        </small>
                        <input
                          type="text"
                          placeholder="Metric — e.g. Appointment no-show rate"
                          value={useCaseMeasures[row.id]?.metric ?? ""}
                          onClick={(event) => event.preventDefault()}
                          onChange={(event) =>
                            setUseCaseMeasures((current) => ({
                              ...current,
                              [row.id]: {
                                metric: event.target.value,
                                target: current[row.id]?.target ?? "",
                              },
                            }))
                          }
                        />
                        <input
                          type="text"
                          placeholder="Target — e.g. Reduced by at least 25% within 90 days"
                          value={useCaseMeasures[row.id]?.target ?? ""}
                          onClick={(event) => event.preventDefault()}
                          onChange={(event) =>
                            setUseCaseMeasures((current) => ({
                              ...current,
                              [row.id]: {
                                metric: current[row.id]?.metric ?? "",
                                target: event.target.value,
                              },
                            }))
                          }
                        />
                        <small className="muted">
                          Approved measures ship to DF as the success
                          measures it verifies delivery against.
                        </small>
                      </span>
                    ) : null}
                  </span>
                </label>
              ))
            )}
            <div className="usecases-actions">
              <button
                type="button"
                className="primary"
                disabled={
                  approving || !useCaseRows || useCaseSelected.length === 0
                }
                onClick={() => void approveUseCases()}
              >
                {approving
                  ? "Approving…"
                  : `Approve selection (${useCaseSelected.length})`}
              </button>
              <small className="muted">
                Approving stamps you as the human validator on each
                selected requirement.
              </small>
            </div>
          </div>
        ) : null}
        {proposalLead ? (
          <div className="usecases-panel">
            <div className="usecases-head">
              <h4>Proposal — {proposalLead.title}</h4>
              <button
                type="button"
                className="row-action"
                onClick={() => setProposalLead(null)}
              >
                Close
              </button>
            </div>
            <p className="muted">
              Outreach is drafted here in the Lead Engine, from this
              lead&apos;s evidence and its approved use cases — the
              success measures below are the OKRs you promise the
              lead, and the same numbers ship to the Delivery Factory
              to be measured after delivery. You review and approve
              the final text, and you send it yourself; nothing
              auto-sends.
            </p>
            {proposalError ? (
              <p className="error-text">{proposalError}</p>
            ) : null}
            {!proposalData ? (
              <p className="muted">Loading proposal…</p>
            ) : (
              <>
                <p className="muted">
                  Approved use cases: <b>{proposalData.approvedUseCases}</b>
                  {" · "}CASL consent basis:{" "}
                  <b>
                    {proposalData.consentRecorded
                      ? "recorded"
                      : "not recorded"}
                  </b>
                  {proposalData.proposal ? (
                    <>
                      {" · "}Status: <b>{proposalData.proposal.status}</b>
                      {proposalData.proposal.drafted_by === "llm"
                        ? " · Drafted by AI from the full evidence (quotes verified)"
                        : " · Template draft"}
                    </>
                  ) : null}
                </p>
                {!proposalData.consentRecorded ? (
                  <div className="consent-box">
                    <small>
                      <b>Record the consent basis first</b> — approval
                      stays blocked until a CASL basis exists for this
                      lead.
                    </small>
                    <span className="consent-row">
                      <select
                        value={consentBasis}
                        onChange={(event) => setConsentBasis(event.target.value)}
                      >
                        <option value="existing_relationship">
                          Existing relationship
                        </option>
                        <option value="inquiry">Inquiry</option>
                        <option value="consent">Consent</option>
                      </select>
                      <input
                        type="text"
                        placeholder="Evidence reference (e.g. public contact page, prior order)"
                        value={consentReference}
                        onChange={(event) =>
                          setConsentReference(event.target.value)
                        }
                      />
                      <button
                        type="button"
                        className="row-action"
                        disabled={proposalBusy}
                        onClick={() => void recordConsent()}
                      >
                        Record basis
                      </button>
                    </span>
                  </div>
                ) : null}
                {proposalData.proposal ? (
                  <>
                    <textarea
                      className="proposal-text"
                      rows={16}
                      value={proposalText}
                      disabled={proposalData.proposal.status !== "draft"}
                      onChange={(event) => setProposalText(event.target.value)}
                    />
                    {proposalData.proposal.evidence_quotes.length ? (
                      <small className="muted">
                        Evidence backing the draft:{" "}
                        {proposalData.proposal.evidence_quotes
                          .map((quote) => `"${quote}"`)
                          .join(" · ")}
                      </small>
                    ) : null}
                  </>
                ) : (
                  <p className="muted">
                    No proposal drafted yet.
                  </p>
                )}
                <div className="usecases-actions">
                  <button
                    type="button"
                    className="row-action"
                    disabled={
                      proposalBusy || proposalData.approvedUseCases === 0
                    }
                    onClick={() => void draftProposal()}
                  >
                    {proposalBusy
                      ? "Working…"
                      : proposalData.proposal
                        ? "Redraft with AI"
                        : "Draft proposal"}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={
                      proposalBusy ||
                      !proposalData.proposal ||
                      proposalData.proposal.status !== "draft" ||
                      !proposalData.consentRecorded
                    }
                    onClick={() => void approveProposal()}
                  >
                    Approve proposal
                  </button>
                  <button
                    type="button"
                    className="row-action"
                    disabled={
                      proposalBusy ||
                      !proposalData.proposal ||
                      proposalData.proposal.status !== "approved"
                    }
                    onClick={() => void markProposalSent()}
                  >
                    Mark as sent
                  </button>
                  <small className="muted">
                    Approve locks the text; send it from your own
                    mailbox, then mark it sent — the lead records a
                    “contacted” outcome.
                  </small>
                </div>
              </>
            )}
          </div>
        ) : null}
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
              <Score value={lead.opportunity_score} />
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

function PipelineBoard({
  leads,
  handoffByLead,
  pipelineByLead,
  onUseCases,
  onProposal,
}: {
  leads: LeadRecord[];
  handoffByLead: Record<string, HandoffStatusRow>;
  pipelineByLead: Record<string, PipelineLeadState>;
  onUseCases: (lead: LeadRecord) => void;
  onProposal: (lead: LeadRecord) => void;
}) {
  const inputsOf = (lead: LeadRecord): PipelineStageInputs => ({
    // The pipeline endpoint carries the complete per-lead handoff
    // status; the /handoffs map (capped at 200 rows) is a fallback.
    handoffStatus:
      pipelineByLead[lead.id]?.handoffStatus ??
      handoffByLead[lead.id]?.status ??
      null,
    proposalStatus: pipelineByLead[lead.id]?.proposalStatus ?? null,
    latestDecision: pipelineByLead[lead.id]?.latestDecision ?? null,
  });
  const stageOf = (lead: LeadRecord): PipelineStageId =>
    derivePipelineStage(inputsOf(lead));
  return (
    <div className="pipeline-board">
      {PIPELINE_STAGES.map((stage) => {
        const inStage = leads.filter((lead) => stageOf(lead) === stage.id);
        return (
          <div
            className={`pipeline-col pipeline-col--${stage.id}`}
            key={stage.id}
          >
            <div className="pipeline-col-head">
              <b>
                <span className="pipeline-dot" /> {stage.label}
              </b>
              <span>
                {inStage.length} ·{" "}
                {inStage.reduce(
                  (sum, lead) => sum + lead.opportunity_score,
                  0,
                )}{" "}
                pts
              </span>
            </div>
            {inStage.map((lead) => {
              const org = Array.isArray(lead.organizations)
                ? lead.organizations[0]
                : lead.organizations;
              const cardStatus = pipelineCardStatus(inputsOf(lead));
              return (
                <div className="pipeline-card" key={lead.id}>
                  <div className="op-name">
                    <span className="avatar">
                      {(org?.name ?? lead.title).slice(0, 2).toUpperCase()}
                    </span>
                    <div>
                      <b>{org?.name ?? lead.title}</b>
                      <small>{org?.normalized_domain ?? lead.routing}</small>
                    </div>
                  </div>
                  <p className="pipeline-card-meta">
                    Opportunity <b>{lead.opportunity_score}</b> · confidence{" "}
                    <b>{Math.round(lead.confidence * 100)}%</b>
                  </p>
                  <p className="pipeline-card-status">
                    {cardStatus.kind === "outcome" ? (
                      <>Last outcome: {cardStatus.decision}</>
                    ) : cardStatus.kind === "at_df" ? (
                      <span className="badge status-success">At DF ✓</span>
                    ) : cardStatus.kind === "proposal" ? (
                      <>Proposal: {cardStatus.status}</>
                    ) : cardStatus.kind === "decision" ? (
                      <>Last outcome: {cardStatus.decision}</>
                    ) : (
                      "Awaiting review"
                    )}
                  </p>
                  <div className="pipeline-card-actions">
                    <button
                      className="row-action"
                      onClick={() => onUseCases(lead)}
                    >
                      Use cases
                    </button>
                    <button
                      className="row-action"
                      onClick={() => onProposal(lead)}
                    >
                      Proposal
                    </button>
                  </div>
                </div>
              );
            })}
            {inStage.length === 0 ? (
              <p className="empty-state">No leads in this stage.</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function Operations({ data }: { data: BootstrapData }) {
  const { operations } = data;
  const alerts = operations.alerts ?? [];
  const openAlerts = alerts.filter((alert) => alert.status === "open");
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
        <Metric
          label="Open incidents"
          value={String(openAlerts.length)}
          detail={
            openAlerts.some((alert) => alert.severity === "critical")
              ? "Critical attention required"
              : "Slack transition alerts enabled"
          }
        />
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Operational incidents</h3>
            <p>
              Neon is the durable incident record; Slack receives opens,
              reminders, and recoveries.
            </p>
          </div>
        </div>
        <div className="record-list">
          {alerts.length ? alerts.slice(0, 20).map((alert) => (
            <div className="record-row" key={alert.id}>
              <div>
                <b>{alert.alert_type.replaceAll("_", " ")}</b>
                <small>
                  {alert.severity} · {alert.reason} · notified {alert.occurrence_count}x
                </small>
              </div>
              <Status value={alert.status} />
              <time>{new Date(alert.last_observed_at).toLocaleString()}</time>
            </div>
          )) : (
            <p className="empty-state">No operational incidents recorded.</p>
          )}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Spend gate</h3>
            <p>Infrastructure budget: CAD 150/month until CAD 1,000 MRR</p>
          </div>
        </div>
        <div className="help-content">
          <p>
            The operating-economics gate is a hard target: total infrastructure
            spend across <b>Neon</b>, <b>Vercel</b>, and <b>QStash</b> stays
            under <b>CAD 150/month</b> until the business reaches CAD 1,000 MRR.
            Billing alerts are the enforcement mechanism — set them up per the
            runbook before introducing any per-candidate LLM spend.
          </p>
          <ul>
            <li>
              Runbook: <code>docs/runbooks/spend-gate-billing-alerts.md</code>
            </li>
            <li>
              <a
                href="https://console.neon.tech"
                target="_blank"
                rel="noreferrer"
              >
                Neon console
              </a>{" "}
              — billing in project / organization settings
            </li>
            <li>
              <a
                href="https://vercel.com/dashboard"
                target="_blank"
                rel="noreferrer"
              >
                Vercel dashboard
              </a>{" "}
              — billing tab
            </li>
            <li>
              <a
                href="https://console.upstash.com"
                target="_blank"
                rel="noreferrer"
              >
                Upstash console
              </a>{" "}
              — QStash billing
            </li>
          </ul>
        </div>
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

/** Hierarchical audit: group events into run buckets, then build a
 * grandparent → parent → children tree within each bucket using the foreign
 * keys captured in before_state/after_state by the audit triggers. */
interface AuditNode {
  event: AuditRecord;
  children: AuditNode[];
}
interface AuditRun {
  id: string;
  title: string;
  startedAt: string;
  eventCount: number;
  roots: AuditNode[];
}

function auditEventKey(event: AuditRecord): string {
  return `${event.resource_type}:${event.resource_id ?? event.id}`;
}

function auditParentKey(event: AuditRecord): string | null {
  const state = (event.after_state ?? event.before_state ?? {}) as Record<
    string,
    unknown
  >;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  switch (event.resource_type) {
    case "scrape_job_attempts":
    case "evidence_artifacts": {
      const jobId = str(state.job_id);
      return jobId ? `scrape_jobs:${jobId}` : null;
    }
    case "signal_observations": {
      const evidenceId = str(state.evidence_id);
      if (evidenceId) return `evidence_artifacts:${evidenceId}`;
      const jobId = str(state.job_id);
      return jobId ? `scrape_jobs:${jobId}` : null;
    }
    case "maturity_assessments": {
      const jobId = str(state.job_id);
      if (jobId) return `scrape_jobs:${jobId}`;
      const orgId = str(state.organization_id);
      return orgId ? `organizations:${orgId}` : null;
    }
    case "opportunities": {
      const assessmentId = str(
        state.assessment_id ?? state.maturity_assessment_id,
      );
      if (assessmentId) return `maturity_assessments:${assessmentId}`;
      const orgId = str(state.organization_id);
      return orgId ? `organizations:${orgId}` : null;
    }
    case "organizations":
    case "scrape_jobs": {
      // Created during a job run — link via job_id when present.
      const jobId = str(state.job_id);
      if (jobId && auditEventKey(event) !== `scrape_jobs:${jobId}`)
        return `scrape_jobs:${jobId}`;
      return null;
    }
    default:
      return null;
  }
}

function buildAuditRuns(events: AuditRecord[]): AuditRun[] {
  if (events.length === 0) return [];
  const sorted = [...events].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  // Bucket into runs: a gap of more than 90 seconds starts a new run.
  const RUN_GAP_MS = 90_000;
  const buckets: AuditRecord[][] = [];
  for (const event of sorted) {
    const last = buckets[buckets.length - 1];
    if (
      !last ||
      new Date(event.created_at).getTime() -
        new Date(last[last.length - 1].created_at).getTime() >
        RUN_GAP_MS
    ) {
      buckets.push([event]);
    } else {
      last.push(event);
    }
  }
  return buckets.map((bucket, index) => {
    const nodes = new Map<string, AuditNode>();
    for (const event of bucket)
      nodes.set(auditEventKey(event), { event, children: [] });
    const roots: AuditNode[] = [];
    for (const event of bucket) {
      const node = nodes.get(auditEventKey(event))!;
      const parentKey = auditParentKey(event);
      const parent = parentKey ? nodes.get(parentKey) : undefined;
      if (parent && parent !== node) parent.children.push(node);
      else roots.push(node);
    }
    // Title from the most significant root (job > campaign > source).
    const rootActions = roots.map((r) => r.event.action);
    const jobRoot = roots.find((r) =>
      r.event.resource_type.startsWith("scrape_job"),
    );
    const title = jobRoot
      ? `Scrape run · ${jobRoot.event.resource_id?.slice(0, 8) ?? "job"}`
      : (rootActions[0]?.replace(/\./g, " ") ?? `Run ${index + 1}`);
    return {
      id: `run-${index}-${bucket[0].id}`,
      title,
      startedAt: bucket[0].created_at,
      eventCount: bucket.length,
      roots,
    };
  });
}

interface AuditDay {
  key: string;
  label: string;
  events: AuditRecord[];
  runs: AuditRun[];
}

const AUDIT_RANGES = [
  { days: 1, label: "24h" },
  { days: 3, label: "3d" },
  { days: 7, label: "7d" },
];

function Audit({
  data,
  session,
  workspaceId,
}: {
  data: BootstrapData;
  session: Session;
  workspaceId: string;
}) {
  const [expandedDayKey, setExpandedDayKey] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const [events, setEvents] = useState<AuditRecord[]>(data.audit);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiRequest<{ data: AuditRecord[] }>(
      session,
      workspaceId,
      `/api/v1/audit?days=${days}`,
    )
      .then((result) => {
        if (cancelled) return;
        setEvents(result.data ?? []);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, session, workspaceId]);

  const dayBuckets = useMemo<AuditDay[]>(() => {
    const byDay = new Map<string, AuditRecord[]>();
    for (const event of events) {
      const at = new Date(event.created_at);
      const key = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
      const list = byDay.get(key);
      if (list) list.push(event);
      else byDay.set(key, [event]);
    }
    return [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([key, dayEvents]) => ({
        key,
        label: new Date(`${key}T12:00:00`).toLocaleDateString(undefined, {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        }),
        events: dayEvents,
        runs: buildAuditRuns(dayEvents),
      }));
  }, [events]);
  // null follows the default: the most recent day starts expanded.
  const effectiveDayKey = expandedDayKey ?? dayBuckets[0]?.key ?? null;

  function renderNode(node: AuditNode, depth: number): ReactNode {
    const { event } = node;
    const expanded = expandedId === event.id;
    const oma = interpretAuditEvent(event);
    return (
      <div key={event.id}>
        <div
          className="record-row audit-row"
          style={{ paddingLeft: `${12 + depth * 20}px` }}
          onClick={() => setExpandedId(expanded ? null : event.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setExpandedId(expanded ? null : event.id);
            }
          }}
        >
          <div>
            <b>
              {depth > 0 && (
                <span aria-hidden="true" style={{ opacity: 0.5 }}>
                  {"└ ".repeat(Math.min(depth, 1))}
                </span>
              )}
              {event.action}
            </b>
            <small>
              {event.resource_type} · {event.resource_id ?? "workspace"}
              {node.children.length > 0 &&
                ` · ${node.children.length} linked record${node.children.length === 1 ? "" : "s"}`}
            </small>
          </div>
          <Status value={event.outcome} />
          <time>{new Date(event.created_at).toLocaleString()}</time>
          <span className="audit-chevron" aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
        </div>
        {expanded && (
          <div
            className="audit-detail"
            style={{ marginLeft: `${depth * 20}px` }}
          >
            <div className="audit-oma">
              <h4>Business interpretation</h4>
              <div className="oma-grid">
                <div className="oma-item">
                  <span className="oma-label">Observation</span>
                  <p>{oma.observation}</p>
                </div>
                <div className="oma-item">
                  <span className="oma-label">Metric</span>
                  <p>{oma.metric}</p>
                </div>
                <div className="oma-item">
                  <span className="oma-label">Action</span>
                  <p>{oma.action}</p>
                </div>
              </div>
            </div>
            <div className="audit-technical">
              <h4>Technical view</h4>
              <pre>
                {JSON.stringify(
                  {
                    id: event.id,
                    action: event.action,
                    resource_type: event.resource_type,
                    resource_id: event.resource_id,
                    outcome: event.outcome,
                    reason: event.reason,
                    actor_id: event.actor_id,
                    correlation_id: event.correlation_id,
                    created_at: event.created_at,
                    before_state: event.before_state,
                    after_state: event.after_state,
                  },
                  null,
                  2,
                )}
              </pre>
            </div>
          </div>
        )}
        {node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  function renderRun(run: AuditRun): ReactNode {
    const expanded = expandedRunId === run.id;
    return (
      <div key={run.id} className="audit-run">
        <div
          className="record-row audit-run-head"
          onClick={() => setExpandedRunId(expanded ? null : run.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setExpandedRunId(expanded ? null : run.id);
            }
          }}
        >
          <div>
            <b>{run.title}</b>
            <small>
              {run.eventCount} record{run.eventCount === 1 ? "" : "s"} ·{" "}
              {run.roots.length} top-level entr
              {run.roots.length === 1 ? "y" : "ies"}
            </small>
          </div>
          <time>{new Date(run.startedAt).toLocaleString()}</time>
          <span className="audit-chevron" aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
        </div>
        {expanded && run.roots.map((root) => renderNode(root, 0))}
      </div>
    );
  }

  function toggleDay(key: string, dayExpanded: boolean) {
    setExpandedDayKey(dayExpanded ? "" : key);
  }

  return (
    <div className="content">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Immutable application audit trail</h3>
            <p>
              Events are grouped by day, then bucketed into runs — expand a day,
              then a run, to walk its grandparent → parent → children tree.
              Click any entry to inspect it.
            </p>
          </div>
          <div
            className="range-buttons"
            role="group"
            aria-label="Audit history range"
          >
            {AUDIT_RANGES.map((range) => (
              <button
                key={range.days}
                type="button"
                className={
                  days === range.days ? "row-action active" : "row-action"
                }
                onClick={() => setDays(range.days)}
              >
                {range.label}
              </button>
            ))}
          </div>
        </div>
        {loading ? (
          <p style={{ padding: "4px 20px" }}>Loading audit history…</p>
        ) : null}
        <div className="record-list">
          {dayBuckets.map((day) => {
            const dayExpanded = effectiveDayKey === day.key;
            return (
              <div key={day.key} className="audit-day">
                <div
                  className="record-row audit-day-head"
                  onClick={() => toggleDay(day.key, dayExpanded)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleDay(day.key, dayExpanded);
                    }
                  }}
                >
                  <div>
                    <b>{day.label}</b>
                    <small>
                      {day.runs.length} run{day.runs.length === 1 ? "" : "s"} ·{" "}
                      {day.events.length} record
                      {day.events.length === 1 ? "" : "s"}
                    </small>
                  </div>
                  <span className="audit-chevron" aria-hidden="true">
                    {dayExpanded ? "▾" : "▸"}
                  </span>
                </div>
                {dayExpanded && day.runs.map((run) => renderRun(run))}
              </div>
            );
          })}
          {!loading && dayBuckets.length === 0 ? (
            <p style={{ padding: "4px 20px" }}>
              No audit events in this range yet.
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/** OMA Framework: Observation, Metric, Action — business interpretation of an audit event. */
function interpretAuditEvent(event: {
  action: string;
  resource_type: string;
  outcome: string;
  reason: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
}): { observation: string; metric: string; action: string } {
  const before = event.before_state ?? {};
  const after = event.after_state ?? {};
  const action = event.action.toLowerCase();

  // Source lifecycle
  if (action === "source_definitions.insert") {
    return {
      observation: `A new lead source "${String(after.name ?? after.base_url ?? "unknown")}" was submitted for policy approval.`,
      metric: `Status: ${String(after.status ?? "pending_approval")} · Collection method: ${String(after.collection_method ?? "—")}`,
      action:
        "Review the source's policy (allowed domains, rate limits, budgets), then approve it so it becomes available for scraping.",
    };
  }
  if (action === "source_definitions.update") {
    const from = String(before.status ?? "—");
    const to = String(after.status ?? "—");
    if (from !== to) {
      return {
        observation: `Source "${String(after.name ?? after.base_url ?? "unknown")}" moved from ${from} to ${to}.`,
        metric: `Status transition: ${from} → ${to}`,
        action:
          to === "active"
            ? "The source is now live — queue a scrape job against it to start collecting evidence."
            : "No action needed unless the change was unexpected; check the technical view for who made it.",
      };
    }
    return {
      observation: `Source "${String(after.name ?? after.base_url ?? "unknown")}" settings were edited.`,
      metric: "Configuration updated (see technical view for changed fields).",
      action:
        "Verify the edited values are correct; budgets and rate limits remain versioned by design.",
    };
  }

  // Scrape jobs
  if (action === "scrape_jobs.insert") {
    return {
      observation: `A new scrape job was queued for ${String(after.target_url ?? "a target URL")}.`,
      metric: `Initial status: ${String(after.status ?? "queued")} · Attempt 0 of ${String(after.max_attempts ?? 3)}`,
      action:
        "Watch the job on the Scrape jobs page — the worker picks it up within minutes.",
    };
  }
  if (action === "scrape_jobs.update") {
    const from = String(before.status ?? "—");
    const to = String(after.status ?? "—");
    const attempts = `${String(after.attempts ?? "?")}/${String(after.max_attempts ?? "?")}`;
    if (to === "completed") {
      return {
        observation: `Scrape job for ${String(after.target_url ?? "the target")} completed successfully.`,
        metric: `Attempts used: ${attempts} · Duration and evidence counts in technical view.`,
        action:
          "Check Qualified leads — newly scored businesses appear there once the criteria thresholds are applied.",
      };
    }
    if (to === "dead_letter") {
      return {
        observation: `Scrape job for ${String(after.target_url ?? "the target")} exhausted all retries and was dead-lettered.`,
        metric: `Attempts used: ${attempts} · Last error: ${String(after.last_error ?? before.last_error ?? "see attempt records")}`,
        action:
          "Inspect the failure reason (robots.txt denial, 404, timeout). Fix the target or source policy, then retry the job.",
      };
    }
    return {
      observation: `Scrape job for ${String(after.target_url ?? "the target")} moved from ${from} to ${to}.`,
      metric: `Status transition: ${from} → ${to} · Attempts: ${attempts}`,
      action:
        to === "leased"
          ? "A worker has picked up the job — no action needed."
          : "Monitor the job; it will retry automatically on transient failures.",
    };
  }
  if (action === "scrape_job_attempts.insert") {
    return {
      observation:
        "A worker started a new collection attempt for a scrape job.",
      metric: `Attempt ${String(after.attempt_number ?? "?")} began at ${String(after.started_at ?? "—")}`,
      action: "No action needed — the attempt runs automatically.",
    };
  }
  if (action === "scrape_job_attempts.update") {
    const ok =
      after.success === true ||
      String(after.status ?? "")
        .toLowerCase()
        .includes("success");
    return {
      observation: ok
        ? "A collection attempt finished successfully and its evidence was stored."
        : `A collection attempt failed: ${String(after.error ?? after.failure_reason ?? "see technical view")}.`,
      metric: `Finished at ${String(after.finished_at ?? "—")} · HTTP ${String(after.http_status ?? "—")}`,
      action: ok
        ? "No action needed — evidence flows into scoring automatically."
        : "If retries also fail, the job dead-letters; check the target URL and the source's robots policy.",
    };
  }

  // Scoring & leads
  if (action === "maturity_assessments.insert") {
    return {
      observation: "A business was scored for automation maturity.",
      metric: `Maturity score: ${String(after.maturity_score ?? "—")} · Confidence: ${String(after.confidence ?? "—")}`,
      action:
        "Scores feed the qualification thresholds — check Qualified leads for businesses that met the bar.",
    };
  }
  if (action === "opportunities.insert") {
    return {
      observation: `A new qualified lead was created: ${String(after.business_name ?? after.organization_id ?? "a business")}.`,
      metric: `Opportunity score: ${String(after.opportunity_score ?? after.score ?? "—")}`,
      action:
        "Review the lead in Qualified leads and export it when ready for outreach planning.",
    };
  }

  // Criteria
  if (
    action === "criteria.suggestion_applied" ||
    action.includes("suggestion_applied")
  ) {
    return {
      observation:
        "The engine's threshold suggestion was applied to the discovery campaign.",
      metric:
        event.reason ??
        "Thresholds adjusted (see technical view for before/after).",
      action:
        "Watch qualified-lead output over the next cycle to confirm the adjustment had the intended effect.",
    };
  }
  if (
    action === "criteria.auto_apply_changed" ||
    action.includes("auto_apply")
  ) {
    return {
      observation: `Automatic threshold application was ${after.auto_apply_criteria ? "enabled" : "disabled"}.`,
      metric: `auto_apply_criteria: ${String(before.auto_apply_criteria ?? "—")} → ${String(after.auto_apply_criteria ?? "—")}`,
      action: after.auto_apply_criteria
        ? "Future suggestions will apply themselves — review the audit trail periodically."
        : "Suggestions will now wait for manual approval on the Criteria & schedule page.",
    };
  }

  // Fallback
  const friendly = event.action.replace(/[._]/g, " ");
  return {
    observation: `Recorded change: ${friendly} on ${event.resource_type}.`,
    metric:
      event.reason ??
      `Outcome: ${event.outcome}. See the technical view for before/after state.`,
    action: "Expand the technical view to inspect exactly what changed.",
  };
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
  // "Release gate" health is the canary verdict plus worker presence.
  // (It previously keyed off the scheduled-start latency target, which
  // flips false whenever a large queue is draining normally.)
  const healthy =
    data.operations.workers.length > 0 && data.operations.canary.passed;
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
function HelpGuide() {
  return (
    <div className="content">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Lead Engine User Guide</h3>
            <p>
              How to use the Raphah Lead Engine — from first source to qualified
              lead.
            </p>
          </div>
        </div>
        <div className="help-content">
          <h4>1. Getting started</h4>
          <p>
            The Lead Engine discovers businesses with low automation maturity,
            scores them as opportunities, and keeps a continuously-refreshed
            list of qualified leads. Work flows through <b>workspaces</b> — your
            personal workspace was created automatically on first sign-in.
          </p>

          <h4>2. Sources &amp; policies — the approval gate</h4>
          <p>
            A <b>source</b> is a website or API you want to collect public
            evidence from. Nothing is collected until a source's policy is
            explicitly approved:
          </p>
          <ol>
            <li>
              Go to <b>Sources &amp; policies</b> → fill in <b>Add source</b>{" "}
              (name, base URL, collection method, purpose, contact email,
              refresh interval).
            </li>
            <li>
              The source is created with status <b>pending approval</b> — it
              appears in the list with a badge and an <b>Approve</b> button.
            </li>
            <li>
              Review the policy (allowed domains, rate limits, budgets), then
              click <b>Approve</b>. Only owners and administrators can approve.
            </li>
            <li>
              Once approved, the status becomes <b>active</b> and the source
              appears in the <b>Approved source</b> dropdown on the Scrape jobs
              page.
            </li>
          </ol>
          <p>
            <b>Why the gate?</b> The Lead Engine only collects public evidence
            for a stated business purpose. The approval step is your record that
            a human reviewed and permitted the collection.
          </p>
          <p>
            <b>Bulk import:</b> the <b>Import sources</b> panel below the source
            list accepts a CSV with <b>name</b> and <b>website</b>
            columns (a template is downloadable from the panel). Each row
            becomes one source with its own policy, duplicates are skipped, and
            nothing is collected until you approve each source — or tick
            <b>Approve all on import</b> (owners and administrators only) to
            activate them immediately.
          </p>

          <p>
            <b>Discovery sources</b> (the <b>Discovery</b> view) find candidate
            businesses via the OpenStreetMap/Overpass engine. Use is subject to
            the Overpass API usage policy and OpenStreetMap attribution (ODbL)
            terms — see Compliance References in the product documentation.
          </p>

          <h4>3. Criteria &amp; schedule — what counts as a lead</h4>
          <p>Each discovery campaign has scoring thresholds:</p>
          <ul>
            <li>
              <b>Maximum maturity</b> — only businesses scoring at or below this
              automation-maturity level qualify (lower = less automated = better
              prospect).
            </li>
            <li>
              <b>Minimum opportunity</b> — the opportunity score a business must
              reach.
            </li>
            <li>
              <b>Confidence %</b> — minimum evidence confidence.
            </li>
            <li>
              <b>Evidence categories</b> — how many distinct evidence types must
              be observed.
            </li>
            <li>
              <b>Geography</b> — limit discovery to cities, regions, or a radius
              around a point.
            </li>
          </ul>
          <p>
            The engine watches your qualified-lead output and suggests threshold
            adjustments (e.g. "loosen" when output is below target). Click{" "}
            <b>Apply suggestion</b> to accept, or edit the values manually and
            save. Enable <b>auto-apply</b> to let future suggestions apply
            themselves.
          </p>

          <h4>4. Scrape jobs — collecting evidence</h4>
          <p>
            Go to <b>Scrape jobs</b>, pick an <b>approved source</b>, enter a
            public target URL, and click <b>Queue scrape</b>. Jobs move through
            a durable lifecycle: <b>queued → leased → completed</b> (or retried,
            then dead-lettered after max attempts). Every job stays queryable in
            the job table.
          </p>

          <h4>5. Qualified leads — the output</h4>
          <p>
            <b>Qualified leads</b> lists businesses that met your criteria,
            ranked by opportunity potential. Each lead links to its evidence.
            Export the list for outreach — note: the system drafts messages, a
            human approves and sends them (no automated outreach).
          </p>

          <h4>6. Operations &amp; audit</h4>
          <p>
            <b>Operations</b> shows worker health, job throughput, and the
            canary status (the hourly pipeline smoke test). <b>Audit log</b>
            records every significant action — source approvals, criteria
            changes, and handoffs — for compliance review.
          </p>

          <h4>7. Job Bank market, rescore &amp; History</h4>
          <p>
            <b>Job Bank market.</b> The engine reads Canada Job Bank open
            data for clinic front-desk roles (dental/medical receptionist
            and related postings). When a clinic&apos;s city shows active
            demand — at least 10 postings in the last 60 days — that
            market hiring is added to the clinic&apos;s intent/trigger
            evidence at scoring time. It is market-level and inferential:
            Job Bank does not disclose which employer is hiring. The{" "}
            <b>Job Bank market</b> view shows the current snapshot —
            postings by city, the top roles, and month-over-month change.
            The bridge applies market evidence only while an approved
            Job Bank discovery source exists and the Canada Job Bank
            terms are accepted: retire that source (or remove the
            acceptance) and the daily refresh stops <i>and</i> scoring
            and rescoring stop applying the stored snapshot. The last
            snapshot remains visible in the market view for reference,
            with its sync date.
          </p>
          <p>
            <b>Job Bank market signal strength</b> (Criteria &amp;
            schedule) is the saved weight of that market evidence, from
            0 to 40; 0 turns the bridge off for the campaign. On-site
            hiring signals weigh 14–22 by comparison, so 20 is a
            meaningful but not decisive contribution.
          </p>
          <p>
            <b>Rescore assessments.</b> Scoring normally happens once,
            when evidence is collected. A rescore recomputes a
            campaign&apos;s stored assessments from their stored
            evidence and signals — no site is re-scraped — under the
            criteria you choose. Use <b>Dry-run</b> first: it projects
            how many leads would qualify and shows the top 20 with
            before/after scores, and writes nothing. The{" "}
            <b>Threshold (this run)</b> and <b>Job Bank strength (this
            run)</b> fields override the saved criteria for that run
            only. A real rescore writes a <b>new</b> assessment for each
            lead — originals are preserved for audit — and is
            idempotent: re-running with unchanged criteria and market
            data reports the rows as already current instead of writing
            duplicates. Opportunities are never deleted by a rescore;
            one that stops qualifying is marked unqualified and leaves
            the review queue, and its history is kept.
          </p>
          <p>
            <b>Use cases &amp; sending a lead to the Delivery Factory.</b>{" "}
            For every qualified lead, the engine identifies at least
            three automation use cases from the lead&apos;s stored
            evidence (for example, phone-only booking → online booking;
            paper intake → digital intake). Open <b>Use cases</b> on
            the lead&apos;s row, select the ones that fit, and{" "}
            <b>Approve</b> — approved use cases become the handoff
            package&apos;s requirement baseline as human-validated Must
            requirements, with you recorded as the validator. The
            Delivery Factory refuses packages without a validated
            baseline, so <b>Send to DF</b> stays blocked until at least
            one use case is approved. Delivery is confirmed, not
            assumed: after sending, the lead shows a live delivery
            chip — <i>Sending to DF…</i> while the factory has not yet
            accepted, <i>At DF ✓</i> once it has, and{" "}
            <i>DF delivery failed</i> (with the reason) if the push
            fails terminally — plus a confirmation banner when the
            outcome lands. Action messages (toasts) stay on screen for
            at least 5 seconds.
          </p>
          <p>
            <b>Proposals &amp; outreach.</b> Outreach lives in the
            Lead Engine — the Delivery Factory only ever receives
            leads this workspace has endorsed. On a qualified lead,
            open <b>Proposal</b>: the draft is written from the
            lead&apos;s full evidence and its approved use cases, and
            every factual claim is backed by a verified evidence
            quote. Each approved use case carries a success measure
            (an OKR you can edit before approving); those measures
            are promised to the lead in the proposal and ship in the
            handoff package as the success measures the Delivery
            Factory verifies after delivery. Approving the proposal
            requires a recorded CASL consent basis for the lead (the
            panel includes the form). You send the approved text
            yourself — nothing auto-sends — and <b>Mark as sent</b>{" "}
            records the “contacted” outcome on the lead.
          </p>
          <p>
            <b>Re-queue scrape</b> (on each campaign card) queues a fresh
            scrape of the campaign source&apos;s base URL under the
            currently saved criteria — save first if you changed
            anything.
          </p>
          <p>
            <b>History — retiring sources and campaigns.</b> Retiring is
            the auditable alternative to deleting. A retired source
            stops collecting everywhere; a retired campaign stops its
            schedule, criteria automation, and discovery collection.
            Records, jobs, assessments, and audit history are
            preserved, and retired entries appear under <b>History</b>{" "}
            on the Sources and Criteria pages, where <b>Restore</b>{" "}
            returns each one to the exact status it held before
            retiring — restoring never approves anything that was not
            already approved. A source cannot retire while its jobs are
            still in flight (queued, leased, running, or retrying); let
            them finish or dead-letter first. Only owners and
            administrators can retire or restore.
          </p>

          <h4>Troubleshooting</h4>
          <ul>
            <li>
              <b>Source dropdown is empty</b> — no active sources in this
              workspace yet. Create one under Sources &amp; policies and approve
              it.
            </li>
            <li>
              <b>Stuck on "Workspace initializing"</b> — refresh the page; the
              bootstrap retries automatically.
            </li>
            <li>
              <b>"Request failed (404)"</b> — the data plane had a hiccup; click
              Refresh or reload the page.
            </li>
          </ul>
        </div>
      </section>
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
