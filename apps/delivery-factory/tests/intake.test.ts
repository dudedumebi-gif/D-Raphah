import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, afterEach } from "vitest";
import { canonicalJsonStringify } from "@raphah/handoff-contract";
import { handleIntake, readIntakeEnv } from "../api/_lib/verify.js";
import { FakeDeliveryDb } from "./fake-db.js";
import {
  intakeRequest,
  otherKeys,
  packageBase,
  senderKeys,
  signTestPackage,
  testEnv,
  validRequirement,
} from "./helpers.js";

describe("POST /api/intake", () => {
  it("accepts a valid intake with 201, then replays the same key with 200", async () => {
    const db = new FakeDeliveryDb();
    const env = testEnv();
    const signed = signTestPackage();
    const key = `key-${randomUUID()}`;

    const first = await handleIntake(
      intakeRequest(signed, { "idempotency-key": key }),
      db,
      env,
    );
    expect(first.status).toBe(201);
    const projectId = (first.body as { projectId: string }).projectId;
    expect(projectId).toBeTruthy();

    // Same key, identical body, fresh nonce/timestamp: idempotent replay.
    const replay = await handleIntake(
      intakeRequest(signed, { "idempotency-key": key }),
      db,
      env,
    );
    expect(replay.status).toBe(200);
    expect((replay.body as { projectId: string }).projectId).toBe(projectId);
    expect(db.inboxCount()).toBe(1);

    // The acceptance was recorded as a feedback event.
    const accepted = db.events.find(
      (e) =>
        (e.event as { eventType: string }).eventType ===
        "delivery.handoff.accepted",
    );
    expect(accepted?.projectId).toBe(projectId);
  });

  it("rejects a tampered payload with a previously-seen idempotency key with 401, not 200", async () => {
    const db = new FakeDeliveryDb();
    const env = testEnv();
    const signed = signTestPackage();
    const key = `key-${randomUUID()}`;
    await handleIntake(intakeRequest(signed, { "idempotency-key": key }), db, env);

    // Attacker replays the seen key with a modified body. The signature was
    // computed over the original canonical bytes, so verification fails and
    // the request must be rejected BEFORE the idempotency lookup.
    const tamperedPkg = {
      ...signed.pkg,
      problemStatement: "Tampered: wire the funds elsewhere.",
    };
    const tamperedBody = canonicalJsonStringify(tamperedPkg);
    const tampered = await handleIntake(
      {
        method: "POST",
        origin: null,
        headers: {
          "content-type": "application/json",
          "x-raphah-signature": signed.signature,
          "x-raphah-timestamp": new Date().toISOString(),
          "x-raphah-nonce": randomUUID(),
          "idempotency-key": key,
          "content-sha256": createHash("sha256")
            .update(tamperedBody, "utf8")
            .digest("hex"),
        },
        rawBody: tamperedBody,
      },
      db,
      env,
    );
    expect(tampered.status).toBe(401);
    expect(db.inboxCount()).toBe(1);
  });

  it("rejects a bad signature with 401 and changes no state", async () => {
    const db = new FakeDeliveryDb();
    const signed = signTestPackage(packageBase(), otherKeys.privateKeyPem);
    const result = await handleIntake(intakeRequest(signed), db, testEnv());
    expect(result.status).toBe(401);
    expect(db.inboxCount()).toBe(0);
  });

  it("rejects a checksum mismatch with 401", async () => {
    const db = new FakeDeliveryDb();
    const signed = signTestPackage();
    const pkg = { ...signed.pkg, manifestChecksum: "0".repeat(64) };
    const rawBody = canonicalJsonStringify(pkg);
    const result = await handleIntake(
      {
        method: "POST",
        origin: null,
        headers: {
          "content-type": "application/json",
          "x-raphah-signature": signed.signature,
          "x-raphah-timestamp": new Date().toISOString(),
          "x-raphah-nonce": randomUUID(),
          "idempotency-key": `key-${randomUUID()}`,
          "content-sha256": createHash("sha256")
            .update(rawBody, "utf8")
            .digest("hex"),
        },
        rawBody,
      },
      db,
      testEnv(),
    );
    expect(result.status).toBe(401);
    expect(db.inboxCount()).toBe(0);
  });

  it("rejects an expired timestamp with 401", async () => {
    const db = new FakeDeliveryDb();
    const signed = signTestPackage();
    const result = await handleIntake(
      intakeRequest(signed, {
        "x-raphah-timestamp": new Date(Date.now() - 10 * 60_000).toISOString(),
      }),
      db,
      testEnv(),
    );
    expect(result.status).toBe(401);
    expect(db.inboxCount()).toBe(0);
  });

  it("rejects a future timestamp with 401", async () => {
    const db = new FakeDeliveryDb();
    const signed = signTestPackage();
    const result = await handleIntake(
      intakeRequest(signed, {
        "x-raphah-timestamp": new Date(Date.now() + 10 * 60_000).toISOString(),
      }),
      db,
      testEnv(),
    );
    expect(result.status).toBe(401);
  });

  it("rejects a replayed nonce with 401", async () => {
    const db = new FakeDeliveryDb();
    const env = testEnv();
    const signed = signTestPackage();
    const nonce = randomUUID();
    const key = `key-${randomUUID()}`;
    const first = await handleIntake(
      intakeRequest(signed, { "idempotency-key": key, "x-raphah-nonce": nonce }),
      db,
      env,
    );
    expect(first.status).toBe(201);

    const replay = await handleIntake(
      intakeRequest(signTestPackage(), {
        "idempotency-key": `key-${randomUUID()}`,
        "x-raphah-nonce": nonce,
      }),
      db,
      env,
    );
    expect(replay.status).toBe(401);
  });

  it("rejects a content-sha256 mismatch with 401", async () => {
    const db = new FakeDeliveryDb();
    const signed = signTestPackage();
    const result = await handleIntake(
      intakeRequest(signed, { "content-sha256": "0".repeat(64) }),
      db,
      testEnv(),
    );
    expect(result.status).toBe(401);
    expect(db.inboxCount()).toBe(0);
  });

  it("rejects missing auth headers with 401", async () => {
    const db = new FakeDeliveryDb();
    const signed = signTestPackage();
    const request = intakeRequest(signed);
    delete request.headers["x-raphah-signature"];
    const result = await handleIntake(request, db, testEnv());
    expect(result.status).toBe(401);
  });

  it("rejects a contract-invalid package with 400", async () => {
    const db = new FakeDeliveryDb();
    // Sign an object that fails Zod (problemStatement too short). The
    // signature is valid so verification passes and schema validation runs.
    const base = packageBase({ problemStatement: "short" });
    const signed = signTestPackage(base);
    const result = await handleIntake(intakeRequest(signed), db, testEnv());
    expect(result.status).toBe(400);
    expect(db.inboxCount()).toBe(0);
  });

  it("rejects an empty requirement baseline with 422", async () => {
    const db = new FakeDeliveryDb();
    const env = testEnv();
    const base = packageBase({
      requirementBaseline: { version: 1, requirements: [], features: [] },
    });
    const result = await handleIntake(intakeRequest(signTestPackage(base)), db, env);
    expect(result.status).toBe(422);
    expect(
      (result.body as { rejectionReasons: Array<{ code: string }> })
        .rejectionReasons[0].code,
    ).toBe("EMPTY_REQUIREMENTS");
    expect(db.inboxCount()).toBe(0);
    const rejected = db.events.find(
      (e) =>
        (e.event as { eventType: string }).eventType ===
        "delivery.handoff.rejected",
    );
    expect(rejected?.projectId).toBeNull();
  });

  it("rejects a Must requirement with blocking questions with 422", async () => {
    const db = new FakeDeliveryDb();
    const base = packageBase({
      requirementBaseline: {
        version: 1,
        requirements: [
          validRequirement({ blockingQuestions: ["Who signs off?"] }),
        ],
        features: [],
      },
    });
    const result = await handleIntake(
      intakeRequest(signTestPackage(base)),
      db,
      testEnv(),
    );
    expect(result.status).toBe(422);
    const codes = (
      result.body as { rejectionReasons: Array<{ code: string }> }
    ).rejectionReasons.map((r) => r.code);
    expect(codes).toContain("MUST_REQUIREMENT_BLOCKED");
  });

  it("treats a Must requirement without a human validator as unvalidated (422)", async () => {
    const db = new FakeDeliveryDb();
    const requirement = validRequirement();
    delete requirement.humanValidatorId;
    const base = packageBase({
      requirementBaseline: { version: 1, requirements: [requirement], features: [] },
    });
    const result = await handleIntake(
      intakeRequest(signTestPackage(base)),
      db,
      testEnv(),
    );
    expect(result.status).toBe(422);
    const codes = (
      result.body as { rejectionReasons: Array<{ code: string }> }
    ).rejectionReasons.map((r) => r.code);
    expect(codes).toContain("MUST_REQUIREMENT_UNVALIDATED");
  });

  it("rejects a non-validated Must requirement with 422", async () => {
    const db = new FakeDeliveryDb();
    const base = packageBase({
      requirementBaseline: {
        version: 1,
        requirements: [validRequirement({ status: "proposed" })],
        features: [],
      },
    });
    const result = await handleIntake(
      intakeRequest(signTestPackage(base)),
      db,
      testEnv(),
    );
    expect(result.status).toBe(422);
  });

  it("does not let should/could requirements block the freeze", async () => {
    const db = new FakeDeliveryDb();
    const requirement = validRequirement();
    delete requirement.humanValidatorId;
    const base = packageBase({
      requirementBaseline: {
        version: 1,
        requirements: [
          validRequirement(),
          { ...requirement, priority: "should", status: "draft" },
        ],
        features: [],
      },
    });
    const result = await handleIntake(
      intakeRequest(signTestPackage(base)),
      db,
      testEnv(),
    );
    expect(result.status).toBe(201);
  });

  it("denies origins outside the allowlist with 403 and allows listed origins", async () => {
    const db = new FakeDeliveryDb();
    const env = testEnv();
    const signed = signTestPackage();

    const denied = await handleIntake(
      intakeRequest(signed, {}, "https://evil.example"),
      db,
      env,
    );
    expect(denied.status).toBe(403);

    const key = `key-${randomUUID()}`;
    const allowed = await handleIntake(
      intakeRequest(signed, { "idempotency-key": key }, "https://ops.raphah.io"),
      db,
      env,
    );
    expect(allowed.status).toBe(201);
    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "https://ops.raphah.io",
    );
  });

  it("rejects non-POST methods with 405", async () => {
    const db = new FakeDeliveryDb();
    const signed = signTestPackage();
    const request = intakeRequest(signed);
    request.method = "GET";
    const result = await handleIntake(request, db, testEnv());
    expect(result.status).toBe(405);
  });
});

describe("readIntakeEnv", () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("converts literal \\n sequences in the PEM to real newlines", () => {
    // Vercel stores PEM blocks with literal backslash-n sequences.
    const escaped = senderKeys.publicKeyPem.replace(/\n/g, "\\n");
    expect(escaped).not.toContain("\n");
    process.env.LEAD_ENGINE_PUBLIC_KEY_PEM = escaped;
    const env = readIntakeEnv();
    expect(env.publicKeyPem).toBe(senderKeys.publicKeyPem);
    expect(env.publicKeyPem).toContain("\n");
  });

  it("leaves PEMs that already contain real newlines untouched", () => {
    process.env.LEAD_ENGINE_PUBLIC_KEY_PEM = senderKeys.publicKeyPem;
    const env = readIntakeEnv();
    expect(env.publicKeyPem).toBe(senderKeys.publicKeyPem);
  });

  it("throws when the public key is missing", () => {
    delete process.env.LEAD_ENGINE_PUBLIC_KEY_PEM;
    expect(() => readIntakeEnv()).toThrow(
      "Missing LEAD_ENGINE_PUBLIC_KEY_PEM environment variable",
    );
  });
});
