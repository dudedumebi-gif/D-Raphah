import { neon } from "@neondatabase/serverless";
import type { LeadEngineHandoffPackage } from "@raphah/handoff-contract";

/**
 * Shared database access for the Delivery Factory Vercel functions.
 *
 * The Delivery Factory owns its database outright (DELIVERY_DATABASE_URL).
 * It NEVER imports anything from apps/leads-engine and never touches the
 * Lead Engine's database: integration is contract-only via POST /api/intake.
 *
 * All functions here run with the service-role connection string. RLS is
 * enabled with no permissive policies, so the service role is the only
 * writer by design. End-user/operator authentication is out of scope for
 * this phase (see migration header).
 */

export type NeonClient = ReturnType<typeof neon>;

let database: NeonClient | null = null;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function getDb(): NeonClient {
  if (!database) database = neon(requiredEnv("DELIVERY_DATABASE_URL"));
  return database;
}

export interface InboxRow {
  id: string;
  idempotency_key: string;
  package: LeadEngineHandoffPackage;
  manifest_checksum: string;
  signature: string;
  status: string;
  received_at: string;
  project_id: string | null;
}

export interface ProjectRow {
  id: string;
  inbox_id: string;
  package_id: string;
  package_version: number;
  opportunity_id: string;
  organization_name: string;
  name: string | null;
  status: string;
  current_stage: string;
  baseline_version: number;
  requirements_count: number;
  features_count: number;
  created_at: string;
  updated_at: string;
}

export interface MilestoneRow {
  id: string;
  project_id: string;
  title: string;
  target_date: string | null;
  completed: boolean;
  completed_at: string | null;
}

export interface ClarificationRow {
  id: string;
  project_id: string;
  question: string;
  owner: string;
  status: string;
  resolved_at: string | null;
}

export interface FeedbackEventRow {
  id: string;
  event: Record<string, unknown>;
  status: string;
  created_at: string;
}

/**
 * Port interface for every database operation the API needs. The Vercel
 * handlers receive a DeliveryDb; unit tests substitute an in-memory fake so
 * no live database is required to run the suite.
 */
export interface DeliveryDb {
  reserveNonce(nonce: string): Promise<boolean>;
  findInboxByIdempotencyKey(key: string): Promise<InboxRow | null>;
  createInboxAndProject(input: {
    idempotencyKey: string;
    pkg: LeadEngineHandoffPackage;
    manifestChecksum: string;
    signature: string;
  }): Promise<{ inboxId: string; project: ProjectRow }>;
  getProject(id: string): Promise<ProjectRow | null>;
  listMilestones(projectId: string): Promise<MilestoneRow[]>;
  listClarifications(projectId: string): Promise<ClarificationRow[]>;
  listProjectEvents(projectId: string): Promise<FeedbackEventRow[]>;
  transitionStage(input: {
    projectId: string;
    toStage: string;
    changedBy?: string;
  }): Promise<ProjectRow>;
  recordStageHistory(input: {
    projectId: string;
    fromStage: string;
    toStage: string;
    changedBy?: string;
  }): Promise<void>;
  createMilestone(input: {
    projectId: string;
    title: string;
    targetDate?: string;
  }): Promise<MilestoneRow>;
  completeMilestone(projectId: string, milestoneId: string): Promise<MilestoneRow>;
  createClarification(input: {
    projectId: string;
    question: string;
    owner: string;
  }): Promise<ClarificationRow>;
  resolveClarification(
    projectId: string,
    clarificationId: string,
  ): Promise<ClarificationRow>;
  enqueueFeedbackEvent(input: {
    projectId: string | null;
    event: Record<string, unknown>;
  }): Promise<void>;
}

const SEED_MILESTONES = [
  "Client Onboarding & Access Verification",
  "Architecture Blueprint Sign-off",
  "Implementation & Integration Deployment",
  "Client Handover & Acceptance Training",
];

