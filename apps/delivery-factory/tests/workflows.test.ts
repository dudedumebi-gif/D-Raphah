import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NODE_CATALOG,
  executeWorkflow,
  renderTemplate,
  specFor,
  type Workflow,
} from "../api/_lib/workflows.js";
import {
  buildUseCaseWorkflowDraft,
  type UseCaseWorkflowProjectRef,
} from "../api/_lib/use-case-workflows.js";
import { packageBase, signTestPackage } from "./helpers.js";

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
    // Hyphenated segments (e.g. node keys) resolve too
    expect(
      renderTemplate("{{node_action-1.output}}", { "node_action-1": { output: "draft text" } }),
    ).toBe("draft text");
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
        { node_key: "a1", type: "action", kind: "slack_notify", label: "Notify", position_x: 0, position_y: 0, config: { webhookUrl: "https://example.com/hook", message: "hi" }, enabled: true },
      ],
      edges: [{ edge_key: "e1", from_node_key: "t1", to_node_key: "a1", from_port: null, label: null }],
    };
    const { db, steps } = makeFakeDb(bad);
    const run = await executeWorkflow(db, bad.id, {});
    expect(run.status).toBe("failed");
    expect(run.error).toContain("invalid Slack webhook URL");
    expect(steps.find((s) => s.node_key === "a1")?.status).toBe("failed");
  });

  it("send_email with a recipient records the no-provider draft unchanged", async () => {
    const wf: Workflow = {
      ...demoWorkflow,
      nodes: [
        { node_key: "t1", type: "trigger", kind: "manual", label: "Manual", position_x: 0, position_y: 0, config: {}, enabled: true },
        { node_key: "a1", type: "action", kind: "send_email", label: "Email", position_x: 0, position_y: 0, config: { to: "client@example.com", subject: "Hi {{trigger.lead.name}}", body: "<p>Hello</p>" }, enabled: true },
      ],
      edges: [{ edge_key: "e1", from_node_key: "t1", to_node_key: "a1", from_port: null, label: null }],
    };
    const { db, steps } = makeFakeDb(wf);
    const run = await executeWorkflow(db, wf.id, { lead: { name: "Acme Corp" } });
    expect(run.status).toBe("completed");
    const email = steps.find((s) => s.node_key === "a1");
    expect(email?.status).toBe("success");
    // No provider configured: intent recorded, nothing delivered.
    expect(email?.output).toMatchObject({
      delivered: false, queued: true,
      to: "client@example.com", subject: "Hi Acme Corp", body: "<p>Hello</p>",
    });
  });

  it("send_email with a recipient uses the provider hook when configured", async () => {
    const wf: Workflow = {
      ...demoWorkflow,
      nodes: [
        { node_key: "t1", type: "trigger", kind: "manual", label: "Manual", position_x: 0, position_y: 0, config: {}, enabled: true },
        { node_key: "a1", type: "action", kind: "send_email", label: "Email", position_x: 0, position_y: 0, config: { to: "client@example.com", subject: "Hello", body: "<p>Hi</p>" }, enabled: true },
      ],
      edges: [{ edge_key: "e1", from_node_key: "t1", to_node_key: "a1", from_port: null, label: null }],
    };
    const { db, steps } = makeFakeDb(wf);
    const seen: Array<Record<string, unknown>> = [];
    const run = await executeWorkflow(
      db, wf.id, {},
      { sendEmail: async (args) => { seen.push(args); return { delivered: true, id: "msg-1" }; } },
    );
    expect(run.status).toBe("completed");
    expect(seen).toEqual([{ to: "client@example.com", subject: "Hello", body: "<p>Hi</p>", encryptSensitive: false }]);
    expect(steps.find((s) => s.node_key === "a1")?.output).toMatchObject({ delivered: true, id: "msg-1" });
  });

  it("send_email with a whitespace-only recipient completes as a draft", async () => {
    const wf: Workflow = {
      ...demoWorkflow,
      nodes: [
        { node_key: "t1", type: "trigger", kind: "manual", label: "Manual", position_x: 0, position_y: 0, config: {}, enabled: true },
        { node_key: "a1", type: "action", kind: "send_email", label: "Email", position_x: 0, position_y: 0, config: { to: "   ", subject: "Draft subject", body: "<p>Draft body</p>" }, enabled: true },
      ],
      edges: [{ edge_key: "e1", from_node_key: "t1", to_node_key: "a1", from_port: null, label: null }],
    };
    const { db, steps } = makeFakeDb(wf);
    const run = await executeWorkflow(db, wf.id, {});
    expect(run.status).toBe("completed");
    const email = steps.find((s) => s.node_key === "a1");
    expect(email?.status).toBe("success");
    expect(email?.output).toMatchObject({
      delivered: false, draft: true,
      reason: "no recipient set — draft only",
      subject: "Draft subject", body: "<p>Draft body</p>",
    });
  });

  it("send_sms records a draft when no provider is configured", async () => {
    const wf: Workflow = {
      ...demoWorkflow,
      nodes: [
        { node_key: "t1", type: "trigger", kind: "manual", label: "Manual", position_x: 0, position_y: 0, config: {}, enabled: true },
        { node_key: "a1", type: "action", kind: "send_sms", label: "SMS", position_x: 0, position_y: 0, config: { to: "+14165550123", message: "Hi {{trigger.lead.name}}, we got your request." }, enabled: true },
      ],
      edges: [{ edge_key: "e1", from_node_key: "t1", to_node_key: "a1", from_port: null, label: null }],
    };
    const { db, steps } = makeFakeDb(wf);
    const run = await executeWorkflow(db, wf.id, { lead: { name: "Acme Corp" } });
    expect(run.status).toBe("completed");
    const sms = steps.find((s) => s.node_key === "a1");
    expect(sms?.status).toBe("success");
    // Template rendered, but nothing sent without a provider (MVP outreach rule)
    expect(sms?.output).toMatchObject({
      delivered: false, queued: true, draft: true,
      to: "+14165550123",
      message: "Hi Acme Corp, we got your request.",
    });
  });

  it("send_sms uses the provider hook when configured", async () => {
    const wf: Workflow = {
      ...demoWorkflow,
      nodes: [
        { node_key: "t1", type: "trigger", kind: "manual", label: "Manual", position_x: 0, position_y: 0, config: {}, enabled: true },
        { node_key: "a1", type: "action", kind: "send_sms", label: "SMS", position_x: 0, position_y: 0, config: { to: "+14165550123", message: "Hello" }, enabled: true },
      ],
      edges: [{ edge_key: "e1", from_node_key: "t1", to_node_key: "a1", from_port: null, label: null }],
    };
    const { db, steps } = makeFakeDb(wf);
    const seen: Array<Record<string, unknown>> = [];
    const run = await executeWorkflow(
      db, wf.id, {},
      { sendSms: async (args) => { seen.push(args); return { delivered: true, sid: "SM123" }; } },
    );
    expect(run.status).toBe("completed");
    expect(seen).toEqual([{ to: "+14165550123", message: "Hello" }]);
    expect(steps.find((s) => s.node_key === "a1")?.output).toMatchObject({ delivered: true, sid: "SM123" });
  });

  it("send_sms requires to and message", async () => {
    const wf: Workflow = {
      ...demoWorkflow,
      nodes: [
        { node_key: "t1", type: "trigger", kind: "manual", label: "Manual", position_x: 0, position_y: 0, config: {}, enabled: true },
        { node_key: "a1", type: "action", kind: "send_sms", label: "SMS", position_x: 0, position_y: 0, config: { message: "no recipient" }, enabled: true },
      ],
      edges: [{ edge_key: "e1", from_node_key: "t1", to_node_key: "a1", from_port: null, label: null }],
    };
    const { db } = makeFakeDb(wf);
    const run = await executeWorkflow(db, wf.id, {});
    expect(run.status).toBe("failed");
    expect(run.error).toContain("'to' is required");
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
 * The seeded "Lead follow-up (SMS, draft-first)" demo template
 * (neon/migrations/202609262336_lead_followup_sms_demo.sql), mirrored here
 * so its definition validity and draft-first execution are pinned by tests.
 */
const leadFollowupDemo: Workflow = {
  id: randomUUID(),
  name: "Lead follow-up (SMS, draft-first)",
  description: "Demo template: on a qualified lead handoff, draft a personalized follow-up SMS with AI, then queue the SMS as a draft for human approval. Nothing sends automatically.",
  status: "published",
  environment: "demo",
  trigger_type: "lead_handoff",
  trigger_config: { minScore: 0 },
  created_by: "seed",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  published_at: new Date().toISOString(),
  nodes: [
    { node_key: "trigger-1", type: "trigger", kind: "lead_handoff", label: "Lead Handoff", position_x: 360, position_y: 40, config: { minScore: 0 }, enabled: true },
    {
      node_key: "action-1", type: "action", kind: "ai_assist", label: "Draft follow-up SMS",
      position_x: 360, position_y: 220,
      config: {
        model: "gpt-4o-mini",
        systemPrompt: "You write short follow-up SMS messages for local service businesses. Warm and specific, never hype or false claims. Never invent facts you were not given. Output only the message text.",
        userPrompt: "Write one SMS under 160 characters following up with {{trigger.lead.name}} at {{trigger.organization_name}} (lead score {{trigger.lead.score}}/100). Invite a reply with a specific question.",
        maxTokens: 200,
      },
      enabled: true,
    },
    {
      node_key: "action-2", type: "action", kind: "send_sms", label: "Queue SMS draft",
      position_x: 360, position_y: 400,
      config: { to: "{{trigger.lead.phone}}", message: "{{node_action-1.output}}" },
      enabled: true,
    },
    {
      node_key: "action-3", type: "action", kind: "log_database", label: "Log follow-up drafted",
      position_x: 360, position_y: 580,
      config: { message: "SMS follow-up draft queued for {{trigger.lead.name}} ({{trigger.lead.phone}}); AI draft recorded, awaiting human approval", level: "info" },
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

describe("lead follow-up (SMS, draft-first) demo", () => {
  it("definition is valid: catalogued kinds, one trigger, wired edges", () => {
    expect(leadFollowupDemo.status).toBe("published");
    expect(leadFollowupDemo.trigger_type).toBe("lead_handoff");
    for (const node of leadFollowupDemo.nodes) {
      expect(specFor(node.kind)).toBeDefined();
    }
    const triggers = leadFollowupDemo.nodes.filter((n) => n.type === "trigger");
    expect(triggers).toHaveLength(1);
    expect(triggers[0].kind).toBe("lead_handoff");
    const keys = new Set(leadFollowupDemo.nodes.map((n) => n.node_key));
    for (const edge of leadFollowupDemo.edges) {
      expect(keys.has(edge.from_node_key)).toBe(true);
      expect(keys.has(edge.to_node_key)).toBe(true);
    }
    // send_sms consumes the ai_assist draft output from the run context
    const sms = leadFollowupDemo.nodes.find((n) => n.node_key === "action-2")!;
    expect(sms.config.message).toBe("{{node_action-1.output}}");
  });

  it("executes draft-first: AI draft stub feeds the queued SMS draft", async () => {
    const { db, runs, steps, auditLog } = makeFakeDb(leadFollowupDemo);
    const run = await executeWorkflow(db, leadFollowupDemo.id, sampleLeadPayload);

    expect(run.status).toBe("completed");
    expect(run.error).toBeNull();
    // Run recorded in history with per-step records
    expect(runs.has(run.id)).toBe(true);
    const labels = steps.map((s) => `${s.node_label}:${s.status}`);
    expect(labels).toEqual([
      "Lead Handoff:success",
      "Draft follow-up SMS:success",
      "Queue SMS draft:success",
      "Log follow-up drafted:success",
    ]);

    const ai = steps.find((s) => s.node_key === "action-1")!;
    expect(ai.output).toMatchObject({ delivered: false, draft: true });
    expect(String((ai.output as Record<string, unknown>).output)).toContain(
      "[draft stub",
    );

    // No provider configured: nothing sent, draft queued for human approval
    const sms = steps.find((s) => s.node_key === "action-2")!;
    expect(sms.output).toMatchObject({
      delivered: false,
      draft: true,
      queued: true,
      to: "+14165550123",
    });
    // The queued message is the AI draft, not a template placeholder
    expect(String((sms.output as Record<string, unknown>).message)).toContain(
      "INS Market",
    );
    expect(String((sms.output as Record<string, unknown>).message)).not.toContain(
      "{{",
    );

    const log = steps.find((s) => s.node_key === "action-3")!;
    expect(log.output).toMatchObject({ logged: true });
    expect(auditLog).toHaveLength(1);
    expect(auditLog[0].message).toContain("INS Market");
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
    // AI produced a real draft, but SMS still queued as a draft: no auto-send
    const sms = steps.find((s) => s.node_key === "action-2")!;
    expect(sms.output).toMatchObject({
      delivered: false,
      draft: true,
      message: "Hi INS Market — quick question about your follow-up plan?",
    });
  });
});

/**
 * A use-case skeleton exactly as the generator builds it from a
 * landed package (buildUseCaseWorkflowDraft), wrapped as the
 * published workflow an operator live-tests from Automations.
 * The skeleton's send_email ships to:"" by design (draft-first,
 * never auto-send) — executing it must still complete end-to-end,
 * with the email step recorded as a draft. This is the flow that
 * failed in production on 2026-10-15 (the user's Donddental
 * skeleton run died at send_email: 'to' is required) before the
 * executor learned to complete recipient-less email steps as
 * drafts instead of throwing.
 */
describe("use-case skeleton (generator output)", () => {
  const { pkg } = signTestPackage(
    packageBase({
      organization: { name: "Donddental", domain: "donddental.ca" },
      requirementBaseline: {
        version: 1,
        requirements: [
          {
            id: randomUUID(),
            opportunityId: randomUUID(),
            code: "UC-ONLINE-APPOINTMENT-BOOKING",
            statement:
              "The business will enable patients to book appointments online seamlessly.",
            priority: "must",
            status: "validated",
            humanValidatorId: "reviewer-1",
            acceptanceCriteria: [
              "Patients can book appointments 24/7 through the website",
              "Confirmation emails are sent to patients immediately after booking",
            ],
            blockingQuestions: [],
          },
        ],
        features: [],
      },
      successMeasures: [
        {
          metric: "Increase in online bookings",
          target:
            "Achieve a 30% increase in online appointment bookings within the next quarter",
        },
      ],
    }),
  );

  function skeletonWorkflow(): Workflow {
    const project: UseCaseWorkflowProjectRef = {
      id: randomUUID(),
      environment: "production",
      package_id: pkg.packageId,
      organization_name: pkg.organization.name,
    };
    const draft = buildUseCaseWorkflowDraft({
      project,
      packageId: pkg.packageId,
      requirement: pkg.requirementBaseline.requirements[0],
      successMeasures: pkg.successMeasures,
    });
    return {
      id: randomUUID(),
      name: draft.name,
      description: draft.description,
      status: "published",
      environment: "production",
      trigger_type: "manual",
      trigger_config: draft.trigger_config,
      created_by: "intake-skeleton",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      published_at: new Date().toISOString(),
      nodes: draft.nodes,
      edges: draft.edges,
    };
  }

  it("runs end-to-end: every step succeeds and the email step completes as a draft", async () => {
    const wf = skeletonWorkflow();
    const { db, steps, auditLog } = makeFakeDb(wf);
    const run = await executeWorkflow(db, wf.id, {});

    expect(run.status).toBe("completed");
    expect(run.error).toBeNull();
    const labels = steps.map((s) => `${s.node_label}:${s.status}`);
    expect(labels).toEqual([
      "Manual start:success",
      "Draft plan — Online Appointment Booking:success",
      "Draft client email:success",
      "Log run:success",
    ]);

    // Nothing was sent: the recipient-less email step completed as
    // an auditable draft carrying the rendered subject and body.
    const email = steps.find((s) => s.node_key === "action-2")!;
    expect(email.output).toMatchObject({
      delivered: false,
      draft: true,
      reason: "no recipient set — draft only",
      subject: "Donddental — Online Appointment Booking",
    });
    expect(String((email.output as Record<string, unknown>).body)).toContain(
      "Patients can book appointments 24/7 through the website",
    );

    // The run continued past the email step to the audit log.
    expect(auditLog).toHaveLength(1);
    expect(auditLog[0].message).toContain("UC-ONLINE-APPOINTMENT-BOOKING");
  });
});
