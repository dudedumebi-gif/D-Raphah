import { describe, expect, it } from "vitest";
import {
  CriteriaSchema,
  evaluateGeography,
  suggestCriteriaAdjustment,
  evaluateCanarySoak,
} from "../api/_lib/domain";
import {
  extractCoordinates,
  assertUrlAllowed,
  type CollectionPolicy,
} from "../api/_lib/collection";
import { requireScheduler } from "../api/_lib/neon";

describe("geographic qualification", () => {
  it("does not mistake the word 'on' for Ontario", () => {
    expect(evaluateGeography("We focus on customer service", {}).eligible).toBe(
      false,
    );
  });
  it("does not allow the province to override city narrowing", () => {
    expect(
      evaluateGeography("London, Ontario", {
        geography: { cities: ["Toronto"], regions: ["Ontario"] },
      }).eligible,
    ).toBe(false);
    expect(evaluateGeography("Toronto, Ontario", {}).city).toBe("Toronto");
  });
  it("matches accented region names and custom cities without partial-word matches", () => {
    expect(
      evaluateGeography("Québec", {
        geography: { cities: [], regions: ["Quebec"] },
      }).eligible,
    ).toBe(true);
    expect(
      evaluateGeography("Torontoish", {
        geography: { cities: ["Toronto"], regions: [] },
      }).eligible,
    ).toBe(false);
    expect(
      evaluateGeography("Halifax", {
        geography: { cities: ["Halifax"], regions: ["Nova Scotia"] },
      }).eligible,
    ).toBe(true);
    expect(
      evaluateGeography("Halifax", {
        geography: { cities: [], regions: ["Nova Scotia"] },
      }).eligible,
    ).toBe(false);
    expect(
      evaluateGeography("Anywhere", { geography: { cities: [], regions: [] } })
        .basis,
    ).toBe("not_restricted");
  });
  const radius = {
    geography: {
      mode: "radius",
      centreLatitude: 43.6532,
      centreLongitude: -79.3832,
      radiusKm: 50,
    },
  };
  it("requires valid centre and source coordinates for radius searches", () => {
    expect(evaluateGeography("Toronto", radius).eligible).toBe(false);
    expect(
      evaluateGeography(
        "Toronto",
        { geography: { mode: "radius" } },
        { latitude: 43.65, longitude: -79.38 },
      ).eligible,
    ).toBe(false);
    expect(
      evaluateGeography("Toronto", radius, { latitude: NaN, longitude: 0 })
        .eligible,
    ).toBe(false);
    expect(
      evaluateGeography("Toronto", radius, { latitude: 0, longitude: 181 })
        .eligible,
    ).toBe(false);
  });
  it("calculates radius distance and combines radius with a named market", () => {
    expect(
      evaluateGeography("Toronto", radius, {
        latitude: 43.6532,
        longitude: -79.3832,
      }),
    ).toMatchObject({ eligible: true, distanceKm: 0 });
    expect(
      evaluateGeography("Ottawa", radius, {
        latitude: 45.4215,
        longitude: -75.6972,
      }),
    ).toMatchObject({ eligible: false, basis: "outside_radius" });
    const hybrid = {
      geography: {
        ...radius.geography,
        mode: "hybrid",
        cities: ["Toronto"],
        regions: [],
      },
    };
    expect(
      evaluateGeography("Toronto", hybrid, {
        latitude: 43.65,
        longitude: -79.38,
      }).eligible,
    ).toBe(true);
    expect(
      evaluateGeography("Unknown", hybrid, {
        latitude: 43.65,
        longitude: -79.38,
      }).eligible,
    ).toBe(false);
  });
  it("extracts unambiguous structured coordinates only", () => {
    expect(
      extractCoordinates(
        '<script type="application/ld+json">{"geo":{"latitude":"43.65","longitude":-79.38}}</script>',
        "text/html",
      ),
    ).toEqual({ latitude: 43.65, longitude: -79.38 });
    expect(
      extractCoordinates(
        '{"geo":{"latitude":null,"longitude":0}}',
        "application/json",
      ),
    ).toBeUndefined();
    expect(
      extractCoordinates(
        '{"geo":{"latitude":91,"longitude":0}}',
        "application/json",
      ),
    ).toBeUndefined();
    expect(
      extractCoordinates("invalid json", "application/json"),
    ).toBeUndefined();
    expect(
      extractCoordinates(
        '[{"geo":{"latitude":1,"longitude":2}},{"geo":{"latitude":3,"longitude":4}}]',
        "application/json",
      ),
    ).toBeUndefined();
  });
  it("does not mistake two-letter tokens for Canadian province codes", () => {
    expect(
      evaluateGeography(
        "We love AB testing our funnels. Plans include 50 MB of storage.",
        { geography: { cities: [], regions: ["Alberta", "Manitoba"] } },
      ).eligible,
    ).toBe(false);
  });
  it("still matches full Canadian province names", () => {
    expect(
      evaluateGeography("Our Calgary, Alberta office is hiring.", {
        geography: { cities: [], regions: ["Alberta"] },
      }).eligible,
    ).toBe(true);
  });
});

