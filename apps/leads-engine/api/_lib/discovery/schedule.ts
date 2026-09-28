/**
 * Scheduled discovery loop (audit fix 1 of the discovery funnel).
 *
 * The discovery pipeline (Overpass sweep → dedupe by normalized URL →
 * auto-enqueue scrape jobs) existed but could only be triggered by the
 * manual POST /api/v1/discovery/sources/:id/run. This module is the
 * recurring counterpart: a QStash schedule hits
 * POST /api/v1/discovery/scheduled-run once a day, and each active
 * discovery source gets at most one run per 24 hours.
 *
 * Gates, in order, per source:
 *   1. Source row is active.
 *   2. No discovery run started in the last 24h (conservative daily cadence).
 *   3. Overpass/OSM terms accepted for the workspace (audit gap 2) — a
 *      missing acceptance skips the source with a warning, it never fails
 *      the sweep.
 *   4. The borrowed collection source is still approved and active — the
 *      same check queue_scrape_job enforces. Approval can be revoked after
 *      the discovery source was registered; the scheduler re-verifies.
 *
 * Job enqueueing replicates queue_scrape_job's validation because that RPC
 * requires a human session (has_workspace_role(auth.user_id())); the
 * scheduler is a trusted system actor like the worker tick. The
 * deterministic idempotency key (discovery:<source>:<normalized-url>) makes
 * re-runs safe: a candidate already enqueued is never duplicated.
 */

import { log } from "../telemetry.js";
import { OverpassAdapter } from "./overpass.js";
import {
  runDiscoveryRun,
  type DiscoverySourceRow,
  type DiscoveryStore,
  type QueuedJob,
  type RunOutcome,
} from "./run.js";
import {
  OVERPASS_OSM_TERMS_ID,
  requireTermsAcceptance,
} from "./terms.js";

export type ScheduleSqlClient = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

const RUN_INTERVAL_HOURS = 24;

interface SourceRow {
  id: string;
  workspace_id: string;
  name: string;
  adapter_id: string;
  geo_params: unknown;
  source_id: string;
  campaign_id: string | null;
  active: boolean;
}

function toDiscoverySourceRow(row: SourceRow): DiscoverySourceRow {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    adapter_id: row.adapter_id,
    geo_params: row.geo_params,
    source_id: row.source_id,
    campaign_id: row.campaign_id,
    active: row.active,
  };
}

/** queue_scrape_job's approval check, without the human-session requirement. */
async function assertCollectionSourceApproved(
  client: ScheduleSqlClient,
  workspaceId: string,
  sourceId: string,
): Promise<void> {
  const rows = (await client`
    select 1 from public.source_definitions s
    join public.source_policy_versions p on p.id = s.active_policy_id
    where s.id = ${sourceId}::uuid
      and s.workspace_id = ${workspaceId}::uuid
      and s.status = 'active'
      and p.status = 'approved'
      and p.approved_by is not null
    limit 1
  `) as unknown as Array<{ "?column?": number }>;
  if (rows.length === 0)
    throw Object.assign(
      new Error("Borrowed collection source is not approved and active"),
      { statusCode: 409 },
    );
}

