import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import type { LeadEngineHandoffPackage } from "@raphah/handoff-contract";
import type { ApiRequest } from "../api/_lib/http.js";
import type { NeonClient, ProjectRow } from "../api/_lib/db.js";
import { packageBase, signTestPackage } from "./helpers.js";

/**
 * POST /api/projects/:id/workflow-skeletons — the Charter's manual
 * skeleton generation for projects accepted before the intake hook
 * existed (Donddental). The db port and the engine client are stubbed
 * the way operator-route.test.ts stubs the session lookup; the
 * generator itself runs for real against a fake engine.
 */

const holder = vi.hoisted(() => ({
  projects: new Map<string, ProjectRow>(),
  packages: new Map<string, LeadEngineHandoffPackage>(),
  workflows: new Map<
    string,
    {
      id: string;
      name: string;
      status: string;
      environment: string;
      trigger_type: string;
      trigger_config: Record<string, unknown>;
      created_by: string | null;
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
    }
  >(),
}));

function engineDb() {
  const { workflows, packages } = holder;
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0];
    if (head.includes("join public.handoff_inbox")) {
      const pkg = packages.get(String(values[0]));
      return pkg ? [{ package: pkg }] : [];
    }
    if (
      head.includes("from public.workflows") &&
      head.includes("skeleton_runs") &&
      !head.includes("trigger_config")
    ) {
      // findAndAssessSkeleton: one computed row per match.
      const match = [...workflows.values()].find(
        (w) =>
          w.environment === String(values[0]) &&
          w.trigger_config.projectId === String(values[1]) &&
          w.trigger_config.requirementId === String(values[2]),
      );
      if (!match) return [];
      const stamp = new Date().toISOString();
      return [
        {
          id: match.id,
          name: match.name,
          status: match.status,
          created_at: stamp,
          updated_at: stamp,
          skeleton_node_kinds: new Set(
            match.nodes
              .map((n) => String(n.node_key))
              .filter((k) =>
                ["trigger-1", "action-1", "action-2", "action-3"].includes(k),
              ),
          ).size,
          skeleton_edges: match.edges.length,
          skeleton_runs: 0,
        },
      ];
    }
    if (
      head.includes("from public.workflows") &&
      head.includes("select id, name, status")
    ) {
      const match = [...workflows.values()].find(
        (w) =>
          w.environment === String(values[0]) &&
          w.trigger_config.projectId === String(values[1]) &&
          w.trigger_config.requirementId === String(values[2]),
      );
      return match
        ? [{ id: match.id, name: match.name, status: match.status }]
        : [];
    }
    if (
      head.includes("from public.workflow_runs") &&
      head.includes("count(*)")
    ) {
      return [{ runs: 0 }];
    }
    if (head.includes("insert into public.workflows")) {
      const id = randomUUID();
      workflows.set(id, {
        id,
        name: String(values[0]),
        status: "draft",
        trigger_type: String(values[2]),
        trigger_config: JSON.parse(String(values[3])) as Record<
          string,
          unknown
        >,
        created_by: values[4] ? String(values[4]) : null,
        environment: String(values[5]),
        nodes: [],
        edges: [],
      });
      return [{ id }];
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
        node_key: values[1],
        type: values[2],
        kind: values[3],
        label: values[4],
        position_x: values[5],
        position_y: values[6],
        config: JSON.parse(String(values[7])),
        enabled: values[8],
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
          description: null,
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
      getProject: async (id: string) => holder.projects.get(id) ?? null,
    }),
    getDb: () => engineDb(),
  };
});

const { default: handler } = await import(
  "../api/_projects/[id]/workflow-skeletons.js"
);

beforeEach(() => {
  process.env.OPERATOR_EMAILS = "ops@example.com";
  process.env.LEAD_ENGINE_PUBLIC_KEY_PEM = "dummy-pem-for-test";
  holder.projects.clear();
  holder.packages.clear();
  holder.workflows.clear();
});

afterEach(() => {
  delete process.env.OPERATOR_EMAILS;
  delete process.env.LEAD_ENGINE_PUBLIC_KEY_PEM;
});

function mockReq(id: string, auth = "Bearer ops-session"): ApiRequest {
  return {
    method: "POST",
    headers: { authorization: auth },
    query: { id },
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

function seedProjectWithPackage(): ProjectRow {
  const pkg = signTestPackage(packageBase()).pkg;
  const project = {
    id: randomUUID(),
    inbox_id: randomUUID(),
    package_id: pkg.packageId,
    package_version: 1,
    opportunity_id: pkg.opportunityId,
    organization_name: pkg.organization.name,
    name: null,
    status: "active",
    environment: "production",
    current_stage: "intake",
    baseline_version: 1,
    requirements_count: 1,
    features_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as ProjectRow;
  holder.projects.set(project.id, project);
  holder.packages.set(project.id, pkg);
  return project;
}

describe("POST /api/projects/:id/workflow-skeletons", () => {
  it("401s without an operator session", async () => {
    const res = mockRes();
    await handler(mockReq(randomUUID(), ""), res);
    expect(res.statusCode).toBe(401);
  });

  it("404s for an unknown project", async () => {
    const res = mockRes();
    await handler(mockReq(randomUUID()), res);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ error: "Project not found" });
  });

  it("creates the project's skeletons, then reports them as existing", async () => {
    const project = seedProjectWithPackage();

    const first = mockRes();
    await handler(mockReq(project.id), first);
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body) as {
      created: Array<{ name: string; requirementCode: string }>;
      existing: unknown[];
    };
    expect(firstBody.created).toHaveLength(1);
    expect(firstBody.created[0].requirementCode).toBe("REQ-001");
    expect(firstBody.existing).toEqual([]);
    // The manual route records the operator as the creator.
    expect([...holder.workflows.values()][0].created_by).toBe(
      "ops@example.com",
    );

    const second = mockRes();
    await handler(mockReq(project.id), second);
    const secondBody = JSON.parse(second.body) as {
      created: unknown[];
      existing: Array<{ requirementCode: string }>;
    };
    expect(secondBody.created).toEqual([]);
    expect(secondBody.existing).toHaveLength(1);
    expect(holder.workflows.size).toBe(1);
  });
});
