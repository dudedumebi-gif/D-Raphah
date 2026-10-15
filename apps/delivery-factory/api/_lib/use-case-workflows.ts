/**
 * Use-case workflow skeletons for the Delivery Factory.
 *
 * A handoff package's requirement baseline is the set of use cases the
 * Lead Engine's reviewer approved and shipped (validated requirements,
 * each with acceptance criteria). Until now those requirements were
 * prose on the project's Charter: the only workflows that could run
 * were generic published lead_handoff templates, and in an environment
 * with none published the project sat at intake with nothing to begin
 * or test (the Donddental case, 2026-10-14).
 *
 * This module closes that gap: for each requirement in the project's
 * stored package it ensures ONE draft workflow exists in the project's
 * own environment scope — a linear skeleton (manual trigger → AI plan
 * draft → draft client email → audit log) seeded from the requirement
 * itself, so the operator can open it in Automations, publish it, and
 * live-test the delivery flow for that exact use case.
 *
 * Posture, mirroring the rest of the intake path:
 * - DF reads ONLY its stored package (delivery_projects →
 *   handoff_inbox.package). No Lead Engine calls, no contract changes.
 * - Skeletons are DRAFTS. The generator never publishes and never
 *   executes; sends inside a run stay draft-first for human approval.
 * - Only human-validated requirements get skeletons: status
 *   "validated" with a humanValidatorId — the same bar the baseline
 *   freeze applies to Must requirements. A package may legitimately
 *   carry draft/proposed non-Must requirements; nothing here may
 *   present those as approved (repo rule: no requirement becomes
 *   authoritative without an identified human validator).
 * - Idempotent per (project, requirement): the link lives in the
 *   workflow's trigger_config ({projectId, packageId, requirementId,
 *   requirementCode}) and an existing match is reported, never
 *   duplicated. The key is the requirement's unique id, not its
 *   code — codes are display slugs LE truncates, so two distinct
 *   use cases can share one. Uniqueness is database-backed (the
 *   partial unique index uq_workflows_use_case_skeleton, migration
 *   202610140002): a create that loses a concurrent race adopts the
 *   winner's row.
 * - A matched skeleton whose graph is incomplete (a create that
 *   died mid-graph) is regenerated ONLY when it is provably
 *   untouched machine state: never run, and its row never updated
 *   since creation — the database's own trg_workflows_touch
 *   trigger bumps updated_at on every UPDATE, and the generator's
 *   create path never updates the row, so updated_at = created_at
 *   is a creation-state marker no edit can hide behind. Anything
 *   else — above all an operator's edited, live-tested draft, at
 *   any age — is reported as existing and left exactly as it is.
 */

import type {
  HandoffRequirement,
  LeadEngineHandoffPackage,
} from "@raphah/handoff-contract";
import type { DeliveryEnvironment, NeonClient } from "./db.js";
import { log } from "./telemetry.js";
import {
  createWorkflow,
  getProjectIdForPackage,
  getWorkflow,
  specFor,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
} from "./workflows.js";

/** The project facts the generator needs (a ProjectRow satisfies it). */
export interface UseCaseWorkflowProjectRef {
  id: string;
  environment: DeliveryEnvironment;
  package_id: string;
  organization_name: string;
}

export interface UseCaseSkeleton {
  id: string;
  name: string;
  status: string;
  requirementCode: string;
}

export interface EnsureUseCaseWorkflowsResult {
  created: UseCaseSkeleton[];
  existing: UseCaseSkeleton[];
}

/**
 * Typed wrapper around the neon tag client (same narrowing as
 * workflows.ts: every query here selects rows).
 */
function q(db: NeonClient) {
  return async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Record<string, unknown>[]> => {
    const result = await (
      db as unknown as (
        s: TemplateStringsArray,
        ...v: unknown[]
      ) => Promise<unknown>
    )(strings, ...values);
    return result as Record<string, unknown>[];
  };
}

/**
 * A readable title for a requirement: LE's use-case codes are
 * descriptive slugs ("UC-ONLINE-APPOINTMENT-BOOKING"), so strip the
 * UC- prefix and title-case the words. Codes that carry no words
 * (e.g. "REQ-001") fall back to the statement's opening.
 */
