-- Lead proposals + per-use-case success measures (operator
-- decision 2026-10-14, placement brief): outreach drafting lives
-- in the Lead Engine. Each use case carries a proposed success
-- measure (the OKR promised to the lead), approved together with
-- the use case; approved measures populate the handoff package's
-- successMeasures (previously hard-coded empty). lead_proposals
-- holds the drafted outreach proposal per lead: LLM- or template-
-- drafted, human-approved, human-sent — nothing auto-sends.
--
-- Schema 3.3.15

alter table public.opportunity_use_cases
  add column if not exists success_metric text,
  add column if not exists success_target text;

create table public.lead_proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  draft_text text not null,
  evidence_quotes jsonb not null default '[]'::jsonb,
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'sent', 'superseded')),
  drafted_by text not null default 'template'
    check (drafted_by in ('llm', 'template', 'human')),
  model text,
  approved_by text,
  approved_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index lead_proposals_workspace_idx
  on public.lead_proposals(workspace_id, opportunity_id, created_at desc);

alter table public.lead_proposals enable row level security;

create policy lead_proposals_member_select on public.lead_proposals
  for select using (public.is_workspace_member(workspace_id));
create policy lead_proposals_operator_write on public.lead_proposals
  for all using (public.has_workspace_role(workspace_id, array['owner', 'administrator', 'analyst', 'reviewer']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner', 'administrator', 'analyst', 'reviewer']::public.workspace_role[]));

-- Data API privileges: SELECT only. Proposal state transitions
-- (draft -> approved -> sent) are written by the API routes over
-- the server connection — approval is consent-gated there, and a
-- direct Data API write would bypass that gate entirely.
grant select on public.lead_proposals to authenticated;

create trigger audit_lead_proposals
  after insert or update or delete on public.lead_proposals
  for each row execute function public.capture_audit_event();

create trigger lead_proposals_updated before update on public.lead_proposals
  for each row execute function public.set_updated_at();

insert into public.schema_versions(service, version)
values ('lead-engine', '3.3.15')
on conflict (service) do update
set version = excluded.version, applied_at = now();
