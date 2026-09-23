import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleIntake } from "../api/_lib/verify.js";
import { FakeDeliveryDb } from "./fake-db.js";
import { intakeRequest, signTestPackage, testEnv } from "./helpers.js";

describe("getMonitoringSnapshot", () => {
  it("returns recent handoffs, outbox counts, and nonce state", async () => {
    const db = new FakeDeliveryDb();
    const env = testEnv();
    const key = `key-${randomUUID()}`;
    const result = await handleIntake(
      intakeRequest(signTestPackage(), { "idempotency-key": key }),
      db,
      env,
    );
    expect(result.status).toBe(201);
    const projectId = (result.body as { projectId: string }).projectId;

    const snapshot = await db.getMonitoringSnapshot();
    expect(snapshot.recentHandoffs).toHaveLength(1);
    const handoff = snapshot.recentHandoffs[0];
    expect(handoff.idempotencyKey).toBe(key);
    expect(handoff.projectId).toBe(projectId);
    expect(handoff.organizationName).toBeTruthy();
    expect(handoff.packageId).toBeTruthy();
    // The acceptance enqueued one feedback event.
    expect(snapshot.feedbackOutbox.pending).toBe(1);
    expect(snapshot.activeNonces).toBe(1);
  });

  it("returns empty collections when nothing has been received", async () => {
    const db = new FakeDeliveryDb();
    const snapshot = await db.getMonitoringSnapshot();
    expect(snapshot.recentHandoffs).toHaveLength(0);
    expect(snapshot.feedbackOutbox).toEqual({
      pending: 0,
      dispatching: 0,
      failed: 0,
      sent: 0,
    });
    expect(snapshot.activeNonces).toBe(0);
  });
});
