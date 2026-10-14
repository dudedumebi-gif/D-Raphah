import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression contract for the "Re-queue scrape" failure the operator
// hit on 2026-10-13: the campaign card posts only { sourceId }, but
// POST /api/v1/scrape-jobs required targetUrl, so every requeue died
// in zod validation ("targetUrl: Required"). The route now accepts
// the omission and falls back to the source's base_url — which is
// what re-queueing a source's scrape means. The handler is not
// unit-testable without a request context, so this pins the two
// source shapes the fix depends on.
describe("manual job route contract (requeue regression)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const router = readFileSync(join(here, "../api/_lib/router.ts"), "utf8");

  it("targetUrl is optional in the manual-job schema", () => {
    expect(router).toContain("targetUrl: z.string().url().optional()");
  });

  it("the route falls back to the source's base_url", () => {
    expect(router).toContain("p_target_url: input.targetUrl ?? source.base_url");
  });
});
