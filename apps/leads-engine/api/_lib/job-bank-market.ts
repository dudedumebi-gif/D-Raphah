/**
 * Job Bank market-intent bridge.
 *
 * Why this exists: scoring 3.0.0's intent/trigger factor reads commercial
 * signals from the clinic's own website, and real clinic sites almost
 * never publish hiring evidence there (61 of the first 66 PRD-scored
 * clinics had intent_trigger = 0 while Toronto clinics were continuously
 * posting the exact front-desk roles automation relieves). The Canada Job
 * Bank open-data snapshot (the CKAN package the discovery adapter reads)
 * proves that market demand — but it WITHHOLDS employer identity and
 * usually the postal code, so the evidence is market-level and
 * inferential, never "this clinic posted this job". This module keeps a
 * per-city count of recent postings for clinic front-desk roles; the
 * worker turns a sufficiently active market into ONE synthetic signal
 * whose excerpt states the inferential nature verbatim, and the existing
 * scoring machinery converts it to intent mass. The signal's strength is
 * NOT set here — it comes from the campaign criteria
 * (jobBankMarketStrength, operator-tunable in the Criteria UI, 0 = off).
 */
import { fetchCkanPackage, type CkanPackage } from "./discovery/ckan.js";
import { JOB_BANK_PACKAGE_URL } from "./discovery/job-bank.js";
import type { DetectedSignal } from "./domain.js";

/** Titles that are unambiguously clinic front-desk roles. */
export const JOB_BANK_ROLE_KEYWORDS: readonly string[] = [
  "medical administrative assistant",
  "medical receptionist",
  "medical clinic receptionist",
  "patient coordinator",
  "dental receptionist",
  "clinic administrator",
  "scheduling coordinator",
  "billing administrator",
  "dental office administrator",
  "medical office assistant",
  "medical secretary",
  "dental administrator",
];

/** Below this many postings in the window, a market says nothing. */
export const JOB_BANK_MARKET_MIN_POSTINGS = 10;
export const JOB_BANK_MARKET_WINDOW_DAYS = 60;
/** Re-sync at most once a day; the source files are monthly. */
export const JOB_BANK_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface JobBankCityCount {
  city: string;
  province: string;
  postings: number;
  latestPosted: string | null;
}

export interface JobBankMarket {
  city: string;
  province: string | null;
  postings: number;
}

/**
 * A posting counts when its title is a clinic front-desk role, or it is a
 * receptionist posting in the health-care industry (NAICS 62) — a hotel
 * receptionist is not clinic urgency evidence.
 */
export function isClinicRolePosting(title: string, naics: string): boolean {
  const normalized = title.toLowerCase();
  if (JOB_BANK_ROLE_KEYWORDS.some((keyword) => normalized.includes(keyword)))
    return true;
  return normalized.includes("receptionist") && naics.trim().startsWith("62");
}

/**
 * Count in-window clinic-role postings per city from one monthly Job Bank
 * CSV (already decoded to text; the published files are UTF-16 TSV).
 * Column positions are resolved from the header row, and rows too short
 * to contain the location columns are skipped (free-text columns can
 * carry embedded tabs in principle; every column used here precedes
 * them in the published layout).
 */
export function countJobBankPostingsByCity(
  text: string,
  now: Date,
): Map<string, JobBankCityCount> {
  const counts = new Map<string, JobBankCityCount>();
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return counts;
  const header = lines[0].split("\t").map((value) => value.trim());
  const titleIdx = header.indexOf("Job Title");
  const naicsIdx = header.indexOf("NAICS");
  const provinceIdx = header.indexOf("Province/Territory");
  const cityIdx = header.indexOf("City");
  const dateIdx = header.indexOf("First Posting Date");
  if ([titleIdx, naicsIdx, provinceIdx, cityIdx, dateIdx].some((i) => i < 0))
    return counts;
  const minFields = Math.max(titleIdx, naicsIdx, provinceIdx, cityIdx, dateIdx);
  const cutoff = now.getTime() - JOB_BANK_MARKET_WINDOW_DAYS * 86_400_000;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    if (fields.length <= minFields) continue;
    if (!isClinicRolePosting(fields[titleIdx] ?? "", fields[naicsIdx] ?? ""))
      continue;
    const postedRaw = (fields[dateIdx] ?? "").trim();
    const posted = Date.parse(postedRaw);
    if (!Number.isNaN(posted) && (posted < cutoff || posted > now.getTime()))
      continue;
    const city = (fields[cityIdx] ?? "").trim();
    const province = (fields[provinceIdx] ?? "").trim();
    if (!city || !province) continue;
    const key = `${city.toLowerCase()}|${province.toLowerCase()}`;
    const existing = counts.get(key);
    if (existing) {
      existing.postings += 1;
      if (
        !Number.isNaN(posted) &&
        (!existing.latestPosted ||
          posted > Date.parse(existing.latestPosted))
      )
        existing.latestPosted = postedRaw;
    } else {
      counts.set(key, {
        city,
        province,
        postings: 1,
        latestPosted: Number.isNaN(posted) ? null : postedRaw,
      });
    }
  }
  return counts;
}

