import { z } from "zod";

export const HANDOFF_SCHEMA_VERSION = "1.0.0" as const;

export const RequirementSchema = z.object({
  id: z.string().min(1),
  opportunityId: z.string().min(1),
  code: z.string().min(1),
  statement: z.string().min(5),
  priority: z.enum(["must", "should", "could", "wont"]),
  status: z.enum([
    "draft",
    "needs_clarification",
    "proposed",
    "validated",
    "rejected",
  ]),
  sourceEvidenceId: z.string().optional(),
  humanValidatorId: z.string().optional(),
  acceptanceCriteria: z.array(z.string()),
  blockingQuestions: z.array(z.string()),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const FeatureCandidateSchema = z.object({
  id: z.string().min(1),
  opportunityId: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  userOutcome: z.string().min(1),
  relatedRequirementIds: z.array(z.string()),
  excludedFromHandoff: z.boolean(),
  exclusionReason: z.string().optional(),
});

export const LeadEngineHandoffPackageV1Schema = z.object({
  schemaVersion: z.literal(HANDOFF_SCHEMA_VERSION),
  packageId: z.string().uuid(),
  packageVersion: z.number().int().positive(),
  opportunityId: z.string().uuid(),
  organization: z.object({
    name: z.string().min(1),
    domain: z.string().optional(),
    industry: z.string().optional(),
    employeeCount: z.number().int().nonnegative().optional(),
  }),
  stakeholders: z.array(
    z.object({
      name: z.string().min(1),
      role: z.string().min(1),
      influence: z.string().optional(),
      authority: z.string().optional(),
    }),
  ),
  problemStatement: z.string().min(10),
  currentState: z.array(
    z.object({
      processName: z.string().min(1),
      owner: z.string().optional(),
      painPoint: z.string().min(1),
    }),
  ),
  requirementBaseline: z.object({
    version: z.number().int().positive(),
    requirements: z.array(RequirementSchema),
    features: z.array(FeatureCandidateSchema),
  }),
  constraints: z.array(
    z.object({
      description: z.string().min(1),
      category: z.string().min(1),
    }),
  ),
  risksAndAssumptions: z.array(
    z.object({
      description: z.string().min(1),
      type: z.enum(["risk", "assumption"]),
      impact: z.string().min(1),
    }),
  ),
  successMeasures: z.array(
    z.object({
      metric: z.string().min(1),
      target: z.string().min(1),
    }),
  ),
  commercialScope: z.object({
    scopeSummary: z.string().min(1),
    estimatedValueCad: z.number().nonnegative().optional(),
    timelineWeeks: z.number().positive().optional(),
  }),
  supportingArtifacts: z.array(
    z.object({
      artifactId: z.string().min(1),
      canonicalUrl: z.string().url(),
      contentType: z.string().min(1),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
  openItems: z.array(
    z.object({
      description: z.string().min(1),
      owner: z.string().min(1),
      dueDate: z.string().optional(),
    }),
  ),
  approvedBy: z.string().min(1),
  approvedAt: z.string().datetime(),
  manifestChecksum: z.string().regex(/^[a-f0-9]{64}$/),
});

export const LeadEngineHandoffPackageSchema = LeadEngineHandoffPackageV1Schema;
export type LeadEngineHandoffPackageV1 = z.infer<
  typeof LeadEngineHandoffPackageV1Schema
>;
export type LeadEngineHandoffPackage = LeadEngineHandoffPackageV1;
export type HandoffRequirement = z.infer<typeof RequirementSchema>;
export type HandoffFeatureCandidate = z.infer<typeof FeatureCandidateSchema>;
