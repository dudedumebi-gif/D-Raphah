export type SourceLifecycle = 'draft' | 'pending_approval' | 'active' | 'paused' | 'disabled';

export type CollectionMethod = 'api' | 'rss' | 'sitemap' | 'static_html' | 'rendered_html' | 'pdf' | 'csv' | 'email' | 'manual';

export interface SourcePolicy {
  businessPurpose: string;
  collectionMethod: CollectionMethod;
  allowedDomains: string[];
  allowlistPaths: string[];
  denylistPaths: string[];
  dailyBudget: number;
  monthlyBudget: number;
  maxDepth: number;
  rateLimitRps: number;
  userAgent: string;
  contactEmail: string;
  retentionMonths: number;
  approvedBy?: string;
  approvedAt?: string;
  activeVersion: number;
}

export interface Source {
  id: string;
  workspaceId: string;
  name: string;
  baseUrl: string;
  method: CollectionMethod;
  status: SourceLifecycle;
  policy: SourcePolicy;
  createdAt: string;
  updatedAt: string;
}

export interface CrawlRun {
  id: string;
  sourceId: string;
  workspaceId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped';
  itemCount: number;
  bytesDownloaded: number;
  stopReason?: string;
  startedAt: string;
  endedAt?: string;
}

export interface EvidenceArtifact {
  id: string;
  workspaceId: string;
  sourceId: string;
  canonicalUrl: string;
  contentHash: string;
  contentType: string;
  rawContent: string;
  extractedTitle?: string;
  extractedOrganization?: string;
  extractedText?: string;
  fetchedAt: string;
}

export type OpportunityStage =
  | 'detected'
  | 'qualified'
  | 'engaged'
  | 'discovery'
  | 'requirements_defined'
  | 'proposal'
  | 'won'
  | 'lost'
  | 'handed_off';

export type OpportunityType = 'public_signal' | 'inbound' | 'referral' | 'manual_capture';

export interface ScoreComponents {
  problemFit: number;         // weight 25
  offerFit: number;           // weight 20
  urgencyTiming: number;      // weight 15
  organizationAuthority: number; // weight 15
  budgetSignal: number;       // weight 10
  relationshipProximity: number; // weight 10
  technicalAlignment: number; // weight 5
}

export interface RiskFlags {
  policyRisk: boolean;
  privacyRisk: boolean;
  conflictRisk: boolean;
  expiryRisk: boolean;
  evidenceRisk: boolean;
}

export interface OpportunityScore {
  totalScore: number; // 0 to 100
  components: ScoreComponents;
  confidence: number; // 0 to 1
  riskFlags: RiskFlags;
  explanation: string;
  scoringVersion: string;
  evaluatedAt: string;
}

export type OpportunityRouting = 'priority_review' | 'standard_review' | 'archived';