/** The English CSV resources for the two newest monthly files. */
export function selectJobBankCsvUrls(pkg: CkanPackage): string[] {
  const resources = (pkg.resources ?? [])
    .filter(
      (resource) =>
        (resource.format ?? "").toLowerCase() === "csv" &&
        /job postings advertised/i.test(resource.name ?? "") &&
        (resource.url ?? "").includes("-en-"),
    )
    .sort((a, b) =>
      (b.last_modified ?? "").localeCompare(a.last_modified ?? ""),
    );
  return resources.slice(0, 2).map((resource) => resource.url);
}

async function fetchUtf16Text(
  fetcher: typeof fetch,
  url: string,
): Promise<string> {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok)
    throw new Error(`Job Bank CSV responded with HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  return new TextDecoder("utf-16").decode(buffer);
}

/** Download the current + previous month files and merge the counts. */
export async function fetchJobBankMarketCounts(
  fetcher: typeof fetch,
  now: Date,
): Promise<JobBankCityCount[]> {
  const pkg = await fetchCkanPackage(fetcher, JOB_BANK_PACKAGE_URL);
  const urls = selectJobBankCsvUrls(pkg);
  if (!urls.length) throw new Error("No Job Bank CSV resources found");
  const merged = new Map<string, JobBankCityCount>();
  for (const url of urls) {
    const text = await fetchUtf16Text(fetcher, url);
    for (const [key, value] of countJobBankPostingsByCity(text, now)) {
      const existing = merged.get(key);
      if (existing) {
        existing.postings += value.postings;
        if (
          value.latestPosted &&
          (!existing.latestPosted ||
            value.latestPosted > existing.latestPosted)
        )
          existing.latestPosted = value.latestPosted;
      } else {
        merged.set(key, { ...value });
      }
    }
  }
  return [...merged.values()];
}

type SqlClient = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown>;

/** Replace the market snapshot with fresh counts. Throws on failure. */
export async function syncJobBankMarketSignals(
  client: SqlClient,
  fetcher: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<number> {
  const counts = await fetchJobBankMarketCounts(fetcher, now);
  const syncedAt = now.toISOString();
  // All fetching/parsing happens before the first write, so a timeout
  // mid-download leaves the previous snapshot untouched. Writes are
  // ordered largest-market-first so even an interrupted write keeps the
  // most significant rows.
  counts.sort((a, b) => b.postings - a.postings);
  await client`delete from public.job_bank_market_signals`;
  for (const row of counts) {
    await client`
      insert into public.job_bank_market_signals(
        city, province, postings_60d, latest_posted, synced_at
      ) values (
        ${row.city}, ${row.province}, ${row.postings},
        ${row.latestPosted}, ${syncedAt}::timestamptz
      )
      on conflict (city, province) do update set
        postings_60d = excluded.postings_60d,
        latest_posted = excluded.latest_posted,
        synced_at = excluded.synced_at
    `;
  }
  return counts.length;
}

/** True when the snapshot is missing or older than the daily cadence. */
export async function jobBankMarketSyncStale(
  client: SqlClient,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = (await client`
    select max(synced_at) as latest from public.job_bank_market_signals
  `) as unknown as Array<{ latest: string | null }>;
  const latest = rows[0]?.latest;
  if (!latest) return true;
  return now.getTime() - Date.parse(latest) > JOB_BANK_SYNC_MAX_AGE_MS;
}

/**
 * The market for a city, or null when the snapshot has no sufficiently
 * active market for it. Fail-soft by design: a missing table (migration
 * not yet run) or any read error simply means no market signal.
 */
export async function lookupJobBankMarket(
  client: SqlClient,
  city: string,
): Promise<JobBankMarket | null> {
  try {
    const rows = (await client`
      select city, province, postings_60d
      from public.job_bank_market_signals
      where lower(city) = lower(${city})
        and postings_60d >= ${JOB_BANK_MARKET_MIN_POSTINGS}
      order by postings_60d desc
      limit 1
    `) as unknown as Array<{
      city: string;
      province: string;
      postings_60d: number;
    }>;
    const row = rows[0];
    if (!row) return null;
    return {
      city: row.city,
      province: row.province,
      postings: Number(row.postings_60d),
    };
  } catch {
    return null;
  }
}

/** The synthetic signal the worker adds for an active market. */
export function jobBankMarketSignal(
  market: JobBankMarket,
  strength: number,
): DetectedSignal {
  return {
    code: "job_bank_market_hiring",
    category: "commercial_urgency",
    polarity: "commercial",
    strength,
    confidence: 1,
    excerpt:
      `[job-bank-market] ${market.postings} postings for clinic front-desk ` +
      `roles in ${market.city} in the last ${JOB_BANK_MARKET_WINDOW_DAYS} days ` +
      `(Canada Job Bank open data; employer not disclosed — market-level ` +
      `inferential signal)`,
  };
}
