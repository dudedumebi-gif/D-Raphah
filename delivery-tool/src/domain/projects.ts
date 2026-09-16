import { db } from '../db/store.js';
import { DeliveryProject, DeliveryProjectStage, DeliveryFeedbackEvent } from '../types/index.js';

export class ProjectsService {
  static updateStage(projectId: string, stage: DeliveryProjectStage): DeliveryProject {
    const project = db.projects.get(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    project.stage = stage;
    project.updatedAt = new Date().toISOString();
    db.projects.set(project.id, project);

    this.emitFeedbackEvent(projectId, 'status_updated', { stage });
    return project;
  }

  static completeMilestone(projectId: string, milestoneId: string): DeliveryProject {
    const project = db.projects.get(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const ms = project.milestones.find(m => m.id === milestoneId);
    if (!ms) throw new Error(`Milestone ${milestoneId} not found in project`);

    ms.completed = true;
    project.updatedAt = new Date().toISOString();
    db.projects.set(project.id, project);

    this.emitFeedbackEvent(projectId, 'milestone_completed', { milestoneId, title: ms.title });
    return project;
  }

  static requestClarification(projectId: string, question: string, owner: string): DeliveryFeedbackEvent {
    return this.emitFeedbackEvent(projectId, 'clarification_requested', { question, owner });
  }

  private static emitFeedbackEvent(
    projectId: string,
    type: 'status_updated' | 'clarification_requested' | 'milestone_completed',
    details: any
  ): DeliveryFeedbackEvent {
    const project = db.projects.get(projectId);
    const event: DeliveryFeedbackEvent = {
      eventId: crypto.randomUUID(),
      projectId,
      opportunityId: project?.opportunityId || 'unknown',
      type,
      details,
      emittedAt: new Date().toISOString()
    };
    db.feedbackEvents.set(event.eventId, event);
    return event;
  }
}
