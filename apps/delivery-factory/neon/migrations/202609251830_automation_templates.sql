-- Seed: minimum automation-capability templates so Delivery Factory can
-- deliver the top automations (per the Podbase automated-business-ideas
-- reference) to businesses that arrive as leads from the Lead Engine.
--
-- 1. "Lead auto-response (email + SMS)" — lead_handoff trigger: the moment a
--    qualified lead lands from LE, draft an instant email + SMS response.
--    No provider configured => both record drafts for human approval
--    (MVP rule: no automated outreach sending).
-- 2. "Review request" — webhook trigger: after a job completes, an external
--    system pings this workflow and it drafts a review-request SMS.
-- 3. "AI content draft + review gate" — manual trigger: drafts content with
--    AI, then assigns a human review gate on the delivery project so
--    editorial judgment stays in the loop.
--
-- All are published so they execute immediately; external calls use synthetic
-- targets.

-- ── 1. Lead auto-response (email + SMS) ────────────────────────────────
do $$
declare
  wf_id uuid;
begin
  insert into public.workflows
    (name, description, status, trigger_type, trigger_config, created_by, published_at)
  values (
    'Lead auto-response (email + SMS)',
    'Template: on a qualified lead handoff from the Lead Engine, draft an instant email and SMS response. Drafts wait for human approval when no provider is configured.',
    'published',
    'lead_handoff',
    '{"minScore":0}'::jsonb,
    'seed',
    now()
  )
  returning id into wf_id;

  insert into public.workflow_nodes
    (workflow_id, node_key, type, kind, label, position_x, position_y, config, enabled)
  values
    (wf_id, 'trigger-1', 'trigger', 'lead_handoff', 'Lead Handoff',
     360, 40,
     '{"minScore":0}'::jsonb, true),
    (wf_id, 'action-1', 'action', 'send_email', 'Draft email response',
     180, 220,
     '{"to":"{{trigger.lead.email}}","subject":"Thanks for contacting {{trigger.organization_name}}","body":"<p>Hi {{trigger.lead.name}},</p><p>Thanks for reaching out — a real person will follow up shortly.</p>","encryptSensitive":true}'::jsonb,
     true),
    (wf_id, 'action-2', 'action', 'send_sms', 'Draft SMS response',
     540, 220,
     '{"to":"{{trigger.lead.phone}}","message":"Hi {{trigger.lead.name}} — thanks for contacting {{trigger.organization_name}}. We will follow up shortly."}'::jsonb,
     true),
    (wf_id, 'action-3', 'action', 'log_database', 'Log response drafted',
     360, 400,
     '{"message":"Auto-response drafted for lead {{trigger.lead.name}} (score {{trigger.lead.score}})","level":"info"}'::jsonb,
     true);

  insert into public.workflow_edges
    (workflow_id, edge_key, from_node_key, to_node_key, from_port)
  values
    (wf_id, 'e1', 'trigger-1', 'action-1', null),
    (wf_id, 'e2', 'trigger-1', 'action-2', null),
    (wf_id, 'e3', 'action-1', 'action-3', null),
    (wf_id, 'e4', 'action-2', 'action-3', null);
end $$;

-- ── 2. Review request ──────────────────────────────────────────────────
do $$
declare
  wf_id uuid;
begin
  insert into public.workflows
    (name, description, status, trigger_type, trigger_config, created_by, published_at)
  values (
    'Review request',
    'Template: when a job-completion webhook arrives, draft a review-request SMS to the customer. Draft waits for human approval when no provider is configured.',
    'published',
    'webhook',
    '{"path":"job-completed","secret":""}'::jsonb,
    'seed',
    now()
  )
  returning id into wf_id;

  insert into public.workflow_nodes
    (workflow_id, node_key, type, kind, label, position_x, position_y, config, enabled)
  values
    (wf_id, 'trigger-1', 'trigger', 'webhook', 'Job completed webhook',
     360, 40,
     '{"path":"job-completed","secret":""}'::jsonb, true),
    (wf_id, 'logic-1', 'logic', 'if_else', 'Has phone number?',
     360, 220,
     '{"field":"trigger.customer.phone","operator":"exists","value":""}'::jsonb, true),
    (wf_id, 'action-1', 'action', 'send_sms', 'Draft review request',
     360, 400,
     '{"to":"{{trigger.customer.phone}}","message":"Hi {{trigger.customer.name}} — thanks for choosing {{trigger.business_name}}. A quick Google review would mean a lot: {{trigger.review_link}}"}'::jsonb,
     true),
    (wf_id, 'action-2', 'action', 'log_database', 'Log review request',
     360, 580,
     '{"message":"Review request drafted for {{trigger.customer.name}} (job {{trigger.job_id}})","level":"info"}'::jsonb,
     true);

  insert into public.workflow_edges
    (workflow_id, edge_key, from_node_key, to_node_key, from_port)
  values
    (wf_id, 'e1', 'trigger-1', 'logic-1', null),
    (wf_id, 'e2', 'logic-1', 'action-1', 'true'),
    (wf_id, 'e3', 'action-1', 'action-2', null);
end $$;

-- ── 3. AI content draft + review gate ──────────────────────────────────
do $$
declare
  wf_id uuid;
begin
  insert into public.workflows
    (name, description, status, trigger_type, trigger_config, created_by, published_at)
  values (
    'AI content draft + review gate',
    'Template: draft marketing content with AI, then assign a human review gate. AI drafts, a person approves — never auto-published. Set the project on the review-gate node before enabling it.',
    'published',
    'manual',
    '{}'::jsonb,
    'seed',
    now()
  )
  returning id into wf_id;

  insert into public.workflow_nodes
    (workflow_id, node_key, type, kind, label, position_x, position_y, config, enabled)
  values
    (wf_id, 'trigger-1', 'trigger', 'manual', 'Manual',
     360, 40,
     '{}'::jsonb, true),
    (wf_id, 'action-1', 'action', 'ai_assist', 'Draft content',
     360, 220,
     '{"model":"gpt-4o-mini","systemPrompt":"You draft short, honest marketing copy for local service businesses. No hype, no false claims.","userPrompt":"Draft a 3-sentence service description for: {{trigger.business_name}} — {{trigger.service}} in {{trigger.city}}.","maxTokens":300}'::jsonb,
     true),
    (wf_id, 'action-2', 'action', 'log_database', 'Log draft',
     180, 400,
     '{"message":"AI draft produced for {{trigger.business_name}}; awaiting human review","level":"info"}'::jsonb,
     true),
    (wf_id, 'action-3', 'action', 'assign_gate', 'Assign review gate',
     540, 400,
     '{"projectId":"","label":"Review AI draft","targetDate":""}'::jsonb,
     false);

  insert into public.workflow_edges
    (workflow_id, edge_key, from_node_key, to_node_key, from_port)
  values
    (wf_id, 'e1', 'trigger-1', 'action-1', null),
    (wf_id, 'e2', 'action-1', 'action-2', null),
    (wf_id, 'e3', 'action-1', 'action-3', null);
end $$;
