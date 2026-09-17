import { DeliveryProject, DeliveryFeedbackEvent } from '../types/index.js';

export class MemoryStore {
  public projects: Map<string, DeliveryProject> = new Map();
  public packageToProjectMap: Map<string, string> = new Map();
  public feedbackEvents: Map<string, DeliveryFeedbackEvent> = new Map();

  clear(): void {
    this.projects.clear();
    this.packageToProjectMap.clear();
    this.feedbackEvents.clear();
  }
}

export const db = new MemoryStore();
