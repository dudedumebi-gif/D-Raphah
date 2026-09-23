import { createHash, randomUUID } from "node:crypto";
import {
  HANDOFF_SCHEMA_VERSION,
  LeadEngineHandoffPackageSchema,
  canonicalJsonStringify,
  loadKeysFromEnv,
  signPackage,
  type LeadEngineHandoffPackage,
} from "@raphah/handoff-contract";

/**
 * Minimal SQL client shape: the neon tagged-template returns rows directly.
 * Kept as a structural type so handoff logic is unit-testable with a stub.
 */
export type SqlClient = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

const MAX_DISPATCH_BATCH = 25;
const MAX_DISPATCH_ATTEMPTS = 10;
const MAX_BACKOFF_MINUTES = 360; // 6h cap
const DISPATCH_TIMEOUT_MS = 15_000;

/**
 * Delivery-side verification contract (for the future delivery-factory intake).
 *
 * The Lead Engine POSTs the canonical-JSON serialization of the package body
 * with these headers:
 *   content-type:       application/json
 *   x-raphah-signature:  Ed25519 signature (base64) over the canonical bytes
 *   idempotency-key:     stable per opportunity (`handoff:{workspace}:{opp}`)
 *   x-raphah-timestamp:  ISO-8601 dispatch time
 *   x-raphah-nonce:      random UUID, one per attempt
 *   content-sha256:      SHA-256 hex of the exact raw request body bytes
 *
 * The receiver MUST verify, in order:
 *   1. Transport integrity: SHA-256 hex of the raw body equals `content-sha256`.
 *   2. Package integrity: strip `manifestChecksum` from the parsed body, then
 *      recompute the SHA-256 canonical-JSON checksum over the remainder — it
 *      must equal `manifestChecksum` (this is the checksum the contract and
 *      delivery-tool's handoffReceiver both define).
 *   3. Authenticity: Ed25519-verify `x-raphah-signature` against the same
 *      canonical bytes (package WITHOUT `manifestChecksum`) using the Lead
 *      Engine's public key, distributed out of band — never inside the package.
 *   4. Replay protection: reject when `x-raphah-timestamp` is more than 5
 *      minutes from now, or when `x-raphah-nonce` was already seen; dedupe
 *      accepted packages on `idempotency-key` BEFORE re-verifying the checksum
 *      of an identical replay.
 */

interface OpportunityRow {
  id: string;
  title: string;
  opportunity_potential_score: number;
  automation_maturity_score: number;
  confidence: number;
  latest_assessment_id: string | null;
  primary_evidence_id: string | null;
  org_name: string;
  org_domain: string;
}

interface AssessmentRow {
  id: string;
  explanation: unknown;
  scoring_version: string;
  qualified: boolean;
  confidence: number;
}

interface EvidenceRow {
  id: string;
  canonical_url: string;
  content_type: string;
  content_hash: string;
}

