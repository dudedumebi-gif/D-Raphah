import { db } from '../db/store.js';
import {
  Requirement,
  FeatureCandidate,
  RequirementBaseline,
  RequirementPriority
} from '../types/index.js';

export class RequirementsService {
  static createRequirement(
    opportunityId: string,
    statement: string,
    priority: RequirementPriority,
    sourceEvidenceId?: string
  ): Requirement {
    const existingReqs = Array.from(db.requirements.values()).filter(r => r.opportunityId === opportunityId);
    const seq = existingReqs.length + 1;
    const code = `REQ-OPP-${seq.toString().padStart(3, '0')}`;

    const req: Requirement = {
      id: crypto.randomUUID(),
      opportunityId,
      code,
      statement,
      priority,
      status: 'draft',
      sourceEvidenceId,
      acceptanceCriteria: [],
      blockingQuestions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.requirements.set(req.id, req);
    return req;
  }

  static validateRequirement(
    requirementId: string,
    validatorActorId: string,
    acceptanceCriteria: string[] = []
  ): Requirement {
    const req = db.requirements.get(requirementId);
    if (!req) throw new Error(`Requirement ${requirementId} not found`);

    if (!validatorActorId || validatorActorId.trim() === '') {
      throw new Error('A model suggested requirement cannot become validated without a named human validator.');
    }

    req.status = 'validated';
    req.humanValidatorId = validatorActorId;
    req.acceptanceCriteria = acceptanceCriteria;
    req.updatedAt = new Date().toISOString();

    db.requirements.set(req.id, req);
    return req;
  }

  static addBlockingQuestion(requirementId: string, question: string): Requirement {
    const req = db.requirements.get(requirementId);
    if (!req) throw new Error(`Requirement ${requirementId} not found`);

    req.blockingQuestions.push(question);
    req.updatedAt = new Date().toISOString();

    db.requirements.set(req.id, req);
    return req;
  }

  static createFeatureCandidate(
    opportunityId: string,
    name: string,
    userOutcome: string,
    relatedRequirementIds: string[]
  ): FeatureCandidate {
    const existingFeats = Array.from(db.featureCandidates.values()).filter(f => f.opportunityId === opportunityId);
    const seq = existingFeats.length + 1;
    const code = `FEAT-OPP-${seq.toString().padStart(3, '0')}`;

    const feat: FeatureCandidate = {
      id: crypto.randomUUID(),
      opportunityId,
      code,
      name,
      userOutcome,
      relatedRequirementIds,
      excludedFromHandoff: false
    };

    db.featureCandidates.set(feat.id, feat);
    return feat;
  }

  static freezeBaseline(
    opportunityId: string,
    actorId: string,
    constraints: Array<{ id: string; description: string; category: string }> = [],
    risksAndAssumptions: Array<{ id: string; description: string; type: 'risk' | 'assumption'; impact: string }> = [],
    successMeasures: Array<{ id: string; metric: string; target: string }> = []
  ): RequirementBaseline {
    const reqs = Array.from(db.requirements.values()).filter(r => r.opportunityId === opportunityId);
    const feats = Array.from(db.featureCandidates.values()).filter(f => f.opportunityId === opportunityId);

    // Baseline Quality Gate Checks
    for (const req of reqs) {
      if (req.priority === 'must') {
        if (req.blockingQuestions.length > 0) {
          throw new Error(`A requirement baseline cannot freeze when a Must item (${req.code}) has a blocking question or unresolved conflict.`);
        }
        if (req.status !== 'validated') {
          throw new Error(`A requirement baseline cannot freeze when a Must item (${req.code}) is not validated by a human validator.`);
        }
      }
    }

    const existingBaselines = Array.from(db.baselines.values()).filter(b => b.opportunityId === opportunityId);
    const version = existingBaselines.length + 1;

    const baseline: RequirementBaseline = {
      id: crypto.randomUUID(),
      opportunityId,
      version,
      requirements: JSON.parse(JSON.stringify(reqs)),
      features: JSON.parse(JSON.stringify(feats)),
      constraints,
      risksAndAssumptions,
      successMeasures,
      isFrozen: true,
      frozenBy: actorId,
      frozenAt: new Date().toISOString()
    };

    db.baselines.set(baseline.id, baseline);
    return baseline;
  }
}
