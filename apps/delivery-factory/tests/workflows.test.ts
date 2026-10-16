import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NODE_CATALOG,
  executeWorkflow,
  getWorkflow,
  renderTemplate,
  specFor,
  updateWorkflow,
  type Workflow,
  type WorkflowNode,
} from "../api/_lib/workflows.js";

/**
 * Minimal fake of the @neondatabase/serverless tag client. Matches on the
 * leading SQL fragment of each query the workflow engine issues.
 */
function makeFakeDb(workflow: Workflow) {
  const runs = new Map<string, Record<string, unknown>>();
  const steps: Array<Record<string, unknown>> = [];

  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0];
    if (head.includes("from public.workflows where id =")) {
      const w = workflow;
      return [
        {
          id: w.id, name: w.name, description: w.description, status: w.status,
          environment: w.environment,
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
        environment: values[3],
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
    // NOTE: no workflow_audit_log handler — since the v2 log_database
    // merge, an insert there is a regression and must throw here.
    throw new Error(`Unhandled query in fake db: ${head.slice(0, 80)}`);
  }) as unknown as Parameters<typeof executeWorkflow>[0];

  return { db, runs, steps };
}

const demoWorkflow: Workflow = {
  id: randomUUID(),
  name: "Synthetic E2E demo",
  description: null,
  status: "published",
  environment: "demo",
  trigger_type: "manual",
  trigger_config: {},
  created_by: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  published_at: new Date().toISOString(),
  nodes: [
    { node_key: "t1", type: "trigger", kind: "manual", label: "Manual", position_x: 0, position_y: 0, config: {}, enabled: true },
    { node_key: "a1", type: "action", kind: "log_database", label: "Log", position_x: 0, position_y: 0, config: { message: "Lead {{trigger.lead.name}} scored {{trigger.lead.score}}", level: "info" }, enabled: true },
    { node_key: "a2", type: "action", kind: "ai_assist", label: "Draft follow-up", position_x: 0, position_y: 0, config: { model: "gpt-4o-mini", systemPrompt: "Be brief.", userPrompt: "Draft a follow-up for {{trigger.lead.name}}", maxTokens: 200 }, enabled: true },
    { node_key: "a3", type: "action", kind: "send_email", label: "Email", position_x: 0, position_y: 0, config: { to: "owner@example.com", subject: "Follow-up", body: "{{node_a2.output}}" }, enabled: true },
  ],
  edges: [
    { edge_key: "e1", from_node_key: "t1", to_node_key: "a1", from_port: null, label: null },
    { edge_key: "e2", from_node_key: "a1", to_node_key: "a2", from_port: null, label: null },
    { edge_key: "e3", from_node_key: "a2", to_node_key: "a3", from_port: null, label: null },
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
    // Hyphenated segments (e.g. node keys) resolve too
    expect(
      renderTemplate("{{node_action-1.output}}", { "node_action-1": { output: "draft text" } }),
    ).toBe("draft text");
  });

  it("executes the chain and records every step", async () => {
    const { db, steps } = makeFakeDb(demoWorkflow);
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
      "Draft follow-up:success",
      "Email:success",
    ]);
    // log_database completes with its output in the run step itself
    // (v2 merge — no separate workflow_audit_log write; the fake db
    // would throw on one). The template rendered into the message.
    const log = steps.find((s) => s.node_key === "a1");
    expect(log?.output).toMatchObject({
      logged: true,
      level: "info",
      message: "Lead Acme Corp scored 85",
    });
    // The ai_assist draft feeds the email body through the run context
    const email = steps.find((s) => s.node_key === "a3");
    expect(email?.output).toMatchObject({
      delivered: false,
      queued: true,
      to: "owner@example.com",
    });
    expect(String((email?.output as Record<string, unknown>).body)).toContain(
      "Acme Corp",
    );
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

  it("ai_assist records a draft stub when no AI provider is configured", async () => {
    const wf: Workflow = {
      ...demoWorkflow,
      nodes: [
        { node_key: "t1", type: "trigger", kind: "manual", label: "Manual", position_x: 0, position_y: 0, config: {}, enabled: true },
        { node_key: "a1", type: "action", kind: "ai_assist", label: "Draft reply", position_x: 0, position_y: 0, config: { model: "gpt-4o-mini", systemPrompt: "Be brief.", userPrompt: "Reply to: {{trigger.lead.message}}", maxTokens: 200 }, enabled: true },
      ],
      edges: [{ edge_key: "e1", from_node_key: "t1", to_node_key: "a1", from_port: null, label: null }],
    };
    const { db, steps } = makeFakeDb(wf);
    const run = await executeWorkflow(db, wf.id, { lead: { message: "leaky faucet" } });
    expect(run.status).toBe("completed");
    const ai = steps.find((s) => s.node_key === "a1");
    expect(ai?.status).toBe("success");
    expect(ai?.output).toMatchObject({ delivered: false, draft: true, model: "gpt-4o-mini" });
    expect(String((ai?.output as Record<string, unknown>).prompt)).toContain("leaky faucet");
  });

  it("ai_assist uses the provider hook when configured", async () => {
    const wf: Workflow = {
      ...demoWorkflow,
      nodes: [
        { node_key: "t1", type: "trigger", kind: "manual", label: "Manual", position_x: 0, position_y: 0, config: {}, enabled: true },
        { node_key: "a1", type: "action", kind: "ai_assist", label: "Draft reply", position_x: 0, position_y: 0, config: { userPrompt: "Say hi" }, enabled: true },
      ],
      edges: [{ edge_key: "e1", from_node_key: "t1", to_node_key: "a1", from_port: null, label: null }],
    };
    const { db, steps } = makeFakeDb(wf);
    const seen: Array<Record<string, unknown>> = [];
    const run = await executeWorkflow(
      db, wf.id, {},
      { aiAssist: async (args) => { seen.push(args); return { delivered: true, output: "Hi there!" }; } },
    );
    expect(run.status).toBe("completed");
    expect(seen[0]).toMatchObject({ model: "gpt-4o-mini", userPrompt: "Say hi" });
    expect(steps.find((s) => s.node_key === "a1")?.output).toMatchObject({ delivered: true, output: "Hi there!" });
  });

  it("ai_assist requires a user prompt", async () => {
    const wf: Workflow = {
      ...demoWorkflow,
      nodes: [
        { node_key: "t1", type: "trigger", kind: "manual", label: "Manual", position_x: 0, position_y: 0, config: {}, enabled: true },
        { node_key: "a1", type: "action", kind: "ai_assist", label: "Draft", position_x: 0, position_y: 0, config: {}, enabled: true },
      ],
      edges: [{ edge_key: "e1", from_node_key: "t1", to_node_key: "a1", from_port: null, label: null }],
    };
    const { db } = makeFakeDb(wf);
    const run = await executeWorkflow(db, wf.id, {});
    expect(run.status).toBe("failed");
    expect(run.error).toContain("'userPrompt' is required");
  });
});

