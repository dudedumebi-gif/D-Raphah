import { z } from "zod";
import type {
  Candidate,
  DiscoveryAdapter,
  FetchCandidatesOptions,
  GeoQuery,
} from "./adapter.js";
import { fetchCkanPackage, fetchCkanRows, newestCsvResource } from "./ckan.js";
import { field, normalizedIdentity, numberField } from "./csv.js";

export const TORONTO_PACKAGE_URL =
  "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=municipal-licensing-and-standards-business-licences-and-permits";
const TORONTO_DATASTORE_URL =
  "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/datastore_search";

export const TorontoAdapterConfigSchema = z.object({
  categories: z.array(z.string().min(1)).max(50).default([]),
  activeOnly: z.boolean().default(true),
  maxRecords: z.number().int().min(1).max(500).default(100),
});

export function torontoRowToCandidate(
  row: Record<string, unknown>,
  sourceUrl: string,
  observedAt: string,
): Candidate {
  const name = field(
    row,
    "OPERATING_NAME",
    "Operating Name",
    "CLIENT_NAME",
    "Client Name",
  );
  const category = field(
    row,
    "CATEGORY",
    "Licence Category",
    "LICENCE_CATEGORY",
  );
  const address = field(row, "ADDRESS", "Business Address", "BUSINESS_ADDRESS");
  const externalId =
    field(row, "LICENCE_NO", "Licence Number", "LICENCE_NUMBER") ??
    normalizedIdentity(name, address);
  const website = field(row, "WEBSITE", "Website", "URL", "Business Website");
  const evidenceText = [
    name && `Operating business: ${name}`,
    category && `Municipal licence category: ${category}`,
    address && `Business address: ${address}`,
    field(row, "ISSUED_DATE", "Date Issued") &&
      `Licence issued: ${field(row, "ISSUED_DATE", "Date Issued")}`,
    field(row, "PHONE", "Business Phone") &&
      "A public organizational telephone number is listed.",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    externalId,
    name,
    website,
    address,
    lat: numberField(row, "LATITUDE", "Latitude"),
    lng: numberField(row, "LONGITUDE", "Longitude"),
    category,
    source: "toronto_open_data",
    sourceUrl,
    observedAt,
    evidenceText,
    rawRecord: row,
  };
}

export class TorontoOpenDataAdapter implements DiscoveryAdapter {
  readonly id = "toronto_open_data";

  async fetchCandidates(
    _geo: GeoQuery,
    options: FetchCandidatesOptions = {},
  ): Promise<Candidate[]> {
    const fetcher = options.fetcher ?? fetch;
    const config = TorontoAdapterConfigSchema.parse(options.config ?? {});
    const limit = Math.min(
      config.maxRecords,
      options.maxCandidates ?? config.maxRecords,
    );
    const pkg = await fetchCkanPackage(fetcher, TORONTO_PACKAGE_URL);
    const resource = newestCsvResource(
      pkg.resources,
      /business licences data/i,
    );
    const rows = await fetchCkanRows({
      fetcher,
      resource,
      datastoreBase: TORONTO_DATASTORE_URL,
      limit: Math.max(limit * 5, limit),
    });
    const observedAt =
      pkg.metadata_modified ??
      resource.last_modified ??
      new Date().toISOString();
    const categories = config.categories.map((value) => value.toLowerCase());
    return rows
      .filter((row) => {
        if (config.activeOnly) {
          const status = field(
            row,
            "STATUS",
            "Licence Status",
            "OPERATING_STATUS",
          );
          if (status && /cancel|closed|expired|revoked|inactive/i.test(status))
            return false;
        }
        if (!categories.length) return true;
        const category =
          field(
            row,
            "CATEGORY",
            "Licence Category",
            "LICENCE_CATEGORY",
          )?.toLowerCase() ?? "";
        return categories.some((wanted) => category.includes(wanted));
      })
      .slice(0, limit)
      .map((row) => torontoRowToCandidate(row, resource.url, observedAt));
  }
}
