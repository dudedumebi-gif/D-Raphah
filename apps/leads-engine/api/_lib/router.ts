import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CriteriaSchema,
  evaluateCanarySoak,
  isSuggestionSuppressed,
  mergeSuggestionChanges,
  percentile95,
  suggestCriteriaAdjustment,
} from "./domain.js";
import {
  assertDatabaseReady,
  configurationStatus,
  createAdminClient,
  type DataClient,
  requireScheduler,
  requireRole,
  requireUserContext,
} from "./neon.js";
import { log, reportError, requestContext } from "./telemetry.js";
import {
  buildHandoffPackage,
  enqueueHandoffOutbox,
  tryImmediateDispatch,
  type SqlClient,
} from "./handoff.js";
import {
  cleanEvidenceText,
  draftUseCasesWithLlm,
  generateUseCases,
  mergeUseCaseCandidates,
  type SignalLike,
} from "./use-cases.js";
import {
  draftProposalWithLlm,
  templateProposal,
  type ApprovedUseCaseForProposal,
} from "./proposals.js";
import { ingestDeliveryFeedback } from "./feedback.js";
import {
  dedupeRows,
  mapRowToSourceInput,
  normalizeSourceUrl,
} from "./source-import.js";
import { enqueueCanary, runWorkerTick } from "./worker.js";
import { dryRunRescore, rescoreCampaignBatch } from "./rescore.js";
import {
  isRetired,
  retireDecision,
  type RetireOutcome,
} from "./archive.js";
import { readJobBankMarketView } from "./job-bank-market.js";
import {
  DiscoveryGeoInputSchema,
  normalizeWebsiteUrl,
  resolveGeoQuery,
} from "./discovery/adapter.js";
import {
  createDiscoveryAdapters,
  DiscoveryAdapterIdSchema,
  parseDiscoveryAdapterConfig,
} from "./discovery/registry.js";
import {
  runDiscoveryRun,
  type DiscoverySourceRow,
  type DiscoveryStore,
} from "./discovery/run.js";
import {
  DISCOVERY_TERMS,
  requireTermsAcceptance,
  termsForAdapter,
} from "./discovery/terms.js";
import { runScheduledDiscovery } from "./discovery/schedule.js";
import {
  checkOperationalAlerts,
  recordQstashFailure,
  recordQstashSuccess,
  type AlertSqlClient,
} from "./alerts.js";

const QstashFailureSchema = z.object({
  status: z.number().int().optional(),
  retried: z.number().int().nonnegative().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  sourceMessageId: z.string().optional(),
  scheduleId: z.string().optional(),
  dlqId: z.string().optional(),
  url: z.string().url().optional(),
  sourceBody: z.string().optional(),
}).passthrough();

const ConsentInputSchema = z.object({
  organizationId: z.string().uuid().optional(),
  opportunityId: z.string().uuid().optional(),
  basisType: z.enum(["consent", "existing_relationship", "inquiry"]),
  evidenceReference: z.string().min(1).max(500).optional(),
  notes: z.string().max(2_000).optional(),
});

const SourceInputSchema = z.object({
  name: z.string().min(2).max(160),
  baseUrl: z.string().url(),
  collectionMethod: z.enum(["api", "rss", "sitemap", "static_html"]),
  businessPurpose: z.string().min(10).max(1_000),
  allowedDomains: z.array(z.string().min(1)).min(1),
  allowDiscoveredDomains: z.boolean().default(false),
  allowlistPaths: z.array(z.string()).default(["/*"]),
  denylistPaths: z.array(z.string()).default([]),
  dailyBudget: z.number().int().min(1).max(100_000).default(100),
  monthlyBudget: z.number().int().min(1).max(1_000_000).default(2_000),
  maxDepth: z.number().int().min(0).max(10).default(2),
  rateLimitRps: z.number().min(0.05).max(10).default(1),
  retentionMonths: z.number().int().min(1).max(84).default(12),
  intervalMinutes: z.number().int().min(5).max(43_200).default(1_440),
  userAgent: z.string().min(3).default("RaphahLeadEngineBot/2.0"),
  contactEmail: z.string().email(),
  dataMode: z.enum(["demo", "pilot", "production"]).default("pilot"),
});

const ManualJobSchema = z.object({
  sourceId: z.string().uuid(),
  // Optional: the campaign card's "Re-queue scrape" sends only a
  // sourceId and means "scrape the source's base URL again"; the
  // route falls back to the source's base_url when it is omitted.
  targetUrl: z.string().url().optional(),
  maxAttempts: z.number().int().min(1).max(10).default(3),
});

