-- Corrections to 202610120009 as originally merged (Codex review
-- on PR #48 — all three findings valid):
--
-- 1. Data API privileges: RLS policies are the tenant boundary but
--    grant nothing by themselves; the base migration's rule is that
--    Neon Data API permissions are explicit. 0009 shipped without
--    grants, so every Data API read/write on opportunity_use_cases
--    failed with permission denied (the Use cases panel's
--    "Internal service error"). consent_records (202609260002) has
--    the same latent defect and is granted here too.
-- 2. The use-case write policy gains the reviewer role: approving
--    use cases is the reviewer's step in the flow.
-- 3. enqueue_handoff_outbox refreshes a package only when the row
--    is settled ('pending' or 'failed'). The original condition
--    also matched 'dispatching' — a request in flight to the
--    Delivery Factory — and could rewrite a package underneath its
--    own delivery.
--
-- Idempotent throughout. Schema 3.3.14

alter table public.opportunity_use_cases
  add column if not exists generation_source text not null default 'rules';

-- SELECT only (Codex P1 on PR #49): approval state and the
-- validator stamp are written exclusively by the API routes over
-- the server connection. Broad Data API insert/update would let
-- any operator-role member forge an already-approved row with a
-- self-chosen human_validator_id, and buildHandoffPackage would
-- ship it as a validated Must requirement.
grant select on public.opportunity_use_cases to authenticated;
-- Grants are additive in Postgres (Codex P1): a database that ran
-- a broader-grant variant keeps the write privileges unless they
-- are revoked explicitly.
revoke insert, update on public.opportunity_use_cases from authenticated;
-- SELECT only, same boundary: consent records gate both the
-- handoff and proposal approvals, so they are written only by
-- the consent route over the server connection.
grant select on public.consent_records to authenticated;
revoke insert, update on public.consent_records from authenticated;

drop policy if exists opportunity_use_cases_operator_write on public.opportunity_use_cases;
create policy opportunity_use_cases_operator_write on public.opportunity_use_cases
  for all using (public.has_workspace_role(workspace_id, array['owner', 'administrator', 'analyst', 'reviewer']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner', 'administrator', 'analyst', 'reviewer']::public.workspace_role[]));

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
values ('lead-engine', '3.3.14')
on conflict (service) do update
set version = excluded.version, applied_at = now();
