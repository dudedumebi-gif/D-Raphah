import { describe, expect, it } from "vitest";
import {
  AUTO_APPLY_MAX_STEP,
  CriteriaSchema,
  evaluateAutoApply,
  mergeSuggestionChanges,
  suggestCriteriaAdjustment,
  type CriteriaSuggestion,
} from "../api/_lib/domain";

const BASE_CRITERIA = CriteriaSchema.parse({});

function loosenSuggestion(): CriteriaSuggestion {
  return suggestCriteriaAdjustment(BASE_CRITERIA, 2);
}

describe("mergeSuggestionChanges", () => {
  it("merges partial changes into current criteria", () => {
    const merged = mergeSuggestionChanges(BASE_CRITERIA, {
      automationMaturityMax: 45,
    });
    expect(merged.automationMaturityMax).toBe(45);
    expect(merged.opportunityPotentialMin).toBe(
      BASE_CRITERIA.opportunityPotentialMin,
    );
  });

  it("applies the same validation as the PATCH route (rejects bad merges)", () => {
    expect(() =>
      mergeSuggestionChanges(BASE_CRITERIA, {
        // @ts-expect-error intentionally out of schema bounds
        confidenceMin: 5,
      }),
    ).toThrow();
  });

  it("applies a full engine suggestion without loss", () => {
    const suggestion = loosenSuggestion();
    const merged = mergeSuggestionChanges(BASE_CRITERIA, suggestion.changes);
    for (const [key, value] of Object.entries(suggestion.changes))
      expect(merged[key as keyof typeof merged]).toBe(value);
  });
});

describe("evaluateAutoApply", () => {
  it("returns null when the opt-in flag is off", () => {
    expect(
      evaluateAutoApply(BASE_CRITERIA, loosenSuggestion(), {
        autoApplyEnabled: false,
      }),
    ).toBeNull();
  });

  it("returns null for a hold suggestion", () => {
    const hold = suggestCriteriaAdjustment(BASE_CRITERIA, 20);
    expect(hold.direction).toBe("hold");
    expect(
      evaluateAutoApply(BASE_CRITERIA, hold, { autoApplyEnabled: true }),
    ).toBeNull();
  });

  it("returns null when changes are empty", () => {
    const suggestion: CriteriaSuggestion = {
      direction: "tighten",
      observedQualifiedLeads: 99,
      targetQualifiedLeads: 20,
      changes: {},
      rationale: ["synthetic"],
      autoApply: true,
    };
    expect(
      evaluateAutoApply(BASE_CRITERIA, suggestion, { autoApplyEnabled: true }),
    ).toBeNull();
  });

  it("applies exactly one bounded step toward the suggestion", () => {
    const suggestion: CriteriaSuggestion = {
      direction: "loosen",
      observedQualifiedLeads: 2,
      targetQualifiedLeads: 20,
      // Far-away synthetic target: a single run must not jump the whole way.
      changes: { automationMaturityMax: 60 },
      rationale: ["synthetic"],
      autoApply: true,
    };
    const next = evaluateAutoApply(BASE_CRITERIA, suggestion, {
      autoApplyEnabled: true,
    });
    expect(next).not.toBeNull();
    expect(next!.automationMaturityMax).toBe(
      BASE_CRITERIA.automationMaturityMax + AUTO_APPLY_MAX_STEP.automationMaturityMax,
    );
    expect(next!.opportunityPotentialMin).toBe(
      BASE_CRITERIA.opportunityPotentialMin,
    );
  });

  it("never overshoots the suggestion target", () => {
    const suggestion: CriteriaSuggestion = {
      direction: "loosen",
      observedQualifiedLeads: 2,
      targetQualifiedLeads: 20,
      changes: { automationMaturityMax: 42 },
      rationale: ["synthetic"],
      autoApply: true,
    };
    const next = evaluateAutoApply(BASE_CRITERIA, suggestion, {
      autoApplyEnabled: true,
    });
    expect(next!.automationMaturityMax).toBe(42);
  });

  it("moves every suggested key in one run, each bounded", () => {
    const suggestion = loosenSuggestion();
    const next = evaluateAutoApply(BASE_CRITERIA, suggestion, {
      autoApplyEnabled: true,
    });
    expect(next).not.toBeNull();
    for (const [key, target] of Object.entries(suggestion.changes)) {
      const moved = (next as Record<string, number>)[key];
      const current = (BASE_CRITERIA as Record<string, number>)[key];
      const maxMove =
        AUTO_APPLY_MAX_STEP[key as keyof typeof AUTO_APPLY_MAX_STEP];
      expect(Math.abs(moved - current)).toBeLessThanOrEqual(maxMove + 1e-9);
      expect(
        Math.abs(target - moved) <= Math.abs(target - current) + 1e-9,
      ).toBe(true);
    }
  });

  it("returns null once criteria have converged on the suggestion", () => {
    const suggestion = loosenSuggestion();
    const first = evaluateAutoApply(BASE_CRITERIA, suggestion, {
      autoApplyEnabled: true,
    })!;
    // The engine's own suggestions are single-step; one run converges.
    const second = evaluateAutoApply(first, suggestion, {
      autoApplyEnabled: true,
    });
    expect(second).toBeNull();
  });

  it("respects hard schema bounds on the stepped values", () => {
    const tight = CriteriaSchema.parse({
      automationMaturityMax: 21,
      opportunityPotentialMin: 79,
      confidenceMin: 0.89,
    });
    const suggestion: CriteriaSuggestion = {
      direction: "tighten",
      observedQualifiedLeads: 100,
      targetQualifiedLeads: 20,
      changes: {
        automationMaturityMax: 10,
        opportunityPotentialMin: 90,
        confidenceMin: 1.0,
        minimumEvidenceCategories: 6,
      },
      rationale: ["synthetic"],
      autoApply: true,
    };
    const next = evaluateAutoApply(tight, suggestion, {
      autoApplyEnabled: true,
    })!;
    expect(next.automationMaturityMax).toBeGreaterThanOrEqual(0);
    expect(next.opportunityPotentialMin).toBeLessThanOrEqual(100);
    expect(next.confidenceMin).toBeLessThanOrEqual(1);
    expect(next.minimumEvidenceCategories).toBeLessThanOrEqual(6);
    // confidenceMin keeps 2-decimal precision like the engine.
    expect(Number(next.confidenceMin.toFixed(2))).toBe(next.confidenceMin);
  });

  it("returns a fully validated LeadCriteria object", () => {
    const next = evaluateAutoApply(BASE_CRITERIA, loosenSuggestion(), {
      autoApplyEnabled: true,
    });
    expect(() => CriteriaSchema.parse(next)).not.toThrow();
  });
});
