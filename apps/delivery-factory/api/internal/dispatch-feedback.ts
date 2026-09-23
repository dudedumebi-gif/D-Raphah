import type { ServerResponse } from "node:http";
import {
  bearerMatches,
  dispatchDueFeedback,
  createNeonFeedbackOutboxStore,
} from "../_lib/feedback-dispatch.js";
import { getDb } from "../_lib/db.js";
import type { ApiRequest } from "../_lib/http.js";
import { sendJson } from "../_lib/http.js";

/**
 * POST /api/internal/dispatch-feedback — drains the feedback outbox to the
 * Lead Engine. Invoked by the QStash schedule (every 5 minutes) with
 * `Authorization: Bearer <DELIVERY_FACTORY_CRON_SECRET>`. Never exposed to
 * browsers or operators.
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export default async function handler(req: ApiRequest, res: ServerResponse) {
  if (req.method !== "POST") {
    sendJson(res, 405, { allow: "POST" }, { error: "Method not allowed" });
    return;
  }
  const secret = process.env.DELIVERY_FACTORY_CRON_SECRET ?? "";
  if (!bearerMatches(req.headers.authorization, secret)) {
    sendJson(res, 401, {}, { error: "Unauthorized" });
    return;
  }
  try {
    const summary = await dispatchDueFeedback({
      store: createNeonFeedbackOutboxStore(getDb()),
      env: {
        leadEngineBaseUrl: requiredEnv("LEAD_ENGINE_BASE_URL"),
        signingPrivateKeyPem: requiredEnv(
          "FEEDBACK_SIGNING_PRIVATE_KEY_PEM",
        ).replace(/\\n/g, "\n"),
      },
    });
    sendJson(res, 200, {}, { status: "ok", ...summary });
  } catch (error) {
    sendJson(res, 500, {}, { error: "Feedback dispatch failed" });
  }
}
