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
): Promise<CollectionResult> {
  if (
    !["static_html", "api", "rss", "sitemap"].includes(policy.collectionMethod)
  ) {
    throw new Error(
      `Collection method ${policy.collectionMethod} is not supported by the production worker`,
    );
  }
  let current = assertUrlAllowed(rawUrl, policy);
  await assertPublicHost(current.hostname);
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
      await assertPublicHost(current.hostname);
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
    return {
      canonicalUrl: canonicalizeUrl(rawUrl),
      finalUrl: canonicalizeUrl(current.toString()),
      statusCode: response.status,
      contentType,
      rawContent,
      extractedText: contentType.includes("html")
        ? stripHtml(rawContent)
        : normalizeText(rawContent),
      extractedTitle: title ? stripHtml(title) : null,
      extractedOrganization: organization ? stripHtml(organization) : null,
      contentHash: contentHash(rawContent),
      bytesDownloaded: new TextEncoder().encode(rawContent).byteLength,
      robotsDecision,
      fetchedAt: new Date().toISOString(),
      coordinates: extractCoordinates(rawContent, contentType),
    };
  } finally {
    clearTimeout(timeout);
  }
}
