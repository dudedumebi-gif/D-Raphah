import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { NeonClient, ProjectRow } from "../api/_lib/db.js";
import {
  beginProjectWorkflow,
  getProjectBeginState,
  resolveBeginWorkflow,
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
function makeEngineDb(workflows: FixtureWorkflow[]) {
  const byId = new Map(workflows.map((w) => [w.id, w]));
  const runs = new Map<string, Record<string, unknown>>();
  const steps: Array<Record<string, unknown>> = [];

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
    throw new Error(`Unexpected query: ${head.slice(0, 100)}`);
  }) as unknown as NeonClient;

  return { db, runs, steps };
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
