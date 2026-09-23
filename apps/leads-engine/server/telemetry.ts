import * as Sentry from "@sentry/node";

let initialized = false;

function ensureSentry(): void {
  if (initialized || !process.env.SENTRY_DSN) return;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment:
      process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? "development",
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
  });
  initialized = true;
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
  ensureSentry();
  if (initialized) {
    Sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(context)) {
        if (value !== undefined && value !== null)
          scope.setTag(key, String(value));
      }
      Sentry.captureException(safeError);
    });
    await Sentry.flush(2_000);
  }
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
