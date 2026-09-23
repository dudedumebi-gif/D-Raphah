import { randomUUID } from "node:crypto";
import {
  generateSigningKeyPair,
  sha256CanonicalJson,
  signPackage,
  type DeliveryFeedbackEventV1,
} from "@raphah/handoff-contract";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ingestDeliveryFeedback,
  type FeedbackEnvelope,
} from "../api/_lib/feedback";
import type { SqlClient } from "../api/_lib/handoff";

const keys = generateSigningKeyPair();
const otherKeys = generateSigningKeyPair();

const OPPORTUNITY_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const PACKAGE_ID = "33333333-3333-4333-8333-333333333333";

function buildEvent(
  overrides: Partial<DeliveryFeedbackEventV1> = {},
): DeliveryFeedbackEventV1 {
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
  return {
    ...base,
    manifestChecksum: sha256CanonicalJson(base),
    ...overrides,
  };
}

function signEnvelope(
  event: DeliveryFeedbackEventV1,
  privateKeyPem: string = keys.privateKeyPem,
  overrides: Partial<Pick<FeedbackEnvelope, "nonce" | "issuedAt">> = {},
): FeedbackEnvelope {
  const body = {
    event,
    nonce: randomUUID(),
    issuedAt: new Date().toISOString(),
    ...overrides,
  };
  const { signature } = signPackage(body, privateKeyPem);
  return { ...body, signature };
}

function uniqueViolation(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: "23505",
  });
}

function makeDb(options: { opportunity?: boolean } = {}): {
  client: SqlClient;
  inserts: unknown[][];
} {
  const nonces = new Set<string>();
  const events = new Set<string>();
  const inserts: unknown[][] = [];
  const client = (async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = strings.join(" ");
    if (sql.includes("insert into public.feedback_nonces")) {
      const nonce = values[0] as string;
      if (nonces.has(nonce)) throw uniqueViolation();
      nonces.add(nonce);
      return [];
    }
    if (sql.includes("from public.feedback_nonces")) return [];
    if (sql.includes("from public.opportunities")) {
      return options.opportunity === false
        ? []
        : [{ id: OPPORTUNITY_ID, workspace_id: WORKSPACE_ID }];
    }
    if (sql.includes("insert into public.delivery_feedback_events")) {
      const eventId = values[0] as string;
      if (events.has(eventId)) throw uniqueViolation();
      events.add(eventId);
      inserts.push(values);
      return [];
    }
    throw new Error(`Unexpected query: ${sql.slice(0, 100)}`);
  }) as SqlClient;
  return { client, inserts };
}

beforeEach(() => {
  process.env.DELIVERY_FACTORY_PUBLIC_KEY_PEM = keys.publicKeyPem;
});

describe("delivery feedback ingestion", () => {
  it("accepts a valid signed envelope and stores the event", async () => {
    const { client, inserts } = makeDb();
    const envelope = signEnvelope(buildEvent());
    const result = await ingestDeliveryFeedback(envelope, client);
    expect(result.status).toBe("received");
    expect(result.eventId).toBe(envelope.event.eventId);
    expect(inserts).toHaveLength(1);
    // workspace_id resolved from the opportunity, not trusted from the envelope
    expect(inserts[0][1]).toBe(WORKSPACE_ID);
  });

  it("rejects an envelope signed with the wrong key", async () => {
    const { client } = makeDb();
    const envelope = signEnvelope(buildEvent(), otherKeys.privateKeyPem);
    await expect(ingestDeliveryFeedback(envelope, client)).rejects.toMatchObject(
      { statusCode: 401 },
    );
  });

  it("rejects a stale envelope", async () => {
    const { client } = makeDb();
    const envelope = signEnvelope(buildEvent(), keys.privateKeyPem, {
      issuedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    await expect(ingestDeliveryFeedback(envelope, client)).rejects.toMatchObject(
      { statusCode: 401 },
    );
  });

  it("rejects an event whose manifest checksum no longer matches", async () => {
    const { client } = makeDb();
    const event = buildEvent();
    // Tamper after the factory computed the checksum, then re-sign the
    // envelope so only the inner checksum check fails.
    const tampered = {
      ...event,
      details: { ...event.details, injected: true },
    };
    const envelope = signEnvelope(tampered);
    await expect(ingestDeliveryFeedback(envelope, client)).rejects.toMatchObject(
      { statusCode: 400 },
    );
  });

  it("rejects a replayed nonce", async () => {
    const { client } = makeDb();
    const envelope = signEnvelope(buildEvent());
    await ingestDeliveryFeedback(envelope, client);
    await expect(ingestDeliveryFeedback(envelope, client)).rejects.toMatchObject(
      { statusCode: 409 },
    );
  });

  it("rejects feedback for an unknown opportunity", async () => {
    const { client } = makeDb({ opportunity: false });
    const envelope = signEnvelope(buildEvent());
    await expect(ingestDeliveryFeedback(envelope, client)).rejects.toMatchObject(
      { statusCode: 422 },
    );
  });

  it("acknowledges a retried event idempotently", async () => {
    const { client, inserts } = makeDb();
    const event = buildEvent();
    const first = await ingestDeliveryFeedback(signEnvelope(event), client);
    expect(first.status).toBe("received");
    // Same eventId, fresh nonce: the dispatcher retried after a lost response.
    const retry = await ingestDeliveryFeedback(signEnvelope(event), client);
    expect(retry.status).toBe("duplicate");
    expect(inserts).toHaveLength(1);
  });

  it("returns 503 when the factory public key is not configured", async () => {
    delete process.env.DELIVERY_FACTORY_PUBLIC_KEY_PEM;
    const { client } = makeDb();
    await expect(
      ingestDeliveryFeedback(signEnvelope(buildEvent()), client),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});
