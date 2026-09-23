import { describe, expect, it } from "vitest";
import {
  HANDOFF_SCHEMA_VERSION,
  LeadEngineHandoffPackageV1Schema,
  canonicalJsonStringify,
  sha256CanonicalJson,
  verifyCanonicalSha256,
} from "./index.js";

describe("canonical JSON", () => {
  it("produces the same representation independent of object key order", () => {
    const first = { z: 1, a: { y: true, b: "value" } };
    const second = { a: { b: "value", y: true }, z: 1 };

    expect(canonicalJsonStringify(first)).toBe(canonicalJsonStringify(second));
    expect(sha256CanonicalJson(first)).toBe(sha256CanonicalJson(second));
  });

  it("verifies lowercase SHA-256 hashes and rejects altered content", () => {
    const value = { packageId: "p-1", version: 1 };
    const hash = sha256CanonicalJson(value);

    expect(verifyCanonicalSha256(value, hash)).toBe(true);
    expect(verifyCanonicalSha256({ ...value, version: 2 }, hash)).toBe(false);
  });
});

describe("handoff schema v1", () => {
  const validPackage = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    packageId: "11111111-1111-1111-1111-111111111111",
    packageVersion: 1,
    opportunityId: "22222222-2222-2222-2222-222222222222",
    organization: { name: "Acme" },
    stakeholders: [{ name: "Jane", role: "Sponsor" }],
    problemStatement: "A sufficiently detailed client problem.",
    currentState: [
      { processName: "Manual intake", painPoint: "Slow response" },
    ],
    requirementBaseline: {
      version: 1,
      requirements: [
        {
          id: "req-1",
          opportunityId: "22222222-2222-2222-2222-222222222222",
          code: "REQ-1",
          statement: "System must capture approved opportunities.",
          priority: "must",
          status: "validated",
          acceptanceCriteria: ["Approved record is retained"],
          blockingQuestions: [],
        },
      ],
      features: [],
    },
    constraints: [],
    risksAndAssumptions: [],
    successMeasures: [],
    commercialScope: { scopeSummary: "Initial delivery" },
    supportingArtifacts: [],
    openItems: [],
    approvedBy: "owner-1",
    approvedAt: "2026-09-17T12:00:00.000Z",
    manifestChecksum: "a".repeat(64),
  };

  it("accepts a valid version 1 package", () => {
    expect(
      LeadEngineHandoffPackageV1Schema.parse(validPackage).schemaVersion,
    ).toBe("1.0.0");
  });

  it("rejects unsupported schema versions", () => {
    expect(() =>
      LeadEngineHandoffPackageV1Schema.parse({
        ...validPackage,
        schemaVersion: "2.0.0",
      }),
    ).toThrow();
  });
});
