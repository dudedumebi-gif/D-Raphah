import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { NeonClient, ProjectRow } from "../api/_lib/db.js";
import {
  beginProjectWorkflow,
  getProjectBeginState,
  resolveBeginWorkflow,
  triggerLeadHandoffWorkflows,
} from "../api/_lib/handoff-triggers.js";
import type { TriggerableWorkflow } from "../api/_lib/workflows.js";
import { FakeDeliveryDb } from "./fake-db.js";
import { packageBase, signTestPackage } from "./helpers.js";

/**
 * Manual begin of a project's delivery workflow (the Intake surface):
 * when no lead_handoff workflow was published at accept time, the
 * operator starts one from the project. Resolution rules, the minScore
 * gate, and the intake -> onboarding advance are covered here with the
 * in-memory DeliveryDb fake plus a fake Neon tag client for the
 * workflow engine, mirroring handoff-triggers.test.ts.
 */

function triggerable(
  overrides: Partial<TriggerableWorkflow> = {},
): TriggerableWorkflow {
  return {
    id: randomUUID(),
    name: "Lead follow-up",
    environment: "production",
    trigger_config: { minScore: 0 },
    ...overrides,
  };
}

describe("resolveBeginWorkflow", () => {
  it("reports none published when the scope is empty", () => {
    expect(resolveBeginWorkflow([])).toEqual({ kind: "none_published" });
    expect(resolveBeginWorkflow([], "wf-x")).toEqual({
      kind: "not_available",
      requestedId: "wf-x",
    });
  });

  it("auto-selects the single published workflow", () => {
    const wf = triggerable();
    expect(resolveBeginWorkflow([wf])).toEqual({ kind: "ready", workflow: wf });
  });

  it("is ambiguous with several published workflows and no choice", () => {
    const a = triggerable({ name: "A" });
    const b = triggerable({ name: "B" });
    const result = resolveBeginWorkflow([a, b]);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous")
      expect(result.choices.map((c) => c.id)).toEqual([a.id, b.id]);
  });

  it("honors an explicit choice among several", () => {
    const a = triggerable({ name: "A" });
    const b = triggerable({ name: "B" });
    expect(resolveBeginWorkflow([a, b], b.id)).toEqual({
      kind: "ready",
      workflow: b,
    });
  });

  it("rejects an explicit id that is not among the published workflows", () => {
    const a = triggerable();
    expect(resolveBeginWorkflow([a], "wf-foreign")).toEqual({
      kind: "not_available",
      requestedId: "wf-foreign",
    });
  });
});

/* ── Engine fake ───────────────────────────────────────────────────── */

interface FixtureWorkflow {
  id: string;
  name: string;
  status: string;
  environment: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}

function fixtureWorkflow(
  overrides: Partial<FixtureWorkflow> = {},
): FixtureWorkflow {
  return {
    id: randomUUID(),
    name: "Lead follow-up",
    status: "published",
    environment: "production",
    trigger_type: "lead_handoff",
    trigger_config: { minScore: 0 },
    nodes: [
      {
        node_key: "trigger-1", type: "trigger", kind: "lead_handoff",
        label: "Lead Handoff", position_x: 0, position_y: 0,
        config: {}, enabled: true,
      },
      {
        node_key: "action-1", type: "action", kind: "log_database",
        label: "Log follow-up drafted", position_x: 0, position_y: 0,
        config: {
          message: "Follow-up drafted for {{trigger.lead.name}}",
          level: "info",
        },
        enabled: true,
      },
    ],
    edges: [
      { edge_key: "e1", from_node_key: "trigger-1", to_node_key: "action-1", from_port: null, label: null },
    ],
    ...overrides,
  };
}

/** Fake Neon tag client for the workflow engine queries, matched on the
 *  leading SQL fragment like handoff-triggers.test.ts. */
interface FixtureStart {
  id: string;
  project_id: string;
  workflow_id: string;
  package_id: string;
  environment: string;
  run_id: string | null;
  state: string;
  created_at: Date;
  updated_at: Date;
}

