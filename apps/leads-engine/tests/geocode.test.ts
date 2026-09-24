import { beforeEach, describe, expect, it } from "vitest";
import {
  collectUrl,
  createMemoryGeocodeCache,
  extractAddress,
  geocodeAddress,
  normalizeAddress,
  resetGeocodeCacheAdapter,
  resetGeocodeThrottle,
  type CollectionPolicy,
  type GeocodeCacheAdapter,
} from "../api/_lib/collection";

const testPolicy: CollectionPolicy = {
  allowedDomains: ["example.com"],
  allowlistPaths: [],
  denylistPaths: [],
  userAgent: "RaphahTestBot/1.0",
  contactEmail: "ops@example.com",
  rateLimitRps: 10,
  maxBytes: 1_000_000,
  timeoutMs: 5000,
  respectRobots: false,
  collectionMethod: "static_html",
};

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

interface MockFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  calls: Array<{ url: string; init?: RequestInit }>;
}

/** Routes by URL; no live network. Records every request. */
function createMockFetcher(
  handler: (url: URL, init?: RequestInit) => Response,
): MockFetch {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    calls.push({ url: url.toString(), init });
    return handler(url, init);
  }) as MockFetch;
  fn.calls = calls;
  return fn;
}

const NOMINATIM_FIXTURE = [
  {
    place_id: 123,
    lat: "43.6532",
    lon: "-79.3832",
    display_name: "123 Main Street, Toronto, Ontario, Canada",
  },
];

function nominatimResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  resetGeocodeThrottle();
  resetGeocodeCacheAdapter();
});

describe("extractAddress", () => {
  it("extracts a street address with city, province, and postal code", () => {
    expect(
      extractAddress(
        "Acme Plumbing. Visit us at 123 Main Street, Toronto, ON M4B 1B3. Call today.",
      ),
    ).toBe("123 Main Street, Toronto, ON M4B 1B3");
  });

  it("extracts an address without city or postal code", () => {
    expect(extractAddress("Our shop: 456 Queen Ave. Open daily.")).toBe(
      "456 Queen Ave.",
    );
  });

  it("extracts a US-style address with ZIP code", () => {
    expect(extractAddress("HQ: 789 Elm Drive, Austin, TX 78701.")).toBe(
      "789 Elm Drive, Austin, TX 78701",
    );
  });

  it("returns null when no street address is present", () => {
    expect(
      extractAddress("Call us at 555-1234 or email hello@example.com."),
    ).toBeNull();
  });
});

describe("normalizeAddress", () => {
  it("produces a stable, punctuation-free cache key", () => {
    expect(normalizeAddress("123 Main Street, Toronto, ON M4B 1B3")).toBe(
      "123 main street toronto on m4b 1b3",
    );
    expect(normalizeAddress("  123   Main STREET, Toronto ")).toBe(
      "123 main street toronto",
    );
  });
});

