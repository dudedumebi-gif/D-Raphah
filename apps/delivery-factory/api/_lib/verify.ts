import { createHash, randomUUID } from "node:crypto";
import {
  FEEDBACK_SCHEMA_VERSION,
  HANDOFF_SCHEMA_VERSION,
  LeadEngineHandoffPackageSchema,
  canonicalJsonStringify,
  sha256CanonicalJson,
  verifyPackage,
  type DeliveryFeedbackEventV1,
  type LeadEngineHandoffPackage,
} from "@raphah/handoff-contract";
import type { DeliveryDb } from "./db.js";

/**
 * Intake verification for POST /api/intake.
 *
 * Verification order (deliberate — this fixes delivery-tool's ordering bug,
 * where the checksum was verified AFTER the idempotency check so a tampered
 * replay could be idempotent-accepted without revalidation):
 *   (a) timestamp within ±5 minutes, else 401
 *   (b) nonce unseen (reserved in used_nonces; conflict = replay), else 401
 *   (c) transport integrity (content-sha256 over raw body), then Ed25519
 *       signature + manifest checksum over the canonical bytes, else 401 —
 *       BEFORE any idempotency lookup, so tampered replays are rejected,
 *       never idempotent-accepted
 *   (d) Zod validation of LeadEngineHandoffPackage, else 400
 *   (e) Must-requirement baseline freeze rule, else 422
 *   (f) idempotency lookup: known key -> 200 replay; unknown -> insert, 201
 *
 * No inbox/project state changes on any verification failure. The single
 * intentional write before verification completes is the nonce reservation
 * in (b): it must happen for replay protection to work.
 */

const TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

export interface IntakeHttpRequest {
  method: string;
  origin: string | null;
  /** Header names lowercased. */
  headers: Record<string, string | undefined>;
  /** Exact raw request body bytes as text. */
  rawBody: string;
}

export interface IntakeEnv {
  publicKeyPem: string;
  allowedOrigins: string[];
  environment: "local" | "preview" | "test" | "production";
}