function makeEngineDb(workflows: FixtureWorkflow[]) {
  const byId = new Map(workflows.map((w) => [w.id, w]));
  const runs = new Map<string, Record<string, unknown>>();
  const steps: Array<Record<string, unknown>> = [];
  // project_workflow_starts, keyed like the table's unique
  // (project_id, workflow_id) constraint.
  const starts = new Map<string, FixtureStart>();
  const projectsByPackage = new Map<string, string>();
  const startKey = (projectId: unknown, workflowId: unknown) =>
    `${String(projectId)}|${String(workflowId)}`;

  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0];
    if (head.includes("from public.workflows") && head.includes("trigger_type =")) {
      const triggerType = String(values[0]);
      const environment = String(values[1]);
      return [...byId.values()]
        .filter(
          (w) =>
            w.trigger_type === triggerType &&
            w.status === "published" &&
            w.environment === environment,
        )
        .map((w) => ({
          id: w.id,
          name: w.name,
          trigger_config: w.trigger_config,
          environment: w.environment,
        }));
    }
    if (head.includes("from public.workflows where id =")) {
      const w = byId.get(String(values[0]));
      if (!w) return [];
      return [{
        id: w.id, name: w.name, description: null, status: w.status,
        environment: w.environment, trigger_type: w.trigger_type,
        trigger_config: w.trigger_config, created_by: "seed",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        published_at: new Date().toISOString(),
      }];
    }
    if (
      head.includes("from public.workflows") &&
      head.includes("skeleton_node_kinds")
    ) {
      // listProjectUseCaseWorkflows: values are environment, projectId.
      return [...byId.values()]
        .filter(
          (w) =>
            w.environment === String(values[0]) &&
            w.trigger_config?.projectId === String(values[1]),
        )
        .map((w) => ({
          id: w.id,
          name: w.name,
          status: w.status,
          trigger_config: w.trigger_config,
          skeleton_node_kinds: new Set(
            (w.nodes ?? [])
              .map((n) => String(n.node_key))
              .filter((k) =>
                ["trigger-1", "action-1", "action-2", "action-3"].includes(k),
              ),
          ).size,
          skeleton_edges: (w.edges ?? []).length,
        }));
    }
    if (head.includes("from public.workflow_nodes")) {
      return byId.get(String(values[0]))?.nodes ?? [];
    }
    if (head.includes("from public.workflow_edges")) {
      return byId.get(String(values[0]))?.edges ?? [];
    }
    if (head.includes("insert into public.workflow_runs")) {
      const id = randomUUID();
      runs.set(id, {
        id,
        workflow_id: values[0],
        trigger_type: values[1],
        trigger_payload: JSON.parse(String(values[2])),
        environment: values[3],
        status: "running",
        output: null,
        error: null,
        started_at: new Date().toISOString(),
      });
      return [{ id, started_at: new Date().toISOString() }];
    }
    if (head.includes("insert into public.workflow_run_steps")) {
      const id = randomUUID();
      steps.push({
        id,
        run_id: values[0],
        node_key: values[1],
        node_kind: values[2],
        node_label: values[3],
        status: values[4],
        input: values[5] ? JSON.parse(String(values[5])) : null,
        output: values[6] ? JSON.parse(String(values[6])) : null,
        error: values[7],
      });
      return [{ id }];
    }
    if (head.includes("update public.workflow_run_steps")) {
      const step = steps.find((s) => s.id === values[3]);
      if (step) {
        step.status = values[0];
        step.output = values[1] ? JSON.parse(String(values[1])) : null;
        step.error = values[2];
      }
      return [];
    }
    if (head.includes("insert into public.workflow_audit_log")) {
      return [];
    }
    if (head.includes("update public.workflow_runs")) {
      const run = runs.get(String(values[3]));
      if (run) {
        run.status = values[0];
        run.error = values[1];
        run.output = values[2] ? JSON.parse(String(values[2])) : null;
      }
      return [];
    }
    if (
      head.includes("from public.workflow_runs") &&
      head.includes("where workflow_id =")
    ) {
      // findLeadHandoffRunForPackage: values are workflow id,
      // environment, package id (in query order).
      const match = [...runs.values()].find(
        (run) =>
          run.workflow_id === values[0] &&
          run.environment === values[1] &&
          run.trigger_type === "lead_handoff" &&
          run.status !== "failed" &&
          run.status !== "cancelled" &&
          (run.trigger_payload as { package?: { packageId?: string } })
            ?.package?.packageId === values[2],
      );
      return match ? [{ id: match.id, status: match.status }] : [];
    }
    if (head.includes("from public.workflow_runs where id =")) {
      const run = runs.get(String(values[0]));
      if (!run) return [];
      return [{
        ...run,
        completed_at: new Date().toISOString(),
      }];
    }
    if (head.includes("from public.workflow_run_steps")) {
      return steps.filter((s) => s.run_id === String(values[0]));
    }
    if (head.includes("insert into public.project_workflow_starts")) {
      // claimProjectWorkflowStart: ON CONFLICT DO NOTHING semantics.
      const key = startKey(values[0], values[1]);
      if (starts.has(key)) return [];
      const row: FixtureStart = {
        id: randomUUID(),
        project_id: String(values[0]),
        workflow_id: String(values[1]),
        package_id: String(values[2]),
        environment: String(values[3]),
        run_id: values[4] ? String(values[4]) : null,
        state: String(values[5]),
        created_at: new Date(),
        updated_at: new Date(),
      };
      starts.set(key, row);
      return [{ id: row.id }];
    }
    if (head.includes("from public.project_workflow_starts")) {
      const row = starts.get(startKey(values[0], values[1]));
      return row ? [{ ...row }] : [];
    }
    if (
      head.includes("update public.project_workflow_starts") &&
      head.includes("set run_id = null, state = 'reserved'")
    ) {
      // claimFailedRunRetry: one conditional update keyed on the
      // observed (state, run_id) — values are row id, run id.
      const row = [...starts.values()].find((s) => s.id === values[0]);
      if (!row || row.state !== "reserved" || row.run_id !== String(values[1]))
        return [];
      row.run_id = null;
      row.updated_at = new Date();
      return [{ id: row.id }];
    }
    if (
      head.includes("from public.delivery_projects") &&
      head.includes("package_id =")
    ) {
      // getProjectIdForPackage — seeded by the trigger tests.
      const pid = projectsByPackage.get(String(values[0]));
      return pid ? [{ id: pid }] : [];
    }
    if (
      head.includes("update public.project_workflow_starts") &&
      head.includes("set run_id =")
    ) {
      // settleProjectWorkflowStart: values are run id, state, row id.
      const row = [...starts.values()].find((s) => s.id === values[2]);
      if (row) {
        row.run_id = values[0] ? String(values[0]) : null;
        row.state = String(values[1]);
        row.updated_at = new Date();
      }
      return [];
    }
    if (
      head.includes("update public.project_workflow_starts") &&
      head.includes("set state = 'reserved'")
    ) {
      // retryProjectWorkflowStart: only a 'failed' row can be claimed.
      const row = [...starts.values()].find((s) => s.id === values[0]);
      if (!row || row.state !== "failed") return [];
      row.state = "reserved";
      row.run_id = null;
      row.updated_at = new Date();
      return [{ id: row.id }];
    }
    if (
      head.includes("update public.project_workflow_starts") &&
      head.includes("set created_at = now()")
    ) {
      // reclaimStaleProjectWorkflowStart: reserved, runless, and the
      // claim is older than ten minutes.
      const row = [...starts.values()].find((s) => s.id === values[0]);
      if (
        !row ||
        row.state !== "reserved" ||
        row.run_id !== null ||
        Date.now() - row.updated_at.getTime() <= 10 * 60 * 1000
      )
        return [];
      row.created_at = new Date();
      row.updated_at = new Date();
      return [{ id: row.id }];
    }
    throw new Error(`Unexpected query: ${head.slice(0, 100)}`);
  }) as unknown as NeonClient;

  return { db, runs, steps, starts, projectsByPackage };
}