export function humanizeRequirementTitle(
  requirement: Pick<HandoffRequirement, "code" | "statement">,
): string {
  const words = requirement.code
    .replace(/^uc[-_]/i, "")
    .split(/[-_\s]+/)
    .filter(Boolean);
  // A code only counts as a title when it carries a real word —
  // "REQ-001" humanizes to "Req 001", which is worse than the
  // statement it would replace.
  if (words.some((w) => /^[a-z]+$/i.test(w) && w.length >= 4)) {
    return words
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");
  }
  const statement = requirement.statement.trim();
  return statement.length > 80
    ? `${statement.slice(0, 77).trimEnd()}…`
    : statement;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface UseCaseWorkflowDraft {
  name: string;
  description: string;
  trigger_config: Record<string, unknown>;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/**
 * The skeleton graph for one requirement. Pure (no I/O) so the shape
 * is unit-testable: a manual trigger, an AI step that drafts the
 * implementation plan + client message for THIS use case, a draft
 * client email carrying the acceptance criteria as a checklist, and
 * an audit-log step. Configs start from the NODE_CATALOG defaults so
 * the builder renders them exactly like hand-built nodes.
 */
export function buildUseCaseWorkflowDraft(input: {
  project: UseCaseWorkflowProjectRef;
  packageId: string;
  requirement: HandoffRequirement;
  successMeasure?: { metric: string; target: string };
}): UseCaseWorkflowDraft {
  const { project, requirement, successMeasure } = input;
  const org = project.organization_name;
  const title = humanizeRequirementTitle(requirement);
  const criteria = requirement.acceptanceCriteria ?? [];
  const criteriaList = criteria.length
    ? criteria.map((c) => `- ${c}`).join("\n")
    : "- (no acceptance criteria were shipped with this requirement)";
  const measureLine = successMeasure
    ? `Success measure: ${successMeasure.metric} — target: ${successMeasure.target}`
    : null;

  const aiConfig: Record<string, unknown> = {
    ...specFor("ai_assist").defaultConfig,
    systemPrompt:
      "You are a delivery planner in Raphah's Delivery Factory. You draft " +
      "implementation plans and client-facing messages for ONE approved " +
      "automation use case at a time. Everything you produce is a draft " +
      "for human review — never present it as sent or built. Be concrete " +
      "and brief, and never invent facts about the client beyond the brief.",
    userPrompt: [
      `Use case ${requirement.code} for ${org}: ${requirement.statement}`,
      "",
      "Acceptance criteria:",
      criteriaList,
      ...(measureLine ? ["", measureLine] : []),
      "",
      "Draft: (1) a step-by-step implementation plan for this use case, " +
        "(2) a short client message explaining what will be built and how " +
        "success will be measured, and (3) the open questions a human " +
        "must confirm before the build starts.",
    ].join("\n"),
    maxTokens: 800,
  };

  const emailBody = [
    `<p>Hello from the Raphah delivery team,</p>`,
    `<p>We are preparing to build <b>${escapeHtml(title)}</b> for ${escapeHtml(org)}: ${escapeHtml(requirement.statement)}</p>`,
    `<p>What success looks like:</p>`,
    `<ul>${criteria.map((c) => `<li>✓ ${escapeHtml(c)}</li>`).join("")}</ul>`,
    ...(measureLine ? [`<p>${escapeHtml(measureLine)}</p>`] : []),
    `<p><i>Draft generated from the approved handoff package (requirement ${escapeHtml(requirement.code)}). It waits for human review before sending.</i></p>`,
  ].join("\n");

  const nodes: WorkflowNode[] = [
    {
      node_key: "trigger-1",
      type: "trigger",
      kind: "manual",
      label: "Manual start",
      position_x: 360,
      position_y: 40,
      config: { ...specFor("manual").defaultConfig },
      enabled: true,
    },
    {
      node_key: "action-1",
      type: "action",
      kind: "ai_assist",
      label: `Draft plan — ${title}`,
      position_x: 360,
      position_y: 220,
      config: aiConfig,
      enabled: true,
    },
    {
      node_key: "action-2",
      type: "action",
      kind: "send_email",
      label: "Draft client email",
      position_x: 360,
      position_y: 400,
      config: {
        ...specFor("send_email").defaultConfig,
        to: "",
        subject: `${org} — ${title}`,
        body: emailBody,
      },
      enabled: true,
    },
    {
      node_key: "action-3",
      type: "action",
      kind: "log_database",
      label: "Log run",
      position_x: 360,
      position_y: 580,
      config: {
        ...specFor("log_database").defaultConfig,
        message: `Use-case workflow run for ${requirement.code} on project ${project.id}`,
        level: "info",
      },
      enabled: true,
    },
  ];
  const edges: WorkflowEdge[] = [
    { edge_key: "e1", from_node_key: "trigger-1", to_node_key: "action-1", from_port: null, label: null },
    { edge_key: "e2", from_node_key: "action-1", to_node_key: "action-2", from_port: null, label: null },
    { edge_key: "e3", from_node_key: "action-2", to_node_key: "action-3", from_port: null, label: null },
  ];

  return {
    name: `${org} — ${title}`,
    description:
      `Use-case skeleton generated from the accepted handoff package for ${org} ` +
      `(requirement ${requirement.code}). Draft — review it, publish it, and run it ` +
      `from Automations to live-test delivery for this use case.`,
    trigger_config: {
      projectId: project.id,
      packageId: input.packageId,
      requirementId: requirement.id,
      requirementCode: requirement.code,
    },
    nodes,
    edges,
  };
}

/** The project's stored handoff package (its charter source), or null. */
async function getStoredProjectPackage(
  db: NeonClient,
  projectId: string,
): Promise<LeadEngineHandoffPackage | null> {
  const rows = await q(db)`
    select i.package
    from public.delivery_projects p
    join public.handoff_inbox i on i.id = p.inbox_id
    where p.id = ${projectId}::uuid
    limit 1`;
  const pkg = rows[0]?.package;
  return (pkg ?? null) as LeadEngineHandoffPackage | null;
}

/**
 * Whether a requirement may become a skeleton: it must be
 * human-validated — status "validated" AND an identified
 * humanValidatorId. The intake freeze gate enforces this only for
 * Must requirements, so a valid package can carry lesser
 * requirements in draft/proposed/needs_clarification states; those
 * never get a workflow or a client email here.
 */
export function isGeneratableRequirement(
  requirement: HandoffRequirement,
): boolean {
  return (
    requirement.status === "validated" &&
    typeof requirement.humanValidatorId === "string" &&
    requirement.humanValidatorId.trim().length > 0
  );
}

/** The skeleton already generated for (project, requirement), if any. */
async function findUseCaseWorkflow(
  db: NeonClient,
  environment: DeliveryEnvironment,
  projectId: string,
  requirementId: string,
  requirementCode: string,
): Promise<UseCaseSkeleton | null> {
  const rows = await q(db)`
    select id, name, status
    from public.workflows
    where environment = ${environment}
      and trigger_config->>'projectId' = ${projectId}
      and trigger_config->>'requirementId' = ${requirementId}
    order by created_at asc
    limit 1`;
  if (!rows.length) return null;
  return {
    id: String(rows[0].id),
    name: String(rows[0].name),
    status: String(rows[0].status),
    requirementCode,
  };
}

/** Every skeleton generated for a project, oldest first. */
export async function listProjectUseCaseWorkflows(
  db: NeonClient,
  projectId: string,
  environment: DeliveryEnvironment,
): Promise<UseCaseSkeleton[]> {
  const rows = await q(db)`
    select id, name, status, trigger_config
    from public.workflows
    where environment = ${environment}
      and trigger_config->>'projectId' = ${projectId}
    order by created_at asc`;
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    status: String(r.status),
    requirementCode: String(
      (r.trigger_config as Record<string, unknown> | null)
        ?.requirementCode ?? "",
    ),
  }));
}

