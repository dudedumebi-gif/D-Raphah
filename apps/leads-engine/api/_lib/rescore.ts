/**
 * Audited rescore capability (operator spec, 2026-10-13).
 *
 * Scoring happens once, at collection — so model rebuilds (scoring
 * 3.0.0), new evidence channels (the Job Bank market bridge), and
 * operator retunes (the Criteria sliders) never reached organizations
 * already assessed. This module recomputes scores from STORED
 * evidence — never a re-scrape:
 *
 *  - Signals are REUSED from the stored signal observations (the
 *    clinic's own excerpts and confidences are preserved verbatim);
 *    the only addition is the Job Bank market overlay for the
 *    clinic's evidenced city, refreshed per pass.
 *  - A rescore writes a NEW immutable assessment (the original stays
 *    as the audit record) via public.rescore_scrape_result, which
 *    also reconciles the opportunity idempotently and never deletes
 *    it (unqualifying marks status = 'unqualified').
 *  - Passes are fingerprinted (criteria + market snapshot + scoring
 *    version): re-running with identical inputs writes nothing.
 *  - A dry-run computes the same projections with no writes and
 *    reports projected qualifiers and the top 20 for human review
 *    before any threshold change.
 *
 * Geography comes from the collection-time determination stored on
 * the job result, falling back to the organization's city and then
 * to a text re-evaluation. Profile/contactability are re-derived
 * deterministically from the stored evidence text; freshness is
 * carried from collection (the evidence is not re-fetched).
 */
import { createHash } from "node:crypto";
import {
  CriteriaSchema,
  JOB_BANK_MARKET_SIGNAL_CODE,
  detectContactability,
  evaluateGeography,
  inferBusinessProfile,
  scoreSignals,
  type LeadCriteria,
  type DetectedSignal,
  type ScoreResult,
} from "./domain.js";
import {
  jobBankMarketSignal,
  lookupJobBankMarket,
  type JobBankMarket,
} from "./job-bank-market.js";

type SqlClient = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown>;

type SignalPolarity = DetectedSignal["polarity"];

function asPolarity(value: string): SignalPolarity {
  return value === "manual" || value === "automated" || value === "commercial"
    ? value
    : "commercial";
}

export interface StoredObservation {
  code: string;
  category: DetectedSignal["category"];
  polarity: string;
  strength: number;
  confidence: number;
  excerpt: string;
}

/**
 * The clinic's own signals, reused verbatim from storage. Any prior
 * market overlay is excluded: it is a scoring-time input, refreshed
 * by the current pass, never part of the clinic's evidence.
 */
export function reuseSignals(observations: StoredObservation[]): DetectedSignal[] {
  return observations
    .filter((row) => row.code !== JOB_BANK_MARKET_SIGNAL_CODE)
    .map((row) => ({
      code: row.code,
      category: row.category,
      polarity: asPolarity(row.polarity),
      strength: Number(row.strength),
      confidence: Number(row.confidence),
      excerpt: row.excerpt,
    }));
}

/** Stable fingerprint of everything that determines a rescore. */
export function rescoreFingerprint(
  criteria: LeadCriteria,
  marketSyncedAt: string | null,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        criteria,
        marketSyncedAt,
        scoringVersion: "3.0.0",
      }),
    )
    .digest("hex");
}

export interface RescoreOverrides {
  thresholdOverride?: number;
  strengthOverride?: number;
}

export function effectiveCriteria(
  criteriaInput: unknown,
  overrides: RescoreOverrides,
): LeadCriteria {
  const raw = (criteriaInput ?? {}) as Record<string, unknown>;
  return CriteriaSchema.parse({
    ...raw,
    ...(overrides.thresholdOverride != null
      ? { qualificationScoreMin: overrides.thresholdOverride }
      : {}),
    ...(overrides.strengthOverride != null
      ? { jobBankMarketStrength: overrides.strengthOverride }
      : {}),
  });
}

