import {
  generateKeyPairSync,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "./canonical-json.js";

export const RaphahIntegrationHeaders = {
  authorization: "authorization",
  contentType: "content-type",
  idempotencyKey: "idempotency-key",
  timestamp: "x-raphah-timestamp",
  nonce: "x-raphah-nonce",
  correlationId: "x-correlation-id",
  contentSha256: "x-content-sha256",
} as const;

export const RaphahIntegrationScopes = {
  createHandoff: "handoff:create",
  createFeedback: "feedback:create",
} as const;

export interface SigningKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface SignedPackage {
  manifestChecksum: string;
  signature: string;
}

/**
 * Generates a fresh Ed25519 key pair for signing integration packages.
 * The private key stays with the sender; the public key is distributed to
 * every verifier out of band (never inside the package itself).
 */
export function generateSigningKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

/**
 * Canonicalizes a package, computes its SHA-256 manifest checksum over the
 * canonical bytes, and Ed25519-signs those same bytes with the sender's
 * private key. Returns the hex checksum and the base64 signature.
 *
 * Throws on programmer errors (e.g. invalid key material or a value that
 * cannot be canonicalized); never on caller data problems.
 */
export function signPackage(
  packageObject: unknown,
  privateKeyPem: string,
): SignedPackage {
  if (typeof privateKeyPem !== "string" || privateKeyPem.length === 0) {
    throw new TypeError("signPackage requires a PEM-encoded private key.");
  }
  const canonicalBytes = Buffer.from(canonicalJsonStringify(packageObject), "utf8");
  const manifestChecksum = sha256CanonicalJson(packageObject);
  const signature = sign(null, canonicalBytes, {
    key: privateKeyPem,
    format: "pem",
    type: "pkcs8",
  });
  return { manifestChecksum, signature: signature.toString("base64") };
}

/**
 * Verifies a package against its manifest checksum and Ed25519 signature.
 * Returns true only when both checks pass. Returns false on tampered payloads,
 * mismatched checksums, bad signatures, or a wrong public key. Throws only on
 * programmer errors (e.g. missing or malformed key material).
 */
export function verifyPackage(
  packageObject: unknown,
  manifestChecksum: string,
  signature: string,
  publicKeyPem: string,
): boolean {
  if (typeof publicKeyPem !== "string" || publicKeyPem.length === 0) {
    throw new TypeError("verifyPackage requires a PEM-encoded public key.");
  }
  if (typeof manifestChecksum !== "string" || typeof signature !== "string") {
    return false;
  }
  const recomputed = Buffer.from(sha256CanonicalJson(packageObject), "utf8");
  const claimed = Buffer.from(manifestChecksum, "utf8");
  if (claimed.length !== recomputed.length) return false;
  if (!timingSafeEqual(claimed, recomputed)) return false;

  const canonicalBytes = Buffer.from(canonicalJsonStringify(packageObject), "utf8");
  const signatureBytes = Buffer.from(signature, "base64");
  return verify(null, canonicalBytes, { key: publicKeyPem }, signatureBytes);
}

/**
 * Loads an Ed25519 key pair from environment variables:
 * `<PREFIX>_PRIVATE_KEY_PEM` and `<PREFIX>_PUBLIC_KEY_PEM`.
 * Literal "\n" sequences are converted to real newlines so PEM blocks survive
 * single-line env values. Throws when either variable is missing.
 */
export function loadKeysFromEnv(prefix: string): SigningKeyPair {
  const normalize = (value: string | undefined): string =>
    value && !value.includes("\n") ? value.replace(/\\n/g, "\n") : (value ?? "");
  const privateKeyPem = normalize(process.env[`${prefix}_PRIVATE_KEY_PEM`]);
  const publicKeyPem = normalize(process.env[`${prefix}_PUBLIC_KEY_PEM`]);
  if (!privateKeyPem || !publicKeyPem) {
    throw new Error(
      `Missing signing key material: expected ${prefix}_PRIVATE_KEY_PEM and ${prefix}_PUBLIC_KEY_PEM to be set.`,
    );
  }
  return { publicKeyPem, privateKeyPem };
}
