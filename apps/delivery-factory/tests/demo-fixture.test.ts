import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Demo handoff fixture (migration 202610090003): Monitoring's charter/KPI
 * story must work in the demo environment without a real production
 * handoff. These tests pin the fixture's shape: a contract-valid sample
 * package, demo-scoped rows only, idempotent, no schema-version change
 * (readiness stays at 1.3.0).
 */

const sql = readFileSync(
  new URL(
    "../neon/migrations/202610090003_demo_handoff_fixture.sql",
    import.meta.url,
  ),
  "utf8",
);

function fixturePackage(): Record<string, any> {
  const match = sql.match(/\$pkg\$([\s\S]*?)\$pkg\$/);
  if (!match) throw new Error("package literal not found");
  return JSON.parse(match[1]) as Record<string, any>;
}

describe("demo handoff fixture migration", () => {
  it("embeds a contract-shaped v1 package (the walkthrough case)", () => {
    const pkg = fixturePackage();
    expect(pkg.schemaVersion).toBe("1.0.0");
    expect(pkg.organization.name).toBe("Harbourview Dental Studio");
    expect(pkg.problemStatement.length).toBeGreaterThanOrEqual(10);
    expect(pkg.successMeasures).toHaveLength(3);
    expect(pkg.manifestChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(pkg.consentBasis.basisType).toBe("inquiry");
  });

  it("keeps the baseline freezable: musts validated, human-validated, unblocked", () => {
    const pkg = fixturePackage();
    const reqs = pkg.requirementBaseline.requirements as Array<{
      priority: string;
      status: string;
      humanValidatorId?: string;
      blockingQuestions: string[];
      acceptanceCriteria: string[];
    }>;
    expect(reqs).toHaveLength(3);
    for (const req of reqs) {
      expect(req.status).toBe("validated");
      expect(req.blockingQuestions).toEqual([]);
      expect(req.acceptanceCriteria.length).toBeGreaterThan(0);
      if (req.priority === "must") {
        expect(req.humanValidatorId).toBeTruthy();
      }
    }
    expect(pkg.requirementBaseline.features).toHaveLength(3);
  });

  it("seeds demo-scoped intake-shaped rows and nothing else", () => {
    expect(sql).toContain("'demo-fixture-harbourview-v1'");
    expect(sql).toContain("'processed'");
    expect(sql).toContain("'demo'");
    expect(sql).not.toContain("'production'");
    // Milestones + stage history mirror a real intake.
    expect(sql).toContain("Client Onboarding & Access Verification");
    expect(sql).toContain("'system:intake'");
    // KPIs restated with the standard measurement method.
    expect(sql).toContain(
      "Verified by the operator against Delivery Factory workflow run history",
    );
    expect(sql).toContain("First follow-up draft within 5 minutes of intake");
    // Checksum genuinely computed over the stored package text.
    expect(sql).toContain("sha256(pkg_text::bytea)");
    // Fixture is labeled honestly in the signature field.
    expect(sql).toContain("not a signed LE handoff");
  });

  it("is idempotent and does not move the schema version", () => {
    expect(sql).toContain("if exists");
    expect(sql).toContain("idempotency_key = 'demo-fixture-harbourview-v1'");
    expect(sql).not.toContain("schema_versions");
  });
});
