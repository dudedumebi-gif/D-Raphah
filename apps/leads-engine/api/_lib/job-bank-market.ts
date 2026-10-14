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
import { JOB_BANK_OPEN_DATA_TERMS_ID } from "./discovery/terms.js";
import {
  JOB_BANK_MARKET_SIGNAL_CODE,
  type DetectedSignal,
} from "./domain.js";

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
  /** Snapshot timestamp (when present), for rescore fingerprints. */
  syncedAt?: string;
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

interface JobBankRow {
  title: string;
  naics: string;
  province: string;
  city: string;
  postedRaw: string;
  postedMs: number;
}

/**
 * Parse one monthly Job Bank file (already decoded to text; the
 * published files are UTF-16 TSV) into clinic-role posting rows.
 * Column positions are resolved from the header row, and rows too
 * short to contain the location columns are skipped (free-text columns
 * can carry embedded tabs in principle; every column used here
 * precedes them in the published layout).
 */
function parseJobBankRows(text: string): JobBankRow[] {
  const rows: JobBankRow[] = [];
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return rows;
  const header = lines[0].split("\t").map((value) => value.trim());
  const titleIdx = header.indexOf("Job Title");
  const naicsIdx = header.indexOf("NAICS");
  const provinceIdx = header.indexOf("Province/Territory");
  const cityIdx = header.indexOf("City");
  const dateIdx = header.indexOf("First Posting Date");
  if ([titleIdx, naicsIdx, provinceIdx, cityIdx, dateIdx].some((i) => i < 0))
    return rows;
  const minFields = Math.max(titleIdx, naicsIdx, provinceIdx, cityIdx, dateIdx);
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    if (fields.length <= minFields) continue;
    const title = fields[titleIdx] ?? "";
    const naics = fields[naicsIdx] ?? "";
    if (!isClinicRolePosting(title, naics)) continue;
    const city = (fields[cityIdx] ?? "").trim();
    const province = (fields[provinceIdx] ?? "").trim();
    if (!city || !province) continue;
    const postedRaw = (fields[dateIdx] ?? "").trim();
    rows.push({
      title,
      naics,
      province,
      city,
      postedRaw,
      postedMs: Date.parse(postedRaw),
    });
  }
  return rows;
}

/** Count in-window clinic-role postings per city from one monthly file. */
export function countJobBankPostingsByCity(
  text: string,
  now: Date,
): Map<string, JobBankCityCount> {
  const counts = new Map<string, JobBankCityCount>();
  const cutoff = now.getTime() - JOB_BANK_MARKET_WINDOW_DAYS * 86_400_000;
  for (const row of parseJobBankRows(text)) {
    const posted = row.postedMs;
    if (!Number.isNaN(posted) && (posted < cutoff || posted > now.getTime()))
      continue;
    const key = `${row.city.toLowerCase()}|${row.province.toLowerCase()}`;
    const existing = counts.get(key);
    if (existing) {
      existing.postings += 1;
      if (
        !Number.isNaN(posted) &&
        (!existing.latestPosted ||
          posted > Date.parse(existing.latestPosted))
      )
        existing.latestPosted = row.postedRaw;
    } else {
      counts.set(key, {
        city: row.city,
        province: row.province,
        postings: 1,
        latestPosted: Number.isNaN(posted) ? null : row.postedRaw,
      });
    }
  }
  return counts;
}

export interface JobBankRoleRollup {
  /** First of the posting month, ISO date (yyyy-mm-dd). */
  periodMonth: string;
  city: string;
  province: string;
  roleTitle: string;
  postings: number;
}

