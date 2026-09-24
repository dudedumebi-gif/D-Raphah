import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { canonicalizeUrl, contentHash, normalizeText } from "./domain.js";

export interface CollectionPolicy {
  allowedDomains: string[];
  allowlistPaths: string[];
  denylistPaths: string[];
  userAgent: string;
  contactEmail: string;
  rateLimitRps: number;
  maxBytes: number;
  timeoutMs: number;
  respectRobots: boolean;
  collectionMethod: string;
}

export interface CollectionResult {
  canonicalUrl: string;
  finalUrl: string;
  statusCode: number;
  contentType: string;
  rawContent: string;
  extractedText: string;
  extractedTitle: string | null;
  extractedOrganization: string | null;
  contentHash: string;
  bytesDownloaded: number;
  robotsDecision: "allowed" | "not_checked";
  fetchedAt: string;
  coordinates?: { latitude: number; longitude: number };
  /**
   * How coordinates were obtained: "embedded" from JSON-LD/API payloads,
   * "geocoded" from address extraction + Nominatim (lead-vision gap 5).
   * Absent when no coordinates could be resolved.
   */
  coordinatesSource?: "embedded" | "geocoded";
}

export function extractCoordinates(
  raw: string,
  contentType: string,
): CollectionResult["coordinates"] {
  const candidates: Array<{ latitude: number; longitude: number }> = [];
  function visit(value: unknown, depth = 0): void {
    if (!value || typeof value !== "object" || depth > 12) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    const record = value as Record<string, unknown>;
    const geo = record.geo as Record<string, unknown> | undefined;
    if (
      geo &&
      typeof geo === "object" &&
      geo.latitude != null &&
      geo.longitude != null
    ) {
      const latitude = Number(geo.latitude),
        longitude = Number(geo.longitude);
      if (
        Number.isFinite(latitude) &&
        Math.abs(latitude) <= 90 &&
        Number.isFinite(longitude) &&
        Math.abs(longitude) <= 180
      )
        candidates.push({ latitude, longitude });
    }
    for (const nested of Object.values(record)) visit(nested, depth + 1);
  }
  const blocks = contentType.includes("json")
    ? [raw]
    : [
        ...raw.matchAll(
          /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
        ),
      ].map((match) => match[1]);
  for (const block of blocks) {
    try {
      visit(JSON.parse(block));
    } catch {
      /* Invalid structured data is not location evidence. */
    }
  }
  const unique = new Map(
    candidates.map((item) => [`${item.latitude},${item.longitude}`, item]),
  );
  // Multiple branch coordinates are ambiguous; do not guess which business is targeted.
  return unique.size === 1 ? [...unique.values()][0] : undefined;
}

// ---------------------------------------------------------------------------
// Evidence enrichment (lead-vision gaps 4 & 5).
//
// The collector captures tech-stack fingerprint artifacts (response headers,
// <meta name="generator">, <script src> values), discovers and fetches a
// bounded set of careers/jobs pages, and resolves street addresses to
// coordinates via Nominatim. Fingerprint and job evidence is appended to the
// collected text as marked lines so it flows through the existing
// detectSignals() -> scoreSignals() pipeline unchanged; geocoded coordinates
// fill CollectionResult.coordinates only when no embedded coordinates were
// found, so sites that already carried coordinates behave exactly as before.
// ---------------------------------------------------------------------------

/** Maximum careers/jobs pages fetched per homepage scrape (page budget). */
export const MAX_JOB_PAGES = 2;

export interface PageFingerprint {
  /** Value of <meta name="generator">, when present. */
  metaGenerator: string | null;
  /** Selected response headers, keyed by lowercased header name. */
  headers: Record<string, string>;
  /** Every <script src> value found in the HTML. */
  scriptSrcs: string[];
}

const FINGERPRINT_HEADER_NAMES = [
  "server",
  "x-powered-by",
  "x-generator",
  "x-aspnet-version",
  "x-aspnetmvc-version",
] as const;

