-- Reviewer-validated use cases for handoffs (operator direction
-- 2026-10-14): the Lead Engine identifies the automation use cases a
-- qualified lead presents (from its stored evidence), the reviewer
-- selects and approves them, and the approved set ships to the
-- Delivery Factory as human-validated Must requirements.
--
-- 1. opportunity_use_cases: engine rows start as 'suggested'; the
--    approval action stamps the reviewer as human_validator_id.
--    Posture mirrors consent_records (member select, operator
--    write, automatic audit capture).
-- 2. enqueue_handoff_outbox previously did ON CONFLICT DO NOTHING,
--    which pinned the FIRST package forever: re-sending a lead after
--    approving its use cases would have kept dispatching the stale
--    empty-baseline package until the attempts ran out. The RPC now
--    refreshes the package and resets dispatch state whenever the
--    existing row is still pending or terminally failed; a row
--    that is mid-dispatch ('dispatching', request in flight to the
--    Delivery Factory) or already sent is left untouched, so a
--    resend can never rewrite a package underneath an in-flight
--    delivery and corrupt its outcome record.
--
-- Schema 3.3.13

create table public.opportunity_use_cases (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  use_case_key text not null,
  code text not null,
  title text not null,
  statement text not null,
  rationale text not null default '',
  acceptance_criteria jsonb not null default '[]'::jsonb,
  status text not null default 'suggested'
    check (status in ('suggested', 'approved', 'dismissed')),
  human_validator_id text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (opportunity_id, use_case_key)
);
create index opportunity_use_cases_workspace_idx
  on public.opportunity_use_cases(workspace_id, opportunity_id);

alter table public.opportunity_use_cases enable row level security;

create policy opportunity_use_cases_member_select on public.opportunity_use_cases
  for select using (public.is_workspace_member(workspace_id));
create policy opportunity_use_cases_operator_write on public.opportunity_use_cases
  for all using (public.has_workspace_role(workspace_id, array['owner', 'administrator', 'analyst', 'reviewer']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner', 'administrator', 'analyst', 'reviewer']::public.workspace_role[]));

create trigger audit_opportunity_use_cases
  after insert or update or delete on public.opportunity_use_cases
  for each row execute function public.capture_audit_event();

create trigger opportunity_use_cases_updated before update on public.opportunity_use_cases
  for each row execute function public.set_updated_at();

-- Neon Data API permissions are explicit (base-migration rule):
-- RLS policies are the tenant boundary, but the authenticated role
-- still needs table privileges or every Data API read/write on the
-- table fails. The reviewer role is included because approving use
-- cases IS the reviewer's step in this flow.
grant select, insert, update on public.opportunity_use_cases to authenticated;
-- Same defect, found while fixing this one: consent_records
-- (202609260002) never received its Data API privileges either,
-- although its policies intend member select + operator write and
-- the consent routes use the Data API client.
grant select, insert, update on public.consent_records to authenticated;

create or replace function public.enqueue_handoff_outbox(
  p_workspace_id uuid,
  p_idempotency_key text,
  p_package jsonb,
  p_checksum text,
  p_signature text
)
returns public.handoff_outbox language plpgsql security definer set search_path = public as $$
declare result public.handoff_outbox;
begin
  if not public.has_workspace_role(p_workspace_id, array['owner','administrator','analyst']::public.workspace_role[]) then
    raise exception 'permission denied' using errcode='42501';
  end if;
  if p_checksum !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid manifest checksum';
  end if;
  insert into public.handoff_outbox(workspace_id, idempotency_key, package, manifest_checksum, signature)
    values(p_workspace_id, p_idempotency_key, p_package, p_checksum, p_signature)
    on conflict(idempotency_key) do update
      set package = excluded.package,
          manifest_checksum = excluded.manifest_checksum,
          signature = excluded.signature,
          status = 'pending',
          attempts = 0,
          next_attempt_at = now(),
          last_error = null,
          dispatched_at = null
      where public.handoff_outbox.status in ('pending', 'failed');
  select * into result from public.handoff_outbox
    where idempotency_key = p_idempotency_key and workspace_id = p_workspace_id;
  if result.id is null then
    raise exception 'idempotency key already used for a different request';
  end if;
  return result;
end $$;
revoke execute on function public.enqueue_handoff_outbox(uuid,text,jsonb,text,text) from public, anonymous;
grant execute on function public.enqueue_handoff_outbox(uuid,text,jsonb,text,text) to authenticated;

insert into public.schema_versions(service, version)
values ('lead-engine', '3.3.13')
on conflict (service) do update
set version = excluded.version, applied_at = now();
