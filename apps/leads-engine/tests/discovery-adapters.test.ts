import { describe, expect, it, vi } from "vitest";
import { parseCsvRecords } from "../api/_lib/discovery/csv";
import {
  TorontoOpenDataAdapter,
  torontoRowToCandidate,
} from "../api/_lib/discovery/toronto-open-data";
import {
  JOB_BANK_PACKAGE_URL,
  JobBankAdapter,
  jobBankRowToCandidate,
} from "../api/_lib/discovery/job-bank";
import { createDiscoveryAdapters } from "../api/_lib/discovery/registry";
import { termsForAdapter } from "../api/_lib/discovery/terms";
import { detectSignals } from "../api/_lib/domain";
import {
  allowedDomainsForJob,
  mergeDiscoveryEvidence,
} from "../api/_lib/worker";

const geo = {
  city: "Toronto",
  region: "Ontario",
  centreLatitude: 43.6532,
  centreLongitude: -79.3832,
  radiusKm: 50,
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Encode text the way the published Job Bank files are written: UTF-16LE with BOM. */
function utf16Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    bytes[2 + i * 2] = code & 0xff;
    bytes[2 + i * 2 + 1] = code >> 8;
  }
  return bytes;
}

function utf16CsvResponse(
  text: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(utf16Bytes(text), {
    status: 200,
    headers: { "content-type": "text/csv", ...headers },
  });
}

function jobBankPackageResponse(resources: unknown[]): Response {
  return jsonResponse({
    success: true,
    result: {
      metadata_modified: "2026-09-29T00:00:00Z",
      resources,
    },
  });
}

