import crypto from 'node:crypto';
import { db } from '../db/store.js';
import { LeadEngineHandoffPackage, HandoffReceiptResult, DeliveryProject, RejectionReason } from '../types/index.js';
import { LeadEngineHandoffPackageSchema } from '../schemas/index.js';

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

export class HandoffReceiverService {
  static receivePackage(payload: any): HandoffReceiptResult {
    const rejectionReasons: RejectionReason[] = [];

    const schemaParse = LeadEngineHandoffPackageSchema.safeParse(payload);
    if (!schemaParse.success) {
      for (const issue of schemaParse.error.issues) {
        rejectionReasons.push({
          code: 'SCHEMA_INVALID',
          message: issue.message,
          field: issue.path.join('.')
        });
      }
      return {
        status: 'rejected',
        packageId: payload?.packageId || 'unknown',
        packageVersion: payload?.packageVersion || 0,
        rejectionReasons
      };
    }

    const pkg: LeadEngineHandoffPackage = schemaParse.data;

    const key = `${pkg.packageId}:${pkg.packageVersion}`;
    if (db.packageToProjectMap.has(key)) {
      const existingProjectId = db.packageToProjectMap.get(key)!;
      return {
        status: 'accepted',
        projectId: existingProjectId,
        packageId: pkg.packageId,
        packageVersion: pkg.packageVersion,
        message: 'Package already accepted (idempotent replay).'
      };
    }

    const { manifestChecksum, ...basePackageData } = pkg;
    const computedChecksum = crypto
      .createHash('sha256')
      .update(canonicalJsonStringify(basePackageData))
      .digest('hex');

    if (computedChecksum !== manifestChecksum) {
      rejectionReasons.push({
        code: 'CHECKSUM_MISMATCH',
        message: `Package checksum mismatch. Expected ${manifestChecksum}, computed ${computedChecksum}.`
      });
      return {
        status: 'rejected',
        packageId: pkg.packageId,
        packageVersion: pkg.packageVersion,
        rejectionReasons
      };
    }

    if (!pkg.organization.name || pkg.organization.name.trim() === '') {
      rejectionReasons.push({
        code: 'MISSING_ORGANIZATION',
        message: 'Organization name is required.'
      });
    }

    if (!pkg.requirementBaseline || pkg.requirementBaseline.requirements.length === 0) {
      rejectionReasons.push({
        code: 'EMPTY_REQUIREMENTS',
        message: 'Requirement baseline must contain at least one requirement.'
      });
    }

    if (rejectionReasons.length > 0) {
      return {
        status: 'rejected',
        packageId: pkg.packageId,
        packageVersion: pkg.packageVersion,
        rejectionReasons
      };
    }

    const projectId = `PROJ-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

    const project: DeliveryProject = {
      id: projectId,
      packageId: pkg.packageId,
      packageVersion: pkg.packageVersion,
      opportunityId: pkg.opportunityId,
      organizationName: pkg.organization.name,
      stage: 'onboarding',
      requirementBaselineVersion: pkg.requirementBaseline.version,
      requirementsCount: pkg.requirementBaseline.requirements.length,
      featuresCount: pkg.requirementBaseline.features.length,
      milestones: [
        { id: 'm-1', title: 'Client Onboarding & Access Verification', completed: false },
        { id: 'm-2', title: 'Architecture Blueprint Sign-off', completed: false },
        { id: 'm-3', title: 'Implementation & Integration Deployment', completed: false },
        { id: 'm-4', title: 'Client Handover & Acceptance Training', completed: false }
      ],
      acceptedPackage: pkg,
      receivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.projects.set(projectId, project);
    db.packageToProjectMap.set(key, projectId);

    return {
      status: 'accepted',
      projectId,
      packageId: pkg.packageId,
      packageVersion: pkg.packageVersion,
      message: 'Handoff package accepted successfully.'
    };
  }
}
