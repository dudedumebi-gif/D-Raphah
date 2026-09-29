import { log } from "../telemetry.js";
import {
  DiscoveryGeoInputSchema,
  DiscoveryUpstreamError,
  normalizeWebsiteUrl,
  resolveGeoQuery,
  type Candidate,
  type DiscoveryAdapter,
  type FetchCandidatesOptions,
} from "./adapter.js";
import { normalizedIdentity } from "./csv.js";

/** Discovery source row as read from public.discovery_sources. */
export interface DiscoverySourceRow {
  id: string;
  workspace_id: string;
  name: string;
  adapter_id: string;
  geo_params: unknown;
  adapter_config?: unknown;
  data_mode?: "demo" | "pilot" | "production";
  source_id: string;
  campaign_id: string | null;
  active: boolean;
}

export interface QueuedJob {
  id: string;
  createdAt: string;
}

export interface RunOutcome {
  status: "completed" | "failed";
  candidatesFound: number;
  candidatesEnqueued: number;
  candidatesPersisted?: number;
  candidatesUnresolved?: number;
  error: string | null;
}

export interface DiscoveryRunSummary extends RunOutcome {
  runId: string;
  skippedNoWebsite: number;
  skippedDuplicate: number;
}

export interface PersistedCandidate {
  id: string;
  resolvedWebsite: string | null;
  resolutionStatus:
    "direct" | "matched" | "review_required" | "unresolved" | "rejected";
  duplicate: boolean;
}

/**
 * Storage seam for discovery runs. The router implements this against the
 * authenticated data client; tests inject an in-memory fake. Enqueueing goes
 * through the existing queue_scrape_job RPC so the normal collection
 * pipeline (leases, retries, evidence, scoring) picks the jobs up unchanged.
 */
export interface DiscoveryStore {
  getSource(discoverySourceId: string): Promise<DiscoverySourceRow | null>;
  createRun(
    discoverySourceId: string,
  ): Promise<{ id: string; startedAt: string }>;
  finishRun(runId: string, outcome: RunOutcome): Promise<void>;
  /** Persist every upstream record, including candidates without websites. */
  upsertCandidate?(args: {
    runId: string;
    source: DiscoverySourceRow;
    candidate: Candidate;
    externalId: string;
    identityKey: string;
  }): Promise<PersistedCandidate>;
  listExistingTargets(
    sourceId: string,
  ): Promise<Array<{ target_url: string; idempotency_key: string }>>;
  queueJob(args: {
    sourceId: string;
    targetUrl: string;
    key: string;
    maxAttempts: number;
    candidateId?: string;
    dataMode?: "demo" | "pilot" | "production";
  }): Promise<QueuedJob>;
}

/** Upper bound on candidates processed per run (fair-use + queue hygiene). */
export const MAX_CANDIDATES_PER_RUN = 200;

export interface RunDiscoveryArgs {
  store: DiscoveryStore;
  adapters: Record<string, DiscoveryAdapter>;
  discoverySourceId: string;
  maxCandidates?: number;
  fetcher?: FetchCandidatesOptions["fetcher"];
}

/**
 * Execute one discovery run: fetch candidates from the source's adapter,
 * keep only candidates with a usable website, dedupe by normalized URL
 * against already-enqueued scrape targets and within the run, then enqueue
 * the remainder as scrape jobs via the existing creation path. The run row
 * records the outcome; the campaign link comes from the source row (and
 * queue_scrape_job also derives campaign_id from the collection source).
 */
