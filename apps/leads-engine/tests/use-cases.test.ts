import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanEvidenceText,
  draftUseCasesWithLlm,
  generateUseCases,
  mapUseCaseToRequirement,
  mergeUseCaseCandidates,
  quoteIsGrounded,
  type SignalLike,
} from "../api/_lib/use-cases.js";
import { RequirementSchema } from "@raphah/handoff-contract";

const signal = (
  code: string,
  strength: number,
  excerpt = "evidence excerpt",
  polarity = "manual",
): SignalLike => ({ code, category: "test", polarity, strength, excerpt });

describe("generateUseCases — the engine identifies the opportunities", () => {
  it("always returns at least three use cases, even with no signals", () => {
    const cases = generateUseCases([]);
    expect(cases.length).toBeGreaterThanOrEqual(3);
    expect(cases.map((c) => c.key)).toContain("automated_reminders");
  });

  it("leads with the evidence-matched gap cases, strongest signal first", () => {
    const cases = generateUseCases([
      signal("phone_only", 18, "Call us to book an appointment"),
      signal("fax", 22, "Fax: 416-555-0100"),
      signal("paper_or_pdf", 18, "Download the PDF intake form"),
    ]);
    expect(cases[0].key).toBe("digital_exchange"); // fax strength 22
    expect(cases.map((c) => c.key)).toContain("online_booking");
    expect(cases.map((c) => c.key)).toContain("digital_intake");
    // Rationales cite the actual evidence.
    expect(cases[0].rationale).toContain("Fax: 416-555-0100");
  });

  it("adds the booking case by absence when no booking capability exists", () => {
    const cases = generateUseCases([signal("legacy_system", 17)]);
    expect(cases.map((c) => c.key)).toContain("online_booking");
    const booking = cases.find((c) => c.key === "online_booking");
    expect(booking?.rationale).toContain("No online booking was found");
  });

  it("adds the capacity case when hiring/market pressure exists", () => {
    const cases = generateUseCases([
      signal(
        "job_bank_market_hiring",
        20,
        "34 postings for clinic front-desk roles in Toronto",
        "commercial",
      ),
    ]);
    expect(cases.map((c) => c.key)).toContain("front_desk_capacity");
  });

  it("caps the list at six and never duplicates a key", () => {
    const cases = generateUseCases([
      signal("phone_only", 18),
      signal("fax", 22),
      signal("paper_or_pdf", 18),
      signal("email_to_apply", 14),
      signal("spreadsheet_ops", 16),
      signal("manual_reconciliation", 18),
      signal("legacy_system", 17),
      signal("expansion", 14, "opening a new location", "commercial"),
    ]);
    expect(cases.length).toBeLessThanOrEqual(6);
    expect(new Set(cases.map((c) => c.key)).size).toBe(cases.length);
  });

  it("every candidate carries a statement and acceptance criteria", () => {
    for (const candidate of generateUseCases([signal("phone_only", 18)])) {
      expect(candidate.statement.length).toBeGreaterThanOrEqual(5);
      expect(candidate.acceptanceCriteria.length).toBeGreaterThanOrEqual(2);
      expect(candidate.code).toMatch(/^UC-/);
    }
  });
});

describe("mapUseCaseToRequirement — the DF freeze gate shape", () => {
  const row = {
    id: "0f5a2e6c-0000-4000-8000-000000000001",
    code: "UC-ONLINE-BOOKING",
    statement:
      "Patients can book, reschedule, and cancel appointments online without phoning the practice.",
    acceptance_criteria: ["Criterion one", "Criterion two"],
    human_validator_id: "reviewer@example.com",
    created_at: "2026-10-14T13:00:00.000Z",
    updated_at: "2026-10-14T13:05:00.000Z",
  };

  it("produces a contract-valid requirement", () => {
    const requirement = mapUseCaseToRequirement(
      row,
      "0f5a2e6c-0000-4000-8000-0000000000aa",
      "0f5a2e6c-0000-4000-8000-0000000000bb",
    );
    expect(() => RequirementSchema.parse(requirement)).not.toThrow();
  });

  it("normalizes Date timestamps from the Neon driver to ISO strings", () => {
    // Production regression (2026-10-14): the Neon SQL driver
    // returns timestamptz as Date objects; the contract schema
    // requires strings, and Send to DF failed on exactly this.
    const requirement = mapUseCaseToRequirement(
      {
        ...row,
        created_at: new Date("2026-10-14T13:00:00.000Z"),
        updated_at: new Date("2026-10-14T13:05:00.000Z"),
      },
      "opp-1",
      null,
    );
    expect(requirement.createdAt).toBe("2026-10-14T13:00:00.000Z");
    expect(requirement.updatedAt).toBe("2026-10-14T13:05:00.000Z");
    expect(() => RequirementSchema.parse(requirement)).not.toThrow();
  });

  it("satisfies the freeze rule for Must requirements", () => {
    const requirement = mapUseCaseToRequirement(row, "opp-1", null);
    expect(requirement.priority).toBe("must");
    expect(requirement.status).toBe("validated");
    expect(requirement.humanValidatorId).toBe("reviewer@example.com");
    expect(requirement.blockingQuestions).toEqual([]);
  });
});

