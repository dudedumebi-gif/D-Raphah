import {
  createLocalJWKSet,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import type { ApiRequest } from "./http.js";

/**
 * Operator authentication for the Delivery Factory dashboard.
 *
 * Operators sign in through Neon Auth (better-auth) in the browser; the SPA
 * exchanges the session for a JWT via the auth server's `/api/auth/token`
 * endpoint and sends it as `Authorization: Bearer <jwt>` on every operator
 * API call. Here we verify the JWT signature against the Neon Auth JWKS and
 * enforce an email allowlist. The allowlist is the real gate: anyone can
 * create a Neon Auth account, but only allowlisted emails get past this.
 *
 * /api/intake (Lead Engine handoff ingress, Ed25519-signed) and
 * /api/internal/* (DELIVERY_FACTORY_CRON_SECRET bearer) do not use
 * `defineRoute` and are therefore unaffected by this module.
 */

export class OperatorAuthError extends Error {
  readonly statusCode: 401 | 403;
  constructor(statusCode: 401 | 403, message: string) {
    super(message);
    this.name = "OperatorAuthError";
    this.statusCode = statusCode;
  }
}

export interface OperatorIdentity {
  email: string;
}

/** Injectable JWT verifier; production uses the Neon Auth JWKS, tests stub it. */
export type JwtVerifier = (token: string) => Promise<JWTPayload>;

/** Accept a small clock skew between the auth server and serverless clocks. */
const CLOCK_TOLERANCE_SECONDS = 60;

/** How long a fetched JWKS is reused before re-fetching. */
const JWKS_TTL_MS = 10 * 60 * 1000;

interface CachedKeySet {
  expires: number;
  verify: (token: string) => Promise<JWTPayload>;
}

const jwksCache = new Map<string, CachedKeySet>();

function authBaseUrl(): string {
  const raw = (process.env.NEON_AUTH_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) {
    // Plain Error -> mapped to 500 by errorStatus(); this is a server
    // misconfiguration, not an operator credential problem.
    throw new Error("Operator auth is not configured (NEON_AUTH_URL is unset)");
  }
  return raw;
}

async function fetchKeySet(jwksUrl: string) {
  const res = await fetch(jwksUrl, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`JWKS fetch failed with status ${res.status}`);
  }
  const jwks = (await res.json()) as JSONWebKeySet;
  const keySet = createLocalJWKSet(jwks);
  return async (token: string): Promise<JWTPayload> =>
    (
      await jwtVerify(token, keySet, {
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      })
    ).payload;
}

async function cachedKeySet(jwksUrl: string, refresh: boolean) {
  const cached = jwksCache.get(jwksUrl);
  if (!refresh && cached && cached.expires > Date.now()) return cached;
  const verify = await fetchKeySet(jwksUrl);
  const entry: CachedKeySet = {
    expires: Date.now() + JWKS_TTL_MS,
    verify,
  };
  jwksCache.set(jwksUrl, entry);
  return entry;
}

function remoteVerifier(): JwtVerifier {
  const jwksUrl = `${authBaseUrl()}/.well-known/jwks.json`;
  return async (token: string) => {
    try {
      return await (await cachedKeySet(jwksUrl, false)).verify(token);
    } catch (err) {
      if (
        err instanceof errors.JWKSNoMatchingKey ||
        err instanceof errors.JWSSignatureVerificationFailed
      ) {
        // The auth server may have rotated signing keys (same or new kid):
        // refresh the JWKS once and retry before rejecting the token.
        return await (await cachedKeySet(jwksUrl, true)).verify(token);
      }
      throw err;
    }
  };
}

function bearerToken(req: ApiRequest): string | null {
  const raw = req.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : null;
}

/** Comma-separated allowlist from OPERATOR_EMAILS, lowercase-compared. */
export function operatorAllowlist(): string[] {
  return (process.env.OPERATOR_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Verify the operator JWT on the request and return the operator identity.
 * Throws OperatorAuthError(401) for missing/invalid tokens and
 * OperatorAuthError(403) for valid tokens whose email is not allowlisted.
 */
export async function requireOperator(
  req: ApiRequest,
  verify: JwtVerifier = remoteVerifier(),
): Promise<OperatorIdentity> {
  const token = bearerToken(req);
  if (!token) {
    throw new OperatorAuthError(401, "Missing operator credentials");
  }
  let payload: JWTPayload;
  try {
    payload = await verify(token);
  } catch {
    throw new OperatorAuthError(401, "Invalid operator token");
  }
  const email =
    typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email) {
    throw new OperatorAuthError(403, "Operator token carries no email claim");
  }
  if (!operatorAllowlist().includes(email)) {
    throw new OperatorAuthError(403, "Operator not authorized");
  }
  return { email };
}
