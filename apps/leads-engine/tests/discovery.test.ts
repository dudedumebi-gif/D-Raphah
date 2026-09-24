import { describe, expect, it, vi } from "vitest";
import {
  DiscoveryGeoInputSchema,
  DiscoveryUpstreamError,
  geoBoundingBox,
  normalizeWebsiteUrl,
  resolveGeoQuery,
  type Candidate,
} from "../api/_lib/discovery/adapter";
import {
  buildOverpassQuery,
  OverpassAdapter,
  overpassElementToCandidate,
} from "../api/_lib/discovery/overpass";
import {
  runDiscoveryRun,
  type DiscoverySourceRow,
  type DiscoveryStore,
} from "../api/_lib/discovery/run";

function mockFetchResponse(elements: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => ({ elements }),
  });
}

const GEO = resolveGeoQuery(DiscoveryGeoInputSchema.parse({ city: "Toronto" }));

describe("normalizeWebsiteUrl", () => {
  it("canonicalizes equivalent spellings to the same key", () => {
    expect(normalizeWebsiteUrl("https://www.Example.com/")).toBe(
      "https://example.com",
    );
    expect(normalizeWebsiteUrl("http://example.com/path/")).toBe(
      "https://example.com/path",
    );
    expect(normalizeWebsiteUrl("example.com")).toBe("https://example.com");
    expect(normalizeWebsiteUrl("https://example.com?x=1#frag")).toBe(
      "https://example.com",
    );
  });
  it("rejects unusable values", () => {
    expect(normalizeWebsiteUrl("")).toBeNull();
    expect(normalizeWebsiteUrl("   ")).toBeNull();
    expect(normalizeWebsiteUrl("not a url at all !!!")).toBeNull();
    expect(normalizeWebsiteUrl("ftp://example.com")).toBeNull();
    expect(normalizeWebsiteUrl("mailto:ops@example.com")).toBeNull();
  });
});

describe("resolveGeoQuery", () => {
  it("fills centre coordinates from city presets", () => {
    const geo = resolveGeoQuery(
      DiscoveryGeoInputSchema.parse({ city: "Ottawa", radiusKm: 25 }),
    );
    expect(geo.centreLatitude).toBeCloseTo(45.4215, 3);
    expect(geo.centreLongitude).toBeCloseTo(-75.6972, 3);
    expect(geo.region).toBe("Ontario");
    expect(geo.radiusKm).toBe(25);
  });
  it("prefers explicit coordinates over the preset", () => {
    const geo = resolveGeoQuery(
      DiscoveryGeoInputSchema.parse({
        city: "Toronto",
        centreLatitude: 44,
        centreLongitude: -80,
      }),
    );
    expect(geo.centreLatitude).toBe(44);
    expect(geo.centreLongitude).toBe(-80);
  });
  it("requires coordinates for unknown cities", () => {
    expect(() =>
      resolveGeoQuery(DiscoveryGeoInputSchema.parse({ city: "Atlantis" })),
    ).toThrow(/Unknown city/);
  });
});

describe("geoBoundingBox", () => {
  it("produces a box containing the centre with a sane radius", () => {
    const box = geoBoundingBox({
      city: "Toronto",
      region: "Ontario",
      centreLatitude: 43.6532,
      centreLongitude: -79.3832,
      radiusKm: 50,
    });
    expect(box.south).toBeLessThan(43.6532);
    expect(box.north).toBeGreaterThan(43.6532);
    expect(box.west).toBeLessThan(-79.3832);
    expect(box.east).toBeGreaterThan(-79.3832);
    // ~50km is ~0.45 degrees of latitude.
    expect(box.north - box.south).toBeCloseTo(0.9, 1);
  });
});

describe("buildOverpassQuery", () => {
  it("emits a single query with website selectors for all object types", () => {
    const query = buildOverpassQuery(GEO);
    expect(query).toContain("[out:json]");
    expect(query).toContain("[timeout:60]");
    for (const tag of ["shop", "office", "amenity"]) {
      for (const kind of ["node", "way", "relation"]) {
        expect(query).toContain(`${kind}["${tag}"]["website"]`);
      }
    }
    expect(query).toContain("out center;");
    // Bounding box present in south,west,north,east order.
    const box = geoBoundingBox(GEO);
    expect(query).toContain(box.south.toFixed(5));
  });
});

