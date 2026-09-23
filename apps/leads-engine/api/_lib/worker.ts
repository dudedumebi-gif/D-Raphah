import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { collectUrl, type CollectionPolicy } from "./collection";
import {
  CriteriaSchema,
  detectSignals,
  evaluateGeography,
  retryDelaySeconds,
  scoreSignals,
} from "./domain";
import { truncateToByteLength } from "@raphah/handoff-contract";
import { createAdminClient } from "./neon";
import { dispatchDueHandoffs, type SqlClient } from "./handoff";
import { log, reportError } from "./telemetry";

type DatabaseClient = ReturnType<typeof createAdminClient>;

interface ScrapeJobRow {
  id: string;
  workspace_id: string;
  source_id: string;
  target_url: string;
  attempt_count: number;
  max_attempts: number;
  criteria_snapshot: unknown;
  scheduled_for: string;
  canary_run_id?: string | null;
}

interface SourceRow {
  id: string;
  workspace_id: string;
  name: string;
  base_url: string;
  status: string;
  active_policy_id: string;
}

interface PolicyRow {
  id: string;
  allowed_domains: string[];
  allowlist_paths: string[];
  denylist_paths: string[];
  user_agent: string;
  contact_email: string;
  rate_limit_rps: number;
  max_bytes: number;
  timeout_ms: number;
  respect_robots: boolean;
  collection_method: string;
  approved_by: string | null;
  approved_at: string | null;
}

export interface WorkerTickResult {
  workerId: string;
  enqueued: number;
  recovered: number;
  compactedEvidence: number;
  leased: number;
  completed: number;
  failed: number;
  deadLettered: number;
  handoffsDispatched: number;
  handoffsFailed: number;
}

function collectionPolicy(row: PolicyRow): CollectionPolicy {
  return {
    allowedDomains: row.allowed_domains,
    allowlistPaths: row.allowlist_paths,
    denylistPaths: row.denylist_paths,
    userAgent: row.user_agent,
    contactEmail: row.contact_email,
    rateLimitRps: row.rate_limit_rps,
    maxBytes: row.max_bytes,
    timeoutMs: row.timeout_ms,
    respectRobots: row.respect_robots,
    collectionMethod: row.collection_method,
  };
}

function organizationFromUrl(url: string): {
  domain: string;
  fallbackName: string;
} {
  const parsed = new URL(url);
  const domain = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const fallbackName = domain
    .split(".")[0]
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (value) => value.toUpperCase());
  return { domain, fallbackName };
}

async function loadSource(
  client: DatabaseClient,
  job: ScrapeJobRow,
): Promise<{ source: SourceRow; policy: PolicyRow }> {
  const sourceRows = (await client`
    select id, workspace_id, name, base_url, status, active_policy_id
    from public.source_definitions
    where id = ${job.source_id}::uuid
      and workspace_id = ${job.workspace_id}::uuid
    limit 1
  `) as unknown as SourceRow[];
  const source = sourceRows[0];
  if (!source) throw new Error(`Source unavailable: ${job.source_id}`);
  if (source.status !== "active" || !source.active_policy_id)
    throw new Error(
      "Collection blocked: source is not active with an approved policy",
    );
  const policyRows = (await client`
    select *
    from public.source_policy_versions
    where id = ${source.active_policy_id}::uuid
      and source_id = ${source.id}::uuid
    limit 1
  `) as unknown as PolicyRow[];
  const policy = policyRows[0];
  if (!policy)
    throw new Error(
      `Approved source policy unavailable: ${source.active_policy_id}`,
    );
  if (!policy.approved_by || !policy.approved_at)
    throw new Error("Collection blocked: source policy lacks human approval");
  return { source: source as SourceRow, policy: policy as PolicyRow };
}

