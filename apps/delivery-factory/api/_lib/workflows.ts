/**
 * Workflow automation engine for the Delivery Factory.
 *
 * Visual, auditable automation workflows (ChronoFlow-style): triggers,
 * actions and logic gates are stored as nodes/edges in Postgres, executed
 * by a deterministic interpreter, and every run is audited per-node in
 * workflow_runs / workflow_run_steps.
 *
 * The Delivery Factory owns this database outright (DELIVERY_DATABASE_URL).
 * It never imports from apps/leads-engine and never touches the Lead Engine
 * database: integration is contract-only via POST /api/intake.
 */

import type { NeonClient } from "./db.js";

/* ── Types ─────────────────────────────────────────────────────────────── */

export type WorkflowStatus = "draft" | "published" | "archived";
export type WorkflowTriggerType =
  | "webhook"
  | "schedule"
  | "manual"
  | "lead_handoff"
  | "event";

export type NodeType = "trigger" | "action" | "logic";
export type NodeKind =
  // triggers
  | "webhook"
  | "schedule"
  | "manual"
  | "lead_handoff"
  // actions
  | "send_email"
  | "send_sms"
  | "ai_assist"
  | "http_request"
  | "log_database"
  | "slack_notify"
  | "create_project"
  | "update_status"
  | "assign_gate"
  // logic
  | "if_else"
  | "wait";

export interface WorkflowNode {
  node_key: string;
  type: NodeType;
  kind: NodeKind;
  label: string;
  position_x: number;
  position_y: number;
  config: Record<string, unknown>;
  enabled: boolean;
}

export interface WorkflowEdge {
  edge_key: string;
  from_node_key: string;
  to_node_key: string;
  from_port: string | null;
  label: string | null;
}

export interface Workflow {
  id: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  trigger_type: WorkflowTriggerType;
  trigger_config: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export type RunStatus = "running" | "completed" | "failed" | "cancelled";
export type StepStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "skipped";

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  trigger_type: string;
  trigger_payload: Record<string, unknown> | null;
  status: RunStatus;
  output: Record<string, unknown> | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  steps?: WorkflowRunStep[];
}

