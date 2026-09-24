import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import handler from "../api/sign-out.js";
import { type ApiRequest } from "../api/_lib/http.js";

/**
 * POST /api/sign-out: proves sign-out revokes the better-auth session row
 * directly in our own database (no dependence on the Neon Auth /sign-out
 * endpoint), and that the allowlist is NOT enforced here — anyone holding
 * a live session can revoke it.
 */

const sessions = vi.hoisted(() => {
  const map = new Map<string, string>([
    ["ops-session", "ops@example.com"],
    ["intruder-session", "intruder@example.com"],
  ]);
  return map;
});

vi.mock("../api/_lib/db.js", () => ({
  createDeliveryDb: () => ({
    findOperatorSession: async (token: string) => {
      const email = sessions.get(token);
      return email ? { email } : null;
    },
    revokeOperatorSession: async (token: string) => sessions.delete(token),
  }),
}));

beforeEach(() => {
  process.env.OPERATOR_EMAILS = "ops@example.com";
});

afterEach(() => {
  delete process.env.OPERATOR_EMAILS;
  sessions.set("ops-session", "ops@example.com");
  sessions.set("intruder-session", "intruder@example.com");
});

function mockReq(method: string, authHeader?: string): ApiRequest {
  return {
    method,
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
    body: string;
    headers: Record<string, string>;
  };
}

describe("POST /api/sign-out", () => {
  it("revokes an allowlisted operator session (200)", async () => {
    const res = mockRes();
    await handler(mockReq("POST", "Bearer ops-session"), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ signedOut: true });
    // The session row is gone: a second lookup finds nothing.
    expect(sessions.has("ops-session")).toBe(false);
  });

  it("revokes a NON-allowlisted session too (200, no 403)", async () => {
    const res = mockRes();
    await handler(mockReq("POST", "Bearer intruder-session"), res);
    expect(res.statusCode).toBe(200);
    expect(sessions.has("intruder-session")).toBe(false);
  });

  it("rejects a missing token with 401", async () => {
    const res = mockRes();
    await handler(mockReq("POST"), res);
    expect(res.statusCode).toBe(401);
  });

  it("rejects an unknown token with 401", async () => {
    const res = mockRes();
    await handler(mockReq("POST", "Bearer no-such-session"), res);
    expect(res.statusCode).toBe(401);
  });

  it("rejects non-POST methods with 405", async () => {
    const res = mockRes();
    await handler(mockReq("GET", "Bearer ops-session"), res);
    expect(res.statusCode).toBe(405);
    // Session untouched.
    expect(sessions.has("ops-session")).toBe(true);
  });
});
