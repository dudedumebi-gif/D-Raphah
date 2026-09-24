import type { ServerResponse } from "node:http";
import { createDeliveryDb, type DeliveryDb } from "./db.js";
import {
  corsHeadersFor,
  readIntakeEnv,
  type IntakeEnv,
} from "./verify.js";
import {
  errorMessage,
  errorStatus,
  sendJson,
  type ApiRequest,
} from "./http.js";
import { requireOperator, type OperatorIdentity } from "./operator.js";

/**
 * Shared wrapper for the operator project routes (everything except
 * /api/intake and /api/health): restricted CORS, method gating, operator
 * authentication, service wiring, and error mapping.
 *
 * Operator auth is a Neon Auth (better-auth) RS256 JWT verified against the
 * Neon Auth JWKS, plus an email allowlist from OPERATOR_EMAILS. The
 * allowlist is the real gate: any valid JWT whose email is not listed gets
 * 403. Thrown OperatorAuthErrors map to 401/403 JSON responses via
 * errorStatus() below.
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
    const cors = corsHeadersFor(req.headers.origin ?? null, env.allowedOrigins);
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
      const operator = await requireOperator(req);
      await handler(req, res, { db: createDeliveryDb(), env, operator });
    } catch (error) {
      sendJson(res, errorStatus(error), cors, { error: errorMessage(error) });
    }
  };
}
