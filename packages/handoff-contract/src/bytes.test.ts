import { describe, expect, it } from "vitest";
import { truncateToByteLength, utf8ByteLength } from "./index.js";

describe("truncateToByteLength", () => {
  it("leaves short strings untouched", () => {
    expect(truncateToByteLength("hello", 600)).toBe("hello");
    expect(truncateToByteLength("", 0)).toBe("");
  });

  it("truncates ASCII at the byte limit", () => {
    expect(truncateToByteLength("abcdef", 4)).toBe("abcd");
    expect(utf8ByteLength(truncateToByteLength("abcdef", 4))).toBe(4);
  });

  it("never splits a multi-byte sequence", () => {
    // "é" is 2 bytes in UTF-8; "😀" is 4 bytes.
    const input = "aé😀b";
    expect(utf8ByteLength(input)).toBe(1 + 2 + 4 + 1);
    const cut = truncateToByteLength(input, 4);
    // 4 bytes would split "😀" (bytes 3..6), so it backs up to "aé" (3 bytes).
    expect(cut).toBe("aé");
    expect(utf8ByteLength(cut)).toBeLessThanOrEqual(4);
    // Boundary-exact cut keeps the full character.
    expect(truncateToByteLength(input, 7)).toBe("aé😀");
  });

  it("returns an empty string when nothing fits", () => {
    expect(truncateToByteLength("é", 1)).toBe("");
  });

  it("rejects negative limits", () => {
    expect(() => truncateToByteLength("x", -1)).toThrow(RangeError);
  });

  it("round-trips through the byte budget used for evidence fields", () => {
    const evidence = "pain point: ".concat("café ".repeat(200));
    const capped = truncateToByteLength(evidence, 500);
    expect(utf8ByteLength(capped)).toBeLessThanOrEqual(500);
    // No replacement characters from a split sequence.
    expect(capped).not.toContain("�");
  });
});
