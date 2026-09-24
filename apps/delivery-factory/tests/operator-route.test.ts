import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { defineRoute } from "../api/_lib/route.js";
import { sendJson, type ApiRequest } from "../api/_lib/http.js";
import type { OperatorSession } from "../api/_lib/operator.js";

/**
 * Route-level operator auth test: proves `defineRoute` (the wrapper every
 * /api/workflows, /api/projects and /api/monitoring route uses) actually
 * enforces the session + allowlist gate, using the real production code path
 * with a stubbed database session lookup.
 */

const sessions = vi.hoisted(() => {
  const map: Record<string, OperatorSession> = {
    "ops-session": { email: "ops@example.com" },
    "intruder-session": { email: "intruder@example.com" },
  };
  return map;
});

vi.mock("../api/_lib/db.js", () => ({
  createDeliveryDb: () => ({
    findOperatorSession: async (token: string) =>
      sessions[token] ?? null,
  }),
}));

beforeEach(() => {
  process.env.OPERATOR_EMAILS = "ops@example.com";
  process.env.LEAD_ENGINE_PUBLIC_KEY_PEM = "dummy-pem-for-test";
});

afterEach(() => {
  delete process.env.OPERATOR_EMAILS;
  delete process.env.LEAD_ENGINE_PUBLIC_KEY_PEM;
});

function mockReq(authHeader?: string): ApiRequest {
  return {
    method: "GET",
    headers: authHeader ? { authorization: authHeader } : {},
    query: {},
  } as unknown as ApiRequest;
}

function mockRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    headers,
    body: "",
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(body?: string) {
      res.body = body ?? "";
    },
  };
  return res as unknown as ServerResponse & {
    headers: Record<string, string>;
    body: string;
  };
}

const probe = defineRoute(["GET"], async (_req, res, ctx) => {
  sendJson(res, 200, {}, { ok: true, operator: ctx.operator.email });
});

describe("defineRoute operator gate", () => {
  it("returns 401 JSON when no bearer token is present", async () => {
    const res = mockRes();
    await probe(mockReq(), res);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({
      error: "Missing operator credentials",
    });
  });

  it("returns 401 JSON for an unknown session token", async () => {
    const res = mockRes();
    await probe(mockReq("Bearer bogus-token"), res);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({
      error: "Invalid or expired operator session",
    });
  });

  it("returns 403 JSON for a valid session with a non-allowlisted email", async () => {
    const res = mockRes();
    await probe(mockReq("Bearer intruder-session"), res);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({
      error: "Operator not authorized",
    });
  });

  it("reaches the handler with the operator identity for an allowlisted email", async () => {
    const res = mockRes();
    await probe(mockReq("Bearer ops-session"), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      operator: "ops@example.com",
    });
  });
});
