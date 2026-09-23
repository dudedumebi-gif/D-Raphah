/**
 * Telemetry with lazily-loaded Sentry.
 *
 * `@sentry/node` is intentionally NOT imported at module top level: its
 * heavy dynamic-require graph breaks Vercel's serverless function bundling
 * (FUNCTION_INVOCATION_FAILED on every invocation). It is only loaded when
 * SENTRY_DSN is configured and an error is actually reported.
 */

type SentryModule = typeof import("@sentry/node");

let sentryPromise: Promise<SentryModule | null> | null = null;

function loadSentry(): Promise<SentryModule | null> {
  if (!sentryPromise) {
    sentryPromise = (async () => {
      if (!process.env.SENTRY_DSN) return null;
      const Sentry = await import("@sentry/node");
      Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment:
          process.env.SENTRY_ENVIRONMENT ??
          process.env.VERCEL_ENV ??
          "development",
        release: process.env.VERCEL_GIT_COMMIT_SHA,
        tracesSampleRate: 0.1,
        sendDefaultPii: false,
      });
      return Sentry;
    })().catch(() => null);
  }
  return sentryPromise;
}

export interface LogContext {
  route?: string;
  requestId?: string | null;
  correlationId?: string | null;
  workspaceId?: string | null;
  jobId?: string | null;
  [key: string]: unknown;
}

export function log(
  level: "info" | "warn" | "error",
  message: string,
  context: LogContext = {},
): void {
  const entry = {
    level,
    message,
    service: "lead-engine",
    environment: process.env.VERCEL_ENV ?? "local",
    deploymentId:
      process.env.VERCEL_DEPLOYMENT_ID ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      null,
    timestamp: new Date().toISOString(),
    ...context,
  };
  const serialized = JSON.stringify(entry);
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else console.log(serialized);
}

export async function reportError(
  error: unknown,
  context: LogContext = {},
): Promise<void> {
  const safeError = error instanceof Error ? error : new Error(String(error));
  log("error", safeError.message, { ...context, errorName: safeError.name });
  const Sentry = await loadSentry();
  if (!Sentry) return;
  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(context)) {
      if (value !== undefined && value !== null)
        scope.setTag(key, String(value));
    }
    Sentry.captureException(safeError);
  });
  await Sentry.flush(2_000);
}

export function requestContext(request: Request, route: string): LogContext {
  return {
    route,
    requestId:
      request.headers.get("x-vercel-id") ?? request.headers.get("x-request-id"),
    correlationId: request.headers.get("x-correlation-id"),
    workspaceId: request.headers.get("x-workspace-id"),
  };
}
