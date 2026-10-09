/* ── Workflow export (Phase 4) ─────────────────────────────────────────
 * Pure generators that turn a Delivery Factory workflow definition into
 * portable artifacts:
 *   1. DF JSON — the canonical, versionable definition (re-importable
 *      shape, diffable in git).
 *   2. A TypeScript workflows-as-code scaffold.
 *   3. Cloud transpilations: AWS Step Functions (ASL), Azure Logic Apps,
 *      Google Cloud Workflows — scaffolds with honest mapping notes.
 * DF semantics do not always transfer: outreach nodes are draft-first
 * (they record a draft for human approval and send nothing), and
 * ai_assist keeps a human in the loop. NODE_MAPPINGS says, per node
 * kind and platform, what maps natively, what is approximate, and what
 * needs a manual approval pattern — the generated files carry the same
 * notes so nobody discovers the gaps in production.
 */

export interface ExportNode {
  node_key: string;
  type: "trigger" | "action" | "logic";
  kind: string;
  label: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

export interface ExportEdge {
  edge_key: string;
  from_node_key: string;
  to_node_key: string;
  from_port: string | null;
}

export interface ExportWorkflow {
  name: string;
  description: string | null;
  status: string;
  environment: string;
  trigger_type: string;
  nodes: ExportNode[];
  edges: ExportEdge[];
}

export type MappingFidelity = "native" | "approximate" | "manual";

export interface NodeMapping {
  kind: string;
  aws: string;
  azure: string;
  gcp: string;
  fidelity: MappingFidelity;
  note: string;
}

export const NODE_MAPPINGS: NodeMapping[] = [
  {
    kind: "manual",
    aws: "StartExecution (console/API)",
    azure: "Request trigger",
    gcp: "Manual execution",
    fidelity: "native",
    note: "All three platforms can be started on demand.",
  },
  {
    kind: "schedule",
    aws: "EventBridge Scheduler",
    azure: "Recurrence trigger",
    gcp: "Cloud Scheduler",
    fidelity: "native",
    note: "Cron maps directly; on GCP the scheduler is a separate resource that starts the workflow.",
  },
  {
    kind: "webhook",
    aws: "API Gateway → StartExecution",
    azure: "Request (HTTP) trigger",
    gcp: "HTTP endpoint via Eventarc/API Gateway",
    fidelity: "approximate",
    note: "An HTTP entry point exists everywhere, but auth/secrets are wired per platform.",
  },
  {
    kind: "lead_handoff",
    aws: "Custom EventBridge event",
    azure: "HTTP trigger called by Lead Engine",
    gcp: "HTTP call from Lead Engine",
    fidelity: "approximate",
    note: "DF-specific event: the LeadEngineHandoffPackage contract becomes the event payload, preserving the LE→DF boundary.",
  },
  {
    kind: "send_email",
    aws: "SES via Lambda + approval callback",
    azure: "Outlook/Office 365 + Approvals",
    gcp: "Gmail/HTTP + custom approval step",
    fidelity: "manual",
    note: "DF is draft-first: it records a draft for human approval and sends nothing. Cloud send actions send immediately — rebuild the approval step (e.g. Step Functions waitForTaskToken) or accept different semantics.",
  },
  {
    kind: "send_sms",
    aws: "Pinpoint/SNS + approval callback",
    azure: "Azure Communication Services + Approvals",
    gcp: "HTTP to your SMS provider + approval step",
    fidelity: "manual",
    note: "Same draft-first gap as send_email: DF records an SMS draft; nothing sends without a human.",
  },
  {
    kind: "ai_assist",
    aws: "Bedrock InvokeModel (Task)",
    azure: "Azure OpenAI action",
    gcp: "Vertex AI call",
    fidelity: "approximate",
    note: "The model call maps; DF's contract — output is a draft a human reviews — must be re-imposed downstream.",
  },
  {
    kind: "http_request",
    aws: "Lambda or API Gateway integration",
    azure: "HTTP action",
    gcp: "http.get / http.post",
    fidelity: "approximate",
    note: "Native on Azure and GCP; ASL has no generic HTTP state, so AWS needs Lambda or an API Gateway integration.",
  },
  {
    kind: "log_database",
    aws: "Lambda → DynamoDB/RDS",
    azure: "SQL / Cosmos connector",
    gcp: "Firestore / BigQuery call",
    fidelity: "approximate",
    note: "The write maps; the target database and schema are yours to choose.",
  },
  {
    kind: "slack_notify",
    aws: "Lambda → Slack webhook",
    azure: "HTTP → Slack webhook",
    gcp: "http.post → Slack webhook",
    fidelity: "approximate",
    note: "A webhook POST everywhere; the Slack app/webhook itself is provisioned outside the workflow.",
  },
  {
    kind: "create_project",
    aws: "Lambda → your project API",
    azure: "HTTP → your project API",
    gcp: "HTTP → your project API",
    fidelity: "manual",
    note: "DF-internal: creates the delivery project and its charter. Outside DF it becomes a call to whatever system owns projects.",
  },
  {
    kind: "update_status",
    aws: "Lambda → your project API",
    azure: "HTTP → your project API",
    gcp: "HTTP → your project API",
    fidelity: "manual",
    note: "DF-internal project status transition (with stage history). No cloud equivalent — call your own API.",
  },
  {
    kind: "assign_gate",
    aws: "Approval callback pattern",
    azure: "Approvals action",
    gcp: "Custom approval step",
    fidelity: "manual",
    note: "A DF human gate: a person is assigned to approve. Only Azure has a first-class approvals action; elsewhere it is a pattern, not a state.",
  },
  {
    kind: "if_else",
    aws: "Choice state",
    azure: "If action",
    gcp: "switch",
    fidelity: "native",
    note: "Branching maps directly; the condition expression is translated to each platform's syntax.",
  },
  {
    kind: "wait",
    aws: "Wait state",
    azure: "Wait action",
    gcp: "sys.sleep",
    fidelity: "native",
    note: "Pauses map directly (platform duration limits differ).",
  },
];

export function mappingFor(kind: string): NodeMapping {
  return (
    NODE_MAPPINGS.find((m) => m.kind === kind) ?? {
      kind,
      aws: "Lambda (custom)",
      azure: "HTTP (custom)",
      gcp: "HTTP call (custom)",
      fidelity: "manual" as MappingFidelity,
      note: "Unknown DF node kind — map by hand.",
    }
  );
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "workflow";
}

/** Deterministic topological order (triggers first); unreachable nodes last. */
export function topoOrder(wf: ExportWorkflow): ExportNode[] {
  const byKey = new Map(wf.nodes.map((n) => [n.node_key, n]));
  const indegree = new Map<string, number>();
  for (const n of wf.nodes) indegree.set(n.node_key, 0);
  for (const e of wf.edges) {
    if (byKey.has(e.to_node_key)) {
      indegree.set(e.to_node_key, (indegree.get(e.to_node_key) ?? 0) + 1);
    }
  }
  const queue = wf.nodes.filter((n) => (indegree.get(n.node_key) ?? 0) === 0);
  const ordered: ExportNode[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const node = queue.shift()!;
    if (seen.has(node.node_key)) continue;
    seen.add(node.node_key);
    ordered.push(node);
    for (const e of wf.edges.filter((x) => x.from_node_key === node.node_key)) {
      const next = byKey.get(e.to_node_key);
      if (!next) continue;
      indegree.set(next.node_key, (indegree.get(next.node_key) ?? 1) - 1);
      if ((indegree.get(next.node_key) ?? 0) <= 0) queue.push(next);
    }
  }
  for (const n of wf.nodes) if (!seen.has(n.node_key)) ordered.push(n);
  return ordered;
}

export function successors(
  wf: ExportWorkflow,
): Map<string, Array<{ to: string; port: string | null }>> {
  const map = new Map<string, Array<{ to: string; port: string | null }>>();
  for (const e of wf.edges) {
    const list = map.get(e.from_node_key) ?? [];
    list.push({ to: e.to_node_key, port: e.from_port });
    map.set(e.from_node_key, list);
  }
  return map;
}

function stateName(nodeKey: string): string {
  return nodeKey.replace(/[^A-Za-z0-9_]+/g, "_");
}

function header(format: string): string {
  return `Generated from Delivery Factory · ${format} · ${new Date().toISOString()}`;
}

/* ── 1. Canonical DF JSON ─────────────────────────────────────────────── */
export function exportDfJson(wf: ExportWorkflow): string {
  return JSON.stringify(
    {
      format: "raphah.workflow",
      formatVersion: "1.0.0",
      exportedAt: new Date().toISOString(),
      workflow: {
        name: wf.name,
        description: wf.description,
        status: wf.status,
        environment: wf.environment,
        trigger_type: wf.trigger_type,
        nodes: topoOrder(wf).map((n) => ({
          node_key: n.node_key,
          type: n.type,
          kind: n.kind,
          label: n.label,
          config: n.config,
          enabled: n.enabled,
        })),
        edges: wf.edges.map((e) => ({
          edge_key: e.edge_key,
          from_node_key: e.from_node_key,
          to_node_key: e.to_node_key,
          from_port: e.from_port,
        })),
      },
    },
    null,
    2,
  );
}

/* ── 2. Workflows-as-code scaffold (TypeScript) ──────────────────────── */
export function exportCodeScaffold(wf: ExportWorkflow): string {
  const ordered = topoOrder(wf);
  const trigger = ordered.find((n) => n.type === "trigger");
  const lines: string[] = [
    `/**`,
    ` * ${wf.name} — workflows-as-code scaffold`,
    ` * ${header("code scaffold")}`,
    ` *`,
    ` * Generated from the Delivery Factory definition. The defineWorkflow`,
    ` * runtime below is illustrative — adapt the imports to your runner.`,
    ` * DF semantics to preserve: outreach steps are draft-first (a human`,
    ` * approves before anything sends) and ai_assist output is a draft.`,
    ` */`,
    `import { defineWorkflow, step } from "./df-workflows-as-code";`,
    ``,
    `export default defineWorkflow({`,
    `  name: ${JSON.stringify(wf.name)},`,
    `  environment: ${JSON.stringify(wf.environment)},`,
  ];
  if (trigger) {
    lines.push(
      `  trigger: { kind: ${JSON.stringify(trigger.kind)}, config: ${JSON.stringify(trigger.config)} },`,
    );
  }
  lines.push(`  steps: [`);
  for (const node of ordered) {
    if (node.type === "trigger") continue;
    const mapping = mappingFor(node.kind);
    lines.push(`    // ${node.label} — ${node.kind}: ${mapping.note}`);
    lines.push(
      `    step(${JSON.stringify(node.node_key)}, ${JSON.stringify(node.kind)}, ${JSON.stringify(node.config, null, 2).replace(/\n/g, "\n    ")}),`,
    );
  }
  lines.push(`  ],`, `});`, ``);
  return lines.join("\n");
}

/* ── 3. AWS Step Functions (ASL) ─────────────────────────────────────── */
function aslCondition(node: ExportNode): Record<string, unknown> {
  const field = typeof node.config.field === "string" ? node.config.field : "";
  const variable = `$.${field.replace(/^trigger\./, "")}`;
  const operator = typeof node.config.operator === "string" ? node.config.operator : "exists";
  const raw = node.config.value;
  const numeric = typeof raw === "string" && raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : null;
  switch (operator) {
    case "equals":
      return numeric != null
        ? { Variable: variable, NumericEquals: numeric }
        : { Variable: variable, StringEquals: String(raw ?? "") };
    case "not_equals":
      // ASL has no not-equals operator; wrap the equality in Not.
      return {
        Not: {
          Variable: variable,
          ...(numeric != null
            ? { NumericEquals: numeric }
            : { StringEquals: String(raw ?? "") }),
        },
      };
    case "gt":
      return { Variable: variable, NumericGreaterThan: numeric ?? 0 };
    case "gte":
      return { Variable: variable, NumericGreaterThanEquals: numeric ?? 0 };
    case "lt":
      return { Variable: variable, NumericLessThan: numeric ?? 0 };
    case "contains":
      return { Variable: variable, StringMatches: `*${String(raw ?? "")}*` };
    default:
      return { Variable: variable, IsPresent: true };
  }
}

export function exportAsl(wf: ExportWorkflow): string {
  const ordered = topoOrder(wf);
  const succ = successors(wf);
  const trigger = ordered.find((n) => n.type === "trigger");
  const body = ordered.filter((n) => n.type !== "trigger");
  const states: Record<string, Record<string, unknown>> = {};

  const nextOf = (node: ExportNode): string | null => {
    const outs = succ.get(node.node_key) ?? [];
    return outs.length ? stateName(outs[0].to) : null;
  };

  for (const node of body) {
    const name = stateName(node.node_key);
    const mapping = mappingFor(node.kind);
    const comment = `DF ${node.kind} (${node.label}) → ${mapping.aws}. ${mapping.note}`;
    if (node.kind === "if_else") {
      const outs = succ.get(node.node_key) ?? [];
      const trueOut = outs.find((o) => o.port === "true") ?? outs[0];
      const falseOut = outs.find((o) => o.port === "false") ?? outs[1];
      const choice: Record<string, unknown> = {
        Type: "Choice",
        Comment: comment,
        Choices: [
          {
            ...aslCondition(node),
            Next: trueOut ? stateName(trueOut.to) : "DfEnd",
          },
        ],
      };
      if (falseOut) choice.Default = stateName(falseOut.to);
      else choice.Default = "DfEnd";
      states[name] = choice;
      continue;
    }
    if (node.kind === "wait") {
      const seconds =
        typeof node.config.seconds === "number" ? node.config.seconds : 5;
      const state: Record<string, unknown> = {
        Type: "Wait",
        Comment: comment,
        Seconds: seconds,
      };
      const next = nextOf(node);
      if (next) state.Next = next;
      else state.End = true;
      states[name] = state;
      continue;
    }
    const resource =
      node.kind === "ai_assist"
        ? "arn:aws:states:::bedrock:invokeModel"
        : "arn:aws:states:::lambda:invoke";
    const state: Record<string, unknown> = {
      Type: "Task",
      Comment: comment,
      Resource: resource,
      Parameters: {
        dfNodeKey: node.node_key,
        dfKind: node.kind,
        config: node.config,
        "payload.$": "$",
      },
    };
    const next = nextOf(node);
    if (next) state.Next = next;
    else state.End = true;
    states[name] = state;
  }
  states.DfEnd = { Type: "Pass", Comment: "End of the exported DF flow.", End: true };

  const firstBody = body[0];
  const doc = {
    Comment: `${wf.name} — ${header("AWS Step Functions ASL scaffold")}. Trigger (${trigger?.kind ?? wf.trigger_type}) is wired outside ASL (see the DF mapping notes); states carry each DF node's config so nothing is lost. Replace placeholder resources before deploying.`,
    StartAt: firstBody ? stateName(firstBody.node_key) : "DfEnd",
    States: states,
  };
  return JSON.stringify(doc, null, 2);
}

/* ── 4. Azure Logic Apps ─────────────────────────────────────────────── */
export function exportLogicApp(wf: ExportWorkflow): string {
  const ordered = topoOrder(wf);
  const trigger = ordered.find((n) => n.type === "trigger");
  const body = ordered.filter((n) => n.type !== "trigger");
  const triggerType =
    trigger?.kind === "schedule"
      ? "Recurrence"
      : "Request";
  const actions: Record<string, Record<string, unknown>> = {};
  let prev: string | null = null;
  for (const node of body) {
    const mapping = mappingFor(node.kind);
    const action: Record<string, unknown> = {
      description: `DF ${node.kind} (${node.label}) → ${mapping.azure}. ${mapping.note}`,
      runAfter: prev ? { [prev]: ["Succeeded"] } : {},
    };
    if (node.kind === "if_else") {
      action.type = "If";
      action.expression = {
        and: [
          {
            equals: [
              `@triggerBody()?['${String(node.config.field ?? "")}']`,
              String(node.config.value ?? ""),
            ],
          },
        ],
      };
      action.actions = {};
      action.else = { actions: {} };
    } else if (node.kind === "wait") {
      action.type = "Wait";
      action.inputs = {
        interval: {
          count: typeof node.config.seconds === "number" ? node.config.seconds : 5,
          unit: "Second",
        },
      };
    } else if (node.kind === "http_request") {
      action.type = "Http";
      action.inputs = {
        method: String(node.config.method ?? "GET"),
        uri: String(node.config.url ?? "https://REPLACE-ME"),
      };
    } else {
      action.type = "Compose";
      action.inputs = { dfKind: node.kind, config: node.config };
    }
    actions[stateName(node.node_key)] = action;
    prev = stateName(node.node_key);
  }
  const doc = {
    $schema:
      "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
    contentVersion: "1.0.0.0",
    parameters: {},
    triggers: {
      [trigger ? stateName(trigger.node_key) : "manual"]: {
        type: triggerType,
        kind: "Http",
        description: `DF trigger: ${trigger?.kind ?? wf.trigger_type}. ${trigger ? mappingFor(trigger.kind).note : ""}`,
        inputs: { schema: {} },
      },
    },
    actions,
    outputs: {},
  };
  return JSON.stringify(doc, null, 2);
}

/* ── 5. Google Cloud Workflows (YAML) ────────────────────────────────── */

export function exportGcpYaml(wf: ExportWorkflow): string {
  const ordered = topoOrder(wf);
  const succ = successors(wf);
  const body = ordered.filter((n) => n.type !== "trigger");
  const trigger = ordered.find((n) => n.type === "trigger");
  const lines: string[] = [
    `# ${wf.name} — Google Cloud Workflows scaffold`,
    `# ${header("Google Cloud Workflows YAML scaffold")}`,
    `# Trigger: ${trigger?.kind ?? wf.trigger_type} — ${trigger ? mappingFor(trigger.kind).note : ""}`,
    `# Replace REPLACE-ME endpoints and preserve DF's draft-first semantics`,
    `# (outreach steps draft for human approval; they do not send).`,
    `main:`,
    `  params: [input]`,
    `  steps:`,
  ];
  for (const node of body) {
    const name = stateName(node.node_key);
    const mapping = mappingFor(node.kind);
    const outs = succ.get(node.node_key) ?? [];
    const next = outs.length ? stateName(outs[0].to) : "end";
    lines.push(`    # DF ${node.kind} (${node.label}) → ${mapping.gcp}. ${mapping.note}`);
    if (node.kind === "if_else") {
      const trueOut = outs.find((o) => o.port === "true") ?? outs[0];
      const falseOut = outs.find((o) => o.port === "false") ?? outs[1];
      const rawField = String(node.config.field ?? "");
      const field = rawField.startsWith("trigger.")
        ? `input.${rawField.slice("trigger.".length)}`
        : rawField.startsWith("input.")
          ? rawField
          : `input.${rawField}`;
      const rawVal = node.config.value;
      const valExpr =
        typeof rawVal === "string" &&
        rawVal !== "" &&
        !Number.isNaN(Number(rawVal))
          ? rawVal
          : JSON.stringify(String(rawVal ?? ""));
      const op =
        node.config.operator === "gt"
          ? ">"
          : node.config.operator === "gte"
            ? ">="
            : node.config.operator === "lt"
              ? "<"
              : "==";
      lines.push(`    - ${name}:`);
      lines.push(`        switch:`);
      lines.push(
        `          - condition: "\${${field} ${op} ${valExpr}}"`,
      );
      lines.push(`            next: ${trueOut ? stateName(trueOut.to) : "end"}`);
      lines.push(`        next: ${falseOut ? stateName(falseOut.to) : "end"}`);
      continue;
    }
    if (node.kind === "wait") {
      const seconds =
        typeof node.config.seconds === "number" ? node.config.seconds : 5;
      lines.push(`    - ${name}:`);
      lines.push(`        call: sys.sleep`);
      lines.push(`        args:`);
      lines.push(`          seconds: ${seconds}`);
      lines.push(`        next: ${next}`);
      continue;
    }
    lines.push(`    - ${name}:`);
    lines.push(`        call: http.post`);
    lines.push(`        args:`);
    lines.push(`          url: "https://REPLACE-ME/${node.kind}"`);
    lines.push(`          body:`);
    lines.push(`            dfKind: ${node.kind}`);
    lines.push(`            config: ${JSON.stringify(node.config)}`);
    lines.push(`        result: ${name}_result`);
    lines.push(`        next: ${next}`);
  }
  return lines.join("\n") + "\n";
}

export interface ExportFormat {
  id: "df-json" | "code" | "aws" | "azure" | "gcp";
  label: string;
  filename: (wf: ExportWorkflow) => string;
  mime: string;
  generate: (wf: ExportWorkflow) => string;
}

export const EXPORT_FORMATS: ExportFormat[] = [
  {
    id: "df-json",
    label: "DF JSON (canonical)",
    filename: (wf) => `${slugify(wf.name)}.df-workflow.json`,
    mime: "application/json",
    generate: exportDfJson,
  },
  {
    id: "code",
    label: "TypeScript scaffold",
    filename: (wf) => `${slugify(wf.name)}.workflow.ts`,
    mime: "text/typescript",
    generate: exportCodeScaffold,
  },
  {
    id: "aws",
    label: "AWS Step Functions (ASL)",
    filename: (wf) => `${slugify(wf.name)}.asl.json`,
    mime: "application/json",
    generate: exportAsl,
  },
  {
    id: "azure",
    label: "Azure Logic Apps",
    filename: (wf) => `${slugify(wf.name)}.logicapp.json`,
    mime: "application/json",
    generate: exportLogicApp,
  },
  {
    id: "gcp",
    label: "Google Cloud Workflows (YAML)",
    filename: (wf) => `${slugify(wf.name)}.gcp-workflows.yaml`,
    mime: "text/yaml",
    generate: exportGcpYaml,
  },
];
