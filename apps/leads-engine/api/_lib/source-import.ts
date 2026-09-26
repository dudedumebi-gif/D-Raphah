/**
 * Pure, dependency-free helpers for the CSV source-import feature.
 *
 * This module intentionally has no imports (no zod, no node builtins) so it
 * can be unit-tested with vitest AND bundled into the browser frontend.
 * Schema validation happens in the API route via the existing
 * `SourceInputSchema`; this module only normalizes, maps, dedupes, and
 * parses.
 */

export type ImportCollectionMethod = "api" | "rss" | "sitemap" | "static_html";

export interface SourceImportRow {
  name: string;
  website: string;
  collectionMethod?: ImportCollectionMethod;
  businessPurpose?: string;
}

export interface IndexedImportRow {
  index: number;
  row: SourceImportRow;
}

export interface ImportSkip {
  index: number;
  name: string;
  website: string;
  reason: string;
}

export const DEFAULT_IMPORT_BUSINESS_PURPOSE =
  "Identify public evidence of manual processes and automation opportunity.";

export const IMPORT_COLLECTION_METHODS: readonly ImportCollectionMethod[] = [
  "api",
  "rss",
  "sitemap",
  "static_html",
];

/**
 * Normalize a source URL into a canonical identity string used for
 * de-duplication: lowercase, strip a leading `www.`, drop default ports and
 * fragments, strip a trailing slash, keep the path (and query).
 * Throws on non-HTTP(S) URLs, URLs with embedded credentials, or garbage.
 */
export function normalizeSourceUrl(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid source URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only HTTP(S) source URLs are permitted: ${raw}`);
  }
  if (url.username || url.password) {
    throw new Error(`URL credentials are prohibited: ${raw}`);
  }
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  const host = url.hostname.replace(/^www\./, "");
  const normalized =
    `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}` +
    `${pathname}${url.search}`;
  return normalized.toLowerCase();
}

/**
 * Build a source-create payload from one import row. The returned object is
 * shaped for the existing `SourceInputSchema` (defaults fill the rest);
 * callers must still run it through that schema. Throws when the row's
 * website is not a usable source URL.
 */
export function mapRowToSourceInput(
  row: SourceImportRow,
  contactEmail: string,
): {
  name: string;
  baseUrl: string;
  collectionMethod: ImportCollectionMethod;
  businessPurpose: string;
  allowedDomains: string[];
  allowlistPaths: string[];
  denylistPaths: string[];
  contactEmail: string;
} {
  const baseUrl = normalizeSourceUrl(row.website);
  const host = new URL(baseUrl).hostname;
  const purpose = row.businessPurpose?.trim() ?? "";
  return {
    name: row.name.trim(),
    baseUrl,
    collectionMethod: row.collectionMethod ?? "static_html",
    businessPurpose:
      purpose.length >= 10 ? purpose : DEFAULT_IMPORT_BUSINESS_PURPOSE,
    allowedDomains: [host],
    allowlistPaths: ["/*"],
    denylistPaths: ["/login*", "/account*", "/admin*"],
    contactEmail,
  };
}

/**
 * Split import rows into `{ unique, skipped }`. A row is skipped when its
 * website is not a valid source URL, when its normalized URL already exists
 * in the workspace, or when it duplicates another row in the same file.
 */
export function dedupeRows(
  rows: IndexedImportRow[],
  existingNormalizedUrls: Iterable<string>,
): { unique: IndexedImportRow[]; skipped: ImportSkip[] } {
  const existing = new Set(existingNormalizedUrls);
  const seen = new Set<string>();
  const unique: IndexedImportRow[] = [];
  const skipped: ImportSkip[] = [];
  for (const { index, row } of rows) {
    const name = row.name?.trim() || `row ${index + 1}`;
    const website = String(row.website ?? "").trim();
    let normalized: string;
    try {
      normalized = normalizeSourceUrl(website);
    } catch (error) {
      skipped.push({
        index,
        name,
        website,
        reason: `invalid_url: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (existing.has(normalized)) {
      skipped.push({
        index,
        name,
        website,
        reason: "duplicate: a source with this URL already exists",
      });
      continue;
    }
    if (seen.has(normalized)) {
      skipped.push({
        index,
        name,
        website,
        reason: "duplicate: repeated row in this import file",
      });
      continue;
    }
    seen.add(normalized);
    unique.push({ index, row });
  }
  return { unique, skipped };
}

export interface CsvParseResult {
  rows: SourceImportRow[];
  error: string | null;
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields containing commas,
 * embedded newlines and escaped quotes, plus CRLF line endings. Headers are
 * matched case-insensitively; `website` also accepts `base_url`/`url`.
 * Returns the first fatal problem as `error` instead of throwing.
 */
export function parseSourceCsv(text: string): CsvParseResult {
  const records: string[][] = [];
  let fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    fields.push(current);
    current = "";
  };
  const pushRecord = () => {
    records.push(fields);
    fields = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        current += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ",") {
      pushField();
      i += 1;
    } else if (ch === "\r" && text[i + 1] === "\n") {
      pushField();
      pushRecord();
      i += 2;
    } else if (ch === "\n" || ch === "\r") {
      pushField();
      pushRecord();
      i += 1;
    } else {
      current += ch;
      i += 1;
    }
  }
  if (inQuotes) {
    return { rows: [], error: "Unbalanced quote in CSV: a quoted field was never closed." };
  }
  pushField();
  pushRecord();

  const nonEmpty = records.filter((record) =>
    record.some((field) => field.trim() !== ""),
  );
  if (nonEmpty.length === 0) {
    return { rows: [], error: "The CSV file is empty." };
  }
  const header = nonEmpty[0].map(normalizeHeader);
  const findColumn = (...names: string[]): number =>
    header.findIndex((h) => names.includes(h));
  const nameIdx = findColumn("name");
  const websiteIdx = findColumn("website", "baseurl", "url");
  const methodIdx = findColumn("collectionmethod", "method");
  const purposeIdx = findColumn("businesspurpose", "purpose");
  if (nameIdx === -1) {
    return { rows: [], error: "Missing required column: 'name'." };
  }
  if (websiteIdx === -1) {
    return {
      rows: [],
      error: "Missing required column: 'website' (also accepts 'base_url' or 'url').",
    };
  }
  const rows: SourceImportRow[] = [];
  for (const record of nonEmpty.slice(1)) {
    const cell = (idx: number): string => (idx >= 0 && idx < record.length ? record[idx].trim() : "");
    const rawMethod = cell(methodIdx).toLowerCase();
    const collectionMethod = (
      IMPORT_COLLECTION_METHODS as readonly string[]
    ).includes(rawMethod)
      ? (rawMethod as ImportCollectionMethod)
      : undefined;
    rows.push({
      name: cell(nameIdx),
      website: cell(websiteIdx),
      ...(collectionMethod ? { collectionMethod } : {}),
      ...(purposeIdx >= 0 && cell(purposeIdx)
        ? { businessPurpose: cell(purposeIdx) }
        : {}),
    });
  }
  return { rows, error: null };
}