export interface Opportunity {
  id: string;
  workspaceId: string;
  title: string;
  organizationName: string;
  organizationDomain?: string;
  type: OpportunityType;
  stage: OpportunityStage;
  score: OpportunityScore;
  routing: OpportunityRouting;
  canonicalUrl?: string;
  evidenceArtifactIds: string[];
  suppressionStatus?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Stakeholder {
  id: string;
  opportunityId: string;
  name: string;
  role: string;
  organization: string;
  email?: string;
  phone?: string;
  influence?: 'low' | 'medium' | 'high';
  authority?: 'decision_maker' | 'influencer' | 'end_user';
  attendance?: boolean;
}

export type OutreachDraftType =
  | 'contextual_connection'
  | 'referral_intro'
  | 'explicit_request_response'
  | 'website_contact'
  | 'permission_email'
  | 'discovery_call_agenda'
  | 'audit_proposal_reminder';

export interface OutreachDraft {
  id: string;
  opportunityId: string;
  type: OutreachDraftType;
  recipientName: string;
  recipientContact: string;
  subject: string;
  body: string;
  status: 'drafted' | 'approved' | 'sent' | 'rejected';
  approvedBy?: string;
  approvedAt?: string;
  suppressionChecked: boolean;
  createdAt: string;
}

export interface SuppressionRecord {
  id: string;
  emailDomainOrUrl: string;
  reason: string;
  createdAt: string;
}

export type DiscoverySessionStatus = 'scheduled' | 'in_progress' | 'completed' | 'approved';

export interface ProcessItem {
  id: string;
  name: string;
  owner?: string;
  trigger?: string;
  steps?: string[];
  volume?: string;
  duration?: string;
  painPoints: string[];
}

export interface AISuggestion {
  id: string;
  type: 'requirement' | 'feature' | 'open_question' | 'contradiction';
  content: string;
  sourceExcerpt?: string;
  validationStatus: 'pending' | 'accepted' | 'edited' | 'rejected';
  validatedBy?: string;
  validatedAt?: string;
}

export interface DiscoverySession {
  id: string;
  opportunityId: string;
  purpose: string;
  agenda: string;
  sessionDate: string;
  participants: Stakeholder[];
  processes: ProcessItem[];
  systems: string[];
  dataSources: string[];
  painPoints: string[];
  constraints: string[];
  decisions: string[];
  actions: Array<{ id: string; description: string; owner: string; dueDate: string }>;
  aiSuggestions: AISuggestion[];
  status: DiscoverySessionStatus;
  approvedBy?: string;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type RequirementPriority = 'must' | 'should' | 'could' | 'wont';

export type RequirementStatus = 'draft' | 'needs_clarification' | 'proposed' | 'validated' | 'rejected';

export interface Requirement {
  id: string;
  opportunityId: string;
  code: string; // e.g. REQ-OPP-001
  statement: string;
  priority: RequirementPriority;
  status: RequirementStatus;
  sourceEvidenceId?: string;
  humanValidatorId?: string;
  acceptanceCriteria: string[];
  blockingQuestions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FeatureCandidate {
  id: string;
  opportunityId: string;
  code: string; // e.g. FEAT-OPP-001
  name: string;
  userOutcome: string;
  relatedRequirementIds: string[];
  excludedFromHandoff: boolean;
  exclusionReason?: string;
}

export interface RequirementBaseline {
  id: string;
  opportunityId: string;
  version: number;
  requirements: Requirement[];
  features: FeatureCandidate[];
  constraints: Array<{ id: string; description: string; category: string }>;
  risksAndAssumptions: Array<{ id: string; description: string; type: 'risk' | 'assumption'; impact: string }>;
  successMeasures: Array<{ id: string; metric: string; target: string }>;
  isFrozen: boolean;
  frozenBy?: string;
  frozenAt?: string;
}

export interface OrganizationSnapshot {
  name: string;
  domain?: string;
  industry?: string;
  employeeCount?: number;
}

export interface StakeholderSnapshot {
  name: string;
  role: string;
  influence?: string;
  authority?: string;
}

export interface CurrentStateSnapshot {
  processName: string;
  owner?: string;
  painPoint: string;
}

export interface RequirementBaselineSnapshot {
  version: number;
  requirements: Requirement[];
  features: FeatureCandidate[];
}

export interface ConstraintSnapshot {
  description: string;
  category: string;
}

export interface RiskAssumptionSnapshot {
  description: string;
  type: 'risk' | 'assumption';
  impact: string;
}

export interface SuccessMeasureSnapshot {
  metric: string;
  target: string;
}

export interface CommercialSnapshot {
  scopeSummary: string;
  estimatedValueCad?: number;
  timelineWeeks?: number;
}

export interface ArtifactManifestItem {
  artifactId: string;
  canonicalUrl: string;
  contentType: string;
  contentHash: string;
}

export interface OpenItemSnapshot {
  description: string;
  owner: string;
  dueDate?: string;
}

export interface LeadEngineHandoffPackage {
  schemaVersion: string;
  packageId: string;
  packageVersion: number;
  opportunityId: string;
  organization: OrganizationSnapshot;
  stakeholders: StakeholderSnapshot[];
  problemStatement: string;
  currentState: CurrentStateSnapshot[];
  requirementBaseline: RequirementBaselineSnapshot;
  constraints: ConstraintSnapshot[];
  risksAndAssumptions: RiskAssumptionSnapshot[];
  successMeasures: SuccessMeasureSnapshot[];
  commercialScope: CommercialSnapshot;
  supportingArtifacts: ArtifactManifestItem[];
  openItems: OpenItemSnapshot[];
  approvedBy: string;
  approvedAt: string;
  manifestChecksum: string;
}

export interface CommandEnvelope<T = any> {
  commandId: string;
  workspaceId: string;
  actorId: string;
  idempotencyKey: string;
  expectedVersion?: number;
  payload: T;
  requestedAt: string;
}

export interface CommandResult<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  commandId: string;
}
