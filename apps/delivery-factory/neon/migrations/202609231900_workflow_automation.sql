-- D-Raphah Delivery Factory: workflow automation (ChronoFlow-style visual builder)
-- Phase 2 automation: visual workflows with triggers, actions, logic gates,
-- execution audit (runs + per-node steps) for full adjustability/auditability.

-- ── Workflows ──────────────────────────────────────────────────────────────
create table if not exists public.workflows (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  status text not null default 'draft'
    check (status in ('draft','published','archived')),
  trigger_type text not null default 'manual'
    check (trigger_type in ('webhook','schedule','manual','lead_handoff','event')),
  trigger_config jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz
);
create index if not exists idx_workflows_status on public.workflows (status);
create index if not exists idx_workflows_trigger on public.workflows (trigger_type);

-- ── Workflow nodes ─────────────────────────────────────────────────────────
-- type: trigger | action | logic
-- kind: webhook|schedule|manual|lead_handoff (triggers),
--       send_email|http_request|log_database|slack_notify|create_project|
--       update_status|assign_gate (actions),
--       if_else|wait (logic)
create table if not exists public.workflow_nodes (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  node_key text not null,
  type text not null check (type in ('trigger','action','logic')),
  kind text not null,
  label text not null,
  position_x integer not null default 0,
  position_y integer not null default 0,
  config jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  unique (workflow_id, node_key)
);
create index if not exists idx_workflow_nodes_wf on public.workflow_nodes (workflow_id);

-- ── Workflow edges ─────────────────────────────────────────────────────────
-- from_port is used by if_else: 'true' | 'false'
create table if not exists public.workflow_edges (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  edge_key text not null,
  from_node_key text not null,
  to_node_key text not null,
  from_port text,
  label text,
  unique (workflow_id, edge_key)
);
create index if not exists idx_workflow_edges_wf on public.workflow_edges (workflow_id);

-- ── Workflow runs (execution audit) ────────────────────────────────────────
create table if not exists public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  trigger_type text not null,
  trigger_payload jsonb,
  status text not null default 'running'
    check (status in ('running','completed','failed','cancelled')),
  output jsonb,
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists idx_workflow_runs_wf on public.workflow_runs (workflow_id);
create index if not exists idx_workflow_runs_started on public.workflow_runs (started_at desc);

-- ── Workflow run steps (per-node audit trail) ──────────────────────────────
create table if not exists public.workflow_run_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.workflow_runs(id) on delete cascade,
  node_key text not null,
  node_kind text not null,
  node_label text not null,
  status text not null check (status in ('pending','running','success','failed','skipped')),
  input jsonb,
  output jsonb,
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists idx_workflow_run_steps_run on public.workflow_run_steps (run_id);

-- ── Workflow audit log (log_database action target) ──────────────────────
create table if not exists public.workflow_audit_log (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.workflow_runs(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  level text not null default 'info'
    check (level in ('info','warn','error')),
  message text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_workflow_audit_log_wf
  on public.workflow_audit_log (workflow_id, created_at desc);

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table public.workflows enable row level security;
alter table public.workflow_nodes enable row level security;
alter table public.workflow_edges enable row level security;
alter table public.workflow_runs enable row level security;
alter table public.workflow_run_steps enable row level security;
alter table public.workflow_audit_log enable row level security;

-- Service role has full access (server-side API uses service credentials).
-- Authenticated operators can read published workflows and run history;
-- mutations go through the API with operator auth.
do $$
begin
  if not exists (
    select 1 from pg_policies where policyname = 'service_all_workflows'
  ) then
    create policy service_all_workflows on public.workflows
      for all to service_role using (true) with check (true);
  end if;
  if not exists (
    select 1 from pg_policies where policyname = 'service_all_workflow_nodes'
  ) then
    create policy service_all_workflow_nodes on public.workflow_nodes
      for all to service_role using (true) with check (true);
  end if;
  if not exists (
    select 1 from pg_policies where policyname = 'service_all_workflow_edges'
  ) then
    create policy service_all_workflow_edges on public.workflow_edges
      for all to service_role using (true) with check (true);
  end if;
  if not exists (
    select 1 from pg_policies where policyname = 'service_all_workflow_runs'
  ) then
    create policy service_all_workflow_runs on public.workflow_runs
      for all to service_role using (true) with check (true);
  end if;
  if not exists (
    select 1 from pg_policies where policyname = 'service_all_workflow_run_steps'
  ) then
    create policy service_all_workflow_run_steps on public.workflow_run_steps
      for all to service_role using (true) with check (true);
  end if;
  if not exists (
    select 1 from pg_policies where policyname = 'service_all_workflow_audit_log'
  ) then
    create policy service_all_workflow_audit_log on public.workflow_audit_log
      for all to service_role using (true) with check (true);
  end if;
end $$;

-- ── updated_at trigger ─────────────────────────────────────────────────────
create or replace function public.touch_workflow_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_workflows_touch on public.workflows;
create trigger trg_workflows_touch
  before update on public.workflows
  for each row execute function public.touch_workflow_updated_at();
