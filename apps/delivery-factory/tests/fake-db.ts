import { randomUUID } from "node:crypto";
import {
  KPI_MEASUREMENT_METHOD,
  type ClarificationRow,
  type DeliveryDb,
  type DeliveryEnvironment,
  type DemoResetSummary,
  type FeedbackEventRow,
  type InboxRow,
  type MilestoneRow,
  type MonitoringSnapshot,
  type ProjectKpiRow,
  type ProjectRow,
} from "../api/_lib/db.js";
import type { LeadEngineHandoffPackage } from "@raphah/handoff-contract";

/**
 * In-memory fake of the DeliveryDb port. Mirrors the real Neon's semantics
 * (unique idempotency keys, nonce conflicts, seed milestones) so the intake
 * and project suites run with no live database.
 */
export class FakeDeliveryDb implements DeliveryDb {
  nonces = new Set<string>();
  inboxes = new Map<string, InboxRow & { project_id: string | null }>();
  projects = new Map<string, ProjectRow>();
  kpis = new Map<string, ProjectKpiRow[]>();
  milestones = new Map<string, MilestoneRow[]>();
  clarifications = new Map<string, ClarificationRow[]>();
  events: Array<{ projectId: string | null; event: Record<string, unknown> }> =
    [];
  stageHistory: Array<{
    projectId: string;
    fromStage: string;
    toStage: string;
    changedBy?: string;
  }> = [];
  operatorSessions = new Map<string, string>();

  inboxCount(): number {
    return this.inboxes.size;
  }

  async findOperatorSession(
    token: string,
  ): Promise<{ email: string } | null> {
    const email = this.operatorSessions.get(token);
    return email ? { email } : null;
  }

  async revokeOperatorSession(token: string): Promise<boolean> {
    return this.operatorSessions.delete(token);
  }

  async reserveNonce(nonce: string): Promise<boolean> {
    if (this.nonces.has(nonce)) return false;
    this.nonces.add(nonce);
    return true;
  }

  async findInboxByIdempotencyKey(key: string): Promise<InboxRow | null> {
    return this.inboxes.get(key) ?? null;
  }