export function fingerprintPage(
  html: string,
  headers: Record<string, string>,
): PageFingerprint {
  const lowered: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers))
    lowered[name.toLowerCase()] = value;
  const picked: Record<string, string> = {};
  for (const name of FINGERPRINT_HEADER_NAMES) {
    const value = lowered[name];
    if (value) picked[name] = value;
  }
  const metaGenerator =
    /<meta\b[^>]*\bname=["']generator["'][^>]*\bcontent=["']([^"']+)["']/i.exec(
      html,
    )?.[1] ??
    /<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bname=["']generator["']/i.exec(
      html,
    )?.[1] ??
    null;
  const scriptSrcs = [
    ...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi),
  ].map((match) => match[1]);
  return { metaGenerator, headers: picked, scriptSrcs };
}

/**
 * Renders fingerprint artifacts as marked evidence lines. The fp_* signal
 * rules in domain.ts match these lines; each excerpt cites the concrete
 * artifact (header value, generator string, or script URL).
 */
export function fingerprintEvidenceLines(
  fingerprint: PageFingerprint,
): string[] {
  const lines: string[] = [];
  if (fingerprint.metaGenerator)
    lines.push(
      `[tech-fingerprint] meta-generator: ${fingerprint.metaGenerator}`,
    );
  for (const [name, value] of Object.entries(fingerprint.headers))
    lines.push(`[tech-fingerprint] header: ${name}: ${value}`);
  for (const src of fingerprint.scriptSrcs)
    lines.push(`[tech-fingerprint] script-src: ${src}`);
  return lines;
}

const JOB_PATH_PATTERN = /\b(careers?|jobs?|join[-\s]?us|work[-\s]?with[-\s]?us)\b/i;

const JOB_BOARD_DOMAINS = [
  "lever.co",
  "greenhouse.io",
  "workable.com",
  "jobvite.com",
  "icims.com",
  "smartrecruiters.com",
] as const;

const MANUAL_ROLE_PHRASES = [
  "data entry",
  "receptionist",
  "file clerk",
  "administrative assistant",
  "office assistant",
  "manual filing",
] as const;

/**
 * Discovers careers/jobs pages linked from the homepage. Same-host links only
 * (cross-host links cannot be fetched under the source policy anyway);
 * returns at most MAX_JOB_PAGES canonicalized URLs in document order.
 */
export function discoverJobPageUrls(html: string, baseUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const href = match[1].trim();
    if (!href || href.startsWith("#")) continue;
    // Skip non-navigational schemes; http(s) (absolute or relative) only.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^https?:/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.hostname.toLowerCase() !== base.hostname.toLowerCase()) continue;
    const anchorText = stripHtml(match[2] ?? "");
    if (
      !JOB_PATH_PATTERN.test(url.pathname) &&
      !JOB_PATH_PATTERN.test(anchorText)
    )
      continue;
    let key: string;
    try {
      key = canonicalizeUrl(url.toString());
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(key);
    if (found.length >= MAX_JOB_PAGES) break;
  }
  return found;
}

/** Detects embedded job-board widgets (script, iframe, or link references). */
export function detectJobBoards(html: string): string[] {
  const references = [
    ...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi),
    ...html.matchAll(/<iframe\b[^>]*\bsrc=["']([^"']+)["']/gi),
    ...html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi),
  ].map((match) => match[1].toLowerCase());
  return JOB_BOARD_DOMAINS.filter((board) =>
    references.some((reference) => reference.includes(board)),
  );
}

/** Finds manual-role hiring phrases in job-page text. */
export function detectHiringRoles(text: string): string[] {
  const lowered = ` ${text.toLowerCase()} `;
  return MANUAL_ROLE_PHRASES.filter((phrase) => lowered.includes(phrase));
}

const STREET_SUFFIX =
  "(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|circle|cir|place|pl|terrace|ter|parkway|pkwy|trail|square|sq)";

const POSTAL_CODE = "(?:[A-Z]\\d[A-Z]\\s?\\d[A-Z]\\d|\\d{5}(?:-\\d{4})?)";