describe("structured discovery adapters", () => {
  it("parses quoted RFC-4180 CSV fields and escaped quotes", () => {
    expect(
      parseCsvRecords(
        'Employer,Description\r\n"Acme, Inc.","Uses ""paper"" forms"\r\n',
      ),
    ).toEqual([{ Employer: "Acme, Inc.", Description: 'Uses "paper" forms' }]);
  });

  it("maps Toronto licence records into provenance-rich candidates", () => {
    const candidate = torontoRowToCandidate(
      {
        "Operating Name": "Harbour Bakery",
        "Licence Number": "B123",
        "Licence Category": "Eating Establishment",
        "Business Address": "1 Front St, Toronto",
        Latitude: "43.64",
        Longitude: "-79.38",
      },
      "https://open.toronto.ca/resource.csv",
      "2026-09-29T00:00:00Z",
    );
    expect(candidate).toMatchObject({
      externalId: "B123",
      name: "Harbour Bakery",
      category: "Eating Establishment",
      source: "toronto_open_data",
      lat: 43.64,
      lng: -79.38,
    });
    expect(candidate.evidenceText).toContain("Municipal licence category");
  });

  it("discovers and filters Toronto CKAN records through the datastore", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: {
            metadata_modified: "2026-09-28T00:00:00Z",
            resources: [
              {
                id: "licences",
                name: "Business licences data",
                format: "CSV",
                url: "https://example.test/licences.csv",
                datastore_active: true,
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: {
            records: [
              {
                OPERATING_NAME: "A",
                LICENCE_NO: "1",
                CATEGORY: "Restaurant",
                STATUS: "Active",
                WEBSITE: "https://a.example",
              },
              {
                OPERATING_NAME: "B",
                LICENCE_NO: "2",
                CATEGORY: "Restaurant",
                STATUS: "Expired",
              },
              {
                OPERATING_NAME: "C",
                LICENCE_NO: "3",
                CATEGORY: "Plumber",
                STATUS: "Active",
              },
            ],
          },
        }),
      );
    const result = await new TorontoOpenDataAdapter().fetchCandidates(geo, {
      fetcher: fetcher as typeof fetch,
      config: { categories: ["restaurant"], activeOnly: true, maxRecords: 10 },
    });
    expect(result.map((candidate) => candidate.name)).toEqual(["A"]);
    expect(String(fetcher.mock.calls[1][0])).toContain("resource_id=licences");
  });

  it("maps and filters current Job Bank postings for the configured market", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const csv = [
      "Job Posting ID,Employer Name,Job Title,City,Province,Date Posted,Employer Website,Tasks",
      `J1,Paper Co,Administrative Coordinator,Toronto,Ontario,${today},https://paper.example,Manual filing and data entry`,
      `J2,Code Co,Software Engineer,Toronto,Ontario,${today},https://code.example,Cloud automation`,
      `J3,Ottawa Co,Administrative Assistant,Ottawa,Ontario,${today},https://ottawa.example,Paper records`,
    ].join("\n");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: {
            metadata_modified: "2026-09-29T00:00:00Z",
            resources: [
              {
                id: "jobs-new",
                name: "September 2026 Job Postings Advertised",
                format: "CSV",
                url: "https://example.test/jobs-en-2026.csv",
                last_modified: "2026-09-29",
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(utf16CsvResponse(csv));
    const result = await new JobBankAdapter().fetchCandidates(geo, {
      fetcher: fetcher as typeof fetch,
      config: {
        keywords: ["administrative"],
        postedWithinDays: 30,
        maxRecords: 10,
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      externalId: "J1",
      name: "Paper Co",
      website: "https://paper.example",
      source: "job_bank",
    });
    expect(result[0].evidenceText).toContain("Manual filing");
  });

  it("selects the English Job Bank file even when the French file is newer", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const header =
      "Job Posting ID,Employer Name,Job Title,City,Province,Date Posted,Employer Website,Tasks";
    const enCsv = [
      header,
      `E1,English Co,Dispatcher,Toronto,Ontario,${today},https://en.example,Dispatch phones`,
    ].join("\n");
    const frCsv = [
      header,
      `F1,French Co,Dispatcher,Toronto,Ontario,${today},https://fr.example,Dispatch phones`,
    ].join("\n");
    const requested: string[] = [];
    const fetcher = vi.fn(async (url: unknown) => {
      const target = String(url);
      requested.push(target);
      if (target === JOB_BANK_PACKAGE_URL)
        return jobBankPackageResponse([
          {
            id: "jobs-fr",
            name: "September 2026 Job Postings Advertised",
            format: "CSV",
            url: "https://example.test/jobs-fr-2026.csv",
            last_modified: "2026-09-30",
          },
          {
            id: "jobs-en",
            name: "September 2026 Job Postings Advertised",
            format: "CSV",
            url: "https://example.test/jobs-en-2026.csv",
            last_modified: "2026-09-29",
          },
        ]);
      return utf16CsvResponse(target.includes("-fr-") ? frCsv : enCsv);
    });
    const result = await new JobBankAdapter().fetchCandidates(geo, {
      fetcher: fetcher as typeof fetch,
      config: { keywords: ["dispatcher"], postedWithinDays: 30, maxRecords: 10 },
    });
    expect(requested.some((target) => target.includes("-fr-"))).toBe(false);
    expect(result.map((candidate) => candidate.name)).toEqual(["English Co"]);
    expect(result[0].sourceUrl).toContain("-en-");
  });

  it("decodes the UTF-16 Job Bank file before parsing quoted fields", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const csv = [
      "Job Posting ID,Employer Name,Job Title,City,Province,Date Posted,Employer Website,Tasks",
      `U1,"Café Müller, Inc.",Service Coordinator,Toronto,Ontario,${today},https://cafe.example,"Answer ""busy"" phones, book jobs"`,
    ].join("\n");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jobBankPackageResponse([
          {
            id: "jobs-en",
            name: "September 2026 Job Postings Advertised",
            format: "CSV",
            url: "https://example.test/jobs-en-2026.csv",
            last_modified: "2026-09-29",
          },
        ]),
      )
      .mockResolvedValueOnce(utf16CsvResponse(csv));
    const result = await new JobBankAdapter().fetchCandidates(geo, {
      fetcher: fetcher as typeof fetch,
      config: { keywords: ["coordinator"], postedWithinDays: 30, maxRecords: 10 },
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Café Müller, Inc.");
    expect(result[0].evidenceText).toContain('Answer "busy" phones');
  });

  it("filters the full Job Bank file before applying maxRecords", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const header =
      "Job Posting ID,Employer Name,Job Title,City,Province,Date Posted,Employer Website,Tasks";
    const filler = Array.from(
      { length: 800 },
      (_, i) =>
        `F${i},Filler Co ${i},Baker,Ottawa,Ontario,${today},,Bread and pastries`,
    ).join("\n");
    const matches = [1, 2, 3]
      .map(
        (i) =>
          `T${i},Toronto Dispatch ${i},Dispatcher,Toronto,Ontario,${today},https://t${i}.example,Dispatch board`,
      )
      .join("\n");
    const csv = [header, filler, matches].join("\n");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jobBankPackageResponse([
          {
            id: "jobs-en",
            name: "September 2026 Job Postings Advertised",
            format: "CSV",
            url: "https://example.test/jobs-en-2026.csv",
            last_modified: "2026-09-29",
          },
        ]),
      )
      .mockResolvedValueOnce(utf16CsvResponse(csv));
    const result = await new JobBankAdapter().fetchCandidates(geo, {
      fetcher: fetcher as typeof fetch,
      config: { keywords: ["dispatcher"], postedWithinDays: 30, maxRecords: 2 },
    });
    // The matching rows sit beyond row 800 of the national file; the
    // old fetch sliced a prefix before filtering and missed them all.
    expect(result.map((candidate) => candidate.externalId)).toEqual([
      "T1",
      "T2",
    ]);
  });

  it("does not reject a Job Bank file over the generic CKAN size cap", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const csv = [
      "Job Posting ID,Employer Name,Job Title,City,Province,Date Posted,Employer Website,Tasks",
      `S1,Big File Co,Dispatcher,Toronto,Ontario,${today},https://big.example,Dispatch board`,
    ].join("\n");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jobBankPackageResponse([
          {
            id: "jobs-en",
            name: "September 2026 Job Postings Advertised",
            format: "CSV",
            url: "https://example.test/jobs-en-2026.csv",
            last_modified: "2026-09-29",
          },
        ]),
      )
      .mockResolvedValueOnce(
        utf16CsvResponse(csv, {
          "content-length": String(64 * 1024 * 1024),
        }),
      );
    const result = await new JobBankAdapter().fetchCandidates(geo, {
      fetcher: fetcher as typeof fetch,
      config: { keywords: ["dispatcher"], postedWithinDays: 30, maxRecords: 10 },
    });
    expect(result.map((candidate) => candidate.name)).toEqual(["Big File Co"]);
  });

  it("registers all adapters and their separate human terms gates", () => {
    expect(Object.keys(createDiscoveryAdapters()).sort()).toEqual([
      "job_bank",
      "overpass",
      "toronto_open_data",
    ]);
    expect(termsForAdapter("toronto_open_data").id).toBe("toronto-open-data");
    expect(termsForAdapter("job_bank").id).toBe("canada-job-bank-open-data");
  });

  it("preserves Job Bank record provenance in direct mapping", () => {
    const candidate = jobBankRowToCandidate(
      {
        "Job ID": "x",
        Employer: "Example",
        City: "Toronto",
        Province: "Ontario",
      },
      "https://open.canada.ca/jobs.csv",
      "2026-09-29T00:00:00Z",
    );
    expect(candidate.sourceUrl).toBe("https://open.canada.ca/jobs.csv");
    expect(candidate.rawRecord).toMatchObject({ Employer: "Example" });
  });

  it("joins structured evidence into the normal signal and scoring input", () => {
    const merged = mergeDiscoveryEvidence("Public company homepage", {
      name: "Example Employer",
      evidence_text: "Job title: Data entry clerk",
      source_url: "https://open.canada.ca/jobs.csv",
      source_observed_at: "2026-09-29T00:00:00Z",
      raw_record: {},
    });
    expect(merged).toContain("Structured discovery evidence");
    expect(merged).toContain("open.canada.ca");
    expect(detectSignals(merged).map((signal) => signal.code)).toContain(
      "job_manual_roles",
    );
  });

  it("adds only a candidate-linked target domain when explicitly approved", () => {
    const basePolicy = {
      allowed_domains: ["open.canada.ca"],
      allow_discovered_domains: true,
    };
    expect(
      allowedDomainsForJob(basePolicy, {
        target_url: "https://www.paper.example/about",
        discovery_candidate_id: "candidate-id",
      }),
    ).toEqual(["open.canada.ca", "www.paper.example", "paper.example"]);
    expect(
      allowedDomainsForJob(basePolicy, {
        target_url: "https://www.paper.example/about",
        discovery_candidate_id: null,
      }),
    ).toEqual(["open.canada.ca"]);
    expect(
      allowedDomainsForJob(
        { ...basePolicy, allow_discovered_domains: false },
        {
          target_url: "https://www.paper.example/about",
          discovery_candidate_id: "candidate-id",
        },
      ),
    ).toEqual(["open.canada.ca"]);
  });
});

