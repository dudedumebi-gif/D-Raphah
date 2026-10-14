import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isRetired,
  restoreStatus,
  retireDecision,
  sourceRetireBlocker,
} from "../api/_lib/archive";

describe("source retire guard", () => {
  it("allows retirement when nothing is in flight", () => {
    expect(sourceRetireBlocker(0)).toBeNull();
  });

  it("blocks retirement while jobs are in flight, naming the count", () => {
    const blocker = sourceRetireBlocker(3);
    expect(blocker).toContain("3 job(s) in flight");
  });
});

describe("restore status", () => {
  it("returns the exact pre-retire status", () => {
    expect(restoreStatus("paused")).toBe("paused");
    expect(restoreStatus("pending_approval")).toBe("pending_approval");
  });

  it("never restores into or out of a void as anything but active", () => {
    expect(restoreStatus(null)).toBe("active");
    expect(restoreStatus("retired")).toBe("active");
  });
});

describe("isRetired", () => {
  it("matches only the retired status", () => {
    expect(isRetired("retired")).toBe(true);
    expect(isRetired("active")).toBe(false);
    expect(isRetired(null)).toBe(false);
    expect(isRetired(undefined)).toBe(false);
  });
});

describe("retireDecision (RPC outcome -> HTTP semantics)", () => {
  it("maps successful transitions", () => {
    expect(retireDecision({ outcome: "retired", from_status: "active" }, "Source")).toEqual({
      kind: "retired",
      fromStatus: "active",
    });
    expect(retireDecision({ outcome: "restored", to_status: "paused" }, "Campaign")).toEqual({
      kind: "restored",
      toStatus: "paused",
    });
  });

  it("maps not_found to 404 and state conflicts to 409", () => {
    const missing = retireDecision({ outcome: "not_found" }, "Campaign");
    expect(missing).toEqual({
      kind: "error",
      statusCode: 404,
      message: "Campaign not found",
    });
    const again = retireDecision({ outcome: "already_retired" }, "Source");
    expect(again.kind).toBe("error");
    if (again.kind === "error") expect(again.statusCode).toBe(409);
    const notRetired = retireDecision({ outcome: "not_retired" }, "Source");
    expect(notRetired.kind).toBe("error");
    if (notRetired.kind === "error") expect(notRetired.statusCode).toBe(409);
  });

  it("maps blocked to the in-flight blocker message naming the count", () => {
    const blocked = retireDecision({ outcome: "blocked", in_flight: 2 }, "Source");
    expect(blocked.kind).toBe("error");
    if (blocked.kind === "error") {
      expect(blocked.statusCode).toBe(409);
      expect(blocked.message).toContain("2 job(s) in flight");
    }
  });

  it("maps an unknown outcome to a 500, never a silent success", () => {
    const weird = retireDecision({ outcome: "??" }, "Source");
    expect(weird.kind).toBe("error");
    if (weird.kind === "error") expect(weird.statusCode).toBe(500);
  });
});

// Regression contract for the Codex PR #44 findings. These pin the
// shapes that unit tests of pure helpers cannot see: the transition
// must run through the SECURITY DEFINER RPCs (authenticated has no
// UPDATE grant on source_definitions and only column-scoped grants
// on scrape_campaigns), the in-flight guard must use a literal ANY
// array inside SQL (never a driver-interpolated JS array), and
// retired campaigns must be gated out of discovery.
describe("archive migration + call-site contract", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(
    join(here, "../neon/migrations/202610120007_archive_history.sql"),
    "utf8",
  );
  const router = readFileSync(join(here, "../api/_lib/router.ts"), "utf8");
  const schedule = readFileSync(
    join(here, "../api/_lib/discovery/schedule.ts"),
    "utf8",
  );

  it("defines both lifecycle RPCs and revokes EXECUTE from the API roles", () => {
    expect(migration).toContain(
      "create or replace function public.set_source_retired",
    );
    expect(migration).toContain(
      "create or replace function public.set_campaign_retired",
    );
    expect(migration).toContain(
      "revoke execute on function public.set_source_retired(uuid, uuid, boolean)",
    );
    expect(migration).toContain(
      "revoke execute on function public.set_campaign_retired(uuid, uuid, boolean)",
    );
  });

  it("guards with enum-safe literals and routes call the RPCs via admin", () => {
    // job_status is an ENUM: comparing it to a text[] (the original
    // ANY(array[...]) shape) is SQLSTATE 42883 in production. The
    // guard uses bare literals, which coerce to the enum — pinned
    // here against migration 202610120008, which carries the fix.
    const fix = readFileSync(
      join(here, "../neon/migrations/202610120008_fix_source_retire_enum.sql"),
      "utf8",
    );
    expect(fix).toContain(
      "status in ('queued', 'leased', 'running', 'retrying')",
    );
    expect(fix).not.toContain("any(array[");
    expect(router).not.toContain("status in ${");
    expect(router).toContain("public.set_source_retired(");
    expect(router).toContain("public.set_campaign_retired(");
  });

  it("gates retired campaigns out of scheduled AND manual discovery", () => {
    expect(schedule).toContain("discovery_skipped_campaign_retired");
    expect(schedule).toContain("status = 'active'");
    expect(router).toContain('discoverySource.campaign_id');
  });
});
