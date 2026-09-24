import type { ServerResponse } from "node:http";
import { createDeliveryDb } from "./_lib/db.js";
import {
  errorMessage,
  errorStatus,
  sendJson,
  type ApiRequest,
} from "./_lib/http.js";
import {
  dbSessionValidator,
  OperatorAuthError,
  requireSession,
} from "./_lib/operator.js";

/**
 * POST /api/sign-out — operator sign-out.
 *
 * Deletes the caller's better-auth session row (`neon_auth.session`) from
 * our own database, so sign-out is authoritative and does not depend on
 * the Neon Auth /sign-out endpoint. Any holder of a live session can
 * revoke it — the OPERATOR_EMAILS allowlist is deliberately NOT enforced
 * here (a non-allowlisted account must still be able to sign out).
 *
 * 200 { signedOut: true } when the session row was deleted.
 * 401 when the bearer token is missing, unknown, or expired.
 * 500 when the database is unreachable.
 */
export default async function handler(req: ApiRequest, res: ServerResponse) {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "OPTIONS") {
    sendJson(res, 204, {}, null);
    return;
  }
  if (method !== "POST") {
    sendJson(res, 405, { allow: "POST, OPTIONS" }, { error: "Method not allowed" });
    return;
  }
  try {
    const db = createDeliveryDb();
    const { token } = await requireSession(req, dbSessionValidator(db));
    await db.revokeOperatorSession(token);
    sendJson(res, 200, {}, { signedOut: true });
  } catch (err) {
    const status = errorStatus(err);
    if (err instanceof OperatorAuthError) {
      sendJson(res, status, {}, { error: errorMessage(err) });
      return;
    }
    sendJson(res, 500, {}, { error: "Sign-out failed" });
  }
}