describe("use-case handoff wiring — source contracts", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const router = readFileSync(join(here, "../api/_lib/router.ts"), "utf8");
  const handoff = readFileSync(join(here, "../api/_lib/handoff.ts"), "utf8");
  const main = readFileSync(join(here, "../src/main.tsx"), "utf8");
  const migration = readFileSync(
    join(here, "../neon/migrations/202610120009_use_cases_handoff.sql"),
    "utf8",
  );

  it("the builder ships approved use cases, not a hard-coded empty baseline", () => {
    expect(handoff).toContain("from public.opportunity_use_cases");
    expect(handoff).toContain("status = 'approved'");
    expect(handoff).not.toContain("requirements: [], features: []");
  });

  it("the handoff route refuses a lead with no approved use cases", () => {
    expect(router).toContain("Approve at least one use case");
    expect(router).toContain("statusCode: 409");
  });

  it("the enqueue RPC refreshes an unsent package instead of pinning the first", () => {
    expect(migration).toContain("on conflict(idempotency_key) do update");
    // Only settled rows refresh: a 'dispatching' row has a request
    // in flight to DF and must never be rewritten under it.
    expect(migration).toContain("status in ('pending', 'failed')");
    expect(migration).toContain("attempts = 0");
  });

  it("the use-case table carries explicit Data API privileges (Codex P1)", () => {
    expect(migration).toContain(
      "grant select on public.opportunity_use_cases to authenticated",
    );
    // The production correction migration carries the same fixes
    // for databases that already ran the original 0009.
    const correction = readFileSync(
      join(here, "../neon/migrations/202610120010_use_cases_fixes.sql"),
      "utf8",
    );
    expect(correction).toContain(
      "grant select on public.opportunity_use_cases to authenticated",
    );
    expect(correction).toContain(
      "grant select on public.consent_records to authenticated",
    );
    expect(correction).toContain("status in ('pending', 'failed')");
    expect(correction).toContain("'analyst', 'reviewer'");
    // Grants are additive: the SELECT-only boundary needs revokes.
    expect(correction).toContain(
      "revoke insert, update on public.opportunity_use_cases from authenticated",
    );
    expect(correction).toContain(
      "revoke insert, update on public.consent_records from authenticated",
    );
  });

  it("the feedback route records decisions server-side (production 500 fix)", () => {
    const at = router.indexOf("leadFeedback &&");
    const block = router.slice(at, at + 2600);
    expect(block).toContain("insert into public.lead_feedback");
    expect(block).toContain("Could not record the review decision");
    // The privileged insert re-checks the opportunity's workspace
    // (the guarantee the bypassed RLS policy used to provide).
    expect(block).toContain("and workspace_id = ${workspaceId}::uuid");
    expect(block).toContain('"Opportunity not found"');
  });

  it("approval writes stay behind the server boundary (Codex P1 + P2)", () => {
    // Atomic set replacement in ONE statement, on the server client.
    expect(router).toContain("with updated as (");
    expect(router).toContain("uc.id::text = any(");
    // Generation + consent inserts run on the server connection too.
    expect(router).toContain("insert into public.opportunity_use_cases");
    expect(router).toContain("insert into public.consent_records");
    // Unknown selections 404 before any write; measures are
    // required at approval (Codex P2s on the bundle head).
    expect(router).toContain("have no success measure yet");
  });

  it("the reviewer who selects use cases can also approve them (Codex P2)", () => {
    const at = router.indexOf("opportunityUseCasesApprove &&");
    expect(at).toBeGreaterThan(-1);
    expect(router.slice(at, at + 400)).toContain('"reviewer"');
    expect(migration).toContain("'analyst', 'reviewer'");
  });

  it("a resend never reports a discarded package as enqueued (Codex P2)", () => {
    expect(router).toContain("enqueued.manifestChecksum !== manifestChecksum");
    expect(router).toContain("the changed use cases were not sent");
    expect(handoff).toContain("manifestChecksum: row.manifest_checksum");
  });

  it("delivery confirmation is wired: status feed, landed banner, 5s toasts", () => {
    expect(router).toContain('"/api/v1/handoffs" && request.method === "GET"');
    expect(main).toContain("Landed — the Delivery Factory accepted");
    expect(main).toContain("toast.kind === \"error\" ? 8000 : 5000");
  });
});

