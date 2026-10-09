import { randomUUID } from "node:crypto";
import type { LeadEngineHandoffPackage } from "@raphah/handoff-contract";
import { describe, expect, it } from "vitest";
import type { DeliveryEnvironment } from "../api/_lib/db.js";
import { triggerLeadHandoffWorkflows } from "../api/_lib/handoff-triggers.js";
import { handleIntake, type IntakeEnv } from "../api/_lib/verify.js";
import {
  listWorkflows,
  type Workflow,
} from "../api/_lib/workflows.js";
import { FakeDeliveryDb } from "./fake-db.js";
import {
  intakeRequest,
  packageBase,
  signTestPackage,
  testEnv,
} from "./helpers.js";

/**
 * Phase 0 environment separation: demo and production are real scopes in
 * the data, not a UI badge. Intake stamps every accept with the scope
 * derived from the deployment environment; lead_handoff automation only
 * fires inside the matching scope; workflow lists filter by scope; the
 * demo reset clears demo operational data and never touches production.
 */

describe("intake environment scope", () => {
  it("stamps production accepts as production, end to end", async () => {
    const db = new FakeDeliveryDb();
    const signed = signTestPackage();
    const seen: Array<{ pkg: LeadEngineHandoffPackage; environment: DeliveryEnvironment }> = [];
    const result = await handleIntake(
      intakeRequest(signed),
      db,
      testEnv({ environment: "production" }),
      {
        onHandoffAccepted: async (pkg, environment) => {
          seen.push({ pkg, environment });
        },
      },
    );
    expect(result.status).toBe(201);
    expect((result.body as { environment: string }).environment).toBe(
      "production",
    );
    const projectId = (result.body as { projectId: string }).projectId;
    const project = await db.getProject(projectId);
    expect(project?.environment).toBe("production");
    const inbox = await db.findInboxByIdempotencyKey(
      [...db.inboxes.keys()][0],
    );
    expect(inbox?.environment).toBe("production");
    expect(seen).toHaveLength(1);
    expect(seen[0].environment).toBe("production");
  });

  it("stamps non-production accepts as demo", async () => {
    const db = new FakeDeliveryDb();
    const signed = signTestPackage();
    const seen: DeliveryEnvironment[] = [];
    const result = await handleIntake(
      intakeRequest(signed),
      db,
      testEnv({ environment: "test" }),
      {
        onHandoffAccepted: async (_pkg, environment) => {
          seen.push(environment);
        },
      },
    );
    expect(result.status).toBe(201);
    expect((result.body as { environment: string }).environment).toBe("demo");
    const projectId = (result.body as { projectId: string }).projectId;
    expect((await db.getProject(projectId))?.environment).toBe("demo");
    expect(seen).toEqual(["demo"]);
  });

  it("reports the original scope on idempotent replay", async () => {
    const db = new FakeDeliveryDb();
    const signed = signTestPackage();
    const env: IntakeEnv = testEnv({ environment: "preview" });
    const first = await handleIntake(intakeRequest(signed), db, env);
    expect(first.status).toBe(201);
    const key = [...db.inboxes.keys()][0];
    const replay = await handleIntake(
      intakeRequest(signed, { "idempotency-key": key }),
      db,
      env,
    );
    expect(replay.status).toBe(200);
    expect((replay.body as { environment: string }).environment).toBe("demo");
  });
});

/* ── Trigger isolation ───────────────────────────────────────────────── */

function scopedWorkflow(
  environment: DeliveryEnvironment,
  name: string,
): Workflow {
  return {
    id: randomUUID(),
    name,
    description: null,
    status: "published",
    environment,
    trigger_type: "lead_handoff",
    trigger_config: { minScore: 0 },
    created_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    published_at: new Date().toISOString(),
    nodes: [
      {
        node_key: "trigger-1", type: "trigger", kind: "lead_handoff",
        label: "Lead Handoff", position_x: 0, position_y: 0,
        config: {}, enabled: true,
      },
      {
        node_key: "action-1", type: "action", kind: "log_database",
        label: "Log", position_x: 0, position_y: 0,
        config: { message: "ran {{workflow.name}}", level: "info" },
        enabled: true,
      },
    ],
    edges: [
      {
        edge_key: "e1", from_node_key: "trigger-1", to_node_key: "action-1",
        from_port: null, label: null,
      },
    ],
  };
}

