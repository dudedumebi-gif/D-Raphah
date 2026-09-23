import { afterEach, describe, expect, it } from "vitest";
import {
  generateSigningKeyPair,
  loadKeysFromEnv,
  signPackage,
  verifyPackage,
} from "./index.js";

const samplePackage = {
  schemaVersion: "1.0.0",
  packageId: "11111111-1111-1111-1111-111111111111",
  packageVersion: 1,
  organization: { name: "Acme" },
  manifestChecksum: "pending",
};

afterEach(() => {
  delete process.env.TEST_KEYS_PRIVATE_KEY_PEM;
  delete process.env.TEST_KEYS_PUBLIC_KEY_PEM;
});

describe("Ed25519 package signing", () => {
  it("generates a PEM-encoded Ed25519 key pair", () => {
    const keys = generateSigningKeyPair();
    expect(keys.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(keys.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });

  it("signs and verifies a round trip", () => {
    const keys = generateSigningKeyPair();
    const { manifestChecksum, signature } = signPackage(
      samplePackage,
      keys.privateKeyPem,
    );
    expect(manifestChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(signature.length).toBeGreaterThan(0);
    expect(
      verifyPackage(samplePackage, manifestChecksum, signature, keys.publicKeyPem),
    ).toBe(true);
  });

  it("fails verification on a tampered payload", () => {
    const keys = generateSigningKeyPair();
    const { manifestChecksum, signature } = signPackage(
      samplePackage,
      keys.privateKeyPem,
    );
    const tampered = { ...samplePackage, packageVersion: 999 };
    expect(
      verifyPackage(tampered, manifestChecksum, signature, keys.publicKeyPem),
    ).toBe(false);
  });

  it("fails verification with the wrong public key", () => {
    const signer = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const { manifestChecksum, signature } = signPackage(
      samplePackage,
      signer.privateKeyPem,
    );
    expect(
      verifyPackage(samplePackage, manifestChecksum, signature, other.publicKeyPem),
    ).toBe(false);
  });

  it("fails verification on a checksum mismatch", () => {
    const keys = generateSigningKeyPair();
    const { signature } = signPackage(samplePackage, keys.privateKeyPem);
    expect(
      verifyPackage(samplePackage, "0".repeat(64), signature, keys.publicKeyPem),
    ).toBe(false);
  });

  it("throws only on programmer errors", () => {
    const keys = generateSigningKeyPair();
    const { manifestChecksum, signature } = signPackage(
      samplePackage,
      keys.privateKeyPem,
    );
    expect(() => signPackage(samplePackage, "")).toThrow(TypeError);
    expect(() =>
      verifyPackage(samplePackage, manifestChecksum, signature, ""),
    ).toThrow(TypeError);
    // Malformed-but-string inputs are data problems: false, not throw.
    expect(
      verifyPackage(samplePackage, manifestChecksum, "!!!", keys.publicKeyPem),
    ).toBe(false);
  });
});

describe("loadKeysFromEnv", () => {
  it("reads the private and public PEMs from the prefixed env vars", () => {
    const keys = generateSigningKeyPair();
    process.env.TEST_KEYS_PRIVATE_KEY_PEM = keys.privateKeyPem;
    process.env.TEST_KEYS_PUBLIC_KEY_PEM = keys.publicKeyPem;
    expect(loadKeysFromEnv("TEST_KEYS")).toEqual(keys);
  });

  it("converts literal backslash-n sequences to newlines", () => {
    const keys = generateSigningKeyPair();
    process.env.TEST_KEYS_PRIVATE_KEY_PEM = keys.privateKeyPem.replace(
      /\n/g,
      "\\n",
    );
    process.env.TEST_KEYS_PUBLIC_KEY_PEM = keys.publicKeyPem;
    const loaded = loadKeysFromEnv("TEST_KEYS");
    expect(loaded.privateKeyPem).toBe(keys.privateKeyPem);
    const { manifestChecksum, signature } = signPackage(
      samplePackage,
      loaded.privateKeyPem,
    );
    expect(
      verifyPackage(samplePackage, manifestChecksum, signature, loaded.publicKeyPem),
    ).toBe(true);
  });

  it("throws when key material is missing", () => {
    expect(() => loadKeysFromEnv("TEST_KEYS")).toThrow(/TEST_KEYS/);
  });
});
