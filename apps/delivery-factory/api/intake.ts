import type { ServerResponse } from "node:http";
import { createDeliveryDb } from "./_lib/db.js";
import {
  corsHeadersFor,
  handleIntake,
  readIntakeEnv,
  type IntakeEnv,
} from "./_lib/verify.js";
import {
  INTAKE_BODY_PARSER_CONFIG,
  readRawBody,
  sendJson,
  toIntakeRequest,
  type ApiRequest,
} from "./_lib/http.js";

export const config = INTAKE_BODY_PARSER_CONFIG;

/**
 * POST /api/intake — the single contract boundary with the Lead Engine.
 *
 * The raw body is read unparsed so the content-sha256 transport check and
 * the Ed25519/canonical-JSON verification run over the exact bytes sent.
 * See api/_lib/verify.ts for the verification order and the Must-requirement
 * baseline freeze rule.
 */
export default async function handler(req: ApiRequest, res: ServerResponse) {
  let env: IntakeEnv;
  try {
    env = readIntakeEnv();
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Misconfigured",
      }),
    );
    return;
  }

  if ((req.method ?? "GET").toUpperCase() === "OPTIONS") {
    const cors = corsHeadersFor(
      req.headers.origin ?? null,
      env.allowedOrigins,
    );
    if (cors === null) {
      sendJson(res, 403, {}, { error: "Origin not allowed" });
      return;
    }
    sendJson(res, 204, cors, null);
    return;
  }

  const rawBody = await readRawBody(req);
  const result = await handleIntake(
    toIntakeRequest(req, rawBody),
    createDeliveryDb(),
    env,
  );
  sendJson(res, result.status, result.headers, result.body);
}