/**
 * The draft-first follow-up pattern on the surviving v2 node kinds:
 * a manual trigger, an AI-drafted follow-up, the email queued as a
 * draft record for human approval (nothing sends automatically),
 * and a log step. Mirrors the shape the use-case skeleton generator
 * produces for follow-up requirements.
 */
const leadFollowupDemo: Workflow = {
  id: randomUUID(),
  name: "Lead follow-up (email, draft-first)",
  description: "On a qualified lead, draft a personalized follow-up email with AI, then queue the email as a draft for human approval. Nothing sends automatically.",
  status: "published",
  environment: "demo",
  trigger_type: "manual",
  trigger_config: {},
  created_by: "seed",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  published_at: new Date().toISOString(),
  nodes: [
    { node_key: "trigger-1", type: "trigger", kind: "manual", label: "Manual", position_x: 360, position_y: 40, config: {}, enabled: true },
    {
      node_key: "action-1", type: "action", kind: "ai_assist", label: "Draft follow-up email",
      position_x: 360, position_y: 220,
      config: {
        model: "gpt-4o-mini",
        systemPrompt: "You write short follow-up emails for local service businesses. Warm and specific, never hype or false claims. Never invent facts you were not given. Output only the message text.",
        userPrompt: "Write one email following up with {{trigger.lead.name}} at {{trigger.organization_name}} (lead score {{trigger.lead.score}}/100). Invite a reply with a specific question.",
        maxTokens: 200,
      },
      enabled: true,
    },
    {
      node_key: "action-2", type: "action", kind: "send_email", label: "Queue email draft",
      position_x: 360, position_y: 400,
      config: { to: "owner@example.com", subject: "Following up", body: "{{node_action-1.output}}" },
      enabled: true,
    },
    {
      node_key: "action-3", type: "action", kind: "log_database", label: "Log follow-up drafted",
      position_x: 360, position_y: 580,
      config: { message: "Email follow-up draft queued for {{trigger.lead.name}}; AI draft recorded, awaiting human approval", level: "info" },
      enabled: true,
    },
  ],
  edges: [
    { edge_key: "e1", from_node_key: "trigger-1", to_node_key: "action-1", from_port: null, label: null },
    { edge_key: "e2", from_node_key: "action-1", to_node_key: "action-2", from_port: null, label: null },
    { edge_key: "e3", from_node_key: "action-2", to_node_key: "action-3", from_port: null, label: null },
  ],
};