export interface WorkflowRunStep {
  id: string;
  run_id: string;
  node_key: string;
  node_kind: string;
  node_label: string;
  status: StepStatus;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

/* ── Node catalog (drives the visual builder palette) ──────────────────── */

export interface NodeSpec {
  kind: NodeKind;
  type: NodeType;
  label: string;
  icon: string; // emoji used by the builder UI
  description: string;
  defaultConfig: Record<string, unknown>;
  configSchema: Array<{
    key: string;
    label: string;
    kind: "text" | "textarea" | "number" | "select" | "toggle" | "json";
    placeholder?: string;
    options?: Array<{ value: string; label: string }>;
    help?: string;
  }>;
}

export const NODE_CATALOG: NodeSpec[] = [
  // ── triggers ──
  {
    kind: "webhook", type: "trigger", label: "Webhook", icon: "🪝",
    description: "Start when an HTTP POST hits the workflow's webhook URL.",
    defaultConfig: { path: "", secret: "" },
    configSchema: [
      { key: "path", label: "Path suffix", kind: "text", placeholder: "e.g. new-lead", help: "Appended to /api/workflows/trigger/" },
      { key: "secret", label: "Shared secret (optional)", kind: "text", placeholder: "Bearer token expected in X-Webhook-Secret" },
    ],
  },
  {
    kind: "schedule", type: "trigger", label: "Schedule", icon: "⏰",
    description: "Start on a cron schedule.",
    defaultConfig: { cron: "0 9 * * *", timezone: "America/Toronto" },
    configSchema: [
      { key: "cron", label: "Cron expression", kind: "text", placeholder: "0 9 * * *" },
      { key: "timezone", label: "Timezone", kind: "text", placeholder: "America/Toronto" },
    ],
  },
  {
    kind: "manual", type: "trigger", label: "Manual", icon: "▶️",
    description: "Start from the dashboard or API.",
    defaultConfig: {},
    configSchema: [],
  },
  {
    kind: "lead_handoff", type: "trigger", label: "Lead Handoff", icon: "📥",
    description: "Start when the Lead Engine delivers an accepted handoff package.",
    defaultConfig: { minScore: 0 },
    configSchema: [
      { key: "minScore", label: "Minimum lead score", kind: "number", placeholder: "0" },
    ],
  },
  // ── actions ──
  {
    kind: "send_email", type: "action", label: "Send Email", icon: "✉️",
    description: "Send an email. Supports {{path}} template variables from the run context.",
    defaultConfig: { to: "", subject: "", body: "", encryptSensitive: false },
    configSchema: [
      { key: "to", label: "Recipient email", kind: "text", placeholder: "email@example.com" },
      { key: "subject", label: "Subject line", kind: "text", placeholder: "Enter your subject here" },
      { key: "body", label: "Email body (HTML)", kind: "textarea", placeholder: "<p>Hello {{lead.name}}</p>" },
      { key: "encryptSensitive", label: "Encrypt sensitive data", kind: "toggle" },
    ],
  },
  {
    kind: "send_sms", type: "action", label: "Send SMS", icon: "📱",
    description: "Send (or draft) an SMS via the configured provider. With no provider, records the draft for human approval per the no-automated-outreach rule.",
    defaultConfig: { to: "", message: "" },
    configSchema: [
      { key: "to", label: "Recipient phone", kind: "text", placeholder: "+14165550123" },
      { key: "message", label: "Message", kind: "textarea", placeholder: "Hi {{lead.name}}, thanks for contacting us…" },
    ],
  },
  {
    kind: "ai_assist", type: "action", label: "AI Assist", icon: "🤖",
    description: "Draft content with an AI model (summaries, replies, content). Output lands in the run context for a human to review — never sent automatically.",
    defaultConfig: { model: "gpt-4o-mini", systemPrompt: "", userPrompt: "", maxTokens: 500 },
    configSchema: [
      { key: "model", label: "Model", kind: "text", placeholder: "gpt-4o-mini" },
      { key: "systemPrompt", label: "System prompt", kind: "textarea", placeholder: "You are a helpful assistant drafting…" },
      { key: "userPrompt", label: "User prompt", kind: "textarea", placeholder: "Draft a reply to: {{lead.message}}" },
      { key: "maxTokens", label: "Max tokens", kind: "number", placeholder: "500" },
    ],
  },
  {
    kind: "http_request", type: "action", label: "HTTP Request", icon: "🌐",
    description: "Call any HTTPS endpoint. Body supports {{path}} templates and a JSON payload editor.",
    defaultConfig: { method: "POST", url: "", headers: {}, body: {} },
    configSchema: [
      { key: "method", label: "Method", kind: "select", options: [
        { value: "GET", label: "GET" }, { value: "POST", label: "POST" },
        { value: "PUT", label: "PUT" }, { value: "PATCH", label: "PATCH" },
        { value: "DELETE", label: "DELETE" },
      ]},
      { key: "url", label: "URL", kind: "text", placeholder: "https://api.example.com/hook" },
      { key: "headers", label: "Headers (JSON)", kind: "json" },
      { key: "body", label: "JSON payload", kind: "json" },
    ],
  },
  {
    kind: "log_database", type: "action", label: "Log to Database", icon: "🗄️",
    description: "Write an audit entry into the delivery audit log.",
    defaultConfig: { message: "", level: "info" },
    configSchema: [
      { key: "message", label: "Message", kind: "textarea", placeholder: "Workflow {{workflow.name}} ran" },
      { key: "level", label: "Level", kind: "select", options: [
        { value: "info", label: "Info" }, { value: "warn", label: "Warning" }, { value: "error", label: "Error" },
      ]},
    ],
  },
  {
    kind: "slack_notify", type: "action", label: "Slack", icon: "💬",
    description: "Post a message to a Slack channel via incoming webhook.",
    defaultConfig: { webhookUrl: "", message: "" },
    configSchema: [
      { key: "webhookUrl", label: "Incoming webhook URL", kind: "text", placeholder: "https://hooks.slack.com/..." },
      { key: "message", label: "Message", kind: "textarea", placeholder: "New lead: {{lead.name}}" },
    ],
  },
  {
    kind: "create_project", type: "action", label: "Create Project", icon: "📁",
    description: "Create a Delivery Factory project (e.g. from an accepted lead).",
    defaultConfig: { name: "{{lead.name}}", client: "{{lead.company}}" },
    configSchema: [
      { key: "name", label: "Project name", kind: "text" },
      { key: "client", label: "Client", kind: "text" },
    ],
  },
  {
    kind: "update_status", type: "action", label: "Update System Status", icon: "✅",
    description: "Record a status heartbeat for monitoring dashboards.",
    defaultConfig: { service: "delivery-factory", status: "ok", note: "" },
    configSchema: [
      { key: "service", label: "Service", kind: "text" },
      { key: "status", label: "Status", kind: "select", options: [
        { value: "ok", label: "OK" }, { value: "degraded", label: "Degraded" }, { value: "down", label: "Down" },
      ]},
      { key: "note", label: "Note", kind: "text" },
    ],
  },
  {
    kind: "assign_gate", type: "action", label: "Assign Gate", icon: "🚦",
    description: "Add a review gate (milestone) to a project. projectId accepts {{node_<key>.project_id}} from a Create Project step.",
    defaultConfig: { projectId: "", label: "Client review", targetDate: "" },
    configSchema: [
      { key: "projectId", label: "Project ID", kind: "text", placeholder: "{{node_node-3.project_id}}" },
      { key: "label", label: "Gate label", kind: "text" },
      { key: "targetDate", label: "Target date (YYYY-MM-DD)", kind: "text" },
    ],
  },
  // ── logic ──
  {
    kind: "if_else", type: "logic", label: "If / Else", icon: "🔀",
    description: "Branch on a condition. True port → 'true' edge, else → 'false' edge.",
    defaultConfig: { field: "", operator: "exists", value: "" },
    configSchema: [
      { key: "field", label: "Field path", kind: "text", placeholder: "lead.score" },
      { key: "operator", label: "Operator", kind: "select", options: [
        { value: "exists", label: "exists" }, { value: "equals", label: "equals" },
        { value: "not_equals", label: "not equals" }, { value: "gt", label: "greater than" },
        { value: "gte", label: "greater or equal" }, { value: "lt", label: "less than" },
        { value: "contains", label: "contains" },
      ]},
      { key: "value", label: "Compare value", kind: "text" },
    ],
  },
  {
    kind: "wait", type: "logic", label: "Wait", icon: "⏳",
    description: "Pause before continuing. (Long waits are clamped in serverless.)",
    defaultConfig: { seconds: 5 },
    configSchema: [
      { key: "seconds", label: "Seconds", kind: "number", placeholder: "5", help: "Clamped to 60s per execution step" },
    ],
  },
];

export function specFor(kind: NodeKind): NodeSpec {
  const spec = NODE_CATALOG.find((s) => s.kind === kind);
  if (!spec) throw new Error(`Unknown node kind: ${kind}`);
  return spec;
}

/**
 * Typed wrapper around the neon tag client. The driver's result type is a
 * union (rows | FullQueryResults); every workflow query selects rows, so we
 * narrow once here instead of at each call site.
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

/* ── Template rendering ──────────────────────────────────────────────────
   {{path.to.value}} is resolved against the run context. */

export function renderTemplate(
  template: unknown,
  context: Record<string, unknown>,
): unknown {
  if (typeof template === "string") {
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
      const value = path.split(".").reduce<unknown>(
        (acc, key) => (acc != null && typeof acc === "object"
          ? (acc as Record<string, unknown>)[key]
          : undefined),
        context,
      );
      return value == null ? "" : String(value);
    });
  }
  if (Array.isArray(template)) {
    return template.map((item) => renderTemplate(item, context));
  }
  if (template != null && typeof template === "object") {
    return Object.fromEntries(
      Object.entries(template as Record<string, unknown>).map(([k, v]) => [
        k,
        renderTemplate(v, context),
      ]),
    );
  }
  return template;
}