export interface IntakeResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export function readIntakeEnv(): IntakeEnv {
  const rawPublicKeyPem = process.env.LEAD_ENGINE_PUBLIC_KEY_PEM;
  // Vercel stores PEM blocks with literal "\n" sequences; convert to real
  // newlines so node:crypto can parse the key. Without this, every intake
  // signature verification throws and all handoffs are rejected with 401.
  const publicKeyPem = rawPublicKeyPem?.replace(/\\n/g, "\n");
  if (!publicKeyPem)
    throw new Error("Missing LEAD_ENGINE_PUBLIC_KEY_PEM environment variable");
  const allowedOrigins = (process.env.DELIVERY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const vercelEnv = process.env.VERCEL_ENV;
  const environment =
    vercelEnv === "production"
      ? "production"
      : vercelEnv === "preview"
        ? "preview"
        : (process.env.DELIVERY_ENVIRONMENT as IntakeEnv["environment"] | undefined) ??
          "local";
  return { publicKeyPem, allowedOrigins, environment };
}

/**
 * Restricted CORS: only origins on the DELIVERY_ALLOWED_ORIGINS allowlist get
 * CORS headers. Server-to-server calls (no Origin header, e.g. the Lead
 * Engine dispatcher) bypass the check. There is no wildcard.
 */
export function corsHeadersFor(
  origin: string | null,
  allowedOrigins: string[],
): Record<string, string> | null {
  if (origin === null) return {};
  if (allowedOrigins.includes(origin)) {
    return {
      "access-control-allow-origin": origin,
      vary: "Origin",
      "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
      "access-control-allow-headers":
        "content-type, x-raphah-signature, x-raphah-timestamp, x-raphah-nonce, idempotency-key, content-sha256",
      "access-control-max-age": "600",
    };
  }
  return null;
}

export interface BaselineViolation {
  code:
    | "EMPTY_REQUIREMENTS"
    | "MUST_REQUIREMENT_BLOCKED"
    | "MUST_REQUIREMENT_UNVALIDATED";
  message: string;
  field?: string;
}

/**
 * Must-requirement baseline freeze rule (repo house rule, AGENTS.md):
 * "No requirement baseline can freeze if any Must requirement has blocking
 * questions or is unvalidated."
 *
 * Interpretation enforced here:
 * - The baseline must exist and contain at least one requirement, otherwise
 *   there is nothing to freeze (EMPTY_REQUIREMENTS).
 * - A Must requirement freezes only when ALL of the following hold:
 *     1. blockingQuestions is empty (else MUST_REQUIREMENT_BLOCKED);
 *     2. status is "validated" (else MUST_REQUIREMENT_UNVALIDATED);
 *     3. humanValidatorId is present. Companion house rule: "No model
 *        suggested requirement becomes authoritative without an identified
 *        human validator (humanValidatorId)". A requirement with no human
 *        validator is therefore treated as model-suggested, i.e. as
 *        unvalidated for this check (MUST_REQUIREMENT_UNVALIDATED).
 * - Should/Could/Wont requirements never block the freeze.
 *
 * NOTE: the Lead Engine's current handoff builder emits an empty
 * requirementBaseline (requirements: []), so its packages are rejected here
 * with EMPTY_REQUIREMENTS until human-validated Must requirements flow
 * through. That is the intended gate, not a bug.
 */
export function checkBaselineFreeze(
  pkg: LeadEngineHandoffPackage,
): BaselineViolation[] {
  const violations: BaselineViolation[] = [];
  const requirements = pkg.requirementBaseline?.requirements ?? [];
  if (requirements.length === 0) {
    violations.push({
      code: "EMPTY_REQUIREMENTS",
      message: "Requirement baseline must contain at least one requirement.",
      field: "requirementBaseline.requirements",
    });
    return violations;
  }
  for (const requirement of requirements) {
    if (requirement.priority !== "must") continue;
    const field = `requirementBaseline.requirements.${requirement.id}`;
    if (requirement.blockingQuestions.length > 0) {
      violations.push({
        code: "MUST_REQUIREMENT_BLOCKED",
        message: `Must requirement ${requirement.code} has blocking questions.`,
        field,
      });
    }
    if (requirement.status !== "validated" || !requirement.humanValidatorId) {
      violations.push({
        code: "MUST_REQUIREMENT_UNVALIDATED",
        message:
          `Must requirement ${requirement.code} is not validated` +
          (requirement.humanValidatorId
            ? "."
            : " (no human validator: model-suggested requirements cannot become authoritative)."),
        field,
      });
    }
  }
  return violations;
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** The checksum/signature cover the package WITHOUT its manifestChecksum field. */
export function stripManifestChecksum(
  pkg: Record<string, unknown>,
): Record<string, unknown> {
  const { manifestChecksum: _omitted, ...rest } = pkg;
  return rest;
}

export function buildFeedbackEvent(input: {
  eventType: DeliveryFeedbackEventV1["eventType"];
  pkg: LeadEngineHandoffPackage;
  projectId?: string;
  details: Record<string, unknown>;
  environment: IntakeEnv["environment"];
}): DeliveryFeedbackEventV1 {
  const base = {
    eventId: randomUUID(),
    eventType: input.eventType,
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    occurredAt: new Date().toISOString(),
    producer: "delivery-factory" as const,
    environment: input.environment,
    correlationId: input.pkg.packageId,
    packageId: input.pkg.packageId,
    packageVersion: input.pkg.packageVersion,
    opportunityId: input.pkg.opportunityId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    details: input.details,
  };
  const manifestChecksum = sha256CanonicalJson(base);
  return { ...base, manifestChecksum };
}

export async function handleIntake(
  request: IntakeHttpRequest,
  db: DeliveryDb,
  env: IntakeEnv,
): Promise<IntakeResult> {
  const cors = corsHeadersFor(request.origin, env.allowedOrigins);
  if (request.method === "OPTIONS") {
    if (cors === null)
      return { status: 403, headers: {}, body: { error: "Origin not allowed" } };
    return { status: 204, headers: cors, body: null };
  }
  if (request.method !== "POST") {
    return {
      status: 405,
      headers: { ...cors, allow: "POST, OPTIONS" },
      body: { error: "Method not allowed" },
    };
  }
  if (cors === null) {
    return { status: 403, headers: {}, body: { error: "Origin not allowed" } };
  }
  const headers = cors;

  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.startsWith("application/json")) {
    return {
      status: 415,
      headers,
      body: { error: "Content-Type must be application/json" },
    };
  }

  const signature = request.headers["x-raphah-signature"];
  const timestampHeader = request.headers["x-raphah-timestamp"];
  const nonce = request.headers["x-raphah-nonce"];
  const idempotencyKey = request.headers["idempotency-key"];
  const contentSha256 = request.headers["content-sha256"];
  if (!signature || !timestampHeader || !nonce || !idempotencyKey || !contentSha256) {
    return {
      status: 401,
      headers,
      body: {
        error:
          "Missing required headers: x-raphah-signature, x-raphah-timestamp, x-raphah-nonce, idempotency-key, content-sha256",
      },
    };
  }

  // (a) Timestamp freshness.
  const timestampMs = Date.parse(timestampHeader);
  if (
    Number.isNaN(timestampMs) ||
    Math.abs(Date.now() - timestampMs) > TIMESTAMP_SKEW_MS
  ) {
    return {
      status: 401,
      headers,
      body: { error: "x-raphah-timestamp outside the ±5 minute window" },
    };
  }

  // (b) Nonce replay protection. Reserved BEFORE verification so a replayed
  // nonce can never be verified twice.
  const nonceFresh = await db.reserveNonce(nonce);
  if (!nonceFresh) {
    return {
      status: 401,
      headers,
      body: { error: "x-raphah-nonce already seen: replay rejected" },
    };
  }

  // (c) Transport integrity, then authenticity — BEFORE the idempotency
  // lookup, so tampered replays are rejected rather than idempotent-accepted.
  if (sha256Hex(request.rawBody) !== contentSha256.toLowerCase()) {
    return {
      status: 401,
      headers,
      body: { error: "content-sha256 does not match the request body" },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.rawBody);
  } catch {
    return { status: 400, headers, body: { error: "Invalid JSON body" } };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: 400, headers, body: { error: "JSON body must be an object" } };
  }
  const rawPackage = parsed as Record<string, unknown>;
  const manifestChecksum =
    typeof rawPackage.manifestChecksum === "string"
      ? rawPackage.manifestChecksum
      : "";
  const stripped = stripManifestChecksum(rawPackage);
  let authentic = false;
  try {
    authentic = verifyPackage(stripped, manifestChecksum, signature, env.publicKeyPem);
  } catch {
    authentic = false;
  }
  if (!authentic) {
    return {
      status: 401,
      headers,
      body: { error: "Ed25519 signature or manifest checksum verification failed" },
    };
  }

