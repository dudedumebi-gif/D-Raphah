import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import type { ApiRequest } from "../api/_lib/http.js";

vi.mock("../api/_lib/db.js", () => ({
  assertDeliveryDatabaseReady: vi.fn(async () => undefined),
}));

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
];

afterEach(() => required.forEach((name) => delete process.env[name]));

function response() {
  const res = {
    statusCode: 200,
    body: "",
    setHeader: vi.fn(),
    end(body?: string) {
      res.body = body ?? "";
    },
  };
  return res as unknown as ServerResponse & { body: string };
}

describe("Delivery Factory readiness", () => {
  it("fails closed when production configuration is incomplete", async () => {
    const { default: handler } = await import("../api/ready.js");
    const res = response();
    await handler({ method: "GET", headers: {} } as ApiRequest, res);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).service).toBe("delivery-factory");
  });

  it("reports ready only when configuration and schema checks pass", async () => {
    required.forEach((name) => {
      process.env[name] = "configured";
    });
    const { default: handler } = await import("../api/ready.js");
    const res = response();
    await handler({ method: "GET", headers: {} } as ApiRequest, res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ready");
  });
});
