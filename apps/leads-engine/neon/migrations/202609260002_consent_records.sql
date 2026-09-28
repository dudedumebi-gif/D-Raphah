-- CASL consent records (audit gap 1).
--
-- The outreach readiness checklist requires a recorded CASL basis (consent or
-- existing relationship) before outreach can begin. This table is that
-- record: what the basis is, what evidence supports it, when it was
-- established, and who recorded it. The LE→DF handoff package carries the
-- latest basis for the opportunity so the Delivery Factory can verify
-- outreach readiness as a query, not a memory.
--
-- Creation is wired into the audit log via capture_audit_event, the same as
-- evidence artifacts: every insert/update/delete on consent_records lands in
-- audit_events with the calling human as actor.

create table public.consent_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete set null,
  opportunity_id uuid references public.opportunities(id) on delete set null,
  basis_type text not null
    check (basis_type in ('consent', 'existing_relationship', 'inquiry')),
  evidence_reference text,
  recorded_at timestamptz not null default now(),
  recorded_by text not null,
  notes text,
  check (organization_id is not null or opportunity_id is not null)
);
create index consent_records_workspace_idx
  on public.consent_records(workspace_id, recorded_at desc);
create index consent_records_org_idx
  on public.consent_records(workspace_id, organization_id);
create index consent_records_opp_idx
  on public.consent_records(workspace_id, opportunity_id);

alter table public.consent_records enable row level security;

create policy consent_records_member_select on public.consent_records
  for select using (public.is_workspace_member(workspace_id));
create policy consent_records_operator_write on public.consent_records
  for all using (public.has_workspace_role(workspace_id, array['owner', 'administrator', 'analyst']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner', 'administrator', 'analyst']::public.workspace_role[]));

-- Audit wiring, like evidence artifacts: insert/update/delete auto-logs.
create trigger audit_consent_records
  after insert or update or delete on public.consent_records
  for each row execute function public.capture_audit_event();
