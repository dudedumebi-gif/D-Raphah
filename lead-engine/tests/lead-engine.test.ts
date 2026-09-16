import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/db/store.js';
import { SourceService } from '../src/domain/sources.js';
import { CollectionService } from '../src/domain/collection.js';
import { ScoringService } from '../src/domain/scoring.js';
import { EngagementService } from '../src/domain/engagement.js';
import { DiscoveryService } from '../src/domain/discovery.js';
import { RequirementsService } from '../src/domain/requirements.js';
import { HandoffService } from '../src/domain/handoff.js';

describe('Lead Engine Core Workflows & Controls', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const actorId = '00000000-0000-0000-0000-000000000002';

  beforeEach(() => {
    db.clear();
  });

  it('blocks unapproved source from running collection', () => {
    const source = SourceService.createSource(
      workspaceId,
      'Tech Tender RSS',
      'https://tenders.example.com/rss',
      'rss',
      {}
    );

    expect(() => {
      CollectionService.runCrawl(source.id, []);
    }).toThrow(/Collection blocked: Source is not active/);
  });

  it('runs collection after source policy approval & activation', () => {
    const source = SourceService.createSource(
      workspaceId,
      'Tech Tender RSS',
      'https://tenders.example.com/rss',
      'rss',
      { allowedDomains: ['tenders.example.com'] }
    );

    SourceService.submitPolicyForApproval(source.id);
    SourceService.approveAndActivateSource(source.id, actorId);

    const { crawlRun, artifacts } = CollectionService.runCrawl(source.id, [
      {
        url: 'https://tenders.example.com/item1?utm_source=rss',
        title: 'Need AI Workflow Advisory',
        organization: 'Acme Corp',
        content: 'Acme Corp requires an AI advisory review for CRM operations.'
      }
    ]);

    expect(crawlRun.status).toBe('completed');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].canonicalUrl).toBe('https://tenders.example.com/item1');
  });

  it('evaluates, scores (0-100), and deduplicates opportunities', () => {
    const source = SourceService.createSource(
      workspaceId,
      'Tech Tender RSS',
      'https://tenders.example.com/rss',
      'rss',
      { allowedDomains: ['tenders.example.com'] }
    );
    SourceService.submitPolicyForApproval(source.id);
    SourceService.approveAndActivateSource(source.id, actorId);

    const { artifacts } = CollectionService.runCrawl(source.id, [
      {
        url: 'https://tenders.example.com/item1',
        title: 'Need AI Workflow Advisory',
        organization: 'Acme Corp',
        content: 'Acme Corp requires an AI advisory review for CRM operations.'
      }
    ]);

    const opp = ScoringService.evaluateAndIngestArtifact(artifacts[0]);
    expect(opp.score.totalScore).toBeGreaterThanOrEqual(75);
    expect(opp.routing).toBe('priority_review');

    const dupOpp = ScoringService.evaluateAndIngestArtifact(artifacts[0]);
    expect(dupOpp.id).toBe(opp.id);
  });

  it('prevents outreach approval when recipient is on suppression list', () => {
    const opp = ScoringService.evaluateAndIngestArtifact({
      id: 'art-1',
      workspaceId,
      sourceId: 'src-1',
      canonicalUrl: 'https://example.com/tender',
      contentHash: 'hash-1',
      contentType: 'text/html',
      rawContent: 'Sample tender',
      fetchedAt: new Date().toISOString()
    });

    EngagementService.addSuppression('baddomain.com', 'Opt-out request');

    const draft = EngagementService.draftOutreach(
      opp.id,
      'permission_email',
      'John Doe',
      'john@baddomain.com',
      'Introduction',
      'Hello John...'
    );

    expect(() => {
      EngagementService.approveOutreachDraft(draft.id, actorId);
    }).toThrow(/suppression entry applies/);
  });

  it('requires named human validator to validate requirements and freeze baseline', () => {
    const opp = ScoringService.evaluateAndIngestArtifact({
      id: 'art-1',
      workspaceId,
      sourceId: 'src-1',
      canonicalUrl: 'https://example.com/tender',
      contentHash: 'hash-1',
      contentType: 'text/html',
      rawContent: 'Sample tender',
      fetchedAt: new Date().toISOString()
    });

    const req = RequirementsService.createRequirement(
      opp.id,
      'System MUST process lead payloads within 5 minutes.',
      'must'
    );

    expect(() => {
      RequirementsService.freezeBaseline(opp.id, actorId);
    }).toThrow(/Must item .* is not validated/);

    RequirementsService.validateRequirement(req.id, actorId, ['Payload processed < 300s']);

    const baseline = RequirementsService.freezeBaseline(opp.id, actorId);
    expect(baseline.isFrozen).toBe(true);
    expect(baseline.requirements).toHaveLength(1);
  });

  it('assembles LeadEngineHandoffPackage with SHA-256 checksum and outbox event', () => {
    const opp = ScoringService.evaluateAndIngestArtifact({
      id: 'art-1',
      workspaceId,
      sourceId: 'src-1',
      canonicalUrl: 'https://example.com/tender',
      contentHash: 'hash-1',
      contentType: 'text/html',
      rawContent: 'Sample tender',
      fetchedAt: new Date().toISOString()
    });

    const session = DiscoveryService.createSession(
      opp.id,
      'Discovery Meeting',
      'Review current CRM workflow',
      new Date().toISOString()
    );
    DiscoveryService.approveSession(session.id, actorId);

    const req = RequirementsService.createRequirement(
      opp.id,
      'System MUST automate lead ingestion.',
      'must'
    );
    RequirementsService.validateRequirement(req.id, actorId, ['Passes test']);
    RequirementsService.freezeBaseline(opp.id, actorId);

    const pkg = HandoffService.createHandoffPackage(opp.id, actorId, {
      scopeSummary: 'Implement automated CRM lead pipeline'
    });

    expect(pkg.schemaVersion).toBe('1.0.0');
    expect(pkg.manifestChecksum).toHaveLength(64);
    expect(db.outboxEvents.size).toBe(1);
  });
});
