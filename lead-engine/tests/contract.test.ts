import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { Server } from 'node:http';
import { app as leadEngineApp } from '../src/server/app.js';
import { app as deliveryToolApp } from '../../delivery-tool/src/server/app.js';
import { db as leadDb } from '../src/db/store.js';
import { db as deliveryDb } from '../../delivery-tool/src/db/store.js';
import { SourceService } from '../src/domain/sources.js';
import { CollectionService } from '../src/domain/collection.js';
import { ScoringService } from '../src/domain/scoring.js';
import { DiscoveryService } from '../src/domain/discovery.js';
import { RequirementsService } from '../src/domain/requirements.js';
import { HandoffService } from '../src/domain/handoff.js';

describe('Lead Engine & Delivery Tool End-to-End Contract Integration', () => {
  let leadServer: Server;
  let deliveryServer: Server;
  const LEAD_PORT = 3000;
  const DELIVERY_PORT = 3001;

  beforeAll(async () => {
    await new Promise<void>(resolve => {
      leadServer = leadEngineApp.listen(LEAD_PORT, () => resolve());
    });
    await new Promise<void>(resolve => {
      deliveryServer = deliveryToolApp.listen(DELIVERY_PORT, () => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>(resolve => leadServer.close(() => resolve()));
    await new Promise<void>(resolve => deliveryServer.close(() => resolve()));
  });

  beforeEach(() => {
    leadDb.clear();
    deliveryDb.clear();
  });

  it('completes end-to-end commercial flow from signal discovery to Delivery Tool project creation', async () => {
    const workspaceId = '00000000-0000-0000-0000-000000000001';
    const actorId = '00000000-0000-0000-0000-000000000002';

    const source = SourceService.createSource(
      workspaceId,
      'Government Procurement Feed',
      'https://procurement.gov.ca/rss',
      'rss',
      { allowedDomains: ['procurement.gov.ca'] }
    );
    SourceService.submitPolicyForApproval(source.id);
    SourceService.approveAndActivateSource(source.id, actorId);

    const { artifacts } = CollectionService.runCrawl(source.id, [
      {
        url: 'https://procurement.gov.ca/notice/101?utm_campaign=feed',
        title: 'RFP for Business Systems Automation Review',
        organization: 'Provincial Services Agency',
        content: 'Agency requires AI and systems advisory to streamline workflow.'
      }
    ]);
    expect(artifacts).toHaveLength(1);

    const opp = ScoringService.evaluateAndIngestArtifact(artifacts[0]);
    expect(opp.score.totalScore).toBeGreaterThanOrEqual(75);

    const session = DiscoveryService.createSession(
      opp.id,
      'Client Discovery Meeting',
      'Review current intake pain points',
      new Date().toISOString()
    );
    DiscoveryService.updateSessionNotes(session.id, {
      painPoints: ['Manual intake delays approvals by 3 days']
    });
    DiscoveryService.approveSession(session.id, actorId);

    const req = RequirementsService.createRequirement(
      opp.id,
      'System MUST automate intake workflow approvals.',
      'must',
      artifacts[0].id
    );
    RequirementsService.validateRequirement(req.id, actorId, ['Automated approval within 15 mins']);

    RequirementsService.freezeBaseline(opp.id, actorId);

    const pkg = HandoffService.createHandoffPackage(opp.id, actorId, {
      scopeSummary: 'Automation of Provincial Services Agency intake workflow'
    });
    expect(pkg.manifestChecksum).toHaveLength(64);

    const deliveryRes = await HandoffService.deliverPackageToDeliveryTool(
      pkg.packageId,
      `http://localhost:${DELIVERY_PORT}/api/handoff/receive`
    );

    expect(deliveryRes.success).toBe(true);
    expect(deliveryRes.projectId).toMatch(/^PROJ-/);

    expect(deliveryDb.projects.size).toBe(1);
    const proj = deliveryDb.projects.get(deliveryRes.projectId!);
    expect(proj?.organizationName).toBe('Provincial Services Agency');
  });

  it('handles Delivery Tool outage gracefully by keeping package pending for retry', async () => {
    const workspaceId = '00000000-0000-0000-0000-000000000001';
    const actorId = '00000000-0000-0000-0000-000000000002';

    const source = SourceService.createSource(workspaceId, 'Src', 'https://src.com', 'rss', { allowedDomains: ['src.com'] });
    SourceService.submitPolicyForApproval(source.id);
    SourceService.approveAndActivateSource(source.id, actorId);

    const { artifacts } = CollectionService.runCrawl(source.id, [
      { url: 'https://src.com/item', title: 'Need AI', organization: 'Org', content: 'Details' }
    ]);
    const opp = ScoringService.evaluateAndIngestArtifact(artifacts[0]);

    const session = DiscoveryService.createSession(opp.id, 'Disc', 'Agenda', new Date().toISOString());
    DiscoveryService.approveSession(session.id, actorId);

    const req = RequirementsService.createRequirement(opp.id, 'Requirement statement MUST hold.', 'must');
    RequirementsService.validateRequirement(req.id, actorId, ['OK']);
    RequirementsService.freezeBaseline(opp.id, actorId);

    const pkg = HandoffService.createHandoffPackage(opp.id, actorId, { scopeSummary: 'Test scope' });

    const deliveryRes = await HandoffService.deliverPackageToDeliveryTool(
      pkg.packageId,
      'http://localhost:59999/api/handoff/receive'
    );

    expect(deliveryRes.success).toBe(false);

    expect(leadDb.handoffPackages.has(pkg.packageId)).toBe(true);
    const outbox = Array.from(leadDb.outboxEvents.values())[0];
    expect(outbox.status).toBe('failed');
    expect(outbox.attempts).toBe(1);
  });
});