  async createInboxAndProject(input: {
    idempotencyKey: string;
    pkg: LeadEngineHandoffPackage;
    manifestChecksum: string;
    signature: string;
    environment: DeliveryEnvironment;
  }): Promise<{ inboxId: string; project: ProjectRow }> {
    if (this.inboxes.has(input.idempotencyKey)) {
      throw new Error("duplicate idempotency key");
    }
    const pkg = input.pkg;
    const inboxId = randomUUID();
    const projectId = randomUUID();
    const project: ProjectRow = {
      id: projectId,
      inbox_id: inboxId,
      package_id: pkg.packageId,
      package_version: pkg.packageVersion,
      opportunity_id: pkg.opportunityId,
      organization_name: pkg.organization.name,
      name: pkg.organization.name,
      status: "active",
      environment: input.environment,
      current_stage: "intake",
      baseline_version: pkg.requirementBaseline.version,
      requirements_count: pkg.requirementBaseline.requirements.length,
      features_count: pkg.requirementBaseline.features.length,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.inboxes.set(input.idempotencyKey, {
      id: inboxId,
      idempotency_key: input.idempotencyKey,
      package: pkg,
      manifest_checksum: input.manifestChecksum,
      signature: input.signature,
      status: "processed",
      environment: input.environment,
      received_at: new Date().toISOString(),
      project_id: projectId,
    });
    this.projects.set(projectId, project);
    this.kpis.set(
      projectId,
      (pkg.successMeasures ?? [])
        .filter((m) => m?.metric)
        .map((m) => ({
          id: randomUUID(),
          project_id: projectId,
          metric: m.metric,
          target: m.target,
          measurement: KPI_MEASUREMENT_METHOD,
          status: "pending" as const,
          measured_value: null,
          verify_note: null,
          verified_by: null,
          verified_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })),
    );
    this.milestones.set(
      projectId,
      [
        "Client Onboarding & Access Verification",
        "Architecture Blueprint Sign-off",
        "Implementation & Integration Deployment",
        "Client Handover & Acceptance Training",
      ].map((title) => ({
        id: randomUUID(),
        project_id: projectId,
        title,
        target_date: null,
        completed: false,
        completed_at: null,
      })),
    );
    this.clarifications.set(projectId, []);
    return { inboxId, project };
  }

  async resetDemoEnvironment(): Promise<DemoResetSummary> {
    // The fake keeps no workflow_runs store; runs are covered by the
    // engine-level fakes in the workflow suites.
    let projects = 0;
    for (const [id, project] of this.projects) {
      if (project.environment !== "demo") continue;
      this.projects.delete(id);
      this.kpis.delete(id);
      this.milestones.delete(id);
      this.clarifications.delete(id);
      projects += 1;
    }
    let inbox = 0;
    for (const [key, row] of this.inboxes) {
      if (row.environment !== "demo") continue;
      this.inboxes.delete(key);
      inbox += 1;
    }
    return { workflowRuns: 0, projects, inbox };
  }

  async getProject(id: string): Promise<ProjectRow | null> {
    return this.projects.get(id) ?? null;
  }

  async getProjectPackage(projectId: string): Promise<{
    package: LeadEngineHandoffPackage;
    manifestChecksum: string;
    receivedAt: string;
  } | null> {
    const project = this.projects.get(projectId);
    if (!project) return null;
    const inbox = [...this.inboxes.values()].find(
      (row) => row.id === project.inbox_id,
    );
    if (!inbox) return null;
    return {
      package: inbox.package,
      manifestChecksum: inbox.manifest_checksum,
      receivedAt: inbox.received_at,
    };
  }

  async listProjectKpis(projectId: string): Promise<ProjectKpiRow[]> {
    return this.kpis.get(projectId) ?? [];
  }

  async verifyProjectKpi(input: {
    projectId: string;
    kpiId: string;
    status: "met" | "missed";
    measuredValue?: string;
    note?: string;
    verifiedBy: string;
  }): Promise<ProjectKpiRow> {
    const kpi = this.kpis
      .get(input.projectId)
      ?.find((k) => k.id === input.kpiId);
    if (!kpi) throw new Error("KPI not found");
    kpi.status = input.status;
    kpi.measured_value = input.measuredValue ?? null;
    kpi.verify_note = input.note ?? null;
    kpi.verified_by = input.verifiedBy;
    kpi.verified_at = new Date().toISOString();
    kpi.updated_at = new Date().toISOString();
    return kpi;
  }

  async listMilestones(projectId: string): Promise<MilestoneRow[]> {
    return this.milestones.get(projectId) ?? [];
  }

  async listClarifications(projectId: string): Promise<ClarificationRow[]> {
    return this.clarifications.get(projectId) ?? [];
  }

  async listProjectEvents(projectId: string): Promise<FeedbackEventRow[]> {
    return this.events
      .filter((e) => e.projectId === projectId)
      .map((e, i) => ({
        id: `evt-${i}`,
        event: e.event,
        status: "pending",
        created_at: new Date().toISOString(),
      }));
  }

  async transitionStage(input: {
    projectId: string;
    toStage: string;
    changedBy?: string;
  }): Promise<ProjectRow> {
    const project = this.projects.get(input.projectId);
    if (!project) throw new Error("Project not found");
    project.current_stage = input.toStage;
    project.updated_at = new Date().toISOString();
    return project;
  }

  async recordStageHistory(input: {
    projectId: string;
    fromStage: string;
    toStage: string;
    changedBy?: string;
  }): Promise<void> {
    this.stageHistory.push({ ...input });
  }

  async createMilestone(input: {
    projectId: string;
    title: string;
    targetDate?: string;
  }): Promise<MilestoneRow> {
    const milestone: MilestoneRow = {
      id: randomUUID(),
      project_id: input.projectId,
      title: input.title,
      target_date: input.targetDate ?? null,
      completed: false,
      completed_at: null,
    };
    this.milestones.get(input.projectId)?.push(milestone);
    return milestone;
  }

  async completeMilestone(
    projectId: string,
    milestoneId: string,
  ): Promise<MilestoneRow> {
    const milestone = this.milestones
      .get(projectId)
      ?.find((m) => m.id === milestoneId);
    if (!milestone) throw new Error("Milestone not found");
    milestone.completed = true;
    milestone.completed_at = new Date().toISOString();
    return milestone;
  }

  async createClarification(input: {
    projectId: string;
    question: string;
    owner: string;
  }): Promise<ClarificationRow> {
    const clarification: ClarificationRow = {
      id: randomUUID(),
      project_id: input.projectId,
      question: input.question,
      owner: input.owner,
      status: "open",
      resolved_at: null,
    };
    this.clarifications.get(input.projectId)?.push(clarification);
    return clarification;
  }

  async resolveClarification(
    projectId: string,
    clarificationId: string,
  ): Promise<ClarificationRow> {
    const clarification = this.clarifications
      .get(projectId)
      ?.find((c) => c.id === clarificationId);
    if (!clarification) throw new Error("Clarification not found");
    clarification.status = "resolved";
    clarification.resolved_at = new Date().toISOString();
    return clarification;
  }

  async enqueueFeedbackEvent(input: {
    projectId: string | null;
    event: Record<string, unknown>;
  }): Promise<void> {
    this.events.push({ projectId: input.projectId, event: input.event });
  }

  async getMonitoringSnapshot(): Promise<MonitoringSnapshot> {
    const recentHandoffs = [...this.inboxes.values()]
      .sort((a, b) => b.received_at.localeCompare(a.received_at))
      .slice(0, 10)
      .map((inbox) => {
        const project = [...this.projects.values()].find(
          (p) => p.inbox_id === inbox.id,
        );
        const pkg = inbox.package as LeadEngineHandoffPackage;
        return {
          id: inbox.id,
          idempotencyKey: inbox.idempotency_key,
          packageId: pkg.packageId,
          packageVersion: pkg.packageVersion,
          opportunityId: pkg.opportunityId,
          organizationName: pkg.organization.name,
          status: inbox.status,
          environment: inbox.environment,
          receivedAt: inbox.received_at,
          projectId: project?.id ?? null,
          projectStage: project?.current_stage ?? null,
        };
      });
    const pending = this.events.length;
    return {
      recentHandoffs,
      feedbackOutbox: { pending, dispatching: 0, failed: 0, sent: 0 },
      activeNonces: this.nonces.size,
    };
  }
}
