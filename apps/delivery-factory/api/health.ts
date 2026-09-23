import type { ServerResponse } from "node:http";
import type { ApiRequest } from "./_lib/http.js";
import { sendJson } from "./_lib/http.js";

/** GET /api/health — liveness probe. No database access. */
export default async function handler(_req: ApiRequest, res: ServerResponse) {
  sendJson(res, 200, {}, {
    status: "ok",
    service: "delivery-factory",
    contract: "LeadEngineHandoffPackage/v1 + DeliveryFeedbackEvent/v1",
    timestamp: new Date().toISOString(),
  });
}
