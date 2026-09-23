import { z } from "zod";
export { LeadEngineHandoffPackageSchema } from "@raphah/handoff-contract/handoff/v1";

export const RequirementSchema = z.object({
  id: z.string(),
  opportunityId: z.string(),
  code: z.string(),
  statement: z.string().min(1),
  priority: z.enum(["must", "should", "could", "wont"]),
  status: z.string(),
  sourceEvidenceId: z.string().optional(),
  humanValidatorId: z.string().optional(),
  acceptanceCriteria: z.array(z.string()),
  blockingQuestions: z.array(z.string()),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const FeatureCandidateSchema = z.object({
  id: z.string(),
  opportunityId: z.string(),
  code: z.string(),
  name: z.string(),
  userOutcome: z.string(),
  relatedRequirementIds: z.array(z.string()),
  excludedFromHandoff: z.boolean(),
  exclusionReason: z.string().optional(),
});
