import { randomUUID } from "node:crypto";
import {
  generateSigningKeyPair,
  sha256CanonicalJson,
  verifyPackage,
  type DeliveryFeedbackEventV1,
} from "@raphah/handoff-contract";
import { describe, expect, it, vi } from "vitest";
import {
  bearerMatches,
  buildSignedFeedbackEnvelope,
  dispatchDueFeedback,
  feedbackBackoffMs,
  MAX_FEEDBACK_ATTEMPTS,
  type ClaimedFeedbackRow,
  type FeedbackOutboxStore,
  type FeedbackPostResult,
} from "../api/_lib/feedback-dispatch";

const keys = generateSigningKeyPair();
const OPPORTUNITY_ID = "11111111-1111-4111-8111-111111111111";
const PACKAGE_ID = "33333333-3333-4333-8333-333333333333";

function buildEvent(): DeliveryFeedbackEventV1 {
  const base = {
    eventId: randomUUID(),
    eventType: "delivery.handoff.accepted" as const,
    schemaVersion: "1.0.0" as const,
    occurredAt: new Date().toISOString(),
    producer: "delivery-factory" as const,
    environment: "test" as const,
    correlationId: PACKAGE_ID,
    packageId: PACKAGE_ID,
    packageVersion: 1,
    opportunityId: OPPORTUNITY_ID,
    details: { idempotencyKey: "intake-123" },
  };
  return { ...base, manifestChecksum: sha256CanonicalJson(base) };
}

function makeStore(rows: ClaimedFeedbackRow[] = []): FeedbackOutboxStore & {
  sent: string[];
  failed: string[];
  rescheduled: Array<{ id: string; at: Date }>;
} {
  const sent: string[] = [];
  const failed: string[] = [];
  const rescheduled: Array<{ id: string; at: Date }> = [];
  return {
    sent,
    failed,
    rescheduled,
    async claimDue() {
      return rows;
    },
    async markSent(id: string) {
      sent.push(id);
    },
    async markFailed(id: string) {
      failed.push(id);
    },
    async reschedule(id: string, at: Date) {
      rescheduled.push({ id, at });
    },
  };
}

const env = {
  leadEngineBaseUrl: "https://lead-engine.example",
  signingPrivateKeyPem: keys.privateKeyPem,
};

function row(event: unknown = buildEvent(), attempts = 1): ClaimedFeedbackRow {
  return { id: randomUUID(), event, attempts };
}

describe("feedback envelope", () => {
  it("signs an envelope the Lead Engine can verify", () => {
    const envelope = buildSignedFeedbackEnvelope(buildEvent(), keys.privateKeyPem);
    expect(typeof envelope.signature).toBe("string");
    const { signature, ...body } = envelope as {
      signature: string;
      event: unknown;
      nonce: string;
      issuedAt: string;
    };
    const checksum = sha256CanonicalJson(body);
    expect(verifyPackage(body, checksum, signature, keys.publicKeyPem)).toBe(
      true,
    );
    expect(
      verifyPackage(body, checksum, signature, generateSigningKeyPair().publicKeyPem),
    ).toBe(false);
  });

  it("rejects a schema-invalid event before signing", () => {
    expect(() =>
      buildSignedFeedbackEnvelope({ nope: true }, keys.privateKeyPem),
    ).toThrow();
  });
});

describe("dispatchDueFeedback", () => {
  it("marks 201 responses sent", async () => {
    const store = makeStore([row()]);
    const post = async (): Promise<FeedbackPostResult> => ({
      status: 201,
      body: { status: "received" },
    });
    const summary = await dispatchDueFeedback({ store, env, post });
    expect(summary).toMatchObject({ claimed: 1, sent: 1 });
    expect(store.sent).toHaveLength(1);
  });

  it("treats a duplicate acknowledgement as sent", async () => {
    const store = makeStore([row()]);
    const post = async (): Promise<FeedbackPostResult> => ({
      status: 200,
      body: { status: "duplicate" },
    });
    const summary = await dispatchDueFeedback({ store, env, post });
    expect(summary.sent).toBe(1);
    expect(store.sent).toHaveLength(1);
  });

  it("fails terminally on 400/401/409/422", async () => {
    for (const status of [400, 401, 409, 422]) {
      const store = makeStore([row()]);
      const post = async (): Promise<FeedbackPostResult> => ({
        status,
        body: { error: "bad" },
      });
      const summary = await dispatchDueFeedback({ store, env, post });
      expect(summary.failed).toBe(1);
      expect(store.failed).toHaveLength(1);
      expect(store.rescheduled).toHaveLength(0);
    }
  });

  it("reschedules on 500 and network errors with future backoff", async () => {
    const now = new Date("2026-09-23T15:00:00.000Z");
    for (const post of [
      async (): Promise<FeedbackPostResult> => ({ status: 500, body: null }),
      async (): Promise<FeedbackPostResult> => {
        throw new Error("socket hangup");
      },
    ]) {
      const store = makeStore([row()]);
      const summary = await dispatchDueFeedback({ store, env, post, now });
      expect(summary.rescheduled).toBe(1);
      expect(store.rescheduled).toHaveLength(1);
      expect(store.rescheduled[0].at.getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it("fails after the maximum attempt count", async () => {
    const store = makeStore([row(buildEvent(), MAX_FEEDBACK_ATTEMPTS)]);
    const post = async (): Promise<FeedbackPostResult> => ({
      status: 503,
      body: null,
    });
    const summary = await dispatchDueFeedback({ store, env, post });
    expect(summary.failed).toBe(1);
    expect(store.failed).toHaveLength(1);
    expect(store.rescheduled).toHaveLength(0);
  });

  it("fails poison payloads that cannot be signed", async () => {
    const store = makeStore([row({ nope: true })]);
    const post = vi.fn();
    const summary = await dispatchDueFeedback({ store, env, post });
    expect(summary.failed).toBe(1);
    expect(post).not.toHaveBeenCalled();
  });

  it("posts to the Lead Engine feedback endpoint", async () => {
    const store = makeStore([row()]);
    const seen: string[] = [];
    const post = async (
      url: string,
    ): Promise<FeedbackPostResult> => {
      seen.push(url);
      return { status: 201, body: {} };
    };
    await dispatchDueFeedback({ store, env, post });
    expect(seen).toEqual(["https://lead-engine.example/api/v1/feedback/events"]);
  });
});

describe("feedbackBackoffMs", () => {
  it("stays within 50%-100% of the capped exponential delay", () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const capped = Math.min(2 ** attempt * 60_000, 6 * 3_600_000);
      for (let i = 0; i < 20; i++) {
        const delay = feedbackBackoffMs(attempt);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(capped * 0.5));
        expect(delay).toBeLessThanOrEqual(capped);
      }
    }
  });
});

describe("bearerMatches", () => {
  it("accepts the exact secret and rejects anything else", () => {
    expect(bearerMatches("Bearer s3cr3t", "s3cr3t")).toBe(true);
    expect(bearerMatches("Bearer wrong", "s3cr3t")).toBe(false);
    expect(bearerMatches("Bearer s3cr3", "s3cr3t")).toBe(false);
    expect(bearerMatches(undefined, "s3cr3t")).toBe(false);
    expect(bearerMatches("Basic c2VjcmV0", "s3cr3t")).toBe(false);
  });
});
