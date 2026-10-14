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
  /** How this candidate was produced: the evidence-reading LLM
   *  drafter, or the deterministic rules catalog. */
  source: "llm" | "rules";
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
  source: "rules",
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
      source: "rules",
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
      source: "rules",
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
      source: "rules",
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

/* ── LLM drafter (operator decision 2026-10-14) ───────────────────
 * The rules catalog above can only pattern-match signal codes.
 * The drafter reads the lead's FULL stored evidence text and
 * proposes business-specific use cases. Reality is enforced in
 * code, not trusted to the model: every candidate must carry a
 * verbatim quote from the evidence, and the quote is verified
 * against the exact text the model was shown — an ungrounded
 * candidate is dropped, never displayed. Whatever survives is
 * still only "suggested" until a human approves it. Any failure
 * (no API key, timeout, malformed output) returns null and the
 * caller falls back to the rules catalog, topping up to the
 * 3-candidate floor if the grounded set is smaller.
 */

import { z } from "zod";

const LlmOutputSchema = z.object({
  useCases: z
    .array(
      z.object({
        title: z.string().min(4).max(90),
        statement: z.string().min(20).max(400),
        evidenceQuote: z.string().min(10).max(400),
        rationale: z.string().min(10).max(400),
        acceptanceCriteria: z.array(z.string().min(5).max(200)).min(2).max(5),
      }),
    )
    .min(1)
    .max(6),
});

/** Light cleanup so the model (and the quote check) see text, not markup. */
export function cleanEvidenceText(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24_000);
}

function normalizeForQuote(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** A quote counts as grounded only if it appears in the evidence the model saw. */
export function quoteIsGrounded(quote: string, cleanedEvidence: string): boolean {
  const needle = normalizeForQuote(quote);
  if (needle.length < 24) return false;
  return normalizeForQuote(cleanedEvidence).includes(needle);
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "use-case"
  );
}

export interface LlmDraftInput {
  orgName: string;
  orgDomain?: string | null;
  /** Evidence text AFTER cleanEvidenceText — quotes verify against this. */
  evidenceText: string;
  signals: SignalLike[];
  assessmentSummary?: string | null;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export async function draftUseCasesWithLlm(
  input: LlmDraftInput,
  deps: { fetchFn?: FetchFn; apiKey?: string; model?: string } = {},
): Promise<CandidateUseCase[] | null> {
  const apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey || !input.evidenceText) return null;
  const model = deps.model ?? process.env.LE_LLM_MODEL ?? "gpt-4o-mini";
  const fetchFn = deps.fetchFn ?? fetch;
  const preferredTitles = [
    ...CATALOG.map((entry) => entry.title),
    ...STANDARDS.map((entry) => entry.title),
    CAPACITY_CASE.title,
  ];
  const systemPrompt = [
    "You identify automation use cases for a local service business, working ONLY from evidence text collected from its public website.",
    "Return JSON: {\"useCases\": [{\"title\", \"statement\", \"evidenceQuote\", \"rationale\", \"acceptanceCriteria\": [..]}]} with 3 to 6 use cases.",
    "Rules: every use case must be grounded in the evidence — evidenceQuote must be copied EXACTLY from the evidence text (a short verbatim passage). Never invent services, tools, staff counts, or facts that are not in the text.",
    "statement: one sentence describing the automated end state (what the business gains), written as a requirement.",
    "rationale: why the evidence supports this case, in one or two sentences.",
    "acceptanceCriteria: 2-4 measurable criteria the delivered automation must meet.",
    `When a case matches one of these standard concepts, use its title verbatim: ${preferredTitles.join("; ")}.`,
    "Order by strength of evidence, strongest first.",
  ].join("\n");
  const userPrompt = [
    `Business: ${input.orgName}${input.orgDomain ? ` (${input.orgDomain})` : ""}`,
    input.assessmentSummary
      ? `Assessment summary: ${input.assessmentSummary}`
      : "",
    `Observed signal codes: ${input.signals.map((s) => s.code).join(", ") || "none"}`,
    "",
    "EVIDENCE TEXT:",
    input.evidenceText,
  ]
    .filter(Boolean)
    .join("\n");

  let content: string;
  try {
    const response = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 1600,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    content = payload.choices?.[0]?.message?.content ?? "";
    if (!content) return null;
  } catch {
    return null;
  }

  let parsed: z.infer<typeof LlmOutputSchema>;
  try {
    parsed = LlmOutputSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }

  const grounded: CandidateUseCase[] = [];
  const seenKeys = new Set<string>();
  for (const item of parsed.useCases) {
    if (!quoteIsGrounded(item.evidenceQuote, input.evidenceText)) continue;
    const key = slugify(item.title);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    grounded.push({
      key,
      code: `UC-${key.toUpperCase().slice(0, 40)}`,
      title: item.title,
      statement: item.statement,
      rationale: `${item.rationale} Evidence: "${item.evidenceQuote.replace(/\s+/g, " ").trim()}"`,
      acceptanceCriteria: item.acceptanceCriteria,
      source: "llm",
    });
  }
  return grounded;
}

/**
 * Merge drafter output with the rules catalog: drafter candidates
 * first, rules top up to the 3-candidate floor, cap at 6.
 */
export function mergeUseCaseCandidates(
  drafted: CandidateUseCase[] | null,
  rules: CandidateUseCase[],
): CandidateUseCase[] {
  const out: CandidateUseCase[] = [];
  const seenTitles = new Set<string>();
  const pushUnique = (candidate: CandidateUseCase) => {
    const titleKey = candidate.title.toLowerCase();
    if (seenTitles.has(titleKey) || out.length >= MAX_CANDIDATES) return;
    seenTitles.add(titleKey);
    out.push(candidate);
  };
  for (const candidate of drafted ?? []) pushUnique(candidate);
  for (const candidate of rules) {
    if (out.length >= MIN_CANDIDATES && (drafted?.length ?? 0) > 0) break;
    pushUnique(candidate);
  }
  // If the drafter produced nothing usable, the full rules list applies.
  if (out.length < MIN_CANDIDATES) {
    for (const candidate of rules) pushUnique(candidate);
  }
  return out;
}