function getPath(context: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (acc, key) => (acc != null && typeof acc === "object"
      ? (acc as Record<string, unknown>)[key]
      : undefined),
    context,
  );
}

function evaluateCondition(
  field: string,
  operator: string,
  value: string,
  context: Record<string, unknown>,
): boolean {
  const actual = getPath(context, field);
  switch (operator) {
    case "exists": return actual !== undefined && actual !== null && actual !== "";
    case "equals": return String(actual ?? "") === value;
    case "not_equals": return String(actual ?? "") !== value;
    case "gt": return Number(actual) > Number(value);
    case "gte": return Number(actual) >= Number(value);
    case "lt": return Number(actual) < Number(value);
    case "contains": return String(actual ?? "").includes(value);
    default: return false;
  }
}

/* ── CRUD ──────────────────────────────────────────────────────────────── */

export async function listWorkflows(db: NeonClient): Promise<Workflow[]> {
  const rows = await q(db)`
    select id, name, description, status, trigger_type, trigger_config,
           created_by, created_at, updated_at, published_at
    from public.workflows order by updated_at desc`;
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    description: r.description as string | null,
    status: r.status as WorkflowStatus,
    trigger_type: r.trigger_type as WorkflowTriggerType,
    trigger_config: (r.trigger_config ?? {}) as Record<string, unknown>,
    created_by: r.created_by as string | null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    published_at: r.published_at ? String(r.published_at) : null,
    nodes: [],
    edges: [],
  }));
}

