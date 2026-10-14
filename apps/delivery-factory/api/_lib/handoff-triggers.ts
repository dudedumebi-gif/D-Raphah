/**
 * Lead-handoff workflow triggers for the Delivery Factory.
 *
 * When POST /api/intake accepts a handoff package, every published workflow
 * with trigger_type = 'lead_handoff' is offered the package as its trigger
 * payload. Draft-first is structural: the intake path runs the engine with
 * no provider hooks, so send_email / send_sms / ai_assist nodes record
 * drafts for human approval — nothing can send.
 *
 * This module never imports from apps/leads-engine; the package arrives
 * through the versioned handoff contract only.
 */

import type { LeadEngineHandoffPackage } from "@raphah/handoff-contract";
import type { DeliveryDb, DeliveryEnvironment, NeonClient } from "./db.js";
import { transitionProjectStage } from "./projects.js";
import type { IntakeEnv } from "./verify.js";
import {
  buildLeadHandoffTriggerPayload,
  executeWorkflow,
  findLeadHandoffRunForPackage,
  listPublishedWorkflowsByTrigger,
  type TriggerableWorkflow,
} from "./workflows.js";

/**
 * Whether a lead_handoff workflow's minScore gate allows auto-execution for
 * a lead with the given score. A gate of 0 (or unset) means "always run".
 *
 * The v1 handoff contract carries no numeric lead score, so a positive gate
 * can never be verified — "unknown" never counts as passing, and the
 * workflow does not auto-run. The operator can still run it manually from
 * the Automations UI.
 */
export function leadHandoffMinScoreAllows(
  triggerConfig: Record<string, unknown> | null,
  leadScore: number | undefined,
): boolean {
  const raw = triggerConfig?.minScore;
  const minScore =
    typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  if (minScore <= 0) return true;
  return leadScore != null && leadScore >= minScore;
}

export interface LeadHandoffTriggerResult {
  executed: string[];
  skipped: string[];
}

/**
 * Runs every published 'lead_handoff' workflow *in the given environment
 * scope* against a freshly-accepted handoff package. Environment isolation
 * is structural: a production accept only ever fires production workflows,
 * and a demo/test accept only demo workflows. Per-workflow failure
 * isolation: one broken workflow is recorded in the aggregate error but
 * never blocks the others. Throws when any workflow failed so the caller
 * can log + audit the failure — the intake acceptance itself is unaffected
 * (see handleIntake).
 */