// Street line: number + name + recognized suffix. Case-insensitive, with a
// lookahead so "St" cannot match inside "Styx".
const STREET_RE = new RegExp(
  `\\b\\d{1,5}\\s+[A-Za-z0-9][\\w.'-]*(?:\\s+[A-Za-z][\\w.'-]*){0,4}\\s+${STREET_SUFFIX}\\.?(?![A-Za-z])`,
  "i",
);

// Address tail, anchored right after the street line. Deliberately NOT
// case-insensitive: a state/province code must be truly uppercase ("ON"),
// otherwise trailing prose ("Open daily.") would be swallowed as a city.
const ADDRESS_TAIL_RE = new RegExp(
  `^(?:` +
    `\\s*,\\s*[A-Za-z][\\w.'-]*(?:\\s+[A-Za-z][\\w.'-]*){0,2}(?:\\s*,?\\s*[A-Z]{2})?(?:\\s*${POSTAL_CODE})?` +
    `|\\s+[A-Z]{2}(?:\\s*${POSTAL_CODE})?` +
    `|\\s*${POSTAL_CODE}` +
    `)`,
);

/**
 * Extracts the first plausible street address from page text. Heuristic and
 * conservative: requires a street number plus a recognized street suffix,
 * and the tail only extends the match over a comma-separated city, an
 * uppercase state/province code, or a postal code.
 */
export function extractAddress(text: string): string | null {
  const street = STREET_RE.exec(text);
  if (!street) return null;
  const tail = ADDRESS_TAIL_RE.exec(
    text.slice(street.index + street[0].length),
  );
  return normalizeText(street[0] + (tail ? tail[0] : ""));
}

