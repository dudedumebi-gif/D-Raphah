import { z } from "zod";
import {
  DiscoveryUpstreamError,
  geoBoundingBox,
  type Candidate,
  type DiscoveryAdapter,
  type FetchCandidatesOptions,
  type GeoQuery,
} from "./adapter.js";

/**
 * Overpass adapter configuration (stored on the discovery source).
 * "clinics" narrows the query to clinic-type objects so a bounded
 * run's candidate slice is spent on the target vertical instead of
 * every shop/office/amenity with a website (clinic sprint build C2).
 */
export const OverpassAdapterConfigSchema = z.object({
  categoryPreset: z.enum(["all", "clinics"]).default("all"),
});
export type OverpassAdapterConfig = z.infer<
  typeof OverpassAdapterConfigSchema
>;

/**
 * Clinic preset tag filters: dental, medical and wellness clinics as
 * tagged in OpenStreetMap — amenity values plus the healthcare key
 * (clinic / dentist / doctor / physiotherapist / centre). Every
 * filter still requires a website tag.
 */
const CLINIC_TAG_FILTERS = [
  '["amenity"="dentist"]',
  '["amenity"="clinic"]',
  '["amenity"="doctors"]',
  '["healthcare"~"^(clinic|dentist|doctor|physiotherapist|centre)$"]',
];

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
 * One Overpass QL statement per discovery run. Default preset: all
 * shop/office/amenity objects WITH a website tag inside the geo
 * bounding box. Clinics preset: clinic-type objects only.
 */
export function buildOverpassQuery(
  geo: GeoQuery,
  categoryPreset: OverpassAdapterConfig["categoryPreset"] = "all",
): string {
  const { south, west, north, east } = geoBoundingBox(geo);
  const bbox = [south, west, north, east]
    .map((value) => value.toFixed(5))
    .join(",");
  const filters =
    categoryPreset === "clinics"
      ? CLINIC_TAG_FILTERS
      : ["shop", "office", "amenity"].map((tag) => `["${tag}"]`);
  const selectors = filters
    .map(
      (filter) =>
        `node${filter}["website"](${bbox});\n` +
        `  way${filter}["website"](${bbox});\n` +
        `  relation${filter}["website"](${bbox});`,
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
    externalId: `${element.type}:${element.id}`,
    name: tags.name ?? null,
    website: tags.website ?? null,
    address: buildAddress(tags),
    lat: typeof coords.lat === "number" ? coords.lat : null,
    lng: typeof coords.lon === "number" ? coords.lon : null,
    category:
      tags.shop ?? tags.office ?? tags.healthcare ?? tags.amenity ?? null,
    source: "overpass",
    sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    observedAt: new Date().toISOString(),
    evidenceText: Object.entries(tags)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n"),
    rawRecord: tags,
  };
}

export class OverpassAdapter implements DiscoveryAdapter {
  readonly id = "overpass";

  async fetchCandidates(
    geo: GeoQuery,
    options: FetchCandidatesOptions = {},
  ): Promise<Candidate[]> {
    const config = OverpassAdapterConfigSchema.parse(options.config ?? {});
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
        body: `data=${encodeURIComponent(buildOverpassQuery(geo, config.categoryPreset))}`,
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
