import { db } from '../db/store.js';
import { Source, SourcePolicy, CollectionMethod } from '../types/index.js';
import { SourcePolicySchema } from '../schemas/index.js';

export class SourceService {
  static createSource(
    workspaceId: string,
    name: string,
    baseUrl: string,
    method: CollectionMethod,
    policy: Partial<SourcePolicy>
  ): Source {
    const fullPolicy: SourcePolicy = {
      businessPurpose: policy.businessPurpose || 'Discover potential business automation consulting opportunities.',
      collectionMethod: method,
      allowedDomains: policy.allowedDomains || [new URL(baseUrl).hostname],
      allowlistPaths: policy.allowlistPaths || ['/*'],
      denylistPaths: policy.denylistPaths || [],
      dailyBudget: policy.dailyBudget ?? 100,
      monthlyBudget: policy.monthlyBudget ?? 2000,
      maxDepth: policy.maxDepth ?? 2,
      rateLimitRps: policy.rateLimitRps ?? 1,
      userAgent: policy.userAgent || 'RaphahLeadEngineBot/1.0 (+https://raphah.io)',
      contactEmail: policy.contactEmail || 'compliance@raphah.io',
      retentionMonths: policy.retentionMonths ?? 12,
      activeVersion: 1
    };

    const source: Source = {
      id: crypto.randomUUID(),
      workspaceId,
      name,
      baseUrl,
      method,
      status: 'draft',
      policy: fullPolicy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.sources.set(source.id, source);
    return source;
  }

  static submitPolicyForApproval(sourceId: string): Source {
    const source = db.sources.get(sourceId);
    if (!source) throw new Error(`Source ${sourceId} not found`);

    SourcePolicySchema.parse(source.policy);

    source.status = 'pending_approval';
    source.updatedAt = new Date().toISOString();
    db.sources.set(source.id, source);
    return source;
  }

  static approveAndActivateSource(sourceId: string, approverActorId: string): Source {
    const source = db.sources.get(sourceId);
    if (!source) throw new Error(`Source ${sourceId} not found`);

    if (source.status !== 'pending_approval' && source.status !== 'draft') {
      throw new Error(`Cannot approve source in status ${source.status}`);
    }

    source.policy.approvedBy = approverActorId;
    source.policy.approvedAt = new Date().toISOString();
    source.status = 'active';
    source.updatedAt = new Date().toISOString();
    db.sources.set(source.id, source);
    return source;
  }

  static checkCanRun(sourceId: string): { canRun: boolean; reason?: string } {
    const source = db.sources.get(sourceId);
    if (!source) return { canRun: false, reason: 'Source not found' };

    if (source.status !== 'active') {
      return { canRun: false, reason: `Source is not active (current status: ${source.status})` };
    }

    if (!source.policy.approvedBy || !source.policy.approvedAt) {
      return { canRun: false, reason: 'Source policy has not been explicitly approved by a human.' };
    }

    return { canRun: true };
  }
}