/** Cache key for the geocode_cache table: case/whitespace/punctuation free. */
export function normalizeAddress(address: string): string {
  return address
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface GeocodeCoordinates {
  latitude: number;
  longitude: number;
}

/**
 * Cache adapter for geocode results. Production wiring installs a
 * Neon-backed adapter over the geocode_cache table (see
 * neon/migrations/202609240001_geocode_cache.sql); the default is an
 * in-process memory cache.
 */
export interface GeocodeCacheAdapter {
  get(
    normalizedAddress: string,
  ): Promise<GeocodeCoordinates | null>;
  set(
    normalizedAddress: string,
    coords: GeocodeCoordinates,
  ): Promise<void>;
}

export function createMemoryGeocodeCache(): GeocodeCacheAdapter {
  const store = new Map<string, GeocodeCoordinates>();
  return {
    get: async (key) => store.get(key) ?? null,
    set: async (key, coords) => {
      store.set(key, { ...coords });
    },
  };
}

let defaultGeocodeCache: GeocodeCacheAdapter = createMemoryGeocodeCache();

/** Installs the process-wide geocode cache adapter (production wiring). */
export function setGeocodeCacheAdapter(adapter: GeocodeCacheAdapter): void {
  defaultGeocodeCache = adapter;
}

/** Test seam: restores the default in-memory geocode cache. */
export function resetGeocodeCacheAdapter(): void {
  defaultGeocodeCache = createMemoryGeocodeCache();
}

export interface GeocodeOptions {
  cache?: GeocodeCacheAdapter;
  fetcher?: typeof fetch;
  userAgent?: string;
  /** Test seams for the 1 req/s politeness throttle. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_MIN_INTERVAL_MS = 1000;
let lastNominatimRequestAt = 0;

/** Test seam: resets the in-process Nominatim request throttle. */
export function resetGeocodeThrottle(): void {
  lastNominatimRequestAt = 0;
}

function validGeocodeCoords(coords: GeocodeCoordinates): boolean {
  return (
    Number.isFinite(coords.latitude) &&
    Number.isFinite(coords.longitude) &&
    Math.abs(coords.latitude) <= 90 &&
    Math.abs(coords.longitude) <= 180
  );
}

/**
 * Resolves a street address to coordinates via Nominatim, cache-first.
 * Best-effort: any failure (cache error, network error, bad payload,
 * no result) returns null instead of throwing, so enrichment can never
 * fail a scrape.
 */
export async function geocodeAddress(
  rawAddress: string,
  options: GeocodeOptions = {},
): Promise<GeocodeCoordinates | null> {
  try {
    const key = normalizeAddress(rawAddress);
    if (!key) return null;
    const cache = options.cache ?? defaultGeocodeCache;
    const cached = await cache.get(key);
    if (cached && validGeocodeCoords(cached)) return cached;

    // Nominatim usage policy: at most 1 request/second, valid User-Agent.
    const now = options.now ?? Date.now;
    const sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const waitMs = NOMINATIM_MIN_INTERVAL_MS - (now() - lastNominatimRequestAt);
    if (waitMs > 0) await sleep(waitMs);

    const fetcher = options.fetcher ?? pinnedFetch;
    const params = new URLSearchParams({
      format: "jsonv2",
      q: rawAddress,
      limit: "1",
      addressdetails: "0",
    });
    const response = await fetcher(`${NOMINATIM_URL}?${params.toString()}`, {
      headers: {
        "user-agent": options.userAgent ?? "RaphahLeadEngine/1.0",
        accept: "application/json",
      },
      redirect: "error",
    });
    lastNominatimRequestAt = now();
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    const first =
      Array.isArray(payload) && payload.length > 0 ? payload[0] : null;
    const coords =
      first && typeof first === "object"
        ? {
            latitude: Number(
              (first as Record<string, unknown>).lat,
            ),
            longitude: Number(
              (first as Record<string, unknown>).lon,
            ),
          }
        : null;
    if (!coords || !validGeocodeCoords(coords)) return null;
    try {
      await cache.set(key, coords);
    } catch {
      // Cache writes are advisory: a good geocode result is still returned.
    }
    return coords;
  } catch {
    return null;
  }
}

function truncateChars(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export interface CollectUrlOptions {
  /** Capture tech-stack fingerprint artifacts. Default true for HTML. */
  fingerprint?: boolean;
  /**
   * Discover and fetch up to MAX_JOB_PAGES careers/jobs pages from the
   * homepage. Default true; job pages never recurse further.
   */
  jobPages?: boolean;
  /**
   * Address -> coordinate enrichment via Nominatim. Enabled by default with
   * the process-wide cache adapter; set false to disable.
   */
  geocode?: GeocodeOptions | false;
  /** Test seam: skip DNS public-host verification (unit tests lack real DNS). */
  skipPublicHostCheck?: boolean;
  /** Internal: recursion depth for job-page fetches. */
  _depth?: number;
}

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^224\./,
  /^240\./,
];

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4)
    return PRIVATE_V4.some((pattern) => pattern.test(address));
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

export async function assertPublicHost(hostname: string): Promise<void> {
  await resolvePublicHost(hostname);
}

/** A DNS-resolved address that passed the public-host policy check. */
export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Resolves a hostname and enforces the public-host policy, returning the
 * verified addresses. This is the single choke point for DNS: every outbound
 * collection request pins to one of these addresses (see pinnedFetch), so a
 * hostile DNS change between check and connect (DNS rebinding / TOCTOU)
 * cannot redirect the connection to a private target.
 */
export async function resolvePublicHost(
  hostname: string,
): Promise<PinnedAddress[]> {
  if (
    ["localhost", "metadata.google.internal"].includes(hostname.toLowerCase())
  )
    throw new Error("Private destinations are prohibited");
  const addresses = (await lookup(hostname, {
    all: true,
    verbatim: true,
  })) as PinnedAddress[];
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateAddress(address))
  ) {
    throw new Error(
      "Destination resolves to a private, loopback, link-local, or reserved address",
    );
  }
  return addresses;
}

/** Builds a node:http(s) `lookup` override that pins to one verified address. */
function pinnedLookup(pinned: PinnedAddress) {
  return (
    _hostname: string,
    options: LookupOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family: number,
    ) => void,
  ): void => {
    // Node's happy-eyeballs path (autoSelectFamily) calls lookup with
    // { all: true } and expects an address array back.
    if (options.all) {
      callback(
        null,
        [{ address: pinned.address, family: pinned.family }],
        pinned.family,
      );
    } else {
      callback(null, pinned.address, pinned.family);
    }
  };
}