/** The node keys every complete skeleton graph carries. */
const SKELETON_NODE_KEYS = ["trigger-1", "action-1", "action-2", "action-3"];

interface SkeletonAssessment {
  complete: boolean;
  /**
   * True only for provably untouched machine state: incomplete
   * graph, zero runs, and the workflow row never updated since
   * creation. The check is EXACT equality of the parsed timestamps:
   * both columns are stamped by the same insert's now() — one
   * transaction timestamp, microsecond-identical in Postgres — and
   * the trg_workflows_touch trigger bumps updated_at on ANY update,
   * so any positive delta, however small, is an operator's edit
   * and protects the draft. Freshness is deliberately NOT evidence:
   * an operator can edit a draft seconds after creating it (Codex
   * on PR #60, rounds 2–4).
   */
  repairable: boolean;
}

/**
 * Assess a stored skeleton. createWorkflow writes the workflow row
 * and its graph in separate statements, so a failure mid-create can
 * leave a row with a partial graph; such an orphan must be repaired,
 * never adopted as done — but an incomplete graph alone does not
 * prove abandonment, so repair demands the untouched-state evidence
 * described on SkeletonAssessment.
 */
async function assessSkeleton(
  db: NeonClient,
  workflowId: string,
): Promise<SkeletonAssessment> {
  const workflow = await getWorkflow(db, workflowId);
  if (!workflow) return { complete: false, repairable: false };
  const keys = new Set(workflow.nodes.map((n) => n.node_key));
  const complete =
    SKELETON_NODE_KEYS.every((key) => keys.has(key)) &&
    workflow.edges.length >= SKELETON_NODE_KEYS.length - 1;
  if (complete) return { complete: true, repairable: false };
  const runRows = await q(db)`
    select count(*)::int as runs
    from public.workflow_runs
    where workflow_id = ${workflowId}`;
  const runs = Number(runRows[0]?.runs ?? 0);
  if (runs > 0) return { complete: false, repairable: false };
  const createdAt = Date.parse(workflow.created_at);
  const updatedAt = Date.parse(workflow.updated_at);
  const neverUpdated =
    Number.isFinite(createdAt) &&
    Number.isFinite(updatedAt) &&
    updatedAt === createdAt;
  return { complete: false, repairable: neverUpdated };
}

