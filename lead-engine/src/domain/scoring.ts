import { db } from '../db/store.js';
import {
  EvidenceArtifact,
  Opportunity,
  OpportunityScore,
  ScoreComponents,
  RiskFlags,
  OpportunityRouting
} from '../types/index.js';

export class ScoringService {
  static evaluateAndIngestArtifact(artifact: EvidenceArtifact): Opportunity {
    const existing = this.findDuplicate(artifact);
    if (existing) {
      if (!existing.evidenceArtifactIds.includes(artifact.id)) {
        existing.evidenceArtifactIds.push(artifact.id);
        existing.updatedAt = new Date().toISOString();
        db.opportunities.set(existing.id, existing);
      }
      return existing;
    }

    const title = artifact.extractedTitle || 'Discovered Business Opportunity';
    const organization = artifact.extractedOrganization || 'Unknown Organization';

    const components: ScoreComponents = {
      problemFit: 22,         // max 25
      offerFit: 18,           // max 20
      urgencyTiming: 12,      // max 15
      organizationAuthority: 12, // max 15
      budgetSignal: 8,        // max 10
      relationshipProximity: 6, // max 10
      technicalAlignment: 4   // max 5
    };

    const totalScore =
      components.problemFit +
      components.offerFit +
      components.urgencyTiming +
      components.organizationAuthority +
      components.budgetSignal +
      components.relationshipProximity +
      components.technicalAlignment; // = 82

    const riskFlags: RiskFlags = {
      policyRisk: false,
      privacyRisk: false,
      conflictRisk: false,
      expiryRisk: false,
      evidenceRisk: false
    };

    const confidence = 0.85;

    let routing: OpportunityRouting = 'archived';
    const hasBlockingRisk = Object.values(riskFlags).some(val => val === true);

    if (totalScore >= 75 && confidence >= 0.75 && !hasBlockingRisk) {
      routing = 'priority_review';
    } else if (totalScore >= 50) {
      routing = 'standard_review';
    }

    const score: OpportunityScore = {
      totalScore,
      components,
      confidence,
      riskFlags,
      explanation: `Evaluated problem fit (${components.problemFit}/25) and offer fit (${components.offerFit}/20) from evidence artifact ${artifact.id}.`,
      scoringVersion: '1.0.0',
      evaluatedAt: new Date().toISOString()
    };

    const opportunity: Opportunity = {
      id: crypto.randomUUID(),
      workspaceId: artifact.workspaceId,
      title,
      organizationName: organization,
      organizationDomain: artifact.canonicalUrl ? new URL(artifact.canonicalUrl).hostname : undefined,
      type: 'public_signal',
      stage: 'detected',
      score,
      routing,
      canonicalUrl: artifact.canonicalUrl,
      evidenceArtifactIds: [artifact.id],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.opportunities.set(opportunity.id, opportunity);
    return opportunity;
  }

  static findDuplicate(artifact: EvidenceArtifact): Opportunity | null {
    for (const opp of db.opportunities.values()) {
      if (opp.workspaceId !== artifact.workspaceId) continue;

      if (artifact.canonicalUrl && opp.canonicalUrl && artifact.canonicalUrl === opp.canonicalUrl) {
        return opp;
      }

      for (const evId of opp.evidenceArtifactIds) {
        const ev = db.evidenceArtifacts.get(evId);
        if (ev && ev.contentHash === artifact.contentHash) {
          return opp;
        }
      }

      if (
        artifact.extractedTitle &&
        artifact.extractedOrganization &&
        opp.title.toLowerCase().trim() === artifact.extractedTitle.toLowerCase().trim() &&
        opp.organizationName.toLowerCase().trim() === artifact.extractedOrganization.toLowerCase().trim()
      ) {
        return opp;
      }
    }

    return null;
  }
}
