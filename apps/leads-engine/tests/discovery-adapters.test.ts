import { describe, expect, it, vi } from "vitest";
import { parseCsvRecords } from "../api/_lib/discovery/csv";
import {
  TorontoOpenDataAdapter,
  torontoRowToCandidate,
} from "../api/_lib/discovery/toronto-open-data";
import {
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
                url: "https://example.test/jobs.csv",
                last_modified: "2026-09-29",
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(csv, {
          status: 200,
          headers: { "content-type": "text/csv" },
        }),
      );
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
