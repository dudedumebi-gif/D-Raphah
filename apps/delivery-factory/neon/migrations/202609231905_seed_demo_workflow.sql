-- Seed: demo automation workflow mirroring the ChronoFlow reference
-- (Schedule Trigger -> Check New User Count -> Send Email Digest /
--  Log to Database -> Trigger Webhook to Analytics -> Update System Status).
-- Published so it can execute immediately. All external calls use synthetic
-- targets; send_email has no provider configured and records intent.

do $$
declare
  wf_id uuid;
begin
  insert into public.workflows
    (name, description, status, trigger_type, trigger_config, created_by, published_at)
  values (
    'Daily lead digest',
    'Demo: every morning, check for new scored leads; email a digest when hot leads exist, always log + notify analytics.',
    'published',
    'schedule',
    '{"cron":"0 9 * * *","timezone":"America/Toronto"}'::jsonb,
    'seed',
    now()
  )
  returning id into wf_id;

  insert into public.workflow_nodes
    (workflow_id, node_key, type, kind, label, position_x, position_y, config, enabled)
  values
    (wf_id, 'trigger-1', 'trigger', 'schedule', 'Schedule Trigger',
     360, 40,
     '{"cron":"0 9 * * *","timezone":"America/Toronto"}'::jsonb, true),
    (wf_id, 'logic-1', 'logic', 'if_else', 'Check New User Count',
     340, 200,
     '{"field":"trigger.new_leads","operator":"gt","value":"0"}'::jsonb, true),
    (wf_id, 'action-1', 'action', 'send_email', 'Send Email Digest',
     120, 360,
     '{"to":"digest@example.com","subject":"Daily lead digest — {{trigger.date}}","body":"<p>Hot leads today: {{trigger.hot_leads}}</p><p>New leads: {{trigger.new_leads}}</p>","encryptSensitive":true}'::jsonb,
     true),
    (wf_id, 'action-2', 'action', 'log_database', 'Log to Database',
     420, 360,
     '{"message":"Digest run: {{trigger.new_leads}} new leads, {{trigger.hot_leads}} hot","level":"info"}'::jsonb,
     true),
    (wf_id, 'action-3', 'action', 'http_request', 'Trigger Webhook to Analytics',
     270, 520,
     '{"method":"POST","url":"https://example.com/analytics/digest","headers":{},"body":{"event":"digest_sent","new_leads":"{{trigger.new_leads}}","hot_leads":"{{trigger.hot_leads}}"}}'::jsonb,
     true),
    (wf_id, 'action-4', 'action', 'update_status', 'Update System Status',
     270, 680,
     '{"service":"delivery-factory","status":"ok","note":"Daily digest completed"}'::jsonb,
     true);

  insert into public.workflow_edges
    (workflow_id, edge_key, from_node_key, to_node_key, from_port)
  values
    (wf_id, 'e1', 'trigger-1', 'logic-1', null),
    (wf_id, 'e2', 'logic-1', 'action-1', 'true'),
    (wf_id, 'e3', 'logic-1', 'action-2', 'false'),
    (wf_id, 'e4', 'action-1', 'action-2', null),
    (wf_id, 'e5', 'action-2', 'action-3', null),
    (wf_id, 'e6', 'action-3', 'action-4', null);
end $$;