interface ScopeRow {
  id: string;
  scrape_job_id: string;
  evidence_artifact_id: string;
  current_score: number;
  current_qualified: boolean;
  rescore_fingerprint: string | null;
  current_intent: number | null;
  extracted_text: string;
  org_name: string;
  org_domain: string | null;
  org_city: string | null;
  job_result: {
    geography?: { city?: string | null; eligible?: boolean };
  } | null;
}

async function loadScope(
  client: SqlClient,
  args: { workspaceId: string; campaignId: string; sourceId: string },
): Promise<ScopeRow[]> {
  const rows = (await client`
    select distinct on (a.scrape_job_id)
      a.id, a.scrape_job_id, a.evidence_artifact_id,
      a.opportunity_score as current_score,
      a.qualified as current_qualified,
      a.rescore_fingerprint,
      (a.components->>'intent_trigger')::numeric as current_intent,
      e.extracted_text,
      o.name as org_name, o.normalized_domain as org_domain,
      o.city as org_city,
      j.result as job_result
    from public.maturity_assessments a
    join public.scrape_jobs j on j.id = a.scrape_job_id
    join public.evidence_artifacts e on e.id = a.evidence_artifact_id
    join public.organizations o on o.id = a.organization_id
    where a.workspace_id = ${args.workspaceId}
      and (j.campaign_id = ${args.campaignId}::uuid
        or (j.campaign_id is null and j.source_id = ${args.sourceId}::uuid))
    order by a.scrape_job_id, a.evaluated_at desc
  `) as unknown as ScopeRow[];
  return rows;
}

async function loadObservations(
  client: SqlClient,
  evidenceArtifactId: string,
): Promise<StoredObservation[]> {
  return (await client`
    select code, category, polarity, strength, confidence, excerpt
    from public.signal_observations
    where evidence_artifact_id = ${evidenceArtifactId}::uuid
    order by observed_at asc
  `) as unknown as StoredObservation[];
}

interface ComputedRescore {
  signals: DetectedSignal[];
  marketSignal: DetectedSignal | null;
  market: JobBankMarket | null;
  score: ScoreResult;
  fingerprint: string;
}

/** One assessment's recomputation. Pure given its inputs. */
export function computeRescore(args: {
  observations: StoredObservation[];
  text: string;
  criteria: LeadCriteria;
  market: JobBankMarket | null;
  geoEligible: boolean;
}): ComputedRescore {
  const signals = reuseSignals(args.observations);
  let marketSignal: DetectedSignal | null = null;
  if (args.market && args.criteria.jobBankMarketStrength > 0) {
    marketSignal = jobBankMarketSignal(
      args.market,
      args.criteria.jobBankMarketStrength,
    );
    signals.push(marketSignal);
  }
  const score = scoreSignals(signals, args.criteria, {
    businessProfile: inferBusinessProfile(args.text),
    geoEligible: args.geoEligible,
    evidenceFreshness: 100,
    contactability: detectContactability(args.text),
  });
  return {
    signals,
    marketSignal,
    market: args.market,
    score,
    fingerprint: rescoreFingerprint(
      args.criteria,
      args.market?.syncedAt ?? null,
    ),
  };
}

async function computeForRow(
  client: SqlClient,
  row: ScopeRow,
  criteria: LeadCriteria,
): Promise<ComputedRescore> {
  const text = row.extracted_text ?? "";
  const storedCity = row.job_result?.geography?.city ?? row.org_city ?? null;
  const city = storedCity ?? evaluateGeography(text, criteria, undefined).city;
  const geoEligible =
    row.job_result?.geography?.eligible ??
    evaluateGeography(text, criteria, undefined).eligible;
  const market =
    city && criteria.jobBankMarketStrength > 0
      ? await lookupJobBankMarket(client, city)
      : null;
  const observations = await loadObservations(client, row.evidence_artifact_id);
  return computeRescore({ observations, text, criteria, market, geoEligible });
}

