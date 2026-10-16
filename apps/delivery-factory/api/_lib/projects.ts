import type {
  HandoffFeatureCandidate,
  HandoffRequirement,
  LeadEngineHandoffPackage,
} from "@raphah/handoff-contract";
import type { DeliveryDb, ProjectKpiRow } from "./db.js";

/**
 * Delivery project charter operations. The charter is the handoff
 * package presented as the project's founding document, plus the
 * post-build KPI verification that records verdicts against it.
 * (The stage/milestone/clarification pipeline API was removed in
 * DF v2 — it had no callers; the project advances through intake
 * and workflow execution, not a hand-driven pipeline.)
 */

/* ── Project charter (Phase 1) ─────────────────────────────────────────
 * The charter is the handoff package, presented as the project's founding
 * document: problem/opportunity statement, current state and pain points,
 * the requirement baseline (with acceptance criteria), feature outcomes,
 * commercial scope, constraints, risks, and open items — plus the KPIs
 * restated from the package's successMeasures at intake, with their
 * post-build verification verdicts. DF does not author charter content;
 * it renders what LE shipped. Projects without a stored package
 * yield a charter of empty sections. */

export interface ProjectCharter {
  project: {
    id: string;
    name: string | null;
    organizationName: string;
    status: string;
    currentStage: string;
    environment: string;
    createdAt: string;
  };
  provenance: {
    packageId: string;
    packageVersion: number;
    opportunityId: string;
    approvedBy: string | null;
    approvedAt: string | null;
    manifestChecksum: string | null;
    receivedAt: string | null;
  };
  problemStatement: string | null;
  currentState: Array<{
    processName: string;
    owner?: string;
    painPoint: string;
  }>;
  requirements: HandoffRequirement[];
  features: HandoffFeatureCandidate[];
  constraints: Array<{ description: string; category: string }>;
  risksAndAssumptions: Array<{
    description: string;
    type: "risk" | "assumption";
    impact: string;
  }>;
  openItems: Array<{ description: string; owner: string; dueDate?: string }>;
  commercialScope: LeadEngineHandoffPackage["commercialScope"] | null;
  consentBasis: LeadEngineHandoffPackage["consentBasis"] | null;
  kpis: ProjectKpiRow[];
}

export async function getProjectCharter(
  db: DeliveryDb,
  projectId: string,
): Promise<ProjectCharter> {
  const project = await db.getProject(projectId);
  if (!project) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  const [pkgData, kpis] = await Promise.all([
    db.getProjectPackage(projectId),
    db.listProjectKpis(projectId),
  ]);
  const pkg = pkgData?.package;
  return {
    project: {
      id: project.id,
      name: project.name,
      organizationName: project.organization_name,
      status: project.status,
      currentStage: project.current_stage,
      environment: project.environment,
      createdAt: String(project.created_at),
    },
    provenance: {
      packageId: project.package_id,
      packageVersion: project.package_version,
      opportunityId: project.opportunity_id,
      approvedBy: pkg?.approvedBy ?? null,
      approvedAt: pkg?.approvedAt ?? null,
      manifestChecksum: pkgData?.manifestChecksum ?? null,
      receivedAt: pkgData?.receivedAt ?? null,
    },
    problemStatement: pkg?.problemStatement ?? null,
    currentState: pkg?.currentState ?? [],
    requirements: pkg?.requirementBaseline?.requirements ?? [],
    features: pkg?.requirementBaseline?.features ?? [],
    constraints: pkg?.constraints ?? [],
    risksAndAssumptions: pkg?.risksAndAssumptions ?? [],
    openItems: pkg?.openItems ?? [],
    commercialScope: pkg?.commercialScope ?? null,
    consentBasis: pkg?.consentBasis ?? null,
    kpis,
  };
}

/**
 * Record a post-build KPI verification. The verdict lives on the KPI row
 * and in DF's audit stream (the project_kpis audit trigger). No feedback
 * event is emitted: the v1 feedback contract's eventType enum has no KPI
 * type, and extending it is a contract change for LE to approve — DF does
 * not invent contract surface.
 */
export async function verifyCharterKpi(
  db: DeliveryDb,
  input: {
    projectId: string;
    kpiId: string;
    status: string;
    measuredValue?: string;
    note?: string;
    verifiedBy: string;
  },
): Promise<ProjectKpiRow> {
  if (input.status !== "met" && input.status !== "missed") {
    throw Object.assign(
      new Error("status must be 'met' or 'missed'"),
      { statusCode: 400 },
    );
  }
  const project = await db.getProject(input.projectId);
  if (!project) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  try {
    return await db.verifyProjectKpi({
      projectId: input.projectId,
      kpiId: input.kpiId,
      status: input.status,
      measuredValue: input.measuredValue?.trim() || undefined,
      note: input.note?.trim() || undefined,
      verifiedBy: input.verifiedBy,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "KPI not found") {
      throw Object.assign(new Error("KPI not found"), { statusCode: 404 });
    }
    throw error;
  }
}
