import type { HandoffRequirement } from "@raphah/handoff-contract";

/**
 * Automation use cases for a qualified lead (operator direction
 * 2026-10-14): the Lead Engine IDENTIFIES the opportunities from the
 * lead's stored evidence — at least three real use cases per lead —
 * the reviewer SELECTS one or more and APPROVES them, and the
 * approved set ships to the Delivery Factory as human-validated Must
 * requirements in the handoff package's requirementBaseline. That
 * flow is what satisfies DF's baseline freeze gate (a Must
 * requirement must be status "validated" with a humanValidatorId)
 * without the engine ever inventing authoritative requirements on
 * its own: engine output stays "suggested" until a human approves.
 */

export interface SignalLike {
  code: string;
  category: string;
  polarity: string;
  strength: number;
  excerpt: string;
}

export interface CandidateUseCase {
  key: string;
  code: string;
  title: string;
  statement: string;
  rationale: string;
  acceptanceCriteria: string[];
}

interface CatalogEntry {
  key: string;
  code: string;
  title: string;
  statement: string;
  acceptanceCriteria: string[];
  /** Signal codes whose presence (manual gap) motivates this case. */
  gapSignals: string[];
  rationaleFor: (excerpt: string) => string;
}

const CATALOG: CatalogEntry[] = [
  {
    key: "online_booking",
    code: "UC-ONLINE-BOOKING",
    title: "Online appointment booking",
    statement:
      "Patients can book, reschedule, and cancel appointments online without phoning the practice.",
    acceptanceCriteria: [
      "A patient can complete a booking online in a few minutes, at any hour",
      "Online bookings land directly in the practice schedule — no phone transcription by staff",
      "The patient receives an immediate confirmation with visit details",
    ],
    gapSignals: ["phone_only"],
    rationaleFor: (excerpt) =>
      `Booking appears to run through the phone on the public evidence: "${excerpt}"`,
  },
  {
    key: "digital_intake",
    code: "UC-DIGITAL-INTAKE",
    title: "Digital patient intake",
    statement:
      "New-patient intake, health-history, and consent forms are completed online before the visit instead of on paper or by emailed PDF.",
    acceptanceCriteria: [
      "Intake forms are fillable online with field validation",
      "Submitted information reaches the patient record without manual re-keying",
      "Staff can see which patients have completed intake before the appointment",
    ],
    gapSignals: ["paper_or_pdf", "email_to_apply"],
    rationaleFor: (excerpt) =>
      `Intake appears paper/PDF-based on the public evidence: "${excerpt}"`,
  },
  {
    key: "digital_exchange",
    code: "UC-DIGITAL-EXCHANGE",
    title: "Digital document & referral exchange",
    statement:
      "Referrals, records, and documents are exchanged with other providers digitally instead of by fax.",
    acceptanceCriteria: [
      "Outbound referrals and records can be sent digitally with delivery confirmation",
      "Inbound documents attach to the patient record without printing or scanning",
      "Fax remains only as a fallback, not the primary channel",
    ],
    gapSignals: ["fax"],
    rationaleFor: (excerpt) =>
      `The practice still advertises fax-based exchange: "${excerpt}"`,
  },
  {
    key: "ops_automation",
    code: "UC-OPS-AUTOMATION",
    title: "Replace manual tracking & duplicate entry",
    statement:
      "Operational tracking and reconciliation currently kept in spreadsheets or by duplicate data entry are automated end to end.",
    acceptanceCriteria: [
      "Each operational fact is entered once and flows to where it is needed",
      "Spreadsheet trackers are replaced by a live view of the same data",
      "Reconciliation exceptions surface automatically instead of by manual comparison",
    ],
    gapSignals: ["spreadsheet_ops", "manual_reconciliation"],
    rationaleFor: (excerpt) =>
      `Manual back-office work is visible in the evidence: "${excerpt}"`,
  },
  {
    key: "legacy_modernization",
    code: "UC-LEGACY-MODERNIZATION",
    title: "Modernize the legacy front-desk system",
    statement:
      "The legacy/on-premise system coordinating the front desk is replaced or wrapped by a modern, integrated platform.",
    acceptanceCriteria: [
      "Front-desk workflows run on the modern platform with data migrated",
      "The legacy system is retired or reduced to read-only archive",
      "Staff are trained and the cutover has a rollback path",
    ],
    gapSignals: ["legacy_system"],
    rationaleFor: (excerpt) =>
      `A legacy system anchors operations in the evidence: "${excerpt}"`,
  },
];

/** Standard cases offered for every qualified lead (the ≥3 floor). */
const STANDARDS: Array<Omit<CatalogEntry, "gapSignals" | "rationaleFor"> & {
  rationale: string;
}> = [
  {
    key: "automated_reminders",
    code: "UC-REMINDERS",
    title: "Automated reminders & no-show reduction",
    statement:
      "Appointment confirmations, reminders, and waitlist backfill run automatically by text/email so fewer slots are lost to no-shows.",
    acceptanceCriteria: [
      "Reminders are sent automatically at configurable intervals before each appointment",
      "Confirmations and cancellations update the schedule without staff phone calls",
      "The no-show rate is visible week over week",
    ],
    rationale:
      "Standard high-impact automation for appointment-based practices; offered for every qualified lead.",
  },
  {
    key: "patient_recall",
    code: "UC-RECALL",
    title: "Automated recall & reactivation",
    statement:
      "Patients who are due or overdue for hygiene, follow-up, or treatment are recalled automatically until they rebook.",
    acceptanceCriteria: [
      "Due/overdue patients are identified automatically from the schedule history",
      "Recall messages go out on a set cadence and stop when the patient books",
      "Reactivation results are reported per campaign",
    ],
    rationale:
      "Standard high-impact automation for appointment-based practices; offered for every qualified lead.",
  },
  {
    key: "review_requests",
    code: "UC-REVIEWS",
    title: "Automated review & referral requests",
    statement:
      "After a completed visit, patients are automatically invited to leave a public review or refer a friend.",
    acceptanceCriteria: [
      "Review invitations are sent automatically after completed appointments",
      "Unhappy responses route to the practice privately before anything is posted",
      "New reviews and referrals are counted weekly",
    ],
    rationale:
      "Standard high-impact automation for appointment-based practices; offered for every qualified lead.",
  },
];

