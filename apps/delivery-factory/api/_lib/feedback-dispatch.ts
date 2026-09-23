import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  DeliveryFeedbackEventV1Schema,
  signPackage,
  type DeliveryFeedbackEventV1,
} from "@raphah/handoff-contract";
import type { NeonClient } from "./db.js";

/**
 * Delivery feedback dispatcher (Delivery Factory -> Lead Engine).
 *
 * Producers enqueue structured DeliveryFeedbackEventV1 payloads into
 * feedback_outbox. This module claims due rows, signs a transport envelope
 * { event, nonce, issuedAt } with the factory's Ed25519 private key (the
 * mirror image of handoff signing), and POSTs it to the Lead Engine's
 * machine route POST /api/v1/feedback/events.
 *
 * The two products never share a database or credentials: the only shared
 * material is the factory's public key, configured on the Lead Engine as
 * DELIVERY_FACTORY_PUBLIC_KEY_PEM.
 */

export interface FeedbackDispatchEnv {
  leadEngineBaseUrl: string;
  signingPrivateKeyPem: string;
  dispatchTimeoutMs?: number;
}

export interface ClaimedFeedbackRow {
  id: string;
  event: unknown;
  attempts: number;
}

export interface FeedbackOutboxStore {
  /** Atomically claims up to `limit` due rows (FOR UPDATE SKIP LOCKED). */
  claimDue(limit: number): Promise<ClaimedFeedbackRow[]>;
  markSent(id: string): Promise<void>;
  markFailed(id: string): Promise<void>;
  reschedule(id: string, nextAttemptAt: Date): Promise<void>;
}

export interface FeedbackPostResult {
  status: number;
  body: unknown;
}

export interface DispatchSummary {
  claimed: number;
  sent: number;
  failed: number;
  rescheduled: number;
}

const DISPATCH_BATCH_SIZE = 25;
export const MAX_FEEDBACK_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 6 * 3_600_000; // 6h cap, mirrors handoff dispatch
const DEFAULT_TIMEOUT_MS = 15_000;

/** Builds the signed transport envelope for one feedback event. */
export function buildSignedFeedbackEnvelope(
  event: unknown,
  privateKeyPem: string,
  now: Date = new Date(),
): Record<string, unknown> {
  const parsed: DeliveryFeedbackEventV1 =
    DeliveryFeedbackEventV1Schema.parse(event);
  const body = {
    event: parsed,
    nonce: randomUUID(),
    issuedAt: now.toISOString(),
  };
  const { signature } = signPackage(body, privateKeyPem);
  return { ...body, signature };
}

/** Exponential backoff with equal jitter (50%-100% of the capped delay). */
export function feedbackBackoffMs(attempts: number): number {
  const capped = Math.min(2 ** attempts * 60_000, MAX_BACKOFF_MS);
  return Math.floor(capped * (0.5 + Math.random() * 0.5));
}

/** Neon-backed FeedbackOutboxStore for production use. */
export function createNeonFeedbackOutboxStore(
  client: NeonClient,
): FeedbackOutboxStore {
  return {
    async claimDue(limit: number): Promise<ClaimedFeedbackRow[]> {
      const rows = (await client`
        update public.feedback_outbox
        set status = 'dispatching', attempts = attempts + 1
        where id in (
          select id from public.feedback_outbox
          where status = 'pending' and next_attempt_at <= now()
          order by created_at
          limit ${limit}
          for update skip locked
        )
        returning id, event, attempts
      `) as unknown as Array<{
        id: string;
        event: unknown;
        attempts: number;
      }>;
      return rows.map((row) => ({
        id: row.id,
        event: row.event,
        attempts: row.attempts,
      }));
    },
    async markSent(id: string): Promise<void> {
      await client`
        update public.feedback_outbox set status = 'sent' where id = ${id}::uuid
      `;
    },
    async markFailed(id: string): Promise<void> {
      await client`
        update public.feedback_outbox set status = 'failed' where id = ${id}::uuid
      `;
    },
    async reschedule(id: string, nextAttemptAt: Date): Promise<void> {
      await client`
        update public.feedback_outbox
        set status = 'pending', next_attempt_at = ${nextAttemptAt.toISOString()}::timestamptz
        where id = ${id}::uuid
      `;
    },
  };
}

async function postJson(
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<FeedbackPostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Claims due feedback rows and dispatches them to the Lead Engine.
 * Terminal client errors (400/401/409/422) fail the row; rate limits,
 * server errors, and network failures reschedule with backoff up to
 * MAX_FEEDBACK_ATTEMPTS, then fail.
 */
export async function dispatchDueFeedback(options: {
  store: FeedbackOutboxStore;
  env: FeedbackDispatchEnv;
  post?: (
    url: string,
    body: unknown,
    timeoutMs: number,
  ) => Promise<FeedbackPostResult>;
  batchSize?: number;
  now?: Date;
}): Promise<DispatchSummary> {
  const {
    store,
    env,
    post = postJson,
    batchSize = DISPATCH_BATCH_SIZE,
    now = new Date(),
  } = options;
  const summary: DispatchSummary = {
    claimed: 0,
    sent: 0,
    failed: 0,
    rescheduled: 0,
  };
  const rows = await store.claimDue(batchSize);
  summary.claimed = rows.length;
  const endpoint = `${env.leadEngineBaseUrl.replace(/\/$/, "")}/api/v1/feedback/events`;
  const timeoutMs = env.dispatchTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (const row of rows) {
    let envelope: Record<string, unknown>;
    try {
      envelope = buildSignedFeedbackEnvelope(
        row.event,
        env.signingPrivateKeyPem,
        now,
      );
    } catch {
      // Poison payload: schema-invalid even though it was enqueued.
      await store.markFailed(row.id);
      summary.failed += 1;
      continue;
    }

    let result: FeedbackPostResult;
    try {
      result = await post(endpoint, envelope, timeoutMs);
    } catch {
      result = { status: 0, body: null }; // network failure / timeout
    }

    if (result.status === 201) {
      await store.markSent(row.id);
      summary.sent += 1;
    } else if (
      result.status === 200 &&
      typeof result.body === "object" &&
      result.body !== null &&
      (result.body as { status?: unknown }).status === "duplicate"
    ) {
      // The Lead Engine already stored this event (we retried after a
      // lost response). Nothing left to do.
      await store.markSent(row.id);
      summary.sent += 1;
    } else if (
      result.status === 400 ||
      result.status === 401 ||
      result.status === 409 ||
      result.status === 422
    ) {
      await store.markFailed(row.id);
      summary.failed += 1;
    } else if (row.attempts >= MAX_FEEDBACK_ATTEMPTS) {
      await store.markFailed(row.id);
      summary.failed += 1;
    } else {
      await store.reschedule(
        row.id,
        new Date(now.getTime() + feedbackBackoffMs(row.attempts)),
      );
      summary.rescheduled += 1;
    }
  }
  return summary;
}

/** Constant-time bearer comparison for the internal dispatch endpoint. */
export function bearerMatches(header: string | undefined, secret: string): boolean {
  // Fail closed: an unconfigured (empty) secret never matches, so a missing
  // DELIVERY_FACTORY_CRON_SECRET cannot be bypassed with `Bearer ` (empty token).
  if (!secret) return false;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const token = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(secret, "utf8");
  return token.length === expected.length && timingSafeEqual(token, expected);
}
