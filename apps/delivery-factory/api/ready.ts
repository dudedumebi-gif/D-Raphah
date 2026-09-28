import type { ServerResponse } from "node:http";
import { assertDeliveryDatabaseReady } from "./_lib/db.js";
import { sendJson, type ApiRequest } from "./_lib/http.js";
import { reportError } from "./_lib/telemetry.js";

const required = [
  "DELIVERY_DATABASE_URL",
  "NEON_AUTH_URL",
  "OPERATOR_EMAILS",
  "LEAD_ENGINE_PUBLIC_KEY_PEM",
  "FEEDBACK_SIGNING_PRIVATE_KEY_PEM",
  "LEAD_ENGINE_BASE_URL",
  "DELIVERY_FACTORY_CRON_SECRET",
  "QSTASH_TOKEN",
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
  "SENTRY_DSN",
] as const;

export default async function handler(_req: ApiRequest, res: ServerResponse) {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const missing = required.filter((name) => !process.env[name]);
  checks.push({
    name: "runtime_configuration",
    ok: missing.length === 0,
    detail: missing.length ? `Missing: ${missing.join(", ")}` : undefined,
  });
  try {
    await assertDeliveryDatabaseReady();
    checks.push({ name: "database_schema_1_1_0", ok: true });
  } catch (error) {
    checks.push({
      name: "database_schema_1_1_0",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    await reportError(error, { route: "/api/ready" });
  }
  const ready = checks.every((check) => check.ok);
  sendJson(
    res,
    ready ? 200 : 503,
    {},
    {
      status: ready ? "ready" : "not_ready",
      service: "delivery-factory",
      checks,
      timestamp: new Date().toISOString(),
    },
  );
}
