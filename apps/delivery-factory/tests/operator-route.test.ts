import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { defineRoute } from "../api/_lib/route.js";
import { sendJson, type ApiRequest } from "../api/_lib/http.js";

/**
 * Route-level operator auth test: proves `defineRoute` (the wrapper every
 * /api/workflows, /api/projects and /api/monitoring route uses) actually
 * enforces the JWT + allowlist gate, using the real production code path
 * (JWKS fetched via a stubbed global fetch, signed with the matching key).
 */

const KID = "route-test-key";
const AUTH_BASE = "https://auth.test.example/neondb/auth";

let privateKey: KeyLike;

beforeEach(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  const jwks = {
    keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/.well-known/jwks.json")) {
        return new Response(JSON.stringify(jwks), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    }),
  );
  process.env.NEON_AUTH_URL = AUTH_BASE;
  process.env.OPERATOR_EMAILS = "ops@example.com";
  process.env.LEAD_ENGINE_PUBLIC_KEY_PEM = "dummy-pem-for-test";
  // createDeliveryDb() runs after auth inside defineRoute; neon() only
  // builds a client (no connection), so a dummy URL suffices here.
  process.env.DELIVERY_DATABASE_URL = "postgresql://user:pass@localhost/db";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEON_AUTH_URL;
  delete process.env.OPERATOR_EMAILS;
  delete process.env.LEAD_ENGINE_PUBLIC_KEY_PEM;
  delete process.env.DELIVERY_DATABASE_URL;
});

async function signedToken(email: string): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

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

  it("returns 403 JSON for a valid token with a non-allowlisted email", async () => {
    const token = await signedToken("intruder@example.com");
    const res = mockRes();
    await probe(mockReq(`Bearer ${token}`), res);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({
      error: "Operator not authorized",
    });
  });

  it("reaches the handler with the operator identity for an allowlisted email", async () => {
    const token = await signedToken("ops@example.com");
    const res = mockRes();
    await probe(mockReq(`Bearer ${token}`), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      operator: "ops@example.com",
    });
  });
});
