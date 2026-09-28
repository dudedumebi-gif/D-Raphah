-- Seed: "Lead follow-up (SMS, draft-first)" demo template.
--
-- A live, runnable automation from the DF capability matrix: when a qualified
-- lead handoff lands from the Lead Engine, an ai_assist node drafts a
-- personalized follow-up SMS from the lead context, a send_sms node queues
-- that draft, and a log_database node records the audit entry.
--
-- Draft-first by design (MVP house rule: no automated outreach sending):
-- with no SMS/AI provider configured, both nodes record drafts for human
-- approval instead of sending. The send_sms message is composed from the
-- ai_assist output via {{node_action-1.output}}, so wiring a provider
-- later upgrades the draft to a real personalized message automatically.
--
-- Published so it executes immediately; external calls use synthetic targets.

do $$
declare
  wf_id uuid;
begin
  insert into public.workflows
    (name, description, status, trigger_type, trigger_config, created_by, published_at)
  values (
    'Lead follow-up (SMS, draft-first)',
    'Demo template: on a qualified lead handoff, draft a personalized follow-up SMS with AI, then queue the SMS as a draft for human approval. Nothing sends automatically.',
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
    (wf_id, 'action-1', 'action', 'ai_assist', 'Draft follow-up SMS',
     360, 220,
     '{"model":"gpt-4o-mini","systemPrompt":"You write short follow-up SMS messages for local service businesses. Warm and specific, never hype or false claims. Never invent facts you were not given. Output only the message text.","userPrompt":"Write one SMS under 160 characters following up with {{trigger.lead.name}} at {{trigger.organization_name}} (lead score {{trigger.lead.score}}/100). Invite a reply with a specific question.","maxTokens":200}'::jsonb,
     true),
    (wf_id, 'action-2', 'action', 'send_sms', 'Queue SMS draft',
     360, 400,
     '{"to":"{{trigger.lead.phone}}","message":"{{node_action-1.output}}"}'::jsonb,
     true),
    (wf_id, 'action-3', 'action', 'log_database', 'Log follow-up drafted',
     360, 580,
     '{"message":"SMS follow-up draft queued for {{trigger.lead.name}} ({{trigger.lead.phone}}); AI draft recorded, awaiting human approval","level":"info"}'::jsonb,
     true);

  insert into public.workflow_edges
    (workflow_id, edge_key, from_node_key, to_node_key, from_port)
  values
    (wf_id, 'e1', 'trigger-1', 'action-1', null),
    (wf_id, 'e2', 'action-1', 'action-2', null),
    (wf_id, 'e3', 'action-2', 'action-3', null);
end $$;
