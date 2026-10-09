import { randomUUID } from "node:crypto";
import type { LeadEngineHandoffPackage } from "@raphah/handoff-contract";
import { describe, expect, it } from "vitest";
import {
  leadHandoffMinScoreAllows,
  triggerLeadHandoffWorkflows,
} from "../api/_lib/handoff-triggers.js";
import { buildLeadHandoffTriggerPayload } from "../api/_lib/workflows.js";
import { packageBase, signTestPackage } from "./helpers.js";

interface FixtureWorkflow {
  id: string;
  name: string;
  description: string;
  status: string;
  environment: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
  published_at: string;
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}

/** Minimal mirror of the seeded "Lead follow-up (SMS, draft-first)" template. */
function demoWorkflow(
  overrides: Partial<FixtureWorkflow> = {},
): FixtureWorkflow {
  return {
    id: randomUUID(),
    name: "Lead follow-up (SMS, draft-first)",
    description: "Demo template",
    status: "published",
    environment: "demo",
    trigger_type: "lead_handoff",
    trigger_config: { minScore: 0 },
    created_by: "seed",
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
        node_key: "action-1", type: "action", kind: "ai_assist",
        label: "Draft follow-up SMS", position_x: 0, position_y: 0,
        config: {
          model: "gpt-4o-mini",
          systemPrompt: "Write short SMS.",
          userPrompt:
            "Write one SMS under 160 characters following up with {{trigger.lead.name}} at {{trigger.organization_name}} (lead score {{trigger.lead.score}}/100).",
          maxTokens: 200,
        },
        enabled: true,
      },
      {
        node_key: "action-2", type: "action", kind: "send_sms",
        label: "Queue SMS draft", position_x: 0, position_y: 0,
        config: {
          to: "{{trigger.lead.phone}}",
          message: "{{node_action-1.output}}",
        },
        enabled: true,
      },
      {
        node_key: "action-3", type: "action", kind: "log_database",
        label: "Log follow-up drafted", position_x: 0, position_y: 0,
        config: {
          message: "SMS follow-up draft queued for {{trigger.lead.name}}",
          level: "info",
        },
        enabled: true,
      },
    ],
    edges: [
      { edge_key: "e1", from_node_key: "trigger-1", to_node_key: "action-1", from_port: null, label: null },
      { edge_key: "e2", from_node_key: "action-1", to_node_key: "action-2", from_port: null, label: null },
      { edge_key: "e3", from_node_key: "action-2", to_node_key: "action-3", from_port: null, label: null },
    ],
    ...overrides,
  };
}

/**
 * Fake Neon tag client for the trigger path. Matches on the leading SQL
 * fragment of each query the engine issues, like workflows.test.ts.
 */
function makeTriggerDb(workflows: FixtureWorkflow[]) {
  const byId = new Map(workflows.map((w) => [w.id, w]));
  const runs = new Map<string, Record<string, unknown>>();
  const steps: Array<Record<string, unknown>> = [];
  const auditLog: Array<Record<string, unknown>> = [];
  const failNodeQueryFor = new Set<string>();

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
      const workflowId = String(values[0]);
      if (failNodeQueryFor.has(workflowId)) {
        throw new Error("simulated node query failure");
      }
      return byId.get(workflowId)?.nodes ?? [];
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
      auditLog.push({
        run_id: values[0],
        workflow_id: values[1],
        level: values[2],
        message: values[3],
      });
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
        id: run.id,
        workflow_id: run.workflow_id,
        environment: run.environment,
        trigger_type: run.trigger_type,
        trigger_payload: run.trigger_payload,
        status: run.status,
        output: run.output,
        error: run.error,
        started_at: run.started_at,
        completed_at: new Date().toISOString(),
      }];
    }
    if (head.includes("from public.workflow_run_steps")) {
      return steps.filter((s) => s.run_id === String(values[0]));
    }
    throw new Error(`Unexpected query: ${head.slice(0, 100)}`);
  }) as unknown as Parameters<typeof triggerLeadHandoffWorkflows>[0];

  return { db, runs, steps, auditLog, failNodeQueryFor };
}

function testPackage(
  overrides: Record<string, unknown> = {},
): LeadEngineHandoffPackage {
  return signTestPackage(packageBase(overrides)).pkg;
}

