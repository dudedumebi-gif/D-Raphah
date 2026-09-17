import express from 'express';
import cors from 'cors';
import { db } from '../db/store.js';
import { CommandEnvelopeSchema } from '../schemas/index.js';
import { CommandEnvelope, CommandResult } from '../types/index.js';
import { SourceService } from '../domain/sources.js';
import { CollectionService } from '../domain/collection.js';
import { ScoringService } from '../domain/scoring.js';
import { EngagementService } from '../domain/engagement.js';
import { DiscoveryService } from '../domain/discovery.js';
import { RequirementsService } from '../domain/requirements.js';
import { HandoffService } from '../domain/handoff.js';

export const app: express.Express = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'lead-engine', timestamp: new Date().toISOString() });
});

app.post('/api/commands', async (req, res) => {
  try {
    const envelope: CommandEnvelope = CommandEnvelopeSchema.parse(req.body);

    if (db.processedIdempotencyKeys.has(envelope.idempotencyKey)) {
      return res.status(200).json({
        success: true,
        commandId: envelope.commandId,
        data: { message: 'Command already processed (idempotency key matched).' }
      });
    }

    const { commandId, workspaceId, actorId, payload } = envelope;
    let resultData: any;

    const action = payload.action;

    switch (action) {
      case 'source.create': {
        resultData = SourceService.createSource(
          workspaceId,
          payload.name,
          payload.baseUrl,
          payload.method,
          payload.policy || {}
        );
        break;
      }

      case 'source.approve': {
        SourceService.submitPolicyForApproval(payload.sourceId);
        resultData = SourceService.approveAndActivateSource(payload.sourceId, actorId);
        break;
      }

      case 'collection.run': {
        resultData = CollectionService.runCrawl(payload.sourceId, payload.items || []);
        break;
      }

      case 'opportunity.evaluate': {
        const artifact = db.evidenceArtifacts.get(payload.artifactId);
        if (!artifact) throw new Error(`Artifact ${payload.artifactId} not found`);
        resultData = ScoringService.evaluateAndIngestArtifact(artifact);
        break;
      }

      case 'outreach.draft': {
        resultData = EngagementService.draftOutreach(
          payload.opportunityId,
          payload.type,
          payload.recipientName,
          payload.recipientContact,
          payload.subject,
          payload.body
        );
        break;
      }

      case 'outreach.approve': {
        resultData = EngagementService.approveOutreachDraft(payload.draftId, actorId);
        break;
      }

      case 'suppression.add': {
        resultData = EngagementService.addSuppression(payload.emailDomainOrUrl, payload.reason);
        break;
      }

      case 'discovery.create': {
        resultData = DiscoveryService.createSession(
          payload.opportunityId,
          payload.purpose,
          payload.agenda,
          payload.sessionDate
        );
        break;
      }

      case 'discovery.update_notes': {
        resultData = DiscoveryService.updateSessionNotes(payload.sessionId, payload.updates);
        break;
      }

      case 'discovery.ai_generate': {
        resultData = DiscoveryService.generateAISuggestions(payload.sessionId);
        break;
      }

      case 'discovery.ai_validate': {
        resultData = DiscoveryService.validateAISuggestion(
          payload.sessionId,
          payload.suggestionId,
          payload.validationStatus,
          actorId,
          payload.editedContent
        );
        break;
      }

      case 'discovery.approve': {
        resultData = DiscoveryService.approveSession(payload.sessionId, actorId);
        break;
      }

      case 'requirement.create': {
        resultData = RequirementsService.createRequirement(
          payload.opportunityId,
          payload.statement,
          payload.priority,
          payload.sourceEvidenceId
        );
        break;
      }

      case 'requirement.validate': {
        resultData = RequirementsService.validateRequirement(
          payload.requirementId,
          actorId,
          payload.acceptanceCriteria || []
        );
        break;
      }

      case 'requirement.add_blocking_question': {
        resultData = RequirementsService.addBlockingQuestion(payload.requirementId, payload.question);
        break;
      }

      case 'feature.create': {
        resultData = RequirementsService.createFeatureCandidate(
          payload.opportunityId,
          payload.name,
          payload.userOutcome,
          payload.relatedRequirementIds || []
        );
        break;
      }

      case 'baseline.freeze': {
        resultData = RequirementsService.freezeBaseline(
          payload.opportunityId,
          actorId,
          payload.constraints,
          payload.risksAndAssumptions,
          payload.successMeasures
        );
        break;
      }

      case 'handoff.create': {
        resultData = HandoffService.createHandoffPackage(
          payload.opportunityId,
          actorId,
          payload.commercialScope
        );
        break;
      }

      case 'handoff.deliver': {
        resultData = await HandoffService.deliverPackageToDeliveryTool(
          payload.packageId,
          payload.deliveryToolUrl
        );
        break;
      }

      default:
        throw new Error(`Unknown command action: ${action}`);
    }

    db.processedIdempotencyKeys.add(envelope.idempotencyKey);

    const result: CommandResult = {
      success: true,
      commandId,
      data: resultData
    };
    return res.status(200).json(result);
  } catch (err: any) {
    return res.status(400).json({
      success: false,
      commandId: req.body?.commandId || 'unknown',
      error: {
        code: 'COMMAND_ERROR',
        message: err.message
      }
    });
  }
});

app.get('/api/sources', (req, res) => {
  res.json(Array.from(db.sources.values()));
});

app.get('/api/opportunities', (req, res) => {
  res.json(Array.from(db.opportunities.values()));
});

app.get('/api/discovery-sessions', (req, res) => {
  res.json(Array.from(db.discoverySessions.values()));
});

app.get('/api/requirements', (req, res) => {
  res.json(Array.from(db.requirements.values()));
});

app.get('/api/handoff-packages', (req, res) => {
  res.json(Array.from(db.handoffPackages.values()));
});

app.get('/api/outbox', (req, res) => {
  res.json(Array.from(db.outboxEvents.values()));
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Raphah Lead Engine Workspace</title>
        <style>
          body { font-family: system-ui, sans-serif; padding: 2rem; background: #f8fafc; color: #0f172a; }
          h1 { color: #1e293b; }
          .card { background: white; padding: 1.5rem; border-radius: 8px; margin-bottom: 1rem; border: 1px solid #e2e8f0; }
          .badge { display: inline-block; padding: 4px 8px; border-radius: 4px; background: #e0f2fe; color: #0369a1; font-weight: bold; }
          pre { background: #f1f5f9; padding: 1rem; border-radius: 6px; overflow-x: auto; }
        </style>
      </head>
      <body>
        <h1>Raphah Lead Engine</h1>
        <p>Status: <span class="badge">ACTIVE</span></p>
        <div class="card">
          <h2>Opportunity Pipeline & Compliance Dashboard</h2>
          <p>Operates under human-reviewed, evidence-led, and privacy-aware controls.</p>
          <p>API Base: <code>/api/commands</code></p>
        </div>
      </body>
    </html>
  `);
});