async function persistEvidenceAndLead(
  client: DatabaseClient,
  job: ScrapeJobRow,
  source: SourceRow,
  policy: PolicyRow,
  collected: Awaited<ReturnType<typeof collectUrl>>,
  workerId: string,
) {
  const evidenceInsert = {
    workspace_id: job.workspace_id,
    source_id: source.id,
    scrape_job_id: job.id,
    canonical_url: collected.canonicalUrl,
    final_url: collected.finalUrl,
    content_hash: collected.contentHash,
    content_type: collected.contentType,
    byte_length: collected.bytesDownloaded,
    storage_bucket: "neon-postgres",
    storage_path: `${job.workspace_id}/${source.id}/${collected.contentHash}`,
    raw_content: truncateToByteLength(collected.rawContent, 250_000),
    extracted_title: collected.extractedTitle,
    extracted_organization: collected.extractedOrganization,
    extracted_text: truncateToByteLength(collected.extractedText, 100_000),
    fetched_at: collected.fetchedAt,
    parser_version: "html-text-1.0.0",
    policy_version_id: policy.id,
    robots_decision: collected.robotsDecision,
    response_status: collected.statusCode,
  };
  const signals = detectSignals(collected.extractedText);
  const { domain, fallbackName } = organizationFromUrl(collected.finalUrl);
  const criteria = CriteriaSchema.parse(job.criteria_snapshot ?? {});
  const geography = evaluateGeography(
    collected.extractedText,
    criteria,
    collected.coordinates,
  );
  const score = scoreSignals(signals, criteria, {
    icpFit: 55,
    geoEligible: geography.eligible,
    evidenceFreshness: 100,
  });
  if (job.canary_run_id && (!score.qualified || signals.length === 0)) {
    throw new Error("Canary did not produce a qualified, evidence-backed lead");
  }
  const payload = {
    evidence: evidenceInsert,
    signals,
    criteria,
    geography,
    score,
    organization: {
      domain,
      name: collected.extractedOrganization || fallbackName,
      website: new URL(collected.finalUrl).origin,
    },
  };
  const persisted = (await client`
    select public.persist_scrape_result(
      ${job.id}::uuid,
      ${workerId},
      ${JSON.stringify(payload)}::jsonb
    ) as result
  `) as unknown as Array<{ result: unknown }>;
  const data = persisted[0]?.result;
  if (!data) throw new Error("Result transaction failed: no result");
  return data as {
    evidenceId: string;
    assessmentId: string;
    opportunityId: string | null;
    signalCount: number;
    score: typeof score;
  };
}

export async function processScrapeJob(
  client: DatabaseClient,
  job: ScrapeJobRow,
  workerId: string,
) {
  const attemptRows = (await client`
    select public.start_scrape_attempt(${job.id}::uuid, ${workerId}) as attempt_number
  `) as unknown as Array<{ attempt_number: number }>;
  const attemptNumber = Number(attemptRows[0]?.attempt_number ?? 0);

  try {
    const { source, policy } = await loadSource(client, job);
    const collected = await collectUrl(
      job.target_url,
      collectionPolicy(policy),
    );
    const result = await persistEvidenceAndLead(
      client,
      job,
      source,
      policy,
      collected,
      workerId,
    );
    log("info", "scrape_job_completed", {
      jobId: job.id,
      workspaceId: job.workspace_id,
      workerId,
      signalCount: result.signalCount,
    });
    return { status: "completed" as const, result };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const permanent =
      /prohibited|not approved|robots\.txt denies|unsupported content type|requires authorization/i.test(
        errorMessage,
      );
    const nextStatus =
      permanent || attemptNumber >= job.max_attempts
        ? "dead_letter"
        : "retrying";
    const retryAt =
      nextStatus === "retrying"
        ? new Date(
            Date.now() + retryDelaySeconds(attemptNumber) * 1000,
          ).toISOString()
        : null;
    await client`
      select public.fail_scrape_job(
        ${job.id}::uuid,
        ${workerId},
        ${nextStatus}::public.job_status,
        ${errorMessage},
        ${retryAt}::timestamptz
      )
    `;
    await reportError(error, {
      jobId: job.id,
      workspaceId: job.workspace_id,
      workerId,
      permanent,
    });
    return { status: nextStatus, error: errorMessage } as const;
  }
}

export function resolveWorkerId(): string {
  return (
    process.env.WORKER_ID ||
    process.env.VERCEL_DEPLOYMENT_ID ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    hostname() ||
    `local-${randomUUID()}`
  );
}