describe("buildLeadHandoffTriggerPayload", () => {
  it("shapes the package into the {{trigger.*}} payload templates expect", () => {
    const pkg = testPackage({
      stakeholders: [{ name: "Ava Operator", role: "Owner" }],
    });
    const payload = buildLeadHandoffTriggerPayload(pkg);

    expect(payload.organization_name).toBe("Acme Corp");
    expect(payload.lead.name).toBe("Ava Operator");
    // The v1 contract carries no phone or numeric score: templates must
    // tolerate their absence (rendered as "").
    expect(payload.lead.phone).toBeUndefined();
    expect(payload.lead.score).toBeUndefined();
    expect(payload.package.packageId).toBe(pkg.packageId);
  });

  it("falls back to the organization name when there are no stakeholders", () => {
    const payload = buildLeadHandoffTriggerPayload(testPackage());
    expect(payload.lead.name).toBe("Acme Corp");
  });
});

describe("leadHandoffMinScoreAllows", () => {
  it("runs when the gate is unset or zero", () => {
    expect(leadHandoffMinScoreAllows(null, undefined)).toBe(true);
    expect(leadHandoffMinScoreAllows({}, undefined)).toBe(true);
    expect(leadHandoffMinScoreAllows({ minScore: 0 }, undefined)).toBe(true);
  });

  it("does not auto-run a positive gate when the lead score is unknown", () => {
    // "unknown" never counts as passing: the operator runs it manually.
    expect(leadHandoffMinScoreAllows({ minScore: 80 }, undefined)).toBe(false);
  });

  it("enforces the gate when a score is present", () => {
    expect(leadHandoffMinScoreAllows({ minScore: 80 }, 90)).toBe(true);
    expect(leadHandoffMinScoreAllows({ minScore: 80 }, 80)).toBe(true);
    expect(leadHandoffMinScoreAllows({ minScore: 80 }, 70)).toBe(false);
  });
});

describe("triggerLeadHandoffWorkflows", () => {
  it("executes a published lead_handoff workflow with the demo template draft-first", async () => {
    const wf = demoWorkflow();
    const { db, runs, steps } = makeTriggerDb([wf]);
    const pkg = testPackage({
      stakeholders: [{ name: "Ava Operator", role: "Owner" }],
    });

    const result = await triggerLeadHandoffWorkflows(db, pkg, "demo");
    expect(result).toEqual({ executed: [wf.id], skipped: [] });
    expect(runs.size).toBe(1);
    const run = [...runs.values()][0];
    // The trigger payload reached the engine shaped for {{trigger.*}} refs.
    expect(
      (run.trigger_payload as Record<string, unknown> & {
        lead: { name: string };
      }).lead.name,
    ).toBe("Ava Operator");

    // ai_assist recorded a draft stub for human approval: nothing sent.
    const ai = steps.find((s) => s.node_key === "action-1")!;
    expect(ai.status).toBe("success");
    expect(ai.output).toMatchObject({ delivered: false, draft: true });
    expect(String((ai.output as Record<string, unknown>).output)).toContain(
      "[draft stub",
    );

    // The v1 package carries no phone number, so the SMS step fails loudly
    // instead of sending anywhere — the run is auditable, nothing delivered.
    const sms = steps.find((s) => s.node_key === "action-2")!;
    expect(sms.status).toBe("failed");
    expect(String(sms.error)).toContain("'to' is required");
    expect(run.status).toBe("failed");
  });

  it("skips a workflow whose minScore gate cannot be verified", async () => {
    const gated = demoWorkflow({ trigger_config: { minScore: 80 } });
    const open = demoWorkflow();
    const { db, runs } = makeTriggerDb([gated, open]);

    const result = await triggerLeadHandoffWorkflows(db, testPackage(), "demo");
    expect(result.executed).toEqual([open.id]);
    expect(result.skipped).toEqual([gated.id]);
    expect(runs.size).toBe(1);
  });

  it("ignores unpublished workflows and other trigger types", async () => {
    const draft = demoWorkflow({ status: "draft" });
    const manual = demoWorkflow({ trigger_type: "manual" });
    const { db, runs } = makeTriggerDb([draft, manual]);

    const result = await triggerLeadHandoffWorkflows(db, testPackage(), "demo");
    expect(result).toEqual({ executed: [], skipped: [] });
    expect(runs.size).toBe(0);
  });

  it("isolates per-workflow failures: one broken workflow does not block the others", async () => {
    const broken = demoWorkflow({ name: "broken" });
    const healthy = demoWorkflow({ name: "healthy" });
    const { db, runs, failNodeQueryFor } = makeTriggerDb([broken, healthy]);
    failNodeQueryFor.add(broken.id);

    await expect(
      triggerLeadHandoffWorkflows(db, testPackage(), "demo"),
    ).rejects.toThrow(broken.id);
    // The healthy workflow still executed despite the broken one.
    expect(runs.size).toBe(1);
    expect([...runs.values()][0].workflow_id).toBe(healthy.id);
  });
});
