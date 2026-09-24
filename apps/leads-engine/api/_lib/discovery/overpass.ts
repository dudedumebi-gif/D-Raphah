import {
  DiscoveryUpstreamError,
  geoBoundingBox,
  type Candidate,
  type DiscoveryAdapter,
  type FetchCandidatesOptions,
  type GeoQuery,
} from "./adapter.js";

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
/** Overpass fair-use: a single query per run, bounded wait, identified UA. */
const OVERPASS_TIMEOUT_MS = 60_000;
const USER_AGENT = "RaphahLeadEngine-Discovery/1.0 (+https://raphah.io)";

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * One Overpass QL statement per discovery run: all shop/office/amenity
 * objects WITH a website tag inside the geo bounding box.
 */
export function buildOverpassQuery(geo: GeoQuery): string {
  const { south, west, north, east } = geoBoundingBox(geo);
  const bbox = [south, west, north, east]
    .map((value) => value.toFixed(5))
    .join(",");
  const selectors = ["shop", "office", "amenity"]
    .map(
      (tag) =>
        `node["${tag}"]["website"](${bbox});\n` +
        `  way["${tag}"]["website"](${bbox});\n` +
        `  relation["${tag}"]["website"](${bbox});`,
    )
    .join("\n  ");
  return `[out:json][timeout:60];\n(\n  ${selectors}\n);\nout center;`;
}

function buildAddress(tags: Record<string, string>): string | null {
  const street = [tags["addr:housenumber"], tags["addr:street"]]
    .filter(Boolean)
    .join(" ");
  const parts = [
    street || null,
    tags["addr:city"] ?? null,
    tags["addr:postcode"] ?? null,
    tags["addr:country"] ?? null,
  ].filter((part): part is string => part !== null && part !== "");
  return parts.length > 0 ? parts.join(", ") : null;
}

export function overpassElementToCandidate(
  element: OverpassElement,
): Candidate {
  const tags = element.tags ?? {};
  const coords =
    element.type === "node"
      ? { lat: element.lat, lon: element.lon }
      : element.center
        ? { lat: element.center.lat, lon: element.center.lon }
        : { lat: undefined, lon: undefined };
  return {
    name: tags.name ?? null,
    website: tags.website ?? null,
    address: buildAddress(tags),
    lat: typeof coords.lat === "number" ? coords.lat : null,
    lng: typeof coords.lon === "number" ? coords.lon : null,
    category: tags.shop ?? tags.office ?? tags.amenity ?? null,
    source: "overpass",
  };
}

export class OverpassAdapter implements DiscoveryAdapter {
  readonly id = "overpass";

  async fetchCandidates(
    geo: GeoQuery,
    options: FetchCandidatesOptions = {},
  ): Promise<Candidate[]> {
    const fetcher = options.fetcher ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetcher(OVERPASS_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": USER_AGENT,
          accept: "application/json",
        },
        body: `data=${encodeURIComponent(buildOverpassQuery(geo))}`,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError")
        throw new DiscoveryUpstreamError(
          "Overpass request timed out after 60s",
          { cause: error },
        );
      throw new DiscoveryUpstreamError(
        `Overpass request failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new DiscoveryUpstreamError(
        `Overpass responded with HTTP ${response.status}`,
      );
    }
    let payload: { elements?: OverpassElement[] };
    try {
      payload = (await response.json()) as { elements?: OverpassElement[] };
    } catch (error) {
      throw new DiscoveryUpstreamError("Overpass returned invalid JSON", {
        cause: error,
      });
    }
    return (payload.elements ?? []).map(overpassElementToCandidate);
  }
}