export async function triggerLeadHandoffWorkflows(
  db: NeonClient,
  pkg: LeadEngineHandoffPackage,
  environment: DeliveryEnvironment,
): Promise<LeadHandoffTriggerResult> {
  const workflows = await listPublishedWorkflowsByTrigger(
    db,
    "lead_handoff",
    environment,
  );
  const payload = buildLeadHandoffTriggerPayload(pkg);
  const executed: string[] = [];
  const skipped: string[] = [];
  const failures: Array<{ workflowId: string; error: string }> = [];

  for (const wf of workflows) {
    if (!leadHandoffMinScoreAllows(wf.trigger_config, payload.lead.score)) {
      skipped.push(wf.id);
      continue;
    }
    try {
      await executeWorkflow(
        db,
        wf.id,
        payload as unknown as Record<string, unknown>,
      );
      executed.push(wf.id);
    } catch (error) {
      failures.push({
        workflowId: wf.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `lead_handoff trigger failures: ${failures
        .map((f) => `${f.workflowId}: ${f.error}`)
        .join("; ")}`,
    );
  }
  return { executed, skipped };
}

/* ── Manual begin from the project (Intake page) ──────────────────────
 * The intake trigger above only fires when a package is accepted. When
 * no published lead_handoff workflow existed in the environment at
 * accept time, the package still processes and the project sits at
 * stage 'intake' with nothing started — and until now there was no
 * project-level surface to start one. beginProjectWorkflow is that
 * surface: the operator picks (or accepts the single) published
 * lead_handoff workflow for the project's environment and runs it
 * against the project's stored handoff package, with exactly the
 * intake path's posture — same payload shape, same minScore gate,
 * draft-first (no provider hooks, so send nodes record drafts).
 * Starting the workflow is what moves the project out of intake, so a
 * project still at 'intake' advances to 'onboarding'.
 */

export type BeginWorkflowResolution =
  | { kind: "ready"; workflow: TriggerableWorkflow }
  | { kind: "none_published" }
  | { kind: "ambiguous"; choices: TriggerableWorkflow[] }
  | { kind: "not_available"; requestedId: string };

/**
 * Pure chooser for the manual begin: an explicit id must be one of the
 * published lead_handoff workflows in scope; with no id, exactly one
 * published workflow is required — zero is "none published" and more
 * than one is ambiguous (the caller lists the choices).
 */
export function resolveBeginWorkflow(
  published: TriggerableWorkflow[],
  requestedId?: string,
): BeginWorkflowResolution {
  if (requestedId) {
    const workflow = published.find((wf) => wf.id === requestedId);
    return workflow
      ? { kind: "ready", workflow }
      : { kind: "not_available", requestedId };
  }
  if (published.length === 0) return { kind: "none_published" };
  if (published.length === 1) return { kind: "ready", workflow: published[0] };
  return { kind: "ambiguous", choices: published };
}

export interface ProjectBeginState {
  stage: string;
  environment: DeliveryEnvironment;
  publishedWorkflows: Array<{ id: string; name: string }>;
}

/** What the project's begin surface needs: stage + the workflows an
 *  operator could start for this project (its own environment scope). */
export async function getProjectBeginState(
  db: DeliveryDb,
  sql: NeonClient,
  projectId: string,
): Promise<ProjectBeginState> {
  const project = await db.getProject(projectId);
  if (!project)
    throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  const published = await listPublishedWorkflowsByTrigger(
    sql,
    "lead_handoff",
    project.environment,
  );
  return {
    stage: project.current_stage,
    environment: project.environment,
    publishedWorkflows: published.map((wf) => ({ id: wf.id, name: wf.name })),
  };
}

export interface BeginProjectWorkflowResult {
  workflowId: string;
  workflowName: string;
  runId: string;
  stage: string;
  /** True when the workflow already had a live run for this package
   *  (e.g. started by the intake trigger at accept time) and this
   *  begin simply adopted it instead of executing a duplicate. */
  alreadyStarted: boolean;
}

export async function beginProjectWorkflow(
  db: DeliveryDb,
  sql: NeonClient,
  input: {
    projectId: string;
    workflowId?: string;
    changedBy?: string;
    environment: IntakeEnv["environment"];
  },
): Promise<BeginProjectWorkflowResult> {
  const project = await db.getProject(input.projectId);
  if (!project)
    throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  const pkgData = await db.getProjectPackage(input.projectId);
  if (!pkgData) {
    throw Object.assign(
      new Error(
        "This project has no handoff package, so there is nothing to offer a lead-handoff workflow.",
      ),
      { statusCode: 409 },
    );
  }
  const published = await listPublishedWorkflowsByTrigger(
    sql,
    "lead_handoff",
    project.environment,
  );
  const resolution = resolveBeginWorkflow(published, input.workflowId);
  if (resolution.kind === "none_published") {
    throw Object.assign(
      new Error(
        `No lead-handoff workflow is published in the ${project.environment} environment. ` +
          "Publish one under Workflows / Automations — new packages will then be offered to it automatically at intake, and it can be started here manually.",
      ),
      { statusCode: 409 },
    );
  }
  if (resolution.kind === "ambiguous") {
    throw Object.assign(
      new Error(
        "More than one lead-handoff workflow is published in this environment; choose one: " +
          resolution.choices.map((wf) => `${wf.name} (${wf.id})`).join(", "),
      ),
      { statusCode: 400 },
    );
  }
  if (resolution.kind === "not_available") {
    throw Object.assign(
      new Error(
        `Workflow ${resolution.requestedId} is not a published lead-handoff workflow in the ${project.environment} environment.`,
      ),
      { statusCode: 400 },
    );
  }
  const workflow = resolution.workflow;
  const pkg = pkgData.package;

  // Idempotency: a package accepted while this workflow was already
  // published was already offered to it by the intake trigger, which
  // leaves the project at 'intake' with no started marker. Adopt that
  // run instead of executing the workflow a second time.
  const existing = await findLeadHandoffRunForPackage(sql, {
    workflowId: workflow.id,
    packageId: pkg.packageId,
    environment: project.environment,
  });

  let runId: string;
  let alreadyStarted = false;
  if (existing) {
    runId = existing.id;
    alreadyStarted = true;
  } else {
    const payload = buildLeadHandoffTriggerPayload(pkg);
    if (!leadHandoffMinScoreAllows(workflow.trigger_config, payload.lead.score)) {
      const gate = (workflow.trigger_config as Record<string, unknown> | null)
        ?.minScore;
      throw Object.assign(
        new Error(
          `Workflow "${workflow.name}" requires a minimum lead score of ${String(gate)}, ` +
            "but the v1 handoff package carries no numeric lead score, so the gate cannot be verified. " +
            "Lower the workflow's minimum score gate, or run it from Automations instead.",
        ),
        { statusCode: 409 },
      );
    }
    const run = await executeWorkflow(
      sql,
      workflow.id,
      payload as unknown as Record<string, unknown>,
    );
    // executeWorkflow resolves even when the run failed (the failure
    // is recorded on the run). A failed/cancelled run means delivery
    // did not start: report it and keep the project at intake so the
    // operator can fix the workflow and begin again.
    if (run.status === "failed" || run.status === "cancelled") {
      throw Object.assign(
        new Error(
          `Workflow "${workflow.name}" run ${run.status}` +
            (run.error ? `: ${run.error}` : "") +
            ` (run ${run.id}). The project stays at intake — inspect the run under Workflows → ${workflow.name} → Runs, fix the workflow, and begin again.`,
        ),
        { statusCode: 502 },
      );
    }
    runId = run.id;
  }

  let stage = project.current_stage;
  if (stage === "intake") {
    const updated = await transitionProjectStage(db, {
      projectId: project.id,
      toStage: "onboarding",
      changedBy: input.changedBy,
      environment: input.environment,
    });
    stage = updated.current_stage;
  }
  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    runId,
    stage,
    alreadyStarted,
  };
}
