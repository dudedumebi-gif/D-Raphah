import { DiscoveryUpstreamError } from "./adapter.js";
import { parseCsvRecords } from "./csv.js";

export interface CkanResource {
  id: string;
  name?: string;
  format?: string;
  url: string;
  datastore_active?: boolean;
  created?: string;
  last_modified?: string;
}

export interface CkanPackage {
  metadata_modified?: string;
  resources: CkanResource[];
}

const TIMEOUT_MS = 45_000;
const MAX_BYTES = 40 * 1024 * 1024;

async function boundedText(response: Response): Promise<string> {
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES)
      throw new DiscoveryUpstreamError(
        `Dataset exceeds the ${MAX_BYTES} byte safety limit`,
      );
    return new TextDecoder().decode(buffer);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new DiscoveryUpstreamError(
        `Dataset exceeds the ${MAX_BYTES} byte safety limit`,
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function boundedJson<T>(response: Response): Promise<T> {
  try {
    return JSON.parse(await boundedText(response)) as T;
  } catch (error) {
    if (error instanceof DiscoveryUpstreamError) throw error;
    throw new DiscoveryUpstreamError("Dataset returned invalid JSON", {
      cause: error,
    });
  }
}

async function request(fetcher: typeof fetch, url: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: {
        accept: "application/json,text/csv;q=0.9,*/*;q=0.1",
        "user-agent": "RaphahLeadEngine-Discovery/1.0 (+https://raphah.io)",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new DiscoveryUpstreamError(
      `Dataset request failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok)
    throw new DiscoveryUpstreamError(
      `Dataset responded with HTTP ${response.status}`,
    );
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES)
    throw new DiscoveryUpstreamError(
      `Dataset exceeds the ${MAX_BYTES} byte safety limit`,
    );
  return response;
}

export async function fetchCkanPackage(
  fetcher: typeof fetch,
  packageUrl: string,
): Promise<CkanPackage> {
  const response = await request(fetcher, packageUrl);
  const payload = await boundedJson<{
    success?: boolean;
    result?: CkanPackage;
  }>(response);
  if (!payload.success || !payload.result)
    throw new DiscoveryUpstreamError(
      "Dataset catalogue returned an invalid package",
    );
  return payload.result;
}

export async function fetchCkanRows(args: {
  fetcher: typeof fetch;
  resource: CkanResource;
  datastoreBase?: string;
  limit: number;
}): Promise<Array<Record<string, unknown>>> {
  const { fetcher, resource, datastoreBase, limit } = args;
  if (resource.datastore_active && datastoreBase) {
    const url = new URL(datastoreBase);
    url.searchParams.set("resource_id", resource.id);
    url.searchParams.set("limit", String(limit));
    const response = await request(fetcher, url.toString());
    const payload = await boundedJson<{
      success?: boolean;
      result?: { records?: Array<Record<string, unknown>> };
    }>(response);
    if (!payload.success)
      throw new DiscoveryUpstreamError("Dataset datastore query failed");
    return payload.result?.records ?? [];
  }
  const response = await request(fetcher, resource.url);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    contentType.includes("json") ||
    resource.format?.toLowerCase() === "json"
  ) {
    const payload = await boundedJson<unknown>(response);
    const rows = Array.isArray(payload)
      ? payload
      : ((payload as { records?: unknown[] }).records ?? []);
    return rows.slice(0, limit) as Array<Record<string, unknown>>;
  }
  return parseCsvRecords(await boundedText(response)).slice(0, limit);
}

export function newestCsvResource(
  resources: CkanResource[],
  preferred: RegExp,
): CkanResource {
  const candidates = resources.filter((resource) =>
    /csv|json/i.test(resource.format ?? resource.url),
  );
  const preferredRows = candidates.filter((resource) =>
    preferred.test(resource.name ?? ""),
  );
  const pool = preferredRows.length ? preferredRows : candidates;
  const selected = [...pool].sort((a, b) =>
    String(b.last_modified ?? b.created ?? b.name ?? "").localeCompare(
      String(a.last_modified ?? a.created ?? a.name ?? ""),
    ),
  )[0];
  if (!selected)
    throw new DiscoveryUpstreamError(
      "No CSV/JSON dataset resource is available",
    );
  return selected;
}