function buildStore(client: ScheduleSqlClient): DiscoveryStore {
  return {
    getSource: async (discoverySourceId: string) => {
      const rows = (await client`
        select id, workspace_id, name, adapter_id, geo_params, source_id,
               campaign_id, active
        from public.discovery_sources
        where id = ${discoverySourceId}::uuid
        limit 1
      `) as unknown as SourceRow[];
      return rows[0] ? toDiscoverySourceRow(rows[0]) : null;
    },
    createRun: async (discoverySourceId: string) => {
      const source = (await client`
        select workspace_id from public.discovery_sources
        where id = ${discoverySourceId}::uuid limit 1
      `) as unknown as Array<{ workspace_id: string }>;
      const rows = (await client`
        insert into public.discovery_runs(
          workspace_id, discovery_source_id, status
        ) values (
          ${source[0].workspace_id}::uuid, ${discoverySourceId}::uuid, 'running'
        )
        returning id, started_at
      `) as unknown as Array<{ id: string; started_at: string }>;
      return { id: rows[0].id, startedAt: rows[0].started_at };
    },
    finishRun: async (runId: string, outcome: RunOutcome) => {
      await client`
        update public.discovery_runs set
          status = ${outcome.status},
          finished_at = now(),
          candidates_found = ${outcome.candidatesFound},
          candidates_enqueued = ${outcome.candidatesEnqueued},
          error = ${outcome.error}
        where id = ${runId}::uuid
      `;
    },
    listExistingTargets: async (sourceId: string) => {
      const rows = (await client`
        select target_url, idempotency_key
        from public.scrape_jobs
        where source_id = ${sourceId}::uuid
      `) as unknown as Array<{ target_url: string; idempotency_key: string }>;
      return rows;
    },
    queueJob: async ({ sourceId, targetUrl, key, maxAttempts }) => {
      const jobRows = (await client`
        select workspace_id from public.source_definitions
        where id = ${sourceId}::uuid limit 1
      `) as unknown as Array<{ workspace_id: string }>;
      const workspaceId = jobRows[0]?.workspace_id;
      if (!workspaceId) throw new Error("Collection source not found");
      await assertCollectionSourceApproved(client, workspaceId, sourceId);
      // Mirrors queue_scrape_job: derive the campaign, snapshot its
      // criteria, dedupe on the idempotency key.
      const inserted = (await client`
        insert into public.scrape_jobs(
          workspace_id, source_id, campaign_id, target_url, idempotency_key,
          criteria_snapshot, max_attempts, created_by
        )
        select ${workspaceId}::uuid, ${sourceId}::uuid, sc.id, ${targetUrl},
               ${key}, coalesce(sc.criteria, '{}'::jsonb), ${maxAttempts},
               'discovery-scheduler'
        from (select 1) one
        left join lateral (
          select id, criteria from public.scrape_campaigns
          where source_id = ${sourceId}::uuid
            and workspace_id = ${workspaceId}::uuid
          limit 1
        ) sc on true
        on conflict (idempotency_key) do nothing
        returning id, created_at
      `) as unknown as Array<{ id: string; created_at: string }>;
      if (inserted[0]) return { id: inserted[0].id, createdAt: inserted[0].created_at } satisfies QueuedJob;
      const existing = (await client`
        select id, created_at from public.scrape_jobs
        where idempotency_key = ${key}
          and workspace_id = ${workspaceId}::uuid
        limit 1
      `) as unknown as Array<{ id: string; created_at: string }>;
      if (!existing[0]) throw new Error("Discovery job enqueue failed");
      return { id: existing[0].id, createdAt: existing[0].created_at };
    },
  };
}

export interface ScheduledDiscoveryResult {
  checked: number;
  ran: number;
  skipped: number;
  enqueued: number;
  errors: Array<{ sourceId: string; error: string }>;
}

/**
 * Run one discovery pass per active discovery source, at most once per
 * 24h per source. Failure-isolated per source: one bad source never fails
 * the sweep.
 */
export async function runScheduledDiscovery(
  client: ScheduleSqlClient,
): Promise<ScheduledDiscoveryResult> {
  const result: ScheduledDiscoveryResult = {
    checked: 0,
    ran: 0,
    skipped: 0,
    enqueued: 0,
    errors: [],
  };
  const sources = (await client`
    select id, workspace_id, name, adapter_id, geo_params, source_id,
           campaign_id, active
    from public.discovery_sources
    where active
    order by created_at
  `) as unknown as SourceRow[];
  const store = buildStore(client);
  const adapters = { overpass: new OverpassAdapter() };

  for (const source of sources) {
    result.checked += 1;
    try {
      const recent = (await client`
        select 1 from public.discovery_runs
        where discovery_source_id = ${source.id}::uuid
          and started_at > now() - ${RUN_INTERVAL_HOURS} * interval '1 hour'
        limit 1
      `) as unknown as Array<unknown>;
      if (recent.length > 0) {
        result.skipped += 1;
        continue;
      }
      // Terms gate (audit gap 2): skip loudly, never fail the sweep.
      try {
        await requireTermsAcceptance(
          {
            hasAccepted: async (workspaceId: string, termsId: string) => {
              const rows = (await client`
                select 1 from public.terms_acceptances
                where workspace_id = ${workspaceId}::uuid
                  and terms_id = ${termsId}
                limit 1
              `) as unknown as Array<unknown>;
              return rows.length > 0;
            },
          },
          source.workspace_id,
          OVERPASS_OSM_TERMS_ID,
        );
      } catch (error) {
        log("warn", "discovery_skipped_terms_not_accepted", {
          discoverySourceId: source.id,
          workspaceId: source.workspace_id,
        });
        result.skipped += 1;
        continue;
      }
      await assertCollectionSourceApproved(
        client,
        source.workspace_id,
        source.source_id,
      );
      const summary = await runDiscoveryRun({
        store,
        adapters,
        discoverySourceId: source.id,
      });
      result.ran += 1;
      result.enqueued += summary.candidatesEnqueued;
      log("info", "scheduled_discovery_run", {
        discoverySourceId: source.id,
        runId: summary.runId,
        candidatesEnqueued: summary.candidatesEnqueued,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push({ sourceId: source.id, error: message });
      log("error", "scheduled_discovery_source_failed", {
        discoverySourceId: source.id,
        error: message,
      });
    }
  }
  return result;
}