describe("bounded criteria recommendations", () => {
  it("loosens, holds, and tightens without autonomous application", () => {
    expect(suggestCriteriaAdjustment({}, 2)).toMatchObject({
      direction: "loosen",
      autoApply: false,
      changes: { automationMaturityMax: 45 },
    });
    expect(suggestCriteriaAdjustment({}, 20)).toMatchObject({
      direction: "hold",
      changes: {},
    });
    expect(suggestCriteriaAdjustment({}, 40)).toMatchObject({
      direction: "tighten",
      changes: { automationMaturityMax: 35 },
    });
  });
  it("never reverses direction at custom guardrail boundaries", () => {
    const loose = CriteriaSchema.parse({
      automationMaturityMax: 90,
      opportunityPotentialMin: 20,
      confidenceMin: 0.1,
    });
    expect(suggestCriteriaAdjustment(loose, 0).changes).toEqual({
      automationMaturityMax: 90,
      opportunityPotentialMin: 20,
      confidenceMin: 0.1,
    });
    const strict = CriteriaSchema.parse({
      automationMaturityMax: 10,
      opportunityPotentialMin: 95,
      confidenceMin: 0.95,
    });
    expect(suggestCriteriaAdjustment(strict, 100).changes).toEqual({
      automationMaturityMax: 10,
      opportunityPotentialMin: 95,
      confidenceMin: 0.95,
    });
  });
});

describe("canary gate cannot be manufactured by duplicate or future observations", () => {
  const now = new Date("2026-09-22T12:35:00Z");
  const hours = Array.from({ length: 72 }, (_, index) => {
    const at = Date.parse("2026-09-22T12:00:00Z") - (72 - index) * 3_600_000;
    return {
      scheduledAt: new Date(at).toISOString(),
      completedAt: new Date(at + 60_000).toISOString(),
      status: "completed" as const,
    };
  });
  it("passes only a complete window, including when checked mid-hour", () => {
    expect(evaluateCanarySoak([...hours].reverse(), now)).toMatchObject({
      passed: true,
      completed: 72,
      missing: 0,
    });
  });
  it("counts missing hours and failed runs against the completion denominator", () => {
    expect(evaluateCanarySoak(hours.slice(1), now)).toMatchObject({
      passed: false,
      missing: 1,
      total: 72,
    });
    expect(
      evaluateCanarySoak(
        [...hours.slice(1), { ...hours[0], status: "failed" }],
        now,
      ).passed,
    ).toBe(false);
  });
  it("rejects duplicate-only, conflicting, and future-completed observations", () => {
    expect(evaluateCanarySoak(Array(72).fill(hours[0]), now).passed).toBe(
      false,
    );
    expect(
      evaluateCanarySoak([...hours, { ...hours[0], status: "failed" }], now)
        .passed,
    ).toBe(false);
    expect(
      evaluateCanarySoak(
        hours.map((h) => ({ ...h, completedAt: "2099-01-01T00:00:00Z" })),
        now,
      ).passed,
    ).toBe(false);
    expect(
      evaluateCanarySoak([{ scheduledAt: "invalid", status: "completed" }], now)
        .passed,
    ).toBe(false);
    expect(evaluateCanarySoak([], now).passed).toBe(false);
  });
});

describe("hard collection boundaries", () => {
  const policy = {
    allowedDomains: ["linkedin.com", "example.com"],
    allowlistPaths: ["/*"],
    denylistPaths: [],
  } as unknown as CollectionPolicy;
  it("blocks LinkedIn even when a source policy lists it", () => {
    expect(() =>
      assertUrlAllowed("https://www.linkedin.com/company/test", policy),
    ).toThrow(/prohibited/);
    expect(() => assertUrlAllowed("https://linkedin.com/", policy)).toThrow(
      /prohibited/,
    );
  });
  it("blocks URL-embedded credentials", () => {
    expect(() =>
      assertUrlAllowed("https://username:password@example.com", policy),
    ).toThrow(/credentials/);
  });
});

describe("scheduler authorization", () => {
  it("allows an explicit server-only manual diagnostic secret", async () => {
    const previous = process.env.WORKER_SECRET;
    process.env.WORKER_SECRET = "test-worker-secret";
    try {
      await expect(
        requireScheduler(
          new Request("https://lead.example/api/v1/worker/tick", {
            method: "POST",
            headers: { authorization: "Bearer test-worker-secret" },
          }),
        ),
      ).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.WORKER_SECRET;
      else process.env.WORKER_SECRET = previous;
    }
  });

  it("rejects unsigned scheduler traffic", async () => {
    const previous = process.env.WORKER_SECRET;
    delete process.env.WORKER_SECRET;
    try {
      await expect(
        requireScheduler(
          new Request("https://lead.example/api/v1/worker/tick", {
            method: "POST",
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 401 });
    } finally {
      if (previous !== undefined) process.env.WORKER_SECRET = previous;
    }
  });
});
