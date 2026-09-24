import type { ServerResponse } from "node:http";
import { sendJson, type ApiRequest } from "./_lib/http.js";

/**
 * GET /api/config — public runtime config for the SPA.
 *
 * Returns the Neon Auth base URL so the frontend login gate needs no
 * rebuild per environment. Intentionally NOT behind defineRoute: the SPA
 * needs this before the operator is authenticated.
 */
export default async function handler(req: ApiRequest, res: ServerResponse) {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "OPTIONS") {
    sendJson(res, 204, {}, null);
    return;
  }
  if (method !== "GET") {
    sendJson(res, 405, { allow: "GET, OPTIONS" }, { error: "Method not allowed" });
    return;
  }
  const authUrl = (process.env.NEON_AUTH_URL ?? "").trim().replace(/\/+$/, "");
  sendJson(res, 200, {}, { authUrl: authUrl || null });
}
