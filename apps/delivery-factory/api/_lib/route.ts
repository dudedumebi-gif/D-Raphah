import type { ServerResponse } from "node:http";
import { createDeliveryDb, type DeliveryDb } from "./db.js";
import {
  corsHeadersFor,
  isSameOrigin,
  readIntakeEnv,
  type IntakeEnv,
} from "./verify.js";
import {
  errorMessage,
  errorStatus,
  sendJson,
  type ApiRequest,
} from "./http.js";
import {
  dbSessionValidator,
  requireOperator,
  type OperatorIdentity,
} from "./operator.js";

/**
 * Shared wrapper for the operator project routes (everything except
 * /api/intake and /api/health): restricted CORS, method gating, operator
 * authentication, service wiring, and error mapping.
 *
 * Operator auth is a better-auth session token validated against the
 * better-auth tables in our own database, plus an email allowlist from
 * OPERATOR_EMAILS. The allowlist is the real gate: any valid session whose
 * email is not listed gets 403. Thrown OperatorAuthErrors map to 401/403
 * JSON responses via errorStatus() below.
 */

type RouteHandler = (
  req: ApiRequest,
  res: ServerResponse,
  ctx: { db: DeliveryDb; env: IntakeEnv; operator: OperatorIdentity },
) => Promise<void>;

export function defineRoute(
  methods: string[],
  handler: RouteHandler,
): (req: ApiRequest, res: ServerResponse) => Promise<void> {
  return async function route(req: ApiRequest, res: ServerResponse) {
    const env = readIntakeEnv();
    const origin = req.headers.origin ?? null;
    let cors = corsHeadersFor(
      Array.isArray(origin) ? origin[0] : origin,
      env.allowedOrigins,
    );
    if (cors === null && isSameOrigin(origin, req.headers.host)) {
      // Same-origin browser call: no CORS headers needed, and never
      // forbidden — the allowlist only gates cross-origin callers.
      cors = {};
    }
    const method = (req.method ?? "GET").toUpperCase();

    if (method === "OPTIONS") {
      if (cors === null) {
        sendJson(res, 403, {}, { error: "Origin not allowed" });
        return;
      }
      sendJson(res, 204, cors, null);
      return;
    }
    if (cors === null) {
      sendJson(res, 403, {}, { error: "Origin not allowed" });
      return;
    }
    if (!methods.includes(method)) {
      sendJson(res, 405, { ...cors, allow: [...methods, "OPTIONS"].join(", ") }, {
        error: "Method not allowed",
      });
      return;
    }
    try {
      const db = createDeliveryDb();
      const operator = await requireOperator(req, dbSessionValidator(db));
      await handler(req, res, { db, env, operator });
    } catch (error) {
      sendJson(res, errorStatus(error), cors, { error: errorMessage(error) });
    }
  };
}
