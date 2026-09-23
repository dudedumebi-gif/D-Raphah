import { readFileSync } from "node:fs";
import {
  LeadEngineHandoffPackageSchema,
  canonicalJsonStringify,
  generateSigningKeyPair,
  sha256CanonicalJson,
  verifyPackage,
} from "@raphah/handoff-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHandoffPackage,
  dispatchDueHandoffs,
  enqueueHandoffOutbox,
  type EnqueueHandoffInput,
  type SqlClient,
} from "../server/handoff";

const keys = generateSigningKeyPair();
process.env.HANDOFF_SIGNING_PRIVATE_KEY_PEM = keys.privateKeyPem;
process.env.HANDOFF_SIGNING_PUBLIC_KEY_PEM = keys.publicKeyPem;

const OPPORTUNITY_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const ASSESSMENT_ID = "33333333-3333-4333-8333-333333333333";
const EVIDENCE_ID = "44444444-4444-4444-8444-444444444444";
const CONTENT_HASH =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

type Handler = {
  match: (sql: string) => boolean;
  rows: (sql: string, values: unknown[]) => unknown[];
};

function mockSql(handlers: Handler[], captured: string[]): SqlClient {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ");
    captured.push(`${sql} :: ${JSON.stringify(values)}`);
    const handler = handlers.find((entry) => entry.match(sql));
    if (!handler) throw new Error(`Unexpected query: ${sql.slice(0, 120)}`);
    return handler.rows(sql, values);
  }) as SqlClient;
}

function opportunityHandlers(overrides: {
  opportunity?: unknown[] | null;
  assessment?: unknown[] | null;
  evidence?: unknown[] | null;
  signals?: unknown[] | null;
} = {}): Handler[] {
  return [
    {
      match: (sql) => sql.includes("from public.opportunities"),
      rows: () =>
        overrides.opportunity ?? [
          {
            id: OPPORTUNITY_ID,
            title: "Acme Manufacturing",
            opportunity_potential_score: 82,
            automation_maturity_score: 41,
            confidence: 0.78,
            latest_assessment_id: ASSESSMENT_ID,
            primary_evidence_id: EVIDENCE_ID,
            org_name: "Acme Manufacturing",
            org_domain: "acme.example",
          },
        ],
    },
    {
      match: (sql) => sql.includes("from public.maturity_assessments"),
      rows: () =>
        overrides.assessment ?? [
          {
            id: ASSESSMENT_ID,
            explanation: { summary: "Manual quoting process takes 3 days." },
            scoring_version: "3.0.0",
            qualified: true,
            confidence: 0.78,
          },
        ],
    },
    {
      match: (sql) => sql.includes("from public.evidence_artifacts"),
      rows: () =>
        overrides.evidence ?? [
          {
            id: EVIDENCE_ID,
            canonical_url: "https://acme.example/about",
            content_type: "text/html",
            content_hash: CONTENT_HASH,
          },
        ],
    },
    {
      match: (sql) => sql.includes("from public.signal_observations"),
      rows: () =>
        overrides.signals ?? [
          {
            code: "manual_quoting",
            category: "commercial",
            excerpt: "Quotes are prepared by hand in spreadsheets.",
          },
        ],
    },
  ];
}

