import { describe, expect, it } from "vitest";
import {
  sanitizeForJsonb,
  sanitizePayloadStrings,
} from "../api/_lib/sanitize";
import { truncateChars } from "../api/_lib/collection";

describe("sanitizeForJsonb", () => {
  it("strips NUL characters", () => {
    expect(sanitizeForJsonb("a\u0000b\u0000")).toBe("ab");
  });

  it("replaces a lone high surrogate with U+FFFD", () => {
    expect(sanitizeForJsonb("x\uD83Dy")).toBe("x\uFFFDy");
  });

  it("replaces a lone low surrogate with U+FFFD", () => {
    expect(sanitizeForJsonb("x\uDE00y")).toBe("x\uFFFDy");
  });

  it("preserves valid surrogate pairs (astral characters)", () => {
    expect(sanitizeForJsonb("book 😀 now")).toBe("book 😀 now");
  });

  it("leaves ordinary text untouched", () => {
    const text = "Bathurst Dental — Toronto, café, 日本語";
    expect(sanitizeForJsonb(text)).toBe(text);
  });
});

describe("sanitizePayloadStrings at the persist boundary", () => {
  it("produces a payload whose JSON has no jsonb-illegal escapes", () => {
    const payload = {
      evidence: {
        extracted_title: "Clinic\u0000",
        extracted_text: `careers 😀 page${"a".repeat(10)}\uD83D`,
      },
      signals: [{ code: "hiring", excerpt: "we\u0000hire \uDE00" }],
      score: { opportunityScore: 57 },
      organization: { name: "Clinic\uD83D" },
      missing: null,
    };
    const json = JSON.stringify(sanitizePayloadStrings(payload));
    // The two escape classes PostgreSQL jsonb rejects outright.
    expect(json).not.toContain("\\u0000");
    expect(json).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    // And the sanitized payload round-trips intact.
    const parsed = JSON.parse(json) as typeof payload;
    expect(parsed.evidence.extracted_title).toBe("Clinic");
    expect(parsed.signals[0].excerpt).toBe("wehire \uFFFD");
    expect(parsed.score.opportunityScore).toBe(57);
    expect(parsed.missing).toBeNull();
  });

  it("sanitizes object keys as well as values", () => {
    const payload = { ["bad\u0000key"]: "ok", ["lone\uD83D"]: 1 };
    const json = JSON.stringify(sanitizePayloadStrings(payload));
    expect(json).not.toContain("\\u0000");
    expect(json).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed["badkey"]).toBe("ok");
  });
});

describe("truncateChars", () => {
  it("never splits a surrogate pair at the cut", () => {
    const text = `${"a".repeat(2999)}😀${"b".repeat(10)}`;
    const out = truncateChars(text, 3000);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("\uD83D\uFFFD");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });

  it("returns short text unchanged", () => {
    expect(truncateChars("short", 3000)).toBe("short");
  });
});
