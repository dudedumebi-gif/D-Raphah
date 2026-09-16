import { db } from '../db/store.js';
import {
  DiscoverySession,
  ProcessItem,
  AISuggestion
} from '../types/index.js';

export class DiscoveryService {
  static createSession(
    opportunityId: string,
    purpose: string,
    agenda: string,
    sessionDate: string
  ): DiscoverySession {
    const session: DiscoverySession = {
      id: crypto.randomUUID(),
      opportunityId,
      purpose,
      agenda,
      sessionDate,
      participants: [],
      processes: [],
      systems: [],
      dataSources: [],
      painPoints: [],
      constraints: [],
      decisions: [],
      actions: [],
      aiSuggestions: [],
      status: 'scheduled',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.discoverySessions.set(session.id, session);
    return session;
  }

  static updateSessionNotes(
    sessionId: string,
    updates: {
      processes?: ProcessItem[];
      systems?: string[];
      dataSources?: string[];
      painPoints?: string[];
      constraints?: string[];
      decisions?: string[];
      actions?: Array<{ id: string; description: string; owner: string; dueDate: string }>;
    }
  ): DiscoverySession {
    const session = db.discoverySessions.get(sessionId);
    if (!session) throw new Error(`Discovery session ${sessionId} not found`);

    if (updates.processes) session.processes = updates.processes;
    if (updates.systems) session.systems = updates.systems;
    if (updates.dataSources) session.dataSources = updates.dataSources;
    if (updates.painPoints) session.painPoints = updates.painPoints;
    if (updates.constraints) session.constraints = updates.constraints;
    if (updates.decisions) session.decisions = updates.decisions;
    if (updates.actions) session.actions = updates.actions;

    session.updatedAt = new Date().toISOString();
    db.discoverySessions.set(session.id, session);
    return session;
  }

  static generateAISuggestions(sessionId: string): AISuggestion[] {
    const session = db.discoverySessions.get(sessionId);
    if (!session) throw new Error(`Discovery session ${sessionId} not found`);

    const suggestions: AISuggestion[] = [
      {
        id: crypto.randomUUID(),
        type: 'requirement',
        content: 'System must automate lead ingestion from web forms into the central CRM within 5 minutes.',
        sourceExcerpt: 'Client mentioned manual entry takes 2 hours daily.',
        validationStatus: 'pending'
      },
      {
        id: crypto.randomUUID(),
        type: 'feature',
        content: 'Interactive Dashboard showing real-time pipeline valuation and conversion metrics.',
        sourceExcerpt: 'Founder expressed difficulty visualizing weekly revenue performance.',
        validationStatus: 'pending'
      }
    ];

    session.aiSuggestions.push(...suggestions);
    session.updatedAt = new Date().toISOString();
    db.discoverySessions.set(session.id, session);
    return suggestions;
  }

  static validateAISuggestion(
    sessionId: string,
    suggestionId: string,
    action: 'accepted' | 'edited' | 'rejected',
    validatorActorId: string,
    editedContent?: string
  ): AISuggestion {
    const session = db.discoverySessions.get(sessionId);
    if (!session) throw new Error(`Discovery session ${sessionId} not found`);

    const sug = session.aiSuggestions.find(s => s.id === suggestionId);
    if (!sug) throw new Error(`AI Suggestion ${suggestionId} not found in session`);

    sug.validationStatus = action;
    sug.validatedBy = validatorActorId;
    sug.validatedAt = new Date().toISOString();
    if (editedContent) sug.content = editedContent;

    db.discoverySessions.set(session.id, session);
    return sug;
  }

  static approveSession(sessionId: string, approverActorId: string): DiscoverySession {
    const session = db.discoverySessions.get(sessionId);
    if (!session) throw new Error(`Discovery session ${sessionId} not found`);

    session.status = 'approved';
    session.approvedBy = approverActorId;
    session.approvedAt = new Date().toISOString();
    session.updatedAt = new Date().toISOString();

    db.discoverySessions.set(session.id, session);
    return session;
  }
}
