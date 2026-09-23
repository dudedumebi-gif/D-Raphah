import { createHash } from "node:crypto";
import { z } from "zod";

export const CriteriaSchema = z.object({
  automationMaturityMax: z.number().min(0).max(100).default(40),
  opportunityPotentialMin: z.number().min(0).max(100).default(60),
  confidenceMin: z.number().min(0).max(1).default(0.7),
  minimumEvidenceCategories: z.number().int().min(1).max(6).default(2),
  targetQualifiedLeadsPerWeek: z.number().int().min(1).max(10_000).default(20),
  industries: z.array(z.string()).default([]),
  employeeMinimum: z.number().int().min(1).default(5),
  employeeMaximum: z.number().int().min(1).default(50),
  geography: z
    .object({
      mode: z.enum(["radius", "regions", "hybrid"]).default("hybrid"),
      cities: z.array(z.string()).default(["Toronto", "Ottawa", "Montreal"]),
      regions: z.array(z.string()).default(["Ontario", "Quebec"]),
      radiusKm: z.number().min(1).max(1000).default(50),
      centreLatitude: z.number().min(-90).max(90).nullable().default(null),
      centreLongitude: z.number().min(-180).max(180).nullable().default(null),
    })
    .default({}),
}).superRefine((criteria, ctx) => {
  if (criteria.employeeMinimum > criteria.employeeMaximum) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["employeeMinimum"],
      message: "employeeMinimum must not exceed employeeMaximum",
    });
  }
});

export type LeadCriteria = z.infer<typeof CriteriaSchema>;

export type SignalCategory =
  | "digital_foundation"
  | "customer_self_service"
  | "workflow_automation"
  | "data_analytics"
  | "ai_adoption"
  | "manual_friction"
  | "commercial_urgency";

export interface DetectedSignal {
  code: string;
  category: SignalCategory;
  polarity: "manual" | "automated" | "commercial";
  strength: number;
  confidence: number;
  excerpt: string;
}

export interface ScoreResult {
  automationMaturity: number;
  opportunityPotential: number;
  confidence: number;
  coverageCategories: number;
  qualified: boolean;
  explanation: string[];
  components: Record<string, number>;
  scoringVersion: string;
}

export interface GeographyEvaluation {
  eligible: boolean;
  city: string | null;
  region: string | null;
  matchedTerms: string[];
  basis:
    | "not_restricted"
    | "configured_location_match"
    | "location_not_verified"
    | "within_radius"
    | "outside_radius";
  distanceKm?: number;
}

export interface CriteriaSuggestion {
  direction: "loosen" | "hold" | "tighten";
  observedQualifiedLeads: number;
  targetQualifiedLeads: number;
  changes: Partial<
    Pick<
      LeadCriteria,
      | "automationMaturityMax"
      | "opportunityPotentialMin"
      | "confidenceMin"
      | "minimumEvidenceCategories"
    >
  >;
  rationale: string[];
  autoApply: false;
}

