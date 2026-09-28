type Level = "info" | "warn" | "error";

export function log(
  level: Level,
  event: string,
  fields: Record<string, unknown> = {},
) {
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    service: "delivery-factory",
    level,
    event,
    ...fields,
  });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

export async function reportError(
  error: unknown,
  context: Record<string, unknown> = {},
) {
  log("error", "unhandled_error", {
    message: error instanceof Error ? error.message : String(error),
    ...context,
  });
  if (!process.env.SENTRY_DSN) return;
  try {
    const Sentry = await import("@sentry/node");
    if (!Sentry.getClient()) {
      Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.DELIVERY_ENVIRONMENT ?? "production",
      });
    }
    Sentry.captureException(error, { extra: context });
    await Sentry.flush(2_000);
  } catch (sentryError) {
    log("warn", "sentry_report_failed", {
      message:
        sentryError instanceof Error
          ? sentryError.message
          : String(sentryError),
    });
  }
}
