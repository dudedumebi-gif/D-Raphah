import { z } from "zod";

export const FEEDBACK_SCHEMA_VERSION = "1.0.0" as const;

export const DeliveryFeedbackEventV1Schema = z.object({
  eventId: z.string().uuid(),
  eventType: z.enum([
    "delivery.handoff.accepted",
    "delivery.handoff.rejected",
    "delivery.clarification.requested",
    "delivery.project.started",
    "delivery.scope.change.requested",
    "delivery.release.completed",
    "delivery.project.closed",
  ]),
  schemaVersion: z.literal(FEEDBACK_SCHEMA_VERSION),
  occurredAt: z.string().datetime(),
  producer: z.literal("delivery-factory"),
  environment: z.enum(["local", "preview", "test", "production"]),
  correlationId: z.string().uuid(),
  packageId: z.string().uuid(),
  packageVersion: z.number().int().positive(),
  opportunityId: z.string().uuid(),
  projectId: z.string().min(1).optional(),
  details: z.record(z.unknown()),
  manifestChecksum: z.string().regex(/^[a-f0-9]{64}$/),
});

export type DeliveryFeedbackEventV1 = z.infer<
  typeof DeliveryFeedbackEventV1Schema
>;