// Explicit agents: the pinned `lookup` override must reach net.connect, which
// is not guaranteed through a replaced global agent (egress proxies, sandboxes).
const pinnedHttpAgent = new HttpAgent({ keepAlive: false });
const pinnedHttpsAgent = new HttpsAgent({ keepAlive: false });

function toFetchHeaders(
  raw: NodeJS.Dict<string | string[]>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

/**
 * Creates a fetch-compatible function whose connections are DNS-pinned:
 * the hostname is resolved and policy-checked once per request, and the
 * socket is forced to the verified address via a `lookup` override. The
 * original hostname stays in the request (Host header and TLS SNI), so
 * certificate verification is unaffected. Redirects are never followed
 * automatically — the caller handles them (each hop re-resolves and
 * re-validates).
 */
export function createPinnedFetcher(
  resolver: (hostname: string) => Promise<PinnedAddress[]> = resolvePublicHost,
): typeof fetch {
  return (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("Only HTTP(S) URLs are permitted");
    const [pinned] = await resolver(url.hostname);
    if (!pinned) throw new Error(`No verified address for ${url.hostname}`);

    const headers: Record<string, string> = {};
    const initHeaders = init?.headers;
    if (initHeaders) {
      if (initHeaders instanceof Headers) {
        initHeaders.forEach((value, name) => {
          headers[name] = value;
        });
      } else if (Array.isArray(initHeaders)) {
        for (const [name, value] of initHeaders) headers[name] = value;
      } else {
        Object.assign(headers, initHeaders);
      }
    }
    // Preserve the original host (virtual hosting, TLS SNI) while the
    // connection itself goes to the pinned address via `lookup` below.
    headers.host = url.host;

    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const incoming = await new Promise<import("node:http").IncomingMessage>(
      (resolve, reject) => {
        const req = requestFn(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port ? Number(url.port) : undefined,
            path: `${url.pathname}${url.search}`,
            method: init?.method ?? "GET",
            headers,
            // Explicit agent so the pinned lookup override below reliably
            // reaches the socket layer (a replaced global agent could bypass it).
            agent: url.protocol === "https:" ? pinnedHttpsAgent : pinnedHttpAgent,
            lookup: pinnedLookup(pinned),
            signal: init?.signal as unknown as AbortSignal | undefined,
          },
          resolve,
        );
        req.on("error", reject);
        req.end();
      },
    );
    const status = incoming.statusCode ?? 500;
    const body =
      status === 204 || status === 304
        ? null
        : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
    return new Response(body, {
      status,
      statusText: incoming.statusMessage ?? "",
      headers: toFetchHeaders(incoming.headers),
    });
  }) as typeof fetch;
}

/**
 * Default fetcher for collection: DNS-pinned (see createPinnedFetcher).
 * Tests inject mocks through the `fetcher` parameter instead.
 */
export const pinnedFetch: typeof fetch = createPinnedFetcher();

