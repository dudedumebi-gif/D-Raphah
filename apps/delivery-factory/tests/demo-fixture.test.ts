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

/**
 * Fixtures 2 (migration 202610090004): the two round-2 walkthrough cases
 * seeded the same way as Harbourview, so Monitoring's charter story
 * covers all three demo businesses.
 */
const sql2 = readFileSync(
  new URL(
    "../neon/migrations/202610090004_demo_handoff_fixtures_2.sql",
    import.meta.url,
  ),
  "utf8",
);

function fixturePackages2(): Array<Record<string, any>> {
  const matches = [...sql2.matchAll(/\$pkg\$([\s\S]*?)\$pkg\$/g)];
  if (matches.length !== 2) {
    throw new Error(`expected 2 package literals, found ${matches.length}`);
  }
  return matches.map((m) => JSON.parse(m[1]) as Record<string, any>);
}

describe("demo handoff fixtures 2 (Northgate + TrueNorth)", () => {
  it("embeds contract-shaped v1 packages for both walkthrough cases", () => {
    const [northgate, truenorth] = fixturePackages2();
    expect(northgate.organization.name).toBe("Northgate Legal LLP");
    expect(truenorth.organization.name).toBe("TrueNorth Home Services");
    for (const pkg of [northgate, truenorth]) {
      expect(pkg.schemaVersion).toBe("1.0.0");
      expect(pkg.problemStatement.length).toBeGreaterThanOrEqual(10);
      expect(pkg.successMeasures).toHaveLength(3);
      expect(pkg.manifestChecksum).toMatch(/^[a-f0-9]{64}$/);
      expect(pkg.consentBasis.basisType).toBe("inquiry");
    }
    // Distinct ids — no collision with 003 or each other.
    const ids = [northgate, truenorth].flatMap((p) => [
      p.packageId,
      p.opportunityId,
    ]);
    expect(new Set(ids).size).toBe(4);
    expect(ids).not.toContain("d0000000-0000-4000-8000-000000000001");
  });

  it("keeps both baselines freezable", () => {
    for (const pkg of fixturePackages2()) {
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
    }
  });

  it("seeds demo-scoped rows with per-case KPIs, idempotently", () => {
    expect(sql2).toContain("'demo-fixture-northgate-v1'");
    expect(sql2).toContain("'demo-fixture-truenorth-v1'");
    expect(sql2).not.toContain("'production'");
    expect(sql2).toContain("sha256(pkg_text::bytea)");
    expect(sql2).toContain("not a signed LE handoff");
    expect(sql2).toContain("First response draft within 5 minutes");
    expect(sql2).toContain(
      "Review request drafted the same day the job completes",
    );
    expect(sql2).not.toContain("schema_versions");
    // The case content mirrors the walkthrough cases' own problem text.
    expect(sql2).toContain("first firm that responds");
    expect(sql2).toContain("nobody can say who was asked");
  });
});
