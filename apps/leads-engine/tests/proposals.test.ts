import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  draftProposalWithLlm,
  templateProposal,
  type ApprovedUseCaseForProposal,
} from "../api/_lib/proposals.js";
import { buildHandoffPackage } from "../api/_lib/handoff.js";
import { generateKeyPairSync } from "node:crypto";

const testKeys = generateKeyPairSync("ed25519");
process.env.HANDOFF_SIGNING_PRIVATE_KEY_PEM = testKeys.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.HANDOFF_SIGNING_PUBLIC_KEY_PEM = testKeys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

const staging = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../staging48/${name}`, import.meta.url)),
    "utf8",
  );

const useCases: ApprovedUseCaseForProposal[] = [
  {
    title: "Online appointment booking",
    statement:
      "Patients can book, reschedule, and cancel appointments online at any hour.",
    successMetric: "Appointment no-show rate",
    successTarget: "Reduced by at least 25% within 90 days of launch",
  },
];

describe("Proposal drafting (LE-side, evidence-grounded)", () => {
  const evidence =
    "Welcome to Donddental. To book an appointment please call us at 416-555-0100 during office hours. " +
    "New patients: download our intake form (PDF), print it, and bring the completed paperwork to your first visit.";

  const fakeFetch = (content: unknown, ok = true) =>
    (async () => ({
      ok,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(content) } }],
      }),
    })) as never;

  it("returns a draft when every evidence quote verifies", async () => {
    const draft = await draftProposalWithLlm(
      { orgName: "Donddental", evidenceText: evidence, useCases },
      {
        apiKey: "test-key",
        fetchFn: fakeFetch({
          message:
            "Subject: A proposal for Donddental\n\nHello Donddental team,\n\nWe noticed appointments are booked by phone during office hours. We propose online booking, and we will be measured on the no-show rate. Would a short assessment call suit?\n\n[Your name]",
          evidenceQuotes: [
            "To book an appointment please call us at 416-555-0100 during office hours",
          ],
        }),
      },
    );
    expect(draft?.draftedBy).toBe("llm");
    expect(draft?.text).toContain("Donddental");
  });

  it("discards the whole draft when a quote does not verify", async () => {
    const draft = await draftProposalWithLlm(
      { orgName: "Donddental", evidenceText: evidence, useCases },
      {
        apiKey: "test-key",
        fetchFn: fakeFetch({
          message:
            "Subject: Proposal\n\nHello team,\n\nYour patient portal already handles bookings, so we propose extending it further with reminders and recall, measured on reactivations. A short call?\n\n[Your name]",
          evidenceQuotes: ["your patient portal already handles bookings"],
        }),
      },
    );
    expect(draft).toBeNull();
  });

  it("template fallback uses only the approved cases and their measures", () => {
    const draft = templateProposal({ orgName: "Donddental", useCases });
    expect(draft.draftedBy).toBe("template");
    expect(draft.text).toContain("Online appointment booking");
    expect(draft.text).toContain("Appointment no-show rate");
    expect(draft.evidenceQuotes).toEqual([]);
  });
});

describe("Handoff package ships the approved OKRs", () => {
  // Minimal SQL-tag stub for buildHandoffPackage's reads.
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    void values;
    if (text.includes("from public.opportunities o"))
      return Promise.resolve([
        {
          id: "11111111-1111-4111-8111-111111111111",
          organization_id: "33333333-3333-4333-8333-333333333333",
          campaign_id: null,
          status: "active",
          primary_evidence_id: "44444444-4444-4444-8444-444444444444",
          title: "Donddental",
          org_name: "Donddental",
          org_domain: "donddental.example",
          geography: "Toronto",
          industry: "Dental clinic",
          maturity_score: 40,
          opportunity_score: 61,
          confidence: 0.85,
        },
      ]);
    if (text.includes("maturity_assessments"))
      return Promise.resolve([
        {
          explanation: { summary: "Phone-first front desk." },
          detected_signals: [],
          dimension_scores: {},
          confidence: 0.85,
          assessment_version: "3.0.0",
        },
      ]);
    if (text.includes("signal_observations")) return Promise.resolve([]);
    if (text.includes("evidence_artifacts"))
      return Promise.resolve([
        {
          id: "44444444-4444-4444-8444-444444444444",
          source_locator: "https://donddental.example",
          captured_at: new Date(),
        },
      ]);
    if (text.includes("opportunity_use_cases"))
      return Promise.resolve([
        {
          id: "uc-1",
          code: "UC-ONLINE-BOOKING",
          statement:
            "Patients can book, reschedule, and cancel appointments online at any hour.",
          acceptance_criteria: ["Patients can book online at any hour"],
          human_validator_id: "reviewer@example.com",
          created_at: "2026-10-14T00:00:00Z",
          updated_at: "2026-10-14T00:00:00Z",
          success_metric: "Appointment no-show rate",
          success_target: "Reduced by at least 25% within 90 days of launch",
        },
        {
          id: "uc-2",
          code: "UC-REMINDERS",
          statement: "Automated reminders go out before every appointment.",
          acceptance_criteria: ["Reminders are sent automatically"],
          human_validator_id: "reviewer@example.com",
          created_at: "2026-10-14T00:00:00Z",
          updated_at: "2026-10-14T00:00:00Z",
          success_metric: null,
          success_target: null,
        },
      ]);
    return Promise.resolve([]);
  };

  it("successMeasures carries exactly the approved measures", async () => {
    const { package: pkg } = await buildHandoffPackage(sql as never, {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      opportunityId: "11111111-1111-4111-8111-111111111111",
      approvedBy: "reviewer@example.com",
    });
    expect(pkg.successMeasures).toEqual([
      {
        metric: "Appointment no-show rate",
        target: "Reduced by at least 25% within 90 days of launch",
      },
    ]);
    expect(pkg.requirementBaseline.requirements).toHaveLength(2);
  });
});

describe("Proposal migration + route wiring", () => {
  const migration = staging("202610120011_proposals.sql");
  const router = staging("router.ts");
  const handoff = staging("handoff.ts");

  it("the proposal migration ships WITH its Data API grants", () => {
    expect(migration).toContain("create table public.lead_proposals");
    expect(migration).toContain(
      "grant select on public.lead_proposals to authenticated",
    );
    expect(migration).toContain("audit_lead_proposals");
    expect(migration).toContain("add column if not exists success_metric");
  });

  it("the proposal routes exist and approval is consent-gated", () => {
    expect(router).toContain("opportunityProposalDraft");
    expect(router).toContain("opportunityProposalApprove");
    expect(router).toContain("opportunityProposalSent");
    expect(router).toContain("Record a CASL consent basis for this lead");
    expect(router).toContain("'contacted'");
    expect(router).toContain("'PROPOSAL_SENT'");
    expect(router).toContain("insert into public.lead_proposals");
  });

  it("the builder no longer hard-codes empty success measures", () => {
    expect(handoff).not.toContain("successMeasures: [],");
    expect(handoff).toContain("const successMeasures = useCaseRows");
  });
});
