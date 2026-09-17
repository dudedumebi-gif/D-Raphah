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
