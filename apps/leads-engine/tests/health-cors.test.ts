import { describe, expect, it } from "vitest";
import { handleApiRequest } from "../api/_lib/router.js";

function get(path: string, origin?: string): Request {
  return new Request(`https://lead-engine.example${path}`, {
    headers: origin ? { origin } : {},
  });
}

describe("health endpoint CORS", () => {
  it("returns Access-Control-Allow-Origin: * on /api/health/live for any origin", async () => {
    const res = await handleApiRequest(
      get("/api/health/live", "https://some-dashboard.example.com"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("returns Access-Control-Allow-Origin: * on /api/health/ready for any origin", async () => {
    const res = await handleApiRequest(
      get("/api/health/ready", "https://some-dashboard.example.com"),
    );
    // 503 when unconfigured is fine — the point is the CORS header.
    expect([200, 503]).toContain(res.status);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("does not open non-health endpoints to arbitrary origins", async () => {
    const res = await handleApiRequest(
      get("/api/v1/leads", "https://evil.example.com"),
    );
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