function toSkeleton(workflow: Workflow, requirementCode: string): UseCaseSkeleton {
  return {
    id: workflow.id,
    name: workflow.name,
    status: workflow.status,
    requirementCode,
  };
}

/**
 * Delete a skeleton ONLY if it is still provably untouched — the
 * untouched conditions are revalidated inside the delete statement
 * itself, so an operator save (or a first run) landing between the
 * assessment and the delete makes the delete a no-op instead of
 * erasing their work (the TOCTOU window Codex flagged on PR #60).
 * Draft/archived only, as with the lib's deleteWorkflow; the graph
 * and any child rows cascade.
 */
async function deleteUntouchedSkeleton(
  db: NeonClient,
  workflowId: string,
): Promise<boolean> {
  const rows = await q(db)`
    delete from public.workflows w
    where w.id = ${workflowId}
      and w.status in ('draft', 'archived')
      and w.updated_at = w.created_at
      and not exists (
        select 1 from public.workflow_runs r where r.workflow_id = w.id
      )
    returning w.id`;
  return rows.length > 0;
}

/**
 * Create one skeleton, recovering from the two ways a create can go
 * wrong concurrently or partially (Codex on PR #60):
 * - a concurrent generator won the race — the unique index rejects
 *   this insert; adopt the winner's complete row;
 * - the insert (or a rival's) died mid-graph — the row exists with a
 *   partial graph; regenerate it, but only when the assessment proves
 *   it untouched machine state (an operator's draft is adopted
 *   as-is instead, never erased).
 * A genuine second failure propagates to the caller.
 */
async function createSkeletonWithRecovery(
  db: NeonClient,
  project: UseCaseWorkflowProjectRef,
  draft: UseCaseWorkflowDraft,
  requirement: HandoffRequirement,
  createdBy: string,
): Promise<{ skeleton: UseCaseSkeleton; adopted: boolean }> {
  const input = {
    name: draft.name,
    description: draft.description,
    environment: project.environment,
    trigger_type: "manual" as const,
    trigger_config: draft.trigger_config,
    created_by: createdBy,
    nodes: draft.nodes,
    edges: draft.edges,
  };
  try {
    const workflow = await createWorkflow(db, input);
    return {
      skeleton: toSkeleton(workflow, requirement.code),
      adopted: false,
    };
  } catch (error) {
    const rival = await findUseCaseWorkflow(
      db,
      project.environment,
      project.id,
      requirement.id,
      requirement.code,
    );
    if (!rival) throw error;
    const assessment = await assessSkeleton(db, rival.id);
    if (assessment.complete || !assessment.repairable) {
      return { skeleton: rival, adopted: true };
    }
    const removed = await deleteUntouchedSkeleton(db, rival.id).catch(
      () => false,
    );
    if (!removed) return { skeleton: rival, adopted: true };
    const workflow = await createWorkflow(db, input);
    return {
      skeleton: toSkeleton(workflow, requirement.code),
      adopted: false,
    };
  }
}

