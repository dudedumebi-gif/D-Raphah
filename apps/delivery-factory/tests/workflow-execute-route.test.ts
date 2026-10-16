import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequest } from "../api/_lib/http.js";
import type { NeonClient } from "../api/_lib/db.js";

/**
 * POST /api/workflows/:id/execute — retired-kind rejection (Codex P1
 * on PR #63). A published workflow persisted with v1-era node kinds
 * (send_sms, http_request, if_else, …) is explicitly retired: the
 * route answers 422 with the operator-facing reason BEFORE any run
 * row is created — no partial runs, no mid-flight failure at the
 * interpreter's unsupported-kind branch. Workflows built from kept
 * v2 kinds execute exactly as before.
 */

interface StoredNode {
  node_key: string;
  type: string;
  kind: string;
  label: string;
  position_x: number;
  position_y: number;
  config: Record<string, unknown>;
  enabled: boolean;
}

interface StoredWorkflow {
  id: string;
  name: string;
  status: string;
  environment: string;
  trigger_type: string;
  nodes: StoredNode[];
  edges: Array<Record<string, unknown>>;
}

const holder = {
  workflows: new Map<string, StoredWorkflow>(),
  runs: new Map<string, Record<string, unknown>>(),
  steps: [] as Array<Record<string, unknown>>,
};

function engineDb(): NeonClient {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0];
    if (head.includes("from public.workflows where id =")) {
      const w = holder.workflows.get(String(values[0]));
      if (!w) return [];
      const stamp = new Date().toISOString();
      return [
        {
          id: w.id,
          name: w.name,
          description: null,
          status: w.status,
          environment: w.environment,
          trigger_type: w.trigger_type,
          trigger_config: {},
          created_by: null,
          created_at: stamp,
          updated_at: stamp,
          published_at: stamp,
        },
      ];
    }
    if (head.includes("from public.workflow_nodes")) {
      return (holder.workflows.get(String(values[0]))?.nodes ?? []).map(
        (n) => ({ ...n }),
      );
    }
    if (head.includes("from public.workflow_edges")) {
      return holder.workflows.get(String(values[0]))?.edges ?? [];
    }
    if (head.includes("insert into public.workflow_runs")) {
      const id = randomUUID();
      holder.runs.set(id, {
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
      holder.steps.push({
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
      const step = holder.steps.find((s) => s.id === values[3]);
      if (step) {
        step.status = values[0];
        step.output = values[1] ? JSON.parse(String(values[1])) : null;
        step.error = values[2];
      }
      return [];
    }
    if (head.includes("update public.workflow_runs")) {
      const run = holder.runs.get(String(values[3]));
      if (run) {
        run.status = values[0];
        run.error = values[1];
        run.output = JSON.parse(String(values[2]));
        run.completed_at = new Date().toISOString();
      }
      return [];
    }
    if (head.includes("from public.workflow_runs where id =")) {
      const run = holder.runs.get(String(values[0]));
      return run ? [run] : [];
    }
    if (head.includes("from public.workflow_run_steps where run_id =")) {
      return holder.steps.filter((s) => s.run_id === values[0]);
    }
    throw new Error(`Unexpected query: ${head.slice(0, 100)}`);
  }) as unknown as NeonClient;
}

vi.mock("../api/_lib/db.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/_lib/db.js")>();
  return {
    ...original,
    createDeliveryDb: () => ({
      findOperatorSession: async (token: string) =>
        token === "ops-session" ? { email: "ops@example.com" } : null,
    }),
    getDb: () => engineDb(),
  };
});

const { default: handler } = await import(
  "../api/_workflows/[id]/execute.js"
);

beforeEach(() => {
  process.env.OPERATOR_EMAILS = "ops@example.com";
  process.env.LEAD_ENGINE_PUBLIC_KEY_PEM = "dummy-pem-for-test";
  holder.workflows.clear();
  holder.runs.clear();
  holder.steps = [];
});

afterEach(() => {
  delete process.env.OPERATOR_EMAILS;
  delete process.env.LEAD_ENGINE_PUBLIC_KEY_PEM;
});

function mockReq(id: string): ApiRequest {
  return {
    method: "POST",
    headers: { authorization: "Bearer ops-session" },
    query: { id },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ input: {} }));
    },
  } as unknown as ApiRequest;
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: "",
    setHeader: () => {},
    end(body?: string) {
      res.body = body ?? "";
    },
  };
  return res as unknown as ServerResponse & { body: string };
}

function node(
  key: string,
  type: string,
  kind: string,
  config: Record<string, unknown> = {},
): StoredNode {
  return {
    node_key: key,
    type,
    kind,
    label: kind,
    position_x: 0,
    position_y: 0,
    config,
    enabled: true,
  };
}

function seed(wf: StoredWorkflow): StoredWorkflow {
  holder.workflows.set(wf.id, wf);
  return wf;
}

describe("POST /api/workflows/:id/execute retired kinds", () => {
  it("rejects a published legacy workflow with 422 and creates no run", async () => {
    const wf = seed({
      id: randomUUID(),
      name: "v1-era follow-up",
      status: "published",
      environment: "production",
      trigger_type: "manual",
      nodes: [
        node("t1", "trigger", "manual"),
        node("a1", "action", "send_sms", { to: "+14165550123", message: "hi" }),
      ],
      edges: [
        { edge_key: "e1", from_node_key: "t1", to_node_key: "a1", from_port: null, label: null },
      ],
    });

    const res = mockRes();
    await handler(mockReq(wf.id), res);

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toContain(
      "Workflow contains retired node kinds: send_sms",
    );
    expect(body.error).toContain(
      "viewed, archived, or deleted, but not executed or edited in v2",
    );
    // The rejection happens before the run insert — no run row, no steps.
    expect(holder.runs.size).toBe(0);
    expect(holder.steps).toHaveLength(0);
  });

  it("still executes a published workflow built from kept v2 kinds", async () => {
    const wf = seed({
      id: randomUUID(),
      name: "v2 follow-up",
      status: "published",
      environment: "production",
      trigger_type: "manual",
      nodes: [
        node("t1", "trigger", "manual"),
        node("a1", "action", "log_database", { message: "ran", level: "info" }),
      ],
      edges: [
        { edge_key: "e1", from_node_key: "t1", to_node_key: "a1", from_port: null, label: null },
      ],
    });

    const res = mockRes();
    await handler(mockReq(wf.id), res);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      run: { status: string; workflow_id: string };
    };
    expect(body.run.status).toBe("completed");
    expect(body.run.workflow_id).toBe(wf.id);
    expect(holder.runs.size).toBe(1);
  });
});
