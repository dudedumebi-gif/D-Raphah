import type { IncomingMessage, ServerResponse } from "node:http";
import { createAdminClient, configurationStatus } from "../_lib/neon.js";
import { log } from "../_lib/telemetry.js";
import { ingestDeliveryFeedback } from "../_lib/feedback.js";

export default async function handler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, hasFeedback: typeof ingestDeliveryFeedback === "function" }));
}
