import { describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import type { ApiRequest } from "../api/_lib/http.js";

const seen: Array<{ handler: string; query: unknown }> = [];

vi.mock("../api/_workflows/index.js", () => ({
  default: async (req: ApiRequest) => {
    seen.push({ handler: "workflowsIndex", query: req.query });
  },
}));
vi.mock("../api/_workflows/catalog.js", () => ({
  default: async (req: ApiRequest) => {
    seen.push({ handler: "catalog", query: req.query });
  },
}));
vi.mock("../api/_workflows/[id].js", () => ({
  default: async (req: ApiRequest) => {
    seen.push({ handler: "workflowById", query: req.query });
  },
}));
vi.mock("../api/_workflows/[id]/execute.js", () => ({
  default: async (req: ApiRequest) => {
    seen.push({ handler: "execute", query: req.query });
  },
}));
vi.mock("../api/_workflows/[id]/runs.js", () => ({
  default: async (req: ApiRequest) => {
    seen.push({ handler: "workflowRuns", query: req.query });
  },
}));
vi.mock("../api/_workflows/runs/[runId].js", () => ({
  default: async (req: ApiRequest) => {
    seen.push({ handler: "runDetail", query: req.query });
  },
}));

vi.mock("../api/_projects/[id].js", () => ({
  default: async (req: ApiRequest) => {
    seen.push({ handler: "project", query: req.query });
  },
}));
vi.mock("../api/_projects/[id]/clarifications.js", () => ({
  default: async (req: ApiRequest) => {
    seen.push({ handler: "clarifications", query: req.query });
  },
}));
vi.mock("../api/_projects/[id]/clarifications/[cid]/resolve.js", () => ({
  default: async (req: ApiRequest) => {
    seen.push({ handler: "resolveClarification", query: req.query });
  },
}));
vi.mock("../api/_projects/[id]/events.js", () => ({
  default: async (req: ApiRequest) => {
    seen.push({ handler: "events", query: req.query });
  },
}));
vi.mock("../api/_projects/[id]/milestones.js", () => ({
  default: async (req: ApiRequest) => {
    seen.push({ handler: "milestones", query: req.query });
  },
}));
vi.mock("../api/_projects/[id]/milestones/[mid]/complete.js", () => ({
  default: async (req: ApiRequest) => {
    seen.push({ handler: "completeMilestone", query: req.query });
  },
}));
vi.mock("../api/_projects/[id]/stage.js", () => ({
  default: async (req: ApiRequest) => {
    seen.push({ handler: "stage", query: req.query });
  },
}));

const { default: wfDispatch } = await import("../api/wf-dispatch.js");
const { default: pjDispatch } = await import("../api/pj-dispatch.js");

function makeReq(path: string): {
  req: ApiRequest;
  res: ServerResponse;
  status: () => number | undefined;
  body: () => unknown;
} {
  let payload: unknown;
  const req = { query: { path } } as unknown as ApiRequest;
  const res = {
    statusCode: undefined as number | undefined,
    setHeader: () => {},
    end: (data?: unknown) => {
      payload = data;
    },
  } as unknown as ServerResponse;
  return {
    req,
    res,
    status: () => (res as { statusCode?: number }).statusCode,
    body: () => {
      try {
        return JSON.parse(String(payload));
      } catch {
        return payload;
      }
    },
  };
}

describe("wf-dispatch", () => {
  it.each([
    ["", "workflowsIndex", {}],
    ["catalog", "catalog", {}],
    ["wf-1", "workflowById", { id: "wf-1" }],
    ["wf-1/execute", "execute", { id: "wf-1" }],
    ["wf-1/runs", "workflowRuns", { id: "wf-1" }],
    ["runs/run-9", "runDetail", { runId: "run-9" }],
  ])("routes ?path=%s to %s", async (path, expected, params) => {
    seen.length = 0;
    const t = makeReq(path);
    await wfDispatch(t.req, t.res);
    expect(seen).toHaveLength(1);
    expect(seen[0].handler).toBe(expected);
    expect(seen[0].query).toMatchObject(params);
    expect(seen[0].query).not.toHaveProperty("path");
  });

  it("returns 404 for unknown workflow sub-paths", async () => {
    seen.length = 0;
    const t = makeReq("wf-1/nope/deep");
    await wfDispatch(t.req, t.res);
    expect(seen).toHaveLength(0);
    expect(t.status()).toBe(404);
    expect(t.body()).toMatchObject({ error: "Not found" });
  });
});

describe("pj-dispatch", () => {
  it.each([
    ["p-1", "project", { id: "p-1" }],
    ["p-1/clarifications", "clarifications", { id: "p-1" }],
    ["p-1/clarifications/c-2/resolve", "resolveClarification", { id: "p-1", cid: "c-2" }],
    ["p-1/events", "events", { id: "p-1" }],
    ["p-1/milestones", "milestones", { id: "p-1" }],
    ["p-1/milestones/m-3/complete", "completeMilestone", { id: "p-1", mid: "m-3" }],
    ["p-1/stage", "stage", { id: "p-1" }],
  ])("routes ?path=%s to %s", async (path, expected, params) => {
    seen.length = 0;
    const t = makeReq(path);
    await pjDispatch(t.req, t.res);
    expect(seen).toHaveLength(1);
    expect(seen[0].handler).toBe(expected);
    expect(seen[0].query).toMatchObject(params);
    expect(seen[0].query).not.toHaveProperty("path");
  });

  it("returns 404 for unknown project sub-paths", async () => {
    seen.length = 0;
    const t = makeReq("p-1/nope");
    await pjDispatch(t.req, t.res);
    expect(seen).toHaveLength(0);
    expect(t.status()).toBe(404);
  });
});
