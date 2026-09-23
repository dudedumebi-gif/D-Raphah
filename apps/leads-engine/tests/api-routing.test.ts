import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every API route served by server/router.ts must have a corresponding
 * explicit Vercel function file under api/. A catch-all (api/[...path].ts)
 * does not route reliably on Vercel for vanilla Node projects, so explicit
 * files are the deployment contract.
 */
const ROUTES = [
  "api/health/live.ts",
  "api/health/ready.ts",
  "api/health/canary.ts",
  "api/v1/bootstrap.ts",
  "api/v1/sources.ts",
  "api/v1/criteria.ts",
  "api/v1/scrape-jobs.ts",
  "api/v1/leads.ts",
  "api/v1/handoffs.ts",
  "api/v1/audit-events.ts",
  "api/v1/operations.ts",
  "api/v1/worker/tick.ts",
  "api/v1/canary/run.ts",
  "api/v1/feedback/events.ts",
];

describe("api routing contract", () => {
  it("has no catch-all function file", () => {
    const apiDir = join(root, "api");
    const entries = readdirSync(apiDir);
    expect(entries.some((e) => e.includes("[") || e.includes("]"))).toBe(false);
  });

  it("has an explicit function file for every route", () => {
    for (const route of ROUTES) {
      expect(existsSync(join(root, route)), route).toBe(true);
    }
  });

  it("every endpoint delegates to the shared router handler", () => {
    for (const route of ROUTES) {
      const body = readFileSync(join(root, route), "utf8");
      expect(body).toContain("_lib/handler");
      expect(body).toContain("export default apiHandler");
    }
  });
});