const sampleLeadPayload = {
  lead: { name: "INS Market", phone: "+14165550123", score: 72 },
  organization_name: "INS Market",
};

describe("lead follow-up (email, draft-first)", () => {
  it("definition is valid: catalogued kinds, one trigger, wired edges", () => {
    expect(leadFollowupDemo.status).toBe("published");
    expect(leadFollowupDemo.trigger_type).toBe("manual");
    for (const node of leadFollowupDemo.nodes) {
      expect(specFor(node.kind)).toBeDefined();
    }
    const triggers = leadFollowupDemo.nodes.filter((n) => n.type === "trigger");
    expect(triggers).toHaveLength(1);
    expect(triggers[0].kind).toBe("manual");
    const keys = new Set(leadFollowupDemo.nodes.map((n) => n.node_key));
    for (const edge of leadFollowupDemo.edges) {
      expect(keys.has(edge.from_node_key)).toBe(true);
      expect(keys.has(edge.to_node_key)).toBe(true);
    }
    // send_email consumes the ai_assist draft output from the run context
    const email = leadFollowupDemo.nodes.find((n) => n.node_key === "action-2")!;
    expect(email.config.body).toBe("{{node_action-1.output}}");
  });

  it("executes draft-first: AI draft stub feeds the queued email draft", async () => {
    const { db, runs, steps } = makeFakeDb(leadFollowupDemo);
    const run = await executeWorkflow(db, leadFollowupDemo.id, sampleLeadPayload);

    expect(run.status).toBe("completed");
    expect(run.error).toBeNull();
    // Run recorded in history with per-step records
    expect(runs.has(run.id)).toBe(true);
    const labels = steps.map((s) => `${s.node_label}:${s.status}`);
    expect(labels).toEqual([
      "Manual:success",
      "Draft follow-up email:success",
      "Queue email draft:success",
      "Log follow-up drafted:success",
    ]);

    const ai = steps.find((s) => s.node_key === "action-1")!;
    expect(ai.output).toMatchObject({ delivered: false, draft: true });
    expect(String((ai.output as Record<string, unknown>).output)).toContain(
      "[draft stub",
    );

    // No provider configured: nothing sent, draft queued for human approval
    const email = steps.find((s) => s.node_key === "action-2")!;
    expect(email.output).toMatchObject({
      delivered: false,
      queued: true,
      to: "owner@example.com",
    });
    // The queued body is the AI draft, not a template placeholder
    expect(String((email.output as Record<string, unknown>).body)).toContain(
      "INS Market",
    );
    expect(String((email.output as Record<string, unknown>).body)).not.toContain(
      "{{",
    );

    // log_database records the entry in its own step output (v2 merge)
    const log = steps.find((s) => s.node_key === "action-3")!;
    expect(log.output).toMatchObject({ logged: true, level: "info" });
    expect(String((log.output as Record<string, unknown>).message)).toContain(
      "INS Market",
    );
  });

  it("still draft-first when an AI provider hook is configured", async () => {
    const { db, steps } = makeFakeDb(leadFollowupDemo);
    const run = await executeWorkflow(db, leadFollowupDemo.id, sampleLeadPayload, {
      aiAssist: async () => ({
        delivered: true,
        output: "Hi INS Market — quick question about your follow-up plan?",
      }),
    });
    expect(run.status).toBe("completed");
    // AI produced a real draft, but the email is still only queued as a
    // draft record: no auto-send
    const email = steps.find((s) => s.node_key === "action-2")!;
    expect(email.output).toMatchObject({
      delivered: false,
      queued: true,
      body: "Hi INS Market — quick question about your follow-up plan?",
    });
  });
});

/**
 * Fake for the save path (getWorkflow / updateWorkflow / replaceGraph).
 * Keeps the stored graph in plain arrays so a test can assert exactly
 * what a failed save left behind.
 */