const SIGNAL_RULES: Array<{
  code: string;
  category: SignalCategory;
  polarity: DetectedSignal["polarity"];
  strength: number;
  pattern: RegExp;
}> = [
  {
    code: "phone_only",
    category: "customer_self_service",
    polarity: "manual",
    strength: 18,
    pattern: /call (?:us|to book|for an appointment)|phone[- ]only/i,
  },
  {
    code: "email_to_apply",
    category: "workflow_automation",
    polarity: "manual",
    strength: 14,
    pattern:
      /email (?:your|us your|to apply)|send (?:us )?(?:a )?(?:completed )?form/i,
  },
  {
    code: "paper_or_pdf",
    category: "manual_friction",
    polarity: "manual",
    strength: 18,
    pattern:
      /paperwork|paper[- ]based|download (?:the )?(?:pdf|form)|print and (?:sign|complete)|fillable pdf/i,
  },
  {
    code: "fax",
    category: "manual_friction",
    polarity: "manual",
    strength: 22,
    pattern: /\bfax(?:ed|ing)?\b/i,
  },
  {
    code: "spreadsheet_ops",
    category: "workflow_automation",
    polarity: "manual",
    strength: 16,
    pattern:
      /manual data entry|copy and paste|spreadsheet tracking|excel (?:tracking|reports|reconciliation)/i,
  },
  {
    code: "manual_reconciliation",
    category: "manual_friction",
    polarity: "manual",
    strength: 18,
    pattern: /manual(?:ly)? reconcil|repetitive admin|duplicate data entry/i,
  },
  {
    code: "legacy_system",
    category: "digital_foundation",
    polarity: "manual",
    strength: 17,
    pattern:
      /legacy (?:system|software|platform)|on[- ]premise (?:system|software)|desktop application/i,
  },
  {
    code: "online_booking",
    category: "customer_self_service",
    polarity: "automated",
    strength: 18,
    pattern:
      /book online|online booking|schedule online|self[- ]service scheduling/i,
  },
  {
    code: "customer_portal",
    category: "customer_self_service",
    polarity: "automated",
    strength: 20,
    pattern:
      /customer portal|client portal|self[- ]service portal|track your (?:order|request|application)/i,
  },
  {
    code: "digital_intake",
    category: "workflow_automation",
    polarity: "automated",
    strength: 15,
    pattern:
      /digital intake|online application|online form|automated workflow/i,
  },
  {
    code: "crm_erp",
    category: "digital_foundation",
    polarity: "automated",
    strength: 15,
    pattern: /salesforce|hubspot|dynamics 365|netsuite|\bsap\b|workday|servicenow/i,
  },
  {
    code: "integration",
    category: "workflow_automation",
    polarity: "automated",
    strength: 18,
    pattern:
      /api integration|integrated platform|zapier|mulesoft|boomi|workato|power automate/i,
  },
  {
    code: "analytics",
    category: "data_analytics",
    polarity: "automated",
    strength: 16,
    pattern:
      /power bi|tableau|looker|data warehouse|business intelligence|predictive analytics/i,
  },
  {
    code: "ai_adoption",
    category: "ai_adoption",
    polarity: "automated",
    strength: 22,
    pattern:
      /artificial intelligence|generative ai|machine learning|ai assistant|ai chatbot|copilot/i,
  },
  {
    code: "transformation_hiring",
    category: "commercial_urgency",
    polarity: "commercial",
    strength: 18,
    pattern:
      /digital transformation|process improvement|automation (?:lead|manager|specialist)|systems modernization/i,
  },
  {
    code: "funding_or_tender",
    category: "commercial_urgency",
    polarity: "commercial",
    strength: 22,
    pattern:
      /request for proposal|\brfp\b|tender|grant awarded|funding round|modernization programme/i,
  },
  {
    code: "expansion",
    category: "commercial_urgency",
    polarity: "commercial",
    strength: 14,
    pattern:
      /new location|expansion|rapid growth|acquired|acquires|acquiring|merger|takeover|scaling operations/i,
  },
];

export function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function excerptAround(text: string, index: number, size = 90): string {
  const start = Math.max(0, index - size);
  const end = Math.min(text.length, index + size);
  return normalizeText(text.slice(start, end));
}

export function detectSignals(text: string): DetectedSignal[] {
  const normalized = normalizeText(text);
  const detected: DetectedSignal[] = [];
  for (const rule of SIGNAL_RULES) {
    const match = rule.pattern.exec(normalized);
    if (!match) continue;
    detected.push({
      code: rule.code,
      category: rule.category,
      polarity: rule.polarity,
      strength: rule.strength,
      confidence: match[0].length > 12 ? 0.88 : 0.78,
      excerpt: excerptAround(normalized, match.index),
    });
  }
  return detected;
}

const REGION_ALIASES: Record<string, string[]> = {
  ontario: ["ontario"],
  quebec: ["quebec", "québec"],
  alberta: ["alberta"],
  "british columbia": ["british columbia"],
  manitoba: ["manitoba"],
  saskatchewan: ["saskatchewan"],
  "new brunswick": ["new brunswick"],
  "nova scotia": ["nova scotia"],
};

function locationMatch(text: string, term: string): boolean {
  const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    Boolean(escaped) &&
    new RegExp(
      `(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`,
      "iu",
    ).test(text)
  );
}

