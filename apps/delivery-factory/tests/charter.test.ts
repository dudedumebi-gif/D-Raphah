import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getProjectCharter,
  verifyCharterKpi,
} from "../api/_lib/projects.js";
import { handleIntake } from "../api/_lib/verify.js";
import { FakeDeliveryDb } from "./fake-db.js";
import { intakeRequest, packageBase, signTestPackage, testEnv } from "./helpers.js";

/**
 * Phase 1 project charter: the charter is seeded from the handoff package
 * (never authored in DF), its success measures become testable KPIs at
 * intake, and post-build verification verdicts are recorded on the KPIs.
 */

const SUCCESS_MEASURES = [
  {
    metric: "Lead response time",
    target: "First follow-up draft within 5 minutes of intake",
  },
  {
    metric: "Manual follow-up effort",
    target: "Zero hand-written follow-up drafts per lead",
  },
];

async function acceptWithCharter(db: FakeDeliveryDb) {
  const signed = signTestPackage(
    packageBase({
      successMeasures: SUCCESS_MEASURES,
      currentState: [
        {
          processName: "Manual lead follow-up",
          owner: "Sales",
          painPoint: "Follow-up takes up to 2 days and is often skipped",
        },
      ],
      constraints: [{ description: "CASL consent required", category: "legal" }],
      risksAndAssumptions: [
        { description: "Lead volume stays under 50/day", type: "assumption", impact: "medium" },
      ],
      openItems: [{ description: "Confirm sender domain", owner: "Founder" }],
    }),
  );
  const result = await handleIntake(
    intakeRequest(signed),
    db,
    testEnv({ environment: "production" }),
  );
  expect(result.status).toBe(201);
  return {
    signed,
    projectId: (result.body as { projectId: string }).projectId,
  };
}

describe("project charter", () => {
  it("is seeded from the handoff package, not authored in DF", async () => {
    const db = new FakeDeliveryDb();
    const { signed, projectId } = await acceptWithCharter(db);
    const charter = await getProjectCharter(db, projectId);

    expect(charter.problemStatement).toContain("manual invoice reconciliation");
    expect(charter.currentState).toHaveLength(1);
    expect(charter.currentState[0].painPoint).toContain("2 days");
    expect(charter.requirements).toHaveLength(1);
    expect(charter.requirements[0].acceptanceCriteria).toEqual([
      "Reconciliation completes without manual steps",
    ]);
    expect(charter.constraints).toHaveLength(1);
    expect(charter.risksAndAssumptions).toHaveLength(1);
    expect(charter.openItems).toHaveLength(1);
    expect(charter.commercialScope?.scopeSummary).toBe(
      "Automate invoice reconciliation",
    );
    expect(charter.provenance.approvedBy).toBe("operator@example.com");
    expect(charter.provenance.manifestChecksum).toBe(signed.manifestChecksum);
    expect(charter.provenance.packageId).toBe(signed.pkg.packageId);
    expect(charter.project.environment).toBe("production");
  });

  it("restates success measures as pending, testable KPIs at intake", async () => {
    const db = new FakeDeliveryDb();
    const { projectId } = await acceptWithCharter(db);
    const charter = await getProjectCharter(db, projectId);
    expect(charter.kpis).toHaveLength(2);
    expect(charter.kpis.map((k) => k.metric)).toEqual([
      "Lead response time",
      "Manual follow-up effort",
    ]);
    for (const kpi of charter.kpis) {
      expect(kpi.status).toBe("pending");
      expect(kpi.target.length).toBeGreaterThan(0);
      expect(kpi.measurement).toContain("workflow run history");
      expect(kpi.verified_at).toBeNull();
    }
  });

  it("records post-build verification verdicts on the KPI", async () => {
    const db = new FakeDeliveryDb();
    const { projectId } = await acceptWithCharter(db);
    const charter = await getProjectCharter(db, projectId);
    const [first, second] = charter.kpis;

    const met = await verifyCharterKpi(db, {
      projectId,
      kpiId: first.id,
      status: "met",
      measuredValue: "Median draft time 3.8 minutes over 42 runs",
      note: "Measured from run history, first 30 days after go-live",
      verifiedBy: "operator@example.com",
    });
    expect(met.status).toBe("met");
    expect(met.measured_value).toContain("3.8 minutes");
    expect(met.verified_by).toBe("operator@example.com");
    expect(met.verified_at).not.toBeNull();

    const missed = await verifyCharterKpi(db, {
      projectId,
      kpiId: second.id,
      status: "missed",
      measuredValue: "3 hand-written drafts in the first month",
      verifiedBy: "operator@example.com",
    });
    expect(missed.status).toBe("missed");

    const after = await getProjectCharter(db, projectId);
    expect(after.kpis.map((k) => k.status)).toEqual(["met", "missed"]);
  });

  it("rejects invalid verdicts and unknown projects/KPIs", async () => {
    const db = new FakeDeliveryDb();
    const { projectId } = await acceptWithCharter(db);
    const charter = await getProjectCharter(db, projectId);
    await expect(
      verifyCharterKpi(db, {
        projectId,
        kpiId: charter.kpis[0].id,
        status: "partially",
        verifiedBy: "operator@example.com",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      verifyCharterKpi(db, {
        projectId,
        kpiId: "00000000-0000-4000-8000-000000000000",
        status: "met",
        verifiedBy: "operator@example.com",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      getProjectCharter(db, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("charter KPI migration", () => {
  const migration = readFileSync(
    new URL(
      "../neon/migrations/202610090002_project_charter_kpis.sql",
      import.meta.url,
    ),
    "utf8",
  );

  it("creates project_kpis, audits it, backfills, and advances the schema", () => {
    expect(migration).toContain("create table if not exists public.project_kpis");
    expect(migration).toContain("audit_project_kpis");
    expect(migration).toContain("successMeasures");
    expect(migration).toContain("'1.3.0'");
    expect(migration).toContain("on delete cascade");
  });
});
