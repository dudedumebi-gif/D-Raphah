-- Business-discovery layer (lead-vision gap 1).
--
-- discovery_sources registers a discovery configuration: which adapter
-- produced it (currently "overpass"), the geo query to run, and the approved
-- collection source (source_definitions) whose policy governs the scrape
-- jobs enqueued from discovered candidates. campaign_id is a convenience
-- link; queue_scrape_job also derives the campaign from the source row.
-- discovery_runs records one row per executed run with outcome counts.
--
-- Operators (owner/administrator/analyst) manage both tables; members can
-- read. Candidate websites are enqueued through the existing
-- queue_scrape_job path, so the normal collection pipeline (leases,
-- retries, evidence, scoring) picks them up unchanged.

create table public.discovery_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  adapter_id text not null,
  geo_params jsonb not null default '{}'::jsonb,
  source_id uuid not null references public.source_definitions(id),
  campaign_id uuid references public.scrape_campaigns(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index discovery_sources_workspace_idx
  on public.discovery_sources(workspace_id, created_at desc);

create table public.discovery_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  discovery_source_id uuid not null references public.discovery_sources(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  candidates_found integer not null default 0,
  candidates_enqueued integer not null default 0,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  error text,
  created_at timestamptz not null default now()
);
create index discovery_runs_workspace_idx
  on public.discovery_runs(workspace_id, created_at desc);
create index discovery_runs_source_idx
  on public.discovery_runs(discovery_source_id, started_at desc);

alter table public.discovery_sources enable row level security;
alter table public.discovery_runs enable row level security;

create policy discovery_sources_member_select on public.discovery_sources
  for select using (public.is_workspace_member(workspace_id));
create policy discovery_sources_operator_write on public.discovery_sources
  for all using (public.has_workspace_role(workspace_id, array['owner', 'administrator', 'analyst']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner', 'administrator', 'analyst']::public.workspace_role[]));
create policy discovery_runs_member_select on public.discovery_runs
  for select using (public.is_workspace_member(workspace_id));
create policy discovery_runs_operator_write on public.discovery_runs
  for all using (public.has_workspace_role(workspace_id, array['owner', 'administrator', 'analyst']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner', 'administrator', 'analyst']::public.workspace_role[]));