interface SignalRow {
  code: string;
  category: string;
  excerpt: string;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function explanationSummary(explanation: unknown): string {
  if (typeof explanation === "string") return explanation.slice(0, 600);
  if (explanation && typeof explanation === "object") {
    const record = explanation as Record<string, unknown>;
    const summary = record.summary ?? record.explanation;
    if (typeof summary === "string") return summary.slice(0, 600);
  }
  return "";
}

/**
 * Builds a schema-valid LeadEngineHandoffPackage v1.0.0 from the workspace's
 * opportunity, assessment, and evidence records, then Ed25519-signs the
 * canonical bytes (excluding manifestChecksum, per the contract) with the
 * HANDOFF_SIGNING_* key pair.
 *
 * The package is human-approved: `approvedBy` must be the authenticated
 * operator who invoked POST /api/v1/handoffs. Requirement baselines are left
 * empty here — no model-suggested requirement becomes authoritative without
 * a human validator, per the repo's deterministic controls.
 */
export async function buildHandoffPackage(
  client: SqlClient,
  input: { workspaceId: string; opportunityId: string; approvedBy: string },
): Promise<{
  package: LeadEngineHandoffPackage;
  manifestChecksum: string;
  signature: string;
}> {
  if (!isUuid(input.workspaceId) || !isUuid(input.opportunityId)) {
    throw new Error("Invalid workspace or opportunity identifier");
  }
  const opportunityRows = (await client`
    select o.id, o.title, o.opportunity_potential_score, o.automation_maturity_score,
           o.confidence, o.latest_assessment_id, o.primary_evidence_id,
           org.name as org_name, org.normalized_domain as org_domain
    from public.opportunities o
    join public.organizations org on org.id = o.organization_id
    where o.id = ${input.opportunityId}::uuid
      and o.workspace_id = ${input.workspaceId}::uuid
  `) as unknown as OpportunityRow[];
  const opportunity = opportunityRows[0];
  if (!opportunity) throw new Error("Opportunity not found");

  let assessment: AssessmentRow | null = null;
  if (opportunity.latest_assessment_id) {
    const assessmentRows = (await client`
      select id, explanation, scoring_version, qualified, confidence
      from public.maturity_assessments
      where id = ${opportunity.latest_assessment_id}::uuid
        and workspace_id = ${input.workspaceId}::uuid
    `) as unknown as AssessmentRow[];
    assessment = assessmentRows[0] ?? null;
  }

  let evidence: EvidenceRow | null = null;
  let signals: SignalRow[] = [];
  if (opportunity.primary_evidence_id) {
    const evidenceRows = (await client`
      select id, canonical_url, content_type, content_hash
      from public.evidence_artifacts
      where id = ${opportunity.primary_evidence_id}::uuid
        and workspace_id = ${input.workspaceId}::uuid
    `) as unknown as EvidenceRow[];
    evidence = evidenceRows[0] ?? null;
    if (evidence) {
      signals = (await client`
        select code, category, excerpt
        from public.signal_observations
        where evidence_artifact_id = ${evidence.id}::uuid
          and workspace_id = ${input.workspaceId}::uuid
        order by strength desc
        limit 8
      `) as unknown as SignalRow[];
    }
  }

  const summary = assessment ? explanationSummary(assessment.explanation) : "";
  const problemStatement =
    `${opportunity.title}. Automation maturity ` +
    `${opportunity.automation_maturity_score}/100, opportunity potential ` +
    `${opportunity.opportunity_potential_score}/100 ` +
    `(confidence ${Number(opportunity.confidence).toFixed(2)}).` +
    (summary ? ` ${summary}` : "");

  const base = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    packageId: randomUUID(),
    packageVersion: 1,
    opportunityId: opportunity.id,
    organization: {
      name: opportunity.org_name,
      domain: opportunity.org_domain || undefined,
    },
    stakeholders: [],
    problemStatement,
    currentState: signals
      .filter((signal) => signal.code && signal.excerpt)
      .map((signal) => ({
        processName: signal.code,
        owner: undefined,
        painPoint: signal.excerpt.slice(0, 500),
      })),
    requirementBaseline: { version: 1, requirements: [], features: [] },
    constraints: [],
    risksAndAssumptions: [],
    successMeasures: [],
    commercialScope: {
      scopeSummary: `${opportunity.title} — qualified automation opportunity`,
    },
    supportingArtifacts:
      evidence &&
      /^https?:\/\//i.test(evidence.canonical_url) &&
      /^[a-f0-9]{64}$/.test(evidence.content_hash)
        ? [
            {
              artifactId: evidence.id,
              canonicalUrl: evidence.canonical_url,
              contentType: evidence.content_type,
              contentHash: evidence.content_hash,
            },
          ]
        : [],
    openItems: [],
    approvedBy: input.approvedBy,
    approvedAt: new Date().toISOString(),
  };

  const { privateKeyPem } = loadKeysFromEnv("HANDOFF_SIGNING");
  const { manifestChecksum, signature } = signPackage(base, privateKeyPem);
  const handoffPackage = LeadEngineHandoffPackageSchema.parse({
    ...base,
    manifestChecksum,
  });
  return { package: handoffPackage, manifestChecksum, signature };
}

