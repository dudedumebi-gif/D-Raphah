import crypto from 'node:crypto';
import { db, OutboxEvent } from '../db/store.js';
import { LeadEngineHandoffPackage } from '../types/index.js';
import { HandoffPackageSchema } from '../schemas/index.js';

export function canonicalJsonStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(item => canonicalJsonStringify(item)).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const sortedObjParts = keys
    .filter(k => obj[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`);
  return '{' + sortedObjParts.join(',') + '}';
}

export class HandoffService {
  static createHandoffPackage(
    opportunityId: string,
    approverActorId: string,
    commercialScope: { scopeSummary: string; estimatedValueCad?: number; timelineWeeks?: number }
  ): LeadEngineHandoffPackage {
    const opp = db.opportunities.get(opportunityId);
    if (!opp) throw new Error(`Opportunity ${opportunityId} not found`);

    const sessions = Array.from(db.discoverySessions.values()).filter(
      s => s.opportunityId === opportunityId && s.status === 'approved'
    );
    if (sessions.length === 0) {
      throw new Error('Handoff readiness gate failed: No approved discovery session exists.');
    }

    const baselines = Array.from(db.baselines.values()).filter(
      b => b.opportunityId === opportunityId && b.isFrozen
    );
    if (baselines.length === 0) {
      throw new Error('Handoff readiness gate failed: No frozen requirement baseline exists.');
    }

    const latestBaseline = baselines.sort((a, b) => b.version - a.version)[0];

    const existingPackages = Array.from(db.handoffPackages.values()).filter(
      p => p.opportunityId === opportunityId
    );
    const packageVersion = existingPackages.length + 1;
    const packageId = crypto.randomUUID();

    const currentState = sessions.flatMap(s =>
      s.processes.map(p => ({
        processName: p.name,
        owner: p.owner,
        painPoint: p.painPoints.join('; ') || 'Not specified'
      }))
    );

    const stakeholders = Array.from(db.stakeholders.values())
      .filter(st => st.opportunityId === opportunityId)
      .map(st => ({
        name: st.name,
        role: st.role,
        influence: st.influence,
        authority: st.authority
      }));

    const supportingArtifacts = opp.evidenceArtifactIds.map(id => {
      const art = db.evidenceArtifacts.get(id);
      return {
        artifactId: id,
        canonicalUrl: art?.canonicalUrl || 'https://raphah.io/evidence',
        contentType: art?.contentType || 'text/html',
        contentHash: art?.contentHash || '0'.repeat(64)
      };
    });

    const openItems = sessions.flatMap(s =>
      s.actions.map(a => ({
        description: a.description,
        owner: a.owner,
        dueDate: a.dueDate
      }))
    );

    const basePackageData = {
      schemaVersion: '1.0.0',
      packageId,
      packageVersion,
      opportunityId,
      organization: {
        name: opp.organizationName,
        domain: opp.organizationDomain,
        industry: 'Professional Services',
        employeeCount: 25
      },
      stakeholders: stakeholders.length > 0 ? stakeholders : [{ name: 'Founder / Lead', role: 'Sponsor' }],
      problemStatement: opp.score.explanation || 'Client needs automated workflow and discovery platform implementation.',
      currentState: currentState.length > 0 ? currentState : [{ processName: 'Manual Operations', painPoint: 'High effort' }],
      requirementBaseline: {
        version: latestBaseline.version,
        requirements: latestBaseline.requirements,
        features: latestBaseline.features.filter(f => !f.excludedFromHandoff)
      },
      constraints: latestBaseline.constraints.length > 0 ? latestBaseline.constraints : [{ description: 'Budget cap CAD 150/mo', category: 'financial' }],
      risksAndAssumptions: latestBaseline.risksAndAssumptions.length > 0 ? latestBaseline.risksAndAssumptions : [{ description: 'API access granted by client', type: 'assumption' as const, impact: 'high' }],
      successMeasures: latestBaseline.successMeasures.length > 0 ? latestBaseline.successMeasures : [{ metric: 'Pipeline velocity', target: '2x improvement' }],
      commercialScope,
      supportingArtifacts,
      openItems,
      approvedBy: approverActorId,
      approvedAt: new Date().toISOString()
    };

    const checksumContent = canonicalJsonStringify(basePackageData);
    const manifestChecksum = crypto.createHash('sha256').update(checksumContent).digest('hex');

    const pkg: LeadEngineHandoffPackage = {
      ...basePackageData,
      manifestChecksum
    };

    HandoffPackageSchema.parse(pkg);

    db.handoffPackages.set(pkg.packageId, pkg);

    const outboxEvent: OutboxEvent = {
      id: crypto.randomUUID(),
      eventType: 'handoff.release.requested',
      aggregateId: pkg.packageId,
      payload: pkg,
      status: 'pending',
      attempts: 0,
      createdAt: new Date().toISOString()
    };
    db.outboxEvents.set(outboxEvent.id, outboxEvent);

    return pkg;
  }

  static async deliverPackageToDeliveryTool(
    packageId: string,
    deliveryToolUrl: string = 'http://localhost:3001/api/handoff/receive'
  ): Promise<{ success: boolean; projectId?: string; rejectionReasons?: any }> {
    const pkg = db.handoffPackages.get(packageId);
    if (!pkg) throw new Error(`Package ${packageId} not found`);

    const outbox = Array.from(db.outboxEvents.values()).find(
      e => e.aggregateId === packageId && e.eventType === 'handoff.release.requested'
    );

    try {
      const response = await fetch(deliveryToolUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(pkg)
      });

      const resData = await response.json() as any;

      if (response.ok && resData.status === 'accepted') {
        if (outbox) {
          outbox.status = 'delivered';
          outbox.attempts += 1;
          outbox.lastAttemptAt = new Date().toISOString();
        }

        const opp = db.opportunities.get(pkg.opportunityId);
        if (opp) {
          opp.stage = 'handed_off';
          opp.updatedAt = new Date().toISOString();
          db.opportunities.set(opp.id, opp);
        }

        return { success: true, projectId: resData.projectId };
      } else {
        if (outbox) {
          outbox.status = 'failed';
          outbox.attempts += 1;
          outbox.lastAttemptAt = new Date().toISOString();
          outbox.errorMessage = JSON.stringify(resData.rejectionReasons || resData.error || 'Delivery tool rejected package');
        }

        return { success: false, rejectionReasons: resData.rejectionReasons || resData.error };
      }
    } catch (err: any) {
      if (outbox) {
        outbox.status = 'failed';
        outbox.attempts += 1;
        outbox.lastAttemptAt = new Date().toISOString();
        outbox.errorMessage = err.message;
      }
      return { success: false, rejectionReasons: { code: 'NETWORK_ERROR', message: err.message } };
    }
  }
}