export async function getWorkflow(
  db: NeonClient,
  id: string,
): Promise<Workflow | null> {
  const rows = await q(db)`
    select id, name, description, status, trigger_type, trigger_config,
           created_by, created_at, updated_at, published_at
    from public.workflows where id = ${id}`;
  if (rows.length === 0) return null;
  const r = rows[0];
  const nodes = await q(db)`
    select node_key, type, kind, label, position_x, position_y, config, enabled
    from public.workflow_nodes where workflow_id = ${id}`;
  const edges = await q(db)`
    select edge_key, from_node_key, to_node_key, from_port, label
    from public.workflow_edges where workflow_id = ${id}`;
  return {
    id: r.id as string,
    name: r.name as string,
    description: r.description as string | null,
    status: r.status as WorkflowStatus,
    trigger_type: r.trigger_type as WorkflowTriggerType,
    trigger_config: (r.trigger_config ?? {}) as Record<string, unknown>,
    created_by: r.created_by as string | null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    published_at: r.published_at ? String(r.published_at) : null,
    nodes: nodes.map((n) => ({
      node_key: n.node_key as string,
      type: n.type as NodeType,
      kind: n.kind as NodeKind,
      label: n.label as string,
      position_x: n.position_x as number,
      position_y: n.position_y as number,
      config: (n.config ?? {}) as Record<string, unknown>,
      enabled: n.enabled as boolean,
    })),
    edges: edges.map((e) => ({
      edge_key: e.edge_key as string,
      from_node_key: e.from_node_key as string,
      to_node_key: e.to_node_key as string,
      from_port: e.from_port as string | null,
      label: e.label as string | null,
    })),
  };
}

