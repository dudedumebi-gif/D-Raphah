import { z } from "zod";
import {
  DiscoveryUpstreamError,
  type Candidate,
  type DiscoveryAdapter,
  type FetchCandidatesOptions,
  type GeoQuery,
} from "./adapter.js";
import { fetchCkanPackage, fetchCkanResourceText } from "./ckan.js";
import {
  field,
  normalizedIdentity,
  numberField,
  parseCsvRecords,
} from "./csv.js";
import { selectJobBankCsvUrls } from "../job-bank-market.js";

export const JOB_BANK_PACKAGE_URL =
  "https://open.canada.ca/data/api/action/package_show?id=ea639e28-c0fc-48bf-b5dd-b8899bd43072";

export const JobBankAdapterConfigSchema = z.object({
  keywords: z.array(z.string().min(1)).max(50).default([]),
  postedWithinDays: z.number().int().min(1).max(366).default(90),
  maxRecords: z.number().int().min(1).max(500).default(100),
});

export function jobBankRowToCandidate(
  row: Record<string, unknown>,
  resourceUrl: string,
  observedAt: string,
): Candidate {
  const name = field(
    row,
    "Employer",
    "Employer Name",
    "EMPLOYER_NAME",
    "Business Name",
  );
  const city = field(row, "City", "Work Location City", "CITY_NAME");
  const province = field(row, "Province", "Province/Territory", "PROV_NAME");
  const address = [city, province].filter(Boolean).join(", ") || null;
  const postingId = field(
    row,
    "Job Bank Job Number",
    "Job Posting ID",
    "JOB_ID",
    "Job ID",
  );
  const title = field(row, "Job Title", "JOB_TITLE", "Title");
  const duties = field(
    row,
    "Job Description",
    "Duties",
    "Tasks",
    "SKILL_DESCRIPTION",
  );
  const technologies = field(
    row,
    "Technologies",
    "Computer and Technology Knowledge",
    "Tools",
  );
  const sourceUrl = field(row, "Job URL", "Posting URL", "URL") ?? resourceUrl;
  const website = field(row, "Employer Website", "Company Website", "WEBSITE");
  return {
    externalId:
      postingId ?? normalizedIdentity(name, `${address}:${title ?? ""}`),
    name,
    website,
    address,
    lat: numberField(row, "Latitude", "LATITUDE"),
    lng: numberField(row, "Longitude", "LONGITUDE"),
    category: field(row, "NOC", "NOC Code", "Occupation", "JOB_CATEGORY"),
    source: "job_bank",
    sourceUrl,
    observedAt,
    evidenceText: [
      name && `Employer: ${name}`,
      title && `Job title: ${title}`,
      duties && `Public job duties: ${duties}`,
      technologies && `Technologies or tools: ${technologies}`,
      address && `Work location: ${address}`,
    ]
      .filter(Boolean)
      .join("\n"),
    rawRecord: row,
  };
}

export class JobBankAdapter implements DiscoveryAdapter {
  readonly id = "job_bank";

  async fetchCandidates(
    geo: GeoQuery,
    options: FetchCandidatesOptions = {},
  ): Promise<Candidate[]> {
    const fetcher = options.fetcher ?? fetch;
    const config = JobBankAdapterConfigSchema.parse(options.config ?? {});
    const limit = Math.min(
      config.maxRecords,
      options.maxCandidates ?? config.maxRecords,
    );
    const pkg = await fetchCkanPackage(fetcher, JOB_BANK_PACKAGE_URL);
    // The package holds monthly EN/FR file pairs, and the newest file
    // overall is as often the French one — whose rows this adapter's
    // English column mapping cannot read. Mirror the market sync's
    // selection: the newest resource whose URL carries "-en-".
    const [csvUrl] = selectJobBankCsvUrls(pkg);
    if (!csvUrl)
      throw new DiscoveryUpstreamError(
        "No English Job Bank CSV resource is available",
      );
    const resource = pkg.resources.find((entry) => entry.url === csvUrl);
    // The monthly files are full national snapshots (~100k rows),
    // published as UTF-16 and larger than the generic CKAN safety cap.
    // Fetch the whole file the way the market sync does — UTF-16, no
    // byte cap, a 180s budget — then filter below; reading a prefix
    // first would slice away nearly every in-market row before the
    // filter ever saw it.
    const text = await fetchCkanResourceText({
      fetcher,
      resource: resource ?? { id: "job-bank-en", url: csvUrl },
      encoding: "utf-16",
      maxBytes: null,
      timeoutMs: 180_000,
    });
    const rows = parseCsvRecords(text);
    const observedAt =
      pkg.metadata_modified ??
      resource?.last_modified ??
      new Date().toISOString();
    const keywords = config.keywords.map((value) => value.toLowerCase());
    const cutoff = Date.now() - config.postedWithinDays * 86_400_000;
    return rows
      .filter((row) => {
        const city =
          field(row, "City", "Work Location City", "CITY_NAME") ?? "";
        const province =
          field(row, "Province", "Province/Territory", "PROV_NAME") ?? "";
        if (geo.city && !city.toLowerCase().includes(geo.city.toLowerCase()))
          return false;
        if (
          geo.region &&
          province &&
          !province.toLowerCase().includes(geo.region.toLowerCase())
        )
          return false;
        const posted = field(row, "Date Posted", "POSTED_DATE", "Posting Date");
        if (
          posted &&
          !Number.isNaN(Date.parse(posted)) &&
          Date.parse(posted) < cutoff
        )
          return false;
        if (!keywords.length) return true;
        const haystack = Object.values(row).join(" ").toLowerCase();
        return keywords.some((keyword) => haystack.includes(keyword));
      })
      .slice(0, limit)
      .map((row) => jobBankRowToCandidate(row, csvUrl, observedAt));
  }
}