export async function runWorkerTick(
  client = createAdminClient(),
  workerId = resolveWorkerId(),
): Promise<WorkerTickResult> {
  const result: WorkerTickResult = {
    workerId,
    enqueued: 0,
    recovered: 0,
    compactedEvidence: 0,
    leased: 0,
    completed: 0,
    failed: 0,
    deadLettered: 0,
    handoffsDispatched: 0,
    handoffsFailed: 0,
  };
  const now = new Date().toISOString();
  const deploymentId =
    process.env.VERCEL_DEPLOYMENT_ID ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    null;
  await client`
    insert into public.worker_nodes(
      id, runtime, status, capabilities, concurrency_limit, deployment_id,
      last_heartbeat_at
    ) values (
      ${workerId}, 'vercel-function', 'active',
      ${["static_html", "api", "rss", "sitemap", "json", "xml"]}, 3,
      ${deploymentId}, ${now}::timestamptz
    )
    on conflict (id) do update set
      status = excluded.status,
      capabilities = excluded.capabilities,
      deployment_id = excluded.deployment_id,
      last_heartbeat_at = excluded.last_heartbeat_at
  `;
  // Retention: prune stale worker registrations so the table does not grow
  // unboundedly across ticks. Never delete the current worker's own row.
  await client`
    delete from public.worker_nodes
    where id != ${workerId}
      and last_heartbeat_at < now() - interval '24 hours'
  `;
  const enqueueRows = (await client`
    select public.enqueue_due_scrape_jobs(${now}::timestamptz) as count
  `) as unknown as Array<{ count: number }>;
  result.enqueued = Number(enqueueRows[0]?.count ?? 0);
  const recoveredRows = (await client`
    select public.recover_expired_scrape_leases(${now}::timestamptz) as count
  `) as unknown as Array<{ count: number }>;
  result.recovered = Number(recoveredRows[0]?.count ?? 0);
  const compactedRows = (await client`
    select public.compact_expired_evidence(${now}::timestamptz) as count
  `) as unknown as Array<{ count: number }>;
  result.compactedEvidence = Number(compactedRows[0]?.count ?? 0);
  const jobs = (await client`
    select * from public.lease_scrape_jobs(
      ${workerId}, 3, 240, ${now}::timestamptz
    )
  `) as unknown as ScrapeJobRow[];
  result.leased = jobs.length;
  await Promise.all(
    jobs.map(async (job) => {
      const outcome = await processScrapeJob(client, job, workerId);
      if (outcome.status === "completed") result.completed += 1;
      else if (outcome.status === "dead_letter") result.deadLettered += 1;
      else result.failed += 1;
    }),
  );
  // Handoff dispatch must never fail the tick: a stuck intake is retried on
  // later ticks via the outbox backoff, and the tick reports its outcome.
  try {
    const dispatch = await dispatchDueHandoffs(client as unknown as SqlClient);
    result.handoffsDispatched = dispatch.dispatched;
    result.handoffsFailed = dispatch.failed;
  } catch (error) {
    log("error", "handoff_dispatch_tick_failed", { workerId });
    await reportError(error, { workerId });
    result.handoffsFailed += 1;
  }
  await client`
    update public.worker_nodes
    set last_heartbeat_at = ${new Date().toISOString()}::timestamptz,
        status = 'idle'
    where id = ${workerId}
  `;
  return result;
}

export async function enqueueCanary(client = createAdminClient()) {
  const workspaceId = process.env.LEAD_ENGINE_CANARY_WORKSPACE_ID;
  const sourceId = process.env.LEAD_ENGINE_CANARY_SOURCE_ID;
  const targetUrl = process.env.LEAD_ENGINE_CANARY_URL;
  if (!workspaceId || !sourceId || !targetUrl)
    throw new Error("Canary environment variables are incomplete");
  const scheduledAt = new Date();
  scheduledAt.setMinutes(0, 0, 0);
  const key = `canary:${workspaceId}:${sourceId}:${scheduledAt.toISOString()}`;
  await client`
    insert into public.canary_runs(
      workspace_id, scheduled_at, status, idempotency_key
    ) values (
      ${workspaceId}::uuid, ${scheduledAt.toISOString()}::timestamptz,
      'queued', ${key}
    ) on conflict (idempotency_key) do nothing
  `;
  const runRows = (await client`
    select id from public.canary_runs where idempotency_key = ${key} limit 1
  `) as unknown as Array<{ id: string }>;
  const run = runRows[0];
  if (!run) throw new Error("Canary record failed: no row");
  const criteria = CriteriaSchema.parse({
    automationMaturityMax: 100,
    opportunityPotentialMin: 0,
    confidenceMin: 0,
    minimumEvidenceCategories: 1,
  });
  await client`
    insert into public.scrape_jobs(
      workspace_id, source_id, target_url, status, priority, scheduled_for,
      idempotency_key, criteria_snapshot, max_attempts, canary_run_id
    ) values (
      ${workspaceId}::uuid, ${sourceId}::uuid, ${targetUrl}, 'queued', 100,
      ${scheduledAt.toISOString()}::timestamptz, ${key},
      ${JSON.stringify(criteria)}::jsonb, 3, ${run.id}::uuid
    ) on conflict (idempotency_key) do nothing
  `;
  const jobRows = (await client`
    select id, status from public.scrape_jobs where idempotency_key = ${key} limit 1
  `) as unknown as Array<{ id: string; status: string }>;
  const job = jobRows[0];
  if (!job) throw new Error("Canary job failed: no row");
  await client`
    update public.canary_runs set scrape_job_id = ${job.id}::uuid
    where id = ${run.id}::uuid
  `;
  return { canaryRunId: run.id, jobId: job.id, status: job.status };
}
