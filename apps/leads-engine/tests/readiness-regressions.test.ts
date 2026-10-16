import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  detectSignals,
  evaluateGeography,
} from "../api/_lib/domain";
import {
  extractCoordinates,
  assertUrlAllowed,
  type CollectionPolicy,
} from "../api/_lib/collection";
import {
  isCompatibleSchemaVersion,
  requireScheduler,
} from "../api/_lib/neon";

describe("workspace bootstrap UI safety", () => {
  const source = readFileSync(
    new URL("../src/main.tsx", import.meta.url),
    "utf8",
  );
  const workspace = source.slice(
    source.indexOf("function Workspace("),
    source.indexOf("function funnelDiagnosis("),
  );

  it("declares every workspace hook before the initializing return", () => {
    const initializingReturn = workspace.indexOf(
      "if (!memberships.length && !data)",
    );
    expect(initializingReturn).toBeGreaterThan(0);
    expect(workspace.indexOf("const visibleData = data")).toBeLessThan(
      initializingReturn,
    );
    expect(
      workspace.lastIndexOf("useEffect(", initializingReturn),
    ).toBeLessThan(initializingReturn);
    expect(workspace.indexOf("useEffect(", initializingReturn)).toBe(-1);
  });

  it("lets a trapped user retry or sign out during initialization", () => {
    expect(workspace).toContain("Retry initialization");
    expect(workspace).toContain("Sign out");
    expect(workspace).toContain('localStorage.removeItem("raphah.lead.workspace")');
    expect(workspace).toContain('window.location.replace("/")');
  });

  it("does not reuse another account's remembered workspace", () => {
    expect(workspace).toContain(
      "rows.some((row) => row.workspace_id === current)",
    );
  });
});

describe("database environment isolation", () => {
  const source = readFileSync(
    new URL("../api/_lib/neon.ts", import.meta.url),
    "utf8",
  );

  it("prefers the Lead Engine-specific database URL without replacing production DATABASE_URL", () => {
    expect(source).toContain("process.env.LEAD_ENGINE_DATABASE_URL ??");
    expect(source).toContain('requiredEnvironment("DATABASE_URL")');
  });

  it("accepts the migrated 3.3.1 schema and compatible 3.x successors", () => {
    expect(isCompatibleSchemaVersion("3.3.1")).toBe(true);
    expect(isCompatibleSchemaVersion("3.3.2")).toBe(true);
    expect(isCompatibleSchemaVersion("3.4.0")).toBe(true);
    expect(isCompatibleSchemaVersion("3.2.0")).toBe(false);
    expect(isCompatibleSchemaVersion("4.0.0")).toBe(false);
    expect(isCompatibleSchemaVersion(undefined)).toBe(false);
  });
});