describe("geocodeAddress", () => {
  it("resolves coordinates from a Nominatim fixture on cache miss", async () => {
    const fetcher = createMockFetcher((url) => {
      expect(url.hostname).toBe("nominatim.openstreetmap.org");
      expect(url.searchParams.get("q")).toBe("123 Main Street, Toronto");
      return nominatimResponse(NOMINATIM_FIXTURE);
    });
    const coords = await geocodeAddress("123 Main Street, Toronto", {
      fetcher,
    });
    expect(coords).toEqual({ latitude: 43.6532, longitude: -79.3832 });
  });

  it("is cache-first: a cached address never hits the network", async () => {
    const cache = createMemoryGeocodeCache();
    await cache.set(normalizeAddress("123 Main Street, Toronto"), {
      latitude: 1,
      longitude: 2,
    });
    let fetchCount = 0;
    const fetcher = createMockFetcher(() => {
      fetchCount += 1;
      return nominatimResponse(NOMINATIM_FIXTURE);
    });
    const coords = await geocodeAddress("123 Main Street, Toronto", {
      cache,
      fetcher,
    });
    expect(coords).toEqual({ latitude: 1, longitude: 2 });
    expect(fetchCount).toBe(0);
  });

  it("populates the cache after a miss so the second call is free", async () => {
    const cache = createMemoryGeocodeCache();
    let fetchCount = 0;
    const fetcher = createMockFetcher(() => {
      fetchCount += 1;
      return nominatimResponse(NOMINATIM_FIXTURE);
    });
    await geocodeAddress("123 Main Street, Toronto", { cache, fetcher });
    await geocodeAddress("123 Main Street, Toronto", { cache, fetcher });
    expect(fetchCount).toBe(1);
  });

  it("sends a proper User-Agent identifying the collector", async () => {
    const fetcher = createMockFetcher(() => nominatimResponse(NOMINATIM_FIXTURE));
    await geocodeAddress("123 Main Street, Toronto", {
      fetcher,
      userAgent: "RaphahTestBot/1.0 (ops@example.com)",
    });
    const headers = new Headers(fetcher.calls[0]?.init?.headers);
    expect(headers.get("user-agent")).toBe("RaphahTestBot/1.0 (ops@example.com)");
  });

  it("throttles to at most 1 request/second between misses", async () => {
    const sleeps: number[] = [];
    let nowMs = 10_000;
    const fetcher = createMockFetcher(() => nominatimResponse(NOMINATIM_FIXTURE));
    const options = {
      fetcher,
      cache: createMemoryGeocodeCache(),
      now: () => nowMs,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    };
    await geocodeAddress("123 Main Street, Toronto", options);
    nowMs += 100;
    await geocodeAddress("456 Other Avenue, Ottawa", options);
    expect(sleeps).toEqual([900]);
  });

  it("fails gracefully: HTTP error, bad payload, empty results, bad coords", async () => {
    const cases: Array<{ name: string; response: () => Response }> = [
      { name: "http 500", response: () => nominatimResponse({}, 500) },
      {
        name: "invalid json",
        response: () =>
          new Response("not json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
      { name: "empty results", response: () => nominatimResponse([]) },
      {
        name: "out-of-range coords",
        response: () => nominatimResponse([{ lat: "999", lon: "0" }]),
      },
      {
        name: "network throw",
        response: () => {
          throw new Error("boom");
        },
      },
    ];
    for (const { name, response } of cases) {
      const fetcher = createMockFetcher(response);
      await expect(
        geocodeAddress("123 Main Street, Toronto", {
          fetcher,
          cache: createMemoryGeocodeCache(),
        }),
      ).resolves.toBeNull();
    }
  });

  it("does not poison the cache with failed lookups", async () => {
    const cache: GeocodeCacheAdapter = {
      get: async () => null,
      set: async () => {
        throw new Error("cache down");
      },
    };
    const fetcher = createMockFetcher(() => nominatimResponse(NOMINATIM_FIXTURE));
    // A good geocode result is still returned even when the cache write fails.
    await expect(
      geocodeAddress("123 Main Street, Toronto", { fetcher, cache }),
    ).resolves.toEqual({ latitude: 43.6532, longitude: -79.3832 });
  });
});

const GEO_HOMEPAGE = (body: string, head = "") => `<!DOCTYPE html>
<html><head><title>Acme</title>${head}</head>
<body>${body}</body></html>`;

describe("collectUrl geocode enrichment", () => {
  it("keeps embedded JSON-LD coordinates and never calls Nominatim", async () => {
    let nominatimCalls = 0;
    const fetcher = createMockFetcher((url) => {
      if (url.hostname === "nominatim.openstreetmap.org") {
        nominatimCalls += 1;
        return nominatimResponse(NOMINATIM_FIXTURE);
      }
      return htmlResponse(
        GEO_HOMEPAGE(
          "<p>Visit us at 123 Main Street, Toronto, ON M4B 1B3.</p>",
          `<script type="application/ld+json">{"@type":"LocalBusiness","geo":{"latitude":43.7,"longitude":-79.4}}</script>`,
        ),
      );
    });
    const collected = await collectUrl("https://example.com/", testPolicy, fetcher, {
      skipPublicHostCheck: true,
    });
    expect(collected.coordinates).toEqual({ latitude: 43.7, longitude: -79.4 });
    expect(collected.coordinatesSource).toBe("embedded");
    expect(nominatimCalls).toBe(0);
  });

  it("geocodes an extracted address when the site has no coordinates", async () => {
    const fetcher = createMockFetcher((url) => {
      if (url.hostname === "nominatim.openstreetmap.org")
        return nominatimResponse(NOMINATIM_FIXTURE);
      return htmlResponse(
        GEO_HOMEPAGE("<p>Visit us at 123 Main Street, Toronto, ON M4B 1B3.</p>"),
      );
    });
    const collected = await collectUrl("https://example.com/", testPolicy, fetcher, {
      skipPublicHostCheck: true,
    });
    expect(collected.coordinates).toEqual({
      latitude: 43.6532,
      longitude: -79.3832,
    });
    expect(collected.coordinatesSource).toBe("geocoded");
    const nominatimCall = fetcher.calls.find((call) =>
      call.url.includes("nominatim.openstreetmap.org"),
    );
    expect(nominatimCall).toBeDefined();
    const userAgent = new Headers(nominatimCall?.init?.headers).get("user-agent");
    expect(userAgent).toBe("RaphahTestBot/1.0 (ops@example.com)");
  });

  it("leaves coordinates unset when no address is found", async () => {
    let nominatimCalls = 0;
    const fetcher = createMockFetcher((url) => {
      if (url.hostname === "nominatim.openstreetmap.org") {
        nominatimCalls += 1;
        return nominatimResponse(NOMINATIM_FIXTURE);
      }
      return htmlResponse(GEO_HOMEPAGE("<p>We are fully remote.</p>"));
    });
    const collected = await collectUrl("https://example.com/", testPolicy, fetcher, {
      skipPublicHostCheck: true,
    });
    expect(collected.coordinates).toBeUndefined();
    expect(collected.coordinatesSource).toBeUndefined();
    expect(nominatimCalls).toBe(0);
  });

  it("skips geocoding entirely when disabled", async () => {
    let nominatimCalls = 0;
    const fetcher = createMockFetcher((url) => {
      if (url.hostname === "nominatim.openstreetmap.org") {
        nominatimCalls += 1;
        return nominatimResponse(NOMINATIM_FIXTURE);
      }
      return htmlResponse(
        GEO_HOMEPAGE("<p>Visit us at 123 Main Street, Toronto, ON M4B 1B3.</p>"),
      );
    });
    const collected = await collectUrl("https://example.com/", testPolicy, fetcher, {
      skipPublicHostCheck: true,
      geocode: false,
    });
    expect(collected.coordinates).toBeUndefined();
    expect(nominatimCalls).toBe(0);
  });
});