function seedStart(
  engine: ReturnType<typeof makeEngineDb>,
  overrides: Partial<FixtureStart> & { project_id: string; workflow_id: string },
): FixtureStart {
  const row: FixtureStart = {
    id: randomUUID(),
    package_id: randomUUID(),
    environment: "production",
    run_id: null,
    state: "reserved",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
  engine.starts.set(`${row.project_id}|${row.workflow_id}`, row);
  return row;
}

async function seedProject(db: FakeDeliveryDb) {
  const signed = signTestPackage(packageBase());
  const { project } = await db.createInboxAndProject({
    idempotencyKey: `test-${randomUUID()}`,
    pkg: signed.pkg,
    manifestChecksum: signed.manifestChecksum,
    signature: signed.signature,
    environment: "production",
  });
  return { project, pkg: signed.pkg };
}

async function expectBeginError(
  promise: Promise<unknown>,
  statusCode: number,
  messagePart: string,
) {
  try {
    await promise;
  } catch (error) {
    expect((error as { statusCode?: number }).statusCode).toBe(statusCode);
    expect((error as Error).message).toContain(messagePart);
    return;
  }
  throw new Error(`Expected begin to fail with ${statusCode}`);
}

describe("beginProjectWorkflow", () => {
  it("404s for an unknown project", async () => {
    const db = new FakeDeliveryDb();
    const engine = makeEngineDb([fixtureWorkflow()]);
    await expectBeginError(
      beginProjectWorkflow(db, engine.db, {
        projectId: randomUUID(),
        environment: "production",
      }),
      404,
      "Project not found",
    );
  });

  it("409s when the project has no handoff package", async () => {
    const db = new FakeDeliveryDb();
    const orphan: ProjectRow = {
      id: randomUUID(),
      inbox_id: randomUUID(),
      package_id: randomUUID(),
      package_version: 1,
      opportunity_id: randomUUID(),
      organization_name: "Synthetic",
      name: "Synthetic",
      status: "active",
      environment: "production",
      current_stage: "intake",
      baseline_version: 1,
      requirements_count: 0,
      features_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.projects.set(orphan.id, orphan);
    const engine = makeEngineDb([fixtureWorkflow()]);
    await expectBeginError(
      beginProjectWorkflow(db, engine.db, {
        projectId: orphan.id,
        environment: "production",
      }),
      409,
      "no handoff package",
    );
  });

  it("409s when no lead-handoff workflow is published in the project's environment", async () => {
    const db = new FakeDeliveryDb();
    const { project } = await seedProject(db);
    // A published workflow exists, but only in demo scope.
    const engine = makeEngineDb([fixtureWorkflow({ environment: "demo" })]);
    await expectBeginError(
      beginProjectWorkflow(db, engine.db, {
        projectId: project.id,
        environment: "production",
      }),
      409,
      "No lead-handoff workflow is published in the production environment",
    );
    expect(engine.runs.size).toBe(0);
    expect(db.projects.get(project.id)?.current_stage).toBe("intake");
  });

  it("400s listing the choices when several are published and none is chosen", async () => {
    const db = new FakeDeliveryDb();
    const { project } = await seedProject(db);
    const engine = makeEngineDb([
      fixtureWorkflow({ name: "Alpha follow-up" }),
      fixtureWorkflow({ name: "Beta follow-up" }),
    ]);
    await expectBeginError(
      beginProjectWorkflow(db, engine.db, {
        projectId: project.id,
        environment: "production",
      }),
      400,
      "Alpha follow-up",
    );
    expect(engine.runs.size).toBe(0);
  });

  it("400s for an explicit workflow id that is not published in scope", async () => {
    const db = new FakeDeliveryDb();
    const { project } = await seedProject(db);
    const engine = makeEngineDb([fixtureWorkflow()]);
    await expectBeginError(
      beginProjectWorkflow(db, engine.db, {
        projectId: project.id,
        workflowId: randomUUID(),
        environment: "production",
      }),
      400,
      "is not a published lead-handoff workflow",
    );
  });

  it("409s when the workflow's minScore gate cannot be verified for a v1 package", async () => {
    const db = new FakeDeliveryDb();
    const { project } = await seedProject(db);
    const engine = makeEngineDb([
      fixtureWorkflow({ trigger_config: { minScore: 80 } }),
    ]);
    await expectBeginError(
      beginProjectWorkflow(db, engine.db, {
        projectId: project.id,
        environment: "production",
      }),
      409,
      "cannot be verified",
    );
    expect(engine.runs.size).toBe(0);
    expect(db.projects.get(project.id)?.current_stage).toBe("intake");
  });

  it("runs the single published workflow against the package and advances intake -> onboarding", async () => {
    const db = new FakeDeliveryDb();
    const { project, pkg } = await seedProject(db);
    const wf = fixtureWorkflow();
    const engine = makeEngineDb([wf]);

    const result = await beginProjectWorkflow(db, engine.db, {
      projectId: project.id,
      changedBy: "operator@example.com",
      environment: "production",
    });

    expect(result.workflowId).toBe(wf.id);
    expect(result.stage).toBe("onboarding");
    const run = engine.runs.get(result.runId);
    expect(run).toBeDefined();
    expect(run?.workflow_id).toBe(wf.id);
    expect(run?.status).toBe("completed");
    const payload = run?.trigger_payload as {
      organization_name: string;
      package: { packageId: string };
    };
    expect(payload.organization_name).toBe("Acme Corp");
    expect(payload.package.packageId).toBe(pkg.packageId);
    expect(db.projects.get(project.id)?.current_stage).toBe("onboarding");
    expect(db.stageHistory).toEqual([
      expect.objectContaining({
        projectId: project.id,
        fromStage: "intake",
        toStage: "onboarding",
        changedBy: "operator@example.com",
      }),
    ]);
  });

  it("runs an explicitly chosen workflow among several", async () => {
    const db = new FakeDeliveryDb();
    const { project } = await seedProject(db);
    const a = fixtureWorkflow({ name: "Alpha follow-up" });
    const b = fixtureWorkflow({ name: "Beta follow-up" });
    const engine = makeEngineDb([a, b]);

    const result = await beginProjectWorkflow(db, engine.db, {
      projectId: project.id,
      workflowId: b.id,
      environment: "production",
    });

    expect(result.workflowId).toBe(b.id);
    expect(engine.runs.get(result.runId)?.workflow_id).toBe(b.id);
  });

  it("adopts the run already started for this package instead of executing a duplicate", async () => {
    const db = new FakeDeliveryDb();
    const { project } = await seedProject(db);
    const wf = fixtureWorkflow();
    const engine = makeEngineDb([wf]);

    const first = await beginProjectWorkflow(db, engine.db, {
      projectId: project.id,
      environment: "production",
    });
    expect(first.alreadyStarted).toBe(false);

    // The intake-trigger end state: a live run exists for the package
    // but the project still sits at intake with no marker.
    const stored = db.projects.get(project.id);
    if (stored) stored.current_stage = "intake";
    db.stageHistory.length = 0;

    const second = await beginProjectWorkflow(db, engine.db, {
      projectId: project.id,
      changedBy: "operator@example.com",
      environment: "production",
    });

    expect(second.alreadyStarted).toBe(true);
    expect(second.runId).toBe(first.runId);
    expect(engine.runs.size).toBe(1);
    expect(second.stage).toBe("onboarding");
    expect(db.stageHistory).toHaveLength(1);
  });

  it("ignores a failed prior run and executes again", async () => {
    const db = new FakeDeliveryDb();
    const { project, pkg } = await seedProject(db);
    const wf = fixtureWorkflow();
    const engine = makeEngineDb([wf]);
    const failedId = randomUUID();
    engine.runs.set(failedId, {
      id: failedId,
      workflow_id: wf.id,
      trigger_type: "lead_handoff",
      trigger_payload: {
        organization_name: "Acme Corp",
        package: { packageId: pkg.packageId },
      },
      environment: "production",
      status: "failed",
      output: null,
      error: "earlier failure",
      started_at: new Date().toISOString(),
    });

    const result = await beginProjectWorkflow(db, engine.db, {
      projectId: project.id,
      environment: "production",
    });

    expect(result.alreadyStarted).toBe(false);
    expect(result.runId).not.toBe(failedId);
    expect(engine.runs.size).toBe(2);
    expect(result.stage).toBe("onboarding");
  });

  it("reports a failed run and keeps the project at intake", async () => {
    const db = new FakeDeliveryDb();
    const { project } = await seedProject(db);
    // Mirrors the seeded lead-followup workflow against a v1 package:
    // the package carries no lead phone, so {{trigger.lead.phone}}
    // renders empty, the send_sms step throws, and executeWorkflow
    // resolves with a failed run (it does not reject).
    const failing = fixtureWorkflow({
      nodes: [
        {
          node_key: "trigger-1", type: "trigger", kind: "lead_handoff",
          label: "Lead Handoff", position_x: 0, position_y: 0,
          config: {}, enabled: true,
        },
        {
          node_key: "action-1", type: "action", kind: "send_sms",
          label: "Queue SMS draft", position_x: 0, position_y: 0,
          config: {
            to: "{{trigger.lead.phone}}",
            message: "Following up on your project.",
          },
          enabled: true,
        },
      ],
    });
    const engine = makeEngineDb([failing]);

    await expectBeginError(
      beginProjectWorkflow(db, engine.db, {
        projectId: project.id,
        environment: "production",
      }),
      502,
      "stays at intake",
    );
    expect(engine.runs.size).toBe(1);
    expect(db.projects.get(project.id)?.current_stage).toBe("intake");
    expect(db.stageHistory).toHaveLength(0);
  });

  it("does not move a project that already left intake", async () => {
    const db = new FakeDeliveryDb();
    const { project } = await seedProject(db);
    const stored = db.projects.get(project.id);
    if (stored) stored.current_stage = "blueprint_drafting";
    const engine = makeEngineDb([fixtureWorkflow()]);

    const result = await beginProjectWorkflow(db, engine.db, {
      projectId: project.id,
      environment: "production",
    });

    expect(result.stage).toBe("blueprint_drafting");
    expect(db.stageHistory).toHaveLength(0);
  });

  it("conflicts while an adopted intake-trigger run is still running, then adopts it once it completes", async () => {
    const db = new FakeDeliveryDb();
    const { project, pkg } = await seedProject(db);
    const wf = fixtureWorkflow();
    const engine = makeEngineDb([wf]);
    // The intake trigger already started this workflow for the
    // package; its run is still in flight and no start row exists.
    const runningId = randomUUID();
    engine.runs.set(runningId, {
      id: runningId,
      workflow_id: wf.id,
      trigger_type: "lead_handoff",
      trigger_payload: {
        organization_name: "Acme Corp",
        package: { packageId: pkg.packageId },
      },
      environment: "production",
      status: "running",
      output: null,
      error: null,
      started_at: new Date().toISOString(),
    });

    await expectBeginError(
      beginProjectWorkflow(db, engine.db, {
        projectId: project.id,
        environment: "production",
      }),
      409,
      "already running",
    );
    // No duplicate execution, no stage advance on an unfinished run,
    // and the adoption is recorded on the reservation.
    expect(engine.runs.size).toBe(1);
    expect(db.projects.get(project.id)?.current_stage).toBe("intake");
    const recorded = [...engine.starts.values()];
    expect(recorded).toHaveLength(1);
    expect(recorded[0].state).toBe("reserved");
    expect(recorded[0].run_id).toBe(runningId);

    // The run finishes successfully: the next begin adopts it.
    const run = engine.runs.get(runningId);
    if (run) run.status = "completed";
    const result = await beginProjectWorkflow(db, engine.db, {
      projectId: project.id,
      environment: "production",
    });
    expect(result.alreadyStarted).toBe(true);
    expect(result.runId).toBe(runningId);
    expect(result.stage).toBe("onboarding");
    expect(engine.runs.size).toBe(1);
    expect(recorded[0].state).toBe("completed");
  });

  it("conflicts when another begin holds a fresh claim with no run yet", async () => {
    const db = new FakeDeliveryDb();
    const { project } = await seedProject(db);
    const wf = fixtureWorkflow();
    const engine = makeEngineDb([wf]);
    seedStart(engine, {
      project_id: project.id,
      workflow_id: wf.id,
      state: "reserved",
      run_id: null,
    });

    await expectBeginError(
      beginProjectWorkflow(db, engine.db, {
        projectId: project.id,
        environment: "production",
      }),
      409,
      "already in progress",
    );
    expect(engine.runs.size).toBe(0);
    expect(db.projects.get(project.id)?.current_stage).toBe("intake");
  });

  it("reclaims a stale claim whose claimant never produced a run", async () => {
    const db = new FakeDeliveryDb();
    const { project } = await seedProject(db);
    const wf = fixtureWorkflow();
    const engine = makeEngineDb([wf]);
    const stale = seedStart(engine, {
      project_id: project.id,
      workflow_id: wf.id,
      state: "reserved",
      run_id: null,
      created_at: new Date(Date.now() - 15 * 60 * 1000),
      updated_at: new Date(Date.now() - 15 * 60 * 1000),
    });

    const result = await beginProjectWorkflow(db, engine.db, {
      projectId: project.id,
      environment: "production",
    });

    expect(result.alreadyStarted).toBe(false);
    expect(result.stage).toBe("onboarding");
    expect(engine.runs.size).toBe(1);
    expect(stale.state).toBe("completed");
    expect(stale.run_id).toBe(result.runId);
  });

  it("claims the retry of a failed start and executes again", async () => {
    const db = new FakeDeliveryDb();
    const { project } = await seedProject(db);
    const wf = fixtureWorkflow();
    const engine = makeEngineDb([wf]);
    const failed = seedStart(engine, {
      project_id: project.id,
      workflow_id: wf.id,
      state: "failed",
      run_id: randomUUID(),
    });

    const result = await beginProjectWorkflow(db, engine.db, {
      projectId: project.id,
      environment: "production",
    });

    expect(result.alreadyStarted).toBe(false);
    expect(result.stage).toBe("onboarding");
    expect(engine.runs.size).toBe(1);
    expect(failed.state).toBe("completed");
    expect(failed.run_id).toBe(result.runId);
  });

  it("settles and adopts when the reserved run completed meanwhile", async () => {
    const db = new FakeDeliveryDb();
    const { project, pkg } = await seedProject(db);
    const wf = fixtureWorkflow();
    const engine = makeEngineDb([wf]);
    const runId = randomUUID();
    engine.runs.set(runId, {
      id: runId,
      workflow_id: wf.id,
      trigger_type: "lead_handoff",
      trigger_payload: {
        organization_name: "Acme Corp",
        package: { packageId: pkg.packageId },
      },
      environment: "production",
      status: "completed",
      output: null,
      error: null,
      started_at: new Date().toISOString(),
    });
    const start = seedStart(engine, {
      project_id: project.id,
      workflow_id: wf.id,
      state: "reserved",
      run_id: runId,
    });

    const result = await beginProjectWorkflow(db, engine.db, {
      projectId: project.id,
      environment: "production",
    });

    expect(result.alreadyStarted).toBe(true);
    expect(result.runId).toBe(runId);
    expect(result.stage).toBe("onboarding");
    expect(engine.runs.size).toBe(1);
    expect(start.state).toBe("completed");
  });

  it("retries when the reserved run failed meanwhile", async () => {
    const db = new FakeDeliveryDb();
    const { project, pkg } = await seedProject(db);
    const wf = fixtureWorkflow();
    const engine = makeEngineDb([wf]);
    const failedRunId = randomUUID();
    engine.runs.set(failedRunId, {
      id: failedRunId,
      workflow_id: wf.id,
      trigger_type: "lead_handoff",
      trigger_payload: {
        organization_name: "Acme Corp",
        package: { packageId: pkg.packageId },
      },
      environment: "production",
      status: "failed",
      output: null,
      error: "earlier failure",
      started_at: new Date().toISOString(),
    });
    const start = seedStart(engine, {
      project_id: project.id,
      workflow_id: wf.id,
      state: "reserved",
      run_id: failedRunId,
    });

    const result = await beginProjectWorkflow(db, engine.db, {
      projectId: project.id,
      environment: "production",
    });

    expect(result.alreadyStarted).toBe(false);
    expect(result.runId).not.toBe(failedRunId);
    expect(result.stage).toBe("onboarding");
    expect(engine.runs.size).toBe(2);
    expect(start.state).toBe("completed");
    expect(start.run_id).toBe(result.runId);
  });

  it("a failed execution frees the start, so the next begin retries instead of conflicting", async () => {
    const db = new FakeDeliveryDb();
    const { project } = await seedProject(db);
    const failing = fixtureWorkflow({
      nodes: [
        {
          node_key: "trigger-1", type: "trigger", kind: "lead_handoff",
          label: "Lead Handoff", position_x: 0, position_y: 0,
          config: {}, enabled: true,
        },
        {
          node_key: "action-1", type: "action", kind: "send_sms",
          label: "Queue SMS draft", position_x: 0, position_y: 0,
          config: {
            to: "{{trigger.lead.phone}}",
            message: "Following up on your project.",
          },
          enabled: true,
        },
      ],
    });
    const engine = makeEngineDb([failing]);

    await expectBeginError(
      beginProjectWorkflow(db, engine.db, {
        projectId: project.id,
        environment: "production",
      }),
      502,
      "stays at intake",
    );
    const recorded = [...engine.starts.values()];
    expect(recorded).toHaveLength(1);
    expect(recorded[0].state).toBe("failed");

    // Second begin: claims the retry and executes (failing again),
    // rather than adopting or conflicting forever.
    await expectBeginError(
      beginProjectWorkflow(db, engine.db, {
        projectId: project.id,
        environment: "production",
      }),
      502,
      "stays at intake",
    );
    expect(engine.runs.size).toBe(2);
    expect(db.projects.get(project.id)?.current_stage).toBe("intake");
  });
});

describe("getProjectBeginState", () => {
  it("returns the stage and the in-scope published workflows", async () => {
    const db = new FakeDeliveryDb();
    const { project } = await seedProject(db);
    const wf = fixtureWorkflow({ name: "Only one" });
    const engine = makeEngineDb([
      wf,
      fixtureWorkflow({ environment: "demo", name: "Demo only" }),
      fixtureWorkflow({ status: "draft", name: "Unpublished" }),
    ]);
    const state = await getProjectBeginState(db, engine.db, project.id);
    expect(state.stage).toBe("intake");
    expect(state.environment).toBe("production");
    expect(state.publishedWorkflows).toEqual([{ id: wf.id, name: "Only one" }]);
  });

  it("surfaces the package's requirement count and the project's skeletons", async () => {
    const db = new FakeDeliveryDb();
    const { project } = await seedProject(db);
    const skeleton = fixtureWorkflow({
      name: "Acme Corp — Invoice Reconciliation",
      status: "draft",
      trigger_type: "manual",
      trigger_config: { projectId: project.id, requirementCode: "REQ-001" },
    });
    const otherProject = fixtureWorkflow({
      name: "Someone else's skeleton",
      status: "draft",
      trigger_type: "manual",
      trigger_config: { projectId: randomUUID(), requirementCode: "REQ-9" },
    });
    const engine = makeEngineDb([skeleton, otherProject]);
    const state = await getProjectBeginState(db, engine.db, project.id);
    // packageBase carries exactly one requirement.
    expect(state.requirementCount).toBe(1);
    expect(state.useCaseWorkflows).toEqual([
      {
        id: skeleton.id,
        name: "Acme Corp — Invoice Reconciliation",
        status: "draft",
        requirementCode: "REQ-001",
        // The fixture carries no graph rows, so it lists as
        // incomplete and does not count toward coverage.
        complete: false,
      },
    ]);
    expect(state.useCaseWorkflowCompleteCount).toBe(0);
  });

  it("404s for an unknown project", async () => {
    const db = new FakeDeliveryDb();
    const engine = makeEngineDb([]);
    await expectBeginError(
      getProjectBeginState(db, engine.db, randomUUID()),
      404,
      "Project not found",
    );
  });
});


describe("begin reservation — Codex PR #53 follow-ups", () => {
  it("two begins racing a failed recorded run execute exactly once", async () => {
    const db = new FakeDeliveryDb();
    const { project, pkg } = await seedProject(db);
    const wf = fixtureWorkflow();
    const engine = makeEngineDb([wf]);
    // A previous start is 'reserved' against a run that FAILED.
    const failedRunId = randomUUID();
    engine.runs.set(failedRunId, {
      id: failedRunId,
      workflow_id: wf.id,
      trigger_type: "lead_handoff",
      trigger_payload: { package: { packageId: pkg.packageId } },
      environment: "production",
      status: "failed",
      output: null,
      error: "boom",
      started_at: new Date().toISOString(),
    });
    seedStart(engine, {
      project_id: project.id,
      workflow_id: wf.id,
      package_id: pkg.packageId,
      run_id: failedRunId,
      state: "reserved",
    });
    const attempts = await Promise.allSettled([
      beginProjectWorkflow(db, engine.db, {
        projectId: project.id,
        environment: "production",
      }),
      beginProjectWorkflow(db, engine.db, {
        projectId: project.id,
        environment: "production",
      }),
    ]);
    const fulfilled = attempts.filter((a) => a.status === "fulfilled");
    const rejected = attempts.filter((a) => a.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The failed seed plus exactly ONE new execution.
    expect(engine.runs.size).toBe(2);
  });

  it("the intake trigger reserves its start; a repeat trigger and a later begin do not re-execute", async () => {
    const db = new FakeDeliveryDb();
    const { project, pkg } = await seedProject(db);
    const wf = fixtureWorkflow();
    const engine = makeEngineDb([wf]);
    engine.projectsByPackage.set(pkg.packageId, project.id);

    const first = await triggerLeadHandoffWorkflows(
      engine.db,
      pkg,
      "production",
    );
    expect(first.executed).toEqual([wf.id]);
    expect(engine.runs.size).toBe(1);

    const second = await triggerLeadHandoffWorkflows(
      engine.db,
      pkg,
      "production",
    );
    expect(second.executed).toEqual([]);
    expect(second.skipped).toEqual([wf.id]);
    expect(engine.runs.size).toBe(1);

    // The start row the trigger settled is 'completed': a manual
    // begin adopts it (alreadyStarted) and advances the stage
    // without executing again.
    const begun = await beginProjectWorkflow(db, engine.db, {
      projectId: project.id,
      environment: "production",
    });
    expect(begun.alreadyStarted).toBe(true);
    expect(engine.runs.size).toBe(1);
    expect(db.projects.get(project.id)?.current_stage).toBe("onboarding");
  });
});
