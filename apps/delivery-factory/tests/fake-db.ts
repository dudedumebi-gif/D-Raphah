import { randomUUID } from "node:crypto";
import type {
  ClarificationRow,
  DeliveryDb,
  FeedbackEventRow,
  InboxRow,
  MilestoneRow,
  MonitoringSnapshot,
  ProjectRow,
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
      received_at: new Date().toISOString(),
      project_id: projectId,
    });
    this.projects.set(projectId, project);
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

  async getProject(id: string): Promise<ProjectRow | null> {
    return this.projects.get(id) ?? null;
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