export function createDeliveryDb(client: NeonClient = getDb()): DeliveryDb {
  return {
    async reserveNonce(nonce: string): Promise<boolean> {
      // Prune expired nonces opportunistically, then attempt the reservation.
      // A conflict means the nonce was already seen: replay.
      await client`delete from public.used_nonces where expires_at < now()`;
      const rows = (await client`
        insert into public.used_nonces(nonce, expires_at)
        values (${nonce}, now() + interval '10 minutes')
        on conflict (nonce) do nothing
        returning nonce
      `) as unknown as Array<{ nonce: string }>;
      return rows.length === 1;
    },

    async findInboxByIdempotencyKey(key: string): Promise<InboxRow | null> {
      const rows = (await client`
        select i.id, i.idempotency_key, i.package, i.manifest_checksum,
               i.signature, i.status, i.received_at, p.id as project_id
        from public.handoff_inbox i
        left join public.delivery_projects p on p.inbox_id = i.id
        where i.idempotency_key = ${key}
        limit 1
      `) as unknown as InboxRow[];
      return rows[0] ?? null;
    },

    async createInboxAndProject(input: {
      idempotencyKey: string;
      pkg: LeadEngineHandoffPackage;
      manifestChecksum: string;
      signature: string;
    }): Promise<{ inboxId: string; project: ProjectRow }> {
      const pkg = input.pkg;
      const inboxRows = (await client`
        insert into public.handoff_inbox(
          idempotency_key, package, manifest_checksum, signature, status
        )
        values (
          ${input.idempotencyKey},
          ${JSON.stringify(pkg)}::jsonb,
          ${input.manifestChecksum},
          ${input.signature},
          'processed'
        )
        on conflict (idempotency_key) do nothing
        returning id
      `) as unknown as Array<{ id: string }>;
      if (inboxRows.length === 0) {
        // Lost a race with a concurrent identical intake; the caller treats
        // the existing row as an idempotent replay.
        const existing = await this.findInboxByIdempotencyKey(
          input.idempotencyKey,
        );
        if (!existing?.project_id) throw new Error("Intake race unresolved");
        const project = await this.getProject(existing.project_id);
        if (!project) throw new Error("Intake race unresolved");
        return { inboxId: existing.id, project };
      }
      const inboxId = inboxRows[0].id;
      const projectRows = (await client`
        insert into public.delivery_projects(
          inbox_id, package_id, package_version, opportunity_id,
          organization_name, name, current_stage,
          baseline_version, requirements_count, features_count
        )
        values (
          ${inboxId}::uuid,
          ${pkg.packageId}::uuid,
          ${pkg.packageVersion},
          ${pkg.opportunityId}::uuid,
          ${pkg.organization.name},
          ${pkg.organization.name},
          'intake',
          ${pkg.requirementBaseline.version},
          ${pkg.requirementBaseline.requirements.length},
          ${pkg.requirementBaseline.features.length}
        )
        returning *
      `) as unknown as ProjectRow[];
      const project = projectRows[0];
      for (const title of SEED_MILESTONES) {
        await client`
          insert into public.milestones(project_id, title)
          values (${project.id}::uuid, ${title})
        `;
      }
      await client`
        insert into public.stage_history(project_id, from_stage, to_stage, changed_by)
        values (${project.id}::uuid, 'intake', 'intake', 'system:intake')
      `;
      return { inboxId, project };
    },

    async getProject(id: string): Promise<ProjectRow | null> {
      const rows = (await client`
        select * from public.delivery_projects where id = ${id}::uuid limit 1
      `) as unknown as ProjectRow[];
      return rows[0] ?? null;
    },

    async listMilestones(projectId: string): Promise<MilestoneRow[]> {
      return (await client`
        select * from public.milestones
        where project_id = ${projectId}::uuid
        order by created_at
      `) as unknown as MilestoneRow[];
    },

    async listClarifications(projectId: string): Promise<ClarificationRow[]> {
      return (await client`
        select * from public.clarifications
        where project_id = ${projectId}::uuid
        order by created_at
      `) as unknown as ClarificationRow[];
    },

    async listProjectEvents(projectId: string): Promise<FeedbackEventRow[]> {
      return (await client`
        select id, event, status, created_at
        from public.feedback_outbox
        where project_id = ${projectId}::uuid
        order by created_at desc
        limit 100
      `) as unknown as FeedbackEventRow[];
    },

    async transitionStage(input: {
      projectId: string;
      toStage: string;
      changedBy?: string;
    }): Promise<ProjectRow> {
      const rows = (await client`
        update public.delivery_projects
        set current_stage = ${input.toStage}, updated_at = now()
        where id = ${input.projectId}::uuid
        returning *
      `) as unknown as ProjectRow[];
      if (rows.length === 0) throw new Error("Project not found");
      return rows[0];
    },

    async recordStageHistory(input: {
      projectId: string;
      fromStage: string;
      toStage: string;
      changedBy?: string;
    }): Promise<void> {
      await client`
        insert into public.stage_history(project_id, from_stage, to_stage, changed_by)
        values (${input.projectId}::uuid, ${input.fromStage}, ${input.toStage},
                ${input.changedBy ?? null})
      `;
    },

    async createMilestone(input: {
      projectId: string;
      title: string;
      targetDate?: string;
    }): Promise<MilestoneRow> {
      const rows = (await client`
        insert into public.milestones(project_id, title, target_date)
        values (${input.projectId}::uuid, ${input.title},
                ${input.targetDate ?? null}::date)
        returning *
      `) as unknown as MilestoneRow[];
      return rows[0];
    },

    async completeMilestone(
      projectId: string,
      milestoneId: string,
    ): Promise<MilestoneRow> {
      const rows = (await client`
        update public.milestones
        set completed = true, completed_at = now()
        where id = ${milestoneId}::uuid and project_id = ${projectId}::uuid
        returning *
      `) as unknown as MilestoneRow[];
      if (rows.length === 0) throw new Error("Milestone not found");
      return rows[0];
    },

    async createClarification(input: {
      projectId: string;
      question: string;
      owner: string;
    }): Promise<ClarificationRow> {
      const rows = (await client`
        insert into public.clarifications(project_id, question, owner)
        values (${input.projectId}::uuid, ${input.question}, ${input.owner})
        returning *
      `) as unknown as ClarificationRow[];
      return rows[0];
    },

    async resolveClarification(
      projectId: string,
      clarificationId: string,
    ): Promise<ClarificationRow> {
      const rows = (await client`
        update public.clarifications
        set status = 'resolved', resolved_at = now()
        where id = ${clarificationId}::uuid and project_id = ${projectId}::uuid
        returning *
      `) as unknown as ClarificationRow[];
      if (rows.length === 0) throw new Error("Clarification not found");
      return rows[0];
    },

    async enqueueFeedbackEvent(input: {
      projectId: string | null;
      event: Record<string, unknown>;
    }): Promise<void> {
      await client`
        insert into public.feedback_outbox(project_id, event)
        values (${input.projectId}::uuid, ${JSON.stringify(input.event)}::jsonb)
      `;
    },
  };
}
