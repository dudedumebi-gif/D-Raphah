import { z } from "zod";
import { quoteIsGrounded } from "./use-cases.js";

/**
 * Lead proposal drafting — LE side, by design (operator decision
 * 2026-10-14, following the placement brief): the proposal and the
 * outreach live in the Lead Engine, where the evidence, the
 * reviewer-approved use cases, and the CASL consent records live.
 * Only endorsed leads ship onward to the Delivery Factory; DF
 * never contacts a prospect and never invents the promises — the
 * approved OKRs travel in the handoff package as successMeasures
 * and DF measures delivery against exactly those numbers.
 *
 * The drafter reads the lead's full stored evidence plus its
 * APPROVED use cases (with their success measures). Every factual
 * claim must be backed by a verbatim evidence quote, verified in
 * code exactly like the use-case drafter; a draft whose quotes do
 * not verify is discarded wholesale (prose cannot be partially
 * excised honestly) and the caller falls back to the deterministic
 * template below, which makes no claims beyond the stored signal
 * excerpts. A human reviews, edits, and approves the final text,
 * and a human sends it — nothing auto-sends, ever.
 */

export interface ApprovedUseCaseForProposal {
  title: string;
  statement: string;
  successMetric: string | null;
  successTarget: string | null;
}

export interface ProposalDraftInput {
  orgName: string;
  orgDomain?: string | null;
  /** Evidence text AFTER cleanEvidenceText — quotes verify against this. */
  evidenceText: string;
  useCases: ApprovedUseCaseForProposal[];
  assessmentSummary?: string | null;
}

export interface ProposalDraft {
  text: string;
  draftedBy: "llm" | "template";
  model: string | null;
  evidenceQuotes: string[];
}

const ProposalOutputSchema = z.object({
  message: z.string().min(120).max(4_000),
  evidenceQuotes: z.array(z.string().min(10).max(400)).min(1).max(6),
});

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export async function draftProposalWithLlm(
  input: ProposalDraftInput,
  deps: { fetchFn?: FetchFn; apiKey?: string; model?: string } = {},
): Promise<ProposalDraft | null> {
  const apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey || !input.evidenceText || input.useCases.length === 0)
    return null;
  const model = deps.model ?? process.env.LE_LLM_MODEL ?? "gpt-4o-mini";
  const fetchFn = deps.fetchFn ?? fetch;
  const useCaseBlock = input.useCases
    .map(
      (useCase, i) =>
        `${i + 1}. ${useCase.title} — ${useCase.statement}` +
        (useCase.successMetric && useCase.successTarget
          ? `\n   Success measure: ${useCase.successMetric} — target: ${useCase.successTarget}`
          : ""),
    )
    .join("\n");
  const systemPrompt = [
    "You draft a short, professional outreach proposal from an automation consultancy to a local service business, proposing a free automation assessment.",
    'Return JSON: {"message": "...", "evidenceQuotes": ["...", ...]}.',
    "The message: a subject line, a greeting, two or three short paragraphs, and a sign-off with the placeholder [Your name].",
    "Paragraph 1: what you noticed about how the business operates today — ONLY facts from the evidence text, phrased plainly and respectfully (never condescending about their current tools).",
    "Paragraph 2: the approved automation use cases below, in the business's own terms, and the success measures the sender commits to be measured on.",
    "Paragraph 3: the ask — a brief assessment call to confirm fit, with no obligation.",
    "evidenceQuotes: copy verbatim from the evidence text every passage that backs a factual claim in paragraph 1 (at least one). Never invent services, tools, numbers, staff, or facts that are not in the text. Do not promise prices or timelines.",
  ].join("\n");
  const userPrompt = [
    `Business: ${input.orgName}${input.orgDomain ? ` (${input.orgDomain})` : ""}`,
    input.assessmentSummary
      ? `Assessment summary: ${input.assessmentSummary}`
      : "",
    "",
    "APPROVED USE CASES (already validated by a human reviewer):",
    useCaseBlock,
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
        temperature: 0.3,
        max_tokens: 1400,
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

  let parsed: z.infer<typeof ProposalOutputSchema>;
  try {
    parsed = ProposalOutputSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
  // All-or-nothing grounding: a proposal whose evidence claims do
  // not verify is not shown to the reviewer at all.
  if (
    !parsed.evidenceQuotes.every((quote) =>
      quoteIsGrounded(quote, input.evidenceText),
    )
  )
    return null;
  return {
    text: parsed.message,
    draftedBy: "llm",
    model,
    evidenceQuotes: parsed.evidenceQuotes,
  };
}

/**
 * Deterministic proposal draft (no LLM, no ungrounded claims):
 * assembled from the approved use cases and their measures only.
 */
export function templateProposal(input: {
  orgName: string;
  useCases: ApprovedUseCaseForProposal[];
}): ProposalDraft {
  const lines: string[] = [
    `Subject: A proposal to automate front-desk work at ${input.orgName}`,
    "",
    `Hello ${input.orgName} team,`,
    "",
    "We reviewed how your business handles bookings, intake, and follow-up day to day, and we see a few concrete places where automation would give your team real time back. We would like to propose the following, scoped from what we observed:",
    "",
    ...input.useCases.map(
      (useCase) => `• ${useCase.title} — ${useCase.statement}`,
    ),
    "",
    "We are happy to be measured on the results. For each item we propose a success measure we will report against:",
    "",
    ...input.useCases
      .filter((useCase) => useCase.successMetric && useCase.successTarget)
      .map(
        (useCase) =>
          `• ${useCase.successMetric}: ${useCase.successTarget}`,
      ),
    "",
    "If this is useful, we would welcome a short assessment call to confirm fit and walk through what delivery would look like — no obligation either way.",
    "",
    "Thank you for your time,",
    "[Your name]",
  ];
  return { text: lines.join("\n"), draftedBy: "template", model: null, evidenceQuotes: [] };
}
