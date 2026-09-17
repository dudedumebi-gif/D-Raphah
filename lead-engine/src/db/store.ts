import {
  Source,
  CrawlRun,
  EvidenceArtifact,
  Opportunity,
  Stakeholder,
  OutreachDraft,
  SuppressionRecord,
  DiscoverySession,
  Requirement,
  FeatureCandidate,
  RequirementBaseline,
  LeadEngineHandoffPackage
} from '../types/index.js';

export interface OutboxEvent {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: any;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  lastAttemptAt?: string;
  errorMessage?: string;
  createdAt: string;
}

export class MemoryStore {
  public sources: Map<string, Source> = new Map();
  public crawlRuns: Map<string, CrawlRun> = new Map();
  public evidenceArtifacts: Map<string, EvidenceArtifact> = new Map();
  public opportunities: Map<string, Opportunity> = new Map();
  public stakeholders: Map<string, Stakeholder> = new Map();
  public outreachDrafts: Map<string, OutreachDraft> = new Map();
  public suppressionList: Map<string, SuppressionRecord> = new Map();
  public discoverySessions: Map<string, DiscoverySession> = new Map();
  public requirements: Map<string, Requirement> = new Map();
  public featureCandidates: Map<string, FeatureCandidate> = new Map();
  public baselines: Map<string, RequirementBaseline> = new Map();
  public handoffPackages: Map<string, LeadEngineHandoffPackage> = new Map();
  public outboxEvents: Map<string, OutboxEvent> = new Map();
  public processedIdempotencyKeys: Set<string> = new Set();

  clear(): void {
    this.sources.clear();
    this.crawlRuns.clear();
    this.evidenceArtifacts.clear();
    this.opportunities.clear();
    this.stakeholders.clear();
    this.outreachDrafts.clear();
    this.suppressionList.clear();
    this.discoverySessions.clear();
    this.requirements.clear();
    this.featureCandidates.clear();
    this.baselines.clear();
    this.handoffPackages.clear();
    this.outboxEvents.clear();
    this.processedIdempotencyKeys.clear();
  }
}

export const db = new MemoryStore();
