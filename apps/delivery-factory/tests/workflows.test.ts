import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NODE_CATALOG,
  executeWorkflow,
  renderTemplate,
  specFor,
  type Workflow,
} from "../api/_lib/workflows.js";

/**
 * Minimal fake of the @neondatabase/serverless tag client. Matches on the
 * leading SQL fragment of each query the workflow engine issues.
 */
function makeFakeDb(workflow: Workflow) {
  const runs = new Map<string, Record<string, unknown>>();
  const steps: Array<Record<string, unknown>> = [];
  const auditLog: Array<Record<string, unknown>> = [];

  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0];
    if (head.includes("from public.workflows where id =")) {
      const w = workflow;
      return [
        {
          id: w.id, name: w.name, description: w.description, status: w.status,
          trigger_type: w.trigger_type, trigger_config: w.trigger_config,
          created_by: w.created_by, created_at: w.created_at,
          updated_at: w.updated_at, published_at: w.published_at,
        },
      ];
    }
    if (head.includes("from public.workflow_nodes")) {
      return workflow.nodes.map((n) => ({ ...n }));
    }
    if (head.includes("from public.workflow_edges")) {
      return workflow.edges.map((e) => ({ ...e }));
    }
    if (head.includes("insert into public.workflow_runs")) {
      const id = randomUUID();
      runs.set(id, {
        id, workflow_id: values[0], trigger_type: values[1],
        trigger_payload: JSON.parse(String(values[2])),
        status: "running", output: null, error: null,
        started_at: new Date().toISOString(), completed_at: null,
      });
      return [{ id, started_at: new Date().toISOString() }];
    }
    if (head.includes("insert into public.workflow_run_steps")) {
      const id = randomUUID();
      steps.push({
        id, run_id: values[0], node_key: values[1],
        node_kind: values[2], node_label: values[3], status: values[4],
        input: values[5] ? JSON.parse(String(values[5])) : null,
        output: values[6] ? JSON.parse(String(values[6])) : null,
        error: values[7],
        started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
      });
      return [{ id }];
    }
    if (head.includes("update public.workflow_run_steps")) {
      // values: status, output(json|null), error, id
      const step = steps.find((s) => s.id === values[3]);
      if (step) {
        step.status = values[0];
        step.output = values[1] ? JSON.parse(String(values[1])) : null;
        step.error = values[2];
        step.completed_at = new Date().toISOString();
      }
      return [];
    }
    if (head.includes("insert into public.workflow_audit_log")) {
      auditLog.push({ run_id: values[0], workflow_id: values[1], level: values[2], message: values[3] });
      return [];
    }
    if (head.includes("update public.workflow_runs")) {
      // values: status, error, output(json), id
      const id = String(values[3]);
      const run = runs.get(id)!;
      run.status = values[0];
      run.error = values[1];
      run.output = JSON.parse(String(values[2]));
      run.completed_at = new Date().toISOString();
      return [];
    }
    if (head.includes("from public.workflow_runs where id =")) {
      const run = runs.get(String(values[0]));
      return run ? [run] : [];
    }
    if (head.includes("from public.workflow_run_steps where run_id =")) {
      return steps.filter((s) => s.run_id === values[0]);
    }
    throw new Error(`Unhandled query in fake db: ${head.slice(0, 80)}`);
  }) as unknown as Parameters<typeof executeWorkflow>[0];

  return { db, runs, steps, auditLog };
}

const demoWorkflow: Workflow = {
  id: randomUUID(),
  name: "Synthetic E2E demo",
  description: null,
  status: "published",
  trigger_type: "manual",
  trigger_config: {},
  created_by: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  published_at: new Date().toISOString(),
  nodes: [
    { node_key: "t1", type: "trigger", kind: "manual", label: "Manual", position_x: 0, position_y: 0, config: {}, enabled: true },
    { node_key: "a1", type: "action", kind: "log_database", label: "Log", position_x: 0, position_y: 0, config: { message: "Lead {{trigger.lead.name}} scored {{trigger.lead.score}}", level: "info" }, enabled: true },
    { node_key: "l1", type: "logic", kind: "if_else", label: "Hot?", position_x: 0, position_y: 0, config: { field: "trigger.lead.score", operator: "gte", value: "70" }, enabled: true },
    { node_key: "a2", type: "action", kind: "update_status", label: "Hot path", position_x: 0, position_y: 0, config: { service: "delivery-factory", status: "ok", note: "hot lead {{trigger.lead.name}}" }, enabled: true },
    { node_key: "a3", type: "action", kind: "update_status", label: "Cold path", position_x: 0, position_y: 0, config: { service: "delivery-factory", status: "ok", note: "cold lead" }, enabled: true },
  ],
  edges: [
    { edge_key: "e1", from_node_key: "t1", to_node_key: "a1", from_port: null, label: null },
    { edge_key: "e2", from_node_key: "a1", to_node_key: "l1", from_port: null, label: null },
    { edge_key: "e3", from_node_key: "l1", to_node_key: "a2", from_port: "true", label: null },
    { edge_key: "e4", from_node_key: "l1", to_node_key: "a3", from_port: "false", label: null },
  ],
};