describe("buildHandoffPackage", () => {
  it("builds a schema-valid package with a verifiable signature", async () => {
    const captured: string[] = [];
    const result = await buildHandoffPackage(
      mockSql(opportunityHandlers(), captured),
      {
        workspaceId: WORKSPACE_ID,
        opportunityId: OPPORTUNITY_ID,
        approvedBy: "approver@example.com",
      },
    );
    // Schema validation (already enforced inside, re-assert the contract shape)
    const parsed = LeadEngineHandoffPackageSchema.parse(result.package);
    expect(parsed.schemaVersion).toBe("1.0.0");
    expect(parsed.opportunityId).toBe(OPPORTUNITY_ID);
    expect(parsed.approvedBy).toBe("approver@example.com");
    expect(parsed.supportingArtifacts).toHaveLength(1);
    expect(parsed.supportingArtifacts[0]?.contentHash).toBe(CONTENT_HASH);
    expect(parsed.currentState).toHaveLength(1);
    // The signature verifies over the canonical bytes WITHOUT manifestChecksum,
    // matching the receiver-side checksum definition in the handoff contract.
    const { manifestChecksum, ...base } = result.package;
    expect(manifestChecksum).toBe(result.manifestChecksum);
    expect(sha256CanonicalJson(base)).toBe(result.manifestChecksum);
    expect(
      verifyPackage(
        base,
        result.manifestChecksum,
        result.signature,
        keys.publicKeyPem,
      ),
    ).toBe(true);
  });

  it("omits artifacts whose content hash is not 64-hex", async () => {
    const captured: string[] = [];
    const result = await buildHandoffPackage(
      mockSql(
        opportunityHandlers({
          evidence: [
            {
              id: EVIDENCE_ID,
              canonical_url: "https://acme.example/about",
              content_type: "text/html",
              content_hash: "not-a-sha256",
            },
          ],
        }),
        captured,
      ),
      {
        workspaceId: WORKSPACE_ID,
        opportunityId: OPPORTUNITY_ID,
        approvedBy: "approver@example.com",
      },
    );
    expect(result.package.supportingArtifacts).toHaveLength(0);
  });

  it("throws when the opportunity does not belong to the workspace", async () => {
    const captured: string[] = [];
    await expect(
      buildHandoffPackage(mockSql(opportunityHandlers({ opportunity: [] }), captured), {
        workspaceId: WORKSPACE_ID,
        opportunityId: OPPORTUNITY_ID,
        approvedBy: "approver@example.com",
      }),
    ).rejects.toThrow("Opportunity not found");
  });
});