describe("overpassElementToCandidate", () => {
  it("maps node coordinates and OSM tags", () => {
    const candidate = overpassElementToCandidate({
      type: "node",
      id: 1,
      lat: 43.65,
      lon: -79.38,
      tags: {
        name: "Acme Plumbing",
        website: "https://acmeplumbing.ca",
        shop: "plumber",
        "addr:housenumber": "12",
        "addr:street": "King St W",
        "addr:city": "Toronto",
        "addr:postcode": "M5H 1A1",
      },
    });
    expect(candidate).toMatchObject({
      name: "Acme Plumbing",
      website: "https://acmeplumbing.ca",
      lat: 43.65,
      lng: -79.38,
      category: "plumber",
      source: "overpass",
    });
    expect(candidate.address).toBe("12 King St W, Toronto, M5H 1A1");
  });
  it("uses center coordinates for ways and prefers amenity value", () => {
    const candidate = overpassElementToCandidate({
      type: "way",
      id: 2,
      center: { lat: 45.42, lon: -75.69 },
      tags: { amenity: "dentist", website: "http://smile.example" },
    });
    expect(candidate.lat).toBe(45.42);
    expect(candidate.lng).toBe(-75.69);
    expect(candidate.category).toBe("dentist");
    expect(candidate.name).toBeNull();
    expect(candidate.address).toBeNull();
  });
  it("tolerates missing tags", () => {
    const candidate = overpassElementToCandidate({ type: "node", id: 3 });
    expect(candidate.website).toBeNull();
    expect(candidate.lat).toBeNull();
  });
});

describe("OverpassAdapter", () => {
  it("POSTs one query to the interpreter with a proper User-Agent", async () => {
    const fetcher = mockFetchResponse([
      {
        type: "node",
        id: 1,
        lat: 43.65,
        lon: -79.38,
        tags: { name: "Shop", website: "https://shop.example", shop: "books" },
      },
    ]);
    const adapter = new OverpassAdapter();
    const candidates = await adapter.fetchCandidates(GEO, { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://overpass-api.de/api/interpreter");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["user-agent"]).toContain(
      "RaphahLeadEngine-Discovery",
    );
    expect(String(init.body)).toContain("data=");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      name: "Shop",
      website: "https://shop.example",
      source: "overpass",
    });
  });
  it("maps HTTP failures to a 502 upstream error", async () => {
    const fetcher = mockFetchResponse([], false, 429);
    await expect(
      new OverpassAdapter().fetchCandidates(GEO, { fetcher }),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
  it("maps network failures to a 502 upstream error", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      new OverpassAdapter().fetchCandidates(GEO, { fetcher }),
    ).rejects.toBeInstanceOf(DiscoveryUpstreamError);
  });
  it("maps timeouts to a 502 upstream error", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const fetcher = vi.fn().mockRejectedValue(abortError);
    await expect(
      new OverpassAdapter().fetchCandidates(GEO, { fetcher }),
    ).rejects.toThrow(/timed out/);
  });
});

function makeStore(source: DiscoverySourceRow): {
  store: DiscoveryStore;
  calls: { queued: Array<{ key: string; targetUrl: string }> };
  finished: Array<{ runId: string; outcome: unknown }>;
  existing: Array<{ target_url: string; idempotency_key: string }>;
} {
  const calls = { queued: [] as Array<{ key: string; targetUrl: string }> };
  const finished = [] as Array<{ runId: string; outcome: unknown }>;
  const existing: Array<{ target_url: string; idempotency_key: string }> = [];
  const now = Date.now();
  let runCounter = 0;
  const store: DiscoveryStore = {
    getSource: async (id) => (id === source.id ? source : null),
    createRun: async () => {
      runCounter += 1;
      return {
        id: `run-${runCounter}`,
        startedAt: new Date(now).toISOString(),
      };
    },
    finishRun: async (runId, outcome) => {
      finished.push({ runId, outcome });
    },
    listExistingTargets: async () => [...existing],
    queueJob: async ({ sourceId, targetUrl, key }) => {
      calls.queued.push({ key, targetUrl });
      const job = {
        id: `job-${calls.queued.length}`,
        // Jobs are "created" by this run unless the key already existed.
        createdAt: existing.some((row) => row.idempotency_key === key)
          ? new Date(now - 3_600_000).toISOString()
          : new Date(now + 1_000).toISOString(),
      };
      existing.push({ target_url: targetUrl, idempotency_key: key });
      return { id: job.id, createdAt: job.createdAt };
    },
  };
  return { store, calls, finished, existing };
}

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const DISCOVERY_ID = "22222222-2222-4222-8222-222222222222";

function discoverySource(overrides: Partial<DiscoverySourceRow> = {}) {
  return {
    id: DISCOVERY_ID,
    workspace_id: "33333333-3333-4333-8333-333333333333",
    name: "Toronto SMBs",
    adapter_id: "overpass",
    geo_params: DiscoveryGeoInputSchema.parse({ city: "Toronto" }),
    source_id: SOURCE_ID,
    campaign_id: null,
    active: true,
    ...overrides,
  } satisfies DiscoverySourceRow;
}

function stubAdapter(candidates: Candidate[]) {
  return {
    overpass: {
      id: "overpass",
      fetchCandidates: vi.fn().mockResolvedValue(candidates),
    },
  };
}

