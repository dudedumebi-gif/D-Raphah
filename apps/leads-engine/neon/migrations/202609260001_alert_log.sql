-- Operator alerting (audit gap 4).
--
-- alert_log records one row per emitted alert. The (alert_type, resource_id)
-- unique constraint is the dedupe key: the worker only emits an alert when no
-- row exists for that key, so a canary failure alerts exactly once and a
-- dead-letter threshold breach alerts at most once per workspace per hour.
--
-- Rows are written by the service role (worker tick), never by browser
-- clients: the API writes the companion audit_events entry explicitly via
-- log_workspace_event inside the alert emitter, so no DB trigger is needed.
-- RLS: members can read; operators (owner/administrator/analyst) can manage.

create table public.alert_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  alert_type text not null,
  resource_type text not null,
  resource_id text not null,
  reason text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (alert_type, resource_id)
);
create index alert_log_workspace_idx
  on public.alert_log(workspace_id, created_at desc);

alter table public.alert_log enable row level security;

create policy alert_log_member_select on public.alert_log
  for select using (public.is_workspace_member(workspace_id));
create policy alert_log_operator_write on public.alert_log
  for all using (public.has_workspace_role(workspace_id, array['owner', 'administrator', 'analyst']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner', 'administrator', 'analyst']::public.workspace_role[]));

-- Service-role writes; browser clients must never insert alert rows directly.
revoke insert, update, delete on public.alert_log from anonymous, authenticated;