export interface UpsertWorkflowInput {
  name: string;
  description?: string;
  trigger_type?: WorkflowTriggerType;
  trigger_config?: Record<string, unknown>;
  created_by?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export async function createWorkflow(
  db: NeonClient,
  input: UpsertWorkflowInput,
): Promise<Workflow> {
  const rows = await q(db)`
    insert into public.workflows
      (name, description, trigger_type, trigger_config, created_by)
    values (
      ${input.name},
      ${input.description ?? null},
      ${input.trigger_type ?? "manual"},
      ${JSON.stringify(input.trigger_config ?? {})}::jsonb,
      ${input.created_by ?? null}
    )
    returning id`;
  const id = rows[0].id as string;
  await replaceGraph(db, id, input.nodes, input.edges);
  const wf = await getWorkflow(db, id);
  if (!wf) throw new Error("Workflow vanished after create");
  return wf;
}

export async function updateWorkflow(
  db: NeonClient,
  id: string,
  input: UpsertWorkflowInput,
): Promise<Workflow | null> {
  const existing = await getWorkflow(db, id);
  if (!existing) return null;
  if (existing.status === "published") {
    throw new Error("Published workflows are immutable — duplicate to edit.");
  }
  await q(db)`
    update public.workflows set
      name = ${input.name},
      description = ${input.description ?? null},
      trigger_type = ${input.trigger_type ?? existing.trigger_type},
      trigger_config = ${JSON.stringify(input.trigger_config ?? existing.trigger_config)}::jsonb
    where id = ${id}`;
  await replaceGraph(db, id, input.nodes, input.edges);
  return getWorkflow(db, id);
}

async function replaceGraph(
  db: NeonClient,
  workflowId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): Promise<void> {
  await q(db)`delete from public.workflow_edges where workflow_id = ${workflowId}`;
  await q(db)`delete from public.workflow_nodes where workflow_id = ${workflowId}`;
  for (const n of nodes) {
    specFor(n.kind); // validates kind
    await q(db)`
      insert into public.workflow_nodes
        (workflow_id, node_key, type, kind, label, position_x, position_y, config, enabled)
      values (
        ${workflowId}, ${n.node_key}, ${n.type}, ${n.kind}, ${n.label},
        ${Math.round(n.position_x)}, ${Math.round(n.position_y)},
        ${JSON.stringify(n.config ?? {})}::jsonb, ${n.enabled !== false}
      )`;
  }
  for (const e of edges) {
    await q(db)`
      insert into public.workflow_edges
        (workflow_id, edge_key, from_node_key, to_node_key, from_port, label)
      values (
        ${workflowId}, ${e.edge_key}, ${e.from_node_key}, ${e.to_node_key},
        ${e.from_port ?? null}, ${e.label ?? null}
      )`;
  }
}

export async function deleteWorkflow(
  db: NeonClient,
  id: string,
): Promise<boolean> {
  const rows = await q(db)`delete from public.workflows where id = ${id} returning id`;
  return rows.length > 0;
}

export async function publishWorkflow(
  db: NeonClient,
  id: string,
): Promise<Workflow | null> {
  const wf = await getWorkflow(db, id);
  if (!wf) return null;
  const triggers = wf.nodes.filter((n) => n.type === "trigger" && n.enabled);
  if (triggers.length === 0) {
    throw new Error("A workflow needs at least one enabled trigger to publish.");
  }
  await q(db)`
    update public.workflows
    set status = 'published', published_at = now()
    where id = ${id}`;
  return getWorkflow(db, id);
}

export async function archiveWorkflow(
  db: NeonClient,
  id: string,
): Promise<Workflow | null> {
  await q(db)`update public.workflows set status = 'archived' where id = ${id}`;
  return getWorkflow(db, id);
}

/* ── Runs / audit ──────────────────────────────────────────────────────── */

export async function listRuns(
  db: NeonClient,
  workflowId: string,
  limit = 50,
): Promise<WorkflowRun[]> {
  const rows = await q(db)`
    select id, workflow_id, trigger_type, trigger_payload, status, output,
           error, started_at, completed_at
    from public.workflow_runs
    where workflow_id = ${workflowId}
    order by started_at desc limit ${limit}`;
  return rows.map((r) => ({
    id: r.id as string,
    workflow_id: r.workflow_id as string,
    trigger_type: r.trigger_type as string,
    trigger_payload: (r.trigger_payload ?? null) as Record<string, unknown> | null,
    status: r.status as RunStatus,
    output: (r.output ?? null) as Record<string, unknown> | null,
    error: r.error as string | null,
    started_at: String(r.started_at),
    completed_at: r.completed_at ? String(r.completed_at) : null,
  }));
}

export async function getRun(
  db: NeonClient,
  runId: string,
): Promise<WorkflowRun | null> {
  const rows = await q(db)`
    select id, workflow_id, trigger_type, trigger_payload, status, output,
           error, started_at, completed_at
    from public.workflow_runs where id = ${runId}`;
  if (rows.length === 0) return null;
  const r = rows[0];
  const steps = await q(db)`
    select id, run_id, node_key, node_kind, node_label, status, input, output,
           error, started_at, completed_at
    from public.workflow_run_steps where run_id = ${runId}
    order by started_at asc`;
  return {
    id: r.id as string,
    workflow_id: r.workflow_id as string,
    trigger_type: r.trigger_type as string,
    trigger_payload: (r.trigger_payload ?? null) as Record<string, unknown> | null,
    status: r.status as RunStatus,
    output: (r.output ?? null) as Record<string, unknown> | null,
    error: r.error as string | null,
    started_at: String(r.started_at),
    completed_at: r.completed_at ? String(r.completed_at) : null,
    steps: steps.map((s) => ({
      id: s.id as string,
      run_id: s.run_id as string,
      node_key: s.node_key as string,
      node_kind: s.node_kind as string,
      node_label: s.node_label as string,
      status: s.status as StepStatus,
      input: (s.input ?? null) as Record<string, unknown> | null,
      output: (s.output ?? null) as Record<string, unknown> | null,
      error: s.error as string | null,
      started_at: String(s.started_at),
      completed_at: s.completed_at ? String(s.completed_at) : null,
    })),
  };
}

/* ── Execution engine ────────────────────────────────────────────────────
   Deterministic graph interpreter. Disabled nodes are skipped (their
   outgoing edges are followed). A run records every node outcome so the
   dashboard can audit exactly what happened. */

export interface ExecutionHooks {
  sendEmail?: (args: {
    to: string; subject: string; body: string; encryptSensitive: boolean;
  }) => Promise<Record<string, unknown>>;
  sendSms?: (args: {
    to: string; message: string;
  }) => Promise<Record<string, unknown>>;
  aiAssist?: (args: {
    model: string; systemPrompt: string; userPrompt: string; maxTokens: number;
  }) => Promise<Record<string, unknown>>;
  httpRequest?: (args: {
    method: string; url: string;
    headers: Record<string, string>; body: unknown;
  }) => Promise<Record<string, unknown>>;
  auditLog?: (args: { message: string; level: string }) => Promise<void>;
}

const DEFAULT_MAX_STEPS = 100;

export async function executeWorkflow(
  db: NeonClient,
  workflowId: string,
  triggerPayload: Record<string, unknown>,
  hooks: ExecutionHooks = {},
): Promise<WorkflowRun> {
  const wf = await getWorkflow(db, workflowId);
  if (!wf) throw new Error("Workflow not found");
  if (wf.status !== "published") {
    throw new Error("Only published workflows can execute");
  }

  const runRows = await q(db)`
    insert into public.workflow_runs (workflow_id, trigger_type, trigger_payload)
    values (${workflowId}, ${wf.trigger_type}, ${JSON.stringify(triggerPayload)}::jsonb)
    returning id, started_at`;
  const runId = runRows[0].id as string;

  const wfId = wf.id;
  const wfName = wf.name;
  const context: Record<string, unknown> = {
    trigger: triggerPayload,
    workflow: { id: wfId, name: wfName },
  };

  const nodeByKey = new Map(wf.nodes.map((n) => [n.node_key, n]));
  const edgesFrom = new Map<string, WorkflowEdge[]>();
  for (const e of wf.edges) {
    const list = edgesFrom.get(e.from_node_key) ?? [];
    list.push(e);
    edgesFrom.set(e.from_node_key, list);
  }

  const visited = new Set<string>();
  const queue: string[] = wf.nodes
    .filter((n) => n.type === "trigger" && n.enabled)
    .map((n) => n.node_key);

  let status: RunStatus = "completed";
  let error: string | null = null;
  let steps = 0;

  async function recordStep(
    node: WorkflowNode,
    stepStatus: StepStatus,
    input: Record<string, unknown> | null,
    output: Record<string, unknown> | null,
    stepError: string | null,
  ): Promise<string> {
    const rows = await q(db)`
      insert into public.workflow_run_steps
        (run_id, node_key, node_kind, node_label, status, input, output, error,
         completed_at)
      values (
        ${runId}, ${node.node_key}, ${node.kind}, ${node.label}, ${stepStatus},
        ${input ? JSON.stringify(input) : null}::jsonb,
        ${output ? JSON.stringify(output) : null}::jsonb,
        ${stepError},
        case when ${stepStatus} in ('success','failed','skipped')
             then now() else null end
      )
      returning id`;
    return rows[0].id as string;
  }

  async function finishStep(
    stepId: string,
    stepStatus: StepStatus,
    output: Record<string, unknown> | null,
    stepError: string | null,
  ): Promise<void> {
    await q(db)`
      update public.workflow_run_steps
      set status = ${stepStatus},
          output = ${output ? JSON.stringify(output) : null}::jsonb,
          error = ${stepError},
          completed_at = now()
      where id = ${stepId}`;
  }

  async function runAction(
    node: WorkflowNode,
    cfg: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (node.kind) {
      case "send_email": {
        const args = {
          to: String(cfg.to ?? ""),
          subject: String(cfg.subject ?? ""),
          body: String(cfg.body ?? ""),
          encryptSensitive: cfg.encryptSensitive === true,
        };
        if (!args.to) throw new Error("send_email: 'to' is required");
        if (hooks.sendEmail) return hooks.sendEmail(args);
        // No provider configured: record intent, mark delivered=false.
        return { delivered: false, queued: true, ...args };
      }
      case "send_sms": {
        const args = {
          to: String(cfg.to ?? ""),
          message: String(cfg.message ?? ""),
        };
        if (!args.to) throw new Error("send_sms: 'to' is required");
        if (!args.message) throw new Error("send_sms: 'message' is required");
        if (hooks.sendSms) return hooks.sendSms(args);
        // No provider configured: record the draft for human approval.
        // House rule: no automated outreach sending in MVP — a human
        // approves and sends drafted messages.
        return { delivered: false, queued: true, draft: true, ...args };
      }
      case "ai_assist": {
        const args = {
          model: String(cfg.model ?? "gpt-4o-mini"),
          systemPrompt: String(cfg.systemPrompt ?? ""),
          userPrompt: String(cfg.userPrompt ?? ""),
          maxTokens: Math.min(Math.max(Number(cfg.maxTokens ?? 500), 1), 4000),
        };
        if (!args.userPrompt) throw new Error("ai_assist: 'userPrompt' is required");
        if (hooks.aiAssist) return hooks.aiAssist(args);
        // No AI provider configured: record the request as a draft stub so
        // the run stays auditable; a human completes it before anything sends.
        return {
          delivered: false, draft: true,
          model: args.model,
          prompt: args.userPrompt,
          output: `[draft stub — no AI provider configured] ${args.userPrompt.slice(0, 200)}`,
        };
      }
      case "http_request": {
        const method = String(cfg.method ?? "POST").toUpperCase();
        const url = String(cfg.url ?? "");
        if (!url.startsWith("https://")) {
          throw new Error("http_request: only https:// URLs are allowed");
        }
        const headers = (cfg.headers ?? {}) as Record<string, string>;
        const body = cfg.body ?? null;
        if (hooks.httpRequest) return hooks.httpRequest({ method, url, headers, body });
        const res = await fetch(url, {
          method,
          headers: { "content-type": "application/json", ...headers },
          body: method === "GET" ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });
        const text = await res.text();
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* keep text */ }
        if (!res.ok) {
          throw new Error(`http_request: ${method} ${url} -> ${res.status}`);
        }
        return { status: res.status, body: parsed };
      }
      case "log_database": {
        const message = String(cfg.message ?? "");
        const level = String(cfg.level ?? "info");
        if (hooks.auditLog) await hooks.auditLog({ message, level });
        else {
          await q(db)`insert into public.workflow_audit_log
                     (run_id, workflow_id, level, message)
                   values (${runId}, ${workflowId}, ${level}, ${message})`;
        }
        return { logged: true, level };
      }
      case "slack_notify": {
        const webhookUrl = String(cfg.webhookUrl ?? "");
        const message = String(cfg.message ?? "");
        if (!webhookUrl.startsWith("https://hooks.slack.com/")) {
          throw new Error("slack_notify: invalid Slack webhook URL");
        }
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: message }),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`slack_notify: Slack -> ${res.status}`);
        return { posted: true };
      }
      case "create_project": {
        // delivery_projects requires a handoff_inbox row. For lead_handoff
        // triggers the inbox context comes from the trigger payload;
        // synthetic/manual runs create a synthetic inbox row first.
        const handoff = (context.handoff ?? {}) as Record<string, unknown>;
        let inboxId = handoff.inbox_id as string | undefined;
        let packageId = handoff.package_id as string | undefined;
        let packageVersion = Number(handoff.package_version ?? 1);
        let opportunityId = handoff.opportunity_id as string | undefined;
        let organizationName = String(
          cfg.client ?? handoff.organization_name ?? "Synthetic client",
        );
        if (!inboxId) {
          // PROD guard: fabricating a handoff_inbox row bypasses intake
          // signature verification. Only allow it for demos/tests when the
          // operator explicitly opts in; production runs must originate from
          // a verified handoff (lead_handoff trigger context).
          if (process.env.WORKFLOW_SYNTHETIC_PROJECTS !== "1") {
            throw new Error(
              "create_project requires a verified handoff context; synthetic inbox " +
                "fabrication is disabled (set WORKFLOW_SYNTHETIC_PROJECTS=1 to allow)",
            );
          }
          const syntheticKey = `synthetic-${runId}`;
          const pkg = {
            synthetic: true,
            name: String(cfg.name ?? "Untitled project"),
            organization_name: organizationName,
            generated_by: `workflow:${wfId}`,
            generated_at: new Date().toISOString(),
          };
          const inboxRows = await q(db)`
            insert into public.handoff_inbox
              (idempotency_key, package, manifest_checksum, signature, status)
            values (
              ${syntheticKey},
              ${JSON.stringify(pkg)}::jsonb,
              ${"0".repeat(64)},
              'synthetic',
              'processed'
            )
            returning id`;
          inboxId = inboxRows[0].id as string;
          packageId = packageId ?? crypto.randomUUID();
          opportunityId = opportunityId ?? crypto.randomUUID();
          packageVersion = 1;
        }
        const name = String(cfg.name ?? "Untitled project");
        const rows = await q(db)`
          insert into public.delivery_projects
            (inbox_id, package_id, package_version, opportunity_id,
             organization_name, name)
          values (
            ${inboxId}, ${packageId}, ${packageVersion}, ${opportunityId},
            ${organizationName}, ${name}
          )
          returning id`;
        return { project_id: rows[0].id as string, name };
      }
      case "update_status": {
        return {
          service: String(cfg.service ?? "delivery-factory"),
          status: String(cfg.status ?? "ok"),
          note: String(cfg.note ?? ""),
          at: new Date().toISOString(),
        };
      }
      case "assign_gate": {
        // Gates are modelled as review milestones on a delivery project.
        // projectId may be a literal UUID or reference a prior
        // create_project step via {{node_<node_key>.project_id}}.
        const projectId = String(cfg.projectId ?? "");
        if (!projectId) {
          throw new Error("assign_gate: 'projectId' is required");
        }
        const rows = await q(db)`
          insert into public.milestones (project_id, title, target_date)
          values (${projectId}, ${String(cfg.label ?? "Review gate")},
                  ${String(cfg.targetDate ?? "") || null})
          returning id`;
        return { gate_id: rows[0].id as string };
      }
      default:
        throw new Error(`Unsupported action kind: ${node.kind}`);
    }
  }

  try {
    while (queue.length > 0) {
      if (++steps > DEFAULT_MAX_STEPS) {
        throw new Error(`Step limit (${DEFAULT_MAX_STEPS}) exceeded — possible cycle`);
      }
      const key = queue.shift()!;
      if (visited.has(key)) continue;
      visited.add(key);
      const node = nodeByKey.get(key);
      if (!node) continue;

      if (!node.enabled) {
        await recordStep(node, "skipped", null, null, null);
        for (const e of edgesFrom.get(key) ?? []) queue.push(e.to_node_key);
        continue;
      }

      const cfg = renderTemplate(
        node.config ?? {},
        context,
      ) as Record<string, unknown>;

      if (node.type === "trigger") {
        await recordStep(node, "success", { trigger: triggerPayload }, null, null);
        for (const e of edgesFrom.get(key) ?? []) queue.push(e.to_node_key);
        continue;
      }

      if (node.kind === "wait") {
        const seconds = Math.min(Math.max(Number(cfg.seconds ?? 5), 0), 60);
        const stepId = await recordStep(node, "running", { seconds }, null, null);
        await new Promise((r) => setTimeout(r, seconds * 1000));
        await finishStep(stepId, "success", { waited: true }, null);
        for (const e of edgesFrom.get(key) ?? []) queue.push(e.to_node_key);
        continue;
      }

      if (node.kind === "if_else") {
        const result = evaluateCondition(
          String(cfg.field ?? ""),
          String(cfg.operator ?? "exists"),
          String(cfg.value ?? ""),
          context,
        );
        const port = result ? "true" : "false";
        await recordStep(
          node, "success",
          { field: cfg.field, operator: cfg.operator, value: cfg.value },
          { result, port }, null,
        );
        context[`branch_${node.node_key}`] = result;
        for (const e of (edgesFrom.get(key) ?? []).filter(
          (e) => !e.from_port || e.from_port === port,
        )) {
          queue.push(e.to_node_key);
        }
        continue;
      }

      // Regular action node.
      const stepId = await recordStep(node, "running", cfg, null, null);
      try {
        const output = await runAction(node, cfg);
        context[`node_${node.node_key}`] = output;
        context.last = output;
        await finishStep(stepId, "success", output, null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await finishStep(stepId, "failed", null, message);
        throw err;
      }
      for (const e of edgesFrom.get(key) ?? []) queue.push(e.to_node_key);
    }
  } catch (err) {
    status = "failed";
    error = err instanceof Error ? err.message : String(err);
  }

  await q(db)`
    update public.workflow_runs
    set status = ${status}, error = ${error},
        output = ${JSON.stringify(context.last ?? {})}::jsonb,
        completed_at = now()
    where id = ${runId}`;

  const run = await getRun(db, runId);
  if (!run) throw new Error("Run vanished after execution");
  return run;
}
