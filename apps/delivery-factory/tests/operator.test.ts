import { beforeEach, describe, expect, it } from "vitest";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type JWTPayload,
  type KeyLike,
} from "jose";
import {
  operatorAllowlist,
  requireOperator,
  type JwtVerifier,
} from "../api/_lib/operator.js";
import type { ApiRequest } from "../api/_lib/http.js";

/**
 * Operator auth tests. The JWT verifier is stubbed with a locally generated
 * RS256 key pair (no network): the stub still runs the real jose signature
 * verification, so bad-signature and expiry cases exercise the true path.
 */

const KID = "test-key";

let privateKey: KeyLike;
let verifier: JwtVerifier;
let wrongKey: KeyLike;

beforeEach(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  const jwks = createLocalJWKSet({
    keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }],
  });
  verifier = async (token: string): Promise<JWTPayload> =>
    (await jwtVerify(token, jwks, { clockTolerance: 60 })).payload;
  wrongKey = (await generateKeyPair("RS256")).privateKey;
  process.env.OPERATOR_EMAILS = "ops@example.com, Admin@Example.com";
});

async function signedToken(
  claims: Record<string, unknown>,
  key: KeyLike = privateKey,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

function reqWith(token: string | null): ApiRequest {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as ApiRequest;
}

describe("requireOperator", () => {
  it("passes a valid token whose email is allowlisted", async () => {
    const token = await signedToken({ email: "ops@example.com" });
    const identity = await requireOperator(reqWith(token), verifier);
    expect(identity.email).toBe("ops@example.com");
  });

  it("compares emails case-insensitively", async () => {
    const token = await signedToken({ email: "OPS@EXAMPLE.COM" });
    const identity = await requireOperator(reqWith(token), verifier);
    expect(identity.email).toBe("ops@example.com");
  });

  it("rejects a valid token whose email is not allowlisted (403)", async () => {
    const token = await signedToken({ email: "intruder@example.com" });
    const err = await requireOperator(reqWith(token), verifier).catch(
      (e) => e,
    );
    expect(err).toMatchObject({ statusCode: 403 });
  });

  it("rejects a token signed by an unknown key (401)", async () => {
    const token = await signedToken({ email: "ops@example.com" }, wrongKey);
    const err = await requireOperator(reqWith(token), verifier).catch(
      (e) => e,
    );
    expect(err).toMatchObject({ statusCode: 401 });
  });

  it("rejects a missing Authorization header (401)", async () => {
    const err = await requireOperator(reqWith(null), verifier).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 401 });
  });

  it("rejects a malformed bearer value (401)", async () => {
    const err = await requireOperator(
      { headers: { authorization: "Token abc.def" } } as ApiRequest,
      verifier,
    ).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 401 });
  });

  it("rejects a valid token with no email claim (403)", async () => {
    const token = await signedToken({ sub: "user-123" });
    const err = await requireOperator(reqWith(token), verifier).catch(
      (e) => e,
    );
    expect(err).toMatchObject({ statusCode: 403 });
  });

  it("rejects an expired token (401)", async () => {
    const token = await new SignJWT({ email: "ops@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);
    const err = await requireOperator(reqWith(token), verifier).catch(
      (e) => e,
    );
    expect(err).toMatchObject({ statusCode: 401 });
  });
});

describe("operatorAllowlist", () => {
  it("parses comma-separated emails, trimmed and lowercased", () => {
    process.env.OPERATOR_EMAILS = "  Ops@Example.com ,,admin@example.com ";
    expect(operatorAllowlist()).toEqual([
      "ops@example.com",
      "admin@example.com",
    ]);
  });

  it("is empty when the env var is unset", () => {
    delete process.env.OPERATOR_EMAILS;
    expect(operatorAllowlist()).toEqual([]);
  });
});
