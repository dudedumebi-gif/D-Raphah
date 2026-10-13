import { describe, expect, it } from "vitest";
import {
  computeRescore,
  effectiveCriteria,
  rescoreFingerprint,
  reuseSignals,
  type StoredObservation,
} from "../api/_lib/rescore";
import {
  JOB_BANK_MARKET_SIGNAL_CODE,
  detectSignals,
} from "../api/_lib/domain";

const CLINIC_TEXT =
  "Bathurst Dental Clinic, Toronto, Ontario. Call us at (416) 555-0100 or " +
  "email reception@bathurstdental.ca to book an appointment. Our front desk " +
  "team will help you schedule your visit. We are hiring a dental receptionist.";

function observationsFrom(text: string): StoredObservation[] {
  return detectSignals(text).map((signal) => ({
    code: signal.code,
    category: signal.category,
    polarity: signal.polarity,
    strength: signal.strength,
    confidence: signal.confidence,
    excerpt: signal.excerpt,
  }));
}

const MARKET = {
  city: "Toronto",
  province: "Ontario",
  postings: 34,
  syncedAt: "2026-10-12T00:00:00.000Z",
};

describe("reuseSignals", () => {
  it("preserves the clinic's own observations verbatim", () => {
    const stored = observationsFrom(CLINIC_TEXT);
    expect(stored.length).toBeGreaterThan(0);
    const reused = reuseSignals(stored);
    expect(reused).toHaveLength(stored.length);
    expect(reused[0]).toEqual(stored[0]);
  });

  it("excludes any prior market overlay (refreshed per pass)", () => {
    const stored: StoredObservation[] = [
      ...observationsFrom(CLINIC_TEXT),
      {
        code: JOB_BANK_MARKET_SIGNAL_CODE,
        category: "commercial",
        polarity: "positive",
        strength: 20,
        confidence: 1,
        excerpt: "stale overlay",
      },
    ];
    const reused = reuseSignals(stored);
    expect(
      reused.some((signal) => signal.code === JOB_BANK_MARKET_SIGNAL_CODE),
    ).toBe(false);
  });
});

describe("rescoreFingerprint", () => {
  it("is stable for identical inputs and sensitive to both inputs", () => {
    const criteria = effectiveCriteria({}, {});
    const a = rescoreFingerprint(criteria, MARKET.syncedAt);
    expect(rescoreFingerprint(criteria, MARKET.syncedAt)).toBe(a);
    expect(rescoreFingerprint(criteria, "2026-10-13T00:00:00.000Z")).not.toBe(a);
    const tuned = effectiveCriteria({}, { thresholdOverride: 55 });
    expect(rescoreFingerprint(tuned, MARKET.syncedAt)).not.toBe(a);
  });
});

describe("computeRescore", () => {
  it("adds exactly one fresh market overlay and lifts intent", () => {
    const criteria = effectiveCriteria({}, {});
    const computed = computeRescore({
      observations: observationsFrom(CLINIC_TEXT),
      text: CLINIC_TEXT,
      criteria,
      market: MARKET,
      geoEligible: true,
    });
    expect(computed.marketSignal?.code).toBe(JOB_BANK_MARKET_SIGNAL_CODE);
    expect(
      computed.signals.filter(
        (signal) => signal.code === JOB_BANK_MARKET_SIGNAL_CODE,
      ),
    ).toHaveLength(1);
    expect(computed.score.components.intent_trigger).toBeGreaterThan(0);
  });

  it("changes only the gate, not the score, when the threshold moves", () => {
    const observations = observationsFrom(CLINIC_TEXT);
    const at55 = computeRescore({
      observations,
      text: CLINIC_TEXT,
      criteria: effectiveCriteria({}, { thresholdOverride: 55 }),
      market: MARKET,
      geoEligible: true,
    });
    const at99 = computeRescore({
      observations,
      text: CLINIC_TEXT,
      criteria: effectiveCriteria({}, { thresholdOverride: 99 }),
      market: MARKET,
      geoEligible: true,
    });
    expect(at55.score.opportunityScore).toBe(at99.score.opportunityScore);
    expect(at99.score.qualified).toBe(false);
    if (at55.score.opportunityScore >= 55) {
      expect(at55.score.qualified).toBe(true);
    }
  });

  it("scores without any overlay when the market is absent", () => {
    const computed = computeRescore({
      observations: observationsFrom(CLINIC_TEXT),
      text: CLINIC_TEXT,
      criteria: effectiveCriteria({}, {}),
      market: null,
      geoEligible: true,
    });
    expect(computed.marketSignal).toBeNull();
    expect(computed.fingerprint).toBe(
      rescoreFingerprint(effectiveCriteria({}, {}), null),
    );
  });
});
