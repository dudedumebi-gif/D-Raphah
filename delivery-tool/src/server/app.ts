import express from 'express';
import cors from 'cors';
import { db } from '../db/store.js';
import { HandoffReceiverService } from '../domain/handoffReceiver.js';
import { ProjectsService } from '../domain/projects.js';

export const app: express.Express = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'delivery-tool', timestamp: new Date().toISOString() });
});

app.post('/api/handoff/receive', (req, res) => {
  const result = HandoffReceiverService.receivePackage(req.body);

  if (result.status === 'accepted') {
    return res.status(200).json(result);
  } else {
    return res.status(400).json(result);
  }
});

app.get('/api/projects', (req, res) => {
  res.json(Array.from(db.projects.values()));
});

app.get('/api/projects/:id', (req, res) => {
  const proj = db.projects.get(req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  res.json(proj);
});

app.post('/api/projects/:id/stage', (req, res) => {
  try {
    const updated = ProjectsService.updateStage(req.params.id, req.body.stage);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/projects/:id/milestones/:mId/complete', (req, res) => {
  try {
    const updated = ProjectsService.completeMilestone(req.params.id, req.params.mId);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/projects/:id/clarification', (req, res) => {
  try {
    const event = ProjectsService.requestClarification(req.params.id, req.body.question, req.body.owner || 'Founder');
    res.json(event);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/feedback', (req, res) => {
  res.json(Array.from(db.feedbackEvents.values()));
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Raphah Delivery Tool Workspace</title>
        <style>
          body { font-family: system-ui, sans-serif; padding: 2rem; background: #f8fafc; color: #0f172a; }
          h1 { color: #1e293b; }
          .card { background: white; padding: 1.5rem; border-radius: 8px; margin-bottom: 1rem; border: 1px solid #e2e8f0; }
          .badge { display: inline-block; padding: 4px 8px; border-radius: 4px; background: #dcfce7; color: #15803d; font-weight: bold; }
        </style>
      </head>
      <body>
        <h1>Raphah Delivery Tool</h1>
        <p>Status: <span class="badge">ACTIVE</span></p>
        <div class="card">
          <h2>Client Delivery & Implementation Blueprints</h2>
          <p>Manages client onboarding, architecture blueprints, milestones, and continuous improvement.</p>
          <p>Handoff Endpoint: <code>POST /api/handoff/receive</code></p>
        </div>
      </body>
    </html>
  `);
});
