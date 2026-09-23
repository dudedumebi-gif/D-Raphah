import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  detectSignals,
  evaluateCanarySoak,
  percentile95,
  recoverExpiredLease,
  retryDelaySeconds,
  scheduleIdempotencyKey,
  scoreSignals,
} from "../server/domain";
import { assertUrlAllowed, type CollectionPolicy } from "../server/collection";

const policy: CollectionPolicy = {
  allowedDomains: ["example.com"],
  allowlistPaths: ["/public/*"],
  denylistPaths: ["/public/login*"],
  userAgent: "RaphahLeadEngineBot/2.0",
  contactEmail: "ops@example.com",
  rateLimitRps: 1,
  maxBytes: 2_000_000,
  timeoutMs: 20_000,
  respectRobots: true,
  collectionMethod: "static_html",
};

describe("collection policy", () => {
  it("allows only the approved public domain and path", () => {
    expect(
      assertUrlAllowed("https://example.com/public/process", policy).hostname,
    ).toBe("example.com");
    expect(() =>
      assertUrlAllowed("https://example.com/public/login", policy),
    ).toThrow(/denied/i);
    expect(() =>
      assertUrlAllowed("https://other.example/public/process", policy),
    ).toThrow(/not approved/i);
    expect(() => assertUrlAllowed("file:///etc/passwd", policy)).toThrow(
      /HTTP/i,
    );
  });

  it("canonicalizes tracking parameters for deterministic evidence", () => {
    expect(
      canonicalizeUrl("HTTPS://Example.com/process/?utm_source=x&b=2#top"),
    ).toBe("https://example.com/process?b=2");
  });
});

describe("maturity scoring", () => {
  it("scores strong manual friction as low maturity and high opportunity", () => {
    const signals = detectSignals(
      "Call us to book. Fax the paperwork. We use manual data entry and spreadsheet tracking. A modernization programme is funded.",
    );
    const score = scoreSignals(signals, {
      automationMaturityMax: 45,
      opportunityPotentialMin: 50,
      confidenceMin: 0.5,
      minimumEvidenceCategories: 2,
    });
    expect(score.automationMaturity).toBeLessThan(50);
    expect(score.opportunityPotential).toBeGreaterThanOrEqual(50);
    expect(score.qualified).toBe(true);
    expect(score.scoringVersion).toBe("2.0.0");
  });

  it("does not qualify highly automated organizations", () => {
    const signals = detectSignals(
      "Book online in our customer portal. Salesforce API integration, Power BI analytics, and a generative AI assistant are available.",
    );
    const score = scoreSignals(signals, {
      automationMaturityMax: 40,
      opportunityPotentialMin: 50,
      confidenceMin: 0.5,
      minimumEvidenceCategories: 2,
    });
    expect(score.automationMaturity).toBeGreaterThan(40);
    expect(score.qualified).toBe(false);
  });
});

describe("durable scheduling", () => {
  it("uses deterministic schedule idempotency keys", () => {
    const scheduled = new Date("2026-09-22T10:00:00.000Z");
    expect(scheduleIdempotencyKey("campaign-1", scheduled)).toBe(
      scheduleIdempotencyKey("campaign-1", scheduled),
    );
  });

  it("recovers an expired lease into retry or dead letter", () => {
    const now = new Date("2026-09-22T10:00:00.000Z");
    const retried = recoverExpiredLease(
      {
        id: "1",
        status: "running",
        attemptCount: 1,
        maxAttempts: 3,
        leaseExpiresAt: "2026-09-22T09:59:00.000Z",
      },
      now,
    );
    expect(retried.status).toBe("retrying");
    const dead = recoverExpiredLease(
      {
        id: "2",
        status: "leased",
        attemptCount: 3,
        maxAttempts: 3,
        leaseExpiresAt: "2026-09-22T09:59:00.000Z",
      },
      now,
    );
    expect(dead.status).toBe("dead_letter");
  });

  it("backs off retries", () => {
    expect(retryDelaySeconds(2)).toBeGreaterThan(retryDelaySeconds(1));
    expect(retryDelaySeconds(10)).toBeLessThanOrEqual(4_320);
  });
});

describe("release SLOs", () => {
  it("calculates p95 without mutating input", () => {
    const values = [300, 100, 200, 500, 400];
    expect(percentile95(values)).toBe(500);
    expect(values).toEqual([300, 100, 200, 500, 400]);
  });

  it("passes a complete 72-hour canary at or above 99 percent", () => {
    const now = new Date("2026-09-22T12:00:00.000Z");
    const observations = Array.from({ length: 73 }, (_, index) => {
      const scheduled = new Date(now.getTime() - (72 - index) * 3_600_000);
      return {
        scheduledAt: scheduled.toISOString(),
        completedAt: new Date(scheduled.getTime() + 60_000).toISOString(),
        status: "completed" as const,
      };
    });
    expect(evaluateCanarySoak(observations, now).passed).toBe(true);
  });
});