  // (d) Contract validation.
  const schemaParse = LeadEngineHandoffPackageSchema.safeParse(rawPackage);
  if (!schemaParse.success) {
    return {
      status: 400,
      headers,
      body: {
        error: "Handoff package failed contract validation",
        issues: schemaParse.error.issues.map((issue) => ({
          code: "SCHEMA_INVALID",
          message: issue.message,
          field: issue.path.join("."),
        })),
      },
    };
  }
  const pkg = schemaParse.data;

  // (e) Must-requirement baseline freeze rule.
  const baselineViolations = checkBaselineFreeze(pkg);
  if (baselineViolations.length > 0) {
    await db.enqueueFeedbackEvent({
      projectId: null,
      event: buildFeedbackEvent({
        eventType: "delivery.handoff.rejected",
        pkg,
        details: { rejectionReasons: baselineViolations },
        environment: env.environment,
      }),
    });
    return {
      status: 422,
      headers,
      body: {
        status: "rejected",
        packageId: pkg.packageId,
        packageVersion: pkg.packageVersion,
        rejectionReasons: baselineViolations,
      },
    };
  }

  // (f) Idempotency: a known key is a replay of an already-accepted package.
  const existing = await db.findInboxByIdempotencyKey(idempotencyKey);
  if (existing?.project_id) {
    return {
      status: 200,
      headers,
      body: {
        status: "accepted",
        projectId: existing.project_id,
        packageId: pkg.packageId,
        packageVersion: pkg.packageVersion,
        message: "Package already accepted (idempotent replay).",
      },
    };
  }

  const { project } = await db.createInboxAndProject({
    idempotencyKey,
    pkg,
    manifestChecksum,
    signature,
  });
  await db.enqueueFeedbackEvent({
    projectId: project.id,
    event: buildFeedbackEvent({
      eventType: "delivery.handoff.accepted",
      pkg,
      projectId: project.id,
      details: { idempotencyKey },
      environment: env.environment,
    }),
  });

  return {
    status: 201,
    headers,
    body: {
      status: "accepted",
      projectId: project.id,
      packageId: pkg.packageId,
      packageVersion: pkg.packageVersion,
      schemaVersion: HANDOFF_SCHEMA_VERSION,
      message: "Handoff package accepted.",
    },
  };
}