describe("enqueueHandoffOutbox", () => {
  const input: EnqueueHandoffInput = {
    workspaceId: WORKSPACE_ID,
    idempotencyKey: `handoff:${WORKSPACE_ID}:${OPPORTUNITY_ID}`,
    package: LeadEngineHandoffPackageSchema.parse({
      schemaVersion: "1.0.0",
      packageId: "55555555-5555-4555-8555-555555555555",
      packageVersion: 1,
      opportunityId: OPPORTUNITY_ID,
      organization: { name: "Acme Manufacturing" },
      stakeholders: [],
      problemStatement: "Acme Manufacturing needs automation for quoting.",
      currentState: [],
      requirementBaseline: { version: 1, requirements: [], features: [] },
      constraints: [],
      risksAndAssumptions: [],
      successMeasures: [],
      commercialScope: { scopeSummary: "Quoting automation" },
      supportingArtifacts: [],
      openItems: [],
      approvedBy: "approver@example.com",
      approvedAt: new Date().toISOString(),
      manifestChecksum: CONTENT_HASH,
    }),
    manifestChecksum: CONTENT_HASH,
    signature: "signed-bytes",
  };

  it("calls the RPC with the mapped arguments and returns the row", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const enqueued = await enqueueHandoffOutbox(
      async (name, args) => {
        calls.push({ name, args });
        return {
          data: { id: "66666666-6666-4666-8666-666666666666", status: "pending" },
          error: null,
        };
      },
      input,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("enqueue_handoff_outbox");
    expect(calls[0]?.args).toMatchObject({
      p_workspace_id: WORKSPACE_ID,
      p_idempotency_key: input.idempotencyKey,
      p_checksum: CONTENT_HASH,
      p_signature: "signed-bytes",
    });
    expect(enqueued.id).toBe("66666666-6666-4666-8666-666666666666");
    expect(enqueued.status).toBe("pending");
  });

  it("surfaces RPC errors instead of swallowing them", async () => {
    await expect(
      enqueueHandoffOutbox(
        async () => ({ data: null, error: { message: "permission denied" } }),
        input,
      ),
    ).rejects.toThrow("permission denied");
  });

  it("enforces idempotent enqueue in the migration SQL", () => {
    const migration = readFileSync(
      new URL(
        "../neon/migrations/202609230001_handoff_outbox.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain("on conflict(idempotency_key) do nothing");
    expect(migration).toContain("security definer");
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("handoff_outbox_member_select");
  });
});

describe("dispatchDueHandoffs", () => {
  const row = {
    id: "77777777-7777-4777-8777-777777777777",
    workspace_id: WORKSPACE_ID,
    idempotency_key: `handoff:${WORKSPACE_ID}:${OPPORTUNITY_ID}`,
    package: { schemaVersion: "1.0.0", packageId: "x" },
    manifest_checksum: CONTENT_HASH,
    signature: "base64-signature",
    attempts: 0,
  };

  beforeEach(() => {
    process.env.DELIVERY_INTAKE_URL = "https://delivery.example/intake";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DELIVERY_INTAKE_URL;
  });

  function dispatchClient(captured: string[]): SqlClient {
    return mockSql(
      [
        {
          match: (sql) => sql.includes("from public.handoff_outbox"),
          rows: () => [row],
        },
        {
          match: (sql) => sql.includes("update public.handoff_outbox"),
          rows: () => [],
        },
      ],
      captured,
    );
  }

  it("marks the row sent on a 2xx intake response", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const captured: string[] = [];
    const outcome = await dispatchDueHandoffs(dispatchClient(captured));

    expect(outcome).toEqual({ dispatched: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://delivery.example/intake");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-raphah-signature"]).toBe("base64-signature");
    expect(headers["idempotency-key"]).toBe(row.idempotency_key);
    expect(headers["content-sha256"]).toMatch(/^[a-f0-9]{64}$/);
    expect(headers["x-raphah-timestamp"]).toBeTruthy();
    expect(headers["x-raphah-nonce"]).toBeTruthy();
    expect(init.body).toBe(canonicalJsonStringify(row.package));
    expect(
      captured.some((query) => query.includes("status = 'sent'")),
    ).toBe(true);
  });

  it("schedules an exponential-backoff retry on intake failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    const captured: string[] = [];
    const outcome = await dispatchDueHandoffs(dispatchClient(captured));

    expect(outcome).toEqual({ dispatched: 0, failed: 1 });
    const retryUpdate = captured.find(
      (query) =>
        query.includes("update public.handoff_outbox") &&
        query.includes("next_attempt_at"),
    );
    expect(retryUpdate).toBeTruthy();
    // status, attempts, backoff minutes, error message, id are bind params:
    // attempts 0 -> 1, backoff 2^1 = 2 minutes, row stays pending.
    const values = JSON.parse(retryUpdate!.split(" :: ")[1]) as unknown[];
    expect(values[0]).toBe("pending");
    expect(values[1]).toBe(1);
    expect(values[2]).toBe(2);
    expect(
      captured.some((query) => query.includes("status = 'sent'")),
    ).toBe(false);
  });

  it("marks the row failed after exhausting attempts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const exhausted = { ...row, attempts: 9 };
    const captured: string[] = [];
    const client = mockSql(
      [
        {
          match: (sql) => sql.includes("from public.handoff_outbox"),
          rows: () => [exhausted],
        },
        {
          match: (sql) => sql.includes("update public.handoff_outbox"),
          rows: () => [],
        },
      ],
      captured,
    );
    const outcome = await dispatchDueHandoffs(client);
    expect(outcome).toEqual({ dispatched: 0, failed: 1 });
    const terminalUpdate = captured.find(
      (query) =>
        query.includes("update public.handoff_outbox") &&
        query.includes("next_attempt_at"),
    );
    expect(terminalUpdate).toBeTruthy();
    // attempts 9 -> 10 (exhausted), backoff 2^10 capped at 360 minutes.
    const values = JSON.parse(terminalUpdate!.split(" :: ")[1]) as unknown[];
    expect(values[0]).toBe("failed");
    expect(values[1]).toBe(10);
    expect(values[2]).toBe(360);
  });

  it("leaves rows pending silently when no intake URL is configured", async () => {
    delete process.env.DELIVERY_INTAKE_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const captured: string[] = [];
    const outcome = await dispatchDueHandoffs(dispatchClient(captured));
    expect(outcome).toEqual({ dispatched: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });
});