export function evaluateGeography(
  text: string,
  criteriaInput: unknown,
  coordinates?: { latitude: number; longitude: number },
): GeographyEvaluation {
  const criteria = CriteriaSchema.parse(criteriaInput);
  const { mode, centreLatitude, centreLongitude, radiusKm } =
    criteria.geography;
  const cities = criteria.geography.cities.filter(Boolean);
  const regions = criteria.geography.regions.filter(Boolean);
  if (
    mode === "radius" ||
    (mode === "hybrid" && (centreLatitude !== null || centreLongitude !== null))
  ) {
    if (
      centreLatitude === null ||
      centreLongitude === null ||
      !coordinates ||
      !Number.isFinite(coordinates.latitude) ||
      Math.abs(coordinates.latitude) > 90 ||
      !Number.isFinite(coordinates.longitude) ||
      Math.abs(coordinates.longitude) > 180
    ) {
      return {
        eligible: false,
        city: null,
        region: null,
        matchedTerms: [],
        basis: "location_not_verified",
      };
    }
    const radians = (value: number) => (value * Math.PI) / 180;
    const latDelta = radians(coordinates.latitude - centreLatitude);
    const lonDelta = radians(coordinates.longitude - centreLongitude);
    const a =
      Math.sin(latDelta / 2) ** 2 +
      Math.cos(radians(centreLatitude)) *
        Math.cos(radians(coordinates.latitude)) *
        Math.sin(lonDelta / 2) ** 2;
    const distanceKm =
      6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    const inside = distanceKm <= radiusKm;
    if (mode === "radius" || !inside)
      return {
        eligible: inside,
        city: null,
        region: null,
        matchedTerms: [],
        distanceKm,
        basis: inside ? "within_radius" : "outside_radius",
      };
  }
  if (cities.length === 0 && regions.length === 0) {
    return {
      eligible: true,
      city: null,
      region: null,
      matchedTerms: [],
      basis: "not_restricted",
    };
  }

  const city =
    cities.find((candidate) => locationMatch(text, candidate)) ?? null;
  const region =
    regions.find((candidate) => {
      const aliases = REGION_ALIASES[candidate.toLowerCase()] ?? [candidate];
      return aliases.some((alias) => locationMatch(text, alias));
    }) ?? null;
  const matchedTerms = [city, region].filter((value): value is string =>
    Boolean(value),
  );
  // Named cities narrow a region; a province match must not silently expand city targeting.
  const eligible = cities.length ? Boolean(city) : Boolean(region);
  return {
    eligible,
    city,
    region,
    matchedTerms,
    basis: eligible ? "configured_location_match" : "location_not_verified",
  };
}

export function suggestCriteriaAdjustment(
  criteriaInput: unknown,
  observedQualifiedLeads: number,
): CriteriaSuggestion {
  const criteria = CriteriaSchema.parse(criteriaInput);
  const target = criteria.targetQualifiedLeadsPerWeek;
  if (observedQualifiedLeads < target * 0.8) {
    return {
      direction: "loosen",
      observedQualifiedLeads,
      targetQualifiedLeads: target,
      changes: {
        automationMaturityMax: Math.max(
          criteria.automationMaturityMax,
          Math.min(65, criteria.automationMaturityMax + 5),
        ),
        opportunityPotentialMin: Math.min(
          criteria.opportunityPotentialMin,
          Math.max(40, criteria.opportunityPotentialMin - 5),
        ),
        confidenceMin: Number(
          Math.min(
            criteria.confidenceMin,
            Math.max(0.5, criteria.confidenceMin - 0.05),
          ).toFixed(2),
        ),
      },
      rationale: [
        `Only ${observedQualifiedLeads} qualified leads were observed against a weekly target of ${target}.`,
        "Widen the scoring window one controlled step; keep source policy and geography unchanged.",
      ],
      autoApply: false,
    };
  }
  if (observedQualifiedLeads > target * 1.5) {
    return {
      direction: "tighten",
      observedQualifiedLeads,
      targetQualifiedLeads: target,
      changes: {
        automationMaturityMax: Math.min(
          criteria.automationMaturityMax,
          Math.max(20, criteria.automationMaturityMax - 5),
        ),
        opportunityPotentialMin: Math.max(
          criteria.opportunityPotentialMin,
          Math.min(80, criteria.opportunityPotentialMin + 5),
        ),
        confidenceMin: Number(
          Math.max(
            criteria.confidenceMin,
            Math.min(0.9, criteria.confidenceMin + 0.05),
          ).toFixed(2),
        ),
      },
      rationale: [
        `${observedQualifiedLeads} qualified leads exceed 150% of the weekly target of ${target}.`,
        "Tighten score and confidence gates to prioritize the strongest manual-process opportunities.",
      ],
      autoApply: false,
    };
  }
  return {
    direction: "hold",
    observedQualifiedLeads,
    targetQualifiedLeads: target,
    changes: {},
    rationale: [
      `Lead output is within the operating band for the weekly target of ${target}.`,
    ],
    autoApply: false,
  };
}

