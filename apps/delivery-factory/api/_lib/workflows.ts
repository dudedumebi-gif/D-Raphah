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

import {
  rowEnvironment,
  type DeliveryEnvironment,
  type NeonClient,
} from "./db.js";
/* ── Types ─────────────────────────────────────────────────────────────── */

export type WorkflowStatus = "draft" | "published" | "archived";
export type WorkflowTriggerType = "manual";

export type NodeType = "trigger" | "action" | "logic";
export type NodeKind =
  // triggers
  | "manual"
  // actions
  | "send_email"
  | "ai_assist"
  | "log_database";

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
  /** Environment scope (Phase 0): demo fixtures never mix with production. */
  environment: DeliveryEnvironment;
  trigger_type: WorkflowTriggerType;
  trigger_config: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Node kinds in the stored graph that the v2 catalog retired
   * (v1-era workflows can still carry e.g. send_sms / if_else).
   * Populated by getWorkflow / listWorkflows; such workflows are
   * explicitly retired — viewable, archivable, deletable, but the
   * execute path rejects them before a run is created. */
  retired_kinds?: string[];
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
  /** Environment scope, inherited from the workflow at execution time. */
  environment: DeliveryEnvironment;
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
    kind: "manual", type: "trigger", label: "Manual", icon: "▶️",
    description: "Start from the dashboard or API.",
    defaultConfig: {},
    configSchema: [],
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
    kind: "log_database", type: "action", label: "Log to Database", icon: "🗄️",
    description: "Record a log entry on the run — the message is stored with this step's output in the run record.",
    defaultConfig: { message: "", level: "info" },
    configSchema: [
      { key: "message", label: "Message", kind: "textarea", placeholder: "Workflow {{workflow.name}} ran" },
      { key: "level", label: "Level", kind: "select", options: [
        { value: "info", label: "Info" }, { value: "warn", label: "Warning" }, { value: "error", label: "Error" },
      ]},
    ],
  },
];

export function specFor(kind: NodeKind): NodeSpec {
  const spec = NODE_CATALOG.find((s) => s.kind === kind);
  if (!spec) throw new Error(`Unknown node kind: ${kind}`);
  return spec;
}

const CATALOG_KINDS: ReadonlySet<string> = new Set(
  NODE_CATALOG.map((s) => s.kind),
);

/** The kinds from a kind list that the v2 catalog no longer knows —
 * deduped, in first-appearance order. Persisted v1-era workflows can
 * carry retired kinds (send_sms, http_request, if_else, …): v2 cut
 * them from the catalog without a data migration, so stored graphs
 * still contain them. */
export function retiredKindsFromList(kinds: string[]): string[] {
  const seen = new Set<string>();
  const retired: string[] = [];
  for (const kind of kinds) {
    if (!CATALOG_KINDS.has(kind) && !seen.has(kind)) {
      seen.add(kind);
      retired.push(kind);
    }
  }
  return retired;
}

/** The retired node kinds in a workflow graph (see retiredKindsFromList). */
export function retiredNodeKinds(nodes: Array<{ kind: string }>): string[] {
  return retiredKindsFromList(nodes.map((n) => n.kind));
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
   {{path.to.value}} is resolved against the run context. Path segments may
   contain hyphens so node outputs are reachable via {{node_<node_key>...}}
   (seeded templates use hyphenated keys like "action-1"). */

export function renderTemplate(
  template: unknown,
  context: Record<string, unknown>,
): unknown {
  if (typeof template === "string") {
    return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, path: string) => {
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

/* ── CRUD ──────────────────────────────────────────────────────────────── */

export async function listWorkflows(
  db: NeonClient,
  environment?: DeliveryEnvironment,
): Promise<Workflow[]> {
  // The list rows carry no graph, so retired kinds (below) are
  // computed from a correlated subquery over workflow_nodes — the
  // list must still mark v1-era workflows the v2 catalog retired.
  const rows = environment
    ? await q(db)`
        select id, name, description, status, environment, trigger_type,
               trigger_config, created_by, created_at, updated_at, published_at,
               (select coalesce(array_agg(distinct n.kind), array[]::text[])
                  from public.workflow_nodes n
                 where n.workflow_id = public.workflows.id) as node_kinds
        from public.workflows
        where environment = ${environment}
        order by updated_at desc`
    : await q(db)`
        select id, name, description, status, environment, trigger_type,
               trigger_config, created_by, created_at, updated_at, published_at,
               (select coalesce(array_agg(distinct n.kind), array[]::text[])
                  from public.workflow_nodes n
                 where n.workflow_id = public.workflows.id) as node_kinds
        from public.workflows order by updated_at desc`;
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    description: r.description as string | null,
    status: r.status as WorkflowStatus,
    environment: rowEnvironment(r.environment),
    trigger_type: r.trigger_type as WorkflowTriggerType,
    trigger_config: (r.trigger_config ?? {}) as Record<string, unknown>,
    created_by: r.created_by as string | null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    published_at: r.published_at ? String(r.published_at) : null,
    nodes: [],
    edges: [],
    retired_kinds: retiredKindsFromList(
      Array.isArray(r.node_kinds) ? r.node_kinds.map((k) => String(k)) : [],
    ),
  }));
}

/**
 * The delivery project a handoff package produced, if one exists.
 * Intake persists the project before the skeleton-generation hook
 * runs, so the hook can attribute generated skeletons to the
 * project. A lookup failure resolves to null — the intake path
 * must never break on this lookup.
 */
