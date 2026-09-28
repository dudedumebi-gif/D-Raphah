import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OVERPASS_OSM_TERMS_ID,
  OVERPASS_OSM_TERMS_VERSION,
  TermsNotAcceptedError,
  requireTermsAcceptance,
} from "../api/_lib/discovery/terms";
import {
  runScheduledDiscovery,
  type ScheduleSqlClient,
} from "../api/_lib/discovery/schedule";

const WS = "2e48593c-feb0-41e3-b0e5-0e42cf398a43";
const SRC = "6c20af8e-da02-4212-b66e-833a7e0f8559";

function makeClient(handlers: Record<string, (values: unknown[]) => unknown[]>): ScheduleSqlClient {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?").toLowerCase();
    for (const [fragment, handler] of Object.entries(handlers))
      if (sql.includes(fragment)) return handler(values);
    throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
  }) as ScheduleSqlClient;
}

const sourceRow = () => ({
  id: "disc-1",
  workspace_id: WS,
  name: "Toronto sweep",
  adapter_id: "overpass",
  geo_params: { city: "Toronto", radiusKm: 5 },
  source_id: SRC,
  campaign_id: null,
  active: true,
});

describe("requireTermsAcceptance", () => {
  it("passes when the acceptance exists", async () => {
    const lookup = { hasAccepted: async () => true };
    await expect(
      requireTermsAcceptance(lookup, WS),
    ).resolves.toBeUndefined();
  });

  it("refuses with 409 and names the remediation when absent", async () => {
    const lookup = { hasAccepted: async () => false };
    const error = await requireTermsAcceptance(lookup, WS).catch((e) => e);
    expect(error).toBeInstanceOf(TermsNotAcceptedError);
    expect((error as { statusCode: number }).statusCode).toBe(409);
    expect(String(error.message)).toContain("POST /api/v1/terms/accept");
    expect(OVERPASS_OSM_TERMS_VERSION).toBeTruthy();
  });
});

describe("runScheduledDiscovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function baseHandlers(opts: {
    accepted: boolean;
    recentRun: boolean;
    approved: boolean;
  }) {
    const handlers: Record<string, (values: unknown[]) => unknown[]> = {};
    handlers["from public.discovery_sources"] = () => [sourceRow()];
    handlers["from public.discovery_runs"] = () =>
      opts.recentRun ? [{}] : [];
    handlers["from public.terms_acceptances"] = () =>
      opts.accepted ? [{}] : [];
    handlers["from public.source_definitions s"] = () =>
      opts.approved ? [{}] : [];
    return handlers;
  }

  it("skips a source when Overpass/OSM terms are not accepted", async () => {
    let runsCreated = 0;
    const client = makeClient({
      ...baseHandlers({ accepted: false, recentRun: false, approved: true }),
      "insert into public.discovery_runs": () => {
        runsCreated += 1;
        return [{ id: "run-1", started_at: new Date().toISOString() }];
      },
    });
    const result = await runScheduledDiscovery(client);
    expect(result.checked).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.ran).toBe(0);
    expect(runsCreated).toBe(0);
  });

  it("skips a source that already ran in the last 24h", async () => {
    let runsCreated = 0;
    const client = makeClient({
      ...baseHandlers({ accepted: true, recentRun: true, approved: true }),
      "insert into public.discovery_runs": () => {
        runsCreated += 1;
        return [{ id: "run-1", started_at: new Date().toISOString() }];
      },
    });
    const result = await runScheduledDiscovery(client);
    expect(result.skipped).toBe(1);
    expect(runsCreated).toBe(0);
  });

  it("refuses when the borrowed collection source is no longer approved", async () => {
    let runsCreated = 0;
    const client = makeClient({
      ...baseHandlers({ accepted: true, recentRun: false, approved: false }),
      "insert into public.discovery_runs": () => {
        runsCreated += 1;
        return [{ id: "run-1", started_at: new Date().toISOString() }];
      },
    });
    const result = await runScheduledDiscovery(client);
    expect(result.ran).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain("not approved");
    expect(runsCreated).toBe(0);
  });

  it("runs discovery and enqueues candidates for a gated-clean source", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          elements: [
            {
              type: "node",
              id: 1,
              lat: 43.65,
              lon: -79.38,
              tags: { name: "Test Shop", website: "https://test-shop.example.com" },
            },
            {
              type: "node",
              id: 2,
              lat: 43.66,
              lon: -79.39,
              tags: { name: "No Website Inc" },
            },
          ],
        }),
      }),
    );
    const enqueued: string[] = [];
    const client = makeClient({
      ...baseHandlers({ accepted: true, recentRun: false, approved: true }),
      "insert into public.discovery_runs": () => [
        { id: "run-1", started_at: new Date().toISOString() },
      ],
      "update public.discovery_runs": () => [],
      "select target_url, idempotency_key": () => [],
      "select workspace_id from public.source_definitions": () => [
        { workspace_id: WS },
      ],
      "insert into public.scrape_jobs": (values) => {
        // values: workspaceId, sourceId, targetUrl, idempotencyKey, maxAttempts
        enqueued.push(String(values[2]));
        return [{ id: "job-1", created_at: new Date().toISOString() }];
      },
    });
    const result = await runScheduledDiscovery(client);
    expect(result.checked).toBe(1);
    expect(result.ran).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(result.enqueued).toBe(1);
    expect(enqueued).toContain("https://test-shop.example.com");
  });
});