function domainAllowed(hostname: string, allowedDomains: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedDomains.some((domain) => {
    const allowed = domain.trim().toLowerCase();
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

function globMatches(pathname: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(pathname);
}

export function assertUrlAllowed(
  rawUrl: string,
  policy: CollectionPolicy,
): URL {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Only HTTP(S) sources are permitted");
  if (url.username || url.password)
    throw new Error("URL credentials are prohibited");
  if (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com"))
    throw new Error("Automated LinkedIn collection is prohibited");
  if (!domainAllowed(url.hostname, policy.allowedDomains))
    throw new Error(`Domain ${url.hostname} is not approved`);
  if (
    policy.denylistPaths.some((pattern) => globMatches(url.pathname, pattern))
  )
    throw new Error(`Path ${url.pathname} is denied by source policy`);
  if (
    policy.allowlistPaths.length &&
    !policy.allowlistPaths.some((pattern) => globMatches(url.pathname, pattern))
  ) {
    throw new Error(`Path ${url.pathname} is outside the approved allowlist`);
  }
  return url;
}

function parseRobots(
  content: string,
  pathname: string,
  userAgent: string,
): boolean {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
  let applies = false;
  const relevant: Array<{ type: "allow" | "disallow"; path: string }> = [];
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") {
      applies =
        value === "*" || userAgent.toLowerCase().includes(value.toLowerCase());
      continue;
    }
    if (applies && (key === "allow" || key === "disallow") && value)
      relevant.push({ type: key, path: value });
  }
  const matches = relevant
    .filter((rule) => pathname.startsWith(rule.path))
    .sort((a, b) => b.path.length - a.path.length);
  return matches[0]?.type !== "disallow";
}

async function checkRobots(
  url: URL,
  policy: CollectionPolicy,
  fetcher: typeof fetch,
): Promise<"allowed" | "not_checked"> {
  if (!policy.respectRobots) return "not_checked";
  const robotsUrl = new URL("/robots.txt", url.origin);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.min(policy.timeoutMs, 10_000),
  );
  try {
    const response = await fetcher(robotsUrl, {
      headers: { "user-agent": `${policy.userAgent} (${policy.contactEmail})` },
      signal: controller.signal,
      redirect: "error",
    });
    if (response.status === 404) return "allowed";
    if (!response.ok) throw new Error(`robots.txt returned ${response.status}`);
    const content = await readBoundedBody(
      response,
      Math.min(policy.maxBytes, 512_000),
    );
    if (!parseRobots(content, url.pathname, policy.userAgent))
      throw new Error("robots.txt denies collection for this path");
    return "allowed";
  } finally {
    clearTimeout(timeout);
  }
}

function stripHtml(html: string): string {
  return normalizeText(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#39;/gi, "'")
      .replace(/&quot;/gi, '"'),
  );
}

function extractMeta(html: string, name: string): string | null {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const first = new RegExp(
    `<meta[^>]+(?:property|name)=["']${safe}["'][^>]+content=["']([^"']+)["']`,
    "i",
  ).exec(html);
  const second = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${safe}["']`,
    "i",
  ).exec(html);
  return first?.[1] ?? second?.[1] ?? null;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeded ${maxBytes} byte policy limit`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function collectUrl(
  rawUrl: string,
  policy: CollectionPolicy,
  fetcher: typeof fetch = pinnedFetch,
  options: CollectUrlOptions = {},
): Promise<CollectionResult> {
  if (
    !["static_html", "api", "rss", "sitemap"].includes(policy.collectionMethod)
  ) {
    throw new Error(
      `Collection method ${policy.collectionMethod} is not supported by the production worker`,
    );
  }
  // Test seam: unit tests run without real DNS, so they skip the public-host
  // check. Production callers always leave this unset.
  const verifyHost = options.skipPublicHostCheck
    ? async (_hostname: string): Promise<void> => undefined
    : assertPublicHost;
  let current = assertUrlAllowed(rawUrl, policy);
  await verifyHost(current.hostname);
  const robotsDecision = await checkRobots(current, policy, fetcher);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), policy.timeoutMs);
  let response: Response | null = null;
  try {
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      response = await fetcher(current, {
        headers: {
          "user-agent": `${policy.userAgent} (${policy.contactEmail})`,
          accept:
            "text/html,application/xhtml+xml,application/json,text/plain,application/xml,text/xml,application/pdf",
        },
        signal: controller.signal,
        redirect: "manual",
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location)
        throw new Error("Redirect response omitted Location header");
      current = assertUrlAllowed(new URL(location, current).toString(), policy);
      await verifyHost(current.hostname);
      await checkRobots(current, policy, fetcher);
      response = null;
    }
    if (!response) throw new Error("Too many redirects");
    if (response.status === 401 || response.status === 403)
      throw new Error(
        `Source requires authorization or denied the worker (${response.status})`,
      );
    if (response.status === 429)
      throw new Error("Source rate limited the worker (429)");
    if (!response.ok) throw new Error(`Source returned ${response.status}`);
    const contentType = (
      response.headers.get("content-type") ?? "application/octet-stream"
    )
      .split(";")[0]
      .trim()
      .toLowerCase();
    const allowedTypes = [
      "text/html",
      "application/xhtml+xml",
      "application/json",
      "text/plain",
      "application/xml",
      "text/xml",
    ];
    if (!allowedTypes.includes(contentType))
      throw new Error(`Unsupported content type ${contentType}`);
    const rawContent = await readBoundedBody(response, policy.maxBytes);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(rawContent)?.[1];
    const organization =
      extractMeta(rawContent, "og:site_name") ??
      extractMeta(rawContent, "application-name");
    const isHtml = contentType.includes("html");
    const baseExtractedText = isHtml
      ? stripHtml(rawContent)
      : normalizeText(rawContent);

    // Gap 4: tech-stack fingerprinting + job-page evidence. Marked lines flow
    // through the existing detectSignals() -> scoreSignals() pipeline.
    const depth = options._depth ?? 0;
    const evidenceExtras: string[] = [];
    if (isHtml && options.fingerprint !== false) {
      const headerRecord: Record<string, string> = {};
      for (const name of FINGERPRINT_HEADER_NAMES) {
        const value = response.headers.get(name);
        if (value) headerRecord[name] = value;
      }
      evidenceExtras.push(
        ...fingerprintEvidenceLines(fingerprintPage(rawContent, headerRecord)),
      );
    }
    if (isHtml && depth === 0 && options.jobPages !== false) {
      for (const jobUrl of discoverJobPageUrls(
        rawContent,
        current.toString(),
      )) {
        try {
          const jobPage = await collectUrl(jobUrl, policy, fetcher, {
            ...options,
            _depth: depth + 1,
            jobPages: false,
            geocode: false,
          });
          const jobPath = new URL(jobUrl).pathname;
          for (const board of detectJobBoards(jobPage.rawContent))
            evidenceExtras.push(
              `[job-page:${jobPath}] embedded-board: ${board}`,
            );
          for (const role of detectHiringRoles(jobPage.extractedText))
            evidenceExtras.push(`[job-page:${jobPath}] hiring-role: ${role}`);
          const jobExcerpt = truncateChars(jobPage.extractedText, 3000);
          if (jobExcerpt)
            evidenceExtras.push(`[job-page:${jobPath}] ${jobExcerpt}`);
        } catch {
          // Job-page enrichment is best-effort: policy denials, robots
          // decisions, and fetch failures must not fail the homepage scrape.
        }
      }
    }
    const extractedText = evidenceExtras.length
      ? `${baseExtractedText}\n${evidenceExtras.join("\n")}`
      : baseExtractedText;

    // Gap 5: address -> geocode enrichment. Only fills coordinates when the
    // page carried none, so embedded-coordinate behavior is unchanged.
    let coordinates = extractCoordinates(rawContent, contentType);
    let coordinatesSource: "embedded" | "geocoded" | undefined = coordinates
      ? "embedded"
      : undefined;
    if (!coordinates && isHtml && depth === 0 && options.geocode !== false) {
      const address = extractAddress(extractedText);
      if (address) {
        const geocodeOpts =
          typeof options.geocode === "object" ? options.geocode : {};
        const resolved = await geocodeAddress(address, {
          ...geocodeOpts,
          fetcher: geocodeOpts.fetcher ?? fetcher,
          userAgent:
            geocodeOpts.userAgent ??
            `${policy.userAgent} (${policy.contactEmail})`,
        });
        if (resolved) {
          coordinates = resolved;
          coordinatesSource = "geocoded";
        }
      }
    }

    return {
      canonicalUrl: canonicalizeUrl(rawUrl),
      finalUrl: canonicalizeUrl(current.toString()),
      statusCode: response.status,
      contentType,
      rawContent,
      extractedText,
      extractedTitle: title ? stripHtml(title) : null,
      extractedOrganization: organization ? stripHtml(organization) : null,
      contentHash: contentHash(rawContent),
      bytesDownloaded: new TextEncoder().encode(rawContent).byteLength,
      robotsDecision,
      fetchedAt: new Date().toISOString(),
      coordinates,
      coordinatesSource,
    };
  } finally {
    clearTimeout(timeout);
  }
}