function makeGraphDb() {
  const originalNodes: WorkflowNode[] = [
    { node_key: "t1", type: "trigger", kind: "manual", label: "Manual", position_x: 0, position_y: 0, config: {}, enabled: true },
    { node_key: "a1", type: "action", kind: "log_database", label: "Log", position_x: 10, position_y: 20, config: { message: "hi", level: "info" }, enabled: true },
  ];
  const storedNodes: Array<Record<string, unknown>> = originalNodes.map(
    (n) => ({ ...n }),
  );
  const storedEdges: Array<Record<string, unknown>> = [
    { edge_key: "e1", from_node_key: "t1", to_node_key: "a1", from_port: null, label: null },
  ];
  const workflowRow = {
    id: "wf-graph", name: "Draft", description: null, status: "draft",
    environment: "production", trigger_type: "manual", trigger_config: {},
    created_by: null, created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), published_at: null,
  };
  let deleteCount = 0;

  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0];
    if (head.includes("delete from public.workflow_edges")) {
      deleteCount += 1;
      storedEdges.length = 0;
      return [];
    }
    if (head.includes("delete from public.workflow_nodes")) {
      deleteCount += 1;
      storedNodes.length = 0;
      return [];
    }
    if (head.includes("insert into public.workflow_nodes")) {
      storedNodes.push({
        node_key: values[1], type: values[2], kind: values[3],
        label: values[4], position_x: values[5], position_y: values[6],
        config: JSON.parse(String(values[7])), enabled: values[8],
      });
      return [];
    }
    if (head.includes("insert into public.workflow_edges")) {
      storedEdges.push({
        edge_key: values[1], from_node_key: values[2],
        to_node_key: values[3], from_port: values[4], label: values[5],
      });
      return [];
    }
    if (head.includes("update public.workflows set")) return [];
    if (head.includes("from public.workflows where id =")) return [workflowRow];
    if (head.includes("from public.workflow_nodes")) {
      return storedNodes.map((n) => ({ ...n }));
    }
    if (head.includes("from public.workflow_edges")) {
      return storedEdges.map((e) => ({ ...e }));
    }
    throw new Error(`Unhandled query in fake db: ${head.slice(0, 80)}`);
  }) as unknown as Parameters<typeof updateWorkflow>[0];

  return { db, originalNodes, deleteCount: () => deleteCount };
}

describe("updateWorkflow graph replacement", () => {
  it("rejects a graph carrying a removed kind and leaves the stored graph intact", async () => {
    const { db, originalNodes, deleteCount } = makeGraphDb();
    // A v1-era draft can still carry kinds the v2 catalog removed
    // (send_sms). Even a harmless rename resubmits the whole graph —
    // the save must fail BEFORE the stored graph is touched
    // (Codex P1 on PR #63: validation ran inside the insert loop,
    // after the deletes, erasing the draft).
    const removedKindNode = {
      node_key: "a9", type: "action", kind: "send_sms",
      label: "Text the lead", position_x: 0, position_y: 0,
      config: { to: "+1 555 0100", message: "hi" }, enabled: true,
    } as unknown as WorkflowNode;

    await expect(
      updateWorkflow(db, "wf-graph", {
        name: "Renamed draft",
        nodes: [originalNodes[0], removedKindNode],
        edges: [],
      }),
    ).rejects.toThrow("Unknown node kind: send_sms");

    expect(deleteCount()).toBe(0);
    const after = await getWorkflow(db, "wf-graph");
    expect(after?.nodes).toEqual(originalNodes);
    expect(after?.edges).toEqual([
      { edge_key: "e1", from_node_key: "t1", to_node_key: "a1", from_port: null, label: null },
    ]);
  });

  it("replaces the graph when every kind is in the catalog", async () => {
    const { db, originalNodes, deleteCount } = makeGraphDb();
    const updated = await updateWorkflow(db, "wf-graph", {
      name: "Renamed draft",
      nodes: [
        originalNodes[0],
        { node_key: "a2", type: "action", kind: "send_email", label: "Email", position_x: 30, position_y: 40, config: { to: "", subject: "", body: "" }, enabled: true },
      ],
      edges: [
        { edge_key: "e2", from_node_key: "t1", to_node_key: "a2", from_port: null, label: null },
      ],
    });
    expect(deleteCount()).toBe(2);
    expect(updated?.nodes.map((n) => n.node_key)).toEqual(["t1", "a2"]);
    expect(updated?.edges.map((e) => e.edge_key)).toEqual(["e2"]);
  });
});
