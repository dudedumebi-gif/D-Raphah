import { describe, expect, it } from "vitest";
import {
  EXPORT_FORMATS,
  NODE_MAPPINGS,
  exportAsl,
  exportCodeScaffold,
  exportDfJson,
  exportGcpYaml,
  exportLogicApp,
  slugify,
  topoOrder,
  type ExportWorkflow,
} from "../src/export.js";

/**
 * Phase 4 export: portable JSON + code scaffold + cloud transpilations.
 * The generators are pure; these tests pin the shapes and the honest
 * node-mapping coverage (all 15 catalog kinds).
 */

const fixture: ExportWorkflow = {
  name: "Lead follow-up (SMS, draft-first)",
  description: "Demo",
  status: "published",
  environment: "demo",
  trigger_type: "lead_handoff",
  nodes: [
    { node_key: "trigger-1", type: "trigger", kind: "lead_handoff", label: "Lead Handoff", config: { minScore: 50 }, enabled: true },
    { node_key: "action-1", type: "action", kind: "ai_assist", label: "Draft follow-up", config: { userPrompt: "Draft an SMS" }, enabled: true },
    { node_key: "logic-1", type: "logic", kind: "if_else", label: "Qualified?", config: { field: "lead.score", operator: "gte", value: "50" }, enabled: true },
    { node_key: "action-2", type: "action", kind: "send_sms", label: "Send SMS", config: { to: "{{trigger.lead.phone}}" }, enabled: true },
    { node_key: "action-3", type: "action", kind: "log_database", label: "Log", config: { table: "audit" }, enabled: true },
    { node_key: "action-4", type: "action", kind: "wait", label: "Wait", config: { seconds: 30 }, enabled: true },
  ],
  edges: [
    { edge_key: "e1", from_node_key: "trigger-1", to_node_key: "action-1", from_port: null },
    { edge_key: "e2", from_node_key: "action-1", to_node_key: "logic-1", from_port: null },
    { edge_key: "e3", from_node_key: "logic-1", to_node_key: "action-2", from_port: "true" },
    { edge_key: "e4", from_node_key: "logic-1", to_node_key: "action-3", from_port: "false" },
    { edge_key: "e5", from_node_key: "action-2", to_node_key: "action-4", from_port: null },
  ],
};

describe("export generators", () => {
  it("orders nodes topologically from the trigger", () => {
    const order = topoOrder(fixture).map((n) => n.node_key);
    expect(order[0]).toBe("trigger-1");
    expect(order.indexOf("action-1")).toBeLessThan(order.indexOf("logic-1"));
    expect(order.indexOf("logic-1")).toBeLessThan(order.indexOf("action-2"));
    expect(order).toContain("action-3");
  });

  it("emits canonical DF JSON with the full definition", () => {
    const parsed = JSON.parse(exportDfJson(fixture)) as {
      format: string;
      formatVersion: string;
      workflow: { name: string; environment: string; nodes: unknown[]; edges: unknown[] };
    };
    expect(parsed.format).toBe("raphah.workflow");
    expect(parsed.formatVersion).toBe("1.0.0");
    expect(parsed.workflow.environment).toBe("demo");
    expect(parsed.workflow.nodes).toHaveLength(6);
    expect(parsed.workflow.edges).toHaveLength(5);
    expect(slugify(fixture.name)).toBe("lead-follow-up-sms-draft-first");
  });

  it("emits a code scaffold carrying every step and config", () => {
    const code = exportCodeScaffold(fixture);
    expect(code).toContain("defineWorkflow");
    expect(code).toContain('"ai_assist"');
    expect(code).toContain('"send_sms"');
    expect(code).toContain("draft-first");
  });

  it("emits valid ASL with a Choice state for if_else and a state per node", () => {
    const asl = JSON.parse(exportAsl(fixture)) as {
      StartAt: string;
      States: Record<string, { Type: string; Choices?: unknown[]; Default?: string }>;
    };
    expect(asl.StartAt).toBe("action_1");
    expect(asl.States.logic_1.Type).toBe("Choice");
    expect(asl.States.logic_1.Choices).toHaveLength(1);
    expect(asl.States.logic_1.Default).toBe("action_3");
    expect(asl.States.action_2.Type).toBe("Task");
    expect(asl.States.action_4.Type).toBe("Wait");
    expect(JSON.stringify(asl.States.action_1)).toContain("bedrock");
    // The send_sms state must carry the draft-first honesty note.
    expect(JSON.stringify(asl.States.action_2)).toContain("draft-first");
  });

  it("emits a Logic Apps definition with a runAfter chain", () => {
    const app = JSON.parse(exportLogicApp(fixture)) as {
      triggers: Record<string, { type: string }>;
      actions: Record<string, { type: string; runAfter: Record<string, unknown> }>;
    };
    expect(Object.values(app.triggers)[0].type).toBe("Request");
    expect(app.actions.action_1.runAfter).toEqual({});
    expect(Object.keys(app.actions.action_2.runAfter)).toEqual(["logic_1"]);
    expect(app.actions.logic_1.type).toBe("If");
    expect(JSON.stringify(app.actions.action_2)).toContain("draft-first");
  });

  it("emits Google Cloud Workflows YAML with a switch for if_else", () => {
    const yaml = exportGcpYaml(fixture);
    expect(yaml).toContain("main:");
    expect(yaml).toContain("- logic_1:");
    expect(yaml).toContain("switch:");
    expect(yaml).toContain("input.lead.score >= 50");
    expect(yaml).toContain("sys.sleep");
    expect(yaml).toContain("draft-first");
  });

  it("covers every catalog node kind in the mapping table", () => {
    const kinds = [
      "webhook", "schedule", "manual", "lead_handoff",
      "send_email", "send_sms", "ai_assist", "http_request",
      "log_database", "slack_notify", "create_project",
      "update_status", "assign_gate", "if_else", "wait",
    ];
    expect(NODE_MAPPINGS.map((m) => m.kind).sort()).toEqual(kinds.sort());
    // The draft-first kinds must be flagged as manual-pattern mappings.
    for (const kind of ["send_email", "send_sms"]) {
      expect(NODE_MAPPINGS.find((m) => m.kind === kind)?.fidelity).toBe("manual");
    }
    expect(EXPORT_FORMATS).toHaveLength(5);
  });
});
