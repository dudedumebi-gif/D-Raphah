import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleIntake } from "../api/_lib/verify.js";
import { FakeDeliveryDb } from "./fake-db.js";
import { intakeRequest, signTestPackage, testEnv } from "./helpers.js";

/**
 * Intake -> workflow trigger wiring (handoff gap 2): a freshly-accepted
 * handoff invokes the onHandoffAccepted hook exactly once; idempotent
 * replays never re-execute; a hook failure is fed back as
 * delivery.handoff.trigger_failed and the intake still returns 201.
 */
describe("POST /api/intake lead_handoff triggers", () => {
  it("invokes onHandoffAccepted once on a fresh 201 accept", async () => {
    const db = new FakeDeliveryDb();
    const signed = signTestPackage();
    const key = `key-${randomUUID()}`;
    const seen: string[] = [];

    const result = await handleIntake(
      intakeRequest(signed, { "idempotency-key": key }),
      db,
      testEnv(),
      {
        onHandoffAccepted: async (pkg) => {
          seen.push(pkg.packageId);
        },
      },
    );

    expect(result.status).toBe(201);
    expect(seen).toEqual([signed.pkg.packageId]);
  });

  it("does not re-execute workflows on an idempotent replay", async () => {
    const db = new FakeDeliveryDb();
    const signed = signTestPackage();
    const key = `key-${randomUUID()}`;
    let calls = 0;
    const hooks = {
      onHandoffAccepted: async () => {
        calls += 1;
      },
    };

    const first = await handleIntake(
      intakeRequest(signed, { "idempotency-key": key }),
      db,
      testEnv(),
      hooks,
    );
    expect(first.status).toBe(201);

    const replay = await handleIntake(
      intakeRequest(signed, { "idempotency-key": key }),
      db,
      testEnv(),
      hooks,
    );
    expect(replay.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("still returns 201 and feeds back trigger_failed when the hook throws", async () => {
    const db = new FakeDeliveryDb();
    const signed = signTestPackage();
    const key = `key-${randomUUID()}`;

    const result = await handleIntake(
      intakeRequest(signed, { "idempotency-key": key }),
      db,
      testEnv(),
      {
        onHandoffAccepted: async () => {
          throw new Error("workflow engine unavailable");
        },
      },
    );

    expect(result.status).toBe(201);
    const projectId = (result.body as { projectId: string }).projectId;
    const failed = db.events.find(
      (e) =>
        (e.event as { eventType: string }).eventType ===
        "delivery.handoff.trigger_failed",
    );
    expect(failed).toBeTruthy();
    expect(failed?.projectId).toBe(projectId);
    expect(
      (failed?.event as { details: { error: string } }).details.error,
    ).toContain("workflow engine unavailable");
    // The acceptance itself was still recorded.
    expect(
      db.events.some(
        (e) =>
          (e.event as { eventType: string }).eventType ===
          "delivery.handoff.accepted",
      ),
    ).toBe(true);
  });

  it("records no trigger_failed event when the hook succeeds", async () => {
    const db = new FakeDeliveryDb();
    const signed = signTestPackage();

    const result = await handleIntake(
      intakeRequest(signed, { "idempotency-key": `key-${randomUUID()}` }),
      db,
      testEnv(),
      { onHandoffAccepted: async () => {} },
    );

    expect(result.status).toBe(201);
    expect(
      db.events.some(
        (e) =>
          (e.event as { eventType: string }).eventType ===
          "delivery.handoff.trigger_failed",
      ),
    ).toBe(false);
  });
});
