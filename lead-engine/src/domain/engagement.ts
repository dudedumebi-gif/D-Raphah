import { db } from '../db/store.js';
import {
  Opportunity,
  OpportunityStage,
  Stakeholder,
  OutreachDraft,
  OutreachDraftType,
  SuppressionRecord
} from '../types/index.js';

export class EngagementService {
  static updateOpportunityStage(opportunityId: string, stage: OpportunityStage): Opportunity {
    const opp = db.opportunities.get(opportunityId);
    if (!opp) throw new Error(`Opportunity ${opportunityId} not found`);

    if (stage === 'qualified' && opp.evidenceArtifactIds.length === 0) {
      throw new Error('An opportunity cannot be qualified without evidence.');
    }

    opp.stage = stage;
    opp.updatedAt = new Date().toISOString();
    db.opportunities.set(opp.id, opp);
    return opp;
  }

  static addStakeholder(
    opportunityId: string,
    name: string,
    role: string,
    organization: string,
    email?: string,
    phone?: string,
    authority?: 'decision_maker' | 'influencer' | 'end_user'
  ): Stakeholder {
    const stakeholder: Stakeholder = {
      id: crypto.randomUUID(),
      opportunityId,
      name,
      role,
      organization,
      email,
      phone,
      authority
    };
    db.stakeholders.set(stakeholder.id, stakeholder);
    return stakeholder;
  }

  static addSuppression(emailDomainOrUrl: string, reason: string): SuppressionRecord {
    const record: SuppressionRecord = {
      id: crypto.randomUUID(),
      emailDomainOrUrl: emailDomainOrUrl.toLowerCase().trim(),
      reason,
      createdAt: new Date().toISOString()
    };
    db.suppressionList.set(record.id, record);
    return record;
  }

  static checkSuppression(recipientContact: string): boolean {
    const contact = recipientContact.toLowerCase().trim();
    for (const rec of db.suppressionList.values()) {
      if (contact.includes(rec.emailDomainOrUrl)) {
        return true;
      }
    }
    return false;
  }

  static draftOutreach(
    opportunityId: string,
    type: OutreachDraftType,
    recipientName: string,
    recipientContact: string,
    subject: string,
    body: string
  ): OutreachDraft {
    const isSuppressed = this.checkSuppression(recipientContact);

    const draft: OutreachDraft = {
      id: crypto.randomUUID(),
      opportunityId,
      type,
      recipientName,
      recipientContact,
      subject,
      body,
      status: 'drafted',
      suppressionChecked: true,
      createdAt: new Date().toISOString()
    };

    db.outreachDrafts.set(draft.id, draft);

    if (isSuppressed) {
      const opp = db.opportunities.get(opportunityId);
      if (opp) {
        opp.suppressionStatus = true;
        db.opportunities.set(opp.id, opp);
      }
    }

    return draft;
  }

  static approveOutreachDraft(draftId: string, approverActorId: string): OutreachDraft {
    const draft = db.outreachDrafts.get(draftId);
    if (!draft) throw new Error(`Outreach draft ${draftId} not found`);

    if (this.checkSuppression(draft.recipientContact)) {
      throw new Error('An outreach draft cannot be approved when a suppression entry applies.');
    }

    draft.status = 'approved';
    draft.approvedBy = approverActorId;
    draft.approvedAt = new Date().toISOString();
    db.outreachDrafts.set(draft.id, draft);
    return draft;
  }
}