const MATURITY_WEIGHTS: Record<
  Exclude<SignalCategory, "commercial_urgency">,
  number
> = {
  digital_foundation: 20,
  customer_self_service: 15,
  workflow_automation: 25,
  data_analytics: 15,
  ai_adoption: 15,
  manual_friction: 10,
};

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function scoreSignals(
  signals: DetectedSignal[],
  criteriaInput: unknown,
  metadata: {
    icpFit?: number;
    geoEligible?: boolean;
    evidenceFreshness?: number;
  } = {},
): ScoreResult {
  const criteria = CriteriaSchema.parse(criteriaInput);
  const components: Record<string, number> = {};
  const maturityCategories = Object.keys(MATURITY_WEIGHTS) as Array<
    keyof typeof MATURITY_WEIGHTS
  >;

  for (const category of maturityCategories) {
    const categorySignals = signals.filter(
      (signal) => signal.category === category,
    );
    if (categorySignals.length === 0) {
      components[category] = 50;
      continue;
    }
    let value = 50;
    for (const signal of categorySignals) {
      const direction = signal.polarity === "automated" ? 1 : -1;
      value += direction * signal.strength * signal.confidence;
    }
    components[category] = Math.round(clamp(value));
  }

  const automationMaturity = Math.round(
    maturityCategories.reduce(
      (total, category) =>
        total + components[category] * (MATURITY_WEIGHTS[category] / 100),
      0,
    ),
  );

  const manualStrength = signals
    .filter((signal) => signal.polarity === "manual")
    .reduce((total, signal) => total + signal.strength * signal.confidence, 0);
  const urgencyStrength = signals
    .filter((signal) => signal.polarity === "commercial")
    .reduce((total, signal) => total + signal.strength * signal.confidence, 0);
  const icpFit = clamp(metadata.icpFit ?? 55);
  const opportunityPotential = Math.round(
    clamp(
      icpFit * 0.45 +
        Math.min(100, manualStrength * 1.6) * 0.35 +
        Math.min(100, urgencyStrength * 2) * 0.2,
    ),
  );

  const categories = new Set(signals.map((signal) => signal.category));
  const coverageCategories = categories.size;
  const averageSignalConfidence = signals.length
    ? signals.reduce((total, signal) => total + signal.confidence, 0) /
      signals.length
    : 0;
  const evidenceFreshness = clamp(metadata.evidenceFreshness ?? 100) / 100;
  const confidence =
    Number(
      clamp(
        0.25 +
          coverageCategories * 0.1 +
          Math.min(signals.length, 8) * 0.025 +
          averageSignalConfidence * 0.25,
        0,
        0.97,
      ).toFixed(2),
    ) * evidenceFreshness;
  const geoEligible = metadata.geoEligible ?? true;
  const qualified =
    geoEligible &&
    automationMaturity <= criteria.automationMaturityMax &&
    opportunityPotential >= criteria.opportunityPotentialMin &&
    confidence >= criteria.confidenceMin &&
    coverageCategories >= criteria.minimumEvidenceCategories;

  const explanation = [
    `Automation maturity ${automationMaturity}/100 (qualifies at or below ${criteria.automationMaturityMax}).`,
    `Opportunity potential ${opportunityPotential}/100 (minimum ${criteria.opportunityPotentialMin}).`,
    `Confidence ${(confidence * 100).toFixed(0)}% across ${coverageCategories} evidence categories.`,
    geoEligible
      ? "Geography is eligible."
      : "Geography is outside the configured market.",
  ];

  return {
    automationMaturity,
    opportunityPotential,
    confidence: Number(confidence.toFixed(2)),
    coverageCategories,
    qualified,
    explanation,
    components,
    scoringVersion: "2.0.0",
  };
}