export interface EnqueueHandoffInput {
  workspaceId: string;
  idempotencyKey: string;
  package: LeadEngineHandoffPackage;
  manifestChecksum: string;
  signature: string;
}

export interface EnqueuedHandoff {
  id: string;
  status: string;
}

/**
 * Thin wrapper around the enqueue_handoff_outbox RPC so the call contract
 * (function name, argument mapping, returned row) is unit-testable without a
 * database. The RPC itself enforces workspace role membership via
 * auth.user_id(), so it must be invoked through the authenticated user client.
 */
export async function enqueueHandoffOutbox(
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>,
  input: EnqueueHandoffInput,
): Promise<EnqueuedHandoff> {
  const { data, error } = await rpc("enqueue_handoff_outbox", {
    p_workspace_id: input.workspaceId,
    p_idempotency_key: input.idempotencyKey,
    p_package: input.package,
    p_checksum: input.manifestChecksum,
    p_signature: input.signature,
  });
  if (error) throw new Error(error.message);
  const row = data as EnqueuedHandoff | null;
  if (!row?.id) throw new Error("Handoff enqueue returned no row");
  return { id: row.id, status: row.status };
}

interface OutboxRow {
  id: string;
  workspace_id: string;
  idempotency_key: string;
  package: unknown;
  manifest_checksum: string;
  signature: string;
  attempts: number;
}

/**
 * Drains due handoff_outbox rows and POSTs each signed package to the
 * Delivery Factory intake. Never throws: per-row failures are retried with
 * exponential backoff (2^attempts minutes, capped at 6h) and the row is marked
 * failed after 10 attempts. When DELIVERY_INTAKE_URL is unset the rows are
 * left pending silently.
 */
export async function dispatchDueHandoffs(
  client: SqlClient,
): Promise<{ dispatched: number; failed: number }> {
  const outcome = { dispatched: 0, failed: 0 };
  const intakeUrl = process.env.DELIVERY_INTAKE_URL;
  if (!intakeUrl) return outcome;

  const rows = (await client`
    select id, workspace_id, idempotency_key, package, manifest_checksum,
           signature, attempts
    from public.handoff_outbox
    where (status = 'pending'
           or (status = 'dispatching'
               and updated_at < now() - interval '10 minutes'))
      and next_attempt_at <= now()
    order by created_at
    limit ${MAX_DISPATCH_BATCH}
  `) as unknown as OutboxRow[];

  for (const row of rows) {
    try {
      await client`
        update public.handoff_outbox
        set status = 'dispatching', updated_at = now()
        where id = ${row.id}::uuid
      `;
      const body = canonicalJsonStringify(row.package);
      const timestamp = new Date().toISOString();
      const nonce = randomUUID();
      const contentSha256 = createHash("sha256")
        .update(body, "utf8")
        .digest("hex");
      const response = await fetch(intakeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-raphah-signature": row.signature,
          "idempotency-key": row.idempotency_key,
          "x-raphah-timestamp": timestamp,
          "x-raphah-nonce": nonce,
          "content-sha256": contentSha256,
        },
        body,
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(
          `Delivery intake responded with status ${response.status}`,
        );
      }
      await client`
        update public.handoff_outbox
        set status = 'sent', dispatched_at = now(), last_error = null,
            updated_at = now()
        where id = ${row.id}::uuid
      `;
      outcome.dispatched += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      const exhausted = attempts >= MAX_DISPATCH_ATTEMPTS;
      const backoffMinutes = Math.min(
        2 ** attempts,
        MAX_BACKOFF_MINUTES,
      );
      const message =
        error instanceof Error ? error.message : String(error);
      await client`
        update public.handoff_outbox
        set status = ${exhausted ? "failed" : "pending"},
            attempts = ${attempts},
            next_attempt_at = now() + make_interval(mins => ${backoffMinutes}),
            last_error = ${message.slice(0, 2000)},
            updated_at = now()
        where id = ${row.id}::uuid
      `;
      outcome.failed += 1;
    }
  }
  return outcome;
}