describe("operational alert migration safety", () => {
  const alertsSource = readFileSync(
    new URL("../api/_lib/alerts.ts", import.meta.url),
    "utf8",
  );
  const incidentMigration = readFileSync(
    new URL(
      "../neon/migrations/202610080002_operational_alert_incidents.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const correctionMigration = readFileSync(
    new URL(
      "../neon/migrations/202610080003_close_legacy_alert_incidents.sql",
      import.meta.url,
    ),
    "utf8",
  );

  it("does not import append-only history as open incidents", () => {
    expect(incidentMigration).toContain("and last_notified_at is null");
    expect(incidentMigration).toContain("last_transition = 'resolved'");
    expect(correctionMigration).toContain("alert.legacy_history.corrected");
    expect(correctionMigration).toContain("version = '3.3.3'");
  });

  it("opens dead-letter incidents only within the evaluator lookback", () => {
    expect(alertsSource).toContain("now.getTime() - 15 * 60_000");
    expect(alertsSource).toContain("coalesce(sj.completed_at,sj.updated_at,sj.created_at)");
  });
});

describe("human source-terms acceptance", () => {
  const uiSource = readFileSync(
    new URL("../src/main.tsx", import.meta.url),
    "utf8",
  );
  const termsSource = readFileSync(
    new URL("../api/_lib/discovery/terms.ts", import.meta.url),
    "utf8",
  );

  it("requires review and explicit acknowledgement before recording acceptance", () => {
    expect(uiSource).toContain("Review and accept terms");
    expect(uiSource).toContain('role="dialog"');
    expect(uiSource).toContain("Recorded version:");
    expect(uiSource).toContain("termsAcknowledged");
    expect(uiSource).toContain("disabled={!termsAcknowledged}");
    expect(uiSource).toContain("Record acceptance");
  });

  it("keeps authoritative review links and optional notes in the audited flow", () => {
    expect(termsSource).toContain("https://open.toronto.ca/open-data-license/");
    expect(termsSource).toContain(
      "https://open.canada.ca/en/open-government-licence-canada",
    );
    expect(uiSource).toContain("Acceptance notes (optional)");
    expect(uiSource).toContain("notes: termsNotes.trim()");
    expect(uiSource).toContain('rel="noreferrer"');
  });
});

describe("geographic qualification", () => {
  it("does not mistake the word 'on' for Ontario", () => {
    expect(evaluateGeography("We focus on customer service", {}).eligible).toBe(
      false,
    );
  });
  it("does not allow the province to override city narrowing", () => {
    expect(
      evaluateGeography("London, Ontario", {
        geography: { cities: ["Toronto"], regions: ["Ontario"] },
      }).eligible,
    ).toBe(false);
    expect(evaluateGeography("Toronto, Ontario", {}).city).toBe("Toronto");
  });
  it("matches accented region names and custom cities without partial-word matches", () => {
    expect(
      evaluateGeography("Québec", {
        geography: { cities: [], regions: ["Quebec"] },
      }).eligible,
    ).toBe(true);
    expect(
      evaluateGeography("Torontoish", {
        geography: { cities: ["Toronto"], regions: [] },
      }).eligible,
    ).toBe(false);
    expect(
      evaluateGeography("Halifax", {
        geography: { cities: ["Halifax"], regions: ["Nova Scotia"] },
      }).eligible,
    ).toBe(true);
    expect(
      evaluateGeography("Halifax", {
        geography: { cities: [], regions: ["Nova Scotia"] },
      }).eligible,
    ).toBe(false);
    expect(
      evaluateGeography("Anywhere", { geography: { cities: [], regions: [] } })
        .basis,
    ).toBe("not_restricted");
  });
  const radius = {
    geography: {
      mode: "radius",
      centreLatitude: 43.6532,
      centreLongitude: -79.3832,
      radiusKm: 50,
    },
  };
  it("requires valid centre and source coordinates for radius searches", () => {
    expect(evaluateGeography("Toronto", radius).eligible).toBe(false);
    expect(
      evaluateGeography(
        "Toronto",
        { geography: { mode: "radius" } },
        { latitude: 43.65, longitude: -79.38 },
      ).eligible,
    ).toBe(false);
    expect(
      evaluateGeography("Toronto", radius, { latitude: NaN, longitude: 0 })
        .eligible,
    ).toBe(false);
    expect(
      evaluateGeography("Toronto", radius, { latitude: 0, longitude: 181 })
        .eligible,
    ).toBe(false);
  });
  it("calculates radius distance and combines radius with a named market", () => {
    expect(
      evaluateGeography("Toronto", radius, {
        latitude: 43.6532,
        longitude: -79.3832,
      }),
    ).toMatchObject({ eligible: true, distanceKm: 0 });
    expect(
      evaluateGeography("Ottawa", radius, {
        latitude: 45.4215,
        longitude: -75.6972,
      }),
    ).toMatchObject({ eligible: false, basis: "outside_radius" });
    const hybrid = {
      geography: {
        ...radius.geography,
        mode: "hybrid",
        cities: ["Toronto"],
        regions: [],
      },
    };
    expect(
      evaluateGeography("Toronto", hybrid, {
        latitude: 43.65,
        longitude: -79.38,
      }).eligible,
    ).toBe(true);
    expect(
      evaluateGeography("Unknown", hybrid, {
        latitude: 43.65,
        longitude: -79.38,
      }).eligible,
    ).toBe(false);
  });
  it("extracts unambiguous structured coordinates only", () => {
    expect(
      extractCoordinates(
        '<script type="application/ld+json">{"geo":{"latitude":"43.65","longitude":-79.38}}</script>',
        "text/html",
      ),
    ).toEqual({ latitude: 43.65, longitude: -79.38 });
    expect(
      extractCoordinates(
        '{"geo":{"latitude":null,"longitude":0}}',
        "application/json",
      ),
    ).toBeUndefined();
    expect(
      extractCoordinates(
        '{"geo":{"latitude":91,"longitude":0}}',
        "application/json",
      ),
    ).toBeUndefined();
    expect(
      extractCoordinates("invalid json", "application/json"),
    ).toBeUndefined();
    expect(
      extractCoordinates(
        '[{"geo":{"latitude":1,"longitude":2}},{"geo":{"latitude":3,"longitude":4}}]',
        "application/json",
      ),
    ).toBeUndefined();
  });
  it("does not mistake two-letter tokens for Canadian province codes", () => {
    expect(
      evaluateGeography(
        "We love AB testing our funnels. Plans include 50 MB of storage.",
        { geography: { cities: [], regions: ["Alberta", "Manitoba"] } },
      ).eligible,
    ).toBe(false);
  });
  it("still matches full Canadian province names", () => {
    expect(
      evaluateGeography("Our Calgary, Alberta office is hiring.", {
        geography: { cities: [], regions: ["Alberta"] },
      }).eligible,
    ).toBe(true);
  });
});

describe("hard collection boundaries", () => {
  const policy = {
    allowedDomains: ["linkedin.com", "example.com"],
    allowlistPaths: ["/*"],
    denylistPaths: [],
  } as unknown as CollectionPolicy;
  it("blocks LinkedIn even when a source policy lists it", () => {
    expect(() =>
      assertUrlAllowed("https://www.linkedin.com/company/test", policy),
    ).toThrow(/prohibited/);
    expect(() => assertUrlAllowed("https://linkedin.com/", policy)).toThrow(
      /prohibited/,
    );
  });
  it("blocks URL-embedded credentials", () => {
    expect(() =>
      assertUrlAllowed("https://username:password@example.com", policy),
    ).toThrow(/credentials/);
  });
});

describe("scheduler authorization", () => {
  it("allows an explicit server-only manual diagnostic secret", async () => {
    const previous = process.env.WORKER_SECRET;
    process.env.WORKER_SECRET = "test-worker-secret";
    try {
      await expect(
        requireScheduler(
          new Request("https://lead.example/api/v1/worker/tick", {
            method: "POST",
            headers: { authorization: "Bearer test-worker-secret" },
          }),
        ),
      ).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.WORKER_SECRET;
      else process.env.WORKER_SECRET = previous;
    }
  });

  it("rejects unsigned scheduler traffic", async () => {
    const previous = process.env.WORKER_SECRET;
    delete process.env.WORKER_SECRET;
    try {
      await expect(
        requireScheduler(
          new Request("https://lead.example/api/v1/worker/tick", {
            method: "POST",
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 401 });
    } finally {
      if (previous !== undefined) process.env.WORKER_SECRET = previous;
    }
  });
});

describe("production-readiness implementation", () => {
  const migration = readFileSync(
    new URL(
      "../neon/migrations/202609270001_source_budget_and_audit.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const adapterMigration = readFileSync(
    new URL(
      "../neon/migrations/202609290001_source_adapters_and_data_modes.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const canaryRecoveryMigration = readFileSync(
    new URL(
      "../neon/migrations/202610080001_canary_worker_recovery.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const worker = readFileSync(
    new URL("../api/_lib/worker.ts", import.meta.url),
    "utf8",
  );
  const fixture = readFileSync(
    new URL("../public/canary-source.html", import.meta.url),
    "utf8",
  );

  it("enforces budgets, source pacing, audit coverage, and retention in durable SQL", () => {
    expect(migration).toContain("source_collection_reservations");
    expect(migration).toContain("reserve_source_collection");
    expect(migration).toContain("daily_budget");
    expect(migration).toContain("monthly_budget");
    expect(migration).toContain("prune_operational_history");
    expect(migration).toContain("handoff_outbox");
  });

  it("reserves persistent capacity before network collection", () => {
    expect(worker.indexOf("reserve_source_collection")).toBeGreaterThan(-1);
    expect(worker.indexOf("reserve_source_collection")).toBeLessThan(
      worker.indexOf("collectUrl("),
    );
  });

  it("uses the real geocode timestamp in the recovery migration", () => {
    expect(canaryRecoveryMigration).toContain(
      "where resolved_at < p_now - interval '90 days'",
    );
    expect(canaryRecoveryMigration).not.toContain(
      "geocode_cache where updated_at",
    );
    expect(canaryRecoveryMigration).toContain("set data_mode='demo'");
  });

  it("persists discovery lineage with RLS, audit, data modes, and atomic resolution", () => {
    expect(adapterMigration).toContain(
      "create table if not exists public.discovery_candidates",
    );
    expect(adapterMigration).toContain("enable row level security");
    expect(adapterMigration).toContain("audit_discovery_candidates");
    expect(adapterMigration).toContain("resolve_discovery_candidate");
    expect(adapterMigration).toContain("allow_discovered_domains");
    expect(worker).toContain("allowedDomainsForJob");
    expect(adapterMigration).toContain("discovery_candidate_id");
    expect(adapterMigration).toContain(
      "source and job data modes do not match",
    );
    expect(adapterMigration).toContain(
      "organizations_workspace_domain_mode_key",
    );
    expect(adapterMigration).toContain("version='3.3.0'");
  });

  it("keeps the owned fixture page deterministic and evidence-backed", () => {
    const signals = detectSignals(fixture);
    expect(signals.some((signal) => signal.polarity === "manual")).toBe(true);
    expect(signals.some((signal) => signal.polarity === "commercial")).toBe(
      true,
    );
    expect(fixture).toContain("43.6532");
    expect(fixture).toContain("noindex,nofollow");
  });
});
