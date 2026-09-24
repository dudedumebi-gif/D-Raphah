import type { ApiRequest } from "./http.js";
import type { DeliveryDb } from "./db.js";

/**
 * Operator authentication for the Delivery Factory dashboard.
 *
 * Operators sign in through Neon Auth (better-auth) in the browser. The SPA
 * reads the better-auth session via a cross-origin `get-session` call (the
 * session cookie is `Partitioned`, so the browser sends it) and keeps the
 * opaque session token in memory, sending it as
 * `Authorization: Bearer <session token>` on every operator API call.
 *
 * Here we validate that token directly against the better-auth tables in
 * our own database — the Delivery Factory owns its database outright and
 * Neon Auth branches with it, so this is first-party data, not cross-product
 * access. The token must match a live, unexpired `neon_auth.session` row, and the
 * session's user email must be on the OPERATOR_EMAILS allowlist. The
 * allowlist is the real gate: anyone can create a Neon Auth account, but
 * only allowlisted emails get past this.
 *
 * This deliberately avoids the better-auth JWT plugin (not available in the
 * Neon Auth console): no JWKS, no `/token` endpoint, no JWT minting.
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

/** A validated better-auth session: just the operator's email. */
export interface OperatorSession {
  email: string;
}

/**
 * Injectable session validator; production looks the token up in the
 * better-auth tables, tests stub it. Database failures propagate as-is
 * (mapped to 500 by the route wrapper) — they are not credential problems.
 */
export type SessionValidator = (
  token: string,
) => Promise<OperatorSession | null>;

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
 * Verify the operator session token on the request and return the operator
 * identity. Throws OperatorAuthError(401) for missing/invalid/expired
 * tokens and OperatorAuthError(403) for valid sessions whose email is not
 * allowlisted.
 */
export async function requireOperator(
  req: ApiRequest,
  validateSession: SessionValidator,
): Promise<OperatorIdentity> {
  const token = bearerToken(req);
  if (!token) {
    throw new OperatorAuthError(401, "Missing operator credentials");
  }
  const session = await validateSession(token);
  if (!session) {
    throw new OperatorAuthError(401, "Invalid or expired operator session");
  }
  const email = session.email.trim().toLowerCase();
  if (!email) {
    throw new OperatorAuthError(403, "Operator session has no email");
  }
  if (!operatorAllowlist().includes(email)) {
    throw new OperatorAuthError(403, "Operator not authorized");
  }
  return { email };
}

/** Build a SessionValidator from a DeliveryDb (used by the route wrapper). */
export function dbSessionValidator(db: DeliveryDb): SessionValidator {
  return (token: string) => db.findOperatorSession(token);
}

/**
 * Verify that the request carries a live better-auth session, WITHOUT the
 * operator allowlist check. Used by POST /api/sign-out: anyone holding a
 * valid session (allowlisted or not) must be able to revoke it.
 * Throws OperatorAuthError(401) for missing/invalid/expired tokens.
 */
export async function requireSession(
  req: ApiRequest,
  validateSession: SessionValidator,
): Promise<OperatorIdentity & { token: string }> {
  const token = bearerToken(req);
  if (!token) {
    throw new OperatorAuthError(401, "Missing operator credentials");
  }
  const session = await validateSession(token);
  if (!session) {
    throw new OperatorAuthError(401, "Invalid or expired operator session");
  }
  const email = session.email.trim().toLowerCase();
  if (!email) {
    throw new OperatorAuthError(401, "Operator session has no email");
  }
  return { email, token };
}
