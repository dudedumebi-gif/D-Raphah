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

/**
 * Shared wrapper for the operator project routes (everything except
 * /api/intake and /api/health): restricted CORS, method gating, service
 * wiring, and error mapping.
 *
 * NOTE: these routes currently carry no operator authentication; they run
 * with the service-role database client. End-user auth is out of scope for
 * this phase (see the migration header) and must land before any
 * browser session is allowed to call mutating routes directly.
 */

type RouteHandler = (
  req: ApiRequest,
  res: ServerResponse,
  ctx: { db: DeliveryDb; env: IntakeEnv },
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
      await handler(req, res, { db: createDeliveryDb(), env });
    } catch (error) {
      sendJson(res, errorStatus(error), cors, { error: errorMessage(error) });
    }
  };
}