const SourceImportBodySchema = z.object({
  rows: z
    .array(
      z.object({
        name: z.string(),
        website: z.string(),
        collectionMethod: z
          .enum(["api", "rss", "sitemap", "static_html"])
          .optional(),
        businessPurpose: z.string().optional(),
        allowDiscoveredDomains: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(200),
  contactEmail: z.string().email(),
  approveAll: z.boolean().optional().default(false),
  dataMode: z.enum(["demo", "pilot", "production"]).default("pilot"),
});

const DiscoverySourceInputSchema = z.object({
  name: z.string().min(2).max(160),
  adapterId: DiscoveryAdapterIdSchema,
  geo: DiscoveryGeoInputSchema,
  adapterConfig: z.record(z.unknown()).default({}),
  dataMode: z.enum(["demo", "pilot", "production"]).default("pilot"),
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid().optional(),
});

const CandidateResolutionInputSchema = z.object({
  website: z.string().url().max(2000),
  notes: z.string().min(3).max(1000),
});

function json(
  data: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

function withCors(
  response: Response,
  request: Request,
  pathname: string,
): Response {
  const origin = request.headers.get("origin");
  const configured = process.env.LEAD_ENGINE_ORIGIN;
  if (pathname === "/api/health/live" || pathname === "/api/health/ready") {
    // Public, unauthenticated health endpoints: any origin may read them.
    // Without this, browser-based monitoring (e.g. the Delivery Factory
    // dashboard polling cross-origin) is blocked and reports "Unreachable".
    response.headers.set("access-control-allow-origin", "*");
  } else if (origin && configured && origin === configured) {
    response.headers.set("access-control-allow-origin", origin);
    response.headers.set("vary", "Origin");
  }
  response.headers.set(
    "access-control-allow-headers",
    "Authorization, Content-Type, X-Workspace-ID, X-Correlation-ID, Idempotency-Key",
  );
  response.headers.set(
    "access-control-allow-methods",
    "GET, POST, PATCH, DELETE, OPTIONS",
  );
  return response;
}

async function bodyJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw Object.assign(new Error("Content-Type must be application/json"), {
      statusCode: 415,
    });
  }
  return request.json();
}

async function schedulerName(request: Request): Promise<string | undefined> {
  try {
    const value = await request.clone().json() as { schedule?: unknown };
    return typeof value.schedule === "string" ? value.schedule : undefined;
  } catch {
    return undefined;
  }
}

function schedulerWorkspaceId(): string {
  const workspaceId = process.env.LEAD_ENGINE_CANARY_WORKSPACE_ID;
  if (!workspaceId) throw new Error("LEAD_ENGINE_CANARY_WORKSPACE_ID is required");
  return workspaceId;
}

// --- Lead export (lead-vision gap 2): pure serialization helpers. ---

const EXPORT_FORMATS = ["csv", "json"] as const;
export type LeadExportFormat = (typeof EXPORT_FORMATS)[number];

/** Bounded page size: export reuses the leads list query, capped. */
export const EXPORT_MAX_LEADS = 5_000;

export function parseExportFormat(raw: string | null): LeadExportFormat {
  if (raw === "csv" || raw === "json") return raw;
  throw Object.assign(
    new Error(`format must be one of: ${EXPORT_FORMATS.join(", ")}`),
    { statusCode: 400 },
  );
}

export function exportFilename(
  format: LeadExportFormat,
  now = new Date(),
): string {
  return `leads-export-${now.toISOString().slice(0, 10)}.${format}`;
}

/** CSV escaping: wrap in quotes when the value contains a quote, comma, or newline. */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const LEAD_EXPORT_COLUMNS = [
  "lead_id",
  "organization_name",
  "domain",
  "website",
  "title",
  "stage",
  "status",
  "routing",
  "automation_maturity_score",
  "opportunity_score",
  "confidence",
  "coverage_categories",
  "qualified",
  "last_refreshed_at",
  "created_at",
] as const;

/**
 * Maps one leads-list row (same select/joins as GET /api/v1/leads) to a flat,
 * serialization-ready export object. Supabase returns the joined relations
 * as objects or single-element arrays; both are handled.
 */
export function mapExportLeadRow(lead: any): Record<string, unknown> {
  const organization = Array.isArray(lead.organizations)
    ? lead.organizations[0]
    : lead.organizations;
  const assessment = Array.isArray(lead.maturity_assessments)
    ? lead.maturity_assessments[0]
    : lead.maturity_assessments;
  const row: Record<string, unknown> = {
    lead_id: lead.id ?? "",
    organization_name: organization?.name ?? "",
    domain: organization?.normalized_domain ?? "",
    website: organization?.website_url ?? "",
    title: lead.title ?? "",
    stage: lead.stage ?? "",
    status: lead.status ?? "",
    routing: lead.routing ?? "",
    automation_maturity_score: lead.automation_maturity_score ?? null,
    opportunity_score: lead.opportunity_score ?? null,
    confidence: lead.confidence ?? null,
    coverage_categories: assessment?.coverage_categories ?? null,
    qualified: assessment?.qualified ?? null,
    last_refreshed_at: lead.last_refreshed_at ?? null,
    created_at: lead.created_at ?? null,
  };
  return Object.fromEntries(
    LEAD_EXPORT_COLUMNS.map((column) => [column, row[column]]),
  );
}

export function serializeLeadsExport(
  leads: any[],
  format: LeadExportFormat,
): string {
  const rows = leads.map(mapExportLeadRow);
  if (format === "json") return JSON.stringify(rows, null, 2);
  const lines = [LEAD_EXPORT_COLUMNS.map(csvEscape).join(",")];
  for (const row of rows)
    lines.push(
      LEAD_EXPORT_COLUMNS.map((column) => csvEscape(row[column])).join(","),
    );
  return lines.join("\r\n") + "\r\n";
}

/**
 * Writes an audit entry through the log_workspace_event RPC. Direct
 * audit_events inserts are revoked for authenticated users by design, and
 * export/apply are not table writes, so the DB trigger cannot capture them.
 * actor_id inside the RPC is the calling human — the humanValidatorId the
 * architectural policy requires for applied model suggestions.
 */
async function logWorkspaceEvent(
  client: DataClient,
  workspaceId: string,
  event: {
    action: string;
    resourceType: string;
    resourceId: string | null;
    reason: string;
    before?: unknown;
    after?: unknown;
  },
): Promise<void> {
  const { error } = await client.rpc("log_workspace_event", {
    p_workspace_id: workspaceId,
    p_action: event.action,
    p_resource_type: event.resourceType,
    p_resource_id: event.resourceId,
    p_reason: event.reason,
    p_before_state: event.before ?? null,
    p_after_state: event.after ?? null,
  });
  if (error) throw new Error(error.message);
}

async function operationalSnapshot(
  client: ReturnType<typeof createAdminClient>,
  workspaceId?: string,
) {
  const now = new Date();
  const start72h = new Date(
    Math.floor(now.getTime() / 3_600_000) * 3_600_000 - 72 * 3_600_000,
  ).toISOString();
  const workspaceFilter = workspaceId ?? null;
  // The canary is a system-level signal: its runs live in the dedicated
  // canary workspace (LEAD_ENGINE_CANARY_WORKSPACE_ID), not in the
  // caller's workspace. Filtering canary runs by the caller's workspace
  // made the Overview/Operations canary cards read 0% / "0h observed"
  // for the operator while /api/health reported the soak green.
  const canaryFilter =
    process.env.LEAD_ENGINE_CANARY_WORKSPACE_ID ?? workspaceFilter;
  const [jobsResult, canaryResult, workersResult, alertsResult] = await Promise.all([
    client`
      select status, scheduled_for, started_at, completed_at
      from public.scrape_jobs
      where scheduled_for >= ${start72h}
        and (${workspaceFilter}::uuid is null or workspace_id = ${workspaceFilter}::uuid)
    `,
    client`
      select scheduled_at, completed_at, status, failure_reason
      from public.canary_runs
      where scheduled_at >= ${start72h}
        and (${canaryFilter}::uuid is null or workspace_id = ${canaryFilter}::uuid)
      order by scheduled_at
    `,
    client`
      select id, status, runtime, capabilities, last_heartbeat_at, deployment_id
      from public.worker_nodes
      order by last_heartbeat_at desc
      limit 20
    `,
    client`
      select id, alert_type, severity, status, resource_type, resource_id,
        reason, payload, first_observed_at, last_observed_at,
        last_notified_at, resolved_at, occurrence_count
      from public.alert_log
      where (${workspaceFilter}::uuid is null or workspace_id = ${workspaceFilter}::uuid)
      order by case when status='open' then 0 else 1 end,
        last_observed_at desc
      limit 100
    `,
  ]);
  const jobs = jobsResult as unknown as Array<{
    status: string;
    scheduled_for: string;
    started_at: string | null;
    completed_at: string | null;
  }>;
  const startDelays = jobs
    .flatMap((job) =>
      job.started_at
        ? [
            new Date(job.started_at).getTime() -
              new Date(job.scheduled_for).getTime(),
          ]
        : ["queued", "leased", "retrying"].includes(job.status)
          ? [now.getTime() - new Date(job.scheduled_for).getTime()]
          : [],
    )
    .filter((delay) => delay >= 0);
  const canary = evaluateCanarySoak(
    (
      canaryResult as unknown as Array<{
        scheduled_at: string;
        completed_at: string | null;
        status: "completed" | "failed" | "running" | "queued";
      }>
    ).map((item) => ({
      scheduledAt: item.scheduled_at,
      completedAt: item.completed_at,
      status: item.status,
    })),
    now,
  );
  const workers = workersResult as unknown as Array<{
    id: string;
    status: string;
    runtime: string;
    capabilities: string[];
    last_heartbeat_at: string;
    deployment_id: string | null;
  }>;
  return {
    jobs: {
      total72h: jobs.length,
      byStatus: jobs.reduce<Record<string, number>>((totals, job) => {
        totals[job.status] = (totals[job.status] ?? 0) + 1;
        return totals;
      }, {}),
      scheduledStartP95Ms: percentile95(startDelays),
      scheduledStartTargetMet:
        startDelays.length > 0 &&
        (percentile95(startDelays) ?? Infinity) < 300_000,
    },
    canary,
    workers,
    alerts: alertsResult,
  };
}

async function authenticatedRoutes(
  request: Request,
  pathname: string,
): Promise<Response> {
  const context = await requireUserContext(request);
  const { client, workspaceId } = context;

  if (pathname === "/api/v1/bootstrap" && request.method === "GET") {
    const [sources, campaigns, jobs, leads, audit, memberships, recentLeads] =
      await Promise.all([
        client
          .from("source_definitions")
          .select("*,source_policy_versions!active_policy_id(*)")
          .eq("workspace_id", workspaceId)
          .order("created_at", { ascending: false }),
        client
          .from("scrape_campaigns")
          .select("*")
          .eq("workspace_id", workspaceId)
          .order("created_at", { ascending: false }),
        client
          .from("scrape_jobs")
          .select(
            "id,source_id,target_url,status,scheduled_for,started_at,completed_at,attempt_count,max_attempts,last_error,created_at,data_mode,discovery_candidate_id",
          )
          .eq("workspace_id", workspaceId)
          .order("created_at", { ascending: false })
          .limit(100),
        client
          .from("opportunities")
          .select(
            "*,organizations(name,normalized_domain),maturity_assessments!latest_assessment_id(explanation,components,scoring_version)",
          )
          .eq("workspace_id", workspaceId)
          .eq("status", "active")
          .order("opportunity_score", { ascending: false })
          .limit(100),
        client
          .from("audit_events")
          .select(
            "id,action,resource_type,resource_id,outcome,reason,actor_id,correlation_id,before_state,after_state,created_at",
          )
          .eq("workspace_id", workspaceId)
          .order("created_at", { ascending: false })
          .limit(100),
        client
          .from("workspace_memberships")
          .select("workspace_id,role,workspaces(name)")
          .eq("user_id", context.user.id)
          .eq("status", "active"),
        client.rpc("campaign_qualified_counts", {
          p_workspace_id: workspaceId,
        }),
      ]);
    for (const result of [
      sources,
      campaigns,
      jobs,
      leads,
      audit,
      memberships,
      recentLeads,
    ])
      if (result.error) throw new Error(result.error.message);
    const operations = await operationalSnapshot(
      createAdminClient(),
      workspaceId,
    );
    // Full-table job counts by mode + status. The jobs list above is a
    // 100-row window (newest first): deriving the Overview "Active
    // jobs / completed" card from it hides completions as soon as more
    // than 100 jobs exist — the first sprint batch's completed jobs
    // fell out of the window and the card froze at "100 / 0 completed"
    // while the funnel (a true count) showed scoring progressing.
    const jobCountRows = (await createAdminClient()`
      select data_mode, status, count(*)::int as count
      from public.scrape_jobs
      where workspace_id = ${workspaceId}
      group by data_mode, status
    `) as unknown as Array<{
      data_mode: string;
      status: string;
      count: number;
    }>;
    const jobCounts: Record<string, Record<string, number>> = {};
    for (const row of jobCountRows) {
      (jobCounts[row.data_mode] ??= {})[row.status] = row.count;
    }
    return json({
      actor: {
        id: context.user.id,
        email: context.user.email,
        role: context.role,
      },
      workspaceId,
      memberships: memberships.data,
      sources: sources.data,
      campaigns: (campaigns.data ?? []).map((campaign: any) => {
        const observed = Number(
          recentLeads.data?.find(
            (row: { campaign_id: string }) => row.campaign_id === campaign.id,
          )?.qualified_count ?? 0,
        );
        return {
          ...campaign,
          criteria_suggestion: isSuggestionSuppressed(campaign, observed)
            ? null
            : suggestCriteriaAdjustment(campaign.criteria, observed),
        };
      }),
      jobs: jobs.data,
      jobCounts,
      leads: leads.data,
      audit: audit.data,
      operations,
    });
  }

  if (pathname === "/api/v1/sources" && request.method === "GET") {
    const { data, error } = await client
      .from("source_definitions")
      .select("*,source_policy_versions!active_policy_id(*)")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return json({ data });
  }
  if (pathname === "/api/v1/audit" && request.method === "GET") {
    // Any active workspace member may read the audit trail; no elevated
    // role required. The bootstrap's embedded 100-event fetch is untouched.
    const params = new URL(request.url).searchParams;
    const days = Math.min(
      Math.max(Number.parseInt(params.get("days") ?? "7", 10) || 7, 1),
      30,
    );
    const limit = Math.min(
      Math.max(Number.parseInt(params.get("limit") ?? "500", 10) || 500, 1),
      2000,
    );
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const { data, error } = await client
      .from("audit_events")
      .select(
        "id,action,resource_type,resource_id,outcome,reason,actor_id,correlation_id,before_state,after_state,created_at",
      )
      .eq("workspace_id", workspaceId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return json({ data });
  }
  if (pathname === "/api/v1/sources/import" && request.method === "POST") {
    const body = SourceImportBodySchema.parse(await bodyJson(request));
    requireRole(
      context,
      body.approveAll
        ? ["owner", "administrator"]
        : ["owner", "administrator", "analyst"],
    );
    const { data: existingRows, error: existingError } = await client
      .from("source_definitions")
      .select("base_url")
      .eq("workspace_id", workspaceId);
    if (existingError) throw new Error(existingError.message);
    const existingUrls = new Set<string>();
    for (const row of (existingRows ?? []) as Array<{ base_url: string }>) {
      try {
        existingUrls.add(normalizeSourceUrl(row.base_url));
      } catch {
        // Legacy rows that no longer normalize cannot collide; ignore them.
      }
    }
    const indexed = body.rows.map((row, index) => ({ index, row }));
    const { unique, skipped } = dedupeRows(indexed, existingUrls);
    const created: Array<{ id: string; name: string }> = [];
    const errors: Array<{ index: number; name: string; error: string }> = [];
    let approved = 0;
    for (const { index, row } of unique) {
      const label = row.name?.trim() || `row ${index + 1}`;
      try {
        const input = SourceInputSchema.parse({
          ...mapRowToSourceInput(row, body.contactEmail),
          dataMode: body.dataMode,
        });
        const { data, error } = await client.rpc("create_source_with_policy", {
          p_workspace_id: workspaceId,
          p_input: input,
        });
        if (error) throw new Error(error.message);
        const sourceId = (data as { sourceId?: string } | null)?.sourceId;
        if (!sourceId) throw new Error("Source creation returned no id");
        if (body.approveAll) {
          const { error: approveError } = await client.rpc(
            "approve_source_policy",
            {
              p_workspace_id: workspaceId,
              p_source_id: sourceId,
              p_reason: "Bulk-approved on CSV import.",
            },
          );
          if (approveError) throw new Error(approveError.message);
          approved += 1;
        }
        created.push({ id: sourceId, name: input.name });
      } catch (error) {
        errors.push({
          index,
          name: label,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return json({ data: { created, skipped, errors, approved } }, 201);
  }
  if (pathname === "/api/v1/sources" && request.method === "POST") {
    requireRole(context, ["owner", "administrator", "analyst"]);
    const input = SourceInputSchema.parse(await bodyJson(request));
    const { data, error } = await client.rpc("create_source_with_policy", {
      p_workspace_id: workspaceId,
      p_input: input,
    });
    if (error) throw new Error(error.message);
    return json({ data }, 201);
  }
  const sourceApproval = pathname.match(
    /^\/api\/v1\/sources\/([0-9a-f-]+)\/approve$/i,
  );
  if (sourceApproval && request.method === "POST") {
    requireRole(context, ["owner", "administrator"]);
    const reason = z
      .object({ reason: z.string().min(5).max(500) })
      .parse(await bodyJson(request)).reason;
    const { data, error } = await client.rpc("approve_source_policy", {
      p_workspace_id: workspaceId,
      p_source_id: sourceApproval[1],
      p_reason: reason,
    });
    if (error) throw new Error(error.message);
    return json({ data });
  }
  // Retire/restore a source (History). Retirement is not deletion:
  // the row, its policy history, jobs, and assessments survive; the
  // status change alone stops collection everywhere, because every
  // collection path keys off status = 'active'. The transition runs
  // through the set_source_retired RPC (migration 202610120007) on
  // the admin connection: authenticated has no UPDATE grant on
  // source_definitions at all, and the RPC makes the in-flight
  // guard atomic with the write. EXECUTE is revoked from the API
  // roles, so the owner/administrator check is the only way in.
  const opportunityUseCases = pathname.match(
    /^\/api\/v1\/opportunities\/([0-9a-f-]+)\/use-cases$/i,
  );
  const opportunityUseCasesApprove = pathname.match(
    /^\/api\/v1\/opportunities\/([0-9a-f-]+)\/use-cases\/approve$/i,
  );
  const opportunityProposal = pathname.match(
    /^\/api\/v1\/opportunities\/([0-9a-f-]+)\/proposal$/i,
  );
  const opportunityProposalDraft = pathname.match(
    /^\/api\/v1\/opportunities\/([0-9a-f-]+)\/proposal\/draft$/i,
  );
  const opportunityProposalApprove = pathname.match(
    /^\/api\/v1\/opportunities\/([0-9a-f-]+)\/proposal\/approve$/i,
  );
  const opportunityProposalSent = pathname.match(
    /^\/api\/v1\/opportunities\/([0-9a-f-]+)\/proposal\/sent$/i,
  );
  const sourceRetire = pathname.match(
    /^\/api\/v1\/sources\/([0-9a-f-]+)\/(retire|restore)$/i,
  );
  if (sourceRetire && request.method === "POST") {
    requireRole(context, ["owner", "administrator"]);
    const sourceId = sourceRetire[1];
    const action = sourceRetire[2].toLowerCase();
    const admin = createAdminClient();
    const rpcRows = (await admin`
      select public.set_source_retired(
        ${workspaceId}::uuid, ${sourceId}::uuid, ${action === "retire" ? "true" : "false"}::boolean
      ) as result
    `) as unknown as Array<{ result: RetireOutcome }>;
    const outcome = rpcRows[0]?.result;
    if (!outcome) throw new Error("Retire transition returned no result");
    const decision = retireDecision(outcome, "Source");
    if (decision.kind === "error")
      throw Object.assign(new Error(decision.message), {
        statusCode: decision.statusCode,
      });
    const { data: updated, error: readError } = await client
      .from("source_definitions")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("id", sourceId)
      .single();
    if (readError || !updated)
      throw new Error(readError?.message ?? "Source not found");
    if (decision.kind === "retired") {
      await logWorkspaceEvent(client, workspaceId, {
        action: "source.retired",
        resourceType: "source_definitions",
        resourceId: sourceId,
        reason: `Source "${outcome.name}" retired to History by ${context.user.email ?? context.user.id}. Collection stops; records and audit history are preserved.`,
        before: { status: decision.fromStatus },
        after: { status: "retired" },
      });
    } else {
      await logWorkspaceEvent(client, workspaceId, {
        action: "source.restored",
        resourceType: "source_definitions",
        resourceId: sourceId,
        reason: `Source "${outcome.name}" restored from History to status "${decision.toStatus}" by ${context.user.email ?? context.user.id}.`,
        before: { status: "retired" },
        after: { status: decision.toStatus },
      });
    }
    return json({ data: updated });
  }
  const sourceUpdate = pathname.match(/^\/api\/v1\/sources\/([0-9a-f-]+)$/i);
  if (sourceUpdate && request.method === "PATCH") {
    requireRole(context, ["owner", "administrator"]);
    const input = z
      .object({
        name: z.string().min(1).max(200).optional(),
        baseUrl: z.string().url().max(2000).optional(),
        collectionMethod: z
          .enum(["static_html", "rss", "sitemap", "api"])
          .optional(),
        businessPurpose: z.string().min(10).max(2000).optional(),
      })
      .parse(await bodyJson(request));
    if (
      input.name === undefined &&
      input.baseUrl === undefined &&
      input.collectionMethod === undefined &&
      input.businessPurpose === undefined
    )
      throw Object.assign(new Error("No fields to update"), {
        statusCode: 400,
      });
    // The admin client is the Neon HTTP driver: it is a template-tag
    // function, NOT a (query, params) callable — calling it as one
    // throws and surfaces as a 500 (this is how source rename broke).
    // Use the tag form with coalesce so absent fields keep their
    // current values.
    const admin = createAdminClient();
    const rows = (await admin`
      update public.source_definitions
      set name = coalesce(${input.name ?? null}, name),
          base_url = coalesce(${input.baseUrl ?? null}, base_url),
          collection_method = coalesce(${input.collectionMethod ?? null}, collection_method),
          business_purpose = coalesce(${input.businessPurpose ?? null}, business_purpose),
          updated_at = now()
      where workspace_id = ${workspaceId} and id = ${sourceUpdate[1]}
      returning id, name, base_url, collection_method, business_purpose, status
    `) as unknown as Array<Record<string, unknown>>;
    if (!rows.length)
      throw Object.assign(new Error("Source not found"), { statusCode: 404 });
    return json({ data: rows[0] });
  }

  if (pathname === "/api/v1/criteria" && request.method === "GET") {
    const { data, error } = await client
      .from("scrape_campaigns")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("created_at");
    if (error) throw new Error(error.message);
    return json({ data });
  }
  const campaignCriteria = pathname.match(
    /^\/api\/v1\/criteria\/([0-9a-f-]+)$/i,
  );
  if (campaignCriteria && request.method === "PATCH") {
    requireRole(context, ["owner", "administrator", "analyst"]);
    const input = z
      .object({
        criteria: CriteriaSchema,
        scheduleEnabled: z.boolean().optional(),
        intervalMinutes: z.number().int().min(5).max(43_200).optional(),
        nextRunAt: z.string().datetime().nullable().optional(),
      })
      .parse(await bodyJson(request));
    const scheduleEnabled = input.scheduleEnabled;
    const { data: patchTarget, error: patchTargetError } = await client
      .from("scrape_campaigns")
      .select("id,status")
      .eq("workspace_id", workspaceId)
      .eq("id", campaignCriteria[1])
      .single();
    if (patchTargetError || !patchTarget)
      throw Object.assign(new Error("Campaign not found"), { statusCode: 404 });
    if (isRetired(patchTarget.status as string))
      throw Object.assign(new Error("Campaign is retired"), { statusCode: 409 });
    // Capture the current observed count so the suggestion stays suppressed
    // until fresh scrape output changes it.
    const { data: counts } = await client.rpc("campaign_qualified_counts", {
      p_workspace_id: workspaceId,
    });
    const observed = Number(
      (
        counts as Array<{ campaign_id: string; qualified_count: number }> | null
      )?.find((row) => row.campaign_id === campaignCriteria[1])
        ?.qualified_count ?? 0,
    );
    const updates: Record<string, unknown> = {
      criteria: input.criteria,
      criteria_version: new Date().toISOString(),
      updated_by: context.user.id,
      // Manual save also suppresses the current suggestion cycle; a new
      // suggestion appears only when fresh scrape output arrives.
      last_suggestion_at: new Date().toISOString(),
      last_suggestion_observed_count: observed,
      last_suggestion_direction: "manual",
    };
    if (scheduleEnabled !== undefined)
      updates.schedule_enabled = scheduleEnabled;
    if (input.intervalMinutes !== undefined)
      updates.interval_minutes = input.intervalMinutes;
    if (input.nextRunAt !== undefined) updates.next_run_at = input.nextRunAt;
    else if (scheduleEnabled) updates.next_run_at = new Date().toISOString();
    const { data, error } = await client
      .from("scrape_campaigns")
      .update(updates)
      .eq("workspace_id", workspaceId)
      .eq("id", campaignCriteria[1])
      .select()
      .single();
    if (error) throw new Error(error.message);
    return json({ data });
  }

  const campaignSuggestion = pathname.match(
    /^\/api\/v1\/criteria\/([0-9a-f-]+)\/suggestion$/i,
  );
  if (campaignSuggestion && request.method === "GET") {
    const [campaign, recentLeads] = await Promise.all([
      client
        .from("scrape_campaigns")
        .select("criteria")
        .eq("workspace_id", workspaceId)
        .eq("id", campaignSuggestion[1])
        .single(),
      client.rpc("campaign_qualified_counts", { p_workspace_id: workspaceId }),
    ]);
    if (campaign.error)
      throw Object.assign(new Error("Campaign not found"), { statusCode: 404 });
    if (recentLeads.error) throw new Error(recentLeads.error.message);
    const count = Number(
      recentLeads.data?.find(
        (row: { campaign_id: string }) =>
          row.campaign_id === campaignSuggestion[1],
      )?.qualified_count ?? 0,
    );
    return json({
      data: suggestCriteriaAdjustment(campaign.data.criteria, count),
    });
  }

  // Retire/restore a campaign (History). Same contract as sources:
  // records survive, automation stops (auto-apply and the due-job
  // scheduler both skip retired campaigns, and discovery gates on
  // campaign status), restore returns the exact prior status. The
  // transition runs through the set_campaign_retired RPC on the
  // admin connection — authenticated holds only column-scoped
  // UPDATE grants on scrape_campaigns, which do not cover the
  // lifecycle columns.
  const criteriaRetire = pathname.match(
    /^\/api\/v1\/criteria\/([0-9a-f-]+)\/(retire|restore)$/i,
  );
  if (criteriaRetire && request.method === "POST") {
    requireRole(context, ["owner", "administrator"]);
    const campaignId = criteriaRetire[1];
    const action = criteriaRetire[2].toLowerCase();
    const admin = createAdminClient();
    const rpcRows = (await admin`
      select public.set_campaign_retired(
        ${workspaceId}::uuid, ${campaignId}::uuid, ${action === "retire" ? "true" : "false"}::boolean
      ) as result
    `) as unknown as Array<{ result: RetireOutcome }>;
    const outcome = rpcRows[0]?.result;
    if (!outcome) throw new Error("Retire transition returned no result");
    const decision = retireDecision(outcome, "Campaign");
    if (decision.kind === "error")
      throw Object.assign(new Error(decision.message), {
        statusCode: decision.statusCode,
      });
    const { data: updated, error: readError } = await client
      .from("scrape_campaigns")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("id", campaignId)
      .single();
    if (readError || !updated)
      throw new Error(readError?.message ?? "Campaign not found");
    if (decision.kind === "retired") {
      await logWorkspaceEvent(client, workspaceId, {
        action: "criteria.retired",
        resourceType: "scrape_campaigns",
        resourceId: campaignId,
        reason: `Campaign "${outcome.name}" retired to History by ${context.user.email ?? context.user.id}. Criteria automation stops; records are preserved.`,
        before: { status: decision.fromStatus },
        after: { status: "retired" },
      });
    } else {
      await logWorkspaceEvent(client, workspaceId, {
        action: "criteria.restored",
        resourceType: "scrape_campaigns",
        resourceId: campaignId,
        reason: `Campaign "${outcome.name}" restored from History to status "${decision.toStatus}" by ${context.user.email ?? context.user.id}.`,
        before: { status: "retired" },
        after: { status: decision.toStatus },
      });
    }
    return json({ data: updated });
  }
  // Audited rescore: recompute the campaign's assessments from
  // STORED evidence and signal observations under current criteria —
  // never a re-scrape. dryRun returns projected qualifiers + the top
  // 20 for human review and writes nothing; the real pass writes NEW
  // immutable assessments through rescore_scrape_result (migration
  // 202610120006) and is fingerprint-idempotent. Both are audited as
  // the acting human.
  const rescoreRoute = pathname.match(
    /^\/api\/v1\/criteria\/([0-9a-f-]+)\/rescore$/i,
  );
  if (rescoreRoute && request.method === "POST") {
    requireRole(context, ["owner", "administrator", "analyst"]);
    const campaignId = rescoreRoute[1];
    const input = z
      .object({
        dryRun: z.boolean().default(false),
        thresholdOverride: z.number().int().min(0).max(100).optional(),
        strengthOverride: z.number().int().min(0).max(40).optional(),
        limit: z.number().int().min(1).max(50).default(25),
      })
      .parse(await bodyJson(request).catch(() => ({})));
    const { data: campaign, error: campaignError } = await client
      .from("scrape_campaigns")
      .select("id,source_id,criteria")
      .eq("workspace_id", workspaceId)
      .eq("id", campaignId)
      .single();
    if (campaignError || !campaign)
      throw Object.assign(new Error("Campaign not found"), { statusCode: 404 });
    const overrides = {
      thresholdOverride: input.thresholdOverride,
      strengthOverride: input.strengthOverride,
    };
    const admin = createAdminClient();
    if (input.dryRun) {
      const result = await dryRunRescore(admin, {
        workspaceId,
        campaignId,
        sourceId: campaign.source_id as string,
        criteriaInput: campaign.criteria,
        overrides,
      });
      await logWorkspaceEvent(client, workspaceId, {
        action: "assessments.rescore_dry_run",
        resourceType: "scrape_campaigns",
        resourceId: campaignId,
        reason:
          `Rescore dry-run at threshold ${result.threshold} / market strength ${result.marketStrength} by ${context.user.email ?? context.user.id}: ` +
          `${result.projectedQualified} of ${result.total} projected qualified (${result.newlyQualified} newly). No records written.`,
        after: {
          total: result.total,
          projectedQualified: result.projectedQualified,
          newlyQualified: result.newlyQualified,
        },
      });
      return json({ data: result });
    }
    const result = await rescoreCampaignBatch(admin, {
      workspaceId,
      campaignId,
      sourceId: campaign.source_id as string,
      criteriaInput: campaign.criteria,
      overrides,
      limit: input.limit,
    });
    await logWorkspaceEvent(client, workspaceId, {
      action: "assessments.rescored",
      resourceType: "scrape_campaigns",
      resourceId: campaignId,
      reason:
        `Rescored ${result.rescanned} assessments (${result.alreadyCurrent} already current) by ${context.user.email ?? context.user.id}: ` +
        `${result.newlyQualified} newly qualified, ${result.unqualified} unqualified.`,
      after: result,
    });
    return json({ data: result });
  }
  // --- Lead-vision gap 3: one-click suggestion apply + auto-apply opt-in. ---
  // These routes reuse the existing criteria storage model (criteria jsonb on
  // scrape_campaigns) and the same CriteriaSchema validation the PATCH route
  // applies; they are additive and do not change any existing route.
  const applySuggestion = pathname.match(
    /^\/api\/v1\/criteria\/([0-9a-f-]+)\/apply-suggestion$/i,
  );
  if (applySuggestion && request.method === "POST") {
    requireRole(context, ["owner", "administrator", "analyst"]);
    const campaignId = applySuggestion[1];
    const { data: campaign, error: campaignError } = await client
      .from("scrape_campaigns")
      .select("id,criteria,status")
      .eq("workspace_id", workspaceId)
      .eq("id", campaignId)
      .single();
    if (campaignError || !campaign)
      throw Object.assign(new Error("Campaign not found"), { statusCode: 404 });
    if (isRetired((campaign as { status?: string }).status))
      throw Object.assign(new Error("Campaign is retired"), { statusCode: 409 });
    const { data: counts, error: countsError } = await client.rpc(
      "campaign_qualified_counts",
      { p_workspace_id: workspaceId },
    );
    if (countsError) throw new Error(countsError.message);
    const observed = Number(
      (
        counts as Array<{ campaign_id: string; qualified_count: number }> | null
      )?.find((row) => row.campaign_id === campaignId)?.qualified_count ?? 0,
    );
    const suggestion = suggestCriteriaAdjustment(campaign.criteria, observed);
    if (
      suggestion.direction === "hold" ||
      Object.keys(suggestion.changes).length === 0
    ) {
      return json({
        applied: false,
        direction: suggestion.direction,
        reason: "Suggestion is hold or has no changes; nothing was applied.",
      });
    }
    // Merge through the same validation the PATCH route uses (full
    // CriteriaSchema), then persist like the PATCH route does.
    const merged = mergeSuggestionChanges(
      campaign.criteria,
      suggestion.changes,
    );
    const { data: updated, error: updateError } = await client
      .from("scrape_campaigns")
      .update({
        criteria: merged,
        criteria_version: new Date().toISOString(),
        updated_by: context.user.id,
        // Suppress further suggestions until the observed qualified count
        // changes (new scrape data), so the Criteria page doesn't immediately
        // re-suggest against the same output.
        last_suggestion_at: new Date().toISOString(),
        last_suggestion_observed_count: observed,
        last_suggestion_direction: suggestion.direction,
      })
      .eq("workspace_id", workspaceId)
      .eq("id", campaignId)
      .select()
      .single();
    if (updateError) throw new Error(updateError.message);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of Object.keys(suggestion.changes)) {
      before[key] = (campaign.criteria as Record<string, unknown>)[key];
      after[key] = (merged as unknown as Record<string, unknown>)[key];
    }
    await logWorkspaceEvent(client, workspaceId, {
      action: "criteria.suggestion_applied",
      resourceType: "scrape_campaigns",
      resourceId: campaignId,
      reason:
        `Applied ${suggestion.direction} suggestion ` +
        `(${observed}/${suggestion.targetQualifiedLeads} qualified this week). ` +
        suggestion.rationale.join(" "),
      before,
      after,
    });
    return json({
      data: {
        applied: true,
        direction: suggestion.direction,
        appliedChanges: suggestion.changes,
        rationale: suggestion.rationale,
        criteria: updated.criteria,
      },
    });
  }
  const autoApplyToggle = pathname.match(
    /^\/api\/v1\/criteria\/([0-9a-f-]+)\/auto-apply$/i,
  );
  if (autoApplyToggle && request.method === "PATCH") {
    requireRole(context, ["owner", "administrator", "analyst"]);
    const campaignId = autoApplyToggle[1];
    const input = z
      .object({ autoApply: z.boolean() })
      .parse(await bodyJson(request));
    const { data: existing, error: existingError } = await client
      .from("scrape_campaigns")
      .select("id,auto_apply_criteria,status")
      .eq("workspace_id", workspaceId)
      .eq("id", campaignId)
      .single();
    if (existingError || !existing)
      throw Object.assign(new Error("Campaign not found"), { statusCode: 404 });
    if (isRetired((existing as { status?: string }).status))
      throw Object.assign(new Error("Campaign is retired"), { statusCode: 409 });
    const { data: updated, error: updateError } = await client
      .from("scrape_campaigns")
      .update({ auto_apply_criteria: input.autoApply })
      .eq("workspace_id", workspaceId)
      .eq("id", campaignId)
      .select()
      .single();
    if (updateError) throw new Error(updateError.message);
    await logWorkspaceEvent(client, workspaceId, {
      action: "criteria.auto_apply_changed",
      resourceType: "scrape_campaigns",
      resourceId: campaignId,
      reason: `Auto-apply ${input.autoApply ? "enabled" : "disabled"} by ${
        context.user.email ?? context.user.id
      }.`,
      before: { auto_apply_criteria: existing.auto_apply_criteria },
      after: { auto_apply_criteria: input.autoApply },
    });
    return json({ data: updated });
  }

  if (pathname === "/api/v1/scrape-jobs" && request.method === "GET") {
    const { data, error } = await client
      .from("scrape_jobs")
      .select("*,scrape_job_attempts(*)")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return json({ data });
  }
  if (pathname === "/api/v1/scrape-jobs" && request.method === "POST") {
    requireRole(context, ["owner", "administrator", "analyst"]);
    const input = ManualJobSchema.parse(await bodyJson(request));
    const idempotency = `${workspaceId}:${request.headers.get("idempotency-key") ?? randomUUID()}`;
    const { data: source, error: sourceError } = await client
      .from("source_definitions")
      .select("id,status,base_url")
      .eq("workspace_id", workspaceId)
      .eq("id", input.sourceId)
      .single();
    if (sourceError || !source)
      throw Object.assign(new Error("Source not found"), { statusCode: 404 });
    if (source.status !== "active")
      throw Object.assign(new Error("Source must be approved and active"), {
        statusCode: 409,
      });
    const { data, error } = await client.rpc("queue_scrape_job", {
      p_workspace_id: workspaceId,
      p_source_id: input.sourceId,
      p_target_url: input.targetUrl ?? source.base_url,
      p_key: idempotency,
      p_max_attempts: input.maxAttempts,
    });
    if (error) throw new Error(error.message);
    return json({ data }, 202);
  }

  const jobMatch = pathname.match(/^\/api\/v1\/scrape-jobs\/([0-9a-f-]+)$/i);
  if (jobMatch && request.method === "GET") {
    const { data, error } = await client
      .from("scrape_jobs")
      .select(
        "*,scrape_job_attempts(*),evidence_artifacts(id,canonical_url,content_hash,fetched_at),maturity_assessments(*)",
      )
      .eq("workspace_id", workspaceId)
      .eq("id", jobMatch[1])
      .single();
    if (error)
      throw Object.assign(new Error(error.message), { statusCode: 404 });
    return json({ data });
  }
  const jobEvents = pathname.match(
    /^\/api\/v1\/scrape-jobs\/([0-9a-f-]+)\/events$/i,
  );
  if (jobEvents && request.method === "GET") {
    const [job, attempts, audit] = await Promise.all([
      client
        .from("scrape_jobs")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("id", jobEvents[1])
        .single(),
      client
        .from("scrape_job_attempts")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("scrape_job_id", jobEvents[1])
        .order("started_at"),
      client
        .from("audit_events")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("resource_id", jobEvents[1])
        .order("created_at"),
    ]);
    if (job.error)
      throw Object.assign(new Error("Job not found"), { statusCode: 404 });
    const events = [
      ...(attempts.data ?? []).map((item: any) => ({
        type: "attempt",
        at: item.started_at,
        data: item,
      })),
      ...(audit.data ?? []).map((item: any) => ({
        type: "audit",
        at: item.created_at,
        data: item,
      })),
      { type: "job", at: job.data.updated_at, data: job.data },
    ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    const payload = events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join("");
    return new Response(payload, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "close",
      },
    });
  }
  const jobAction = pathname.match(
    /^\/api\/v1\/scrape-jobs\/([0-9a-f-]+)\/(retry|cancel)$/i,
  );
  if (jobAction && request.method === "POST") {
    requireRole(context, ["owner", "administrator", "analyst"]);
    const { data, error } = await client.rpc(
      jobAction[2] === "retry" ? "retry_scrape_job" : "cancel_scrape_job",
      {
        p_workspace_id: workspaceId,
        p_job_id: jobAction[1],
        p_reason: z
          .object({ reason: z.string().min(3).max(500) })
          .parse(await bodyJson(request)).reason,
      },
    );
    if (error) throw new Error(error.message);
    return json({ data });
  }

  if (pathname === "/api/v1/leads" && request.method === "GET") {
    const { data, error } = await client
      .from("opportunities")
      .select("*,organizations(*),maturity_assessments!latest_assessment_id(*)")
      .eq("workspace_id", workspaceId)
      .eq("status", "active")
      .order("opportunity_score", { ascending: false });
    if (error) throw new Error(error.message);
    return json({ data });
  }
  // --- Lead pipeline board: the per-lead proposal + latest-outcome
  // state the board derives stages from (src/pipeline-stage.ts).
  // Read-only over the server connection; scoping is the
  // opportunity's workspace (proposals and feedback hang off the
  // opportunity, and their inserts enforce the same workspace), so
  // no cross-tenant state can leak into the board.
  if (pathname === "/api/v1/leads/pipeline" && request.method === "GET") {
    const adminSql = createAdminClient();
    const stateRows = await adminSql`
      select o.id as opportunity_id,
        (select p.status from public.lead_proposals p
          where p.opportunity_id = o.id
          order by p.created_at desc limit 1) as proposal_status,
        (select f.decision from public.lead_feedback f
          where f.opportunity_id = o.id
          order by f.created_at desc limit 1) as latest_decision
      from public.opportunities o
      where o.workspace_id = ${workspaceId}::uuid and o.status = 'active'`;
    return json({
      data: (stateRows as Array<Record<string, unknown>>).map((row) => ({
        opportunityId: String(row.opportunity_id),
        proposalStatus: row.proposal_status
          ? String(row.proposal_status)
          : null,
        latestDecision: row.latest_decision
          ? String(row.latest_decision)
          : null,
      })),
    });
  }
  // --- Lead-vision gap 2: lead export. Reuses the list endpoint's
  // filters/joins (same query shape pre-serialization), capped at
  // EXPORT_MAX_LEADS, and writes an audit entry via log_workspace_event.
  if (pathname === "/api/v1/leads/export" && request.method === "GET") {
    const format = parseExportFormat(
      new URL(request.url).searchParams.get("format"),
    );
    const { data, error } = await client
      .from("opportunities")
      .select("*,organizations(*),maturity_assessments!latest_assessment_id(*)")
      .eq("workspace_id", workspaceId)
      .eq("status", "active")
      .order("opportunity_score", { ascending: false })
      .limit(EXPORT_MAX_LEADS);
    if (error) throw new Error(error.message);
    const leads = (data ?? []) as any[];
    await logWorkspaceEvent(client, workspaceId, {
      action: "leads.export",
      resourceType: "opportunities",
      resourceId: null,
      reason: `Exported ${leads.length} leads as ${format} (limit ${EXPORT_MAX_LEADS}).`,
    });
    const body = serializeLeadsExport(leads, format);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type":
          format === "csv"
            ? "text/csv; charset=utf-8"
            : "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${exportFilename(format)}"`,
        "cache-control": "no-store",
      },
    });
  }
  const leadFeedback = pathname.match(
    /^\/api\/v1\/leads\/([0-9a-f-]+)\/feedback$/i,
  );
  if (leadFeedback && request.method === "POST") {
    requireRole(context, ["owner", "administrator", "analyst", "reviewer"]);
    const input = z
      .object({
        decision: z.enum([
          "accepted",
          "rejected",
          "duplicate",
          "contacted",
          "meeting",
          "won",
          "lost",
        ]),
        reasonCode: z.string().min(2).max(100),
        notes: z.string().max(2_000).optional(),
      })
      .parse(await bodyJson(request));
    // Server-side insert (same boundary as the other approval-
    // bearing writes): the Data API path depends on the INSERT
    // policy's reviewer_id = auth.user_id() comparison, which
    // failed in production with a masked 500. The reviewer is
    // taken from the verified session here. Failures surface
    // their real message to the operator instead of a masked 500.
    const admin = createAdminClient();
    // The admin connection bypasses RLS, so the workspace scope
    // the old Data API policy enforced (an opportunity may only
    // receive feedback inside its own workspace) is restored
    // explicitly (Codex on PR #50): a foreign opportunity id is
    // a 404, never a cross-tenant insert or an existence oracle.
    const opportunityRows = (await admin`
      select id, data_mode from public.opportunities
      where id = ${leadFeedback[1]}::uuid
        and workspace_id = ${workspaceId}::uuid
    `) as unknown as Array<{ id: string; data_mode: string }>;
    if (opportunityRows.length === 0)
      throw Object.assign(new Error("Opportunity not found"), {
        statusCode: 404,
      });
    try {
      const rows = (await admin`
        insert into public.lead_feedback (
          workspace_id, opportunity_id, reviewer_id, decision,
          reason_code, notes, data_mode)
        values (${workspaceId}::uuid, ${leadFeedback[1]}::uuid,
          ${context.user.id}, ${input.decision}, ${input.reasonCode},
          ${input.notes ?? null}, ${opportunityRows[0].data_mode})
        returning *
      `) as unknown as Array<Record<string, unknown>>;
      return json({ data: rows[0] }, 201);
    } catch (error) {
      throw Object.assign(
        new Error(
          `Could not record the review decision: ${error instanceof Error ? error.message : String(error)}`,
        ),
        { statusCode: 422 },
      );
    }
  }

  // Reviewer-validated use cases (migration 202610120009): the
  // engine identifies the lead's automation use cases from its
  // stored evidence; the reviewer selects and approves; approved
  // rows ship in the handoff baseline as Must requirements.
  if (opportunityUseCases && request.method === "GET") {
    requireRole(context, ["owner", "administrator", "analyst", "reviewer"]);
    const opportunityId = opportunityUseCases[1];
    const { data: opportunity, error: opportunityError } = await client
      .from("opportunities")
      .select("id, primary_evidence_id")
      .eq("workspace_id", workspaceId)
      .eq("id", opportunityId)
      .single();
    if (opportunityError || !opportunity)
      throw Object.assign(new Error("Opportunity not found"), {
        statusCode: 404,
      });
    let { data: existing } = await client
      .from("opportunity_use_cases")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("opportunity_id", opportunityId)
      .order("created_at", { ascending: true });
    if (!existing || existing.length === 0) {
      const admin = createAdminClient();
      let signals: SignalLike[] = [];
      let evidenceText = "";
      let orgName = "this business";
      let orgDomain: string | null = null;
      let assessmentSummary: string | null = null;
      const orgRows = (await admin`
        select o.title, org.name as org_name, org.normalized_domain as org_domain,
               o.latest_assessment_id
        from public.opportunities o
        join public.organizations org on org.id = o.organization_id
        where o.id = ${opportunityId}::uuid
          and o.workspace_id = ${workspaceId}::uuid
      `) as unknown as Array<{
        title: string;
        org_name: string;
        org_domain: string | null;
        latest_assessment_id: string | null;
      }>;
      if (orgRows[0]) {
        orgName = orgRows[0].org_name || orgRows[0].title;
        orgDomain = orgRows[0].org_domain;
      }
      if (opportunity.primary_evidence_id) {
        signals = (await admin`
          select code, category, polarity, strength, excerpt
          from public.signal_observations
          where workspace_id = ${workspaceId}::uuid
            and evidence_artifact_id = ${opportunity.primary_evidence_id}::uuid
          order by strength desc
          limit 12
        `) as unknown as SignalLike[];
        const evidenceRows = (await admin`
          select raw_content from public.evidence_artifacts
          where id = ${opportunity.primary_evidence_id}::uuid
            and workspace_id = ${workspaceId}::uuid
        `) as unknown as Array<{ raw_content: string | null }>;
        if (evidenceRows[0]?.raw_content)
          evidenceText = cleanEvidenceText(evidenceRows[0].raw_content);
      }
      if (orgRows[0]?.latest_assessment_id) {
        const assessmentRows = (await admin`
          select explanation from public.maturity_assessments
          where id = ${orgRows[0].latest_assessment_id}::uuid
        `) as unknown as Array<{ explanation: unknown }>;
        const explanation = assessmentRows[0]?.explanation;
        if (typeof explanation === "string")
          assessmentSummary = explanation.slice(0, 600);
        else if (explanation && typeof explanation === "object") {
          const summary = (explanation as Record<string, unknown>).summary;
          if (typeof summary === "string")
            assessmentSummary = summary.slice(0, 600);
        }
      }
      // The LLM drafter reads the FULL evidence (operator decision
      // 2026-10-14); every candidate it returns is citation-
      // verified against that text inside draftUseCasesWithLlm.
      // Any failure falls back to the rules catalog via the merge.
      const drafted = evidenceText
        ? await draftUseCasesWithLlm({
            orgName,
            orgDomain,
            evidenceText,
            signals,
            assessmentSummary,
          })
        : null;
      const candidates = mergeUseCaseCandidates(
        drafted,
        generateUseCases(signals),
      );
      // Writes to the approval-bearing tables go through the
      // server connection, never the member Data API: migration
      // 202610120010 grants authenticated SELECT only, so an
      // approved row (and its validator stamp) can only ever be
      // produced by these routes, from the authenticated session
      // (Codex P1 on PR #49).
      for (const candidate of candidates) {
        await admin`
          insert into public.opportunity_use_cases (
            workspace_id, opportunity_id, use_case_key, code, title,
            statement, rationale, acceptance_criteria,
            generation_source, success_metric, success_target, status)
          values (${workspaceId}::uuid, ${opportunityId}::uuid,
            ${candidate.key}, ${candidate.code}, ${candidate.title},
            ${candidate.statement}, ${candidate.rationale},
            ${JSON.stringify(candidate.acceptanceCriteria)}::jsonb,
            ${candidate.source}, ${candidate.successMetric},
            ${candidate.successTarget}, 'suggested')
          on conflict (opportunity_id, use_case_key) do nothing
        `;
      }
      const refreshed = await client
        .from("opportunity_use_cases")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("opportunity_id", opportunityId)
        .order("created_at", { ascending: true });
      existing = refreshed.data ?? [];
    }
    return json({ data: existing ?? [] });
  }

  if (opportunityUseCasesApprove && request.method === "POST") {
    requireRole(context, ["owner", "administrator", "analyst", "reviewer"]);
    const opportunityId = opportunityUseCasesApprove[1];
    const input = z
      .object({
        useCaseIds: z.array(z.string().uuid()).min(1).max(20),
        // Reviewer-edited success measures (the OKRs), keyed by
        // use-case id; approved together with the use case.
        measures: z
          .record(
            z.string().uuid(),
            z.object({
              metric: z.string().min(3).max(120),
              target: z.string().min(5).max(200),
            }),
          )
          .optional(),
      })
      .parse(await bodyJson(request));
    const validator = context.user.email ?? context.user.id;
    // ONE atomic statement replaces the whole approved set
    // (Codex P2 on PR #49: the previous read-modify-write across
    // separate calls could interleave two reviewers into an empty
    // set), executed on the server connection (Codex P1: the
    // validator stamp is only ever written here, from the
    // session). Reviewer-edited success measures ride the same
    // statement via the jsonb overrides map.
    const admin = createAdminClient();
    // Pre-validate BEFORE any write (Codex P2): a submission of
    // only stale/foreign ids must 404 WITHOUT clearing the
    // existing approved set, and every selected row must end up
    // with a success measure (its stored one or the reviewer's
    // override) — an approved case without an OKR would silently
    // ship no promise.
    const selectedRows = (await admin`
      select id, title, success_metric, success_target
      from public.opportunity_use_cases
      where workspace_id = ${workspaceId}::uuid
        and opportunity_id = ${opportunityId}::uuid
        and id::text = any(${input.useCaseIds}::text[])
        and status in ('suggested', 'approved')
    `) as unknown as Array<{
      id: string;
      title: string;
      success_metric: string | null;
      success_target: string | null;
    }>;
    if (selectedRows.length === 0)
      throw Object.assign(new Error("No matching use cases for this lead"), {
        statusCode: 404,
      });
    const missingMeasures = selectedRows.filter((row) => {
      const override = input.measures?.[row.id];
      return (
        !(override?.metric ?? row.success_metric) ||
        !(override?.target ?? row.success_target)
      );
    });
    if (missingMeasures.length > 0)
      throw Object.assign(
        new Error(
          `These use cases have no success measure yet — add a metric and target in the panel before approving: ${missingMeasures.map((row) => row.title).join(", ")}`,
        ),
        { statusCode: 422 },
      );
    const measuresJson = JSON.stringify(input.measures ?? {});
    const counts = (await admin`
      with updated as (
        update public.opportunity_use_cases uc
        set status = case when uc.id::text = any(${input.useCaseIds}::text[])
                          then 'approved' else 'suggested' end,
            human_validator_id = case when uc.id::text = any(${input.useCaseIds}::text[])
                          then ${validator} else null end,
            approved_at = case when uc.id::text = any(${input.useCaseIds}::text[])
                          then now() else null end,
            success_metric = coalesce(
              (${measuresJson}::jsonb -> uc.id::text) ->> 'metric',
              uc.success_metric),
            success_target = coalesce(
              (${measuresJson}::jsonb -> uc.id::text) ->> 'target',
              uc.success_target)
        where uc.workspace_id = ${workspaceId}::uuid
          and uc.opportunity_id = ${opportunityId}::uuid
          and uc.status in ('suggested', 'approved')
        returning uc.status
      )
      select count(*) filter (where status = 'approved')::int as approved_count
      from updated
    `) as unknown as Array<{ approved_count: number }>;
    const approvedCount = counts[0]?.approved_count ?? 0;
    if (approvedCount === 0)
      throw Object.assign(new Error("No matching use cases for this lead"), {
        statusCode: 404,
      });
    await logWorkspaceEvent(client, workspaceId, {
      action: "opportunity.use_cases_approved",
      resourceType: "opportunities",
      resourceId: opportunityId,
      reason: `${approvedCount} use case(s) approved for handoff by ${validator}; they ship to the Delivery Factory as validated Must requirements.`,
      after: { approvedUseCaseIds: input.useCaseIds },
    });
    return json({ data: { approved: approvedCount } });
  }

  // Lead proposals (placement decision 2026-10-14): outreach is
  // drafted in LE from the lead's evidence + approved use cases,
  // approved by the reviewer, gated on a recorded CASL consent
  // basis, and sent by a human. Outcomes land in lead_feedback.
  if (opportunityProposal && request.method === "GET") {
    requireRole(context, ["owner", "administrator", "analyst", "reviewer"]);
    const opportunityId = opportunityProposal[1];
    const { data: opportunity, error: opportunityError } = await client
      .from("opportunities")
      .select("id, organization_id")
      .eq("workspace_id", workspaceId)
      .eq("id", opportunityId)
      .single();
    if (opportunityError || !opportunity)
      throw Object.assign(new Error("Opportunity not found"), {
        statusCode: 404,
      });
    const { data: proposals } = await client
      .from("lead_proposals")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("opportunity_id", opportunityId)
      .order("created_at", { ascending: false })
      .limit(1);
    const { data: consent } = await client
      .from("consent_records")
      .select("id")
      .eq("workspace_id", workspaceId)
      .or(
        `opportunity_id.eq.${opportunityId},organization_id.eq.${opportunity.organization_id}`,
      )
      .limit(1);
    const { data: approvedCases } = await client
      .from("opportunity_use_cases")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("opportunity_id", opportunityId)
      .eq("status", "approved");
    return json({
      data: {
        proposal: proposals?.[0] ?? null,
        consentRecorded: (consent?.length ?? 0) > 0,
        approvedUseCases: approvedCases?.length ?? 0,
      },
    });
  }

  if (opportunityProposalDraft && request.method === "POST") {
    requireRole(context, ["owner", "administrator", "analyst", "reviewer"]);
    const opportunityId = opportunityProposalDraft[1];
    const { data: approvedCases, error: casesError } = await client
      .from("opportunity_use_cases")
      .select("title, statement, success_metric, success_target")
      .eq("workspace_id", workspaceId)
      .eq("opportunity_id", opportunityId)
      .eq("status", "approved")
      .order("approved_at", { ascending: true });
    if (casesError) throw new Error(casesError.message);
    if (!approvedCases || approvedCases.length === 0)
      throw Object.assign(
        new Error(
          "Approve at least one use case first — the proposal is drafted from the approved use cases and their success measures.",
        ),
        { statusCode: 409 },
      );
    const admin = createAdminClient();
    const orgRows = (await admin`
      select o.title, o.primary_evidence_id, o.latest_assessment_id,
             org.name as org_name, org.normalized_domain as org_domain
      from public.opportunities o
      join public.organizations org on org.id = o.organization_id
      where o.id = ${opportunityId}::uuid
        and o.workspace_id = ${workspaceId}::uuid
    `) as unknown as Array<{
      title: string;
      primary_evidence_id: string | null;
      latest_assessment_id: string | null;
      org_name: string;
      org_domain: string | null;
    }>;
    const org = orgRows[0];
    if (!org)
      throw Object.assign(new Error("Opportunity not found"), {
        statusCode: 404,
      });
    let evidenceText = "";
    if (org.primary_evidence_id) {
      const evidenceRows = (await admin`
        select raw_content from public.evidence_artifacts
        where id = ${org.primary_evidence_id}::uuid
          and workspace_id = ${workspaceId}::uuid
      `) as unknown as Array<{ raw_content: string | null }>;
      if (evidenceRows[0]?.raw_content)
        evidenceText = cleanEvidenceText(evidenceRows[0].raw_content);
    }
    let assessmentSummary: string | null = null;
    if (org.latest_assessment_id) {
      const assessmentRows = (await admin`
        select explanation from public.maturity_assessments
        where id = ${org.latest_assessment_id}::uuid
      `) as unknown as Array<{ explanation: unknown }>;
      const explanation = assessmentRows[0]?.explanation;
      if (typeof explanation === "string")
        assessmentSummary = explanation.slice(0, 600);
      else if (explanation && typeof explanation === "object") {
        const summary = (explanation as Record<string, unknown>).summary;
        if (typeof summary === "string")
          assessmentSummary = summary.slice(0, 600);
      }
    }
    const useCases: ApprovedUseCaseForProposal[] = approvedCases.map(
      (row: Record<string, unknown>) => ({
        title: row.title as string,
        statement: row.statement as string,
        successMetric: (row.success_metric as string | null) ?? null,
        successTarget: (row.success_target as string | null) ?? null,
      }),
    );
    const drafted =
      (evidenceText
        ? await draftProposalWithLlm({
            orgName: org.org_name || org.title,
            orgDomain: org.org_domain,
            evidenceText,
            useCases,
            assessmentSummary,
          })
        : null) ??
      templateProposal({ orgName: org.org_name || org.title, useCases });
    // Proposal writes also go through the server connection
    // (same boundary as the use-case approvals: SELECT-only for
    // the member Data API — see migration 202610120011).
    await admin`
      update public.lead_proposals set status = 'superseded'
      where workspace_id = ${workspaceId}::uuid
        and opportunity_id = ${opportunityId}::uuid
        and status = 'draft'
    `;
    const inserted = (await admin`
      insert into public.lead_proposals (
        workspace_id, opportunity_id, draft_text, evidence_quotes,
        status, drafted_by, model)
      values (${workspaceId}::uuid, ${opportunityId}::uuid,
        ${drafted.text}, ${JSON.stringify(drafted.evidenceQuotes)}::jsonb,
        'draft', ${drafted.draftedBy}, ${drafted.model})
      returning *
    `) as unknown as Array<Record<string, unknown>>;
    return json({ data: inserted[0] }, 201);
  }

  if (opportunityProposalApprove && request.method === "POST") {
    requireRole(context, ["owner", "administrator", "analyst", "reviewer"]);
    const opportunityId = opportunityProposalApprove[1];
    const input = z
      .object({
        proposalId: z.string().uuid(),
        text: z.string().min(40).max(6_000),
      })
      .parse(await bodyJson(request));
    const { data: opportunity } = await client
      .from("opportunities")
      .select("id, organization_id")
      .eq("workspace_id", workspaceId)
      .eq("id", opportunityId)
      .single();
    if (!opportunity)
      throw Object.assign(new Error("Opportunity not found"), {
        statusCode: 404,
      });
    const { data: consent } = await client
      .from("consent_records")
      .select("id")
      .eq("workspace_id", workspaceId)
      .or(
        `opportunity_id.eq.${opportunityId},organization_id.eq.${opportunity.organization_id}`,
      )
      .limit(1);
    if (!consent || consent.length === 0)
      throw Object.assign(
        new Error(
          "Record a CASL consent basis for this lead before approving the proposal — outreach without a recorded basis is not permitted. Use the consent form in the Proposal panel.",
        ),
        { statusCode: 409 },
      );
    const approver = context.user.email ?? context.user.id;
    const admin = createAdminClient();
    const updatedRows = (await admin`
      update public.lead_proposals
      set draft_text = ${input.text}, status = 'approved',
          approved_by = ${approver}, approved_at = now()
      where workspace_id = ${workspaceId}::uuid
        and opportunity_id = ${opportunityId}::uuid
        and id = ${input.proposalId}::uuid
        and status = 'draft'
      returning *
    `) as unknown as Array<Record<string, unknown>>;
    const proposal = updatedRows[0];
    if (!proposal) {
      // The conditional update matched nothing: either the
      // proposal does not exist in this workspace (404) or it is
      // no longer a draft (409) — approving an approved or sent
      // proposal must never silently reset it.
      const existing = (await admin`
        select status from public.lead_proposals
        where workspace_id = ${workspaceId}::uuid
          and opportunity_id = ${opportunityId}::uuid
          and id = ${input.proposalId}::uuid
      `) as unknown as Array<{ status: string }>;
      if (existing.length === 0)
        throw Object.assign(new Error("Proposal not found"), {
          statusCode: 404,
        });
      throw Object.assign(
        new Error(
          `Only a draft proposal can be approved — this proposal is already ${existing[0].status}.`,
        ),
        { statusCode: 409 },
      );
    }
    await logWorkspaceEvent(client, workspaceId, {
      action: "opportunity.proposal_approved",
      resourceType: "opportunities",
      resourceId: opportunityId,
      reason: `Outreach proposal approved by ${approver}; a human sends it externally. Consent basis on record.`,
      after: { proposalId: input.proposalId },
    });
    return json({ data: proposal });
  }

  if (opportunityProposalSent && request.method === "POST") {
    requireRole(context, ["owner", "administrator", "analyst", "reviewer"]);
    const opportunityId = opportunityProposalSent[1];
    const input = z
      .object({ proposalId: z.string().uuid() })
      .parse(await bodyJson(request));
    const admin = createAdminClient();
    const sentRows = (await admin`
      update public.lead_proposals
      set status = 'sent', sent_at = now()
      where workspace_id = ${workspaceId}::uuid
        and opportunity_id = ${opportunityId}::uuid
        and id = ${input.proposalId}::uuid
        and status = 'approved'
      returning *
    `) as unknown as Array<Record<string, unknown>>;
    const proposal = sentRows[0];
    if (!proposal)
      throw Object.assign(
        new Error(
          "Proposal not found or not approved — only an approved proposal can be marked sent.",
        ),
        { statusCode: 409 },
      );
    const sentOpportunity = (await admin`
      select data_mode from public.opportunities
      where id = ${opportunityId}::uuid
        and workspace_id = ${workspaceId}::uuid
    `) as unknown as Array<{ data_mode: string }>;
    await admin`
      insert into public.lead_feedback (
        workspace_id, opportunity_id, reviewer_id, decision,
        reason_code, notes, data_mode)
      values (${workspaceId}::uuid, ${opportunityId}::uuid,
        ${context.user.id}, 'contacted', 'PROPOSAL_SENT',
        'Approved proposal sent by the operator (human-sent from LE).',
        ${sentOpportunity[0]?.data_mode ?? "pilot"})
    `;
    return json({ data: proposal });
  }

  // Delivery status for handoffs: the outbox row is the delivery
  // truth (pending/retrying, sent = DF accepted, failed = terminal).
  // The leads UI maps rows to opportunities via the idempotency key
  // suffix and shows a per-lead delivery chip + confirmation.
  if (pathname === "/api/v1/handoffs" && request.method === "GET") {
    const { data, error } = await client
      .from("handoff_outbox")
      .select(
        "id, idempotency_key, status, attempts, last_error, dispatched_at, created_at, updated_at",
      )
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return json({ data: data ?? [] });
  }

  if (pathname === "/api/v1/handoffs" && request.method === "POST") {
    requireRole(context, ["owner", "administrator", "analyst"]);
    const input = z
      .object({
        opportunityId: z.string().uuid(),
        idempotencyKey: z.string().min(1).max(200).optional(),
      })
      .parse(await bodyJson(request));
    const { data: opportunity, error: opportunityError } = await client
      .from("opportunities")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("id", input.opportunityId)
      .single();
    if (opportunityError || !opportunity)
      throw Object.assign(new Error("Opportunity not found"), {
        statusCode: 404,
      });
    const { data: approvedUseCases } = await client
      .from("opportunity_use_cases")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("opportunity_id", input.opportunityId)
      .eq("status", "approved")
      .limit(1);
    if (!approvedUseCases || approvedUseCases.length === 0)
      throw Object.assign(
        new Error(
          "Approve at least one use case for this lead before sending it to the Delivery Factory — DF requires a human-validated requirement baseline. Open the lead's Use cases panel, select the opportunities that fit, and approve them.",
        ),
        { statusCode: 409 },
      );
    const {
      package: handoffPackage,
      manifestChecksum,
      signature,
    } = await buildHandoffPackage(createAdminClient() as unknown as SqlClient, {
      workspaceId,
      opportunityId: input.opportunityId,
      approvedBy: context.user.email ?? context.user.id,
    });
    const enqueued = await enqueueHandoffOutbox(
      (name, args) => client.rpc(name, args),
      {
        workspaceId,
        idempotencyKey:
          input.idempotencyKey ??
          `handoff:${workspaceId}:${input.opportunityId}`,
        package: handoffPackage,
        manifestChecksum,
        signature,
      },
    );
    // Truth-in-confirmation (Codex P2 on PR #49): when the outbox
    // row is mid-dispatch or already delivered, the RPC returns it
    // unchanged — so a resend carrying a CHANGED baseline would
    // otherwise report success for a package that was discarded.
    // Compare what is actually stored with what was just built.
    if (enqueued.manifestChecksum !== manifestChecksum) {
      throw Object.assign(
        new Error(
          enqueued.status === "sent"
            ? "This lead was already delivered to the Delivery Factory with an earlier baseline — the changed use cases were not sent (the v1 handoff delivers one package per lead)."
            : "A delivery for this lead is already in progress with an earlier package — the changed use cases were not sent. Wait for the current delivery to finish, then resend.",
        ),
        { statusCode: 409 },
      );
    }
    // Best-effort immediate dispatch (handoff gap 1): the 5-minute worker
    // tick stays the durable fallback, but an accepted lead should reach DF
    // in seconds, not minutes. tryImmediateDispatch never rejects, so the
    // 201 enqueue response below is unaffected by dispatch failures.
    await tryImmediateDispatch(
      createAdminClient() as unknown as SqlClient,
      enqueued.id,
    );
    return json(
      {
        id: enqueued.id,
        manifestChecksum,
        status: enqueued.status,
      },
      201,
    );
  }

  // CASL consent records (audit gap 1): what outreach basis exists for an
  // organization/opportunity, who recorded it, and what evidence supports
  // it. The outreach checklist gates on these rows; the handoff package
  // carries the latest basis to the Delivery Factory.
  if (pathname === "/api/v1/consent" && request.method === "GET") {
    const url = new URL(request.url);
    const organizationId = url.searchParams.get("organizationId");
    const opportunityId = url.searchParams.get("opportunityId");
    let query = client
      .from("consent_records")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("recorded_at", { ascending: false })
      .limit(200);
    if (organizationId) query = query.eq("organization_id", organizationId);
    if (opportunityId) query = query.eq("opportunity_id", opportunityId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return json({ data });
  }
  if (pathname === "/api/v1/consent" && request.method === "POST") {
    requireRole(context, ["owner", "administrator", "analyst"]);
    const input = ConsentInputSchema.parse(await bodyJson(request));
    if (!input.organizationId && !input.opportunityId)
      throw Object.assign(
        new Error("organizationId or opportunityId is required"),
        { statusCode: 400 },
      );
    if (input.organizationId) {
      const { data: org, error: orgError } = await client
        .from("organizations")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("id", input.organizationId)
        .single();
      if (orgError || !org)
        throw Object.assign(new Error("Organization not found"), {
          statusCode: 404,
        });
    }
    if (input.opportunityId) {
      const { data: opp, error: oppError } = await client
        .from("opportunities")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("id", input.opportunityId)
        .single();
      if (oppError || !opp)
        throw Object.assign(new Error("Opportunity not found"), {
          statusCode: 404,
        });
    }
    // Consent records are gate-trusted (handoff + proposal
    // approvals rely on them), so the insert goes through the
    // server connection — the member Data API is SELECT-only on
    // this table (Codex P1 boundary, PR #49).
    const admin = createAdminClient();
    const recordedBy = context.user.email ?? context.user.id;
    const consentRows = (await admin`
      insert into public.consent_records (
        workspace_id, organization_id, opportunity_id, basis_type,
        evidence_reference, recorded_by, notes)
      values (${workspaceId}::uuid,
        ${input.organizationId ?? null}::uuid,
        ${input.opportunityId ?? null}::uuid,
        ${input.basisType},
        ${input.evidenceReference ?? null},
        ${recordedBy},
        ${input.notes ?? null})
      returning *
    `) as unknown as Array<Record<string, unknown>>;
    return json({ data: consentRows[0] }, 201);
  }

  // Third-party terms acceptance (audit gap 2). Owners/administrators only.
  if (pathname === "/api/v1/terms/accept" && request.method === "POST") {
    requireRole(context, ["owner", "administrator"]);
    const input = z
      .object({
        termsId: z.string().min(1).max(80),
        notes: z.string().max(2_000).optional(),
      })
      .parse(await bodyJson(request));
    const terms = Object.values(DISCOVERY_TERMS).find(
      (item) => item.id === input.termsId,
    );
    if (!terms)
      throw Object.assign(new Error(`Unknown terms id: ${input.termsId}`), {
        statusCode: 422,
      });
    const { error } = await client.from("terms_acceptances").upsert(
      {
        workspace_id: workspaceId,
        terms_id: input.termsId,
        terms_version: terms.version,
        accepted_by: context.user.email ?? context.user.id,
        notes: input.notes ?? null,
      },
      { onConflict: "workspace_id,terms_id" },
    );
    if (error) throw new Error(error.message);
    return json(
      {
        data: {
          termsId: terms.id,
          termsVersion: terms.version,
          acceptedBy: context.user.email ?? context.user.id,
        },
      },
      201,
    );
  }
  if (pathname === "/api/v1/terms" && request.method === "GET") {
    const { data, error } = await client
      .from("terms_acceptances")
      .select("*")
      .eq("workspace_id", workspaceId);
    if (error) throw new Error(error.message);
    return json({ data });
  }

  // Pipeline funnel width (audit fix): one number per stage so the funnel
  // is visible before the first qualified lead ever appears.
  if (pathname === "/api/v1/funnel" && request.method === "GET") {
    const url = new URL(request.url);
    const mode = z
      .enum(["demo", "pilot", "production"])
      .parse(url.searchParams.get("mode") ?? "pilot");
    const windowDays = Math.min(
      365,
      Math.max(1, Number(url.searchParams.get("windowDays")) || 30),
    );
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const { count: activeSources, error: sourcesError } = await client
      .from("source_definitions")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("data_mode", mode)
      .eq("status", "active");
    if (sourcesError) throw new Error(sourcesError.message);
    const { count: candidatesEvaluated, error: evaluatedError } = await client
      .from("discovery_candidates")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("data_mode", mode)
      .gte("last_seen_at", since);
    if (evaluatedError) throw new Error(evaluatedError.message);
    const { count: scored, error: scoredError } = await client
      .from("maturity_assessments")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("data_mode", mode)
      .gte("evaluated_at", since);
    if (scoredError) throw new Error(scoredError.message);
    const { count: qualified, error: qualifiedError } = await client
      .from("maturity_assessments")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("data_mode", mode)
      .gte("evaluated_at", since)
      .eq("qualified", true);
    if (qualifiedError) throw new Error(qualifiedError.message);
    return json({
      data: {
        activeSources: activeSources ?? 0,
        candidatesEvaluated: candidatesEvaluated ?? 0,
        scored: scored ?? 0,
        qualified: qualified ?? 0,
        windowDays,
      },
    });
  }

  if (pathname === "/api/v1/audit-events" && request.method === "GET") {
    const { data, error } = await client
      .from("audit_events")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return json({ data });
  }
  if (pathname === "/api/v1/operations" && request.method === "GET") {
    return json({
      data: await operationalSnapshot(createAdminClient(), workspaceId),
    });
  }

  if (pathname === "/api/v1/job-bank-market" && request.method === "GET") {
    return json({ data: await readJobBankMarketView(createAdminClient()) });
  }

  if (pathname === "/api/v1/discovery/sources" && request.method === "GET") {
    const { data, error } = await client
      .from("discovery_sources")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return json({ data });
  }
  if (pathname === "/api/v1/discovery/sources" && request.method === "POST") {
    requireRole(context, ["owner", "administrator", "analyst"]);
    const input = DiscoverySourceInputSchema.parse(await bodyJson(request));
    const adapterConfig = parseDiscoveryAdapterConfig(
      input.adapterId,
      input.adapterConfig,
    );
    const resolvedGeo = resolveGeoQuery(input.geo);
    // The discovery source borrows an existing, approved collection source:
    // its policy governs the scrape jobs enqueued from discovered websites.
    const { data: linked, error: linkedError } = await client
      .from("source_definitions")
      .select("id,status,data_mode,active_policy_id")
      .eq("workspace_id", workspaceId)
      .eq("id", input.sourceId)
      .maybeSingle();
    if (linkedError) throw new Error(linkedError.message);
    if (!linked)
      throw Object.assign(new Error("Collection source not found"), {
        statusCode: 404,
      });
    if (linked.data_mode !== input.dataMode)
      throw Object.assign(
        new Error(
          "Discovery source and collection source must use the same data mode",
        ),
        { statusCode: 409 },
      );
    if (linked.status !== "active" || !linked.active_policy_id)
      throw Object.assign(
        new Error("Collection source must have an approved active policy"),
        { statusCode: 409 },
      );
    const { data: linkedPolicy, error: policyError } = await client
      .from("source_policy_versions")
      .select("status,approved_by,allow_discovered_domains")
      .eq("workspace_id", workspaceId)
      .eq("id", linked.active_policy_id)
      .maybeSingle();
    if (policyError) throw new Error(policyError.message);
    if (
      linkedPolicy?.status !== "approved" ||
      !linkedPolicy.approved_by ||
      !linkedPolicy.allow_discovered_domains
    )
      throw Object.assign(
        new Error(
          "Linked collection source must have an approved policy with discovered-domain collection enabled",
        ),
        { statusCode: 409 },
      );
    if (input.campaignId) {
      const { data: campaign, error: campaignError } = await client
        .from("scrape_campaigns")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("id", input.campaignId)
        .maybeSingle();
      if (campaignError) throw new Error(campaignError.message);
      if (!campaign)
        throw Object.assign(new Error("Campaign not found"), {
          statusCode: 404,
        });
    }
    const { data, error } = await client
      .from("discovery_sources")
      .insert({
        workspace_id: workspaceId,
        name: input.name,
        adapter_id: input.adapterId,
        geo_params: resolvedGeo,
        adapter_config: adapterConfig,
        data_mode: input.dataMode,
        source_id: input.sourceId,
        campaign_id: input.campaignId ?? null,
        active: true,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return json({ data }, 201);
  }
  if (pathname === "/api/v1/discovery/runs" && request.method === "GET") {
    const sourceFilter = new URL(request.url).searchParams.get("source_id");
    let query = client
      .from("discovery_runs")
      .select("*")
      .eq("workspace_id", workspaceId);
    if (sourceFilter) query = query.eq("discovery_source_id", sourceFilter);
    const { data, error } = await query
      .order("started_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return json({ data });
  }
  if (pathname === "/api/v1/discovery/candidates" && request.method === "GET") {
    const url = new URL(request.url);
    const mode = z
      .enum(["demo", "pilot", "production"])
      .parse(url.searchParams.get("mode") ?? "pilot");
    const { data, error } = await client
      .from("discovery_candidates")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("data_mode", mode)
      .order("last_seen_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return json({ data });
  }
  const candidateResolution = pathname.match(
    /^\/api\/v1\/discovery\/candidates\/([0-9a-f-]+)\/resolve$/i,
  );
  if (candidateResolution && request.method === "POST") {
    requireRole(context, ["owner", "administrator", "analyst"]);
    const input = CandidateResolutionInputSchema.parse(await bodyJson(request));
    const normalized = new URL(input.website);
    if (normalized.protocol !== "http:" && normalized.protocol !== "https:")
      throw Object.assign(new Error("Resolved website must use HTTP(S)"), {
        statusCode: 422,
      });
    normalized.hash = "";
    const website = normalized.toString();
    const { data: candidate, error: candidateError } = await client
      .from("discovery_candidates")
      .select("id,data_mode,discovery_source_id")
      .eq("workspace_id", workspaceId)
      .eq("id", candidateResolution[1])
      .maybeSingle();
    if (candidateError) throw new Error(candidateError.message);
    if (!candidate)
      throw Object.assign(new Error("Discovery candidate not found"), {
        statusCode: 404,
      });
    const { data: discoverySource, error: discoveryError } = await client
      .from("discovery_sources")
      .select("source_id,data_mode")
      .eq("workspace_id", workspaceId)
      .eq("id", candidate.discovery_source_id)
      .single();
    if (discoveryError) throw new Error(discoveryError.message);
    if (discoverySource.data_mode !== candidate.data_mode)
      throw Object.assign(
        new Error("Candidate data mode does not match its source"),
        {
          statusCode: 409,
        },
      );
    const normalizedTarget = normalizeWebsiteUrl(website);
    if (!normalizedTarget)
      throw Object.assign(new Error("Resolved website is invalid"), {
        statusCode: 422,
      });
    const key = `discovery:${candidate.data_mode}:${discoverySource.source_id}:${normalizedTarget}`;
    const { data, error } = await client.rpc("resolve_discovery_candidate", {
      p_workspace_id: workspaceId,
      p_candidate_id: candidate.id,
      p_website: website,
      p_domain: normalized.hostname.toLowerCase(),
      p_key: key,
      p_notes: input.notes,
    });
    if (error) throw new Error(error.message);
    return json({ data }, 202);
  }
  const discoveryRun = pathname.match(
    /^\/api\/v1\/discovery\/sources\/([0-9a-f-]+)\/run$/i,
  );
  if (discoveryRun && request.method === "POST") {
    requireRole(context, ["owner", "administrator", "analyst"]);
    const { data: discoverySource, error: discoverySourceError } = await client
      .from("discovery_sources")
      .select("adapter_id,campaign_id")
      .eq("workspace_id", workspaceId)
      .eq("id", discoveryRun[1])
      .single();
    if (discoverySourceError || !discoverySource)
      throw Object.assign(new Error("Discovery source not found"), {
        statusCode: 404,
      });
    // Retiring a campaign stops its discovery collection too: a
    // discovery source linked to a retired campaign does not run.
    if (discoverySource.campaign_id) {
      const { data: linkedCampaign } = await client
        .from("scrape_campaigns")
        .select("status")
        .eq("workspace_id", workspaceId)
        .eq("id", discoverySource.campaign_id)
        .maybeSingle();
      if (isRetired(linkedCampaign?.status as string | null))
        throw Object.assign(new Error("Campaign is retired"), {
          statusCode: 409,
        });
    }
    const requiredTerms = termsForAdapter(discoverySource.adapter_id);
    await requireTermsAcceptance(
      {
        hasAccepted: async (wsId: string, termsId: string) => {
          const { data, error } = await client
            .from("terms_acceptances")
            .select("terms_id")
            .eq("workspace_id", wsId)
            .eq("terms_id", termsId)
            .maybeSingle();
          if (error) throw new Error(error.message);
          return data !== null;
        },
      },
      workspaceId,
      requiredTerms.id,
      requiredTerms.label,
    );
    const store: DiscoveryStore = {
      getSource: async (discoverySourceId: string) => {
        const { data, error } = await client
          .from("discovery_sources")
          .select("*")
          .eq("workspace_id", workspaceId)
          .eq("id", discoverySourceId)
          .maybeSingle();
        if (error) throw new Error(error.message);
        return (data as DiscoverySourceRow | null) ?? null;
      },
      createRun: async (discoverySourceId: string) => {
        const { data, error } = await client
          .from("discovery_runs")
          .insert({
            workspace_id: workspaceId,
            discovery_source_id: discoverySourceId,
            status: "running",
          })
          .select("id,started_at")
          .single();
        if (error) throw new Error(error.message);
        const row = data as { id: string; started_at: string };
        return { id: row.id, startedAt: row.started_at };
      },
      finishRun: async (runId: string, outcome) => {
        const { error } = await client
          .from("discovery_runs")
          .update({
            status: outcome.status,
            finished_at: new Date().toISOString(),
            candidates_found: outcome.candidatesFound,
            candidates_enqueued: outcome.candidatesEnqueued,
            candidates_persisted: outcome.candidatesPersisted ?? 0,
            candidates_unresolved: outcome.candidatesUnresolved ?? 0,
            error: outcome.error,
          })
          .eq("workspace_id", workspaceId)
          .eq("id", runId);
        if (error) throw new Error(error.message);
      },
      upsertCandidate: async ({
        runId,
        source,
        candidate,
        externalId,
        identityKey,
      }) => {
        const mode = source.data_mode ?? "pilot";
        const { data: existing, error: existingError } = await client
          .from("discovery_candidates")
          .select("id,resolved_website,resolution_status")
          .eq("workspace_id", workspaceId)
          .eq("adapter_id", source.adapter_id)
          .eq("external_id", externalId)
          .eq("data_mode", mode)
          .maybeSingle();
        if (existingError) throw new Error(existingError.message);
        let resolvedWebsite = candidate.website;
        let resolutionStatus: "direct" | "matched" | "unresolved" =
          candidate.website ? "direct" : "unresolved";
        let confidence = candidate.website ? 1 : 0;
        if (!resolvedWebsite) {
          const { data: match, error: matchError } = await client
            .from("discovery_candidates")
            .select("resolved_website")
            .eq("workspace_id", workspaceId)
            .eq("data_mode", mode)
            .eq("identity_key", identityKey)
            .not("resolved_website", "is", null)
            .limit(1)
            .maybeSingle();
          if (matchError) throw new Error(matchError.message);
          if (match?.resolved_website) {
            resolvedWebsite = match.resolved_website;
            resolutionStatus = "matched";
            confidence = 0.9;
          }
        }
        const { data, error } = await client
          .from("discovery_candidates")
          .upsert(
            {
              workspace_id: workspaceId,
              discovery_source_id: source.id,
              discovery_run_id: runId,
              adapter_id: source.adapter_id,
              external_id: externalId,
              data_mode: mode,
              name: candidate.name ?? "Unnamed candidate",
              normalized_name: (
                candidate.name ?? "Unnamed candidate"
              ).toLowerCase(),
              identity_key: identityKey,
              website: candidate.website,
              resolved_website: resolvedWebsite,
              resolution_status: resolutionStatus,
              resolution_confidence: confidence,
              address: candidate.address,
              latitude: candidate.lat,
              longitude: candidate.lng,
              category: candidate.category,
              source_url:
                candidate.sourceUrl ?? resolvedWebsite ?? "about:blank",
              source_observed_at:
                candidate.observedAt ?? new Date().toISOString(),
              evidence_text: candidate.evidenceText ?? "",
              raw_record: candidate.rawRecord ?? {},
              last_seen_at: new Date().toISOString(),
            },
            { onConflict: "workspace_id,adapter_id,external_id,data_mode" },
          )
          .select("id,resolved_website,resolution_status")
          .single();
        if (error) throw new Error(error.message);
        return {
          id: data.id,
          resolvedWebsite: data.resolved_website,
          resolutionStatus: data.resolution_status,
          duplicate: existing !== null,
        };
      },
      listExistingTargets: async (sourceId: string) => {
        const { data, error } = await client
          .from("scrape_jobs")
          .select("target_url,idempotency_key")
          .eq("workspace_id", workspaceId)
          .eq("source_id", sourceId);
        if (error) throw new Error(error.message);
        return (data ?? []) as Array<{
          target_url: string;
          idempotency_key: string;
        }>;
      },
      queueJob: async ({
        sourceId,
        targetUrl,
        key,
        maxAttempts,
        candidateId,
      }) => {
        // Existing creation path: the DB validates the source is approved
        // and active, links the campaign, and enforces idempotency.
        const { data, error } = await client.rpc("queue_scrape_job", {
          p_workspace_id: workspaceId,
          p_source_id: sourceId,
          p_target_url: targetUrl,
          p_key: key,
          p_max_attempts: maxAttempts,
        });
        if (error) throw new Error(error.message);
        const row = data as { id: string; created_at: string };
        if (candidateId) {
          const { error: candidateError } = await client
            .from("scrape_jobs")
            .update({ discovery_candidate_id: candidateId })
            .eq("workspace_id", workspaceId)
            .eq("id", row.id);
          if (candidateError) throw new Error(candidateError.message);
        }
        return { id: row.id, createdAt: row.created_at };
      },
    };
    const summary = await runDiscoveryRun({
      store,
      adapters: createDiscoveryAdapters(),
      discoverySourceId: discoveryRun[1],
    });
    return json({ data: summary }, 202);
  }

  throw Object.assign(new Error("Route not found"), { statusCode: 404 });
}

export async function handleApiRequest(request: Request): Promise<Response> {
  const started = Date.now();
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  const context = requestContext(request, pathname);
  if (request.method === "OPTIONS")
    return withCors(new Response(null, { status: 204 }), request, pathname);
  log("info", "request_started", context);
  try {
    let response: Response;
    if (pathname === "/api/health/live" && request.method === "GET") {
      response = json({
        status: "ok",
        service: "lead-engine",
        version: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
        timestamp: new Date().toISOString(),
      });
    } else if (pathname === "/api/health/ready" && request.method === "GET") {
      const configuration = configurationStatus();
      if (!configuration.configured)
        response = json(
          {
            status: "not_ready",
            configuration: {
              configured: false,
              missing: configuration.missing,
            },
          },
          503,
        );
      else {
        const admin = createAdminClient();
        await assertDatabaseReady(admin);
        const operations = await operationalSnapshot(admin);
        const latestWorker = operations.workers[0];
        const workerFresh =
          latestWorker &&
          Date.now() - new Date(latestWorker.last_heartbeat_at).getTime() <
            15 * 60_000;
        response = json(
          {
            status: workerFresh ? "ready" : "degraded",
            database: "ready",
            worker: workerFresh ? "ready" : "stale_or_missing",
            canary: operations.canary,
            timestamp: new Date().toISOString(),
          },
          workerFresh ? 200 : 503,
        );
      }
    } else if (pathname === "/api/health/canary" && request.method === "GET") {
      const configuration = configurationStatus();
      if (!configuration.configured)
        response = json({ status: "not_configured" }, 503);
      else
        response = json({
          status: "ok",
          ...(await operationalSnapshot(createAdminClient())).canary,
        });
    } else if (
      pathname === "/api/v1/worker/tick" &&
      (request.method === "GET" || request.method === "POST")
    ) {
      await requireScheduler(request);
      const admin = createAdminClient();
      response = json({ data: await runWorkerTick(admin) });
      await recordQstashSuccess(
        admin as unknown as AlertSqlClient,
        schedulerWorkspaceId(),
        await schedulerName(request),
      );
    } else if (
      pathname === "/api/v1/canary/run" &&
      (request.method === "GET" || request.method === "POST")
    ) {
      await requireScheduler(request);
      const admin = createAdminClient();
      response = json({ data: await enqueueCanary(admin) }, 202);
      await recordQstashSuccess(
        admin as unknown as AlertSqlClient,
        schedulerWorkspaceId(),
        await schedulerName(request),
      );
    } else if (
      pathname === "/api/v1/discovery/scheduled-run" &&
      (request.method === "GET" || request.method === "POST")
    ) {
      // Daily QStash schedule (audit fix 1): each active discovery source
      // runs at most once per 24h. Scheduler-signed like the worker tick.
      await requireScheduler(request);
      const admin = createAdminClient();
      response = json({
        data: await runScheduledDiscovery(
          admin as unknown as Parameters<
            typeof runScheduledDiscovery
          >[0],
        ),
      });
      await recordQstashSuccess(
        admin as unknown as AlertSqlClient,
        schedulerWorkspaceId(),
        await schedulerName(request),
      );
    } else if (
      pathname === "/api/v1/qstash/failure" &&
      request.method === "POST"
    ) {
      await requireScheduler(request);
      const payload = QstashFailureSchema.parse(await bodyJson(request));
      const transition = await recordQstashFailure(
        createAdminClient() as unknown as AlertSqlClient,
        schedulerWorkspaceId(),
        payload,
      );
      response = json({ data: { accepted: true, transition } }, 202);
    } else if (
      pathname === "/api/v1/operations/evaluate" &&
      (request.method === "GET" || request.method === "POST")
    ) {
      await requireScheduler(request);
      const admin = createAdminClient();
      response = json({
        data: {
          transitions: await checkOperationalAlerts(
            admin as unknown as AlertSqlClient,
          ),
        },
      });
      await recordQstashSuccess(
        admin as unknown as AlertSqlClient,
        schedulerWorkspaceId(),
        await schedulerName(request),
      );
    } else if (
      pathname === "/api/v1/feedback/events" &&
      request.method === "POST"
    ) {
      // Machine-to-machine route: authenticated by the Delivery Factory's
      // Ed25519 envelope signature, not by a user session.
      const result = await ingestDeliveryFeedback(await bodyJson(request));
      response = json(result, result.status === "duplicate" ? 200 : 201);
    } else {
      response = await authenticatedRoutes(request, pathname);
    }
    log("info", "request_completed", {
      ...context,
      status: response.status,
      durationMs: Date.now() - started,
    });
    response.headers.set(
      "x-correlation-id",
      context.correlationId ?? randomUUID(),
    );
    return withCors(response, request, pathname);
  } catch (error) {
    const status = Number(
      (error as { statusCode?: number }).statusCode ??
        (error instanceof z.ZodError ? 400 : 500),
    );
    await reportError(error, {
      ...context,
      status,
      durationMs: Date.now() - started,
    });
    const message =
      status >= 500
        ? "Internal service error"
        : error instanceof Error
          ? error.message
          : String(error);
    const details = error instanceof z.ZodError ? error.flatten() : undefined;
    return withCors(
      json(
        {
          error: {
            code: status >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
            message,
            details,
          },
          correlationId: context.correlationId,
        },
        status,
      ),
      request,
      pathname,
    );
  }
}