describe("workflow engine", () => {
  it("catalog has unique kinds and sane specs", () => {
    const kinds = NODE_CATALOG.map((s) => s.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const spec of NODE_CATALOG) {
      expect(specFor(spec.kind)).toBe(spec);
      expect(spec.label.length).toBeGreaterThan(0);
    }
    expect(() => specFor("nope" as never)).toThrow();
  });

  it("renderTemplate resolves paths, arrays and missing values", () => {
    const ctx = { lead: { name: "Acme", score: 80 }, tags: ["a", "b"] };
    expect(renderTemplate("Hi {{lead.name}} ({{lead.score}})", ctx)).toBe("Hi Acme (80)");
    expect(renderTemplate("{{lead.missing}}!", ctx)).toBe("!");
    expect(renderTemplate({ a: "{{lead.name}}", b: ["{{tags.0}}"] }, ctx)).toEqual({ a: "Acme", b: ["a"] });
    expect(renderTemplate(42, ctx)).toBe(42);
  });

  it("executes the true branch and audits every step", async () => {
    const { db, steps, auditLog } = makeFakeDb(demoWorkflow);
    const run = await executeWorkflow(
      db, demoWorkflow.id,
      { lead: { name: "Acme Corp", score: 85 } },
    );
    expect(run.status).toBe("completed");
    expect(run.error).toBeNull();
    const labels = steps.map((s) => `${s.node_label}:${s.status}`);
    expect(labels).toEqual([
      "Manual:success",
      "Log:success",
      "Hot?:success",
      "Hot path:success",
    ]);
    // Template rendered into the audit message
    expect(auditLog[0].message).toBe("Lead Acme Corp scored 85");
    // Branch output recorded
    const branch = steps.find((s) => s.node_key === "l1");
    expect(branch?.output).toMatchObject({ result: true, port: "true" });
    const hot = steps.find((s) => s.node_key === "a2");
    expect(hot?.output).toMatchObject({ note: "hot lead Acme Corp" });
  });

  it("executes the false branch for cold leads", async () => {
    const { db, steps } = makeFakeDb(demoWorkflow);
    const run = await executeWorkflow(
      db, demoWorkflow.id,
      { lead: { name: "Cold Co", score: 20 } },
    );
    expect(run.status).toBe("completed");
    const labels = steps.map((s) => `${s.node_label}:${s.status}`);
    expect(labels).toEqual([
      "Manual:success",
      "Log:success",
      "Hot?:success",
      "Cold path:success",
    ]);
  });

  it("refuses to execute draft workflows", async () => {
    const { db } = makeFakeDb({ ...demoWorkflow, status: "draft" });
    await expect(executeWorkflow(db, demoWorkflow.id, {})).rejects.toThrow(
      "Only published workflows can execute",
    );
  });

  it("marks the run failed when an action throws", async () => {
    const bad: Workflow = {
      ...demoWorkflow,
      nodes: [
        { node_key: "t1", type: "trigger", kind: "manual", label: "Manual", position_x: 0, position_y: 0, config: {}, enabled: true },
        { node_key: "a1", type: "action", kind: "send_email", label: "Email", position_x: 0, position_y: 0, config: { subject: "x" }, enabled: true },
      ],
      edges: [{ edge_key: "e1", from_node_key: "t1", to_node_key: "a1", from_port: null, label: null }],
    };
    const { db, steps } = makeFakeDb(bad);
    const run = await executeWorkflow(db, bad.id, {});
    expect(run.status).toBe("failed");
    expect(run.error).toContain("'to' is required");
    expect(steps.find((s) => s.node_key === "a1")?.status).toBe("failed");
  });

  it("blocks synthetic project fabrication unless explicitly enabled", async () => {
    const wf: Workflow = {
      ...demoWorkflow,
      nodes: [
        { node_key: "t1", type: "trigger", kind: "manual", label: "Manual", position_x: 0, position_y: 0, config: {}, enabled: true },
        { node_key: "a1", type: "action", kind: "create_project", label: "Create project", position_x: 0, position_y: 0, config: { name: "Synthetic" }, enabled: true },
      ],
      edges: [{ edge_key: "e1", from_node_key: "t1", to_node_key: "a1", from_port: null, label: null }],
    };
    const prev = process.env.WORKFLOW_SYNTHETIC_PROJECTS;
    delete process.env.WORKFLOW_SYNTHETIC_PROJECTS;
    try {
      const { db } = makeFakeDb(wf);
      const run = await executeWorkflow(db, wf.id, {});
      expect(run.status).toBe("failed");
      expect(run.error).toContain("verified handoff context");
    } finally {
      if (prev === undefined) delete process.env.WORKFLOW_SYNTHETIC_PROJECTS;
      else process.env.WORKFLOW_SYNTHETIC_PROJECTS = prev;
    }
  });
});
