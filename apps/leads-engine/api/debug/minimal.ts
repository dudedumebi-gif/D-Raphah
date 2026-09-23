import type { IncomingMessage, ServerResponse } from "node:http";
// Only import the "safe" modules
import { createAdminClient, configurationStatus } from "../_lib/neon.js";
import { log } from "../_lib/telemetry.js";

export default async function handler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  log("info", "minimal test");
  res.end(JSON.stringify({ ok: true, configured: configurationStatus().configured }));
}
