import {
  DeliveryFeedbackEventV1Schema,
  sha256CanonicalJson,
  verifyPackage,
} from "@raphah/handoff-contract";
import { z } from "zod";
import type { SqlClient } from "./handoff.js";
import { createAdminClient } from "./neon.js";

/**
 * Machine-to-machine delivery feedback ingestion.
 *
 * The Delivery Factory signs a transport envelope { event, nonce, issuedAt }
 * with its Ed25519 private key (the mirror image of handoff signing, where
 * the Lead Engine is the signer). Verification order mirrors the intake
 * pipeline: timestamp -> signature -> envelope checksum -> nonce claim ->
 * opportunity resolution -> idempotent insert.
 *
 * Human sales feedback stays in lead_feedback; machine delivery telemetry
 * lands in delivery_feedback_events so the two semantics never mix.
 */

const FEEDBACK_SKEW_MS = 5 * 60_000;
const NONCE_TTL_MS = 10 * 60_000;

const FeedbackEnvelopeSchema = z.object({
  event: DeliveryFeedbackEventV1Schema,
  nonce: z.string().min(16).max(128),
  issuedAt: z.string().datetime(),
  signature: z.string().min(1),
});

export type FeedbackEnvelope = z.infer<typeof FeedbackEnvelopeSchema>;

export interface FeedbackIngestResult {
  status: "received" | "duplicate";
  eventId: string;
}

function deliveryFactoryPublicKey(): string {
  const raw = process.env.DELIVERY_FACTORY_PUBLIC_KEY_PEM;
  if (!raw || raw.trim().length === 0) {
    throw Object.assign(
      new Error("Delivery feedback receiver is not configured"),
      { statusCode: 503 },
    );
  }
  return raw.replace(/\\n/g, "\n");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

/**
 * Verifies and stores one signed delivery feedback envelope.
 * Idempotent on the contract's eventId: a retried dispatch of the same
 * event is acknowledged without a second row.
 */
export async function ingestDeliveryFeedback(
  body: unknown,
  client: SqlClient = createAdminClient() as unknown as SqlClient,
  now: Date = new Date(),
): Promise<FeedbackIngestResult> {
  const envelope = FeedbackEnvelopeSchema.parse(body);
  const { event, nonce, issuedAt, signature } = envelope;

  // (1) Timestamp freshness: rejects captured envelopes replayed late.
  const issuedMs = new Date(issuedAt).getTime();
  if (Number.isNaN(issuedMs) || Math.abs(now.getTime() - issuedMs) > FEEDBACK_SKEW_MS) {
    throw Object.assign(
      new Error("Feedback envelope timestamp outside tolerance"),
      { statusCode: 401 },
    );
  }

  // (2) Envelope signature over { event, nonce, issuedAt }.
  const envelopeBody = { event, nonce, issuedAt };
  const envelopeChecksum = sha256CanonicalJson(envelopeBody);
  if (
    !verifyPackage(envelopeBody, envelopeChecksum, signature, deliveryFactoryPublicKey())
  ) {
    throw Object.assign(new Error("Invalid feedback signature"), {
      statusCode: 401,
    });
  }

  // (3) Event manifest integrity (defense in depth: the event's own checksum,
  // computed by the factory in buildFeedbackEvent).
  const { manifestChecksum, ...eventBody } = event;
  if (sha256CanonicalJson(eventBody) !== manifestChecksum) {
    throw Object.assign(new Error("Feedback event checksum mismatch"), {
      statusCode: 400,
    });
  }

  // (4) Nonce claim: first writer wins; a claimed nonce is a replay.
  const expiresAt = new Date(now.getTime() + NONCE_TTL_MS).toISOString();
  try {
    await client`
      insert into public.feedback_nonces(nonce, expires_at)
      values (${nonce}, ${expiresAt}::timestamptz)
    `;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw Object.assign(new Error("Duplicate feedback delivery"), {
        statusCode: 409,
      });
    }
    throw error;
  }
  // Opportunistic prune of expired nonces.
  await client`delete from public.feedback_nonces where expires_at < now()`;

  // (5) Resolve the opportunity to its workspace. The factory never learns
  // Lead Engine workspace IDs, so resolution happens here.
  const opportunities = (await client`
    select id, workspace_id from public.opportunities where id = ${event.opportunityId}::uuid
  `) as Array<{ id: string; workspace_id: string }>;
  if (opportunities.length === 0) {
    throw Object.assign(new Error("Unknown opportunity"), { statusCode: 422 });
  }

  // (6) Idempotent insert on the contract's eventId.
  try {
    await client`
      insert into public.delivery_feedback_events
        (event_id, workspace_id, opportunity_id, package_id, event_type,
         producer, environment, occurred_at, payload)
      values
        (${event.eventId}::uuid, ${opportunities[0].workspace_id}::uuid,
         ${event.opportunityId}::uuid, ${event.packageId}::uuid,
         ${event.eventType}, ${event.producer}, ${event.environment},
         ${event.occurredAt}::timestamptz, ${JSON.stringify(event.details)}::jsonb)
    `;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { status: "duplicate", eventId: event.eventId };
    }
    throw error;
  }
  return { status: "received", eventId: event.eventId };
}
