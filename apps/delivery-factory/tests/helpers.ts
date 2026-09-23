import { createHash, randomUUID } from "node:crypto";
import {
  HANDOFF_SCHEMA_VERSION,
  canonicalJsonStringify,
  generateSigningKeyPair,
  signPackage,
  type LeadEngineHandoffPackage,
} from "@raphah/handoff-contract";
import type { IntakeEnv, IntakeHttpRequest } from "../api/_lib/verify.js";

/** Test signing keys, mirroring the Lead Engine sender's key pair. */
export const senderKeys = generateSigningKeyPair();
export const otherKeys = generateSigningKeyPair();

export function validRequirement(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: randomUUID(),
    opportunityId: randomUUID(),
    code: "REQ-001",
    statement: "The system must automate invoice reconciliation.",
    priority: "must",
    status: "validated",
    humanValidatorId: "human-validator-1",
    acceptanceCriteria: ["Reconciliation completes without manual steps"],
    blockingQuestions: [],
    ...overrides,
  };
}

export function packageBase(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const opportunityId = randomUUID();
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    packageId: randomUUID(),
    packageVersion: 1,
    opportunityId,
    organization: { name: "Acme Corp", domain: "acme.example" },
    stakeholders: [],
    problemStatement:
      "Acme Corp spends 40 hours weekly on manual invoice reconciliation.",
    currentState: [],
    requirementBaseline: {
      version: 1,
      requirements: [validRequirement({ opportunityId })],
      features: [],
    },
    constraints: [],
    risksAndAssumptions: [],
    successMeasures: [],
    commercialScope: { scopeSummary: "Automate invoice reconciliation" },
    supportingArtifacts: [],
    openItems: [],
    approvedBy: "operator@example.com",
    approvedAt: new Date().toISOString(),
    ...overrides,
  };
}

export interface SignedPackage {
  rawBody: string;
  manifestChecksum: string;
  signature: string;
  pkg: LeadEngineHandoffPackage;
}

/**
 * Signs exactly like the Lead Engine sender: the canonical bytes EXCLUDE
 * manifestChecksum; the checksum is attached afterwards.
 */
export function signTestPackage(
  base: Record<string, unknown> = packageBase(),
  privateKeyPem: string = senderKeys.privateKeyPem,
): SignedPackage {
  const { manifestChecksum, signature } = signPackage(base, privateKeyPem);
  const pkg = { ...base, manifestChecksum } as LeadEngineHandoffPackage;
  return {
    rawBody: canonicalJsonStringify(pkg),
    manifestChecksum,
    signature,
    pkg,
  };
}

export function intakeHeaders(
  signed: SignedPackage,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-raphah-signature": signed.signature,
    "x-raphah-timestamp": new Date().toISOString(),
    "x-raphah-nonce": randomUUID(),
    "idempotency-key": `test-${randomUUID()}`,
    "content-sha256": createHash("sha256")
      .update(signed.rawBody, "utf8")
      .digest("hex"),
    ...overrides,
  };
}

export function intakeRequest(
  signed: SignedPackage,
  headerOverrides: Record<string, string> = {},
  origin: string | null = null,
): IntakeHttpRequest {
  return {
    method: "POST",
    origin,
    headers: intakeHeaders(signed, headerOverrides),
    rawBody: signed.rawBody,
  };
}

export function testEnv(
  overrides: Partial<IntakeEnv> = {},
): IntakeEnv {
  return {
    publicKeyPem: senderKeys.publicKeyPem,
    allowedOrigins: ["https://ops.raphah.io"],
    environment: "test",
    ...overrides,
  };
}