export interface RescoreBatchResult {
  total: number;
  rescanned: number;
  alreadyCurrent: number;
  newlyQualified: number;
  unqualified: number;
  remaining: number;
}

/** One bounded batch of the real pass (fingerprint-skipping). */
export async function rescoreCampaignBatch(
  client: SqlClient,
  args: {
    workspaceId: string;
    campaignId: string;
    sourceId: string;
    criteriaInput: unknown;
    overrides: RescoreOverrides;
    limit: number;
  },
): Promise<RescoreBatchResult> {
  const criteria = effectiveCriteria(args.criteriaInput, args.overrides);
  const scope = await loadScope(client, args);
  let rescanned = 0;
  let alreadyCurrent = 0;
  let newlyQualified = 0;
  let unqualified = 0;
  let remaining = 0;
  for (const row of scope) {
    const computed = await computeForRow(client, row, criteria);
    if (row.rescore_fingerprint === computed.fingerprint) {
      alreadyCurrent += 1;
      continue;
    }
    if (rescanned >= args.limit) {
      remaining += 1;
      continue;
    }
    const payload = {
      signals: computed.signals,
      marketSignal: computed.marketSignal,
      criteria,
      score: computed.score,
      fingerprint: computed.fingerprint,
    };
    const result = (await client`
      select public.rescore_scrape_result(
        ${row.id}::uuid, ${JSON.stringify(payload)}::jsonb
      ) as result
    `) as unknown as Array<{ result: { qualified: boolean } }>;
    const qualifiedNow = result[0]?.result?.qualified ?? computed.score.qualified;
    if (qualifiedNow && !row.current_qualified) newlyQualified += 1;
    if (!qualifiedNow && row.current_qualified) unqualified += 1;
    rescanned += 1;
  }
  return {
    total: scope.length,
    rescanned,
    alreadyCurrent,
    newlyQualified,
    unqualified,
    remaining,
  };
}

export interface RescoreProjection {
  organization: string;
  domain: string | null;
  currentScore: number;
  projectedScore: number;
  currentQualified: boolean;
  projectedQualified: boolean;
  alreadyCurrent: boolean;
  intentBefore: number | null;
  intentAfter: number;
}

export interface RescoreDryRunResult {
  total: number;
  projectedQualified: number;
  newlyQualified: number;
  alreadyCurrent: number;
  threshold: number;
  marketStrength: number;
  top: RescoreProjection[];
}

/** Full-scope projection with NO writes — the human-review input. */
export async function dryRunRescore(
  client: SqlClient,
  args: {
    workspaceId: string;
    campaignId: string;
    sourceId: string;
    criteriaInput: unknown;
    overrides: RescoreOverrides;
  },
): Promise<RescoreDryRunResult> {
  const criteria = effectiveCriteria(args.criteriaInput, args.overrides);
  const scope = await loadScope(client, args);
  const projections: RescoreProjection[] = [];
  for (const row of scope) {
    const computed = await computeForRow(client, row, criteria);
    projections.push({
      organization: row.org_name,
      domain: row.org_domain,
      currentScore: row.current_score,
      projectedScore: computed.score.opportunityScore,
      currentQualified: row.current_qualified,
      projectedQualified: computed.score.qualified,
      alreadyCurrent: row.rescore_fingerprint === computed.fingerprint,
      intentBefore:
        row.current_intent != null ? Number(row.current_intent) : null,
      intentAfter: computed.score.components.intent_trigger,
    });
  }
  projections.sort((a, b) => b.projectedScore - a.projectedScore);
  return {
    total: projections.length,
    projectedQualified: projections.filter((p) => p.projectedQualified).length,
    newlyQualified: projections.filter(
      (p) => p.projectedQualified && !p.currentQualified,
    ).length,
    alreadyCurrent: projections.filter((p) => p.alreadyCurrent).length,
    threshold: criteria.qualificationScoreMin,
    marketStrength: criteria.jobBankMarketStrength,
    top: projections.slice(0, 20),
  };
}