export async function runDiscoveryRun(
  args: RunDiscoveryArgs,
): Promise<DiscoveryRunSummary> {
  const { store, adapters, discoverySourceId } = args;
  const maxCandidates = args.maxCandidates ?? MAX_CANDIDATES_PER_RUN;

  const source = await store.getSource(discoverySourceId);
  if (!source)
    throw Object.assign(new Error("Discovery source not found"), {
      statusCode: 404,
    });
  if (!source.active)
    throw Object.assign(new Error("Discovery source is not active"), {
      statusCode: 409,
    });
  const adapter = adapters[source.adapter_id];
  if (!adapter)
    throw Object.assign(
      new Error(`Unknown discovery adapter: ${source.adapter_id}`),
      { statusCode: 422 },
    );
  const geo = resolveGeoQuery(DiscoveryGeoInputSchema.parse(source.geo_params));

  const run = await store.createRun(source.id);
  const summary: DiscoveryRunSummary = {
    runId: run.id,
    status: "completed",
    candidatesFound: 0,
    candidatesEnqueued: 0,
    candidatesPersisted: 0,
    candidatesUnresolved: 0,
    skippedNoWebsite: 0,
    skippedDuplicate: 0,
    error: null,
  };

  try {
    const raw = await adapter.fetchCandidates(geo, {
      fetcher: args.fetcher,
      config: source.adapter_config,
      maxCandidates,
    });
    summary.candidatesFound = raw.slice(0, maxCandidates).length;
    const withWebsite: Array<{
      candidate: Candidate;
      candidateId?: string;
      normalized: string;
    }> = [];
    for (const [index, candidate] of raw.slice(0, maxCandidates).entries()) {
      const candidateName =
        candidate.name?.trim() ||
        `Unnamed ${candidate.source} candidate ${candidate.externalId ?? index + 1}`;
      const normalizedCandidate = { ...candidate, name: candidateName };
      const identityKey =
        normalizedIdentity(candidateName, candidate.address) ||
        `${candidate.source}:${candidate.externalId ?? index}`;
      const externalId = candidate.externalId ?? identityKey;
      const persisted = store.upsertCandidate
        ? await store.upsertCandidate({
            runId: run.id,
            source,
            candidate: normalizedCandidate,
            externalId,
            identityKey,
          })
        : {
            id: "",
            resolvedWebsite: normalizedCandidate.website,
            resolutionStatus: normalizedCandidate.website
              ? ("direct" as const)
              : ("unresolved" as const),
            duplicate: false,
          };
      summary.candidatesPersisted = (summary.candidatesPersisted ?? 0) + 1;
      const normalized = persisted.resolvedWebsite
        ? normalizeWebsiteUrl(persisted.resolvedWebsite)
        : null;
      if (!normalized) {
        summary.skippedNoWebsite += 1;
        summary.candidatesUnresolved = (summary.candidatesUnresolved ?? 0) + 1;
        continue;
      }
      withWebsite.push({
        candidate: {
          ...normalizedCandidate,
          website: persisted.resolvedWebsite,
        },
        candidateId: persisted.id || undefined,
        normalized,
      });
    }

    // Within-run dedupe by normalized URL.
    const seen = new Set<string>();
    const uniques: Array<{
      candidate: Candidate;
      candidateId?: string;
      normalized: string;
    }> = [];
    for (const item of withWebsite) {
      if (seen.has(item.normalized)) {
        summary.skippedDuplicate += 1;
        continue;
      }
      seen.add(item.normalized);
      uniques.push(item);
    }

    // Dedupe against already-enqueued/known scrape targets for the
    // collection source behind this discovery source.
    const existing = await store.listExistingTargets(source.source_id);
    const existingUrls = new Set(
      existing
        .map((row) => normalizeWebsiteUrl(row.target_url))
        .filter((value): value is string => value !== null),
    );
    const existingKeys = new Set(existing.map((row) => row.idempotency_key));

    for (const { candidate, candidateId, normalized } of uniques) {
      // Deterministic idempotency key: a re-run of the same discovery
      // source never creates a duplicate job for the same website.
      const key = `discovery:${source.data_mode ?? "pilot"}:${source.source_id}:${normalized}`;
      if (existingUrls.has(normalized) || existingKeys.has(key)) {
        summary.skippedDuplicate += 1;
        continue;
      }
      const queued = await store.queueJob({
        sourceId: source.source_id,
        targetUrl: candidate.website as string,
        key,
        maxAttempts: 3,
        candidateId,
        dataMode: source.data_mode ?? "pilot",
      });
      // queue_scrape_job returns the pre-existing row when the key was
      // already used; only count jobs actually created by this run.
      if (
        new Date(queued.createdAt).getTime() >=
        new Date(run.startedAt).getTime()
      ) {
        summary.candidatesEnqueued += 1;
        existingKeys.add(key);
        existingUrls.add(normalized);
      } else {
        summary.skippedDuplicate += 1;
      }
    }

    await store.finishRun(run.id, {
      status: "completed",
      candidatesFound: summary.candidatesFound,
      candidatesEnqueued: summary.candidatesEnqueued,
      candidatesPersisted: summary.candidatesPersisted,
      candidatesUnresolved: summary.candidatesUnresolved,
      error: null,
    });
    log("info", "discovery_run_completed", {
      runId: run.id,
      discoverySourceId: source.id,
      adapterId: source.adapter_id,
      candidatesFound: summary.candidatesFound,
      candidatesEnqueued: summary.candidatesEnqueued,
      skippedNoWebsite: summary.skippedNoWebsite,
      skippedDuplicate: summary.skippedDuplicate,
    });
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.finishRun(run.id, {
      status: "failed",
      candidatesFound: summary.candidatesFound,
      candidatesEnqueued: summary.candidatesEnqueued,
      error: message,
    });
    log("error", "discovery_run_failed", {
      runId: run.id,
      discoverySourceId: source.id,
      adapterId: source.adapter_id,
      error: message,
    });
    if (error instanceof DiscoveryUpstreamError) throw error;
    throw Object.assign(new Error(message), {
      statusCode:
        (error as { statusCode?: number }).statusCode !== undefined
          ? (error as { statusCode?: number }).statusCode
          : 500,
    });
  }
}
