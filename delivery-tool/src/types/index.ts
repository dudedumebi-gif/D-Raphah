export interface Requirement {
  id: string;
  opportunityId: string;
  code: string;
  statement: string;
  priority: 'must' | 'should' | 'could' | 'wont';
  status: string;
  sourceEvidenceId?: string;
  humanValidatorId?: string;
  acceptanceCriteria: string[];
  blockingQuestions: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface FeatureCandidate {
  id: string;
  opportunityId: string;
  code: string;
  name: string;
  userOutcome: string;
  relatedRequirementIds: string[];
  excludedFromHandoff: boolean;
  exclusionReason?: string;
}

export interface LeadEngineHandoffPackage {
  schemaVersion: string;
  packageId: string;
  packageVersion: number;
  opportunityId: string;
  organization: {
    name: string;
    domain?: string;
    industry?: string;
    employeeCount?: number;
  };
  stakeholders: Array<{
    name: string;
    role: string;
    influence?: string;
    authority?: string;
  }>;
  problemStatement: string;
  currentState: Array<{
    processName: string;
    owner?: string;
    painPoint: string;
  }>;
  requirementBaseline: {
    version: number;
    requirements: Requirement[];
    features: FeatureCandidate[];
  };
  constraints: Array<{ description: string; category: string }>;
  risksAndAssumptions: Array<{ description: string; type: 'risk' | 'assumption'; impact: string }>;
  successMeasures: Array<{ metric: string; target: string }>;
  commercialScope: {
    scopeSummary: string;
    estimatedValueCad?: number;
    timelineWeeks?: number;
  };
  supportingArtifacts: Array<{
    artifactId: string;
    canonicalUrl: string;
    contentType: string;
    contentHash: string;
  }>;
  openItems: Array<{
    description: string;
    owner: string;
    dueDate?: string;
  }>;
  approvedBy: string;
  approvedAt: string;
  manifestChecksum: string;
}

export type DeliveryProjectStage =
  | 'onboarding'
  | 'blueprint_drafting'
  | 'implementation'
  | 'testing'
  | 'handover'
  | 'completed';

export interface Milestone {
  id: string;
  title: string;
  targetDate?: string;
  completed: boolean;
}

export interface DeliveryProject {
  id: string; // projectId
  packageId: string;
  packageVersion: number;
  opportunityId: string;
  organizationName: string;
  stage: DeliveryProjectStage;
  requirementBaselineVersion: number;
  requirementsCount: number;
  featuresCount: number;
  milestones: Milestone[];
  acceptedPackage: LeadEngineHandoffPackage;
  receivedAt: string;
  updatedAt: string;
}

export interface RejectionReason {
  code: string;
  message: string;
  field?: string;
}

export interface HandoffReceiptResult {
  status: 'accepted' | 'rejected';
  projectId?: string;
  packageId: string;
  packageVersion: number;
  message?: string;
  rejectionReasons?: RejectionReason[];
}

export interface DeliveryFeedbackEvent {
  eventId: string;
  projectId: string;
  opportunityId: string;
  type: 'status_updated' | 'clarification_requested' | 'milestone_completed';
  details: any;
  emittedAt: string;
}
