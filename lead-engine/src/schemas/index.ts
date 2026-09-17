import { z } from "zod";
export { LeadEngineHandoffPackageSchema as HandoffPackageSchema } from "@raphah/handoff-contract/handoff/v1";

export const CommandEnvelopeSchema = z.object({
  commandId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  actorId: z.string().uuid(),
  idempotencyKey: z.string().min(1),
  expectedVersion: z.number().optional(),
  payload: z.record(z.any()),
  requestedAt: z.string().datetime(),
});

export const SourcePolicySchema = z.object({
  businessPurpose: z.string().min(5),
  collectionMethod: z.enum([
    "api",
    "rss",
    "sitemap",
    "static_html",
    "rendered_html",
    "pdf",
    "csv",
    "email",
    "manual",
  ]),
  allowedDomains: z.array(z.string().min(1)),
  allowlistPaths: z.array(z.string()),
  denylistPaths: z.array(z.string()),
  dailyBudget: z.number().nonnegative(),
  monthlyBudget: z.number().nonnegative(),
  maxDepth: z.number().int().min(0).max(10),
  rateLimitRps: z.number().positive(),
  userAgent: z.string().min(1),
  contactEmail: z.string().email(),
  retentionMonths: z.number().int().positive(),
  approvedBy: z.string().optional(),
  approvedAt: z.string().datetime().optional(),
  activeVersion: z.number().int().positive(),
});

export const RequirementSchema = z.object({
  id: z.string(),
  opportunityId: z.string(),
  code: z.string(),
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
  id: z.string(),
  opportunityId: z.string(),
  code: z.string(),
  name: z.string(),
  userOutcome: z.string(),
  relatedRequirementIds: z.array(z.string()),
  excludedFromHandoff: z.boolean(),
  exclusionReason: z.string().optional(),
});
