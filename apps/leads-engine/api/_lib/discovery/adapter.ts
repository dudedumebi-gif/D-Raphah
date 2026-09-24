import { z } from "zod";

/**
 * A single business discovered by an adapter: a website that may become a
 * scrape target plus the evidence that identified it.
 */
export interface Candidate {
  name: string | null;
  website: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  category: string | null;
  /** Adapter that produced the candidate (e.g. "overpass"). */
  source: string;
}

/**
 * Resolved geographic query for a discovery run. Mirrors the radius-mode
 * geography in LeadCriteria (domain.ts) but flattened: a discovery run always
 * executes against one centre point + radius.
 */
export interface GeoQuery {
  city: string;
  region: string;
  centreLatitude: number;
  centreLongitude: number;
  radiusKm: number;
}

export interface FetchCandidatesOptions {
  /** Injectable fetch; tests pass a mock so no live network is touched. */
  fetcher?: typeof fetch;
}

export interface DiscoveryAdapter {
  id: string;
  fetchCandidates(
    geo: GeoQuery,
    options?: FetchCandidatesOptions,
  ): Promise<Candidate[]>;
}

/** Upstream discovery failure (e.g. Overpass down or rate limited). */
export class DiscoveryUpstreamError extends Error {
  readonly statusCode = 502;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DiscoveryUpstreamError";
  }
}

/**
 * City presets matching the LeadCriteria defaults (Toronto/Ottawa/Montreal).
 * A source may override the centre coordinates explicitly.
 */
export const DISCOVERY_CITY_DEFAULTS: Record<
  string,
  { region: string; centreLatitude: number; centreLongitude: number }
> = {
  Toronto: {
    region: "Ontario",
    centreLatitude: 43.6532,
    centreLongitude: -79.3832,
  },
  Ottawa: {
    region: "Ontario",
    centreLatitude: 45.4215,
    centreLongitude: -75.6972,
  },
  Montreal: {
    region: "Quebec",
    centreLatitude: 45.5017,
    centreLongitude: -73.5673,
  },
};

/**
 * Geo parameters accepted when registering a discovery source. Centre
 * coordinates are optional when the city has a known preset.
 */
export const DiscoveryGeoInputSchema = z.object({
  city: z.string().min(1).max(120).default("Toronto"),
  region: z.string().min(1).max(120).optional(),
  centreLatitude: z.number().min(-90).max(90).optional(),
  centreLongitude: z.number().min(-180).max(180).optional(),
  radiusKm: z.number().min(1).max(500).default(50),
});

export type DiscoveryGeoInput = z.infer<typeof DiscoveryGeoInputSchema>;

/** Resolve input (with optional preset lookup) into a concrete GeoQuery. */
export function resolveGeoQuery(input: DiscoveryGeoInput): GeoQuery {
  const preset = DISCOVERY_CITY_DEFAULTS[input.city];
  const centreLatitude = input.centreLatitude ?? preset?.centreLatitude;
  const centreLongitude = input.centreLongitude ?? preset?.centreLongitude;
  if (centreLatitude === undefined || centreLongitude === undefined) {
    throw new Error(
      `Unknown city "${input.city}": provide centreLatitude and centreLongitude`,
    );
  }
  return {
    city: input.city,
    region: input.region ?? preset?.region ?? "",
    centreLatitude,
    centreLongitude,
    radiusKm: input.radiusKm,
  };
}

export interface BoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Approximate bounding box for a centre + radius (degrees). */
export function geoBoundingBox(geo: GeoQuery): BoundingBox {
  const latDelta = geo.radiusKm / 111.0;
  const lngDelta =
    geo.radiusKm /
    (111.0 * Math.cos((geo.centreLatitude * Math.PI) / 180 || 1e-9));
  return {
    south: geo.centreLatitude - latDelta,
    west: geo.centreLongitude - lngDelta,
    north: geo.centreLatitude + latDelta,
    east: geo.centreLongitude + lngDelta,
  };
}

/**
 * Canonicalize a website for dedupe. Returns null for values that can never
 * be scrape targets (empty, non-http(s), unparseable).
 */
export function normalizeWebsiteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL | null = null;
  for (const candidate of [trimmed, `https://${trimmed}`]) {
    try {
      parsed = new URL(candidate);
      break;
    } catch {
      // try next form
    }
  }
  if (!parsed) return null;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return null;
  const bare = host.replace(/^www\./, "");
  const path = parsed.pathname.replace(/\/+$/, "");
  return `https://${bare}${path}`;
}
