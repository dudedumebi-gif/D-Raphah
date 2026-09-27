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
  type DiscoveryRunRecord,
  type DiscoverySourceRecord,
  type FunnelStats,
  type JobRecord,
  type LeadRecord,
  type Membership,
  type Session,
} from "./api";
import { Settings } from "./CriteriaSettings";
import { JobLiveWindow } from "./JobLiveWindow";
import {
  normalizeSourceUrl,
  parseSourceCsv,
  type SourceImportRow,
} from "../api/_lib/source-import";
import "./styles.css";
import "./functionality.css";

type View =
  | "overview"
  | "sources"
  | "discovery"
  | "jobs"
  | "leads"
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
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(
    "Connecting to the production data plane…",
  );

  useEffect(() => {
    void (async () => {
      // Retry the bootstrap RPC — the session JWT can take a moment to
      // propagate to the Data API after sign-in, causing a transient failure
      // on the first attempt. Retry with backoff instead of giving up.
      let bootstrap: { error: { message: string } | null } | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
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
        <div className="sticky-header">
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
        </div>
        {!data ? (
          <Centered
            title="Loading workspace"
            detail="Fetching sources, jobs, leads, and telemetry."
          />
        ) : (
          <DashboardView
            view={view}
            setView={setView}
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
}: {
  data: BootstrapData;
  session: Session;
  workspaceId: string;
}) {
  const [live, setLive] = useState<FunnelStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiRequest<{ data?: FunnelStats }>(session, workspaceId, "/api/v1/funnel")
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
  }, [session, workspaceId]);

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
        <span key={`arrow-${index}`} className="funnel-arrow" aria-hidden="true">
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
      {diagnosis ? (
        <p className="muted funnel-diagnosis">{diagnosis}</p>
      ) : null}
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
}: {
  view: View;
  setView: (view: View) => void;
  data: BootstrapData;
  mutate: Mutate;
  session: Session;
  workspaceId: string;
}) {
  if (view === "sources") return <Sources data={data} mutate={mutate} />;
  if (view === "discovery")
    return (
      <Discovery
        data={data}
        mutate={mutate}
        session={session}
        workspaceId={workspaceId}
      />
    );
  if (view === "jobs")
    return (
      <Jobs data={data} mutate={mutate} session={session} workspaceId={workspaceId} />
    );
  if (view === "leads")
    return (
      <Leads data={data} mutate={mutate} session={session} workspaceId={workspaceId} />
    );
  if (view === "operations") return <Operations data={data} />;
  if (view === "audit")
    return <Audit data={data} session={session} workspaceId={workspaceId} />;
  if (view === "settings")
    return <Settings data={data} mutate={mutate} />;
  if (view === "help") return <HelpGuide />;
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
      <FunnelStrip data={data} session={session} workspaceId={workspaceId} />
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
  "name,website,collection_method,business_purpose\n" +
  '"Example Business",https://example.com,static_html,"Identify public evidence of manual processes and automation opportunity."\n';

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
}: {
  data: BootstrapData;
  mutate: Mutate;
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
      <form className="inline-form" onSubmit={(event) => event.preventDefault()}>
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

function Sources({ data, mutate }: { data: BootstrapData; mutate: Mutate }) {
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
    <>
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
              <button
                className="row-action"
                onClick={() =>
                  setEditingId(editingId === source.id ? null : source.id)
                }
              >
                {editingId === source.id ? "Cancel" : "Edit"}
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
      <div className="content">
        <ImportSources data={data} mutate={mutate} />
      </div>
    </>
  );
}

const DISCOVERY_CITIES = ["Toronto", "Ottawa", "Montreal", "Custom"];

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
}: {
  data: BootstrapData;
  mutate: Mutate;
  session: Session;
  workspaceId: string;
}) {
  const [sources, setSources] = useState<DiscoverySourceRecord[] | null>(null);
  const [runs, setRuns] = useState<DiscoveryRunRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [city, setCity] = useState("Toronto");
  const [runningId, setRunningId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [sourceResult, runResult] = await Promise.all([
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
      ]);
      setSources(sourceResult.data);
      setRuns(runResult.data);
    } catch {
      // mutate() surfaces request errors; the lists simply stay stale.
    } finally {
      setLoading(false);
    }
  }, [session, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
    const campaignId = String(form.get("campaignId") ?? "");
    const result = await mutate(
      "/api/v1/discovery/sources",
      {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          adapterId: "overpass",
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

  return (
    <>
      <div className="content split-layout">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Discovery sources</h3>
              <p>
                Business discovery over OpenStreetMap. Discovered websites are
                enqueued as scrape jobs under the linked collection source, so
                its approved policy governs collection.
              </p>
            </div>
          </div>
          {loading ? (
            <p className="muted">Loading discovery sources…</p>
          ) : (
            <div className="record-list">
              {(sources ?? []).map((source) => (
                <div className="record-row" key={source.id}>
                  <div>
                    <b>{source.name}</b>
                    <small>
                      {geoSummary(source.geo_params)} ·{" "}
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
                Free Overpass adapter — no API key required. Use is subject to
                the Overpass API usage policy and OpenStreetMap attribution
                (ODbL) terms.
              </p>
            </div>
          </div>
          <form className="inline-form" onSubmit={(e) => void submit(e)}>
            <label>
              Name
              <input name="name" minLength={2} maxLength={160} required />
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
                <span>{run.candidates_enqueued ?? "—"}</span>
              </div>
            ))}
          </div>
          {(runs ?? []).length === 0 && !loading ? (
            <p className="muted">No discovery runs yet.</p>
          ) : null}
        </section>
      </div>
    </>
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
    await mutate(
      "/api/v1/handoffs",
      {
        method: "POST",
        body: JSON.stringify({ opportunityId: lead.id }),
      },
      `Handoff package for ${lead.title} queued for the Delivery Factory.`,
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
      setExportError(
        error instanceof Error ? error.message : "Export failed.",
      );
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
                title="Build a signed handoff package and queue it for the Delivery Factory"
                onClick={() => void handoff(lead)}
              >
                Send to DF
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
            <h3>Spend gate</h3>
            <p>Infrastructure budget: CAD 150/month until CAD 1,000 MRR</p>
          </div>
        </div>
        <div className="help-content">
          <p>
            The operating-economics gate is a hard target: total infrastructure
            spend across <b>Neon</b>, <b>Vercel</b>, and <b>QStash</b> stays
            under <b>CAD 150/month</b> until the business reaches CAD 1,000
            MRR. Billing alerts are the enforcement mechanism — set them up
            per the runbook before introducing any per-candidate LLM spend.
          </p>
          <ul>
            <li>
              Runbook:{" "}
              <code>docs/runbooks/spend-gate-billing-alerts.md</code>
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
              <a href="https://vercel.com/dashboard" target="_blank" rel="noreferrer">
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
      const assessmentId = str(state.assessment_id ?? state.maturity_assessment_id);
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
      : rootActions[0]?.replace(/\./g, " ") ?? `Run ${index + 1}`;
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
              Events are grouped by day, then bucketed into runs — expand a
              day, then a run, to walk its grandparent → parent → children
              tree. Click any entry to inspect it.
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
                      {day.runs.length} run{day.runs.length === 1 ? "" : "s"}{" "}
                      · {day.events.length} record
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
      action: "Review the source's policy (allowed domains, rate limits, budgets), then approve it so it becomes available for scraping.",
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
      action: "Verify the edited values are correct; budgets and rate limits remain versioned by design.",
    };
  }

  // Scrape jobs
  if (action === "scrape_jobs.insert") {
    return {
      observation: `A new scrape job was queued for ${String(after.target_url ?? "a target URL")}.`,
      metric: `Initial status: ${String(after.status ?? "queued")} · Attempt 0 of ${String(after.max_attempts ?? 3)}`,
      action: "Watch the job on the Scrape jobs page — the worker picks it up within minutes.",
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
        action: "Check Qualified leads — newly scored businesses appear there once the criteria thresholds are applied.",
      };
    }
    if (to === "dead_letter") {
      return {
        observation: `Scrape job for ${String(after.target_url ?? "the target")} exhausted all retries and was dead-lettered.`,
        metric: `Attempts used: ${attempts} · Last error: ${String(after.last_error ?? before.last_error ?? "see attempt records")}`,
        action: "Inspect the failure reason (robots.txt denial, 404, timeout). Fix the target or source policy, then retry the job.",
      };
    }
    return {
      observation: `Scrape job for ${String(after.target_url ?? "the target")} moved from ${from} to ${to}.`,
      metric: `Status transition: ${from} → ${to} · Attempts: ${attempts}`,
      action: to === "leased" ? "A worker has picked up the job — no action needed." : "Monitor the job; it will retry automatically on transient failures.",
    };
  }
  if (action === "scrape_job_attempts.insert") {
    return {
      observation: "A worker started a new collection attempt for a scrape job.",
      metric: `Attempt ${String(after.attempt_number ?? "?")} began at ${String(after.started_at ?? "—")}`,
      action: "No action needed — the attempt runs automatically.",
    };
  }
  if (action === "scrape_job_attempts.update") {
    const ok = after.success === true || String(after.status ?? "").toLowerCase().includes("success");
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
      action: "Scores feed the qualification thresholds — check Qualified leads for businesses that met the bar.",
    };
  }
  if (action === "opportunities.insert") {
    return {
      observation: `A new qualified lead was created: ${String(after.business_name ?? after.organization_id ?? "a business")}.`,
      metric: `Opportunity score: ${String(after.opportunity_potential_score ?? after.score ?? "—")}`,
      action: "Review the lead in Qualified leads and export it when ready for outreach planning.",
    };
  }

  // Criteria
  if (action === "criteria.suggestion_applied" || action.includes("suggestion_applied")) {
    return {
      observation: "The engine's threshold suggestion was applied to the discovery campaign.",
      metric: event.reason ?? "Thresholds adjusted (see technical view for before/after).",
      action: "Watch qualified-lead output over the next cycle to confirm the adjustment had the intended effect.",
    };
  }
  if (action === "criteria.auto_apply_changed" || action.includes("auto_apply")) {
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
    metric: event.reason ?? `Outcome: ${event.outcome}. See the technical view for before/after state.`,
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
function HelpGuide() {
  return (
    <div className="content">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Lead Engine User Guide</h3>
            <p>How to use the Raphah Lead Engine — from first source to qualified lead.</p>
          </div>
        </div>
        <div className="help-content">
          <h4>1. Getting started</h4>
          <p>
            The Lead Engine discovers businesses with low automation maturity,
            scores them as opportunities, and keeps a continuously-refreshed
            list of qualified leads. Work flows through <b>workspaces</b> —
            your personal workspace was created automatically on first sign-in.
          </p>

          <h4>2. Sources &amp; policies — the approval gate</h4>
          <p>
            A <b>source</b> is a website or API you want to collect public
            evidence from. Nothing is collected until a source's policy is
            explicitly approved:
          </p>
          <ol>
            <li>Go to <b>Sources &amp; policies</b> → fill in <b>Add source</b> (name, base URL, collection method, purpose, contact email, refresh interval).</li>
            <li>The source is created with status <b>pending approval</b> — it appears in the list with a badge and an <b>Approve</b> button.</li>
            <li>Review the policy (allowed domains, rate limits, budgets), then click <b>Approve</b>. Only owners and administrators can approve.</li>
            <li>Once approved, the status becomes <b>active</b> and the source appears in the <b>Approved source</b> dropdown on the Scrape jobs page.</li>
          </ol>
          <p>
            <b>Why the gate?</b> The Lead Engine only collects public evidence
            for a stated business purpose. The approval step is your record
            that a human reviewed and permitted the collection.
          </p>
          <p>
            <b>Bulk import:</b> the <b>Import sources</b> panel below the
            source list accepts a CSV with <b>name</b> and <b>website</b>
            columns (a template is downloadable from the panel). Each row
            becomes one source with its own policy, duplicates are skipped,
            and nothing is collected until you approve each source — or tick
            <b>Approve all on import</b> (owners and administrators only) to
            activate them immediately.
          </p>

          <p>
            <b>Discovery sources</b> (the <b>Discovery</b> view) find candidate
            businesses via the OpenStreetMap/Overpass engine. Use is subject
            to the Overpass API usage policy and OpenStreetMap attribution
            (ODbL) terms — see Compliance References in the product
            documentation.
          </p>

          <h4>3. Criteria &amp; schedule — what counts as a lead</h4>
          <p>Each discovery campaign has scoring thresholds:</p>
          <ul>
            <li><b>Maximum maturity</b> — only businesses scoring at or below this automation-maturity level qualify (lower = less automated = better prospect).</li>
            <li><b>Minimum opportunity</b> — the opportunity score a business must reach.</li>
            <li><b>Confidence %</b> — minimum evidence confidence.</li>
            <li><b>Evidence categories</b> — how many distinct evidence types must be observed.</li>
            <li><b>Geography</b> — limit discovery to cities, regions, or a radius around a point.</li>
          </ul>
          <p>
            The engine watches your qualified-lead output and suggests
            threshold adjustments (e.g. "loosen" when output is below target).
            Click <b>Apply suggestion</b> to accept, or edit the values
            manually and save. Enable <b>auto-apply</b> to let future
            suggestions apply themselves.
          </p>

          <h4>4. Scrape jobs — collecting evidence</h4>
          <p>
            Go to <b>Scrape jobs</b>, pick an <b>approved source</b>, enter a
            public target URL, and click <b>Queue scrape</b>. Jobs move through
            a durable lifecycle: <b>queued → leased → completed</b> (or
            retried, then dead-lettered after max attempts). Every job stays
            queryable in the job table.
          </p>

          <h4>5. Qualified leads — the output</h4>
          <p>
            <b>Qualified leads</b> lists businesses that met your criteria,
            ranked by opportunity potential. Each lead links to its evidence.
            Export the list for outreach — note: the system drafts messages,
            a human approves and sends them (no automated outreach).
          </p>

          <h4>6. Operations &amp; audit</h4>
          <p>
            <b>Operations</b> shows worker health, job throughput, and the
            canary status (the hourly pipeline smoke test). <b>Audit log</b>
            records every significant action — source approvals, criteria
            changes, and handoffs — for compliance review.
          </p>

          <h4>Troubleshooting</h4>
          <ul>
            <li><b>Source dropdown is empty</b> — no active sources in this workspace yet. Create one under Sources &amp; policies and approve it.</li>
            <li><b>Stuck on "Workspace initializing"</b> — refresh the page; the bootstrap retries automatically.</li>
            <li><b>"Request failed (404)"</b> — the data plane had a hiccup; click Refresh or reload the page.</li>
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
