import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CriteriaSchema,
  evaluateCanarySoak,
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
  type SqlClient,
} from "./handoff.js";
import { ingestDeliveryFeedback } from "./feedback.js";
import { enqueueCanary, runWorkerTick } from "./worker.js";
import {
  DiscoveryGeoInputSchema,
  resolveGeoQuery,
} from "./discovery/adapter.js";
import { OverpassAdapter } from "./discovery/overpass.js";
import {
  runDiscoveryRun,
  type DiscoverySourceRow,
  type DiscoveryStore,
} from "./discovery/run.js";

const SourceInputSchema = z.object({
  name: z.string().min(2).max(160),
  baseUrl: z.string().url(),
  collectionMethod: z.enum(["api", "rss", "sitemap", "static_html"]),
  businessPurpose: z.string().min(10).max(1_000),
  allowedDomains: z.array(z.string().min(1)).min(1),
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
});

const ManualJobSchema = z.object({
  sourceId: z.string().uuid(),
  targetUrl: z.string().url(),
  maxAttempts: z.number().int().min(1).max(10).default(3),
});

const DiscoverySourceInputSchema = z.object({
  name: z.string().min(2).max(160),
  adapterId: z.literal("overpass"),
  geo: DiscoveryGeoInputSchema,
  sourceId: z.string().uuid(),
  campaignId: z.string().uuid().optional(),
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
  return /[",\n\r]/.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
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
  "opportunity_potential_score",
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
    opportunity_potential_score: lead.opportunity_potential_score ?? null,
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
    lines.push(LEAD_EXPORT_COLUMNS.map((column) => csvEscape(row[column])).join(","));
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
  const [jobsResult, canaryResult, workersResult] = await Promise.all([
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
        and (${workspaceFilter}::uuid is null or workspace_id = ${workspaceFilter}::uuid)
      order by scheduled_at
    `,
    client`
      select id, status, runtime, capabilities, last_heartbeat_at, deployment_id
      from public.worker_nodes
      order by last_heartbeat_at desc
      limit 20
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
            "id,source_id,target_url,status,scheduled_for,started_at,completed_at,attempt_count,max_attempts,last_error,created_at",
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
          .order("opportunity_potential_score", { ascending: false })
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
    return json({
      actor: {
        id: context.user.id,
        email: context.user.email,
        role: context.role,
      },
      workspaceId,
      memberships: memberships.data,
      sources: sources.data,
      campaigns: (campaigns.data ?? []).map((campaign: any) => ({
        ...campaign,
        criteria_suggestion: suggestCriteriaAdjustment(
          campaign.criteria,
          Number(
            recentLeads.data?.find(
              (row: { campaign_id: string }) => row.campaign_id === campaign.id,
            )?.qualified_count ?? 0,
          ),
        ),
      })),
      jobs: jobs.data,
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
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.name !== undefined) {
      sets.push(`name = $${idx++}`);
      params.push(input.name);
    }
    if (input.baseUrl !== undefined) {
      sets.push(`base_url = $${idx++}`);
      params.push(input.baseUrl);
    }
    if (input.collectionMethod !== undefined) {
      sets.push(`collection_method = $${idx++}`);
      params.push(input.collectionMethod);
    }
    if (input.businessPurpose !== undefined) {
      sets.push(`business_purpose = $${idx++}`);
      params.push(input.businessPurpose);
    }
    if (sets.length === 0)
      throw Object.assign(new Error("No fields to update"), { statusCode: 400 });
    const sql = createAdminClient() as unknown as (
      query: string,
      params: unknown[],
    ) => Promise<Array<Record<string, unknown>>>;
    const rows = await sql(
      `update public.source_definitions set ${sets.join(", ")}, updated_at = now()
       where workspace_id = $${idx++} and id = $${idx++}
       returning id, name, base_url, collection_method, business_purpose, status`,
      [...params, workspaceId, sourceUpdate[1]],
    );
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
    const updates: Record<string, unknown> = {
      criteria: input.criteria,
      criteria_version: new Date().toISOString(),
      updated_by: context.user.id,
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
      .select("id,criteria")
      .eq("workspace_id", workspaceId)
      .eq("id", campaignId)
      .single();
    if (campaignError || !campaign)
      throw Object.assign(new Error("Campaign not found"), { statusCode: 404 });
    const { data: counts, error: countsError } = await client.rpc(
      "campaign_qualified_counts",
      { p_workspace_id: workspaceId },
    );
    if (countsError) throw new Error(countsError.message);
    const observed = Number(
      (counts as Array<{ campaign_id: string; qualified_count: number }> | null)?.find(
        (row) => row.campaign_id === campaignId,
      )?.qualified_count ?? 0,
    );
    const suggestion = suggestCriteriaAdjustment(campaign.criteria, observed);
    if (
      suggestion.direction === "hold" ||
      Object.keys(suggestion.changes).length === 0
    ) {
      return json({
        applied: false,
        direction: suggestion.direction,
        reason:
          "Suggestion is hold or has no changes; nothing was applied.",
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
      .select("id,auto_apply_criteria")
      .eq("workspace_id", workspaceId)
      .eq("id", campaignId)
      .single();
    if (existingError || !existing)
      throw Object.assign(new Error("Campaign not found"), { statusCode: 404 });
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
      p_target_url: input.targetUrl,
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
      .order("opportunity_potential_score", { ascending: false });
    if (error) throw new Error(error.message);
    return json({ data });
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
      .order("opportunity_potential_score", { ascending: false })
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
    const { data, error } = await client
      .from("lead_feedback")
      .insert({
        workspace_id: workspaceId,
        opportunity_id: leadFeedback[1],
        reviewer_id: context.user.id,
        decision: input.decision,
        reason_code: input.reasonCode,
        notes: input.notes,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return json({ data }, 201);
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
    const { package: handoffPackage, manifestChecksum, signature } =
      await buildHandoffPackage(createAdminClient() as unknown as SqlClient, {
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
    return json(
      {
        id: enqueued.id,
        manifestChecksum,
        status: enqueued.status,
      },
      201,
    );
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
    const resolvedGeo = resolveGeoQuery(input.geo);
    // The discovery source borrows an existing, approved collection source:
    // its policy governs the scrape jobs enqueued from discovered websites.
    const { data: linked, error: linkedError } = await client
      .from("source_definitions")
      .select("id,status")
      .eq("workspace_id", workspaceId)
      .eq("id", input.sourceId)
      .maybeSingle();
    if (linkedError) throw new Error(linkedError.message);
    if (!linked)
      throw Object.assign(new Error("Collection source not found"), {
        statusCode: 404,
      });
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
  const discoveryRun = pathname.match(
    /^\/api\/v1\/discovery\/sources\/([0-9a-f-]+)\/run$/i,
  );
  if (discoveryRun && request.method === "POST") {
    requireRole(context, ["owner", "administrator", "analyst"]);
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
            error: outcome.error,
          })
          .eq("workspace_id", workspaceId)
          .eq("id", runId);
        if (error) throw new Error(error.message);
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
      queueJob: async ({ sourceId, targetUrl, key, maxAttempts }) => {
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
        return { id: row.id, createdAt: row.created_at };
      },
    };
    const summary = await runDiscoveryRun({
      store,
      adapters: { overpass: new OverpassAdapter() },
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
      response = json({ data: await runWorkerTick() });
    } else if (
      pathname === "/api/v1/canary/run" &&
      (request.method === "GET" || request.method === "POST")
    ) {
      await requireScheduler(request);
      response = json({ data: await enqueueCanary() }, 202);
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