export async function getProjectIdForPackage(
  db: NeonClient,
  packageId: string,
): Promise<string | null> {
  try {
    const rows = await q(db)`
      select id
      from public.delivery_projects
      where package_id = ${packageId}
      order by created_at desc
      limit 1`;
    if (!rows.length) return null;
    return String(rows[0].id);
  } catch {
    return null;
  }
}

export async function getWorkflow(
  db: NeonClient,
  id: string,
): Promise<Workflow | null> {  const rows = await q(db)`
    select id, name, description, status, environment, trigger_type,
           trigger_config, created_by, created_at, updated_at, published_at
    from public.workflows where id = ${id}`;
  if (rows.length === 0) return null;
  const r = rows[0];
  const nodes = await q(db)`
    select node_key, type, kind, label, position_x, position_y, config, enabled
    from public.workflow_nodes where workflow_id = ${id}`;
  const edges = await q(db)`
    select edge_key, from_node_key, to_node_key, from_port, label
    from public.workflow_edges where workflow_id = ${id}`;
  const mappedNodes: WorkflowNode[] = nodes.map((n) => ({
    node_key: n.node_key as string,
    type: n.type as NodeType,
    kind: n.kind as NodeKind,
    label: n.label as string,
    position_x: n.position_x as number,
    position_y: n.position_y as number,
    config: (n.config ?? {}) as Record<string, unknown>,
    enabled: n.enabled as boolean,
  }));
  return {
    id: r.id as string,
    name: r.name as string,
    description: r.description as string | null,
    status: r.status as WorkflowStatus,
    environment: rowEnvironment(r.environment),
    trigger_type: r.trigger_type as WorkflowTriggerType,
    trigger_config: (r.trigger_config ?? {}) as Record<string, unknown>,
    created_by: r.created_by as string | null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    published_at: r.published_at ? String(r.published_at) : null,
    nodes: mappedNodes,
    retired_kinds: retiredNodeKinds(mappedNodes),
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
  /** Environment is fixed at creation; updates never move a workflow. */
  environment?: DeliveryEnvironment;
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
      (name, description, trigger_type, trigger_config, created_by, environment)
    values (
      ${input.name},
      ${input.description ?? null},
      ${input.trigger_type ?? "manual"},
      ${JSON.stringify(input.trigger_config ?? {})}::jsonb,
      ${input.created_by ?? null},
      ${input.environment ?? "production"}
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
  // Validate the COMPLETE incoming graph before any destructive write.
  // The stored graph is deleted first below, so a node kind the catalog
  // no longer knows (a v1-era draft can still carry kinds removed in
  // v2, e.g. send_sms) must be rejected up front: validating inside the
  // insert loop erased the stored graph and only then failed the save
  // (Codex P1 on PR #63).
  for (const n of nodes) specFor(n.kind);
  await q(db)`delete from public.workflow_edges where workflow_id = ${workflowId}`;
  await q(db)`delete from public.workflow_nodes where workflow_id = ${workflowId}`;
  for (const n of nodes) {
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
  // The status guard lives IN the delete (Codex on PR #56): a
  // client-side gate reads a possibly stale snapshot — a workflow
  // published by another operator after the list loaded must not
  // become deletable. Only drafts and archived workflows delete;
  // a published workflow is archived first.
  const rows = await q(db)`
    delete from public.workflows
    where id = ${id} and status in ('draft', 'archived')
    returning id`;
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
    select id, workflow_id, environment, trigger_type, trigger_payload,
           status, output, error, started_at, completed_at
    from public.workflow_runs
    where workflow_id = ${workflowId}
    order by started_at desc limit ${limit}`;
  return rows.map((r) => ({
    id: r.id as string,
    workflow_id: r.workflow_id as string,
    environment: rowEnvironment(r.environment),
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
    select id, workflow_id, environment, trigger_type, trigger_payload,
           status, output, error, started_at, completed_at
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
    environment: rowEnvironment(r.environment),
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
  aiAssist?: (args: {
    model: string; systemPrompt: string; userPrompt: string; maxTokens: number;
  }) => Promise<Record<string, unknown>>;
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
  // Explicit retirement for persisted v1-era graphs (Codex P1 on
  // PR #63): a graph containing kinds the v2 catalog removed is
  // rejected BEFORE a run row exists — never failed mid-flight at
  // the interpreter's unsupported-kind branch, and never a partial
  // run. The stored graph is untouched: the workflow stays
  // viewable, archivable, and deletable. Any node counts, enabled
  // or not — retirement is a property of the graph, not the path a
  // particular run would have taken.
  const retired = retiredNodeKinds(wf.nodes);
  if (retired.length > 0) {
    throw Object.assign(
      new Error(
        `Workflow contains retired node kinds: ${retired.join(", ")} — ` +
          "it can be viewed, archived, or deleted, but not executed or edited in v2",
      ),
      { statusCode: 422 },
    );
  }

  const runRows = await q(db)`
    insert into public.workflow_runs
      (workflow_id, trigger_type, trigger_payload, environment)
    values (${workflowId}, ${wf.trigger_type},
            ${JSON.stringify(triggerPayload)}::jsonb, ${wf.environment})
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
      case "log_database": {
        // The log entry lives in this step's own output in the run
        // record, like every other step — there is no separate
        // audit-log write.
        const message = String(cfg.message ?? "");
        const level = String(cfg.level ?? "info");
        return { logged: true, level, message };
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
