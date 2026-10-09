import type {
  HandoffFeatureCandidate,
  HandoffRequirement,
  LeadEngineHandoffPackage,
} from "@raphah/handoff-contract";
import type {
  ClarificationRow,
  DeliveryDb,
  MilestoneRow,
  ProjectKpiRow,
  ProjectRow,
} from "./db.js";
import { buildFeedbackEvent, type IntakeEnv } from "./verify.js";

/**
 * Delivery project domain operations, ported from delivery-tool's
 * ProjectsService onto the durable Neon schema. delivery-tool allowed
 * arbitrary stage jumps against an in-memory store; here transitions are
 * validated against the pipeline order and every change is recorded in
 * stage_history. Operator-facing auth is out of scope for this phase (see
 * migration header); the `changedBy` audit field is accepted as metadata.
 */

export const PROJECT_STAGES = [
  "intake",
  "onboarding",
  "blueprint_drafting",
  "implementation",
  "testing",
  "handover",
  "completed",
] as const;

export type ProjectStage = (typeof PROJECT_STAGES)[number];

/**
 * Transition rule: forward exactly one pipeline step, or backward to any
 * earlier stage (rework). `completed` is terminal. A no-op (same stage) is
 * allowed and returns the project unchanged.
 */
export function isStageTransitionAllowed(
  fromStage: string,
  toStage: string,
): boolean {
  const fromIdx = PROJECT_STAGES.indexOf(fromStage as ProjectStage);
  const toIdx = PROJECT_STAGES.indexOf(toStage as ProjectStage);
  if (fromIdx === -1 || toIdx === -1) return false;
  if (fromStage === "completed") return toStage === "completed";
  if (toIdx === fromIdx) return true;
  if (toIdx === fromIdx + 1) return true;
  return toIdx < fromIdx;
}

export function assertValidStage(stage: unknown): asserts stage is ProjectStage {
  if (typeof stage !== "string" || !PROJECT_STAGES.includes(stage as ProjectStage)) {
    throw Object.assign(
      new Error(
        `Invalid stage. Must be one of: ${PROJECT_STAGES.join(", ")}`,
      ),
      { statusCode: 400 },
    );
  }
}

export interface ProjectDetail {
  project: ProjectRow;
  milestones: MilestoneRow[];
  clarifications: ClarificationRow[];
}

export async function getProjectDetail(
  db: DeliveryDb,
  projectId: string,
): Promise<ProjectDetail> {
  const project = await db.getProject(projectId);
  if (!project) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  const [milestones, clarifications] = await Promise.all([
    db.listMilestones(projectId),
    db.listClarifications(projectId),
  ]);
  return { project, milestones, clarifications };
}

function packageRef(project: ProjectRow): LeadEngineHandoffPackage {
  return {
    packageId: project.package_id,
    packageVersion: project.package_version,
    opportunityId: project.opportunity_id,
  } as LeadEngineHandoffPackage;
}

export async function transitionProjectStage(
  db: DeliveryDb,
  input: {
    projectId: string;
    toStage: string;
    changedBy?: string;
    environment: IntakeEnv["environment"];
  },
): Promise<ProjectRow> {
  assertValidStage(input.toStage);
  const project = await db.getProject(input.projectId);
  if (!project) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  if (!isStageTransitionAllowed(project.current_stage, input.toStage)) {
    throw Object.assign(
      new Error(
        `Stage transition not allowed: ${project.current_stage} -> ${input.toStage}`,
      ),
      { statusCode: 400 },
    );
  }
  if (project.current_stage === input.toStage) return project;
  const fromStage = project.current_stage;
  const updated = await db.transitionStage({
    projectId: input.projectId,
    toStage: input.toStage,
    changedBy: input.changedBy,
  });
  await db.recordStageHistory({
    projectId: input.projectId,
    fromStage,
    toStage: input.toStage,
    changedBy: input.changedBy,
  });
  if (input.toStage === "completed") {
    await db.enqueueFeedbackEvent({
      projectId: project.id,
      event: buildFeedbackEvent({
        eventType: "delivery.project.closed",
        pkg: packageRef(project),
        projectId: project.id,
        details: { fromStage, toStage: input.toStage },
        environment: input.environment,
      }) as unknown as Record<string, unknown>,
    });
  }
  return updated;
}

export async function addMilestone(
  db: DeliveryDb,
  input: { projectId: string; title: string; targetDate?: string },
): Promise<MilestoneRow> {
  const project = await db.getProject(input.projectId);
  if (!project) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  if (!input.title || input.title.trim() === "") {
    throw Object.assign(new Error("Milestone title is required"), { statusCode: 400 });
  }
  if (input.targetDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.targetDate)) {
    throw Object.assign(new Error("targetDate must be YYYY-MM-DD"), { statusCode: 400 });
  }
  return db.createMilestone({
    projectId: input.projectId,
    title: input.title.trim(),
    targetDate: input.targetDate,
  });
}

export async function finishMilestone(
  db: DeliveryDb,
  input: {
    projectId: string;
    milestoneId: string;
    environment: IntakeEnv["environment"];
  },
): Promise<MilestoneRow> {
  const project = await db.getProject(input.projectId);
  if (!project) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  const milestone = await db.completeMilestone(input.projectId, input.milestoneId);
  await db.enqueueFeedbackEvent({
    projectId: project.id,
    event: buildFeedbackEvent({
      eventType: "delivery.release.completed",
      pkg: packageRef(project),
      projectId: project.id,
      details: { milestoneId: milestone.id, title: milestone.title },
      environment: input.environment,
    }) as unknown as Record<string, unknown>,
  });
  return milestone;
}

export async function askClarification(
  db: DeliveryDb,
  input: {
    projectId: string;
    question: string;
    owner?: string;
    environment: IntakeEnv["environment"];
  },
): Promise<ClarificationRow> {
  const project = await db.getProject(input.projectId);
  if (!project) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  if (!input.question || input.question.trim() === "") {
    throw Object.assign(new Error("Clarification question is required"), { statusCode: 400 });
  }
  const clarification = await db.createClarification({
    projectId: input.projectId,
    question: input.question.trim(),
    owner: input.owner?.trim() || "Founder",
  });
  await db.enqueueFeedbackEvent({
    projectId: project.id,
    event: buildFeedbackEvent({
      eventType: "delivery.clarification.requested",
      pkg: packageRef(project),
      projectId: project.id,
      details: {
        clarificationId: clarification.id,
        question: clarification.question,
        owner: clarification.owner,
      },
      environment: input.environment,
    }) as unknown as Record<string, unknown>,
  });
  return clarification;
}

export async function settleClarification(
  db: DeliveryDb,
  input: { projectId: string; clarificationId: string },
): Promise<ClarificationRow> {
  const project = await db.getProject(input.projectId);
  if (!project) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  return db.resolveClarification(input.projectId, input.clarificationId);
}

/* ── Project charter (Phase 1) ─────────────────────────────────────────
 * The charter is the handoff package, presented as the project's founding
 * document: problem/opportunity statement, current state and pain points,
 * the requirement baseline (with acceptance criteria), feature outcomes,
 * commercial scope, constraints, risks, and open items — plus the KPIs
 * restated from the package's successMeasures at intake, with their
 * post-build verification verdicts. DF does not author charter content;
 * it renders what LE shipped. Synthetic projects (created by workflow
 * runs without a real package) yield a charter of empty sections. */

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
