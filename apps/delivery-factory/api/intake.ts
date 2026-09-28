import type { ServerResponse } from "node:http";
import { createDeliveryDb, getDb } from "./_lib/db.js";
import { triggerLeadHandoffWorkflows } from "./_lib/handoff-triggers.js";
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
import { log, reportError } from "./_lib/telemetry.js";

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
    await reportError(error, { route: "/api/intake", phase: "configuration" });
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
    const cors = corsHeadersFor(req.headers.origin ?? null, env.allowedOrigins);
    if (cors === null) {
      sendJson(res, 403, {}, { error: "Origin not allowed" });
      return;
    }
    sendJson(res, 204, cors, null);
    return;
  }

  try {
    const rawBody = await readRawBody(req);
    const result = await handleIntake(
      toIntakeRequest(req, rawBody),
      createDeliveryDb(),
      env,
      {
        onHandoffAccepted: (pkg) => triggerLeadHandoffWorkflows(getDb(), pkg),
      },
    );
    log("info", "handoff_intake_completed", {
      statusCode: result.status,
      replay: result.status === 200,
    });
    sendJson(res, result.status, result.headers, result.body);
  } catch (error) {
    await reportError(error, { route: "/api/intake", phase: "processing" });
    sendJson(res, 500, {}, { error: "Intake processing failed" });
  }
}
