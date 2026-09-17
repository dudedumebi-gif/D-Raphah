import { z } from 'zod';

export const CommandEnvelopeSchema = z.object({
  commandId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  actorId: z.string().uuid(),
  idempotencyKey: z.string().min(1),
  expectedVersion: z.number().optional(),
  payload: z.record(z.any()),
  requestedAt: z.string().datetime()
});

export const SourcePolicySchema = z.object({
  businessPurpose: z.string().min(5),
  collectionMethod: z.enum([
    'api',
    'rss',
    'sitemap',
    'static_html',
    'rendered_html',
    'pdf',
    'csv',
    'email',
    'manual'
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
  activeVersion: z.number().int().positive()
});

export const RequirementSchema = z.object({
  id: z.string(),
  opportunityId: z.string(),
  code: z.string(),
  statement: z.string().min(5),
  priority: z.enum(['must', 'should', 'could', 'wont']),
  status: z.enum(['draft', 'needs_clarification', 'proposed', 'validated', 'rejected']),
  sourceEvidenceId: z.string().optional(),
  humanValidatorId: z.string().optional(),
  acceptanceCriteria: z.array(z.string()),
  blockingQuestions: z.array(z.string()),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional()
});

export const FeatureCandidateSchema = z.object({
  id: z.string(),
  opportunityId: z.string(),
  code: z.string(),
  name: z.string(),
  userOutcome: z.string(),
  relatedRequirementIds: z.array(z.string()),
  excludedFromHandoff: z.boolean(),
  exclusionReason: z.string().optional()
});

export const HandoffPackageSchema = z.object({
  schemaVersion: z.string(),
  packageId: z.string().uuid(),
  packageVersion: z.number().int().positive(),
  opportunityId: z.string().uuid(),
  organization: z.object({
    name: z.string().min(1),
    domain: z.string().optional(),
    industry: z.string().optional(),
    employeeCount: z.number().optional()
  }),
  stakeholders: z.array(
    z.object({
      name: z.string().min(1),
      role: z.string().min(1),
      influence: z.string().optional(),
      authority: z.string().optional()
    })
  ),
  problemStatement: z.string().min(10),
  currentState: z.array(
    z.object({
      processName: z.string(),
      owner: z.string().optional(),
      painPoint: z.string()
    })
  ),
  requirementBaseline: z.object({
    version: z.number().int().positive(),
    requirements: z.array(RequirementSchema),
    features: z.array(FeatureCandidateSchema)
  }),
  constraints: z.array(
    z.object({
      description: z.string(),
      category: z.string()
    })
  ),
  risksAndAssumptions: z.array(
    z.object({
      description: z.string(),
      type: z.enum(['risk', 'assumption']),
      impact: z.string()
    })
  ),
  successMeasures: z.array(
    z.object({
      metric: z.string(),
      target: z.string()
    })
  ),
  commercialScope: z.object({
    scopeSummary: z.string(),
    estimatedValueCad: z.number().optional(),
    timelineWeeks: z.number().optional()
  }),
  supportingArtifacts: z.array(
    z.object({
      artifactId: z.string(),
      canonicalUrl: z.string(),
      contentType: z.string(),
      contentHash: z.string()
    })
  ),
  openItems: z.array(
    z.object({
      description: z.string(),
      owner: z.string(),
      dueDate: z.string().optional()
    })
  ),
  approvedBy: z.string(),
  approvedAt: z.string(),
  manifestChecksum: z.string().length(64)
});
