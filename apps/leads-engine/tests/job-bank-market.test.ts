import { describe, expect, it } from "vitest";
import {
  countJobBankPostingsByCity,
  isClinicRolePosting,
  jobBankMarketSignal,
  selectJobBankCsvUrls,
} from "../api/_lib/job-bank-market";
import { CriteriaSchema, scoreSignals } from "../api/_lib/domain";

describe("clinic role posting match", () => {
  it("matches strict clinic front-desk titles in any industry", () => {
    expect(isClinicRolePosting("Dental Receptionist", "541514")).toBe(true);
    expect(isClinicRolePosting("medical administrative assistant", "")).toBe(
      true,
    );
  });

  it("matches generic receptionists only in health care (NAICS 62)", () => {
    expect(isClinicRolePosting("Receptionist", "621610")).toBe(true);
    expect(isClinicRolePosting("Receptionist", "721111")).toBe(false);
    expect(isClinicRolePosting("Hotel Manager", "621610")).toBe(false);
  });
});

describe("per-city counting", () => {
  const header =
    "Job Title\tNOC\tNAICS\tProvince/Territory\tCity\tFirst Posting Date";
  const text = [
    header,
    "Dental Receptionist\t14101\t621210\tOntario\tToronto\t2026/09/15",
    "Medical Receptionist\t14101\t621110\tOntario\tToronto\t2026/09/20",
    "Receptionist\t14101\t721111\tOntario\tToronto\t2026/09/20",
    "Receptionist\t14101\t621110\tOntario\tToronto\t2026/08/01",
    "Medical Office Assistant\t14101\t621110\tOntario\tOttawa\t2026/10/01",
    "Dental Receptionist\t14101\t621210\tOntario\tToronto",
  ].join("\n");

  it("counts in-window clinic-role postings per city", () => {
    const counts = countJobBankPostingsByCity(text, new Date("2026-10-12"));
    const toronto = [...counts.values()].find((row) => row.city === "Toronto");
    const ottawa = [...counts.values()].find((row) => row.city === "Ottawa");
    // The hotel receptionist (NAICS 72), the 72-day-old posting, and the
    // truncated row are all excluded.
    expect(toronto?.postings).toBe(2);
    expect(toronto?.latestPosted).toBe("2026/09/20");
    expect(ottawa?.postings).toBe(1);
  });

  it("returns nothing when the expected columns are absent", () => {
    expect(
      countJobBankPostingsByCity("a\tb\n1\t2", new Date()).size,
    ).toBe(0);
  });
});

describe("CSV resource selection", () => {
  it("picks the two newest English monthly files", () => {
    const pkg = {
      resources: [
        {
          format: "CSV",
          name: "July 2026 Job Postings Advertised on Canada's National Job Bank Website",
          url: "https://example.test/jul2026-en-x.csv",
          last_modified: "2026-08-01",
        },
        {
          format: "CSV",
          name: "September 2026 Job Postings Advertised on Canada's National Job Bank Website",
          url: "https://example.test/sept2026-fr-x.csv",
          last_modified: "2026-10-02",
        },
        {
          format: "CSV",
          name: "September 2026 Job Postings Advertised on Canada's National Job Bank Website",
          url: "https://example.test/sept2026-en-x.csv",
          last_modified: "2026-10-01",
        },
        {
          format: "CSV",
          name: "August 2026 Job Postings Advertised on Canada's National Job Bank Website",
          url: "https://example.test/aug2026-en-x.csv",
          last_modified: "2026-09-01",
        },
      ],
    };
    expect(selectJobBankCsvUrls(pkg as never)).toEqual([
      "https://example.test/sept2026-en-x.csv",
      "https://example.test/aug2026-en-x.csv",
    ]);
  });
});

describe("market signal", () => {
  it("carries the inferential provenance in its excerpt", () => {
    const signal = jobBankMarketSignal(
      { city: "Toronto", province: "Ontario", postings: 71 },
      20,
    );
    expect(signal.code).toBe("job_bank_market_hiring");
    expect(signal.polarity).toBe("commercial");
    expect(signal.strength).toBe(20);
    expect(signal.excerpt).toContain("71 postings");
    expect(signal.excerpt).toContain("inferential");
  });

  it("feeds intent_trigger through the normal scoring machinery", () => {
    const signal = jobBankMarketSignal(
      { city: "Toronto", province: "Ontario", postings: 71 },
      20,
    );
    const scored = scoreSignals([signal], {}, { contactability: 0 });
    expect(scored.components.intent_trigger).toBe(40);
  });

  it("defaults the criteria strength to 20 and allows disabling", () => {
    expect(CriteriaSchema.parse({}).jobBankMarketStrength).toBe(20);
    expect(
      CriteriaSchema.parse({ jobBankMarketStrength: 0 }).jobBankMarketStrength,
    ).toBe(0);
    expect(() =>
      CriteriaSchema.parse({ jobBankMarketStrength: 41 }),
    ).toThrow();
  });
});
