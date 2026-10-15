import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequest } from "../api/_lib/http.js";
import type { NeonClient } from "../api/_lib/db.js";

/**
 * PUT /api/workflows/:id — trigger_config preservation (Codex round
 * 4 on PR #60): the builder's save payload does not carry
 * trigger_config, and generated skeletons keep their
 * project/requirement linkage in it. The route used to default an
 * omitted trigger_config to {}, silently unlinking every skeleton
 * an operator reviewed and saved — the Charter stopped listing it
 * and the next generation created a duplicate. Omitted now means
 * unchanged; an explicit object still replaces.
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
  description: string | null;
  status: string;
  environment: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  created_by: string | null;
  nodes: StoredNode[];
  edges: Array<Record<string, unknown>>;
}

const holder = {
  workflows: new Map<string, StoredWorkflow>(),
};

function engineDb(): NeonClient {
  return (async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const head = strings[0];
    const workflows = holder.workflows;
    if (head.includes("update public.workflows")) {
      // updateWorkflow always writes trigger_config — resolved by
      // the lib as (input ?? existing) — with values laid out as
      // name, description, trigger_type, trigger_config, id.
      const w = workflows.get(String(values[4]));
      if (!w) return [];
      w.name = String(values[0]);
      w.description = values[1] ? String(values[1]) : null;
      w.trigger_type = String(values[2]);
      w.trigger_config = JSON.parse(String(values[3])) as Record<
        string,
        unknown
      >;
      return [{ id: w.id }];
    }
    if (head.includes("delete from public.workflow_edges")) {
      const wf = workflows.get(String(values[0]));
      if (wf) wf.edges = [];
      return [];
    }
    if (head.includes("delete from public.workflow_nodes")) {
      const wf = workflows.get(String(values[0]));
      if (wf) wf.nodes = [];
      return [];
    }
    if (head.includes("insert into public.workflow_nodes")) {
      workflows.get(String(values[0]))?.nodes.push({
        node_key: String(values[1]),
        type: String(values[2]),
        kind: String(values[3]),
        label: String(values[4]),
        position_x: Number(values[5]),
        position_y: Number(values[6]),
        config: JSON.parse(String(values[7])) as Record<string, unknown>,
        enabled: Boolean(values[8]),
      });
      return [];
    }
    if (head.includes("insert into public.workflow_edges")) {
      workflows.get(String(values[0]))?.edges.push({
        edge_key: values[1],
        from_node_key: values[2],
        to_node_key: values[3],
        from_port: values[4],
        label: values[5],
      });
      return [];
    }
    if (head.includes("from public.workflows where id =")) {
      const w = workflows.get(String(values[0]));
      if (!w) return [];
      const stamp = new Date().toISOString();
      return [
        {
          id: w.id,
          name: w.name,
          description: w.description,
          status: w.status,
          environment: w.environment,
          trigger_type: w.trigger_type,
          trigger_config: w.trigger_config,
          created_by: w.created_by,
          created_at: stamp,
          updated_at: stamp,
          published_at: null,
        },
      ];
    }
    if (head.includes("from public.workflow_nodes")) {
      return workflows.get(String(values[0]))?.nodes ?? [];
    }
    if (head.includes("from public.workflow_edges")) {
      return workflows.get(String(values[0]))?.edges ?? [];
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

const { default: handler } = await import("../api/_workflows/[id].js");

beforeEach(() => {
  process.env.OPERATOR_EMAILS = "ops@example.com";
  process.env.LEAD_ENGINE_PUBLIC_KEY_PEM = "dummy-pem-for-test";
  holder.workflows.clear();
});

afterEach(() => {
  delete process.env.OPERATOR_EMAILS;
  delete process.env.LEAD_ENGINE_PUBLIC_KEY_PEM;
});

function mockReq(id: string, body: unknown): ApiRequest {
  return {
    method: "PUT",
    headers: { authorization: "Bearer ops-session" },
    query: { id },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
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

function seedSkeleton(): StoredWorkflow {
  const wf: StoredWorkflow = {
    id: randomUUID(),
    name: "Donddental — Online Appointment Booking",
    description: "Use-case skeleton generated from REQ-001.",
    status: "draft",
    environment: "production",
    trigger_type: "manual",
    trigger_config: {
      projectId: randomUUID(),
      packageId: "pkg-1",
      requirementId: randomUUID(),
      requirementCode: "REQ-001",
    },
    created_by: "intake-skeleton",
    nodes: [
      {
        node_key: "trigger-1",
        type: "trigger",
        kind: "manual",
        label: "Manual start",
        position_x: 360,
        position_y: 40,
        config: {},
        enabled: true,
      },
    ],
    edges: [],
  };
  holder.workflows.set(wf.id, wf);
  return wf;
}

const BUILDER_SAVE_BODY = {
  // Exactly what the builder sends: name + graph, no trigger fields.
  name: "Donddental — Online Appointment Booking (reviewed)",
  nodes: [
    {
      node_key: "trigger-1",
      type: "trigger",
      kind: "manual",
      label: "Manual start",
      x: 360,
      y: 40,
      config: {},
      enabled: true,
    },
  ],
  edges: [],
};

describe("PUT /api/workflows/:id trigger_config handling", () => {
  it("preserves trigger_config when the save payload omits it", async () => {
    const wf = seedSkeleton();
    const res = mockRes();
    await handler(mockReq(wf.id, BUILDER_SAVE_BODY), res);
    expect(res.statusCode).toBe(200);
    const stored = holder.workflows.get(wf.id);
    expect(stored?.name).toBe(
      "Donddental — Online Appointment Booking (reviewed)",
    );
    // The skeleton's linkage survives the builder save intact.
    expect(stored?.trigger_config).toEqual(wf.trigger_config);
    const body = JSON.parse(res.body) as {
      workflow: { trigger_config: Record<string, unknown> };
    };
    expect(body.workflow.trigger_config).toEqual(wf.trigger_config);
  });

  it("replaces trigger_config when the payload carries an explicit object", async () => {
    const wf = seedSkeleton();
    const res = mockRes();
    await handler(
      mockReq(wf.id, { ...BUILDER_SAVE_BODY, trigger_config: {} }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(holder.workflows.get(wf.id)?.trigger_config).toEqual({});
  });
});