/**
 * Ensure one draft skeleton exists per requirement in the project's
 * stored handoff package. Idempotent: requirements that already have
 * a complete skeleton in the project's environment are reported
 * under `existing` and never duplicated. A project with no package —
 * or a package whose baseline is empty — creates nothing.
 *
 * Success measures pair with requirements positionally over the
 * FULL baseline (see the pairing note in the body): LE builds both
 * arrays from the same approved use-case rows in the same order,
 * keeping only rows that carry a measure — so the pairing is exact
 * when the counts cover the whole baseline (the shipped shape),
 * and no pairing is claimed when they do not.
 */
export async function ensureUseCaseWorkflows(
  db: NeonClient,
  project: UseCaseWorkflowProjectRef,
  options: { createdBy?: string } = {},
): Promise<EnsureUseCaseWorkflowsResult> {
  const created: UseCaseSkeleton[] = [];
  const existing: UseCaseSkeleton[] = [];
  const pkg = await getStoredProjectPackage(db, project.id);
  if (!pkg) return { created, existing };
  const allRequirements = pkg.requirementBaseline?.requirements ?? [];
  const measures = pkg.successMeasures ?? [];
  // Measures pair with requirements POSITIONALLY over the FULL
  // baseline: the contract's two arrays carry no linkage ids, so a
  // pairing is only sound when the measures array covers every
  // baseline requirement, and each requirement keeps its ORIGINAL
  // index. Pairing after filtering would silently hand one
  // requirement's metric to another whenever an ungeneratable
  // requirement precedes a generatable one (Codex on PR #60).
  const pairMeasures = measures.length === allRequirements.length;
  const createdBy = options.createdBy ?? "intake-skeleton";

  for (const [index, requirement] of allRequirements.entries()) {
    if (!isGeneratableRequirement(requirement)) continue;
    const found = await findUseCaseWorkflow(
      db,
      project.environment,
      project.id,
      requirement.id,
      requirement.code,
    );
    if (found) {
      const assessment = await assessSkeleton(db, found.id);
      if (assessment.complete || !assessment.repairable) {
        existing.push(found);
        continue;
      }
      // A partial orphan from a create that died mid-graph, proven
      // untouched: remove it and fall through to regeneration. If it
      // can no longer be deleted (an operator published it), it has
      // been taken over — report it as-is.
      const removed = await deleteUntouchedSkeleton(db, found.id).catch(
        () => false,
      );
      if (!removed) {
        existing.push(found);
        continue;
      }
    }
    const draft = buildUseCaseWorkflowDraft({
      project,
      packageId: pkg.packageId,
      requirement,
      successMeasure: pairMeasures ? measures[index] : undefined,
    });
    const { skeleton, adopted } = await createSkeletonWithRecovery(
      db,
      project,
      draft,
      requirement,
      createdBy,
    );
    (adopted ? existing : created).push(skeleton);
  }
  return { created, existing };
}

/**
 * Intake-path entry point: generate skeletons for a freshly accepted
 * package. FAIL-OPEN by construction — package acceptance has already
 * been decided by the time this runs, so any failure here (the
 * project lookup, the package read, a create) is logged and reported
 * as null, never thrown; the published-workflow trigger that follows
 * in the intake hook is unaffected either way.
 */
export async function generateUseCaseWorkflowsForAcceptedPackage(
  db: NeonClient,
  pkg: LeadEngineHandoffPackage,
  environment: DeliveryEnvironment,
): Promise<EnsureUseCaseWorkflowsResult | null> {
  try {
    const projectId = await getProjectIdForPackage(db, pkg.packageId);
    if (!projectId) return null;
    const rows = await q(db)`
      select id, environment, package_id, organization_name
      from public.delivery_projects
      where id = ${projectId}::uuid
      limit 1`;
    const row = rows[0];
    if (!row) return null;
    const project: UseCaseWorkflowProjectRef = {
      id: String(row.id),
      environment: (row.environment as DeliveryEnvironment) ?? environment,
      package_id: String(row.package_id),
      organization_name: String(row.organization_name),
    };
    const result = await ensureUseCaseWorkflows(db, project, {
      createdBy: "intake-skeleton",
    });
    if (result.created.length > 0) {
      log("info", "usecase_skeletons_generated", {
        projectId: project.id,
        packageId: pkg.packageId,
        environment: project.environment,
        created: result.created.map((s) => s.requirementCode),
        existing: result.existing.map((s) => s.requirementCode),
      });
    }
    return result;
  } catch (error) {
    log("warn", "usecase_skeleton_generation_failed", {
      packageId: pkg.packageId,
      environment,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
