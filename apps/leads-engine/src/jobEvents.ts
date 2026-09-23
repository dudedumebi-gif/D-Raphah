/**
 * Helpers for the live scrape-job window.
 *
 * The server exposes GET /api/v1/scrape-jobs/{id}/events which returns a
 * one-shot, SSE-formatted timeline (content-type: text/event-stream,
 * connection: close). The UI polls it while a job is active and renders the
 * blocks below. Everything in this module is pure so it can be unit tested
 * in the node vitest environment without React or the Neon client.
 */

export interface JobEvent {
  /** "attempt" | "audit" | "job" (server-defined; treated opaquely). */
  type: string;
  /** ISO timestamp the event sorts on. */
  at: string;
  /** Decoded data payload; shape varies by type. */
  data: Record<string, unknown>;
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "dead_letter",
]);

export function isTerminalJobStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && TERMINAL_STATUSES.has(status);
}

export function isActiveJobStatus(status: string | null | undefined): boolean {
  return (
    typeof status === "string" &&
    ["queued", "leased", "running", "retrying"].includes(status)
  );
}

/**
 * Parse an SSE-formatted payload ("event: <type>\\ndata: <json>\\n\\n" blocks)
 * into a time-ordered list of job events. Malformed blocks are skipped so a
 * single bad row can never blank the live window.
 */
export function parseJobEvents(payload: string): JobEvent[] {
  const events: JobEvent[] = [];
  if (!payload) return events;
  for (const block of payload.split("\n\n")) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let type = "";
    const dataLines: string[] = [];
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!type || dataLines.length === 0) continue;
    // The server serializes the whole envelope per block:
    //   data: {"type":"attempt","at":"…","data":{…row…}}
    // Unwrap to the inner row so summaries read row fields directly.
    let envelope: { type?: unknown; at?: unknown; data?: unknown };
    try {
      const parsed: unknown = JSON.parse(dataLines.join("\n"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        continue;
      envelope = parsed as { type?: unknown; at?: unknown; data?: unknown };
    } catch {
      continue;
    }
    const inner = envelope.data;
    const data: Record<string, unknown> =
      inner && typeof inner === "object" && !Array.isArray(inner)
        ? (inner as Record<string, unknown>)
        : {};
    const at = typeof envelope.at === "string" ? envelope.at : "";
    events.push({ type, at, data });
  }
  return events.sort((a, b) => {
    const ta = Date.parse(a.at);
    const tb = Date.parse(b.at);
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return ta - tb;
  });
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function formatTime(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "—" : new Date(ms).toLocaleTimeString();
}

/** One-line, human-readable summary for a timeline row. */
export function summarizeEvent(event: JobEvent): string {
  const data = event.data;
  if (event.type === "attempt") {
    const status = asString(data.status);
    const error = asString(data.error ?? data.last_error);
    if (status) return `Attempt ${status}${error ? ` — ${error}` : ""}`;
    return "Attempt recorded";
  }
  if (event.type === "audit") {
    const action = asString(data.action) ?? "event";
    const outcome = asString(data.outcome);
    const reason = asString(data.reason);
    return `${action}${outcome ? ` · ${outcome}` : ""}${reason ? ` — ${reason}` : ""}`;
  }
  if (event.type === "job") {
    const status = asString(data.status) ?? "updated";
    const attempts = `${String(data.attempt_count ?? "?")}/${String(data.max_attempts ?? "?")}`;
    const error = asString(data.last_error);
    return `Job ${status} · attempt ${attempts}${error ? ` — ${error}` : ""}`;
  }
  return `${event.type} event`;
}

export function eventTimeLabel(event: JobEvent): string {
  return formatTime(event.at);
}

/**
 * Read the freshest job status out of a parsed timeline (the server appends
 * a synthetic { type: "job" } block with the current row). Falls back to the
 * provided status when the timeline carries none.
 */
export function latestJobStatus(
  events: JobEvent[],
  fallback: string | null | undefined,
): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const status = asString(events[i].data.status);
    if (events[i].type === "job" && status) return status;
  }
  return typeof fallback === "string" ? fallback : null;
}