function displayRoleTitle(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/(^|[\s-])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * Postings per (posting month, city, role) from one monthly file —
 * the market view's raw material for top roles and month-over-month
 * growth. Rows with unparseable dates are excluded (no month to
 * bucket them into).
 */
export function countJobBankRoleRollups(text: string): JobBankRoleRollup[] {
  const counts = new Map<string, JobBankRoleRollup>();
  for (const row of parseJobBankRows(text)) {
    if (Number.isNaN(row.postedMs)) continue;
    const date = new Date(row.postedMs);
    const periodMonth = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const roleTitle = displayRoleTitle(row.title);
    const key = `${periodMonth}|${row.city.toLowerCase()}|${row.province.toLowerCase()}|${roleTitle.toLowerCase()}`;
    const existing = counts.get(key);
    if (existing) existing.postings += 1;
    else
      counts.set(key, {
        periodMonth,
        city: row.city,
        province: row.province,
        roleTitle,
        postings: 1,
      });
  }
  return [...counts.values()];
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

export interface JobBankMarketData {
  cities: JobBankCityCount[];
  rollups: JobBankRoleRollup[];
}

/** Download the current + previous month files and merge the counts. */
export async function fetchJobBankMarketCounts(
  fetcher: typeof fetch,
  now: Date,
): Promise<JobBankMarketData> {
  const pkg = await fetchCkanPackage(fetcher, JOB_BANK_PACKAGE_URL);
  const urls = selectJobBankCsvUrls(pkg);
  if (!urls.length) throw new Error("No Job Bank CSV resources found");
  const mergedCities = new Map<string, JobBankCityCount>();
  const mergedRollups = new Map<string, JobBankRoleRollup>();
  for (const url of urls) {
    const text = await fetchUtf16Text(fetcher, url);
    for (const [key, value] of countJobBankPostingsByCity(text, now)) {
      const existing = mergedCities.get(key);
      if (existing) {
        existing.postings += value.postings;
        if (
          value.latestPosted &&
          (!existing.latestPosted ||
            value.latestPosted > existing.latestPosted)
        )
          existing.latestPosted = value.latestPosted;
      } else {
        mergedCities.set(key, { ...value });
      }
    }
    for (const rollup of countJobBankRoleRollups(text)) {
      const key = `${rollup.periodMonth}|${rollup.city.toLowerCase()}|${rollup.province.toLowerCase()}|${rollup.roleTitle.toLowerCase()}`;
      const existing = mergedRollups.get(key);
      if (existing) existing.postings += rollup.postings;
      else mergedRollups.set(key, { ...rollup });
    }
  }
  return {
    cities: [...mergedCities.values()],
    rollups: [...mergedRollups.values()],
  };
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
  const data = await fetchJobBankMarketCounts(fetcher, now);
  const counts = data.cities;
  const syncedAt = now.toISOString();
  // All fetching/parsing happens before the first write, so a timeout
  // mid-download leaves the previous snapshot untouched. Each table's
  // swap is ONE transaction (delete + inserts): any failure rolls
  // that table back whole, so readers never see a partial replacement.
  counts.sort((a, b) => b.postings - a.postings);
  const transactional = client as SqlClient & {
    transaction?: (batch: unknown[]) => Promise<unknown>;
  };
  const runBatch = async (queries: unknown[]) => {
    if (typeof transactional.transaction === "function") {
      await transactional.transaction(queries);
    } else {
      // Non-transactional client (tests/fakes): sequential fallback.
      for (const query of queries) await query;
    }
  };
  await runBatch([
    client`delete from public.job_bank_market_signals`,
    ...counts.map(
      (row) => client`
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
      `,
    ),
  ]);
  // Rollups in their own transaction. A missing table (migration
  // 202610120005 pending) is tolerated — the scoring snapshot must not
  // be held hostage to the view's table — but any other failure
  // propagates so the tick logs it, and the staleness check (which
  // watches both tables once the rollups exist) retries next tick.
  try {
    await runBatch([
      client`delete from public.job_bank_role_rollups`,
      ...data.rollups.map(
        (row) => client`
          insert into public.job_bank_role_rollups(
            period_month, city, province, role_title, postings, synced_at
          ) values (
            ${row.periodMonth}::date, ${row.city}, ${row.province},
            ${row.roleTitle}, ${row.postings}, ${syncedAt}::timestamptz
          )
          on conflict (period_month, city, province, role_title) do update set
            postings = excluded.postings,
            synced_at = excluded.synced_at
        `,
      ),
    ]);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (code !== "42P01" && !/job_bank_role_rollups.*does not exist/i.test(message))
      throw error;
  }
  return counts.length;
}

/**
 * True when the snapshot is missing or older than the daily cadence.
 * Watches the role rollups too once their table exists (migration
 * 202610120005), so a failed rollup swap retries on the next tick
 * instead of waiting a day; a not-yet-migrated rollup table never
 * makes the sync spin.
 */
export async function jobBankMarketSyncStale(
  client: SqlClient,
  now: Date = new Date(),
): Promise<boolean> {
  const isStale = (latest: string | null | undefined) =>
    !latest || now.getTime() - Date.parse(latest) > JOB_BANK_SYNC_MAX_AGE_MS;
  const rows = (await client`
    select max(synced_at) as latest from public.job_bank_market_signals
  `) as unknown as Array<{ latest: string | null }>;
  if (isStale(rows[0]?.latest)) return true;
  const reg = (await client`
    select to_regclass('public.job_bank_role_rollups') is not null as present
  `) as unknown as Array<{ present: boolean }>;
  if (!reg[0]?.present) return false;
  const rollupRows = (await client`
    select max(synced_at) as latest from public.job_bank_role_rollups
  `) as unknown as Array<{ latest: string | null }>;
  return isStale(rollupRows[0]?.latest);
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
      select city, province, postings_60d, synced_at
      from public.job_bank_market_signals
      where lower(city) = lower(${city})
        and postings_60d >= ${JOB_BANK_MARKET_MIN_POSTINGS}
      order by postings_60d desc
      limit 1
    `) as unknown as Array<{
      city: string;
      province: string;
      postings_60d: number;
      synced_at: string;
    }>;
    const row = rows[0];
    if (!row) return null;
    return {
      city: row.city,
      province: row.province,
      postings: Number(row.postings_60d),
      syncedAt: row.synced_at,
    };
  } catch {
    return null;
  }
}

/**
 * The repository's source gate, applied to the market sync: the Job
 * Bank dataset may only be collected while a Job Bank discovery source
 * exists whose linked collection source is active with a human-approved
 * policy AND whose workspace has accepted the Open Government Licence —
 * Canada terms. Mirrors the predicates discovery runs and collection
 * already enforce (schedule.ts assertCollectionSourceApproved, the
 * terms_acceptances check in the discovery routes). Fail-closed: any
 * error or missing link means the sync does not run.
 */
export async function jobBankSourceApproved(
  client: SqlClient,
): Promise<boolean> {
  try {
    const rows = (await client`
      select 1 as ok
      from public.discovery_sources d
      join public.source_definitions s on s.id = d.source_id
      join public.source_policy_versions p on p.id = s.active_policy_id
      join public.terms_acceptances t
        on t.workspace_id = d.workspace_id
       and t.terms_id = ${JOB_BANK_OPEN_DATA_TERMS_ID}
      where d.adapter_id = 'job_bank'
        and d.active = true
        and s.status = 'active'
        and p.status = 'approved'
        and p.approved_by is not null
        and p.allow_discovered_domains = true
      limit 1
    `) as unknown as unknown[];
    return rows.length > 0;
  } catch {
    return false;
  }
}

export interface JobBankRoleStat {
  role: string;
  currentMonth: number;
  previousMonth: number;
  /** Percent change vs the previous month; null when the role is new. */
  deltaPct: number | null;
}

export interface JobBankMarketView {
  syncedAt: string | null;
  gateApproved: boolean;
  threshold: number;
  windowDays: number;
  periods: { current: string | null; previous: string | null };
  /** Total cities in the snapshot (cities below is the top-15 display). */
  totalCities: number;
  cities: Array<{
    city: string;
    province: string;
    postings: number;
    latestPosted: string | null;
  }>;
  toronto: { postings: number; roles: JobBankRoleStat[] };
  nationalRoles: JobBankRoleStat[];
}

function roleStats(
  rollups: JobBankRoleRollup[],
  current: string | null,
  previous: string | null,
): JobBankRoleStat[] {
  const byRole = new Map<string, JobBankRoleStat>();
  for (const row of rollups) {
    let stat = byRole.get(row.roleTitle);
    if (!stat) {
      stat = {
        role: row.roleTitle,
        currentMonth: 0,
        previousMonth: 0,
        deltaPct: null,
      };
      byRole.set(row.roleTitle, stat);
    }
    if (row.periodMonth === current) stat.currentMonth += row.postings;
    else if (row.periodMonth === previous) stat.previousMonth += row.postings;
  }
  const stats = [...byRole.values()];
  for (const stat of stats) {
    stat.deltaPct =
      stat.previousMonth > 0
        ? Math.round(
            ((stat.currentMonth - stat.previousMonth) / stat.previousMonth) *
              100,
          )
        : stat.currentMonth > 0
          ? null
          : 0;
  }
  return stats.sort((a, b) => b.currentMonth - a.currentMonth);
}

/** Pure shaping for the market view (unit-tested). */
export function shapeJobBankMarketView(args: {
  cities: Array<{
    city: string;
    province: string;
    postings: number;
    latestPosted: string | null;
  }>;
  rollups: JobBankRoleRollup[];
  gateApproved: boolean;
  syncedAt: string | null;
}): JobBankMarketView {
  const periods = [...new Set(args.rollups.map((row) => row.periodMonth))].sort();
  const current = periods.at(-1) ?? null;
  const previous = periods.at(-2) ?? null;
  const torontoRollups = args.rollups.filter(
    (row) => row.city.toLowerCase() === "toronto",
  );
  const torontoCity = args.cities.find(
    (row) => row.city.toLowerCase() === "toronto",
  );
  return {
    syncedAt: args.syncedAt,
    gateApproved: args.gateApproved,
    threshold: JOB_BANK_MARKET_MIN_POSTINGS,
    windowDays: JOB_BANK_MARKET_WINDOW_DAYS,
    periods: { current, previous },
    totalCities: args.cities.length,
    cities: [...args.cities]
      .sort((a, b) => b.postings - a.postings)
      .slice(0, 15)
      .map((row) => ({
        city: row.city,
        province: row.province,
        postings: row.postings,
        latestPosted: row.latestPosted ?? null,
      })),
    toronto: {
      postings: torontoCity?.postings ?? 0,
      roles: roleStats(torontoRollups, current, previous).slice(0, 12),
    },
    nationalRoles: roleStats(args.rollups, current, previous).slice(0, 12),
  };
}

/**
 * Read the market view from the snapshot tables. Fail-soft: missing
 * tables (migrations pending) read as an empty snapshot; the gate
 * state is always reported so the UI can explain a paused bridge.
 */
export async function readJobBankMarketView(
  client: SqlClient,
): Promise<JobBankMarketView> {
  const gateApproved = await jobBankSourceApproved(client);
  let cities: Array<{
    city: string;
    province: string;
    postings: number;
    latestPosted: string | null;
  }> = [];
  let rollups: JobBankRoleRollup[] = [];
  let syncedAt: string | null = null;
  try {
    const cityRows = (await client`
      select city, province, postings_60d, latest_posted, synced_at
      from public.job_bank_market_signals
      order by postings_60d desc
    `) as unknown as Array<{
      city: string;
      province: string;
      postings_60d: number;
      latest_posted: string | null;
      synced_at: string;
    }>;
    cities = cityRows.map((row) => ({
      city: row.city,
      province: row.province,
      postings: Number(row.postings_60d),
      latestPosted: row.latest_posted,
    }));
    syncedAt =
      cityRows.reduce<string | null>(
        (max, row) => (max === null || row.synced_at > max ? row.synced_at : max),
        null,
      ) ?? null;
  } catch {
    // Snapshot table not present yet — empty view.
  }
  try {
    const rollupRows = (await client`
      select period_month::text as period_month, city, province, role_title, postings
      from public.job_bank_role_rollups
    `) as unknown as Array<{
      period_month: string;
      city: string;
      province: string;
      role_title: string;
      postings: number;
    }>;
    rollups = rollupRows.map((row) => ({
      periodMonth: row.period_month,
      city: row.city,
      province: row.province,
      roleTitle: row.role_title,
      postings: Number(row.postings),
    }));
  } catch {
    // Rollups not present yet — role tables render empty.
  }
  return shapeJobBankMarketView({ cities, rollups, gateApproved, syncedAt });
}

/** The synthetic signal the worker adds for an active market. */
export function jobBankMarketSignal(
  market: JobBankMarket,
  strength: number,
): DetectedSignal {
  return {
    code: JOB_BANK_MARKET_SIGNAL_CODE,
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
