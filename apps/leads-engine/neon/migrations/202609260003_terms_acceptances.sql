-- Third-party terms acceptances (audit gap 2).
--
-- Some collection inputs have their own terms of use that the Lead Engine
-- does not own: the Overpass API usage policy and the OpenStreetMap ODbL
-- attribution terms. Before a discovery run executes against such an input,
-- the workspace must have a recorded acceptance. This table is that record:
-- one row per (workspace, terms), accepted explicitly by an operator.
--
-- The discovery run path (manual "Run now" and the scheduled daily run)
-- refuses with 409 until acceptance is recorded via
-- POST /api/v1/terms/accept.

create table public.terms_acceptances (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  terms_id text not null,
  terms_version text not null,
  accepted_by text not null,
  accepted_at timestamptz not null default now(),
  notes text,
  primary key (workspace_id, terms_id)
);

alter table public.terms_acceptances enable row level security;

create policy terms_acceptances_member_select on public.terms_acceptances
  for select using (public.is_workspace_member(workspace_id));
create policy terms_acceptances_operator_write on public.terms_acceptances
  for all using (public.has_workspace_role(workspace_id, array['owner', 'administrator']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner', 'administrator']::public.workspace_role[]));
-- Write access is owner/administrator-only via the RLS policy above
-- (analysts and reviewers cannot accept third-party terms).