describe("runDiscoveryRun", () => {
  it("enqueues website candidates, skipping no-website and duplicates", async () => {
    const { store, calls, finished } = makeStore(discoverySource());
    const candidates: Candidate[] = [
      {
        name: "A",
        website: "https://a.example",
        address: null,
        lat: 1,
        lng: 1,
        category: "plumber",
        source: "overpass",
      },
      {
        name: "B",
        website: "https://www.b.example/",
        address: null,
        lat: 1,
        lng: 1,
        category: "bakery",
        source: "overpass",
      },
      {
        name: "NoSite",
        website: null,
        address: null,
        lat: 1,
        lng: 1,
        category: "shop",
        source: "overpass",
      },
      {
        name: "Dupe",
        website: "https://a.example/",
        address: null,
        lat: 1,
        lng: 1,
        category: "plumber",
        source: "overpass",
      },
      {
        name: "BadUrl",
        website: "ftp://bad.example",
        address: null,
        lat: 1,
        lng: 1,
        category: "shop",
        source: "overpass",
      },
    ];
    const adapters = stubAdapter(candidates);
    const summary = await runDiscoveryRun({
      store,
      adapters,
      discoverySourceId: DISCOVERY_ID,
    });
    expect(adapters.overpass.fetchCandidates).toHaveBeenCalledTimes(1);
    expect(summary.status).toBe("completed");
    expect(summary.candidatesFound).toBe(3);
    expect(summary.candidatesEnqueued).toBe(2);
    expect(summary.skippedNoWebsite).toBe(2);
    expect(summary.skippedDuplicate).toBe(1);
    expect(calls.queued.map((call) => call.key).sort()).toEqual([
      `discovery:${SOURCE_ID}:https://a.example`,
      `discovery:${SOURCE_ID}:https://b.example`,
    ]);
    expect(finished).toHaveLength(1);
    expect(finished[0].outcome).toMatchObject({
      status: "completed",
      candidatesFound: 3,
      candidatesEnqueued: 2,
      error: null,
    });
  });
  it("dedupes against already-enqueued targets on repeat runs", async () => {
    const { store, existing } = makeStore(discoverySource());
    existing.push({
      target_url: "https://a.example",
      idempotency_key: `discovery:${SOURCE_ID}:https://a.example`,
    });
    const summary = await runDiscoveryRun({
      store,
      adapters: stubAdapter([
        {
          name: "A",
          website: "https://a.example",
          address: null,
          lat: 1,
          lng: 1,
          category: "shop",
          source: "overpass",
        },
      ]),
      discoverySourceId: DISCOVERY_ID,
    });
    expect(summary.candidatesFound).toBe(1);
    expect(summary.candidatesEnqueued).toBe(0);
    expect(summary.skippedDuplicate).toBe(1);
  });
  it("counts a pre-existing idempotency key as a duplicate", async () => {
    const { store, existing } = makeStore(discoverySource());
    // Same key already used by an earlier job with a differently-cased URL.
    existing.push({
      target_url: "https://WWW.a.example/",
      idempotency_key: `discovery:${SOURCE_ID}:https://a.example`,
    });
    const summary = await runDiscoveryRun({
      store,
      adapters: stubAdapter([
        {
          name: "A",
          website: "https://a.example",
          address: null,
          lat: 1,
          lng: 1,
          category: "shop",
          source: "overpass",
        },
      ]),
      discoverySourceId: DISCOVERY_ID,
    });
    expect(summary.candidatesEnqueued).toBe(0);
    expect(summary.skippedDuplicate).toBe(1);
  });
  it("records a failed run when the adapter fails", async () => {
    const { store, finished } = makeStore(discoverySource());
    const adapters = {
      overpass: {
        id: "overpass",
        fetchCandidates: vi
          .fn()
          .mockRejectedValue(new DiscoveryUpstreamError("Overpass down")),
      },
    };
    await expect(
      runDiscoveryRun({ store, adapters, discoverySourceId: DISCOVERY_ID }),
    ).rejects.toBeInstanceOf(DiscoveryUpstreamError);
    expect(finished).toHaveLength(1);
    expect(finished[0].outcome).toMatchObject({
      status: "failed",
      error: "Overpass down",
    });
  });
  it("rejects unknown, inactive, and misconfigured sources", async () => {
    const { store } = makeStore(discoverySource());
    await expect(
      runDiscoveryRun({
        store,
        adapters: stubAdapter([]),
        discoverySourceId: "nope",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const inactive = makeStore(discoverySource({ active: false }));
    await expect(
      runDiscoveryRun({
        store: inactive.store,
        adapters: stubAdapter([]),
        discoverySourceId: DISCOVERY_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const badAdapter = makeStore(discoverySource({ adapter_id: "scraper-x" }));
    await expect(
      runDiscoveryRun({
        store: badAdapter.store,
        adapters: stubAdapter([]),
        discoverySourceId: DISCOVERY_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
  it("respects maxCandidates", async () => {
    const { store, calls } = makeStore(discoverySource());
    const many: Candidate[] = Array.from({ length: 10 }, (_, i) => ({
      name: `Shop ${i}`,
      website: `https://shop-${i}.example`,
      address: null,
      lat: 1,
      lng: 1,
      category: "shop",
      source: "overpass",
    }));
    const summary = await runDiscoveryRun({
      store,
      adapters: stubAdapter(many),
      discoverySourceId: DISCOVERY_ID,
      maxCandidates: 3,
    });
    expect(summary.candidatesEnqueued).toBe(3);
    expect(calls.queued).toHaveLength(3);
  });
});