const CAPACITY_CASE: CandidateUseCase = {
  key: "front_desk_capacity",
  code: "UC-CAPACITY",
  title: "Front-desk capacity relief for growth",
  statement:
    "Self-service and automation absorb the front-desk workload created by growth and active hiring, so demand turns into capacity instead of backlog.",
  rationale: "",
  acceptanceCriteria: [
    "The top call reasons (booking, intake, reminders) are handled by self-service or automation",
    "Front-desk staff time shifts from repetitive calls to patient care and follow-up",
    "Booking lead time and missed-call volume are tracked monthly",
  ],
};

const MAX_CANDIDATES = 6;
const MIN_CANDIDATES = 3;

function shortExcerpt(excerpt: string): string {
  const clean = excerpt.replace(/\s+/g, " ").trim();
  return clean.length > 160 ? `${clean.slice(0, 157)}…` : clean;
}

/**
 * Deterministic candidate generation from the lead's stored signals.
 * Order: evidence-matched gap cases (strongest signal first), the
 * absence-based booking case, the growth/capacity case when hiring or
 * expansion signals exist, then the standards. Always ≥3.
 */
export function generateUseCases(signals: SignalLike[]): CandidateUseCase[] {
  const byCode = new Map<string, SignalLike>();
  for (const signal of signals) {
    const existing = byCode.get(signal.code);
    if (!existing || signal.strength > existing.strength) {
      byCode.set(signal.code, signal);
    }
  }
  const out: CandidateUseCase[] = [];
  const seen = new Set<string>();
  const push = (candidate: CandidateUseCase) => {
    if (seen.has(candidate.key) || out.length >= MAX_CANDIDATES) return;
    seen.add(candidate.key);
    out.push(candidate);
  };

  const matched: Array<{ entry: CatalogEntry; signal: SignalLike }> = [];
  for (const entry of CATALOG) {
    let best: SignalLike | null = null;
    for (const code of entry.gapSignals) {
      const signal = byCode.get(code);
      if (signal && (!best || signal.strength > best.strength)) best = signal;
    }
    if (best) matched.push({ entry, signal: best });
  }
  matched.sort((a, b) => b.signal.strength - a.signal.strength);
  for (const { entry, signal } of matched) {
    push({
      key: entry.key,
      code: entry.code,
      title: entry.title,
      statement: entry.statement,
      rationale: entry.rationaleFor(shortExcerpt(signal.excerpt)),
      acceptanceCriteria: entry.acceptanceCriteria,
    });
  }

  // Absence-based: no online booking capability observed at all.
  if (!byCode.has("online_booking") && !seen.has("online_booking")) {
    const entry = CATALOG[0];
    push({
      key: entry.key,
      code: entry.code,
      title: entry.title,
      statement: entry.statement,
      rationale:
        "No online booking was found in the collected public evidence — scheduling appears to require staff involvement.",
      acceptanceCriteria: entry.acceptanceCriteria,
    });
  }

  // Growth-linked: hiring / market / expansion pressure.
  const growthSignal =
    byCode.get("job_bank_market_hiring") ??
    byCode.get("transformation_hiring") ??
    byCode.get("expansion");
  if (growthSignal) {
    push({
      ...CAPACITY_CASE,
      rationale: `Growth pressure is visible in the evidence: "${shortExcerpt(growthSignal.excerpt)}"`,
    });
  }

  for (const standard of STANDARDS) {
    push({
      key: standard.key,
      code: standard.code,
      title: standard.title,
      statement: standard.statement,
      rationale: standard.rationale,
      acceptanceCriteria: standard.acceptanceCriteria,
    });
  }
  return out.slice(0, Math.max(MIN_CANDIDATES, Math.min(out.length, MAX_CANDIDATES)));
}

/** A stored opportunity_use_cases row, as the builder consumes it. */
export interface ApprovedUseCaseRow {
  id: string;
  code: string;
  statement: string;
  acceptance_criteria: string[] | unknown;
  human_validator_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Map an approved use-case row to the contract requirement the
 * Delivery Factory freeze gate accepts: priority "must", status
 * "validated", a human validator, and no blocking questions.
 */
export function mapUseCaseToRequirement(
  row: ApprovedUseCaseRow,
  opportunityId: string,
  sourceEvidenceId: string | null,
): HandoffRequirement {
  const criteria = Array.isArray(row.acceptance_criteria)
    ? row.acceptance_criteria.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  return {
    id: row.id,
    opportunityId,
    code: row.code,
    statement: row.statement,
    priority: "must",
    status: "validated",
    sourceEvidenceId: sourceEvidenceId ?? undefined,
    humanValidatorId: row.human_validator_id ?? undefined,
    acceptanceCriteria: criteria,
    blockingQuestions: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
