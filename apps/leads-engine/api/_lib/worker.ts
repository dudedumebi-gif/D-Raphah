import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { collectUrl, type CollectionPolicy } from "./collection.js";
import {
  CriteriaSchema,
  detectContactability,
  detectSignals,
  evaluateGeography,
  inferBusinessProfile,
  retryDelaySeconds,
  scoreSignals,
} from "./domain.js";
import { truncateToByteLength } from "@raphah/handoff-contract";
import { createAdminClient } from "./neon.js";
import { dispatchDueHandoffs, type SqlClient } from "./handoff.js";
import {
  jobBankMarketSignal,
  jobBankMarketSyncStale,
  jobBankSourceApproved,
  lookupJobBankMarket,
  syncJobBankMarketSignals,
} from "./job-bank-market.js";
import { checkOperationalAlerts } from "./alerts.js";
import { sanitizePayloadStrings } from "./sanitize.js";
import { log, reportError } from "./telemetry.js";

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
  discovery_candidate_id?: string | null;
  data_mode?: "demo" | "pilot" | "production";
}

export interface DiscoveryCandidateEvidenceRow {
  name: string;
  evidence_text: string;
  source_url: string;
  source_observed_at: string;
  raw_record: unknown;
}

export function mergeDiscoveryEvidence(
  collectedText: string,
  discoveryEvidence?: DiscoveryCandidateEvidenceRow,
): string {
  return [
    collectedText,
    discoveryEvidence?.evidence_text
      ? `\nStructured discovery evidence (${discoveryEvidence.source_url}, observed ${discoveryEvidence.source_observed_at}):\n${discoveryEvidence.evidence_text}`
      : "",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
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
  allow_discovered_domains: boolean;
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
  alertsEmitted: number;
  prunedOperationalRows: number;
  jobBankCitiesSynced: number;
}

export function allowedDomainsForJob(
  row: Pick<PolicyRow, "allowed_domains" | "allow_discovered_domains">,
  job: Pick<ScrapeJobRow, "target_url" | "discovery_candidate_id">,
): string[] {
  const allowed = new Set(
    row.allowed_domains.map((domain) => domain.toLowerCase()),
  );
  if (row.allow_discovered_domains && job.discovery_candidate_id) {
    const hostname = new URL(job.target_url).hostname.toLowerCase();
    allowed.add(hostname);
    if (hostname.startsWith("www.")) allowed.add(hostname.slice(4));
  }
  return [...allowed];
}

function collectionPolicy(row: PolicyRow, job: ScrapeJobRow): CollectionPolicy {
  return {
    allowedDomains: allowedDomainsForJob(row, job),
    allowlistPaths: row.allowlist_paths,
    denylistPaths: row.denylist_paths,
    userAgent: row.user_agent,
    contactEmail: row.contact_email,
    rateLimitRps: row.rate_limit_rps,
    maxBytes: row.max_bytes,
    timeoutMs: row.timeout_ms,
    respectRobots: row.respect_robots,
    collectionMethod: row.collection_method,
    // Same envelope allowedDomainsForJob admits the job's own host under:
    // the owner's discovered-domains flag + a discovery-linked job. Only
    // inside it may redirect hops leave the approved domain set.
    allowDiscoveredDomains: Boolean(
      row.allow_discovered_domains && job.discovery_candidate_id,
    ),
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
  const discoveryEvidence = job.discovery_candidate_id
    ? (
        (await client`
        select name, evidence_text, source_url, source_observed_at, raw_record
        from public.discovery_candidates
        where id = ${job.discovery_candidate_id}::uuid
          and workspace_id = ${job.workspace_id}::uuid
        limit 1
      `) as unknown as DiscoveryCandidateEvidenceRow[]
      )[0]
    : undefined;
  const combinedExtractedText = mergeDiscoveryEvidence(
    collected.extractedText,
    discoveryEvidence,
  );
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
    extracted_organization:
      collected.extractedOrganization || discoveryEvidence?.name || null,
    extracted_text: truncateToByteLength(combinedExtractedText, 100_000),
    fetched_at: collected.fetchedAt,
    parser_version: discoveryEvidence
      ? "html-text+structured-discovery-1.0.0"
      : "html-text-1.0.0",
    policy_version_id: policy.id,
    robots_decision: collected.robotsDecision,
    response_status: collected.statusCode,
  };
  const signals = detectSignals(combinedExtractedText);
  const { domain, fallbackName } = organizationFromUrl(collected.finalUrl);
  const criteria = CriteriaSchema.parse(job.criteria_snapshot ?? {});
  const geography = evaluateGeography(
    combinedExtractedText,
    criteria,
    collected.coordinates,
  );
  // Job Bank market-intent bridge: when the clinic's market is actively
  // hiring for clinic front-desk roles, add ONE synthetic signal whose
  // strength is the campaign's operator-tuned jobBankMarketStrength.
  // The evidence is market-level and inferential (Job Bank open data
  // withholds employer identity); its excerpt says so verbatim. The
  // lookup is fail-soft — no snapshot, no signal. The city must be
  // EVIDENCED by the clinic's own geography evaluation — never the
  // campaign's configured targets, which would credit a clinic with a
  // market it was never shown to be in.
  const marketCity = geography.city;
  if (
    marketCity &&
    criteria.jobBankMarketStrength > 0 &&
    (await jobBankSourceApproved(client))
  ) {
    const market = await lookupJobBankMarket(client, marketCity);
    if (market) {
      signals.push(
        jobBankMarketSignal(market, criteria.jobBankMarketStrength),
      );
    }
  }
  const score = scoreSignals(signals, criteria, {
    businessProfile: inferBusinessProfile(combinedExtractedText),
    geoEligible: geography.eligible,
    evidenceFreshness: 100,
    contactability: detectContactability(combinedExtractedText),
  });
  const payload = {
    evidence: evidenceInsert,
    signals,
    criteria,
    geography,
    score,
    organization: {
      domain,
      name:
        collected.extractedOrganization ||
        discoveryEvidence?.name ||
        fallbackName,
      website: new URL(collected.finalUrl).origin,
    },
  };
  const persisted = (await client`
    select public.persist_scrape_result(
      ${job.id}::uuid,
      ${workerId},
      ${JSON.stringify(sanitizePayloadStrings(payload))}::jsonb
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
  let attemptNumber = job.attempt_count;
  try {
    const reservations = (await client`
      select public.reserve_source_collection(
        ${job.id}::uuid, ${workerId}, ${new Date().toISOString()}::timestamptz
      ) as reserved
    `) as unknown as Array<{ reserved: boolean }>;
    if (!reservations[0]?.reserved)
      throw new Error("Collection reservation was not granted");
    const attemptRows = (await client`
      select public.start_scrape_attempt(${job.id}::uuid, ${workerId}) as attempt_number
    `) as unknown as Array<{ attempt_number: number }>;
    attemptNumber = Number(attemptRows[0]?.attempt_number ?? 0);
    const { source, policy } = await loadSource(client, job);
    const collected = await collectUrl(
      job.target_url,
      collectionPolicy(policy, job),
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
    alertsEmitted: 0,
    prunedOperationalRows: 0,
    jobBankCitiesSynced: 0,
  };
  const now = new Date().toISOString();
  // The alert/incident reconcile runs FIRST, before this tick refreshes
  // the worker heartbeat: evaluating after the heartbeat write would
  // erase any outage gap (a resumed tick would see its own fresh
  // heartbeat and worker_stale could never open — Codex P1 on PR #64).
  // The reconcile is failure-isolated: Slack or alert persistence can
  // never fail the worker tick or a lead pipeline result. Dead-letter
  // and p95 conditions therefore reflect state as of the previous tick.
  try {
    const sql = client as unknown as Parameters<typeof checkOperationalAlerts>[0];
    result.alertsEmitted = await checkOperationalAlerts(sql);
  } catch (error) {
    log("error", "alert_tick_failed", { workerId });
    await reportError(error, { workerId });
  }
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
      ${["static_html", "api", "rss", "sitemap", "json", "xml"]}, 20,
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
  const prunedRows = (await client`
    select public.prune_operational_history(${now}::timestamptz) as count
  `) as unknown as Array<{ count: number }>;
  result.prunedOperationalRows = Number(prunedRows[0]?.count ?? 0);
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
  // Job Bank market snapshot: refresh at most daily (the source files
  // are monthly), and ONLY while the source gate holds — an active Job
  // Bank discovery source with a human-approved collection policy and
  // accepted Open Government Licence terms (the same gate discovery
  // runs enforce; without it the dataset is not collected at all).
  // Failure-isolated — a CKAN outage, a slow download, or the snapshot
  // table not existing yet must never fail the tick; the scoring-side
  // lookup is likewise fail-soft.
  try {
    if (await jobBankMarketSyncStale(client, new Date(now))) {
      if (await jobBankSourceApproved(client)) {
        result.jobBankCitiesSynced = await syncJobBankMarketSignals(
          client,
          fetch,
          new Date(now),
        );
      } else {
        log("info", "job_bank_market_sync_skipped_unapproved", { workerId });
      }
    }
  } catch (error) {
    log("error", "job_bank_market_sync_failed", { workerId });
  }
  const jobs = (await client`
    select * from public.lease_scrape_jobs(
      ${workerId}, 20, 240, ${now}::timestamptz
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
