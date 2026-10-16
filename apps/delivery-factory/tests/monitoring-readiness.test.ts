import { describe, expect, it } from "vitest";
import { readinessFromProbe } from "../src/monitoring-readiness.js";

/**
 * Per-product readiness (Codex P2 on PR #63): the Monitoring strip
 * derives each product's indicator ONLY from that product's own
 * readiness probe. The combined value it replaced let a Lead Engine
 * failure mark Delivery Factory degraded while DF /api/ready was
 * healthy.
 */
describe("readinessFromProbe", () => {
  it("LE down + DF ready → DF indicator reads ready", () => {
    const lead = readinessFromProbe(null); // LE request failed outright
    const factory = readinessFromProbe({
      ok: true,
      status: 200,
      data: {
        checks: [
          { name: "runtime_configuration", ok: true },
          { name: "database_schema_1_1_0", status: "ok" },
        ],
      },
    });
    expect(lead).toEqual({ state: "down", detail: "Unreachable" });
    expect(factory.state).toBe("up");
    expect(factory.detail).toContain("Ready");
  });

  it("DF degraded names only DF's own failing checks", () => {
    const factory = readinessFromProbe({
      ok: false,
      status: 503,
      data: {
        checks: [
          { name: "runtime_configuration", ok: true },
          { name: "database_schema_1_1_0", ok: false },
        ],
      },
    });
    expect(factory.state).toBe("degraded");
    expect(factory.detail).toBe("Not ready: database_schema_1_1_0");
  });

  it("falls back to the HTTP status when no check is flagged failing", () => {
    expect(readinessFromProbe({ ok: false, status: 502, data: {} })).toEqual({
      state: "degraded",
      detail: "Readiness HTTP 502",
    });
  });

  it("treats ok:true and status ok/pass checks alike", () => {
    const ready = readinessFromProbe({
      ok: true,
      status: 200,
      data: {
        checks: [
          { name: "a", ok: true },
          { name: "b", status: "pass" },
          { check: "c", status: "ok" },
        ],
      },
    });
    expect(ready.state).toBe("up");
  });
});
