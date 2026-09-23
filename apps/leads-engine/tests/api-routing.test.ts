import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * API routes are served by explicit Vercel function files under api/.
 * A catch-all (api/[...path].ts) does not route multi-segment paths
 * reliably on Vercel for vanilla Node projects, and the Hobby plan caps
 * deployments at 12 serverless functions, so routes are grouped:
 * - api/health/[check].ts      -> /api/health/live, /ready, /canary
 * - api/v1/[resource].ts       -> single-segment /api/v1/* resources
 * - api/v1/worker/tick.ts, api/v1/canary/run.ts, api/v1/feedback/events.ts
 * All files delegate to the central router in server/router.ts.
 */
const FUNCTION_FILES = [
  "api/health/[check].ts",
  "api/v1/[resource].ts",
  "api/v1/worker/tick.ts",
  "api/v1/canary/run.ts",
  "api/v1/feedback/events.ts",
];

const ROUTER_PATHS = [
  "/api/health/live",
  "/api/health/ready",
  "/api/health/canary",
  "/api/v1/bootstrap",
  "/api/v1/sources",
  "/api/v1/criteria",
  "/api/v1/scrape-jobs",
  "/api/v1/leads",
  "/api/v1/handoffs",
  "/api/v1/audit-events",
  "/api/v1/operations",
  "/api/v1/worker/tick",
  "/api/v1/canary/run",
  "/api/v1/feedback/events",
];

function matchesFunction(pathname: string): boolean {
  const seg = pathname.replace(/^\/api\//, "").split("/");
  if (seg[0] === "health" && seg.length === 2) return true;
  if (seg[0] === "v1" && seg.length === 2) return true;
  if (
    seg.length === 3 &&
    seg[0] === "v1" &&
    ((seg[1] === "worker" && seg[2] === "tick") ||
      (seg[1] === "canary" && seg[2] === "run") ||
      (seg[1] === "feedback" && seg[2] === "events"))
  )
    return true;
  return false;
}

describe("api routing contract", () => {
  it("has no catch-all function file", () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.includes("...")) found.push(p);
      }
    };
    walk(join(root, "api"));
    expect(found).toEqual([]);
  });

  it("stays within the serverless function limit", () => {
    expect(FUNCTION_FILES.length).toBeLessThanOrEqual(12);
    for (const f of FUNCTION_FILES) {
      expect(existsSync(join(root, f)), f).toBe(true);
    }
  });

  it("every router path is covered by a function file", () => {
    for (const p of ROUTER_PATHS) {
      expect(matchesFunction(p), p).toBe(true);
    }
  });

  it("every endpoint delegates to the shared router handler", () => {
    for (const f of FUNCTION_FILES) {
      const body = readFileSync(join(root, f), "utf8");
      expect(body).toContain("_lib/handler");
      expect(body).toContain("export default apiHandler");
    }
  });
});