describe("overpass category preset (clinic sprint C2)", () => {
  it("parses overpass adapter config with an all-businesses default", async () => {
    const { parseDiscoveryAdapterConfig } = await import(
      "../api/_lib/discovery/registry"
    );
    expect(parseDiscoveryAdapterConfig("overpass", {})).toEqual({
      categoryPreset: "all",
    });
    expect(
      parseDiscoveryAdapterConfig("overpass", { categoryPreset: "clinics" }),
    ).toEqual({ categoryPreset: "clinics" });
    expect(() =>
      parseDiscoveryAdapterConfig("overpass", { categoryPreset: "bogus" }),
    ).toThrow();
  });

  it("parses and sends the field-service preset (Experiment 2)", async () => {
    const { parseDiscoveryAdapterConfig } = await import(
      "../api/_lib/discovery/registry"
    );
    expect(
      parseDiscoveryAdapterConfig("overpass", {
        categoryPreset: "field_service",
      }),
    ).toEqual({ categoryPreset: "field_service" });

    const { OverpassAdapter, overpassElementToCandidate } = await import(
      "../api/_lib/discovery/overpass"
    );
    const adapter = new OverpassAdapter();
    let body = "";
    const fetcher = (async (_url: unknown, init?: { body?: unknown }) => {
      body = String(init?.body ?? "");
      return jsonResponse({ elements: [] });
    }) as typeof fetch;
    await adapter.fetchCandidates(geo, {
      fetcher,
      config: { categoryPreset: "field_service" },
    });
    const query = decodeURIComponent(body.replace(/^data=/, ""));
    expect(query).toContain('["craft"~"^(plumber|electrician|hvac|');
    expect(query).toContain("garage_door|electronics_repair");
    expect(query).toContain('["shop"~"^(appliance_repair|electronics_repair)$"]');
    expect(query).toContain('["shop"]["repair"~"^(electronics|appliance)$"]');
    expect(query).toContain('["shop"~"^(electronics|appliance_repair|electronics_repair)$"]["repair"="yes"]');
    expect(query).not.toContain('["amenity"="dentist"]');
    expect(query).toContain('["website"]');

    const candidate = overpassElementToCandidate({
      type: "node",
      id: 42,
      lat: 43.65,
      lon: -79.38,
      tags: {
        name: "Rapid Flow Plumbing",
        craft: "plumber",
        website: "https://rapidflow.example.ca",
      },
    });
    expect(candidate.category).toBe("plumber");
    expect(candidate.website).toBe("https://rapidflow.example.ca");
  });

  it("sends clinic-only selectors when the preset is configured", async () => {
    const { OverpassAdapter } = await import(
      "../api/_lib/discovery/overpass"
    );
    const adapter = new OverpassAdapter();
    let body = "";
    const fetcher = (async (_url: unknown, init?: { body?: unknown }) => {
      body = String(init?.body ?? "");
      return jsonResponse({ elements: [] });
    }) as typeof fetch;
    await adapter.fetchCandidates(geo, {
      fetcher,
      config: { categoryPreset: "clinics" },
    });
    const query = decodeURIComponent(body.replace(/^data=/, ""));
    expect(query).toContain('["amenity"="dentist"]');
    expect(query).not.toContain('["shop"]');
  });
});
