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

-- Backfill (Codex P2): use-case rows generated before success
-- measures existed carry NULLs, and the builder excludes
-- measure-less rows — upgraded databases would ship handoffs
-- with no promised OKRs. Restore the catalog defaults by key.
update public.opportunity_use_cases uc
set success_metric = c.metric, success_target = c.target
from (values
  ('online_booking', 'Online booking share', 'At least 50% of new appointments booked online within 90 days of launch'),
  ('digital_intake', 'Intake completed before arrival', 'At least 80% of new patients complete intake online before their visit'),
  ('digital_exchange', 'Fax volume for referrals and records', 'Fax use reduced by at least 80% within 90 days'),
  ('ops_automation', 'Staff hours on duplicate entry and manual tracking', 'At least 5 hours per week returned to the front desk'),
  ('legacy_modernization', 'Legacy system in daily front-desk use', 'Retired or reduced to read-only archive within 6 months'),
  ('automated_reminders', 'Appointment no-show rate', 'Reduced by at least 25% within 90 days of launch'),
  ('patient_recall', 'Overdue patients reactivated per recall cycle', 'At least 15% of overdue patients rebooked in the first cycle'),
  ('review_requests', 'New public reviews per month', 'At least 10 new Google reviews per month'),
  ('front_desk_capacity', 'Booking lead time', 'Kept under 2 business days while demand grows')
) as c(key, metric, target)
where uc.use_case_key = c.key and uc.success_metric is null;

insert into public.schema_versions(service, version)
values ('lead-engine', '3.3.15')
on conflict (service) do update
set version = excluded.version, applied_at = now();
