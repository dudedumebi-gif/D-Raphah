import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/db/store.js';
import { HandoffReceiverService, canonicalJsonStringify } from '../src/domain/handoffReceiver.js';
import { ProjectsService } from '../src/domain/projects.js';
import { LeadEngineHandoffPackage } from '../src/types/index.js';

describe('Delivery Tool Handoff & Project Operations', () => {
  beforeEach(() => {
    db.clear();
  });

  const validPackageData = {
    schemaVersion: '1.0.0',
    packageId: '11111111-1111-1111-1111-111111111111',
    packageVersion: 1,
    opportunityId: '22222222-2222-2222-2222-222222222222',
    organization: {
      name: 'Acme Advisory Services',
      domain: 'acme.com',
      industry: 'Professional Services',
      employeeCount: 30
    },
    stakeholders: [{ name: 'Jane Doe', role: 'CEO', authority: 'decision_maker' }],
    problemStatement: 'Acme needs automated lead management and CRM integration.',
    currentState: [{ processName: 'Manual Ingestion', painPoint: 'High error rate' }],
    requirementBaseline: {
      version: 1,
      requirements: [
        {
          id: 'req-1',
          opportunityId: '22222222-2222-2222-2222-222222222222',
          code: 'REQ-001',
          statement: 'System MUST process leads within 5 minutes',
          priority: 'must' as const,
          status: 'validated',
          acceptanceCriteria: ['Processing time < 300s'],
          blockingQuestions: []
        }
      ],
      features: [
        {
          id: 'feat-1',
          opportunityId: '22222222-2222-2222-2222-222222222222',
          code: 'FEAT-001',
          name: 'Lead Automation Engine',
          userOutcome: 'Faster lead response time',
          relatedRequirementIds: ['req-1'],
          excludedFromHandoff: false
        }
      ]
    },
    constraints: [{ description: 'Budget CAD 150/mo', category: 'financial' }],
    risksAndAssumptions: [{ description: 'API token provided by Acme', type: 'assumption' as const, impact: 'high' }],
    successMeasures: [{ metric: 'Processing speed', target: '< 300s' }],
    commercialScope: { scopeSummary: 'Build and deploy Lead Engine' },
    supportingArtifacts: [
      {
        artifactId: 'art-1',
        canonicalUrl: 'https://acme.com/tender',
        contentType: 'text/html',
        contentHash: 'a'.repeat(64)
      }
    ],
    openItems: [],
    approvedBy: '33333333-3333-3333-3333-333333333333',
    approvedAt: new Date().toISOString()
  };

  function createValidPackage(): LeadEngineHandoffPackage {
    const manifestChecksum = crypto
      .createHash('sha256')
      .update(canonicalJsonStringify(validPackageData))
      .digest('hex');

    return {
      ...validPackageData,
      manifestChecksum
    };
  }

  it('accepts valid handoff package and creates delivery project', () => {
    const pkg = createValidPackage();
    const res = HandoffReceiverService.receivePackage(pkg);

    expect(res.status).toBe('accepted');
    expect(res.projectId).toMatch(/^PROJ-/);
    expect(db.projects.size).toBe(1);

    const project = db.projects.get(res.projectId!);
    expect(project?.organizationName).toBe('Acme Advisory Services');
    expect(project?.stage).toBe('onboarding');
  });

  it('rejects handoff package when manifestChecksum is invalid', () => {
    const pkg = createValidPackage();
    pkg.manifestChecksum = '0'.repeat(64);

    const res = HandoffReceiverService.receivePackage(pkg);

    expect(res.status).toBe('rejected');
    expect(res.rejectionReasons).toBeDefined();
    expect(res.rejectionReasons![0].code).toBe('CHECKSUM_MISMATCH');
    expect(db.projects.size).toBe(0);
  });

  it('handles replay protection for duplicate handoff release without duplicate project creation', () => {
    const pkg = createValidPackage();
    const res1 = HandoffReceiverService.receivePackage(pkg);
    const res2 = HandoffReceiverService.receivePackage(pkg);

    expect(res1.status).toBe('accepted');
    expect(res2.status).toBe('accepted');
    expect(res1.projectId).toBe(res2.projectId);
    expect(db.projects.size).toBe(1);
  });

  it('updates project stage, completes milestone, and emits feedback event', () => {
    const pkg = createValidPackage();
    const res = HandoffReceiverService.receivePackage(pkg);
    const projectId = res.projectId!;

    const updated = ProjectsService.updateStage(projectId, 'blueprint_drafting');
    expect(updated.stage).toBe('blueprint_drafting');

    ProjectsService.completeMilestone(projectId, 'm-1');
    const project = db.projects.get(projectId);
    expect(project?.milestones.find(m => m.id === 'm-1')?.completed).toBe(true);

    expect(db.feedbackEvents.size).toBe(2);
  });
});
