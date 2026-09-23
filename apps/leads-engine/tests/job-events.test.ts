import { describe, expect, it } from "vitest";
import {
  eventTimeLabel,
  isActiveJobStatus,
  isTerminalJobStatus,
  latestJobStatus,
  parseJobEvents,
  summarizeEvent,
} from "../src/jobEvents";

// Mirrors the server's exact serialization in router.ts:
//   `event: ${type}\ndata: ${JSON.stringify({ type, at, data: row })}\n\n`
function block(type: string, at: string, row: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, at, data: row })}`;
}

const ATTEMPT = block("attempt", "2026-09-23T19:00:01Z", {
  id: "a1",
  started_at: "2026-09-23T19:00:01Z",
  status: "running",
});
const AUDIT = block("audit", "2026-09-23T19:00:05Z", {
  action: "scrape.completed",
  outcome: "ok",
  reason: null,
  created_at: "2026-09-23T19:00:05Z",
});
const JOB = block("job", "2026-09-23T19:00:06Z", {
  id: "j1",
  status: "completed",
  attempt_count: 1,
  max_attempts: 3,
  last_error: null,
  updated_at: "2026-09-23T19:00:06Z",
});

describe("parseJobEvents", () => {
  it("parses SSE blocks and unwraps the server envelope", () => {
    const events = parseJobEvents([ATTEMPT, AUDIT, JOB].join("\n\n"));
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.type)).toEqual(["attempt", "audit", "job"]);
    // Inner row fields are read directly, not the envelope.
    expect(events[0].data.status).toBe("running");
    expect(events[1].data.action).toBe("scrape.completed");
    expect(events[2].data.status).toBe("completed");
  });

  it("sorts by timestamp regardless of payload order", () => {
    const events = parseJobEvents([JOB, ATTEMPT, AUDIT].join("\n\n"));
    expect(events.map((e) => e.type)).toEqual(["attempt", "audit", "job"]);
  });

  it("skips malformed blocks without failing the whole payload", () => {
    const payload = [
      ATTEMPT,
      "event: attempt\ndata: not-json{{{",
      "event: audit", // missing data line
      "data: {\"a\":1}", // missing event line
      "",
      "   ",
      JOB,
    ].join("\n\n");
    const events = parseJobEvents(payload);
    expect(events.map((e) => e.type)).toEqual(["attempt", "job"]);
  });

  it("returns an empty list for empty payloads", () => {
    expect(parseJobEvents("")).toEqual([]);
    expect(parseJobEvents("\n\n  \n")).toEqual([]);
  });
});

describe("job status helpers", () => {
  it("classifies terminal statuses", () => {
    for (const s of ["completed", "failed", "cancelled", "dead_letter"])
      expect(isTerminalJobStatus(s)).toBe(true);
    for (const s of ["queued", "leased", "running", "retrying", "", "bogus"])
      expect(isTerminalJobStatus(s)).toBe(false);
    expect(isTerminalJobStatus(null)).toBe(false);
    expect(isTerminalJobStatus(undefined)).toBe(false);
  });

  it("classifies active statuses", () => {
    for (const s of ["queued", "leased", "running", "retrying"])
      expect(isActiveJobStatus(s)).toBe(true);
    expect(isActiveJobStatus("completed")).toBe(false);
    expect(isActiveJobStatus(null)).toBe(false);
  });
});

describe("summarizeEvent", () => {
  it("summarizes attempts, audits, and job updates", () => {
    const [attempt, audit, job] = parseJobEvents(
      [ATTEMPT, AUDIT, JOB].join("\n\n"),
    );
    expect(summarizeEvent(attempt)).toBe("Attempt running");
    expect(summarizeEvent(audit)).toBe("scrape.completed · ok");
    expect(summarizeEvent(job)).toBe("Job completed · attempt 1/3");
  });

  it("includes error detail when present", () => {
    const events = parseJobEvents(
      block("job", "2026-09-23T19:00:06Z", {
        status: "failed",
        attempt_count: 3,
        max_attempts: 3,
        last_error: "DNS blocked",
      }),
    );
    expect(summarizeEvent(events[0])).toBe(
      "Job failed · attempt 3/3 — DNS blocked",
    );
  });

  it("falls back for unknown event types", () => {
    const events = parseJobEvents(
      block("mystery", "2026-09-23T19:00:01Z", { x: 1 }),
    );
    expect(summarizeEvent(events[0])).toBe("mystery event");
  });
});

describe("latestJobStatus", () => {
  it("reads the freshest job block, falling back to the prop", () => {
    const events = parseJobEvents([ATTEMPT, JOB].join("\n\n"));
    expect(latestJobStatus(events, "running")).toBe("completed");
    expect(latestJobStatus([], "running")).toBe("running");
    expect(latestJobStatus([], null)).toBeNull();
  });
});

describe("eventTimeLabel", () => {
  it("never throws on bad timestamps", () => {
    const events = parseJobEvents(
      block("job", "not-a-date", { status: "queued" }),
    );
    expect(eventTimeLabel(events[0])).toBe("—");
  });
});