function makeScopedDb(workflows: Workflow[]) {
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
      const { nodes: _n, edges: _e, ...row } = w;
      return [row];
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
        completed_at: null,
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
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
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
        run.completed_at = new Date().toISOString();
      }
      return [];
    }
    if (head.includes("from public.workflow_runs where id =")) {
      const run = runs.get(String(values[0]));
      return run ? [run] : [];
    }
    if (head.includes("from public.workflow_run_steps")) {
      return steps.filter((s) => s.run_id === String(values[0]));
    }
    throw new Error(`Unexpected query: ${head.slice(0, 100)}`);
  }) as unknown as Parameters<typeof triggerLeadHandoffWorkflows>[0];

  return { db, runs };
}

describe("lead_handoff trigger environment isolation", () => {
  it("a production accept fires only production workflows", async () => {
    const demo = scopedWorkflow("demo", "Demo follow-up");
    const prod = scopedWorkflow("production", "Production follow-up");
    const { db, runs } = makeScopedDb([demo, prod]);
    const pkg = signTestPackage(packageBase()).pkg;
    const result = await triggerLeadHandoffWorkflows(db, pkg, "production");
    expect(result.executed).toEqual([prod.id]);
    expect([...runs.values()].map((r) => r.environment)).toEqual([
      "production",
    ]);
  });

  it("a demo accept fires only demo workflows", async () => {
    const demo = scopedWorkflow("demo", "Demo follow-up");
    const prod = scopedWorkflow("production", "Production follow-up");
    const { db, runs } = makeScopedDb([demo, prod]);
    const pkg = signTestPackage(packageBase()).pkg;
    const result = await triggerLeadHandoffWorkflows(db, pkg, "demo");
    expect(result.executed).toEqual([demo.id]);
    expect([...runs.values()].map((r) => r.environment)).toEqual(["demo"]);
  });
});

/* ── Workflow list filter ────────────────────────────────────────────── */

describe("workflow list environment filter", () => {
  const rows = [
    { id: randomUUID(), name: "Demo A", environment: "demo" },
    { id: randomUUID(), name: "Demo B", environment: "demo" },
    { id: randomUUID(), name: "Prod A", environment: "production" },
  ].map((r) => ({
    ...r,
    description: null,
    status: "draft",
    trigger_type: "manual",
    trigger_config: {},
    created_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    published_at: null,
  }));

  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0];
    if (head.includes("from public.workflows") && head.includes("where environment =")) {
      return rows.filter((r) => r.environment === String(values[0]));
    }
    if (head.includes("from public.workflows")) return rows;
    throw new Error(`Unexpected query: ${head.slice(0, 100)}`);
  }) as unknown as Parameters<typeof listWorkflows>[0];

  it("lists everything without a filter", async () => {
    expect(await listWorkflows(db)).toHaveLength(3);
  });

  it("filters to one environment", async () => {
    const demo = await listWorkflows(db, "demo");
    expect(demo.map((w) => w.name)).toEqual(["Demo A", "Demo B"]);
    expect(demo.every((w) => w.environment === "demo")).toBe(true);
    const prod = await listWorkflows(db, "production");
    expect(prod.map((w) => w.name)).toEqual(["Prod A"]);
  });
});

/* ── Demo reset ──────────────────────────────────────────────────────── */

describe("demo environment reset", () => {
  it("clears demo data and leaves production untouched", async () => {
    const db = new FakeDeliveryDb();
    const pkg = signTestPackage(packageBase()).pkg;
    await db.createInboxAndProject({
      idempotencyKey: "demo-key",
      pkg,
      manifestChecksum: "a".repeat(64),
      signature: "sig",
      environment: "demo",
    });
    const prod = await db.createInboxAndProject({
      idempotencyKey: "prod-key",
      pkg,
      manifestChecksum: "b".repeat(64),
      signature: "sig",
      environment: "production",
    });
    const summary = await db.resetDemoEnvironment();
    expect(summary.projects).toBe(1);
    expect(summary.inbox).toBe(1);
    expect(await db.getProject(prod.project.id)).not.toBeNull();
    expect(db.inboxCount()).toBe(1);
  });
});