export function canonicalizeUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("Only HTTP(S) URLs are permitted");
  parsed.hash = "";
  for (const key of [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "ref",
    "fbclid",
    "gclid",
  ]) {
    parsed.searchParams.delete(key);
  }
  if (parsed.pathname.endsWith("/") && parsed.pathname.length > 1)
    parsed.pathname = parsed.pathname.slice(0, -1);
  parsed.hostname = parsed.hostname.toLowerCase();
  // Sort query parameters so equivalent URLs canonicalize identically
  // regardless of parameter order (stable for dedup and content hashing).
  parsed.searchParams.sort();
  return parsed.toString();
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function scheduleIdempotencyKey(
  scheduleId: string,
  scheduledFor: Date,
): string {
  return `schedule:${scheduleId}:${scheduledFor.toISOString()}`;
}

export interface LeaseableJob {
  id: string;
  status:
    | "queued"
    | "leased"
    | "running"
    | "retrying"
    | "completed"
    | "partial"
    | "failed"
    | "dead_letter"
    | "cancelled";
  attemptCount: number;
  maxAttempts: number;
  leaseExpiresAt?: string | null;
  nextAttemptAt?: string | null;
}

export function recoverExpiredLease(
  job: LeaseableJob,
  now = new Date(),
): LeaseableJob {
  if (!["leased", "running"].includes(job.status) || !job.leaseExpiresAt)
    return job;
  if (new Date(job.leaseExpiresAt).getTime() >= now.getTime()) return job;
  return {
    ...job,
    status: job.attemptCount >= job.maxAttempts ? "dead_letter" : "retrying",
    leaseExpiresAt: null,
    nextAttemptAt:
      job.attemptCount >= job.maxAttempts ? null : now.toISOString(),
  };
}

export function retryDelaySeconds(attemptCount: number): number {
  const base = Math.min(3600, 30 * 2 ** Math.max(0, attemptCount - 1));
  return base + Math.floor(base * 0.2);
}

export function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
  ];
}

export interface CanaryObservation {
  scheduledAt: string;
  completedAt?: string | null;
  status: "completed" | "failed" | "running" | "queued";
}

export function evaluateCanarySoak(
  observations: CanaryObservation[],
  now = new Date(),
) {
  // Evaluate 72 fully elapsed UTC hours. Missing hours count as failures;
  // repeated observations in one hour cannot manufacture a soak pass.
  const hour = 3_600_000;
  const end = Math.floor(now.getTime() / hour) * hour;
  const start = end - 72 * hour;
  const slots = new Map<number, CanaryObservation[]>();
  for (const item of observations) {
    const scheduled = Date.parse(item.scheduledAt);
    if (scheduled < start || scheduled >= end || !Number.isFinite(scheduled))
      continue;
    const slot = Math.floor(scheduled / hour) * hour;
    slots.set(slot, [...(slots.get(slot) ?? []), item]);
  }
  const relevant = [...slots.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, items]) => {
      // Conflicting duplicates fail closed rather than masking a failed run.
      return (
        items.find(
          (item) =>
            item.status !== "completed" ||
            !item.completedAt ||
            Date.parse(item.completedAt) > now.getTime() ||
            !Number.isFinite(Date.parse(item.completedAt)),
        ) ?? items[0]
      );
    });
  const completed = relevant.filter(
    (item) =>
      item.status === "completed" &&
      item.completedAt &&
      Date.parse(item.completedAt) <= now.getTime() &&
      Date.parse(item.completedAt) >= Date.parse(item.scheduledAt),
  );
  const completionRate = completed.length / 72;
  const delays = completed
    .filter((item) => item.completedAt)
    .map(
      (item) =>
        new Date(item.completedAt!).getTime() -
        new Date(item.scheduledAt).getTime(),
    );
  return {
    hoursCovered: relevant.length
      ? Math.min(
          72,
          (now.getTime() - new Date(relevant[0].scheduledAt).getTime()) /
            3_600_000,
        )
      : 0,
    total: 72,
    observed: relevant.length,
    missing: 72 - relevant.length,
    completed: completed.length,
    completionRate,
    p95CompletionMs: percentile95(delays),
    passed: slots.size === 72 && completionRate >= 0.99,
  };
}
