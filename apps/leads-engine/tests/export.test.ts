import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  csvEscape,
  exportFilename,
  LEAD_EXPORT_COLUMNS,
  mapExportLeadRow,
  parseExportFormat,
  serializeLeadsExport,
} from "../api/_lib/router";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function sampleLead(overrides: Record<string, unknown> = {}) {
  return {
    id: "lead-1",
    title: 'Acme "Best" Plumbing, Inc.',
    stage: "detected",
    status: "active",
    routing: "standard_review",
    automation_maturity_score: 32,
    opportunity_potential_score: 78,
    confidence: 0.81,
    last_refreshed_at: "2026-09-24T01:00:00.000Z",
    created_at: "2026-09-23T12:00:00.000Z",
    organizations: {
      name: 'Acme "Best" Plumbing, Inc.',
      normalized_domain: "acmeplumbing.test",
      website_url: "https://acmeplumbing.test",
    },
    maturity_assessments: {
      coverage_categories: 3,
      qualified: true,
    },
    ...overrides,
  };
}

describe("parseExportFormat", () => {
  it("accepts csv and json", () => {
    expect(parseExportFormat("csv")).toBe("csv");
    expect(parseExportFormat("json")).toBe("json");
  });

  it("rejects anything else with a 400", () => {
    for (const raw of [null, "", "xml", "CSV"]) {
      try {
        parseExportFormat(raw);
        expect.unreachable(`expected 400 for ${String(raw)}`);
      } catch (error) {
        expect((error as { statusCode?: number }).statusCode).toBe(400);
      }
    }
  });
});

describe("exportFilename", () => {
  it("produces a dated attachment filename", () => {
    expect(exportFilename("csv", new Date("2026-09-24T05:00:00Z"))).toBe(
      "leads-export-2026-09-24.csv",
    );
    expect(exportFilename("json", new Date("2026-09-24T05:00:00Z"))).toBe(
      "leads-export-2026-09-24.json",
    );
  });
});

describe("csvEscape", () => {
  it("leaves plain values untouched", () => {
    expect(csvEscape("Acme")).toBe("Acme");
    expect(csvEscape(42)).toBe("42");
    expect(csvEscape(true)).toBe("true");
  });

  it("quotes values containing commas, quotes, or newlines", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
    expect(csvEscape("a\rb")).toBe('"a\rb"');
  });

  it("renders null/undefined as empty", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });
});

describe("mapExportLeadRow", () => {
  it("flattens the leads-list join shape into the column set", () => {
    const row = mapExportLeadRow(sampleLead());
    expect(Object.keys(row)).toEqual([...LEAD_EXPORT_COLUMNS]);
    expect(row.lead_id).toBe("lead-1");
    expect(row.organization_name).toBe('Acme "Best" Plumbing, Inc.');
    expect(row.domain).toBe("acmeplumbing.test");
    expect(row.qualified).toBe(true);
    expect(row.coverage_categories).toBe(3);
  });

  it("handles single-element array joins (supabase shape)", () => {
    const lead = sampleLead();
    lead.organizations = [lead.organizations];
    lead.maturity_assessments = [lead.maturity_assessments];
    const row = mapExportLeadRow(lead);
    expect(row.organization_name).toBe('Acme "Best" Plumbing, Inc.');
    expect(row.qualified).toBe(true);
  });

  it("handles missing joins without throwing", () => {
    const row = mapExportLeadRow(
      sampleLead({ organizations: null, maturity_assessments: null }),
    );
    expect(row.organization_name).toBe("");
    expect(row.qualified).toBeNull();
  });
});

describe("serializeLeadsExport", () => {
  it("csv: header row plus one escaped row per lead", () => {
    const body = serializeLeadsExport(
      [sampleLead(), sampleLead({ id: "lead-2" })],
      "csv",
    );
    const lines = body.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(LEAD_EXPORT_COLUMNS.join(","));
    expect(lines[1]).toContain('"Acme ""Best"" Plumbing, Inc."');
    expect(lines[1]).toContain("lead-1");
    expect(lines[2]).toContain("lead-2");
  });

  it("csv: empty lead set still emits the header", () => {
    const body = serializeLeadsExport([], "csv");
    expect(body.trim()).toBe(LEAD_EXPORT_COLUMNS.join(","));
  });

  it("json: array of lead objects", () => {
    const body = serializeLeadsExport([sampleLead()], "json");
    const parsed = JSON.parse(body);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].lead_id).toBe("lead-1");
    expect(parsed[0].organization_name).toBe('Acme "Best" Plumbing, Inc.');
  });
});

describe("export/apply route registration", () => {
  const source = readFileSync(join(root, "api/_lib/router.ts"), "utf8");

  it("registers the export endpoint", () => {
    expect(source).toContain('"/api/v1/leads/export"');
  });

  it("registers the apply-suggestion and auto-apply endpoints", () => {
    expect(source).toContain("/apply-suggestion");
    expect(source).toContain("/auto-apply");
    expect(source).toContain("criteria.suggestion_applied");
    expect(source).toContain("criteria.auto_apply_changed");
  });

  it("writes audit entries through the RPC, not direct table writes", () => {
    expect(source).toContain("log_workspace_event");
  });
});
