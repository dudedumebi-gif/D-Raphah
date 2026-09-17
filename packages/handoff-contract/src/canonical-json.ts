import { createHash } from "node:crypto";

/**
 * Produces deterministic JSON for contract payloads. Object keys are sorted,
 * undefined object properties are omitted, and non-finite numbers are rejected.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        "Canonical JSON does not support non-finite numbers.",
      );
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(",")}]`;
  }

  if (typeof value !== "object") {
    throw new TypeError(
      `Canonical JSON does not support values of type ${typeof value}.`,
    );
  }

  const record = value as Record<string, unknown>;
  const properties = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`,
    );

  return `{${properties.join(",")}}`;
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJsonStringify(value), "utf8")
    .digest("hex");
}

export function verifyCanonicalSha256(
  value: unknown,
  expectedHash: string,
): boolean {
  return (
    /^[a-f0-9]{64}$/.test(expectedHash) &&
    sha256CanonicalJson(value) === expectedHash
  );
}