describe("LLM drafter — full evidence, citation-verified", () => {
  const evidence =
    "Welcome to Donddental. To book an appointment please call us at 416-555-0100 during office hours. " +
    "New patients: download our intake form (PDF), print it, and bring the completed paperwork to your first visit. " +
    "We send referrals by fax to your family doctor.";

  it("cleanEvidenceText strips markup", () => {
    const cleaned = cleanEvidenceText(
      "<html><style>.a{}</style><body><p>Call   us</p><script>var x=1;</script></body></html>",
    );
    expect(cleaned).toBe("Call us");
  });

  it("quoteIsGrounded requires a verbatim passage from the evidence", () => {
    expect(
      quoteIsGrounded("please call us at 416-555-0100 during office hours", evidence),
    ).toBe(true);
    expect(
      quoteIsGrounded("book online instantly through our portal", evidence),
    ).toBe(false);
    expect(quoteIsGrounded("call us", evidence)).toBe(false); // too short
  });

  const fakeFetch = (content: unknown, ok = true) =>
    (async () => ({
      ok,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(content) } }],
      }),
    })) as never;

  it("keeps only grounded candidates and marks them as LLM-sourced", async () => {
    const drafted = await draftUseCasesWithLlm(
      { orgName: "Donddental", evidenceText: evidence, signals: [] },
      {
        apiKey: "test-key",
        fetchFn: fakeFetch({
          useCases: [
            {
              title: "Online appointment booking",
              statement:
                "Patients can book appointments online instead of phoning during office hours.",
              evidenceQuote:
                "To book an appointment please call us at 416-555-0100 during office hours",
              rationale: "Booking is phone-only today.",
              acceptanceCriteria: [
                "Patients can book online at any hour",
                "Bookings land directly in the schedule",
              ],
              successMetric: "Online booking share",
              successTarget: "At least 50% of new appointments booked online within 90 days",
            },
            {
              title: "Patient portal",
              statement:
                "Patients manage everything through a self-service portal.",
              evidenceQuote: "our patient portal gives you full control",
              rationale: "Invented — must be dropped.",
              acceptanceCriteria: ["Portal exists", "Patients use it"],
              successMetric: "Portal adoption",
              successTarget: "Most patients use the portal",
            },
          ],
        }),
      },
    );
    expect(drafted).toHaveLength(1);
    expect(drafted?.[0].source).toBe("llm");
    expect(drafted?.[0].rationale).toContain("Evidence:");
  });

  it("returns null without an API key or on provider failure", async () => {
    expect(
      await draftUseCasesWithLlm(
        { orgName: "X", evidenceText: evidence, signals: [] },
        { apiKey: "", fetchFn: fakeFetch({}) },
      ),
    ).toBeNull();
    expect(
      await draftUseCasesWithLlm(
        { orgName: "X", evidenceText: evidence, signals: [] },
        { apiKey: "k", fetchFn: fakeFetch({}, false) },
      ),
    ).toBeNull();
  });

  it("mergeUseCaseCandidates tops up a thin drafted set to the floor of 3", () => {
    const rules = generateUseCases([]);
    const merged = mergeUseCaseCandidates(
      [
        {
          key: "ai-one",
          code: "UC-AI-ONE",
          title: "A very specific case",
          statement: "A specific statement for the merged case.",
          rationale: "Grounded in evidence.",
          acceptanceCriteria: ["One", "Two"],
          successMetric: "A metric",
          successTarget: "A target",
          source: "llm" as const,
        },
      ],
      rules,
    );
    expect(merged.length).toBeGreaterThanOrEqual(3);
    expect(merged[0].key).toBe("ai-one");
    expect(
      mergeUseCaseCandidates(null, rules).map((c) => c.key),
    ).toEqual(rules.map((c) => c.key));
  });
});
